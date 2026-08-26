# S4 v1.0.0 Pilot UAT — Executable Test Cases

Use with `UAT_MASTER_PLAN.md`. Record actual results and evidence in the execution log; do not edit expected results to make a failure pass.

## AUTH / TENANCY

### UAT-AUTH-001 — Company registration and login [P0]
**Preconditions:** unused company email.
**Steps:** Register a company with valid required fields; log out; log back in.
**Expected:** registration succeeds; company profile exists once; login returns company principal; no guard/admin privileges are granted.
**Failure severity:** High.

### UAT-AUTH-002 — Guard authentication is separate from work eligibility [P0]
**Steps:** Register a new guard through the public flow; confirm the User account and GuardProfile states independently; log in as the guard; while the GuardProfile remains pending/unapproved/unvetted and required compliance or screening is incomplete, attempt hire, assignment and other work-eligible operations; inspect the resulting commercial and assignment records.
**Expected:** registration succeeds; the User account is ACTIVE and the guard can authenticate; the GuardProfile remains pending/unapproved/unvetted; authentication does not make the guard work-eligible; hire, assignment and other work-eligible operations are rejected until the required compliance, screening and approval conditions are satisfied; rejected attempts create no partial commercial, assignment or shift records.
**Failure severity:** Critical if an incomplete, unapproved or unvetted guard becomes work-eligible or if a rejected operation leaves partial commercial or assignment records.

### UAT-AUTH-003 — Privileged self-registration rejected [P0]
**Steps:** Call public registration requesting `admin`, `company_staff`, `client_admin` and `client_viewer` roles.
**Expected:** every privileged role request is rejected and no orphan user is created.
**Failure severity:** Critical.

### UAT-AUTH-004 — Company A cannot read Company B guard data [P0]
**Steps:** Authenticate as Company A; attempt list and direct-ID reads for Guard B / Company B records.
**Expected:** Company B data is absent or access is rejected; no SIA/contact/compliance data leaks.
**Failure severity:** Critical.

### UAT-AUTH-005 — Company A cannot write Company B records [P0]
**Steps:** As Company A, submit known Company B IDs in company-guard, availability, leave, site/client-related write paths where IDs are accepted.
**Expected:** server derives Company A tenant or rejects the request; Company B data is unchanged.
**Failure severity:** Critical.

## GUARD / COMPLIANCE

### UAT-GRD-001 — Guard approval [P0]
**Preconditions:** Guard A has an ACTIVE User account and a pending/unapproved/unvetted GuardProfile.
**Steps:** Platform/company-authorized workflow approves Guard A.
**Expected:** the GuardProfile approval/status transition is recorded; authenticated account access remains independent of approval; approval permits work-eligible Guard operations only when the required compliance, screening and other eligibility conditions are also satisfied.
**Failure severity:** High.

### UAT-GRD-002 — Ineligible compliance blocks assignment [P0]
**Steps:** Make required compliance expired/missing; attempt to match/hire/assign Guard A to a shift.
**Expected:** eligibility is false with a clear blocking reason; assignment/shift commitment is not created.
**Failure severity:** Critical if invalid guard can be assigned.

### UAT-GRD-003 — Valid compliance restores eligibility [P0]
**Steps:** Supply/verify required compliance; rerun eligibility.
**Expected:** compliance blocking reason disappears, subject to availability/leave/clash rules.
**Failure severity:** High.

## CLIENT / SITE

### UAT-SITE-001 — Create client and site in own tenant [P0]
**Steps:** Company A creates Client A and Site A.
**Expected:** both belong to Company A; Company B cannot access them.
**Failure severity:** Critical for wrong tenant ownership.

### UAT-SITE-002 — GPS-required site configuration [P0]
**Steps:** Configure Site GPS with known latitude, longitude and geofence radius; enable GPS Book On.
**Expected:** site saves without exposing any NFC secret; configuration is used by attendance validation.
**Failure severity:** High.

## JOB / MARKETPLACE / HIRE

### UAT-JOB-001 — Create open job [P0]
**Steps:** Company A creates an open job linked to Site A with guard requirement and pay/billing data.
**Expected:** job belongs to Company A and is visible through correct company/marketplace views.
**Failure severity:** High.

### UAT-JOB-002 — Guard applies once [P0]
**Steps:** Eligible Guard A applies to open job; repeat the same application action.
**Expected:** first application succeeds; duplicate application does not create a second active application.
**Failure severity:** High.

### UAT-JOB-003 — Closed/filled job rejects new application [P0]
**Steps:** Close/fill the job; attempt a new guard application.
**Expected:** request is rejected with no application created.
**Failure severity:** High.

