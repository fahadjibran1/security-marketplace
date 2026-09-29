-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Phase 1 production correction: scheduled times written under the naive convention.
--
-- NOT APPLIED. Nothing in this file has been run against production. Part A is READ ONLY and produces
-- the correction table for review; Part B is the correction itself and stays commented out until the
-- row list from Part A has been read and approved.
--
-- WHAT NEEDS CORRECTING AND WHY
-- Before Phase 1 the client sent an offset-less date-time and the server resolved it with `new Date(...)`,
-- against its own (UTC) clock. A shift the operator entered as 11:30 at a London site in summer was
-- therefore stored as the wall clock 11:30 in a column the whole platform now reads as an instant — so it
-- reads as 12:30 site time: one hour later than intended. In winter the offset is zero and those rows are
-- already correct, which is why the correction is computed per row from the SITE's timezone and never
-- applied as a blanket hour.
--
-- Affected naive columns (all `timestamp without time zone`):
--   rota_slots."startAt", rota_slots."endAt"          -- the scheduled requirement
--   shifts.start, shifts."end"                        -- the positions under it, and legacy standalone shifts
--   timesheets."scheduledStartAt", ."scheduledEndAt"  -- copied from shifts.start/end when the timesheet opened
--
-- NOT affected: attendance.occurredAt and every other recorded timestamp (stamped by the server at the
-- moment the event arrived, already a true instant), and the P1H client-approval columns (timestamptz).
-- Actual attendance times are never touched by this correction.
--
-- THE CONVERSION
--   corrected := (stored AT TIME ZONE site.timezone) AT TIME ZONE 'UTC'
-- The first AT TIME ZONE reads the stored wall clock AS site-local and yields a real instant; the second
-- renders that instant back as a naive UTC timestamp, which is what the column holds. Postgres uses the
-- IANA database for both, so DST is handled per row and per date. There is no arithmetic here to get wrong.
--
-- WHERE THAT CONVERSION MUST NOT BE TRUSTED
-- `AT TIME ZONE` silently resolves the two local times that have no single meaning:
--   * a wall clock in the hour SKIPPED when the clocks go forward never happened; Postgres rolls it
--     forward an hour and returns a value anyway;
--   * a wall clock in the hour that happens TWICE when the clocks go back resolves to the LATER
--     occurrence, while the platform's own policy for new writes is the EARLIER one
--     (AMBIGUOUS_POLICY = 'earliest-occurrence'). Verified on PostgreSQL 16.15: a stored
--     2026-10-25 01:30 at a London site converts to 01:30Z, where a fresh entry of 01:30 is stored
--     as 00:30Z — a one-hour disagreement with the running application.
-- Both classes are therefore EXCLUDED from automatic correction and listed for record-by-record review.
--
-- CLASSIFICATION (query A1; every candidate row falls in exactly one class)
--   A  legacy_wall_clock   the stored value is an unambiguous site-local wall clock -> safe to convert
--   B  already_correct     converting would change nothing (zero offset at that date) -> leave alone
--   C  ambiguous           fall-back hour, happens twice -> MANUAL
--   D  nonexistent         spring-forward hour, never happened -> MANUAL
--   E  insufficient        the site has no usable timezone -> MANUAL, do not guess
--
-- Class B covers every row written in GMT AND every row written by the fixed code, because a corrected
-- instant re-converted would move. Class B alone is not proof a row is post-fix; see the note on
-- provenance under A5.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- PART A — READ ONLY. Produces the correction table. Safe to run at any time.
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

-- ── A0. Before-state snapshot ───────────────────────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM typeorm_migrations)                       AS migration_count,
  (SELECT name FROM typeorm_migrations ORDER BY timestamp DESC LIMIT 1) AS latest_migration,
  (SELECT count(*) FROM rota_slots)                               AS rota_slot_count,
  (SELECT count(*) FROM shifts)                                   AS shift_count,
  (SELECT count(*) FROM timesheets)                               AS timesheet_count,
  (SELECT count(*) FROM attendance_events)                        AS attendance_event_count,
  (SELECT count(*) FROM daily_logs)                               AS daily_log_count,
  (SELECT count(*) FROM safety_alerts)                            AS safety_alert_count,
  (SELECT count(*) FROM sites)                                    AS site_count,
  current_setting('TimeZone')                                     AS server_timezone,
  version()                                                       AS server_version;

