# Security Mobile App (Expo + Node Backend)

A cross-platform mobile app starter for **Android + iOS** with two role dashboards, plus a runnable backend API implementing core domain modules.

## Correct domain model (backend)
- **Job**: company requirement (`/jobs`) with `guardsRequired`
- **JobApplication**: guard applying for a job (`/job-applications`)
- **Assignment**: hiring result per guard (`/assignments`)
- **Shift**: schedule linked to assignment (`/shifts`)
- **Timesheet**: payroll record linked to shift (`/timesheets`)

## MVP flow
1. Company posts job
2. Guard applies to job
3. Company hires application (creates assignment)
4. Company creates shift for assignment (creates timesheet automatically)

## Key endpoints
- Auth: `POST /auth/register`, `POST /auth/login`
- Companies: `GET/POST /companies`
- Guards: `GET/POST /guards`
- Jobs: `GET/POST /jobs`
- Job applications: `GET/POST /job-applications`
- Hire application: `POST /job-applications/:id/hire`
- Assignments: `GET /assignments`
- Shifts: `GET/POST /shifts`
- Timesheets: `GET /timesheets`
- Attendance: `GET /attendance`, `POST /attendance/check-in`, `POST /attendance/check-out`

## Local run commands
### 1) Install dependencies (mobile toolchain)
```bash
cd security-mobile-app
npm install
```

If your environment injects broken proxy variables, run:
```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u npm_config_http_proxy -u npm_config_https_proxy npm install
```

### 2) Build checks
```bash
npm run build
```

### 3) Start backend API
```bash
npm run start
```

### 4) Start mobile app (Expo)
```bash
npm run start:mobile
```

## Smoke test the domain flow
```bash
# 1) Company posts job
curl -X POST http://localhost:4000/jobs -H "Content-Type: application/json" -d '{"companyId":1,"title":"Warehouse Guard","guardsRequired":2,"hourlyRate":16.5,"status":"open"}'

# 2) Guard applies
curl -X POST http://localhost:4000/job-applications -H "Content-Type: application/json" -d '{"jobId":1,"guardId":1}'

# 3) Company hires the application (creates assignment + optional shift/timesheet)
curl -X POST http://localhost:4000/job-applications/1/hire -H "Content-Type: application/json" -d '{"createShift":true,"siteName":"Warehouse A","start":"2026-03-08T21:00:00Z","end":"2026-03-09T05:00:00Z"}'

# 4) Verify outputs
curl http://localhost:4000/assignments
curl http://localhost:4000/shifts
curl http://localhost:4000/timesheets
```
