# Patrols Phase 1 — owner decisions required before pilot activation

Recorded 29 Oct 2026 with P1-C (`feature/patrols-p1c`). Items 2 and 3 must be implemented before Patrols is switched on
for a pilot company; they are tracked as GitHub issues and are deliberately not part of P1-C (each needs a migration and
changes to the P1-B sweep / sync core).

| # | Decision | Status |
| --- | --- | --- |
| 1 | Control Room acts on patrol alerts with `alerts.manage`, never `patrols.manage` | **Done in P1-C** (commit "feat(patrols): Control Room acts on patrol alerts with alerts.manage…") |
| 2 | Outage reconciliation: no missed-patrol record is permanently lost after a long outage | **Implemented** on `fix/patrols-71-67-lifecycle` (Migration 71) — [#67](https://github.com/fahadjibran1/security-marketplace/issues/67) |
| 3 | Exceptional offline recovery beyond the 24 h post-shift sync window | **Built** on `fix/patrols-68-recovery-grant` (Migration 72) — [#68](https://github.com/fahadjibran1/security-marketplace/issues/68) |
| 4 | The Patrols switch never suspends retention, holds, deletion or exports of existing evidence | **Implemented** on `fix/patrols-71-67-lifecycle` — [#71](https://github.com/fahadjibran1/security-marketplace/issues/71) |

---

## 1. Control Room permissions — done

**Decision.** Control Room operators acknowledge, investigate, escalate and resolve patrol alerts; they are not given
`patrols.manage` (site settings, schedules, checkpoints, routes, labels).

**Finding.** The permission model had no `alerts.manage`: P1-B allowed a company member to act on a patrol alert only with
`patrols.manage` (mirroring compliance alerts, which need `compliance.manage`), so Control Room could see patrol alerts
but not handle them.

**Change (narrow).**
* New company permission `alerts.manage` — Owner, Admin, Operations, Control Room. It only widens who may act on
  **patrol** alerts; every other alert type (panic / SOS, welfare, Missing Book Off, compliance lapse, site requests,
  incidents) keeps its existing rule.
* A member may act on a patrol alert with `alerts.manage` or `patrols.manage` (`mayActOnPatrolAlerts`) — through the
  existing alert endpoints (`PATCH /alerts/:id/ack|close`, resolution options) **and** the Patrols endpoints
  (`POST /patrols/exceptions/:id/acknowledge|resolve`), since they are the same action. The exception still follows its
  alert (and the reverse), audited as the acting user.
* Control Room still has no `patrols.manage`: policies, schedules, checkpoints and routes stay `403 PATROL_FORBIDDEN`.
* The legacy owner account and platform admin keep their rights. `alerts.manage` is not part of the Patrol switch filter
  (`PATROL_PERMISSIONS`): it appears in the session permission list of those four roles; it has no effect on a company
  without patrol alerts.

**Tests.** `scripts/patrol-schedule.spec.ts` PS-A05: Control Room acknowledges and resolves via both paths (audited, the
exception follows); HR / compliance (neither permission), Viewer, Guard and another company's Control Room cannot;
Control Room still cannot edit policies, schedules, checkpoints or routes. PS-A01's former "Control Room 403" expectation
is now asserted for a role with neither permission. Permission-count inventories 41 → 42.

---

## 2. Outage reconciliation — implemented ([#67](https://github.com/fahadjibran1/security-marketplace/issues/67))

**Problem.** `PATROL_SWEEP_LOOKBACK_HOURS = 26`. After an outage longer than that (server, database, or the sweep itself),
windows that ended before `now − 26 h` are never judged, so a missed patrol in the gap is never recorded.

**Design.**
* `patrol_sweep_watermarks (companyId PK → companies, judgedThrough timestamptz, updatedAt)`. The sweep judges from
  `max(judgedThrough, patrols-enabled-at, schedule-changed-at, now − 14 days)`; the watermark advances only after the batch
  that judged up to it commits (inside the existing per-company `PATROL_SWEEP_LOCK_NAMESPACE` transaction).
* Normal operation: the watermark trails `now` by the start grace; nothing changes.
* Reconciliation mode (gap > 26 h): bounded batches (≤ 6 h of windows and ≤ 500 windows per company per pass), oldest
  first, resumable. `patrol_reconciliation_runs (id, companyId, from, to, status, windowsJudged, exceptionsRaised,
  startedAt, completedAt)`.
* Exceptions raised in reconciliation: `patrol_exceptions.reconciliationRunId` (marker) and `actionable = false`
  individually; ONE summary SafetyAlert per (company, site, reconciliation run): "Patrol reconciliation: 37 windows missed
  between Mon 12:00 and Wed 09:00 at North Gate" linking the run. Normal per-window alerts resume once caught up.
* Anything older than the 14-day horizon is not judged: recorded on the run as `unjudgedFrom/unjudgedTo`, audited
  (`patrol.reconciliation_horizon_exceeded`) and raised as one explicit alert — never silently dropped.
* Idempotent: the existing uniqueness `(company, windowKey, scopeKey, type)` and one-alert-per-exception index make repeats
  and crashes harmless; the watermark makes progress durable.
* Uses historical effective attendance and schedule history exactly as the live sweep does; late-synced runs inside the
  gap still satisfy their windows.
* Audit: `patrol.reconciliation_started`, `…_batch`, `…_completed` with counts.

**Tests.** 30 h, 5-day and 20-day outages; crash mid-batch and resume; concurrent sweeps; DST nights inside the gap; no
duplicates; summary alert content; audit trail.

**As implemented (Migration 71, `AddPatrolSweepReconciliation1720900000017`).**
* `judgedThrough` means: every window whose **start deadline** is ≤ it has been judged. The first pass after deploy sets it
  to now (nothing is backdated); every normal pass sets it to now in the same transaction that judged.
* Gap ≤ 26 h: the live pass widens its window-start floor back to `judgedThrough − 26 h` (never beyond now − 52 h), which
  also closes the smaller hole the fixed lookback had after outages shorter than 26 h. No run.
* Gap > 26 h: the live pass keeps alerting normally for deadlines after now − 26 h; deadlines in
  `(judgedThrough, now − 26 h]` go to reconciliation batches (≤ 6 h of deadlines, ≤ 500 judged windows with ties at the
  cut-off kept together, ≤ 8 batches per company per five-minute pass, each batch its own transaction under the
  per-company `PATROL_SWEEP_LOCK_NAMESPACE` TRY lock, advancing both the watermark and the run's `throughAt`).
* Reconciled exceptions: `reconciliationRunId`, `actionable = false` (no alert each), note "found by outage reconciliation";
  exposed as `reconciliationRunId` by `GET /patrols/exceptions` and resolvable on their own. On completion ONE
  `patrol_missed` summary SafetyAlert per site (`patrolReconciliationRunId`, `patrolWindowKey = reconciliation:site:{id}`),
  listing the first ten windows and "and N more"; closing it never touches the exceptions.
* Beyond 14 days: `unjudgedFrom / unjudgedTo` on the run, audit `patrol.reconciliation_horizon_exceeded`, and ONE alert
  (`reconciliation:horizon`) when the company has an active schedule.
* Audit: `patrol.reconciliation_started`, `…_batch` (per batch, with `boundedByWindowLimit`), `…_completed` (counts,
  summary alerts), `…_alert_raised`; each reconciled `patrol.exception_raised` carries `reconciled: true`.
* Not changed: run re-evaluation (`judgeRuns`: abandoned / incomplete / verification) keeps its 4-day review window.
* Tests: `scripts/patrol-reconciliation.spec.ts` (PR-01…PR-10), `scripts/m71-migration.spec.ts` (M71-01…M71-10).

---

## 3. Exceptional offline recovery — built ([#68](https://github.com/fahadjibran1/security-marketplace/issues/68))

**Keep** the standard 24 h post-shift sync window (`postShiftSyncHours`, 1–72 h).

**Design.**
* `patrol_sync_recovery_grants (id, companyId, guardId, shiftId, reason, createdByUserId, createdAt, expiresAt,
  revokedAt, revokedByUserId, revokeReason, uses)` with composite FKs to the company's shift / Guard, a CHECK that
  `expiresAt ≤ createdAt + 72 h`, and an index on active grants.
* Issued and revoked by Owner / Admin only (a new `patrols.recovery` permission or `patrols.holds`), reason mandatory,
  every issue / use / revoke audited.
* The sync paths (run start, scan, completion, photo upload intent and completion) consult an active grant **only** when the
  normal window has closed, and only for that Guard and that shift. No other permission changes; replays of accepted
  writes keep working as today.
* Accepted-via-grant data is flagged `recovered_via_grant`, `needsReview = true`, provisional. Photos are verified exactly
  as in P1-C (hash, image checks, quarantine on mismatch).
* Never auto-clears an exception or alert: late evidence annotates them (P1-B / P1-C behaviour) and a person resolves.
* Exports list the flag in the manifest; holds / retention treat the evidence like any other.

**Tests.** No grant → refused; another Guard / shift / company → refused; expired / revoked → refused; inside a grant →
accepted, flagged, needsReview; alerts never closed; audit; Owner / Admin only.

**As built (`fix/patrols-68-recovery-grant`, Migration 72 = `1720900000018-AddPatrolSyncRecoveryGrants`; it follows
Migration 71 = `1720900000017-AddPatrolSweepReconciliation`; 019 is reserved by another branch).**
* Table `patrol_sync_recovery_grants` (+ `lastUsedAt`); CHECKs: `expiresAt` after issue and ≤ issue + 72 h, a real reason,
  revocation all-or-none with its own reason, `uses`/`lastUsedAt` consistent. Composite FK `(shiftId, companyId)` →
  `shifts(id, companyId)` via a new `UQ_shifts_id_company` (id is the PK, so it rejects nothing). down() refuses while
  grants exist.
* Permission: the existing `patrols.holds` (Owner / Admin) — no new permission, so no session inventory changes.
* API: `POST /patrols/recovery-grants` `{ shiftId, guardId?, durationHours? (1–72, default 24), reason }` — guardId
  defaults to the shift's Guard; another Guard only if they have attendance or a patrol run on the shift; the shift must
  be in progress or completed and have a site; one active grant per Guard and shift (409
  `PATROL_RECOVERY_GRANT_ALREADY_ACTIVE`). `GET /patrols/recovery-grants?status=active|all&shiftId=`.
  `POST /patrols/recovery-grants/:id/revoke` `{ reason }` (409 `PATROL_RECOVERY_GRANT_ENDED` once revoked or expired).
  Another company's shift or grant: 404. Audit: `patrol.recovery_grant_issued` / `_revoked` (in the change's
  transaction) and `patrol.recovery_grant_used` (step, record, run) for every acceptance a grant allowed.
* Sync paths: run start, scan, completion, photo upload intent and a re-issued upload URL consult an active grant only
  when the window has closed. Accepted data: `recovered_via_grant` (a review flag) on the run / visit / photo, the run
  and photo `needsReview`, provisional as every post-shift write. Photo completion needs no grant (as in P1-C, a URL
  already issued can complete) and verifies exactly as P1-C.
* Sweep: a run in progress is not closed by the sync-window rule while its Guard holds an active grant for its shift; a
  run already `closed_by_system` takes its scans and completion under a grant (status becomes completed / incomplete,
  the settled verification is not reopened — a person reviews it).
* Dashboard: "Late-sync recovery grants" panel on Patrol Management → Downloads, retention & holds (Owner / Admin).
  Guard app: a window-closed refusal shows "Send again" (P1-E-guard-app.md); nothing is retried automatically.
* Specs: `scripts/m72-migration.spec.ts` (10), `scripts/patrol-recovery-grants.spec.ts` (PR-01 … PR-10); mobile
  `patrol-management-ui.spec.cjs` PM-19 / PM-20 and `guard-patrols.spec.cjs` GPAT-22.

---

## 4. Switch-off never suspends the evidence lifecycle — implemented ([#71](https://github.com/fahadjibran1/security-marketplace/issues/71))

* Evidence maintenance (orphan verification, retention claims, quarantine moves, purge / tombstone) runs for every
  company with Patrols on **and** every company with any patrol evidence record, whatever its switch. Holds protect
  exactly as before. Exports already requested are built (the former `patrols_disabled` build failure is gone).
* With the switch off, Owner / Admin (`patrols.holds`) keep the evidence-management routes while the company has any
  evidence record, hold or export: holds (list / place / release), delete and restore, exports (request / list / status /
  download) and storage usage. Everyone else, and a company that never had evidence, still gets 404 PATROLS_NOT_ENABLED.
* Still blocked with the switch off: Guard uploads and completions, runs, scans, configuration, the sweep, viewing a
  photo (`patrols.evidence`), including a page of thumbnail links (#79, `GET /patrols/runs/:id/evidence/thumbnails`).
  The session permission list is unchanged (it omits `patrols.*` while off), so a web UI for switched-off evidence
  management needs its own cue.
* Tests: `scripts/patrol-evidence.spec.ts` PE-W01; `scripts/patrol-foundation.spec.ts` PF-19.

---

## 5. S4 1.2.1 — schedule versions are durable (Migration 73)

Owner decision B1 (1.2.1): a timing change to an active schedule archives it and creates a successor with a new id; a
window belongs to the version in force at its start. 1.2.1 first linked the two versions only through the
`patrol.schedule.superseded` audit entry; **1.2.1 includes Migration 73**, which makes the link a column.

* **Migration 73 = `1720900000020-AddPatrolScheduleSuccessors`** (follows Migration 72 = `1720900000018`;
  `1720900000019` stays reserved by another branch — no file with that timestamp exists on any branch). Additive:
  `patrol_schedules."supersededByScheduleId"` (int, null) and `"supersededAt"` (timestamptz, null); CHECKs both-or-none,
  never itself, only on an archived schedule; composite FK `("supersededByScheduleId", "companyId", "siteId")` →
  `patrol_schedules ("id", "companyId", "siteId")` (the existing `UQ_patrol_schedules_id_company_site`), so a successor is
  always the same company AND site — declarative, chosen over a trigger; partial UNIQUE on the successor (one
  predecessor per successor); partial index on `companyId` for the reads. Backfill from the audit entries is idempotent
  (earliest valid entry per schedule and per successor; never across a site or company). Nothing else is written.
  `down()` refuses while any link exists (as Migration 72 does for grants).
* **Service:** the predecessor is locked `FOR UPDATE`; the link is written `WHERE "supersededByScheduleId" IS NULL`; a
  concurrent second edit gets 409 (`PATROL_VALIDATION_FAILED`, `details.supersededByScheduleId`), never a second
  successor; the unique index is the backstop. Owner rule for a PAUSED schedule: its timing changes in place only when
  nothing could be reinterpreted (no patrol run, no patrol exception in any status, not itself a successor, and audited
  as created paused and never switched on); otherwise it gets a successor like an active one, and the successor stays
  paused. The check runs after the row is locked `FOR UPDATE`, so a run or exception cannot appear meanwhile. The
  audit entry is still written as evidence; the window engine, sweep, Guard plan and windows-due count read the columns.
* **Rollback to 1.2.0 (4f4de31):** the old code never names the columns (raw `SELECT *` carries two extra null keys;
  the old entity maps only its own columns; inserts leave them null). Locally, the 4f4de31 patrol specs (foundation,
  schedule, evidence, recovery grants, reconciliation, dashboard reads) and boot checks were run against a database
  migrated to 73 (only their "head is Migration 72" assertion relaxed in a scratch copy). After a rollback an
  already-replaced schedule stays archived (hidden) and its successor is an ordinary active schedule: 1.2.0 shows its
  windows from the start of the shift in the Guard plan and day count (those before the edit cannot be covered by old
  runs and are never judged, because its judging floor is its creation), and the predecessor's open window at the edit
  is no longer offered. No row is changed by a rollback; do not revert Migration 73 for an application rollback.
* Specs: `scripts/m73-migration.spec.ts` (M73-01 … M73-09); `scripts/patrol-schedule.spec.ts` PS-C10, PS-C14, PS-C15.

---

## 6. S4 1.3.0 Package B, stage B1 — site setup and shift-based patrols (Migration 74; backend only)

* **Migration 74 = `1720900000021-AddPatrolSiteSetup`** (follows 73 = `1720900000020`; `1720900000019` stays reserved).
  Additive: `shifts.patrolRequirement` (`required` / `not_required`, NULL = site default; `select: false` on the entity);
  `patrol_policies.setupMode` (`off` / `every_shift` / `per_shift`), `windowAnchor` (`scheduled_start` / `book_on`, NULL =
  scheduled start), `setupConfirmedAt` + `setupConfirmedByUserId`; `patrol_schedules.anchor` (`clock` default / `shift`);
  `patrol_routes.kind` (`custom` default / `auto`), `supersededByRouteId` + `supersededAt` (constraints as Migration 73's,
  same company and site); `patrol_checkpoints.confirmedAt` / `confirmedByUserId` / `confirmedTokenVersion` (all or none).
  `down()` refuses while any of that data exists. Certified by `scripts/m74-migration.spec.ts`.
* **Setup** (`GET` / `PUT /patrols/sites/:siteId/setup`, `POST …/setup/confirm`): one view; one save writes the site
  policy (evidence mode as `methods` / `photosPerRun`, photos stay yes / no; `photosPerCheckpoint` 0), the site's
  shift-anchored schedule and the automatic route version in one transaction, under a per-site advisory lock; saving
  never activates; activation is refused (422 `PATROL_SETUP_INCOMPLETE`, `details.checklist`) until complete.
* **Checkpoint test scan** (`POST /patrols/checkpoints/:id/confirm`, patrols.manage): the scanned payload must be this
  checkpoint's current signed label at its site; rotation and revocation clear the confirmation. Every change to the set
  of confirmed checkpoints creates a new automatic route version.
* **Route versions:** a referenced route's checkpoint change (any route; the automatic one always) archives it and links
  a successor (409 `PATROL_ROUTE_SUPERSEDED` to a concurrent edit); every schedule naming the replaced version is moved
  onto the new current one in the same transaction; a window owes the version in force at its start (the chain walked
  back); a run keeps the version it started under. The Guard plan reports each checkpoint's EFFECTIVE photo requirement
  (false on an automatic route / at an active setup site unless an active custom route includes it), matching the server.
* **Shift-based windows** (`patrol-shift-windows.ts`): the operational window grid from the shift's scheduled start
  (Book On by explicit override), whole windows, owed by each effectively required shift on duty (scope `sh{shiftId}`),
  judged only after the latest of the setup's activation, the site's last requirement / anchor change and the shift's
  last requirement change (future windows only). Frequency changes are Migration 73 successors.
* **Stamped photos** (`GET /patrols/evidence/:id/stamped`): derived per request with `sharp` (0.34.5, prebuilt binaries;
  text drawn from an embedded bitmap font as SVG paths, so no system font is needed), streamed, never stored.

### Rollback to 1.2.1 (5d749fa) over a 74 database

Rehearsed locally (`scripts/rehearsals/patrol-b1-compat-scenario.ts` run under both codes; the 5d749fa patrol specs and
boot checks run against databases migrated to 74, only their "head is Migration 73" assertion relaxed in a scratch copy):

* 1.2.1 never names the new columns; its migrations find nothing to run. Pilot-shaped data (a schedule with a Migration 73
  successor, an unconfirmed checkpoint, a run flagged `qr_rule_missing`) reads, plans, counts and is judged identically
  by both codes.
* A shift-anchored schedule is stored inactive with `startsOn = endsOn = 2000-01-01`: the 1.2.1 clock engine yields no
  window for it, so 1.2.1 shows, counts and raises nothing for shift patrols. It lists it as a paused "Shift patrol"
  schedule (do not switch it on under 1.2.1).
* Versioned routes need no rollback step. When a route gets a successor, 1.3.0 moves every schedule that named the
  replaced version onto the new current version in the same locked transaction (audited in `repointedScheduleIds`; not a
  timing change, so no schedule successor, and `updatedAt` — the sweep's judging floor — is untouched). A schedule
  therefore never names an archived route, which is all 1.2.1 follows: its plan lists the route, it shows no "route
  required" warning, and a new patrol starts. History is kept by the chain walked backwards: a window still owes the
  version in force at its start, and a run keeps the routeId it started under (1.2.1 judges such a run on that archived
  version exactly as before). Enforced by `patrol-site-setup.spec.ts` PSS-05 (no schedule ever names a replaced version)
  and `m74-migration.spec.ts` M74-09.
* Rehearsed on a restored copy of the pre-1.2.1 pilot backup in a local scratch cluster
  (`scripts/rehearsals/patrol-b1-restored-setup.ts` with the 1.3.0 code, then `patrol-b1-restored-observe.ts` with the
  5d749fa code): migrating to 74 changes no restored row; after a custom route edit and a shift-patrol setup on site 15,
  5d749fa shows no "route required" warning, starts a new patrol on the current version (201), shows no shift window,
  and every restored row is unchanged.
* Do not revert Migration 74 for an application rollback.

### Known limitation (1.2.1 Guard app): a checkpoint photo prompt on an automatic route

The Guard plan reports each checkpoint's EFFECTIVE photo requirement: a checkpoint's own "photo required" is ignored on
an automatic route and at a site whose setup is active, UNLESS an active custom route includes that checkpoint. So when
a site's setup follows the automatic route (every test-scanned checkpoint) and a checkpoint marked "photo required" is
also on an active custom route that the site does not use, the plan says `photoRequired: true` and the deployed 1.2.1
Guard app opens the camera for a checkpoint photo after the scan.

* The server does not require that photo: verification is scans + the patrol photo (owner decision 6), whatever the
  Guard does. Taking the photo changes nothing; it is kept as evidence like any other.
* Worst case: the Guard declines the photo, and the 1.2.1 app asks for a reason (the reason box) before completing. The
  patrol completes — never blocked — and is recorded exactly as any 1.2.1 completion with a reason: status
  `incomplete` ("Completed with a reason"), one `patrol_incomplete` exception carrying the Guard's words. Its
  verification is unaffected (verified when the scans and the patrol photo are there); no missed-checkpoint or
  unverified exception is raised.
* Certified by `security-backend-nest/scripts/patrol-evidence-b1.spec.ts` PEB-06 (the edge case: prompt reported, photo
  taken → verified; photo declined with a reason → completed, verified, one `patrol_incomplete`) alongside PEB-05 (the
  1.2.1 request sequence on a shift window verifies; no prompt without a custom route).
* Avoid it by not keeping a spare custom route over checkpoints that are marked "photo required" at a site that follows
  the automatic route, or by clearing "photo required" on those checkpoints.

## 7. S4 1.3.0 Package B, stage B2 — Company Dashboard patrol management usability

* **Navigation:** Patrol Management opens on **Setup / Today / Evidence**. **Advanced** shows every earlier tab
  unchanged (Overview, Live Patrols, Schedules, Checkpoints & Routes, History, Photographic Evidence, Downloads /
  retention & holds, Site settings, Storage usage), each with its own permission rule. Nothing was removed.
* **Setup** (the B1 setup API): one workflow per site — which shifts patrol, evidence method (QR only / Photos only /
  QR + Photos; no photo-count setting), frequency and anchor (scheduled start by default, Book On as the override),
  checkpoints with printable labels and the authorised test scan (`POST /patrols/checkpoints/:id/confirm`; the scanned
  text from a handheld scanner or pasted). A plain-English checklist sits beside it; **Activate** stays disabled until
  every item passes and the changes are saved, and the server's 422 `PATROL_SETUP_INCOMPLETE` is shown as "Not
  activated yet. Still to do: …". A final summary says what will happen before activation.
* **Rota Planner:** the shift (slot) create form and the shift drawer have **Patrol Requirement** — Use Site Default /
  Required / Not Required — beside the site default (which shifts patrol, how often, from when). Backend:
  `POST /rota-slots` and `PATCH /rota-slots/:id` accept an optional `patrolRequirement` (written to the slot's
  positions, `shifts.patrolRequirement`; absent = NULL = the site default, exactly as before); added and replacement
  positions inherit it; an edit changes open positions only, with one audited `shift.patrol_requirement_changed` each
  (the sweep's future-windows floor); slot detail responses add `patrolRequirement` (value or `mixed`, effect, site
  default with its frequency) only for companies with Patrols on. No migration. Certified by
  `patrol-site-setup.spec.ts` PSS-12.
* **Evidence:** Client → Site → Date → Patrol time → Guard (`/patrols/evidence/tree`, `/patrols/evidence/patrols`); QR-only
  patrols included, "Photos only" filter; one patrol record with its QR scans, photos, verification status and the
  server's explanation. A photo opens as the **original** (the existing short-lived audited link, with a stated reason)
  or **stamped** (`/patrols/evidence/:id/stamped`, fetched with the session into memory; the stamp reads
  `www.sfour.co.uk` with no protocol prefix — PB1-09). No link or image data is ever shown as text, logged or stored.

---

## Also recorded with P1-C (not owner decisions)

* Retention ships in `report` mode (`PATROL_EVIDENCE_RETENTION_MODE`); switch to `enforce` after reviewing the counts.
* Before activation: certify the non-production R2 bucket with `npm run test:patrol-evidence-storage` and add the
  `patrol-incoming/` lifecycle rule (see `P1-C-evidence-storage.md`).
* P1-D (Guard app) must capture photos without location EXIF and complete uploads with retries.
