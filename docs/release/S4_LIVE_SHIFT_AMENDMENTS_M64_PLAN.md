# S4 Live Shift Amendments — Migration 64 readiness and implementation plan

Status: **PLAN ONLY — awaiting owner approval.** No code, migration, push or deployment. Reviewed against production `b3c13db` (22 Oct 2026).

Sources: the owner's "Live Shift Amendments — Approved Business Rules & Controlled Implementation" brief; the implementation-readiness review; the owner's Phase 1 decisions (22 Oct 2026); the scheduling-safety release `b3c13db`.

## 1. Approved rules this plan implements

- A company extends an **in-progress** shift; the Guard agrees in the app, or authorised staff record the Guard's verbal agreement. No universal cap.
- Company-configurable fatigue thresholds (pilot defaults, not legal limits): warning above 12 scheduled hours; Owner/Admin approval above 14 h; configurable hard limit above 16 h; warning and management review when rest before the Guard's next shift is under 11 h; warning and compliance review above 48 scheduled hours in 7 days.
- Per-person Control Room authorisation; Owner/Admin management approval, self-approval allowed and audited; the proposer may record verbal agreement.
- A disputed verbal agreement keeps the extension pending authorised review; the Guard gets a dispute mechanism and a confirmation through an available channel.
- Prominent last-minute warning. Proposals expire at the current effective end; no retrospective acceptance; an unanswered proposal never extends the shift.
- Original overnight pricing classification preserved; every extension flagged for billing review. MVP immutability: application rules + database constraints + existing audit log.

## 2. What changed since the design (b3c13db) and how the design adapts

| # | b3c13db fact | Design consequence |
| --- | --- | --- |
| C1 | Per-Guard assignment lock (`534_401_402`), ascending, **before** any shift row lock; only `assertNoShiftClash` runs inside the transaction, on its own connection (pool max 10, 10 s connect timeout) | Propose, accept and record-verbal take the Guard lock, then the shift row, then re-check overlap for `[start, proposedEnd)`. Full eligibility (relationship, compliance, leave, fatigue reads) runs **before** the transaction |
| C2 | The Welfare sweep takes the per-shift lock with a non-blocking *try*, takes no row lock, and inserts alerts whose foreign key takes `FOR KEY SHARE` on the shift row; `FOR UPDATE` + a blocking sweep lock deadlocked (SS-12) | Amendment paths lock the shift **`FOR NO KEY UPDATE`** (like Close without Book Off), never `FOR UPDATE`, then take the sweep lock. (The design said `FOR UPDATE`; corrected.) `FOR NO KEY UPDATE` still serialises against Book Off (`FOR UPDATE`), edits, reconciliation and other amendments |
| C3 | `now()` inside a transaction is the transaction start; expiry checks use `statement_timestamp()` (OAW-05) | Accept, verbal and propose compare `"expiresAt"` and the shift end with `statement_timestamp() AT TIME ZONE 'UTC'` |
| C4 | Material-change re-acceptance applies to `ready` shifts; `PATCH /shifts/:id` refuses any schedule change on `in_progress` | No conflict: amendments exist only for `in_progress` shifts and are the **only** route that may move an in-progress end. They never trigger re-acceptance. A proposal on `offered`/`ready` is refused (`SHIFT_AMENDMENT_NOT_LIVE`) and must use the ordinary edit (which re-offers) |
| C5 | Atomic Book On compares start/end/site under the row lock | Unaffected: amendments need an existing Book On |
| C6 | Book Off locks the row `FOR UPDATE` in one transaction | Book Off additionally voids any `awaiting_approval`/`pending` amendment **inside that transaction** (row lock first, amendment rows second). No Book On/Off evidence is written by an amendment |
| C7 | Rota time change refuses any slot with an in-progress position and row-locks positions | Unaffected. An extended rota position's slot keeps its own times; the Rota Planner's live/past state must use the latest `end` of its positions |
| C8 | Guard lock waits have no timeout | Amendment transactions set `SET LOCAL lock_timeout = '5s'`; a timeout is a 409 `SHIFT_AMENDMENT_BUSY` (retryable). Existing paths are not changed |
| C9 | Conditional writes are checked through `returningRows` | Every state change is `UPDATE … WHERE status = <expected> … RETURNING`; zero rows is a precise 409, never a false success or audit entry |

**Lock order for every amendment path:** Guard assignment lock (propose / accept / verbal only) → shift row `FOR NO KEY UPDATE` → Welfare sweep lock `pg_advisory_xact_lock(534_401_401, shiftId)` → amendment row `FOR UPDATE`. Book Off: shift row `FOR UPDATE` → amendment rows. Reconciliation unchanged (row `FOR NO KEY UPDATE` → sweep lock). No path holds an amendment row while waiting on a shift row or Guard lock.

