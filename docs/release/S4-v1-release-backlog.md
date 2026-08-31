# S4 v1.0.0 Release Backlog

Status: Active release baseline
Branch: `s4-release-stabilization`
Objective: first commercial pilot release

## Release principles

- P0 = must be fixed or proven before pilot production.
- P1 = valuable hardening that may follow RC1 if it does not create material pilot risk.
- v1.1 = intentionally deferred to prevent feature creep.
- A feature is not release-ready because code exists; it must be integrated, tenant-safe, tested and accepted.

## Completed P0 hardening

- Production-safe database configuration and environment validation.
- TypeORM production synchronization disabled and migration-only schema changes enforced.
- Clean PostgreSQL bootstrap, idempotent migrations and semantic schema-drift CI gate.
- Health liveness/readiness separation and structured request/startup logging.
- Public registration privilege escalation blocked.
- Guard registration changed to pending approval.
- Password hashes excluded from normal queries for platform and client portal users.
- Cross-tenant guard directory and company-guard writes fixed.
- Incident, daily-log and safety-alert admin/tenant route contracts corrected.
- Attachment target ownership derived from referenced operational records.
- Client-portal principals excluded from platform notification endpoints.
- Job slots tenant-scoped.
- Guard scheduling clashes made global across marketplace companies.
- Availability rules/overrides tenant ownership corrected.
- Explicit unavailability, leave and compliance now block shift eligibility.
- Job hire preflight moved before accepted state and optional shift creation.
- Company leave writes require a company-guard relationship; guard self-service leave is always pending.
- Global financial scheduler execution restricted to platform admins.
- Site attendance GPS geofence and NFC verification added as configurable server-side controls.
- NFC credentials hidden from API responses and stored as one-way fingerprints.
- Attendance Book On / Book Off retries made response-loss safe by returning the already-committed event when lifecycle state proves the same action completed.
- `requireGpsCheckIn` and `requireNfcCheckIn` no longer block Book Off; checkout can still record evidence when supplied.
- Panic alerts forced to CRITICAL priority.
- Missed-welfare monitoring added for in-progress shifts using site welfare interval and last welfare/check-in reference.
- Guard Mobile release gate added with TypeScript build and Expo compatibility validation.
- Expo SDK 54 dependencies reconciled and `expo-location` declared for foreground attendance verification.
- Native foreground location permission configuration added for Guard Mobile.

## Active P0 audit areas

- Complete Guard Mobile foreground GPS source wiring and certify it through the mobile release gate.
- End-to-end Book On test with a GPS-required site on a real/native build.
- Welfare/check-call end-to-end mobile workflow and recovery behavior.
- Offline/retry/idempotency behavior for incidents, daily logs, safety alerts and panic actions.
- Remaining tenant-isolation review across all API surfaces.
- Runtime dependency vulnerability remediation and exploitability assessment.
- Expanded behavioral/integration tests for tenant boundaries and finance state transitions.
- Pilot UAT on a clean deployment.

## P1 backlog

- Durable offline mutation queue for guard operational records if pilot connectivity proves unreliable.
- Generic idempotency keys for incident/daily-log/alert mutations beyond attendance-specific retry protection.
- Database-level concurrent duplicate protection for attendance events after pilot behavior is proven, without blocking an authorised future shift-reopen workflow.
- Coverage calculation reconciliation between Job, JobSlot, Assignment and Shift semantics.
- Constraint/index naming cleanup where TypeORM-generated names differ from migration names without semantic drift.
- Company staff membership model and reliable tenant resolution for `COMPANY_STAFF`.
- Scheduler distributed locking before running more than one scheduler-active backend instance.
- Pagination and query-performance review for high-volume list endpoints.
- Broader automated test suite beyond release smoke coverage.

## v1.1 scope

The following are deliberately deferred unless a signed pilot requirement makes one mandatory:

- Dedicated QR patrol routes/checkpoint engine.
- Multi-checkpoint NFC patrol engine.
- Patrol image / incident image upload and managed evidence storage. The current Attachment module registers metadata for an existing URL; it is not a secure upload/storage implementation.
- Dedicated Visitor Book module.
- Dedicated Vehicle Book module.
- Dedicated Occurrence Book module beyond the current Daily Log operational record.
- Advanced/AI smart matching and predictive staffing.
- Horizontal scheduler/worker scaling architecture.

## Pilot operational scope

The v1 pilot operational baseline is:

- Guard registration and approval.
- Company guard pool and marketplace hiring.
- Job/assignment/shift lifecycle.
- Availability, leave and compliance eligibility.
- GPS verified Book On where enabled per site.
- Optional server-side NFC Book On verification only where the client interaction is explicitly available and tested; otherwise leave the site NFC requirement disabled.
- Book Off and attendance evidence.
- Incident reports without managed image upload.
- Daily logs including welfare-check records.
- Missed-welfare alerts.
- Panic/safety alerts.
- Timesheets, payroll batches, invoicing and finance reporting.
- Client/company/platform administration appropriate to the existing tenant model.

## Offline / retry policy for pilot

- Attendance retries are server-idempotent for the common lost-response scenario.
- Operational forms retain their entered content on a failed request and only clear after confirmed success.
- The v1 pilot does not claim offline-first operation or durable background sync.
- Pilot deployment therefore requires usable mobile data/Wi-Fi coverage and a documented control-room fallback for connectivity outages.
- Full durable offline queuing is P1 unless pilot UAT demonstrates that connectivity makes it a release blocker.

## Current release gate

A release candidate must pass:

1. Backend compile.
2. Release security smoke suite.
3. Empty PostgreSQL migration bootstrap.
4. Second migration run with no pending migration side effects.
5. Migration-state verification.
6. Entity-to-migration schema diagnostics.
7. Semantic schema-drift gate.
8. Guard Mobile TypeScript build.
9. Expo SDK dependency compatibility check.
10. No open Critical/High release defects after risk review.
11. Pilot UAT and deployment/rollback validation.

## Deployment constraint for pilot

Run one scheduler-active application instance until distributed job locking or a dedicated worker scheduler is implemented.
