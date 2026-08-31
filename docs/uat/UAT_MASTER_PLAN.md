# S4 v1.0.0 Pilot UAT Master Plan

Status: Release Candidate gate
Owner: S4 Release Management
Target: First commercial pilot

## Purpose

This plan defines the acceptance evidence required before S4 v1.0.0 may be deployed to a pilot customer. A feature is not accepted because its code exists or because an isolated API call succeeds. P0 user journeys must complete end-to-end with the correct tenant, role, state transitions, audit records and financial consequences.

## Entry criteria

UAT execution may begin when:

- Backend release gate is green.
- Guard Mobile release gate is green.
- Release migrations create a clean PostgreSQL database successfully.
- Production-like environment variables are configured without development fallbacks.
- Test company, client, site and guard data can be created without direct database editing.
- No known Critical defect is open.

## Exit criteria

Pilot UAT passes only when:

- 100% of P0 test cases pass.
- No Critical or High defect remains open.
- Failed Medium cases have a documented workaround and release-owner acceptance.
- Tenant-isolation negative tests pass.
- GPS Book On is demonstrated on a physical Android device for a GPS-required site.
- Backup and restore drill has passed independently of UAT.
- Deployment and rollback runbooks have been exercised.
- Pilot limitations are disclosed and accepted.

## Pilot scope under test

### In scope

- Company registration and authentication.
- Guard registration, approval and compliance eligibility.
- Company guard pool.
- Clients and sites.
- Job creation and marketplace application.
- Matching/eligibility and hire.
- Shift offer/acceptance and lifecycle.
- GPS-verified Book On where enabled.
- Book Off and attendance evidence.
- Daily logs, welfare records and missed-welfare alerting.
- Panic/safety alerting.
- Incident reporting.
- Timesheet lifecycle.
- Payroll batch lifecycle.
- Invoice lifecycle and payment recording.
- Client portal visibility.
- Notifications and audit trail.
- Tenant isolation and role restrictions.

### Explicitly out of v1.0 pilot scope

- Dedicated QR patrol checkpoint engine.
- Multi-checkpoint NFC patrol engine.
- Managed camera/file evidence upload and storage.
- Visitor Book module.
- Vehicle Book module.
- Dedicated Occurrence Book beyond Daily Logs.
- Durable offline-first mutation queue/background synchronisation.
- Multi-instance scheduler execution.
- Advanced/AI predictive staffing.

## Test roles

- Platform Admin
- Company Admin A
- Company Admin B
- Guard A (Company A pool / marketplace)
- Guard B (Company B or independent marketplace)
- Client Admin A
- Client Viewer A

## Required test data

Create two independent security-company tenants to prove isolation.

### Company A

- One active client.
- One active site with GPS disabled.
- One active site with GPS required and known coordinates/geofence.
- One approved guard in the company pool.
- One marketplace guard not initially in the pool.
- Active pay rule and contract pricing rule.

### Company B

- One client, site and guard records solely for negative isolation tests.

## Severity model

| Severity | Definition | Release action |
|---|---|---|
| Critical | Cross-tenant disclosure/modification, authentication bypass, unrecoverable data loss, materially incorrect payroll/invoice totals, production outage | Immediate NO-GO |
| High | Core P0 workflow cannot complete, GPS/security control bypass, major incorrect state transition with no safe workaround | NO-GO until fixed |
| Medium | Important workflow defect with safe documented workaround and no security/data-integrity impact | Release-owner decision |
| Low | Cosmetic/usability issue without operational impact | May defer |

## Evidence standard

For every executed P0 case record:

- Test-case ID.
- Environment and build/commit SHA.
- Test user/tenant.
- Execution date/time.
- Actual result.
- PASS/FAIL.
- Screenshot or screen recording where UI/device behaviour is material.
- Relevant API/request ID or audit-log ID where available.
- Defect ID for failures.

Do not use production customer personal data for UAT.

## Release decision

UAT completion does not itself authorize production. UAT evidence feeds the Executive Release Board together with security, performance, infrastructure, backup/restore and operational-readiness evidence.
