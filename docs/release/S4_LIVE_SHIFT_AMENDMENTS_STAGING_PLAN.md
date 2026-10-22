# S4 Live Shift Amendments — staging deployment and rollback plan

Status: **PLAN — awaiting owner approval.** Nothing in this plan has been executed. Staging and production are at
`b3c13db` (ledger 63). Candidate: `feature/live-shift-amendments` @ `a68f9d6` (draft PR #27, not merged).

## 0. Approvals this plan needs (each at the time it is used)

| # | Action | Why it needs approval |
| --- | --- | --- |
| A1 | Fast-forward `staging/s4-uat` `b3c13db` → `a68f9d6` | Render staging deploys from it; it runs ahead of release with an unmerged feature |
| A2 | Deploy `a68f9d6` to Render staging, whose pre-deploy step applies **Migration 64** (ledger 63 → 64) | First schema change on staging since 63; `down()` is refused once amendment rows exist |
| A3 | A staging **platform administrator** to switch amendments on for the UAT company | Activation is S4-admin only. The owner runs the repository's own `admin:bootstrap` / `admin:recover` against **staging** in their own terminal (masked prompt); Claude never types a credential |
| A4 | Enable `amendmentsEnabled` for the fictional UAT company **only** | Owner decision D5 |
| A5 | (Optional) extra fictional staff accounts (Operations, Control Room) on staging | To exercise per-person Control Room authorisation on staging; otherwise covered by CI (LSA-12) |

## 1. Pre-flight (read only)

1. `staging/s4-uat` = `b3c13db`; release = `b3c13db`; production Render live on `b3c13db` (`dep-dbd62io473hc73dhkif0`).
2. PR #27 gate green on `a68f9d6`.
3. Staging `/health/live` and `/health/ready` 200; ledger **63**, last `AddComplianceLapseAlerts1720900000009`.
4. `staging-uat-seed.ts --target staging --report` (read only): 3 fictional accounts, UAT shifts and evidence as before;
   "Migration 64 not applied".
5. **Per-row hash baseline** of every existing staging table (read-only transaction), new columns excluded — the same
   method that proved "all 53 tables, 320 rows byte-identical" on the local copy.
6. Production read-only baseline (ledger 63, counts, hashes) — production must not change at any step.

## 2. Deploy and migrate (A1, A2)

1. `git push origin a68f9d6:refs/heads/staging/s4-uat` (fast-forward, no force). Vercel: backend-only, the ignore step cancels.
2. Render staging → Manual Deploy → **Deploy a specific commit** → `a68f9d6`. Never "Deploy latest".
3. Watch the deploy: pre-deploy `migration:run:prod` must log
   `Migration AddShiftAmendments1720900000010 has been executed successfully`, then "Nest application successfully started".
4. Record the deploy id. The previous staging deploy `dep-dbd5i8oae00c73cp79h0` (`b3c13db`) is the code rollback target.

## 3. Verify (read only)

1. Ledger **64**, last `AddShiftAmendments1720900000010`; 0 pending (repository files vs ledger).
2. `/health/live`, `/health/ready` 200; no startup or database errors; no 5xx.
3. Hash comparison vs §1.5: **every pre-existing row byte-identical** (attendance, timesheets, Welfare logs, alerts,
   audit, shifts, users …). New tables empty; `shifts.originalEnd` all null; `canAmendShifts` all false.
4. `--report`: ledger 64; "shift amendments: none; amendments enabled for: no company".
5. **Disabled by default:** with the UAT owner, `POST /shifts/:id/amendments` → 403 `SHIFT_AMENDMENTS_DISABLED`.
6. Welfare scanner continues (a live UAT shift's windows / Missing Book Off as in the previous staging UAT).

## 4. Enable for the UAT company only (A3, A4)

1. Owner creates or recovers a **staging** platform administrator with `admin:bootstrap` / `admin:recover` (own terminal).
2. `PUT /admin/shift-amendments/companies/<UAT company id>` `{ "enabled": true }` — audited
   (`company_shift_policy.amendments_enabled`). Confirm `--report` lists exactly that company.

## 5. Staging UAT (fictional accounts, live shifts created and Booked On through the API)

| ID | Scenario |
| --- | --- |
| LU-01 | Propose → Guard accepts in the API → `end` extended, `originalEnd` kept, draft timesheet synced, audited, notified |
| LU-02 | Decline; withdraw; expiry (shift ending in minutes, no answer → refused after end, recorded expired) |
| LU-03 | Last-minute warning; sequential extensions (sequence 2 references the first agreed end) |
| LU-04 | Fatigue: > 12 h warning; > 14 h owner approval (self-approval confirmation); > 16 h refused |
| LU-05 | Owner records verbal agreement; confirmation email outcome recorded (staging transport); Guard disputes; owner resolves; extension kept |
| LU-06 | Book Off while pending voids the proposal; Book Off evidence unchanged |
| LU-07 | Missing Book Off follows the effective end; Welfare windows continue past the original end (15-minute interval shift) |
| LU-08 | Disable the UAT company → every state-changing route 403; re-enable |
| LU-09 | Deterministic races on the staging database (row lock held, both orders): accept vs Book Off; accept vs withdraw; two proposals; accept vs the sweep lock + alert insert (no deadlock); lock timeout → `SHIFT_AMENDMENT_BUSY` |
| LU-10 | Tenant isolation and audit integrity (one company on staging: cross-company covered by CI LSA-16) |
| LU-11 | Android 15 / iOS 14 contract: `/shifts/my` unchanged while pending; extended end after acceptance |
| LU-12 | No duplicate attendance, alerts or window records; no deadlocks (pg_stat_database) |

## 6. Production unchanged

Read-only, before and after every step: Render production on `b3c13db`; ledger 63; per-row hashes unchanged except
ordinary pilot activity; `app.sfour.co.uk` unchanged. Production is never migrated by this plan.

## 7. Rollback and its limits

| Layer | How | Limits |
| --- | --- | --- |
| **Code** | Render staging rollback to `dep-dbd5i8oae00c73cp79h0` (`b3c13db`) | **Safe with Migration 64 applied** — rehearsed on a copy of the staging data: `b3c13db` boots, serves shifts and Book Off over a 64 database holding an accepted extension and a pending proposal. Old code ignores the new tables and columns |
| Extended shifts | — | **Cannot be un-extended by a rollback.** `shifts.end` stays the agreed extended end; old code treats it as the schedule (Welfare, Missing Book Off and reconciliation follow it, consistently) |
| Open proposals | — | Old code cannot answer, void or expire them: a Book Off under old code leaves a proposal `pending`. On roll-forward it can no longer be accepted (`NOT_LIVE` / `EXPIRED`) and the expiry job records it expired (rehearsed) |
| Notifications | — | Rows of the four new types stay; old code shows them as unknown types (no crash) |
| **Schema** | Migration 64 `down()` | **Refused while any amendment row exists** (evidence). Removing 64 after use needs an export (pg_dump of `shift_amendments`, `shifts`, `audit_logs`) and explicit owner approval, and would drop `originalEnd`. The four enum labels can never be removed. Render rollback never runs `migration:revert` |
| Seeder | — | The `a68f9d6` seeder requires ledger 64; the `b3c13db`-era seeder (on `welfare-alert-remediation`) required 63 — after 64, seed/recover only with the matching code |
| Feature | Switch the UAT company off | Immediate: every state-changing route refused; history readable; the expiry job still records lapses |

## 8. Exit criteria

All of §3 and §5 pass; production unchanged (§6); the UAT company remains the only company enabled. Production
activation remains **NO-GO** until (a) the overnight pricing correction (proposal `6c9dfa8`) is approved and released,
(b) Guard app 1.2.0 is tested, and (c) the owner approves activation.
