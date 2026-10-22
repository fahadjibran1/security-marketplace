# S4 backend 0a982c5 — production release record

Status: **DEPLOYED TO PRODUCTION. CERTIFIED. RELEASE CLOSED** (owner approval, 22 October 2026).
S4 is running as a supervised pilot: the security company and Guards know the system is under test and do not rely on it alone for operational safety.

## 1. What was released

| Item | Value |
| --- | --- |
| Commit | `0a982c5e1b138e46a8d5999876ebedac7e719464` — fix(shifts): an offer whose shift has ended can no longer be accepted |
| Parent (previous production) | `a7b5b22` — fix(security): never delete a shift that has a timesheet |
| Change | Backend only: `src/shift/offer-acceptance-window.ts` (new), `src/shift/shift.service.ts`, two specs, one `package.json` script. No migration, no mobile or web change. |
| Branch | `release/s4-pilot-rc1` = `origin/release/s4-pilot-rc1` = `0a982c5` (fast-forward from `a7b5b22`, no force) |
| CI | S4 Backend Release Gate run `39688307309` on `0a982c5`: success |
| Render service | `security-marketplace-api` (`srv-d6ttvdea2pns7391pa0g`), single instance, auto-deploy off |
| Deployment | **`dep-dbckeess728c73fb8ha0`**, manual "Deploy a specific commit" with the full SHA |
| Started / Live | 22 Oct 2026 00:14:03 BST / 00:15:41 BST (21 Oct 23:14:03Z / 23:15:41Z), 1m38s |
| Pre-deploy step | `npm run migration:run:prod`: "No migrations are pending" |

Not changed by this release: production data, environment variables, Vercel (`app.sfour.co.uk` still serves the `a7b5b22` web build, which is correct because the release has no web change), Android build 15 and iOS build 14.

## 2. Verification

| Check | Result |
| --- | --- |
| Correct commit Live | Render events: `live dep-dbckeess728c73fb8ha0 0a982c5` is the latest event; re-confirmed at release close |
| Health | `/health/live` and `/health/ready` returned 200 on all **22** checks (0.23–0.72 s) |
| Migrations | Ledger at **63**, last `AddComplianceLapseAlerts1720900000009`; unchanged before, during and after the deploy and at release close |
| Startup | "Nest application successfully started", processTimeZone UTC, first `/health/ready` 200 |
| Errors | No startup or database errors, no 5xx responses, no "failed" log lines. The only "ERROR" text is the existing notice that error monitoring is disabled (Sentry DSN not set) |
| Record integrity | **PASS** in all 8 comparisons with the pre-deploy snapshot (immediately after deploy, seven rounds five minutes apart, final check at 00:08Z): no table count fell; attendance, Welfare Check logs, incidents and audit rows that existed before the deploy are byte-identical; no duplicate alerts, window records or attendance events |
| Welfare scanner | **Resumed correctly** on the new build (started 23:15:37Z). 23:25:39Z: raised the Missing Book Off alert for shift 66 exactly when its 15-minute grace ran out. 00:05:38Z: recorded missed window 5 for shift 45 and escalated its existing summary without a duplicate. No duplicates in the sweeps between; no sweep failures logged |
| New records since deploy | Only ordinary pilot activity: session refreshes, the shift 66 Missing Book Off alert and its audit row, the shift 45 missed-window record and escalation audit |
| Monitoring window | 53 minutes (23:15Z–00:08Z) |

All reads of production were made with the read-only credential inside `READ ONLY` transactions ending in `ROLLBACK`, returning counts and checksums only.

## 3. Guard acceptance not yet observed in production

No real Guard accepted or declined an offer during the monitoring window, so the new rule (an offer cannot be accepted once its shift has ended) and acceptance latency have **not yet been observed in production**. They were certified on staging and locally (`test:offer-acceptance-window`, `test:shift-offers`). Watch the first real offer responses during normal pilot use: expect success for shifts not yet ended, a 409 `SHIFT_OFFER_EXPIRED` for ended ones, and no new acceptance after shift end beyond the historic shift 42.

## 4. Rollback

| Item | Value |
| --- | --- |
| Rollback target | **`a7b5b22`**, Render deploy `dep-dbbhplff3r2c738uobc0` (Live 20 Oct 2026 08:49 BST until this release) |
| Method | Render dashboard → Events → that deploy → Rollback. Code only: both commits are at migration 63, so the pre-deploy migration step is a no-op |
| Consequence | Restores the earlier behaviour in which an offer can be accepted after its shift has ended. No data is removed |
| Rule | Never roll back automatically. Assess operational and data consequences first and get owner approval |

## 5. Open pilot items at release close (control-room, not release defects)

- Shift 45 (company 9): missed-Welfare summary alert 33012 open since about 19:10Z on 21 Oct, with repeated missed windows.
- Shift 66 (company 9): Missing Book Off alert open.

Neither was acknowledged or closed as part of this release.
