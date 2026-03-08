# Security Backend (NestJS + PostgreSQL)

Standalone backend-first MVP for the security companies/guards platform.

## Stack
- NestJS
- TypeORM
- PostgreSQL
- JWT authentication + role-based authorization

## Included modules
- Auth
- CompanyProfile
- GuardProfile
- Job
- JobApplication
- Assignment
- Shift
- Timesheet

## Domain guarantees
- `Job` is a requirement with `guardsRequired`.
- A `Job` can have multiple hired guards.
- Hiring a `JobApplication` creates an `Assignment`.
- `Shift` is separate from `Job` and linked to `Assignment`.
- `Timesheet` is separate from `Shift` and auto-created for each new shift.

## Setup
```bash
cd security-backend
cp .env.example .env
npm install
npm run build
npm run start:dev
```

## Production start
```bash
npm run build
npm run start:prod
```

## MVP flow
1. Register and login (`/auth/register`, `/auth/login`)
2. Company creates job (`POST /jobs`)
3. Guard applies (`POST /job-applications`)
4. Company hires application (`POST /job-applications/:id/hire`) => Assignment
5. Company creates shift (`POST /shifts`) => Timesheet auto-created
