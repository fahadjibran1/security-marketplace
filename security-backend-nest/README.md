# Security MVP Backend (NestJS + PostgreSQL)

This is a backend-first MVP for the security companies/guards platform.

## Stack
- NestJS
- TypeORM
- PostgreSQL
- JWT authentication with role-based authorization

## Implemented modules
- Auth (JWT + roles)
- Company profile
- Guard profile
- Job
- JobApplication
- Assignment
- Shift
- Timesheet

## Domain rules implemented
- `Job` is a company requirement and has `guardsRequired`.
- Hiring does **not** complete a Job.
- Hiring a guard from a `JobApplication` creates an `Assignment`.
- `Shift` is separate from `Job` and belongs to an `Assignment`.
- `Timesheet` is separate from `Shift` and is auto-created when a shift is created.

## Project structure
```
security-backend-nest/
  src/
    auth/
    company/
    guard-profile/
    job/
    job-application/
    assignment/
    shift/
    timesheet/
    user/
    common/
```

## Setup
1. Copy env:
   ```bash
   cp .env.example .env
   ```
2. Ensure PostgreSQL is running and database exists.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build:
   ```bash
   npm run build
   ```
5. Start:
   ```bash
   npm run start:dev
   ```

## Key API flow (MVP)
1. Register/login as company + guard (`/auth/register`, `/auth/login`).
2. Company creates job (`POST /jobs`) with `guardsRequired`.
3. Guard applies (`POST /job-applications`).
4. Company hires application (`POST /job-applications/:id/hire`) => Assignment created.
5. Company creates shift (`POST /shifts`) => Timesheet auto-created.

## Notes
- `synchronize: true` is enabled for MVP development.
- For production, replace with proper migrations.
