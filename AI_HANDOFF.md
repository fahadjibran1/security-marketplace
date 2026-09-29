# AI_HANDOFF.md

## Project Overview

This is an EXISTING security workforce platform for pilot use with real companies.

Current focus:
- 1 company pilot
- mobile app for guards
- company-side operational workflows
- stable backend/frontend integration
- no architecture redesign

Tech stack in active use:
- Backend: NestJS
- ORM: TypeORM
- Database: PostgreSQL (Supabase)
- Auth: JWT
- Mobile frontend: Expo React Native
- Web/frontend work may also exist in React/Vite depending on module

---

## Core Business Goal

Deliver a pilot-ready app for a real security company with these operational flows:

1. Company creates jobs
2. Guard browses jobs
3. Guard applies
4. Company hires guard
5. Shift is created
6. Guard views shifts
7. Guard checks in / checks out
8. Timesheet is created
9. Incidents and safety alerts are managed
10. Company reviews operations

This is NOT a greenfield product.
This is NOT a redesign exercise.
This is a stabilisation and completion exercise.

---

## Non-Negotiable Rules

1. Do NOT redesign the architecture.
2. Do NOT create a new project.
3. Do NOT regenerate existing modules unless explicitly required.
4. Do NOT invent backend fields or endpoint behavior.
5. Backend is the source of truth.
6. Frontend must only consume tested backend contracts.
7. Keep pilot scope tight and practical.
8. Prefer small focused changes over broad rewrites.
9. Output changed files only.
10. Preserve existing auth, role, and company scoping logic.

---

## Current Roles

System roles currently used:
- ADMIN
- COMPANY_ADMIN
- GUARD

Role expectations:
- COMPANY_ADMIN manages jobs, sites, shifts, operations, timesheets
- GUARD can browse jobs, apply, view own shifts, check in/out, raise incidents or alerts where allowed
- ADMIN role should remain intact but is not the pilot priority

---

## Verified/Expected Backend Modules

Existing modules already implemented or in active use:
- auth
- users
- company
- guard-profile
- jobs
- job-applications
- assignments
- shifts
- attendance
- timesheets
- sites
- safety / incidents / alerts / logs (depending on current backend naming)

Do NOT rename modules casually.

---

## Backend Source of Truth

All frontend work must follow backend truth defined by:
- NestJS controllers/services
- DTOs
- entity fields
- Swagger examples
- tested PowerShell or Swagger smoke tests

If frontend assumptions conflict with backend code, backend contract wins.

---

## Auth Rules

Authentication is JWT-based.

Expected request format for protected endpoints:
- `Authorization: Bearer <TOKEN>`

Important:
- Do NOT break current JWT payload expectations
- Do NOT replace current auth guards unless fixing a specific bug
- Preserve role checks and company scoping
- Guard identity must come from token, not user-entered IDs where self-service flow exists

---

## API Integration Rules

Frontend must never guess:
- endpoint names
- field names
- auth behavior
- enum values
- date formats

For every frontend feature, define:
1. endpoint path
2. HTTP method
3. auth required or not
4. request body shape
5. response shape
6. empty state behavior
7. error shape
8. date/time rendering rules

---

## Key Pilot Features

Priority order for pilot:

1. Login
2. Open Jobs
3. My Applications
4. My Shifts
5. Check-in
6. Check-out
7. Incidents
8. Safety Alerts / Welfare Checks
9. Timesheets
10. Profile / basic account details

Anything outside this should be treated as lower priority unless explicitly requested.

---

## Frontend Structure Rules

Avoid giant all-in-one screens.

Preferred guard mobile structure:
- HomeScreen
- JobsScreen
- ShiftsScreen
- HistoryScreen
- ProfileScreen

Preferred sub-sections:
- JobsScreen
  - Open Jobs
  - My Applications
- ShiftsScreen
  - Upcoming Shifts
  - Active Shift
  - Shift History

Do NOT overload one screen with unrelated workflows.

