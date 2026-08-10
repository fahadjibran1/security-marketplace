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
- Panic alerts forced to CRITICAL priority.
- Missed-welfare monitoring added for in-progress shifts using site welfare interval and last welfare/check-in reference.

## Active P0 audit areas

- Guard mobile client compatibility with GPS/NFC attendance payloads.
- Welfare/check-call end-to-end mobile workflow and recovery behavior.
- Patrol evidence / image upload end-to-end verification.
- Offline/retry/idempotency behavior for guard operational actions.
- Remaining tenant-isolation review across all API surfaces.
- Runtime dependency vulnerability remediation and exploitability assessment.
- Expanded behavioral/integration tests for tenant boundaries and finance state transitions.
- Pilot UAT on a clean deployment.

## P1 backlog

- Coverage calculation reconciliation between Job, JobSlot, Assignment and Shift semantics.
- Constraint/index naming cleanup where TypeORM-generated names differ from migration names without semantic drift.
- Company staff membership model and reliable tenant resolution for `COMPANY_STAFF`.
- Scheduler distributed locking before running more than one scheduler-active backend instance.
- Pagination and query-performance review for high-volume list endpoints.
- Broader automated test suite beyond release smoke coverage.

## v1.1 scope

The following are not registered production backend modules in the current v1 release line and are deliberately deferred unless a signed pilot requirement makes one mandatory:

- Dedicated QR patrol routes/checkpoint engine.
- Multi-checkpoint NFC patrol engine.
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
- GPS/NFC verified Book On where enabled per site.
- Book Off and attendance evidence.
- Incidents and attachments.
- Daily logs including welfare-check records.
- Missed-welfare alerts.
- Panic/safety alerts.
- Timesheets, payroll batches, invoicing and finance reporting.
- Client/company/platform administration appropriate to existing tenant model.

## Current release gate

A release candidate must pass:

1. Backend compile.
2. Release security smoke suite.
3. Empty PostgreSQL migration bootstrap.
4. Second migration run with no pending migration side effects.
5. Migration-state verification.
6. Entity-to-migration schema diagnostics.
7. Semantic schema-drift gate.
8. No open Critical/High release defects after risk review.
9. Pilot UAT and deployment/rollback validation.

## Deployment constraint for pilot

Run one scheduler-active application instance until distributed job locking or a dedicated worker scheduler is implemented.
