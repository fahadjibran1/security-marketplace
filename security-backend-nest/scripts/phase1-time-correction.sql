-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Phase 1 production correction: scheduled times written under the naive convention.
--
-- NOT APPLIED. Nothing in this file has been run against production. Part A is READ ONLY and produces
-- the correction table for review; Part B is the correction itself and must not be run until Part A has
-- been read and the row list agreed.
--
-- WHAT NEEDS CORRECTING AND WHY
-- Before Phase 1 the client sent an offset-less date-time and the server resolved it with `new Date(...)`,
-- against its own (UTC) clock. A shift the operator entered as 11:30 at a London site in summer was
-- therefore stored as the wall clock 11:30 in a column the whole platform now reads as an instant — so it
-- reads as 12:30 site time: one hour later than intended. In winter the offset is zero and those rows are
-- already correct, which is why the correction must be computed per row from the SITE's timezone and not
-- applied as a blanket hour.
--
-- Affected naive columns (all `timestamp without time zone`):
--   rota_slots.startAt, rota_slots.endAt        -- the scheduled requirement
--   shifts.start, shifts.end                    -- the positions under it, and legacy standalone shifts
--   timesheets.scheduledStartAt, .scheduledEndAt-- copied from shifts.start/end when the timesheet opened
--
-- NOT affected: attendance.occurredAt and every other recorded timestamp (stamped by the server at the
-- moment the event arrived, already a true instant), and the P1H client-approval columns (timestamptz).
--
-- THE CONVERSION
--   corrected := (stored AT TIME ZONE site.timezone) AT TIME ZONE 'UTC'
-- The first AT TIME ZONE reads the stored wall clock AS site-local and yields a real instant; the second
-- renders that instant back as a naive UTC timestamp, which is what the column holds. Postgres uses the
-- IANA database for both, so DST is handled per row and per date. There is no arithmetic here to get wrong.
--
-- SCOPE — READ THIS BEFORE RUNNING PART B
-- Rows written AFTER the Phase 1 deploy are already correct, and applying the conversion to one would move
-- it by the offset a second time. So Part B is scoped to an explicit id list taken from Part A. Do not
-- replace that list with a date predicate unless the deploy timestamp is known exactly.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- PART A — READ ONLY. Produces the correction table. Safe to run at any time.
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- A1. Every rota slot, with the correction that would be applied and how much it moves.
SELECT
  rs.id                                                         AS rota_slot_id,
  rs."siteId"                                                   AS site_id,
  s.timezone                                                    AS site_timezone,
  rs."startAt"                                                  AS stored_start,
  (rs."startAt" AT TIME ZONE s.timezone) AT TIME ZONE 'UTC'     AS corrected_start,
  rs."endAt"                                                    AS stored_end,
  (rs."endAt"   AT TIME ZONE s.timezone) AT TIME ZONE 'UTC'     AS corrected_end,
  EXTRACT(EPOCH FROM (
    rs."startAt" - ((rs."startAt" AT TIME ZONE s.timezone) AT TIME ZONE 'UTC')
  )) / 60                                                       AS start_moves_minutes,
  -- Scheduled duration must not change: the correction shifts both ends by the offset at each end, so an
  -- overnight shift across a clock change legitimately shows a different duration afterwards. Anything
  -- else is worth a second look.
  EXTRACT(EPOCH FROM (rs."endAt" - rs."startAt")) / 60          AS stored_duration_minutes,
  EXTRACT(EPOCH FROM (
    ((rs."endAt"   AT TIME ZONE s.timezone) AT TIME ZONE 'UTC')
  - ((rs."startAt" AT TIME ZONE s.timezone) AT TIME ZONE 'UTC')
  )) / 60                                                       AS corrected_duration_minutes
FROM rota_slots rs
JOIN sites s ON s.id = rs."siteId"
ORDER BY rs."startAt";

-- A2. Every shift, including legacy standalone shifts with no rota slot.
SELECT
  sh.id                                                         AS shift_id,
  sh."rotaSlotId"                                               AS rota_slot_id,
  sh."siteId"                                                   AS site_id,
  s.timezone                                                    AS site_timezone,
  sh.status,
  sh.start                                                      AS stored_start,
  (sh.start AT TIME ZONE s.timezone) AT TIME ZONE 'UTC'         AS corrected_start,
  sh."end"                                                      AS stored_end,
  (sh."end"  AT TIME ZONE s.timezone) AT TIME ZONE 'UTC'        AS corrected_end,
  EXTRACT(EPOCH FROM (
    sh.start - ((sh.start AT TIME ZONE s.timezone) AT TIME ZONE 'UTC')
  )) / 60                                                       AS start_moves_minutes
FROM shifts sh
JOIN sites s ON s.id = sh."siteId"
ORDER BY sh.start;

-- A3. Timesheets carrying a copy of a scheduled time.
SELECT
  t.id                                                          AS timesheet_id,
  t."shiftId"                                                   AS shift_id,
  s.timezone                                                    AS site_timezone,
  t."approvalStatus",
  t."scheduledStartAt"                                          AS stored_scheduled_start,
  (t."scheduledStartAt" AT TIME ZONE s.timezone) AT TIME ZONE 'UTC' AS corrected_scheduled_start,
  t."scheduledEndAt"                                            AS stored_scheduled_end,
  (t."scheduledEndAt"   AT TIME ZONE s.timezone) AT TIME ZONE 'UTC' AS corrected_scheduled_end,
  -- Recorded times are NOT corrected; shown only so the variance can be re-read after the correction.
  t."actualCheckInAt",
  t."actualCheckOutAt"
