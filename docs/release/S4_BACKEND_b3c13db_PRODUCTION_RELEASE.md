# S4 backend b3c13db — scheduling-safety production release record

Status: **DEPLOYED TO PRODUCTION. CERTIFIED. RELEASE CLOSED** (owner approval, 22 October 2026).
S4 is running as a supervised pilot: the security company and Guards know the system is under test and do not rely on it alone for operational safety.

## 1. What was released

| Item | Value |
| --- | --- |
| Commit | `b3c13db1e2eef581150576c2d6b8882609dedb02` — fix(shifts): a material change to an accepted shift returns it to the Guard for re-acceptance |
| Previous production | `0a982c5` (deployment `dep-dbckeess728c73fb8ha0`, now the rollback target) |
| Contents | Phase 0 (rota assignment concurrency, PR #25: `3fd1ae9`…`ae073e1`), Phase 0b (`581505e`, `fdb2b14`: retime eligibility re-check, Close without Book Off `FOR NO KEY UPDATE`), material-change re-acceptance and atomic Book On (`b3c13db`). Backend only. No migration, no mobile, web, environment or pricing change |
| Branch | `release/s4-pilot-rc1` = `b3c13db` (fast-forward from `ae073e1`, no force; PR #26 merged 22 Oct 18:30:15Z) |
| CI | PR gate `39822569001` on `b3c13db`: success. Release-branch gate `39831974530` (push) on `b3c13db`: success |
| Vercel | Both `b3c13db` builds "Canceled by Ignored Build Step"; `app.sfour.co.uk` still serves `dpl_4sTqSpPMbFvxRJMES9E9j9nWWgem` (`a7b5b22`), correct for a backend-only release |
| Staging | `staging/s4-uat` = `b3c13db`, deployment `dep-dbd5i8oae00c73cp79h0`; staging UAT U01–U13 all PASS (fictional accounts only) |
| Render service | `security-marketplace-api` (`srv-d6ttvdea2pns7391pa0g`), single instance, auto-deploy off |
| Deployment | **`dep-dbd62io473hc73dhkif0`**, manual "Deploy a specific commit" (`b3c13db`); environment, plan, database and migration settings unchanged |
| Started / Live | 22 Oct 2026 19:17:31Z / 19:19:07Z (20:17:31 / 20:19:07 BST), 1m36s |

## 2. Behaviour introduced

- **Rota assignment concurrency (Phase 0).** Assignments take a per-Guard advisory lock (`GUARD_ASSIGNMENT_LOCK_NAMESPACE`, ascending Guard id, before any shift row lock) and re-check overlap on the transaction's own connection; a lost race is an accurate 409 with no audit entry.
- **Retime eligibility (Phase 0b).** Retiming an assigned shift re-runs the Guard's full eligibility check. Close without Book Off locks the shift `FOR NO KEY UPDATE`, so it no longer deadlocks with the Welfare sweep's alert inserts.
- **Material-change re-acceptance (owner rule, 22 Oct 2026).** Any actual change to an accepted (`ready`) shift's start, end or site returns it to the same Guard as `offered`, through `PATCH /shifts/:id` and `PATCH /rota-slots/:id/time`, audited as `shift.reacceptance_required` with the accepted and revised terms. Notes, instructions and the Welfare interval are not material. An acceptance of superseded terms is refused (409).
- **Atomic Book On.** One transaction under the shift row lock; only a still-`ready` shift on the checked terms can start. A re-offered shift cannot be Booked On; failed attempts write no attendance; a concurrent duplicate Book On returns the same event.

## 3. Verification

| Check | Result |
| --- | --- |
| Preflight (19:14Z) | Production on `0a982c5`; release at `b3c13db`; gate passed; staging 13/13; health 200/200; ledger 63; rollback deployment present; no other deploy in progress |
| Correct commit Live | `dep-dbd62io473hc73dhkif0` "Deploy succeeded / Live", source `b3c13db` |
| Health | `/health/ready` 200 on all 31 samples through the rollout (19:17–19:33Z, no downtime); `/health/live` and `/health/ready` 200/200 on all 10 monitoring rounds and the final check (20:23Z); `app.sfour.co.uk` 200 |
| Migrations | Ledger **63**, last `AddComplianceLapseAlerts1720900000009`, unchanged before and after |
| Startup and errors | "Nest application successfully started", processTimeZone UTC. No 5xx responses, no "failed" lines in the last hour of application logs; the only "ERROR" text is the existing notice that error monitoring is disabled (Sentry DSN not set) |
| Record integrity | **PASS**. Per-row hash comparison with the 19:14:41Z baseline, immediately after the deploy, every five minutes for 50 minutes and at 20:23Z: no existing attendance, timesheet, incident, Welfare log, audit, alert, shift, rota, company, user, Guard or site row changed or was deleted |
| Duplicates / conflicts | 0 duplicate attendance events, 0 duplicate open alerts, 0 double-booked Guards, 0 database deadlocks, throughout |
| Welfare scanner | **Continued on the new build.** Live shift 48 (company 9): its window-0 evaluation (19:05:39Z, before the deploy) stands; the Guard's 19:01Z and 20:04Z Welfare Checks satisfied the following windows, so no new miss was due. At 20:19:02Z the sweep issued its idempotent alert insert, which correctly produced no duplicate row (`ON CONFLICT DO NOTHING` on the partial unique index). No sweep failures logged |
| New records since deploy | Only ordinary pilot activity: one Welfare Check log (shift 48, 20:04:16Z) and its two audit rows |
| Monitoring window | 64 minutes (19:19Z–20:23Z), more than two 5-minute sweep cycles |

All reads of production were made with the read-only credential inside `READ ONLY` transactions ending in `ROLLBACK`, returning counts, ids, timestamps and per-row hashes only. No production test data was created.

## 4. Not yet observed in production

No company changed an accepted shift and no Guard Booked On or Off during the monitoring window, so the **re-acceptance path** (`shift.reacceptance_required`, revised offer, re-acceptance) and the **atomic Book On path** have **not yet been exercised by real pilot use**. Both were certified in CI (`material-change-reacceptance.spec.ts` RA-01..17, with 18 of 21 failing on the previous code) and on staging (U03–U09, U12, U13). Watch the first real occurrences: a company changing an accepted shift's start, end or site should see it return to Offered (and should phone the Guard; there is no push notification); a Guard Booking On a re-offered shift should see "This shift is waiting for you to accept it…".

## 5. Rollback

Render rollback to `dep-dbckeess728c73fb8ha0` (`0a982c5`). Code-only: no migration was involved. Never automatic; owner decision only. Rolling back re-opens the pre-release behaviour (accepted shifts retimed without re-acceptance; non-atomic Book On; the rota assignment race), so it is a last resort.

## 6. Carried forward

- Shift 19 (company 8) is still `in_progress` from 30 September with an open Missing Book Off alert: a company action (Close without Book Off), not a release issue.
- Guard assignment lock waits have no timeout; the Rota Planner time change still runs its eligibility reads inside its transaction (pre-existing).
- No Guard push notification for revised offers; a material change to instructions does not trigger re-acceptance.
- PRC-001 (pricing uses UTC instead of the site time zone) and PRC-002 (financial read paths ignore frozen snapshots) remain open as a separate pricing release (`docs/release/S4_PRICING_DEFECTS.md`, local branch `docs/pricing-defects`).
