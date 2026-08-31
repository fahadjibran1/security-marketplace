# Security Platform Implementation Blueprint

## Purpose

This document turns the target security-operations model into a concrete implementation plan for the current codebase.

It is intentionally grounded in the repo as it exists today:

- Backend: [security-backend-nest](C:/Users/Admin/security-marketplace/security-backend-nest)
- Mobile/web app: [security-mobile-app](C:/Users/Admin/security-marketplace/security-mobile-app)
- Current deployment:
  - API: `https://api.observantsecurity.co.uk`
  - Browser dashboard: `https://dashboard.observantsecurity.co.uk`
  - App download page: `https://download.observantsecurity.co.uk`

## Current Reality

The current backend already supports a usable MVP, but the model is still too shallow for the target platform design.

### Current strengths

- Working auth, role guard, company and guard onboarding
- Site entity already exists
- Jobs, job applications, assignments, shifts, timesheets, attendance, incidents already exist
- Browser company dashboard and mobile app are live

### Current structural gaps

- IDs are numeric, not UUID
- Roles are only `ADMIN`, `COMPANY`, `GUARD`
- `COMPANY_STAFF` does not exist
- `User` does not hold profile/status/audit fields yet
- `Shift` is linked to `Assignment` first, instead of being the operational root
- `Assignment` is acting as both hire record and assignment state
- Check-in/out uses `AttendanceEvent` but not a richer `CheckEvent` model
- Timesheets are minimal and not fully shift-accounting based
- Alerts/check calls, daily logs, attachments, notifications, and audit logs do not exist yet
- Status enums are mostly raw strings rather than consistent workflow enums

## Current Entity Snapshot

### User

Current file: [user.entity.ts](C:/Users/Admin/security-marketplace/security-backend-nest/src/user/entities/user.entity.ts)

- `id: number`
- `email`
- `passwordHash`
- `role: admin | company | guard`
- linked one-to-one to `Company` or `GuardProfile`

### Company

Current file: [company.entity.ts](C:/Users/Admin/security-marketplace/security-backend-nest/src/company/entities/company.entity.ts)

- `id: number`
- linked to `user`
- `name`
- `companyNumber`
- `address`
- `contactDetails`

### GuardProfile

Current file: [guard-profile.entity.ts](C:/Users/Admin/security-marketplace/security-backend-nest/src/guard-profile/entities/guard-profile.entity.ts)

- `id: number`
- linked to `user`
- `fullName`
- `siaLicenseNumber`
- `phone`
- `locationSharingEnabled`
- `status`

### Site

Current file: [site.entity.ts](C:/Users/Admin/security-marketplace/security-backend-nest/src/site/entities/site.entity.ts)

- `id: number`
- `company`
- `name`
- `clientName`
- `address`
- `contactDetails`
- `status`
- `welfareCheckIntervalMinutes`

### Job

Current file: [job.entity.ts](C:/Users/Admin/security-marketplace/security-backend-nest/src/job/entities/job.entity.ts)

- `id: number`
- `company`
- optional `site`
- `title`
- `description`
- `guardsRequired`
- `hourlyRate`
- `status`
- `sourceType`
- `startAt`
- `endAt`

### JobApplication

Current file: [job-application.entity.ts](C:/Users/Admin/security-marketplace/security-backend-nest/src/job-application/entities/job-application.entity.ts)

- `id: number`
- `job`
- `guard`
- `status`
- `appliedAt`
- `hiredAt`

### Assignment

Current file: [assignment.entity.ts](C:/Users/Admin/security-marketplace/security-backend-nest/src/assignment/entities/assignment.entity.ts)

- `id: number`
- optional `job`
- `company`
- `guard`
- optional `application`
- `status`
- `hiredAt`

### Shift

Current file: [shift.entity.ts](C:/Users/Admin/security-marketplace/security-backend-nest/src/shift/entities/shift.entity.ts)

- `id: number`
- `assignment`
- `company`
- `guard`
- optional `site`
- `siteName`
- `start`
- `end`
- `status`

### Timesheet

Current file: [timesheet.entity.ts](C:/Users/Admin/security-marketplace/security-backend-nest/src/timesheet/entities/timesheet.entity.ts)

- `id: number`
- `shift`
- `guard`
- `company`
- `hoursWorked`
- `approvalStatus`
- `submittedAt`

### AttendanceEvent

Current file: [attendance.entity.ts](C:/Users/Admin/security-marketplace/security-backend-nest/src/attendance/entities/attendance.entity.ts)