FROM timesheets t
JOIN shifts sh ON sh.id = t."shiftId"
JOIN sites s   ON s.id  = sh."siteId"
WHERE t."scheduledStartAt" IS NOT NULL OR t."scheduledEndAt" IS NOT NULL
ORDER BY t."scheduledStartAt";

-- A4. Rows the conversion cannot resolve cleanly. DECIDE THESE BY HAND — do not include them in Part B.
--
--   'nonexistent' — the stored wall clock falls in the hour skipped when the clocks go forward, so it
--     never happened at that site. Postgres still returns a value (it rolls the reading forward an hour),
--     which is a silent guess at what the operator meant.
--
--   'ambiguous' — the stored wall clock falls in the hour that happens twice when the clocks go back.
--     Postgres resolves it to the LATER occurrence. The platform's own policy for new writes is the
--     EARLIER occurrence (AMBIGUOUS_POLICY = 'earliest-occurrence'), so a blanket correction here would
--     disagree with how the same input is handled today, by exactly one hour. Verified against Postgres
--     16.15: stored 2026-10-25 01:30 at a London site converts to 01:30Z (GMT, later), where a fresh
--     entry of 01:30 would be stored as 00:30Z (BST, earlier).
SELECT record, id, site_timezone, stored_value, issue FROM (
  SELECT 'rota_slot' AS record, rs.id, s.timezone AS site_timezone, rs."startAt" AS stored_value,
         CASE
           WHEN (rs."startAt" AT TIME ZONE s.timezone) AT TIME ZONE s.timezone <> rs."startAt"
             THEN 'nonexistent'
           WHEN ((rs."startAt" AT TIME ZONE s.timezone) - interval '1 hour') AT TIME ZONE s.timezone = rs."startAt"
             THEN 'ambiguous'
         END AS issue
  FROM rota_slots rs JOIN sites s ON s.id = rs."siteId"
  UNION ALL
  SELECT 'rota_slot_end', rs.id, s.timezone, rs."endAt",
         CASE
           WHEN (rs."endAt" AT TIME ZONE s.timezone) AT TIME ZONE s.timezone <> rs."endAt" THEN 'nonexistent'
           WHEN ((rs."endAt" AT TIME ZONE s.timezone) - interval '1 hour') AT TIME ZONE s.timezone = rs."endAt" THEN 'ambiguous'
         END
  FROM rota_slots rs JOIN sites s ON s.id = rs."siteId"
  UNION ALL
  SELECT 'shift', sh.id, s.timezone, sh.start,
         CASE
           WHEN (sh.start AT TIME ZONE s.timezone) AT TIME ZONE s.timezone <> sh.start THEN 'nonexistent'
           WHEN ((sh.start AT TIME ZONE s.timezone) - interval '1 hour') AT TIME ZONE s.timezone = sh.start THEN 'ambiguous'
         END
  FROM shifts sh JOIN sites s ON s.id = sh."siteId"
  UNION ALL
  SELECT 'shift_end', sh.id, s.timezone, sh."end",
         CASE
           WHEN (sh."end" AT TIME ZONE s.timezone) AT TIME ZONE s.timezone <> sh."end" THEN 'nonexistent'
           WHEN ((sh."end" AT TIME ZONE s.timezone) - interval '1 hour') AT TIME ZONE s.timezone = sh."end" THEN 'ambiguous'
         END
  FROM shifts sh JOIN sites s ON s.id = sh."siteId"
) flagged
WHERE issue IS NOT NULL
ORDER BY record, id;

-- A5. Sites with no timezone set. These cannot be corrected until one is chosen, because there is no
--     authority for what their stored wall clock meant.
SELECT id, name, timezone
FROM sites
WHERE timezone IS NULL OR btrim(timezone) = '';

ROLLBACK;

-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- PART B — THE CORRECTION. DO NOT RUN until Part A has been reviewed and the id lists are agreed.
--
-- Replace the id lists with the ids from Part A. A row must appear in exactly one run: the conversion is
-- not idempotent, and applying it twice moves a row by twice the offset.
--
-- Take a backup first (ops/backup-postgres.sh), and keep the Part A output as the before-image.
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

-- BEGIN;
-- SET LOCAL statement_timeout = '60s';
--
-- -- B1. Rota slots.
-- UPDATE rota_slots rs
-- SET "startAt" = (rs."startAt" AT TIME ZONE s.timezone) AT TIME ZONE 'UTC',
--     "endAt"   = (rs."endAt"   AT TIME ZONE s.timezone) AT TIME ZONE 'UTC'
-- FROM sites s
-- WHERE s.id = rs."siteId"
--   AND rs.id IN (/* ids from A1 */);
--
-- -- B2. Shifts. Includes the positions under a corrected slot and any legacy standalone shift.
-- UPDATE shifts sh
-- SET start = (sh.start AT TIME ZONE s.timezone) AT TIME ZONE 'UTC',
--     "end" = (sh."end"  AT TIME ZONE s.timezone) AT TIME ZONE 'UTC'
-- FROM sites s
-- WHERE s.id = sh."siteId"
--   AND sh.id IN (/* ids from A2 */);
--
-- -- B3. Timesheet copies of the scheduled times. Recorded times are deliberately untouched.
-- UPDATE timesheets t
-- SET "scheduledStartAt" = (t."scheduledStartAt" AT TIME ZONE s.timezone) AT TIME ZONE 'UTC',
--     "scheduledEndAt"   = (t."scheduledEndAt"   AT TIME ZONE s.timezone) AT TIME ZONE 'UTC'
-- FROM shifts sh
-- JOIN sites s ON s.id = sh."siteId"
-- WHERE sh.id = t."shiftId"
--   AND t.id IN (/* ids from A3 */);
--
-- -- Re-run Part A here and confirm every start_moves_minutes is now 0 before committing.
-- ROLLBACK; -- change to COMMIT only after that check passes.