-- ── A1. Every candidate scheduled value, classified ─────────────────────────────────────────────
-- One row per COLUMN, not per record, because the two ends of a shift can fall in different classes
-- (an overnight shift across a transition night is exactly that case).
WITH candidates AS (
  SELECT 'rota_slots' AS tbl, 'startAt' AS col, rs.id, rs."siteId" AS site_id, s.timezone, NULL::text AS status, rs."startAt" AS stored
    FROM rota_slots rs JOIN sites s ON s.id = rs."siteId"
  UNION ALL
  SELECT 'rota_slots', 'endAt', rs.id, rs."siteId", s.timezone, NULL, rs."endAt"
    FROM rota_slots rs JOIN sites s ON s.id = rs."siteId"
  UNION ALL
  SELECT 'shifts', 'start', sh.id, sh."siteId", s.timezone, sh.status::text, sh.start
    FROM shifts sh JOIN sites s ON s.id = sh."siteId"
  UNION ALL
  SELECT 'shifts', 'end', sh.id, sh."siteId", s.timezone, sh.status::text, sh."end"
    FROM shifts sh JOIN sites s ON s.id = sh."siteId"
  UNION ALL
  SELECT 'timesheets', 'scheduledStartAt', t.id, sh."siteId", s.timezone, t."approvalStatus"::text, t."scheduledStartAt"
    FROM timesheets t JOIN shifts sh ON sh.id = t."shiftId" JOIN sites s ON s.id = sh."siteId"
   WHERE t."scheduledStartAt" IS NOT NULL
  UNION ALL
  SELECT 'timesheets', 'scheduledEndAt', t.id, sh."siteId", s.timezone, t."approvalStatus"::text, t."scheduledEndAt"
    FROM timesheets t JOIN shifts sh ON sh.id = t."shiftId" JOIN sites s ON s.id = sh."siteId"
   WHERE t."scheduledEndAt" IS NOT NULL
),
judged AS (
  SELECT
    c.*,
    CASE WHEN c.timezone IS NULL OR btrim(c.timezone) = '' THEN NULL
         ELSE (c.stored AT TIME ZONE c.timezone) AT TIME ZONE 'UTC' END AS corrected
  FROM candidates c
)
SELECT
  tbl                                                              AS "table",
  col                                                              AS "column",
  id                                                               AS record_id,
  site_id,
  timezone                                                         AS site_timezone,
  status,
  stored                                                           AS current_value,
  -- What the operator meant, read back in the site's own clock. For class A this is the wall clock
  -- currently stored; it is printed explicitly so the reviewer can confirm it against the rota.
  to_char(stored, 'YYYY-MM-DD HH24:MI')                            AS intended_site_local,
  corrected                                                        AS proposed_corrected_utc,
  CASE
    WHEN timezone IS NULL OR btrim(timezone) = ''                                             THEN 'E_insufficient'
    WHEN (stored AT TIME ZONE timezone) AT TIME ZONE timezone <> stored                       THEN 'D_nonexistent'
    WHEN ((stored AT TIME ZONE timezone) - interval '1 hour') AT TIME ZONE timezone = stored   THEN 'C_ambiguous'
    WHEN corrected = stored                                                                    THEN 'B_already_correct'
    ELSE 'A_legacy_wall_clock'
  END                                                              AS classification,
  CASE
    WHEN timezone IS NULL OR btrim(timezone) = ''                                             THEN 'site has no timezone — no authority for what the stored wall clock meant'
    WHEN (stored AT TIME ZONE timezone) AT TIME ZONE timezone <> stored                       THEN 'clocks go forward: this local time never existed at this site'
    WHEN ((stored AT TIME ZONE timezone) - interval '1 hour') AT TIME ZONE timezone = stored   THEN 'clocks go back: this local time occurs twice; AT TIME ZONE picks the later one, the application picks the earlier'
    WHEN corrected = stored                                                                    THEN 'zero offset at this date — nothing to change'
    ELSE 'unambiguous site-local wall clock; deterministic conversion'
  END                                                              AS reason,
  EXTRACT(EPOCH FROM (stored - corrected)) / 60                    AS moves_minutes