- `id: number`
- `shift`
- `guard`
- `type`
- `nfcTag`
- `notes`
- `occurredAt`

### Incident

Current file: [incident.entity.ts](C:/Users/Admin/security-marketplace/security-backend-nest/src/incident/entities/incident.entity.ts)

- `id: number`
- `company`
- `guard`
- optional `shift`
- `title`
- `notes`
- `severity`
- `locationText`
- `status`

## Target Architecture

The target operating model is correct and should become the platform standard:

```text
Company
  -> Users
  -> Sites
  -> Jobs
    -> Applications
      -> Hires
        -> Shifts
          -> Assignments
          -> Check In / Check Out
          -> Timesheets
          -> Incidents
          -> Alerts / Check Calls
          -> Daily Logs
```

### Target principles

- Every operational record is company-scoped
- `Shift` is the operational core
- Recruitment and live operations are separate concerns
- Workflow is status-driven
- Role checks are explicit, not implied
- Auditability is first-class

## Recommended Canonical Modules

### 1. Roles and auth

- `ADMIN`
- `COMPANY_ADMIN`
- `COMPANY_STAFF`
- `GUARD`

This replaces the current simplified `admin | company | guard`.

### 2. Users

User should become the platform identity entity:

- `id: uuid`
- `companyId: uuid | null`
- `firstName`
- `lastName`
- `email`
- `phone`
- `passwordHash`
- `role`
- `status`
- `isEmailVerified`
- `lastLoginAt`
- timestamps

### 3. Companies

Company should become richer and onboarding-aware:

- contact details
- legal/registration details
- address fields
- status: `ONBOARDING | ACTIVE | INACTIVE | SUSPENDED`

### 4. Sites

Site should be the operational anchor for:

- jobs
- shifts
- incidents
- alerts/check calls
- daily logs
- invoicing later

### 5. Guards

GuardProfile should stay separate from User, but become richer:

- SIA lifecycle
- approval state
- company linkage
- emergency contacts
- availability
- notes

### 6. Jobs and applications

Jobs are for staffing/recruitment only.

- jobs create demand
- applications represent candidates
- `HIRED` can remain an application state in MVP
- separate `Hire` entity can be deferred

### 7. Shifts and assignments

This is the biggest model correction:

- `Shift` should be the operational parent
- `Assignment` should represent the guard’s assignment/acceptance/live attendance state

Current code has this relationship reversed in practice.

### 8. Check events

Current `AttendanceEvent` can evolve into `CheckEvent`:

- `CHECK_IN`
- `CHECK_OUT`
- location
- method: `MANUAL | GPS | QR | NFC`
- notes

### 9. Timesheets

Timesheets should be explicitly shift-based:

- scheduled start/end
- actual check-in/out
- worked minutes
- break minutes
- rounded minutes
- status: `PENDING | SUBMITTED | APPROVED | REJECTED`

### 10. Safety alerts and check calls

New module required.

This should own:

- hourly welfare check calls
- missed check calls
- panic
- late check-in alerts
- acknowledgement and closure

### 11. Incidents

Current incident model is a good start, but needs:

- `siteId`
- category
- richer status lifecycle
- review/close metadata

### 12. Daily logs

New module required.

Routine activity during a shift:

- patrol
- observation
- visitor
- delivery
- maintenance
- other

### 13. Attachments

New module required.

Used for:

- incident evidence
- shift proof
- timesheet support
- safety alert evidence

### 14. Notifications

New module required later.

Do not block pilot on this.

### 15. Audit logs

New module required and should become mandatory before scale.

Especially important for:

- assignment changes
- timesheet approvals/rejections
- incident status changes
- role/status changes

## Migration Strategy

Do not try to rewrite the whole platform in one pass. Use a staged migration.

### Phase 1. Stabilize roles and naming

Goal:

- introduce the correct role model
- preserve existing MVP behavior

Actions:

- expand `UserRole` enum
- add user/company/guard statuses
- update JWT payload and guards
- add role-specific decorators and guards for new company/admin split

This can be done before UUID conversion.

### Phase 2. Make shift the operational root

Goal:

- move from assignment-centric modeling to shift-centric operations

Actions:

- add proper `createdByUserId`, `jobId`, `jobApplicationId`, `siteId`, `guardUserId` to `Shift`
- evolve `Assignment` into guard acceptance/live attendance state instead of “hire”
- keep compatibility adapters while old mobile/web code still exists

This is the most important structural backend refactor.

### Phase 3. Expand operational modules

Goal:

- support real site operations

Add:

