# S4 Live Shift Amendments — Phase 3 (Guard app) and coordinated staging plan

Status: **proposal for owner review**. Nothing here has been deployed, built or distributed.

Branch: `feature/live-shift-amendments-guard` (on top of `feature/live-shift-amendments-web`, which is on top of
`feature/live-shift-amendments`). Draft PRs #27 (Phase 1) and #28 (Phase 2) are not merged.

## 1. What Phase 3 adds

| Area | Change | Backend change |
|---|---|---|
| Guard app | Extension request card on Home for the live shift (and any staff-recorded agreement on a recent shift): original and current end, proposed end and extra time, company reason, management approval, the backend's own fatigue warnings, Accept / Decline behind a confirmation, Dispute for a staff-recorded agreement, history. | None — uses the certified `GET /shift-amendments/mine`, `PATCH /shift-amendments/:id/respond`, `POST /shift-amendments/:id/dispute`. |
| Company web | Approval reason stated with the policy threshold; unresolved dispute must be acknowledged before proposing again. | None. |

Reliability rules implemented in the Guard app:
- One answer at a time (in-flight guard + disabled buttons); a retry after a lost response is safe (the server
  returns the stored answer for a repeated identical answer).
- Nothing changes on the device before the server confirms; after an accept the shifts are re-read from the server.
- Expired / withdrawn / answered / approval-required / disabled answers reload the request and say the shift end did
  not change.
- Refresh on the screen's existing minute tick while a shift is live, on foregrounding (15 s minimum) and after every
  full load. No new timer.
- No push service exists for these requests; the card says so ("S4 does not send instant alerts for them").
- Against an older backend without the routes (current production b3c13db), the first plain 404 hides the feature
  for the session — no error shown.
- Book On, Book Off and shift-offer handlers are byte-identical to the Phase 2 baseline (fingerprinted in the spec).

## 2. Proposed backend additions (not implemented — owner approval needed)

Two company-web follow-ups cannot be done correctly with the certified API.

### A. Dry-run assessment — for the pre-submission fatigue and rest preview (follow-up 1)

The rest-before-next-shift and 7-day checks count the Guard's shifts across **all** companies
(`ShiftAmendmentService.assess`). A preview built from the company's own `/shifts` list could say "no short rest"
when the API would require approval, so it is not built client-side.

`POST /shifts/:shiftId/amendments/assessment` — body `{ proposedEnd }`.
- Same permission (`shifts.amend`), company, enabled and live-shift checks as `propose`; read-only: no lock, no row,
  no notification, no audit entry.
- Returns `{ additionalMinutes, totalScheduledHours, warnings, approvalRequired, approvalReasons, hardLimitExceeded,
  restHoursBeforeNextShift, sevenDayScheduledHours }` from the existing `assess()`.
- Exposure: exactly the fields the company already receives in the `propose` response today; no other company's
  shift, site or name. Rate: one call per proposal form change, debounced.
- Tests: values equal the following `propose`'s frozen assessment; disabled company 403; other company 404; no
  audit/notification rows written.

### B. Company staff list — for the Control Room toggle (follow-up 2) and staff names in history (follow-up 5)

There is no endpoint that lists a company's memberships.

`GET /shift-amendments/staff`
- Any company account with a `shifts.amend*` or `shifts.view` permission: `[{ userId, displayName }]` for the
  company's active members and owner (`displayName` = first + last name, or the email's local part when no name is
  set). Used to name proposer / approver / recorder in the history.
- Owner / Admin additionally receive `membershipRole` and `canAmendShifts` for Control Room members, which drives an
  on/off toggle calling the existing `PUT /shift-amendments/control-room/:userId`.