FROM judged
ORDER BY classification, tbl, record_id, col;

-- ── A2. Counts per class, for the approval summary ──────────────────────────────────────────────
WITH candidates AS (
  SELECT 'rota_slots' AS tbl, rs."startAt" AS stored, s.timezone FROM rota_slots rs JOIN sites s ON s.id = rs."siteId"
  UNION ALL SELECT 'rota_slots', rs."endAt", s.timezone FROM rota_slots rs JOIN sites s ON s.id = rs."siteId"
  UNION ALL SELECT 'shifts', sh.start, s.timezone FROM shifts sh JOIN sites s ON s.id = sh."siteId"
  UNION ALL SELECT 'shifts', sh."end", s.timezone FROM shifts sh JOIN sites s ON s.id = sh."siteId"
  UNION ALL SELECT 'timesheets', t."scheduledStartAt", s.timezone FROM timesheets t JOIN shifts sh ON sh.id = t."shiftId" JOIN sites s ON s.id = sh."siteId" WHERE t."scheduledStartAt" IS NOT NULL
  UNION ALL SELECT 'timesheets', t."scheduledEndAt", s.timezone FROM timesheets t JOIN shifts sh ON sh.id = t."shiftId" JOIN sites s ON s.id = sh."siteId" WHERE t."scheduledEndAt" IS NOT NULL
)
SELECT
  tbl AS "table",
  CASE
    WHEN timezone IS NULL OR btrim(timezone) = ''                                           THEN 'E_insufficient'
    WHEN (stored AT TIME ZONE timezone) AT TIME ZONE timezone <> stored                     THEN 'D_nonexistent'
    WHEN ((stored AT TIME ZONE timezone) - interval '1 hour') AT TIME ZONE timezone = stored THEN 'C_ambiguous'
    WHEN (stored AT TIME ZONE timezone) AT TIME ZONE 'UTC' = stored                          THEN 'B_already_correct'
    ELSE 'A_legacy_wall_clock'
  END AS classification,
  count(*) AS values_affected
FROM candidates
GROUP BY 1, 2
ORDER BY 1, 2;

-- ── A3. Whole-record view for the rows proposed for automatic correction ────────────────────────
-- Both ends together, so a reviewer sees the shift as a shift. A record appears here only when BOTH
-- of its ends are class A or B and NEITHER is C, D or E — a record with one manual end is corrected
-- as a whole or not at all.
SELECT
  'rota_slots'                                                  AS "table",
  rs.id                                                         AS record_id,
  rs."siteId"                                                   AS site_id,
  s.timezone                                                    AS site_timezone,
  rs."startAt"                                                  AS current_start,
  rs."endAt"                                                    AS current_end,
  to_char(rs."startAt", 'YYYY-MM-DD HH24:MI')                   AS intended_site_local_start,
  to_char(rs."endAt",   'YYYY-MM-DD HH24:MI')                   AS intended_site_local_end,
  (rs."startAt" AT TIME ZONE s.timezone) AT TIME ZONE 'UTC'     AS corrected_start,
  (rs."endAt"   AT TIME ZONE s.timezone) AT TIME ZONE 'UTC'     AS corrected_end,
  EXTRACT(EPOCH FROM (rs."endAt" - rs."startAt")) / 60          AS current_duration_minutes,
  EXTRACT(EPOCH FROM (
    ((rs."endAt"   AT TIME ZONE s.timezone) AT TIME ZONE 'UTC')
  - ((rs."startAt" AT TIME ZONE s.timezone) AT TIME ZONE 'UTC')
  )) / 60                                                       AS corrected_duration_minutes