## 3. Review of the 12 design areas

1. **Lifecycle and schema.** States: `awaiting_approval` → `pending` → `accepted` | `declined` | `withdrawn` | `expired` | `voided`; `accepted` (staff-recorded) → `disputed` → `dispute_upheld` | `dispute_corrected`. A pending proposal never changes shift status; only acceptance changes `shifts.end`. Schema in section 4. **Ready.**
2. **Original vs effective end.** `shifts.end` = effective end (all ~25 readers follow it unchanged: Welfare windows, sweep, Missing Book Off, reconciliation grace, Live Operations, exports, client portal, Guard card). `shifts.originalEnd` is set once at the first acceptance; the amendment chain (`previousEnd` → `agreedEnd`) plus audit rows is the full history. **Ready.**
3. **Guard accept / decline.** `PATCH /shift-amendments/:id/respond`, assigned Guard only; idempotent (same answer → stored result 200; different answer → 409 `SHIFT_AMENDMENT_ALREADY_ANSWERED`); accept re-checks expiry (C3), `shift.end = previousEnd` (else `SHIFT_AMENDMENT_STALE`), overlap under the Guard lock (C1) and the hard limit. **Ready.**
4. **Audited verbal agreement.** Only on a `pending`, unexpired proposal; agreed end = proposed end; contact method, contact time (between proposal and now), confirmation statement, reason and staff identity stored; `responseMethod = staff_recorded_verbal`; never written as a Guard response; shown as staff-reported everywhere; confirmation sent to the Guard (decision D4). **Ready.**
5. **Per-person Control Room permission.** New permissions `shifts.amend`, `shifts.amend.approve`, `shifts.amend.record_agreement`, `shifts.amend.resolve_dispute`. Owner/Admin: all. Operations: amend + record. Control Room: amend + record **only when** `company_memberships.canAmendShifts = true` (granted by Owner/Admin, audited). No other permission is widened. **Ready.**
6. **Fatigue safeguards.** `company_shift_policies` row per company with the defaults in section 1; the assessment (figures and thresholds used) is frozen into `fatigueAssessment` jsonb at proposal and re-evaluated at accept. Over the hard limit → 422 `SHIFT_AMENDMENT_FATIGUE_LIMIT`; over the approval threshold or short rest → `awaiting_approval` until an Owner/Admin approves (self-approval needs an explicit confirmation flag, audited). Warnings never block. **Ready.**
7. **Welfare continuity.** Windows are `start + n·interval` up to the effective end; only missed windows are stored, one per index (unique). Extending adds future windows, keeps every existing index, span and record; the interval cannot be changed by an amendment. The sweep is unchanged; it reads the committed end. **Ready.**
8. **Missing Book Off.** Raised at effective end + 15 min. Because proposals expire at the current end and acceptance is never retrospective, an extension can never follow a raised Missing Book Off (the "one per shift ever" index stays safe). The sweep marks lapsed proposals `expired` (cosmetic; acceptance is guarded by C3 regardless). **Ready.**
9. **Attendance and timesheets.** Book On/Off rows are never written by an amendment. Accept updates `timesheets.scheduledEndAt` only when the timesheet is draft, unpaid, uninvoiced and in no client approval; otherwise unchanged and flagged for payroll and billing review. Actual hours remain attendance-verified. **Ready, subject to D1/D2.**
10. **Android 15 / iOS 14.** No status change for a pending proposal, so the live shift never disappears; new response fields are additive and ignored; the extended end appears after refresh; Book Off and Welfare Checks unchanged. These builds **cannot** see or answer a request (decision D5). **Ready.**
11. **Locking and concurrency.** Section 2. **Ready.**
12. **Feature flag and deployment.** `company_shift_policies.amendmentsEnabled` default **false**; all amendment routes return 403 `SHIFT_AMENDMENTS_DISABLED` until an Owner enables it. Migration 64 is additive, so `b3c13db` can run over it (rollback-safe). **Ready.**

## 4. Migration 64 (`1720900000010-AddShiftAmendments`)

Additive, transactional (no index predicate uses a new enum value, so no `transaction = false`):