- Tests: tenant isolation (other company's staff never listed); Operations / Control Room never receive
  `canAmendShifts`; Guards 403.

Both are additive, need no migration, and can ship in the same backend deploy as section 3.

## 3. Coordinated staging deployment (prepared, NOT executed)

Current staging: backend `a68f9d6` (`staging/s4-uat`), ledger 64, amendments enabled for company 1 only.
Production: backend `b3c13db`, ledger 63 — untouched by this plan.

One staging backend deploy carrying:
1. `24c8519` — Control Room per-person grant shown in `companyPermissions` (Phase 2; display only).
2. If approved: endpoints A and B above (implemented on this branch first, with their tests and CI).

No migration (ledger stays 64). No change to production, Vercel production, mobile store builds or pricing.

Steps (each needs the owner's go-ahead at the time):
1. Preflight (read-only): staging ledger 64; `staging/s4-uat` = `a68f9d6`; production ledger 63 and `b3c13db`;
   row-count baseline of staging (`staging-baseline.cjs`).
2. Fast-forward `staging/s4-uat` to the approved commit (no force-push) and push; manual Render deploy of the
   staging service only.
3. Post-deploy (read-only + fictional UAT accounts): `/health/ready`; ledger still 64; row counts unchanged except
   new UAT rows; staging company 1 still the only enabled company.
4. UAT: re-run `staging-web-contract.cjs` (W-01..W-07) and `staging-guard-contract.cjs` (SG-01..SG-05); grant the
   fictional Control Room member (if one is created by the seeder) and confirm the permission appears and disappears.
5. Rollback: Render "Rollback" to the `a68f9d6` deploy — no schema change to undo.

## 4. Device testing (needs a development/UAT build — owner approval before building)

- Android 15 and iOS UAT builds pointed at **staging** only (not a store release).
- Scenarios: answer Accept and Decline; double-tap Accept; airplane mode during Accept then retry; app backgrounded
  while the company withdraws, then foregrounded; request expiring while the app is open; staff-recorded agreement
  then Dispute; awaiting-approval request; small phone (320 pt) and large phone; Android back button and keyboard
  over the dispute field.
- Current production builds (Android versionCode 14, iOS build 13) never call these routes; Phase 1 LSA-21 certifies
  the backend keeps their fields unchanged.

## 5. Phase 3 completion record (23 Oct 2026)

- Endpoints A and B implemented in `7fa7c96` (LSA-23, LSA-24; web LSA-UI-23..26). Assessment: dry run, nothing
  written; rest/7-day figures returned only from the requesting company's own shifts. Staff directory: id, display
  name (role when no name), role; Control Room authorisation only to Owner/Admin; no contact details.
- Certified candidate `7fa7c96`: S4 Backend Release Gate 39926645838 and S4 Mobile Release Gate 39926645870 — success.
- Staging: `staging/s4-uat` fast-forwarded `a68f9d6 → 7fa7c96`; Render staging deploy `dep-dbdi3mmq1p3s738n39v0`
  succeeded; ledger 64 → 64; all 53 pre-existing tables byte-identical; company 1 still the only enabled company;
  company regression W-01..W-09 9/9, Guard regression SG-01..SG-05 5/5. Production `b3c13db`, ledger 63, unchanged.

## 6. Mobile build preflight — STOPPED before building

The Guard apps distributed to the pilot (1.1.0: Android versionCode 15 built `8d1873a3`, iOS build 14 built
`7333ba4d`; Play Internal Testing last owner-confirmed with 1.1.0 (14); TestFlight with one associated build of
unconfirmed number) were built from the **local-only** branch `welfare-alert-remediation` (22 commits, not on GitHub,
not in `release/s4-pilot-rc1` or this candidate). It carries the 1.1.0 Guard fixes (Book Off confirmation, keyboard,
offer timing) and the S4 UAT variant (`app.config.js`, `uat` EAS profile, `com.sfour.s4.uat`, staging-only guard,
amber icons) — which already meets every UAT safeguard requested.

A UAT build from `7fa7c96` alone would therefore lack the 1.1.0 fixes and the UAT variant. Proposed (needs owner
approval): merge `welfare-alert-remediation` into the amendment line on a new branch, resolve conflicts in
`GuardDashboardScreen.tsx`, bump the UAT build to versionCode 16 (above the existing UAT APK 15) without changing the
store identity, re-run both gates, then build the Android UAT APK with the existing `uat` profile (signed with the
permanent S4 key, local credentials). iOS UAT (ad hoc, `com.sfour.s4.uat`) needs the owner to register test iPhones
(`eas device:create`) and approve the App ID / ad hoc profile creation interactively.