FROM rota_slots rs
JOIN sites s ON s.id = rs."siteId"
WHERE s.timezone IS NOT NULL AND btrim(s.timezone) <> ''
  AND (rs."startAt" AT TIME ZONE s.timezone) AT TIME ZONE s.timezone = rs."startAt"
  AND (rs."endAt"   AT TIME ZONE s.timezone) AT TIME ZONE s.timezone = rs."endAt"
  AND ((rs."startAt" AT TIME ZONE s.timezone) - interval '1 hour') AT TIME ZONE s.timezone <> rs."startAt"
  AND ((rs."endAt"   AT TIME ZONE s.timezone) - interval '1 hour') AT TIME ZONE s.timezone <> rs."endAt"
  AND (rs."startAt" AT TIME ZONE s.timezone) AT TIME ZONE 'UTC' <> rs."startAt"
ORDER BY rs."startAt";

SELECT
  'shifts'                                                      AS "table",
  sh.id                                                         AS record_id,
  sh."rotaSlotId"                                               AS rota_slot_id,
  sh."siteId"                                                   AS site_id,
  s.timezone                                                    AS site_timezone,
  sh.status,
  sh.start                                                      AS current_start,
  sh."end"                                                      AS current_end,
  to_char(sh.start, 'YYYY-MM-DD HH24:MI')                       AS intended_site_local_start,
  to_char(sh."end", 'YYYY-MM-DD HH24:MI')                       AS intended_site_local_end,
  (sh.start AT TIME ZONE s.timezone) AT TIME ZONE 'UTC'         AS corrected_start,
  (sh."end"  AT TIME ZONE s.timezone) AT TIME ZONE 'UTC'        AS corrected_end
FROM shifts sh
JOIN sites s ON s.id = sh."siteId"
WHERE s.timezone IS NOT NULL AND btrim(s.timezone) <> ''
  AND (sh.start AT TIME ZONE s.timezone) AT TIME ZONE s.timezone = sh.start
  AND (sh."end"  AT TIME ZONE s.timezone) AT TIME ZONE s.timezone = sh."end"
  AND ((sh.start AT TIME ZONE s.timezone) - interval '1 hour') AT TIME ZONE s.timezone <> sh.start
  AND ((sh."end"  AT TIME ZONE s.timezone) - interval '1 hour') AT TIME ZONE s.timezone <> sh."end"
  AND (sh.start AT TIME ZONE s.timezone) AT TIME ZONE 'UTC' <> sh.start
ORDER BY sh.start;

-- ── A4. MANUAL REVIEW: ambiguous, nonexistent and insufficient-evidence values ──────────────────
-- These are EXCLUDED from Part B. Do not convert them in bulk.
WITH candidates AS (
  SELECT 'rota_slots' AS tbl, 'startAt' AS col, rs.id, s.timezone, rs."startAt" AS stored FROM rota_slots rs JOIN sites s ON s.id = rs."siteId"
  UNION ALL SELECT 'rota_slots', 'endAt', rs.id, s.timezone, rs."endAt" FROM rota_slots rs JOIN sites s ON s.id = rs."siteId"
  UNION ALL SELECT 'shifts', 'start', sh.id, s.timezone, sh.start FROM shifts sh JOIN sites s ON s.id = sh."siteId"
  UNION ALL SELECT 'shifts', 'end', sh.id, s.timezone, sh."end" FROM shifts sh JOIN sites s ON s.id = sh."siteId"
  UNION ALL SELECT 'timesheets', 'scheduledStartAt', t.id, s.timezone, t."scheduledStartAt" FROM timesheets t JOIN shifts sh ON sh.id = t."shiftId" JOIN sites s ON s.id = sh."siteId" WHERE t."scheduledStartAt" IS NOT NULL
  UNION ALL SELECT 'timesheets', 'scheduledEndAt', t.id, s.timezone, t."scheduledEndAt" FROM timesheets t JOIN shifts sh ON sh.id = t."shiftId" JOIN sites s ON s.id = sh."siteId" WHERE t."scheduledEndAt" IS NOT NULL
)
SELECT tbl AS "table", col AS "column", id AS record_id, timezone AS site_timezone, stored AS current_value, issue
FROM (
  SELECT c.*,
    CASE
      WHEN c.timezone IS NULL OR btrim(c.timezone) = ''                                             THEN 'E_insufficient'
      WHEN (c.stored AT TIME ZONE c.timezone) AT TIME ZONE c.timezone <> c.stored                   THEN 'D_nonexistent'
      WHEN ((c.stored AT TIME ZONE c.timezone) - interval '1 hour') AT TIME ZONE c.timezone = c.stored THEN 'C_ambiguous'
    END AS issue
  FROM candidates c
) flagged
WHERE issue IS NOT NULL
ORDER BY issue, "table", record_id, "column";