---

## UI / UX Rules

Frontend should be pilot-ready, not fancy.

Required for each user-facing feature:
- loading state
- empty state
- error state
- success state

Avoid:
- too many popups
- hidden actions
- unclear tabs
- mixing two workflows into one list
- giant components with too much state

Modals:
- prefer one controlled modal state instead of many overlapping modal booleans

Navigation:
- keep stable
- do not keep redesigning tabs
- do not hide core features behind unclear UI

---

## Date and Time Rules

Date/time handling is critical.

Rules:
1. Backend date values must be treated consistently.
2. Frontend must not guess timezone behavior.
3. Overnight shifts must be handled correctly.
4. If end time is logically after midnight, backend must store correct next-day datetime.
5. Frontend must render using a consistent formatter.

If there is a shift date bug:
- first inspect backend stored value
- then inspect API response
- then inspect frontend rendering

Do NOT patch date issues blindly in the UI.

### The time model (locked, Phase 1)

A scheduled shift time is an **INSTANT**, not a wall clock.

- The operator types a date and a clock time. The **site's IANA timezone** converts that to an instant —
  never the operator's device, never the server's clock.
- What is sent, stored, compared and returned is that one instant. Scheduled-time API fields **must**
  carry an explicit offset (`+01:00`, `Z`). An offset-less date-time is rejected with a 400 that says so.
- Display converts the instant back to the site's timezone, so the operator reads what they typed. Never
  render an instant by reading the digits out of the ISO string, and never by forcing `timeZone: 'UTC'`.
- Clock changes come from the IANA database. There is no "subtract an hour" anywhere: it is wrong in
  winter, wrong outside the UK, and wrong on the two transition days.
  - A time that does not exist (clocks forward) is **rejected**, not moved.
  - A time that happens twice (clocks back) takes the **earliest occurrence**, deterministically.
- Attendance timestamps are unchanged by this: the server stamps `occurredAt` when the event arrives.

One implementation on each side, and both are executed in tests:
`security-mobile-app/src/services/siteTime.ts` and `security-backend-nest/src/common/site-time.ts`
(`npm run test:site-time`, `npm run test:scheduled-instant`).

### Open time tech debt

**TECH-DEBT-TIME-01 — scheduled and attendance columns are `timestamp without time zone`.**
The node-postgres driver reads and writes those columns using the *process's* local clock, so the stored
instant is only correct because the API process runs with `TZ=UTC` (set explicitly on the Render service).
`src/config/process-timezone.ts` asserts this at boot and **refuses to start** otherwise, because a wrong
clock corrupts every stored instant silently rather than erroring. The real fix is `timestamptz`, which
does not depend on the process clock at all; that needs a migration with a reviewed backfill and has not
been done. Do not remove the boot assertion while the columns are naive.

**TECH-DEBT-TIME-02 — no operator choice on the fall-back hour.**
On the night the clocks go back, a time like 01:30 occurs twice. The platform always picks the earlier
occurrence (`AMBIGUOUS_POLICY = 'earliest-occurrence'`), which covers the site for longer — the safer
direction for a security rota. Offering the operator the choice needs a form control and an API field.
The resolver already returns `ambiguous: true` so a caller can warn; nothing surfaces it yet.

**Not yet applied: existing rows.** Shift rows written before Phase 1 hold a site-local wall clock in a
column that is now read as an instant, so a pre-existing BST shift reads one hour later than intended
until it is corrected. No backfill has been run and no migration was created.

---

## Company Scoping Rules

Company data must remain scoped correctly.

Important examples:
- company should only see its own sites
- company should only manage its own jobs
- company should only assign/hire guards in valid company context
- guard actions must resolve against authenticated guard identity, not arbitrary IDs

Never weaken company scoping for convenience.

---

## Known Engineering Style

Preferred working style:
- exact file changes
- minimal blast radius
- compile-safe code
- step-by-step smoke tests
- pragmatic fixes
- complete files when useful
- no vague pseudo-code when implementation is requested

