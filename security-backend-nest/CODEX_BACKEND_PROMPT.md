We are continuing development of an EXISTING NestJS security workforce platform backend.

IMPORTANT CONTEXT:
This is NOT a greenfield project.
Do NOT redesign architecture.
Do NOT create a new project.
Do NOT regenerate modules unless strictly required for this task.
Do NOT rename modules, entities, DTOs, or routes unless fixing a specific bug.

STACK:
- NestJS
- TypeORM
- PostgreSQL (Supabase)
- JWT auth
- Existing modules already implemented

EXISTING MODULES IN USE:
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
- safety / incidents / alerts / logs (depending on current naming)

CURRENT PRODUCT GOAL:
We are stabilising and completing a pilot-ready security workforce platform for real company use.
The priority is working operational flows, not architecture changes.

NON-NEGOTIABLE RULES:
- Preserve existing auth flow
- Preserve existing role behavior
- Preserve company scoping
- Backend is source of truth
- Make minimal, targeted changes only
- Keep compile-safe TypeScript
- Output changed files only
- If a file changes, provide the COMPLETE final file content
- Do not output pseudocode
- Do not suggest broad rewrites

WORKING FLOWS WE WANT TO PRESERVE:
- company registration/login
- guard registration/login/approval
- company creates sites
- company creates jobs
- guards browse jobs
- guards apply to jobs
- company hires guard
- shift can be created
- guard can view own shifts
- check-in/check-out flow
- timesheet generation/update
- incident / safety operational flow where already implemented

TASK:
[PASTE YOUR BACKEND TASK HERE]

REQUIRED APPROACH:
1. Inspect current structure and preserve it
2. Change only the files necessary
3. Keep DTO/entity/controller/service alignment correct
4. Respect JWT identity and role guards
5. Respect company scoping and self-service guard identity
6. Handle empty/error cases cleanly
7. Keep endpoint behavior explicit and stable

REQUIRED OUTPUT:
1. Short summary of root cause / required change
2. List of changed files
3. COMPLETE final contents of each changed file only
4. Example request JSON if relevant
5. Example response JSON
6. Swagger or PowerShell smoke tests
7. Any migration/data note only if strictly required

SUCCESS CRITERIA:
- 0 TypeScript errors
- no broken imports
- existing flows preserved
- endpoint works as requested
- response shape is stable for frontend integration
- auth and company scoping remain correct

If you need to choose between “clever” and “safe”, choose safe.