-- ── A5. Timesheet provenance ────────────────────────────────────────────────────────────────────
-- A timesheet's scheduled times are a COPY of shift.start/end taken when the timesheet opened. They may
-- therefore be corrected only when they still match the shift they came from — otherwise the copy has
-- since diverged (an approved correction, a rescheduled shift) and the provenance is no longer clear.
-- Actual attendance times are shown for context and are NEVER corrected.
SELECT
  t.id                                                          AS timesheet_id,
  t."shiftId"                                                   AS shift_id,
  s.timezone                                                    AS site_timezone,
  t."approvalStatus",
  t."scheduledStartAt"                                          AS ts_scheduled_start,
  sh.start                                                      AS shift_start,
  t."scheduledEndAt"                                            AS ts_scheduled_end,
  sh."end"                                                      AS shift_end,
  (t."scheduledStartAt" IS NOT DISTINCT FROM sh.start
   AND t."scheduledEndAt" IS NOT DISTINCT FROM sh."end")        AS provenance_clear,
  -- Not corrected. Listed so variance can be re-read after the shift correction.
  t."actualCheckInAt",
  t."actualCheckOutAt"
FROM timesheets t
JOIN shifts sh ON sh.id = t."shiftId"
JOIN sites s   ON s.id  = sh."siteId"
WHERE t."scheduledStartAt" IS NOT NULL OR t."scheduledEndAt" IS NOT NULL
ORDER BY t.id;

-- ── A6. Sites with no usable timezone (class E root cause) ──────────────────────────────────────
SELECT id, name, timezone FROM sites WHERE timezone IS NULL OR btrim(timezone) = '';

ROLLBACK;

-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- PART B — THE CORRECTION. COMMENTED OUT. Requires explicit approval of the id list from Part A.
--
-- IDEMPOTENCY
-- Every update is driven by a literal VALUES list of
--     (record id, expected current start, expected current end, corrected start, corrected end)
-- taken verbatim from A3, and matches only while the row still holds the EXPECTED value. A second
-- execution therefore matches zero rows and changes nothing: the guard is the before-image itself, not
-- a date or timezone predicate. There is deliberately no
--     UPDATE ... WHERE <some date range>
-- anywhere, because such a statement is not safe to run twice and cannot tell a legacy row from a
-- corrected one.
--
-- Rows classified C (ambiguous), D (nonexistent) or E (insufficient) MUST NOT appear in these lists.
--
-- Take a backup first (ops/backup-postgres.sh) and keep the Part A output as the before-image.
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

-- ENUMERATED FROM PRODUCTION, 2026-09-29, read-only. Snapshot at enumeration time:
--   59 migrations, latest AddWelfareWindowEvidence1720900000005, PostgreSQL 17.6, TimeZone=UTC
--   1 site (id 14, Europe/London), 4 rota_slots, 4 shifts, 2 timesheets, 2 attendance_events,
--   0 daily_logs, 0 safety_alerts, 0 assignments
--
-- All 20 candidate values classified A_legacy_wall_clock. Zero B, C, D or E: no ambiguous fall-back
-- value, no nonexistent spring-forward value, and the one site has a timezone. Every value moves
-- exactly -60 minutes because all four records fall on 28-29 September 2026, inside BST. Scheduled
-- durations are unchanged by the correction (110, 60, 120, 120 minutes before and after).
--
-- The four other operator-enterable time columns on timesheets — companyApprovedStartAt/EndAt and
-- clientBillingApprovedStartAt/EndAt — are NULL on every row, so the six columns below are the complete
-- correction set. Every other naive timestamp column in the schema is a server-stamped recorded or audit
-- instant (createdAt, submittedAt, verifiedAt, occurredAt, …) and is correct as it stands.