- **`shift_amendments`**: `id`; `shiftId` (FK shifts, `ON DELETE RESTRICT`), `companyId`, `guardId`; `sequence` (unique with `shiftId`); `status` varchar + CHECK; `originalEnd`, `previousEnd`, `proposedEnd` (CHECK `proposedEnd > previousEnd`), `agreedEnd`; `reason`; `proposedByUserId`, `proposedAt`, `expiresAt`; `fatigueAssessment` jsonb; `approvalRequired`, `approvedByUserId`, `approvedAt`, `approvalStatement`, `selfApproved`; `responseMethod` (CHECK `guard_app` | `staff_recorded_verbal`), `respondedByUserId`, `respondedAt`, `responseReason`; `verbalContactMethod`, `verbalContactAt`, `verbalConfirmation`; `withdrawnByUserId`, `withdrawnAt`, `voidedReason`, `voidedAt`; `disputedAt`, `disputeReason`, `disputeResolvedByUserId`, `disputeResolvedAt`, `disputeResolution`; `payrollReviewRequired`, `billingReviewRequired`; `createdAt`, `updatedAt`.
  - **Partial unique index** on `shiftId` where `status IN ('awaiting_approval','pending')`: a simultaneous second proposal is a 409 `SHIFT_AMENDMENT_PENDING`.
  - CHECKs tying fields to states (e.g. `agreedEnd` and `respondedAt` set iff accepted/disputed/resolved; verbal fields iff `staff_recorded_verbal`).
- **`shifts.originalEnd`** timestamp, nullable.
- **`company_shift_policies`**: `companyId` (unique FK), `amendmentsEnabled` (false), `fatigueWarningHours` (12), `approvalRequiredHours` (14), `hardLimitHours` (16, nullable = none), `minRestHours` (11), `weeklyReviewHours` (48), `lastMinuteWarningMinutes` (10), `updatedByUserId`, `updatedAt`. No row = defaults with amendments disabled.
- **`company_memberships.canAmendShifts`** boolean, default false.
- **`notifications_type_enum`** += `shift_amendment_requested`, `shift_amendment_responded`, `shift_amendment_disputed`, `shift_amendment_expired`.
- `down()`: drops the table, columns and policy table; refuses while any `shift_amendments` row exists (evidence), like Migration 63. Enum values are left in place (PostgreSQL cannot drop them; harmless to older code).

Not required: no change to `attendance_events`, `daily_logs`, `safety_alerts`, timesheets schema or pricing tables.

## 5. Implementation plan

**Branch:** `feature/live-shift-amendments` from `release/s4-pilot-rc1` (`b3c13db`). Local commits and GitHub CI on a draft PR (as for Phases 0/0b). No staging or production movement without approval.

| Step | Scope | Files (indicative) |
| --- | --- | --- |
| 1 | Migration 64 + entities | `src/database/migrations/1720900000010-AddShiftAmendments.ts`; `src/shift-amendment/entities/*.ts`; `company-shift-policy` entity; `entities.ts`; membership entity column |
| 2 | Policy and permissions | `src/shift-amendment/shift-amendment-policy.ts` (fatigue, last-minute, permission helpers); `company-membership-types.ts` (four permissions, per-person Control Room check) |
| 3 | Service and API | `shift-amendment.service.ts`, controller, DTOs. Routes: `POST /shifts/:id/amendments`, `GET /shifts/:id/amendments`, `POST /shift-amendments/:id/approve`, `/withdraw`, `/record-verbal-agreement`, `/dispute`, `/resolve-dispute`, `PATCH /shift-amendments/:id/respond`, `GET`/`PUT /company/shift-policy`, `PUT /company/members/:id/amendment-authorisation` |
| 4 | Integrations | `attendance.service.ts` (Book Off voids open proposals in its transaction); `safety-alert.service.ts` sweep (expire lapsed proposals, idempotent); `shift.service.ts` / projection / export (`originalEnd`, `pendingAmendment`, `amendmentSummary`); timesheet draft-only sync |
| 5 | Audit and notifications | Audit actions `shift_amendment.proposed / approved / accepted / declined / withdrawn / expired / voided / verbal_recorded / disputed / dispute_resolved`, written in the same transaction; in-app notification rows after commit; Guard confirmation email for staff-recorded agreements (D4), best-effort and never part of the transaction |
| 6 | Pricing touch points (only as decided in D1/D2) | Overnight classification reads the original end; night-hours pay follows the draft timesheet's synced end |
| 7 | Company web (Phase 2) | Live Operations detail: Propose Extension, current / original / proposed end, reason, fatigue / overlap / last-minute warnings, pending response, withdraw, approve, record verbal agreement, history, dispute resolution; "Extended" badges (Live Ops, Rota Planner live state from latest position end); operations report/export "Original end"; timesheet and client-approval review flags; company policy and Control Room authorisation settings; friendly messages for every error code |
| 8 | Guard app (Phase 3, build 1.2.0) | Active-shift "Shift Extension Request" card (original end, proposed end, added hours, reason, fatigue note, Accept / Decline), 60 s refresh while in progress, double-tap guard, server re-read after any network error, extension history, staff-recorded agreements with "Report disagreement", small-screen and large-text layouts |