### UAT-JOB-004 — Availability/leave blocks hire [P0]
**Steps:** Make Guard A explicitly unavailable or put them on approved overlapping leave; attempt hire/auto-shift.
**Expected:** preflight rejects before application becomes accepted and before assignment/shift is committed.
**Failure severity:** Critical for partial or invalid hire.

### UAT-JOB-005 — Cross-company shift clash blocks marketplace guard [P0]
**Steps:** Give marketplace Guard A an active commitment in Company A; Company B attempts an overlapping assignment.
**Expected:** Guard A is unavailable globally for the overlap; Company B cannot double-book them.
**Failure severity:** Critical.

### UAT-JOB-006 — Successful hire is atomic from user perspective [P0]
**Steps:** With valid site/time/compliance/availability, hire accepted application with auto-shift.
**Expected:** application accepted, assignment created, shift created with correct company/site/guard; no partial state.
**Failure severity:** High.

## SHIFT / ATTENDANCE / MOBILE

### UAT-SHF-001 — Guard accepts offered shift [P0]
**Steps:** Guard receives offered shift and accepts it.
**Expected:** lifecycle moves to ready/accepted state; company sees updated state.
**Failure severity:** High.

### UAT-ATT-001 — GPS-disabled Book On [P0]
**Device:** physical Android preferred.
**Steps:** Book On at a site that does not require GPS.
**Expected:** Book On succeeds without forcing a location permission prompt; one check-in event exists; shift becomes in progress.
**Failure severity:** High.

### UAT-ATT-002 — GPS-required Book On inside geofence [P0]
**Device:** physical Android.
**Steps:** With location permission not yet granted, Book On at GPS-required site while inside geofence; approve foreground permission.
**Expected:** first server challenge causes foreground location request; retry includes latitude/longitude/accuracy; server marks GPS verified; one check-in event exists.
**Evidence:** screen recording + attendance record + request/audit ID.
**Failure severity:** Critical if GPS-required site accepts unverified Book On; High if valid in-geofence guard cannot Book On.

### UAT-ATT-003 — GPS-required Book On permission denied [P0]
**Steps:** Deny location permission; try Book On.
**Expected:** Book On fails clearly; shift remains not in progress; no check-in event created.
**Failure severity:** Critical if it succeeds.

### UAT-ATT-004 — Outside geofence rejected [P0]
**Steps:** Attempt GPS-required Book On outside configured radius using a real test location/site configuration.
**Expected:** Book On rejected; distance/verification result does not permit attendance; no in-progress transition.
**Failure severity:** Critical if accepted.

### UAT-ATT-005 — Lost Book On response / retry [P0]
**Steps:** Simulate response loss after server commits Book On, then repeat Book On.
**Expected:** retry returns/recognizes existing successful check-in; no duplicate event; shift remains in progress.
**Failure severity:** High.

### UAT-ATT-006 — Book Off [P0]
**Steps:** Book Off an in-progress shift.
**Expected:** one check-out event; shift becomes completed; check-in-only GPS/NFC requirement does not trap checkout.
**Failure severity:** High.

### UAT-ATT-007 — Lost Book Off response / retry [P0]
**Steps:** Simulate response loss after Book Off commit; repeat Book Off.
**Expected:** retry resolves to already-completed checkout without duplicate event.
**Failure severity:** High.

## LIVE OPERATIONS

### UAT-OPS-001 — Daily patrol/observation log [P0]
**Steps:** During in-progress shift, submit a Daily Log; simulate one failed network attempt before a successful retry.
**Expected:** failed request does not clear typed text; successful request creates one record belonging to correct guard/company/shift and audit trail.
**Failure severity:** High for data loss/wrong ownership.

### UAT-OPS-002 — Welfare check [P0]
**Steps:** During active shift record a welfare check/log.
**Expected:** record is associated with current shift/guard/company; welfare monitoring reference resets appropriately.
**Failure severity:** High.

### UAT-OPS-003 — Missed welfare alert [P0]
**Steps:** Configure short test welfare interval; leave in-progress shift without a new welfare check past interval.
**Expected:** one high-priority missed-welfare alert is raised and company notified; repeated scheduler cycles do not spam duplicates until a new welfare event resets the cycle.
**Failure severity:** High.

### UAT-OPS-004 — Panic alert cannot be downgraded [P0]
**Steps:** Send panic from Guard Mobile/API while active shift; attempt a lower priority in payload.
**Expected:** stored panic priority is CRITICAL; correct company receives alert/notification; audit trail present.
**Failure severity:** Critical.

### UAT-OPS-005 — Incident reporting [P0]
**Steps:** Guard submits incident during active shift; simulate a failed request first, then retry manually.
**Expected:** failed attempt retains entered description; confirmed success creates one incident in correct tenant/site/shift and company can see it.
**Failure severity:** High.