Avoid:
- abstract advice without concrete implementation
- overengineering
- unnecessary patterns
- introducing big dependencies without reason

---

## Prompt Rules For AI Tools

### When using Codex
Codex should own backend tasks.

Codex should:
- implement/fix endpoints
- preserve structure
- respect existing auth and role flow
- provide example request/response bodies
- provide smoke test steps

Codex should not:
- redesign architecture
- invent new module layouts
- change frontend assumptions without clearly stating contract changes

### When using Cursor
Cursor should own frontend implementation.

Cursor should:
- build screens against tested API contracts
- keep UI simple
- split large screens into manageable parts
- respect current project structure

Cursor should not:
- invent backend fields
- fake endpoint behavior
- redesign the whole app

### When using Claude Code
Claude should be used mainly for:
- refactoring messy screens
- reducing state conflicts
- cleaning modal logic
- fixing navigation complexity
- date/time reasoning
- debugging cross-file behavior

Claude should not:
- perform broad rewrites just because it can
- change stable API contracts during frontend cleanup

---

## Branch Ownership Rules

Recommended branch ownership:
- `backend/*` -> Codex only
- `frontend/*` -> Cursor only
- `refactor/*` -> Claude only
- `hotfix/*` -> one tool only, never multiple in parallel

Do NOT allow multiple AI tools to edit the same branch at the same time.

---

## Feature Delivery Workflow

For every feature, use this order:

1. Backend contract finalised
2. Backend tested in Swagger or PowerShell
3. Frontend implemented against exact contract
4. Manual test run end-to-end
5. Refactor only if needed after working flow exists

Never build frontend first and hope backend matches later.

---

## Smoke Test Discipline

Every completed backend feature should have:
- a test endpoint
- example request body
- example response body
- auth requirement
- expected error behavior

Every completed frontend feature should be manually checked for:
- visible loading state
- empty state
- error display
- correct data binding
- correct auth behavior
- correct navigation flow

---

## Current Feature Expectations

### Jobs
Guard should be able to:
- view open jobs
- apply to jobs
- view own applications

Company should be able to:
- create jobs
- view applicants
- hire guards

### Shifts
Guard should be able to:
- view own shifts
- see correct dates/times
- check in
- check out

### Timesheets
System should:
- generate/update timesheet from attendance flow
- allow company-side review/approval if implemented

### Incidents / Safety
Guard/company flows should remain practical and operational, not overbuilt.

---

## Do Not Change Without Strong Reason

- auth flow
- JWT token expectations
- role names
- company scoping logic
- tested endpoint paths
- existing project/module structure
- pilot tab structure unless clearly broken

---

## Current Product Mindset

This project should feel:
- usable
- stable
- operational
- simple

It does NOT need to feel:
- feature-rich
- over-designed
- enterprise-perfect
- heavily abstracted

Shipping a stable pilot matters more than impressing with architecture.

---

## If an AI Is Unsure

If any AI tool is unsure:
1. inspect the existing file first
2. preserve current patterns
3. ask for or use existing contract examples
4. prefer minimal changes
5. do not invent behavior

When in doubt:
- trust tested backend behavior
- keep frontend simple
- avoid broad rewrites

---

## Current Immediate Priorities

Immediate practical priorities:
1. stable guard navigation
2. proper Jobs screen with Open Jobs + My Applications
3. correct shift date/time rendering
4. reliable check-in/check-out flow
5. incidents / safety visibility
6. timesheet visibility

Everything else is secondary until these are stable.

---

## Definition of Done

A feature is only done when:
- backend works
- frontend works
- auth works
- data is correct
- loading/empty/error states exist
- manual smoke test passes
- no fake or guessed data is being used

---

## Final Reminder

This project is already partly working.
The job is to complete and stabilise it.
Do not restart it.
Do not redesign it.
Do not let AI tools freelance outside their role.