**Machine-readable errors:** `SHIFT_AMENDMENTS_DISABLED`, `SHIFT_AMENDMENT_NOT_LIVE`, `_PENDING`, `_STALE`, `_EXPIRED`, `_ALREADY_ANSWERED`, `_CLASH`, `_FATIGUE_LIMIT`, `_APPROVAL_REQUIRED`, `_FORBIDDEN`, `_BUSY`.

## 6. Tests (CI release gate, own disposable databases)

- `m64-migration.spec.ts`: up on a 63-entry database with real-shaped data; idempotent re-run; `down()` refusal with evidence; `b3c13db` code boots and passes its smoke over the migrated schema (rollback compatibility).
- `shift-amendment.spec.ts` (real HTTP, real auth and audit): the owner's 24 scenarios — accept, decline, withdraw, expiry, last-minute, sequential extensions, Book Off while pending, overlapping future shift, fatigue warning / approval / hard limit / self-approval, verbal agreement authorised and refused, dispute and resolution, tenant isolation, audit integrity, feature flag off, per-person Control Room grant and revoke, proposal on a ready/offered shift refused.
- `shift-amendment-concurrency.spec.ts` (deterministic row-lock holder, as `material-change-reacceptance.spec.ts`): accept vs Book Off (both orders), accept vs withdraw, two simultaneous proposals, accept vs Welfare sweep insert (no deadlock: the SS-12 pattern), accept vs rota assignment of the same Guard into the extended window, accept vs reconciliation, `lock_timeout` → `_BUSY`.
- `shift-amendment-welfare.spec.ts`: windows continue to the new end; existing missed windows untouched and not renumbered; no duplicate window records; Missing Book Off at effective end + 15; overnight and the 25 Oct / 29 Mar BST↔GMT transitions.
- `shift-amendment-finance.spec.ts`: draft timesheet synced; submitted / approved / paid / invoiced untouched and flagged; overnight classification from the original end; night-hours effect per D2.
- Existing suites unchanged and green, plus CHK-GATE-style assertions that the new paths call the compliance gate. Mobile: unit tests for the card and dispute flow; a compatibility check that build-15/14 API contracts are unchanged.

## 7. Release sequence

1. Backend + Migration 64 on the feature branch → CI gate → owner review.
2. Staging (approval required at the time): move `staging/s4-uat`, Render staging runs Migration 64 in its pre-deploy step (ledger 63 → 64), staging UAT with fictional accounts and the flag enabled for the UAT company only.
3. Company web against staging (Vercel preview only; production promotion separately approved).
4. Production backend dark launch (flag off everywhere; ledger 64; rollback to `b3c13db` safe).
5. Guard app 1.2.0 builds after certification and approval; controlled distribution.
6. Owner enables `amendmentsEnabled` for the pilot company.

Estimate: backend + migration + certification 5–7 days; web 3–4 days; Guard app 3 days plus store processing; staging UAT 1–2 days per phase.

## 8. Decisions still required (before code)

- **D1 — Overnight classification code change.** Preserving the original overnight classification (approved) needs a narrow change in the contract-pricing read (classify on the original end). This touches pricing code, which the standing instructions otherwise forbid. *Recommended:* approve this single, tested read change inside the amendment release; no other pricing change.
- **D2 — Night-hours pay on extensions.** Syncing a **draft** timesheet's scheduled end makes extension hours in the night window earn the night premium (without it they earn none). *Recommended:* sync drafts (matches the work done); locked timesheets are never changed, only flagged.
- **D3 — Release order vs PRC-001.** Until the site-time-zone pricing fix ships, night windows in BST are one hour off; extensions make this more visible. *Recommended:* ship amendments first with every extension flagged for billing review (already approved); fix PRC-001 in its own release.
- **D4 — Confirmation channel for staff-recorded agreements.** *Recommended:* email to the Guard's account address through the existing transactional email service (best-effort, with how to dispute), plus in-app visibility from 1.2.0. Guards on 15/14 dispute by contacting the company until 1.2.0.
- **D5 — Enabling before 1.2.0.** Guards on 15/14 cannot see or answer requests. *Recommended:* keep the flag off for the pilot company until 1.2.0 is installed by its Guards; staging may enable it earlier.
- **D6 — Defaults to confirm.** Last-minute warning at 10 minutes before the current end; dispute resolution by Owner/Admin only; the 7-day and rest calculations use scheduled hours of `offered`/`ready`/`in_progress`/`completed` shifts.

## 9. Risks

- Requests are visible only in-app (no push); a last-minute request can expire unseen — mitigated by the prominent warning and phone fallback.
- Guard lock waits elsewhere still have no timeout (amendments use `lock_timeout`).
- PRC-001 remains until its own release (D3).
- A company could set thresholds unsafely high; S4 records and audits the policy but does not provide legal advice.
- Real re-acceptance and atomic Book On paths have not yet been used in production; observe them before layering amendments on top.