## TIMESHEET / PAYROLL

### UAT-TIM-001 — Completed shift produces usable timesheet [P0]
**Steps:** Complete Book On/Off lifecycle and inspect associated timesheet.
**Expected:** scheduled/actual times are coherent; guard/company ownership correct; no duplicate timesheet.
**Failure severity:** Critical for duplicate/wrong tenant; High for incorrect time data.

### UAT-TIM-002 — Submit/review timesheet [P0]
**Steps:** Guard submits timesheet; Company A approves with expected approved hours.
**Expected:** valid state transitions only; Company B cannot view/review; audit/reviewer fields populated where designed.
**Failure severity:** Critical for tenant breach; High for invalid state.

### UAT-PAY-001 — Payroll batch only uses own approved timesheets [P0]
**Steps:** Company A creates payroll batch using approved own timesheet plus a known Company B timesheet ID.
**Expected:** mixed-tenant request is rejected; no partial batch created. Retry with only Company A IDs succeeds.
**Failure severity:** Critical.

### UAT-PAY-002 — Payroll totals and state transitions [P0]
**Steps:** Calculate expected pay manually from configured rule; create/finalise/pay batch.
**Expected:** hours and amount match manual calculation to agreed rounding; finalised/paid transitions are valid and duplicate payment transition is prevented.
**Failure severity:** Critical for materially wrong money or duplicate payment state.

## INVOICE / FINANCE / CLIENT PORTAL

### UAT-INV-001 — Invoice tenant/client validation [P0]
**Steps:** Company A attempts invoice with Company B timesheet or client ID; then valid Company A set.
**Expected:** cross-tenant set rejected atomically; valid set creates one draft invoice batch.
**Failure severity:** Critical.

### UAT-INV-002 — Invoice totals, VAT and issue [P0]
**Steps:** Manually calculate billable hours, net, VAT and gross from contract rule; finalise and issue invoice.
**Expected:** generated totals match manual result; invoice number/reference and snapshots are stable after finalisation.
**Failure severity:** Critical for material money error.

### UAT-INV-003 — Record partial then full payment [P0]
**Steps:** Record partial payment then remaining payment.
**Expected:** paid/outstanding totals and payment status move unpaid → partially paid → paid; overpayment/invalid state is rejected if prohibited by requirements.
**Failure severity:** High/Critical depending financial impact.

### UAT-CLI-001 — Client portal isolation [P0]
**Steps:** Client Admin A signs in and views dashboard, sites, incidents, service records and invoices; attempt direct ID for another client/company.
**Expected:** only Client A-authorized records are visible; foreign direct IDs rejected.
**Failure severity:** Critical.

## ADMIN / AUDIT / NOTIFICATIONS

### UAT-ADM-001 — Platform admin global read does not impersonate guard [P0]
**Steps:** Admin uses global incident/log/alert views; try guard-only creation/attendance endpoints.
**Expected:** global management reads work; admin cannot accidentally execute guard-only Book On/log creation flows unless explicitly designed.
**Failure severity:** High.

### UAT-AUD-001 — Critical workflow audit trail [P0]
**Steps:** Review audit records for guard approval, hire/assignment, attendance, incident/panic, timesheet review and financial finalisation where auditing is designed.
**Expected:** records identify action/entity/time/principal/company sufficiently for investigation; no password hash or NFC credential appears.
**Failure severity:** High for missing security/financial audit evidence.

### UAT-NOT-001 — Notification principal isolation [P0]
**Steps:** Generate company/guard notification; use Client Portal principal to call platform notification endpoints/direct notification ID.
**Expected:** Client Portal principal is denied; intended platform user can read/mark only owned notification.
**Failure severity:** Critical for cross-principal disclosure.

## RECOVERY / KNOWN LIMITATIONS

### UAT-REC-001 — Connectivity outage operational fallback [P0]
**Steps:** During active shift remove network connectivity and attempt log/incident/welfare submission; restore connectivity and retry manually.
**Expected:** app reports failure clearly and retains entered text; no silent success; after connectivity restore manual retry succeeds. Control-room fallback procedure is exercised.
**Note:** v1.0 does not promise offline-first background sync.
**Failure severity:** High if data is silently lost or falsely shown as submitted.

### UAT-REC-002 — App restart after committed Book On [P0]
**Steps:** Book On successfully, terminate/relaunch app, restore session/dashboard.
**Expected:** server state reload shows shift in progress and existing attendance; app does not require a duplicate Book On.
**Failure severity:** High.

## Completion record

Every P0 case above must have a row in `UAT_EXECUTION_LOG.md`. A verbal statement that a flow 'works' is not release evidence.