- `CheckEvent`
- `SafetyAlert`
- `DailyLog`
- richer `Timesheet`
- richer `Incident`

### Phase 4. Governance and files

Add:

- `Attachment`
- `Notification`
- `AuditLog`

### Phase 5. UUID migration

Goal:

- move core entities to UUID safely

Recommendation:

- do **not** convert existing production tables in-place early in the pilot
- instead, complete role and workflow refactors first
- then plan a dedicated UUID migration or a v2 schema with data migration scripts

For the pilot, numeric IDs are acceptable if relationships and status rules are stabilized.

## Recommended Backend Route Map

### Auth

- `/auth/login`
- `/auth/register-company`
- `/auth/register-guard`

### Companies

- `/companies/me/profile`
- `/companies/admin/pending`

### Sites

- `/sites`
- `/sites/:id`

### Jobs

- `/jobs`
- `/jobs/:id/apply`
- `/jobs/:id/applicants`
- `/jobs/me/applications`

### Shifts

- `/shifts/company/shifts`
- `/shifts/company/shifts/:shiftId/assign`
- `/shifts/company/applications/:id/create-shift`
- `/shifts/me/assignments`
- `/shifts/assignments/:id/check-in`
- `/shifts/assignments/:id/check-out`

### Timesheets

- `/shifts/me/timesheets`
- `/shifts/company/timesheets`
- `/shifts/company/timesheets/:id/decision`

### Safety

- `/safety/alerts`
- `/safety/me/alerts`
- `/safety/company/alerts`
- `/safety/company/alerts/:id/ack`
- `/safety/company/alerts/:id/close`
- `/safety/incidents`
- `/safety/me/incidents`
- `/safety/company/incidents`
- `/safety/company/incidents/:id/status`
- `/safety/logs`
- `/safety/me/logs`
- `/safety/company/logs`

### Admin

- `/admin/guards/pending`
- `/admin/guards/:id/approve`
- `/admin/guards/:id/reject`

## Recommended Frontend Page Map

### Company web/mobile

- Dashboard
- Sites
- Jobs
- Recruitment pipeline
- Shifts
- Timesheets
- Incidents
- Alerts
- Invoices

### Guard mobile

- My Assignments
- My Timesheets
- My Incidents
- My Alerts
- Jobs marketplace
- Profile

### Admin

- Pending guards
- Company approvals
- Platform overview

## Recommended MVP Trial Scope

Keep the first company trial narrow.

### Company

- Dashboard
- Jobs
- Shifts
- Timesheets
- Incidents
- Alerts

### Guard

- My Assignments
- My Timesheets
- My Incidents / Alerts

### Admin

- Pending Guards
- Company approvals

This is enough for a serious operational pilot.

## Critical Business Rules

### Company scoping

Every operational record must have `companyId`.

### Shift-centric operations

Attach these to `shiftId` whenever possible:

- check-in/out
- timesheets
- incidents
- alerts
- daily logs

### Role checks

- only `COMPANY_ADMIN` can create jobs
- only `COMPANY_ADMIN` can approve timesheets
- only `ADMIN` can approve guards
- only assigned guards can check in/check out

### Status-driven workflow

Never bypass transitions casually.

Recommended flows:

- Application: `APPLIED -> SHORTLISTED -> HIRED`
- Shift: `SCHEDULED -> ASSIGNED -> IN_PROGRESS -> COMPLETED`
- Timesheet: `PENDING -> SUBMITTED -> APPROVED`
- Alert: `OPEN -> ACKNOWLEDGED -> CLOSED`
- Incident: `OPEN -> IN_REVIEW -> CLOSED`

## Concrete Next Implementation Order

### Step 1. Roles and statuses

Implement first:

- richer `UserRole`
- user/company/guard status enums
- auth payload updates
- route guards

### Step 2. Shift/assignment redesign

Implement next:

- make `Shift` own the operational data
- make `Assignment` the guard-state record

### Step 3. Alerts and daily logs

Add:

- `SafetyAlert`
- `DailyLog`

These are core to real guarding operations.

### Step 4. Rich timesheets and incidents

Upgrade:

- shift-based worked minutes
- approval metadata
- richer incident categories and lifecycle

### Step 5. Audit and files

Add:

- `Attachment`
- `AuditLog`

## Pilot-Safe Rule

Do not redesign the live UI and the live backend model at the same time.

For the current trial:

- keep the live pilot working
- fix bugs and missing fields only
- collect operational feedback

Then use this blueprint to drive the next structured backend/frontend refactor.