-- BEGIN;
-- SET LOCAL statement_timeout = '60s';
--
-- -- B1. Rota slots. Values copied verbatim from A3.
-- WITH approved(id, expect_start, expect_end, new_start, new_end) AS (
--   VALUES
--     (5, timestamp '2026-09-28 11:40', timestamp '2026-09-28 13:30', timestamp '2026-09-28 10:40', timestamp '2026-09-28 12:30'),
--     (6, timestamp '2026-09-28 13:30', timestamp '2026-09-28 14:30', timestamp '2026-09-28 12:30', timestamp '2026-09-28 13:30'),
--     (7, timestamp '2026-09-29 11:30', timestamp '2026-09-29 13:30', timestamp '2026-09-29 10:30', timestamp '2026-09-29 12:30'),
--     (8, timestamp '2026-09-29 11:30', timestamp '2026-09-29 13:30', timestamp '2026-09-29 10:30', timestamp '2026-09-29 12:30')
-- )
-- UPDATE rota_slots rs
-- SET "startAt" = a.new_start, "endAt" = a.new_end
-- FROM approved a
-- WHERE rs.id = a.id
--   AND rs."startAt" = a.expect_start   -- before-image guard: makes a second run a no-op
--   AND rs."endAt"   = a.expect_end;
-- -- expect: UPDATE 4
--
-- -- B2. Shifts — the positions under each corrected slot (shift 12->slot 5, 13->6, 14->7, 15->8).
-- --     Cancelled and missed shifts are included: their scheduled times are wrong in the same way, and
-- --     leaving them behind would make historical reporting disagree with the rota it came from.
-- WITH approved(id, expect_start, expect_end, new_start, new_end) AS (
--   VALUES
--     (12, timestamp '2026-09-28 11:40', timestamp '2026-09-28 13:30', timestamp '2026-09-28 10:40', timestamp '2026-09-28 12:30'),
--     (13, timestamp '2026-09-28 13:30', timestamp '2026-09-28 14:30', timestamp '2026-09-28 12:30', timestamp '2026-09-28 13:30'),
--     (14, timestamp '2026-09-29 11:30', timestamp '2026-09-29 13:30', timestamp '2026-09-29 10:30', timestamp '2026-09-29 12:30'),
--     (15, timestamp '2026-09-29 11:30', timestamp '2026-09-29 13:30', timestamp '2026-09-29 10:30', timestamp '2026-09-29 12:30')
-- )
-- UPDATE shifts sh
-- SET start = a.new_start, "end" = a.new_end
-- FROM approved a
-- WHERE sh.id = a.id
--   AND sh.start = a.expect_start
--   AND sh."end" = a.expect_end;
-- -- expect: UPDATE 4
--
-- -- B3. Timesheet copies of the scheduled times. Both rows were reported provenance_clear by A5 — each
-- --     still matches the shift it was copied from. Recorded attendance times are NOT touched.
-- WITH approved(id, expect_start, expect_end, new_start, new_end) AS (
--   VALUES
--     (6, timestamp '2026-09-28 13:30', timestamp '2026-09-28 14:30', timestamp '2026-09-28 12:30', timestamp '2026-09-28 13:30'),
--     (7, timestamp '2026-09-29 11:30', timestamp '2026-09-29 13:30', timestamp '2026-09-29 10:30', timestamp '2026-09-29 12:30')
-- )
-- UPDATE timesheets t
-- SET "scheduledStartAt" = a.new_start, "scheduledEndAt" = a.new_end
-- FROM approved a
-- WHERE t.id = a.id
--   AND t."scheduledStartAt" = a.expect_start
--   AND t."scheduledEndAt"   = a.expect_end;
-- -- expect: UPDATE 2
--
-- -- Verify before committing: re-run Part A. A2 must report zero A_legacy_wall_clock values and all 20
-- -- as B_already_correct. Spot-check timesheet 7 / shift 15, whose attendance is a true instant already:
-- --   corrected scheduled start 2026-09-29 10:30:00 vs check-in 2026-09-29 10:30:00.612451
-- --   => booked on 0.6 seconds after the scheduled start, instead of the 59m 59s early it reads today.
-- ROLLBACK; -- change to COMMIT once that check passes.
