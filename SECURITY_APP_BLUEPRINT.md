# Security Companies & Guards Mobile App Blueprint

## 1) Product Overview
A cross-platform mobile app (Android + iOS) with two role-specific experiences:
- **Company Dashboard** for security companies.
- **Guard Dashboard** for security guards.

A shared backend powers authentication, compliance workflows, scheduling, patrol verification, invoicing, incident reporting, messaging, and safety tools.

---

## 2) Core Roles
- **Security Company Admin**
  - Creates company profile.
  - Publishes jobs and hires guards.
  - Assigns guards to projects/sites and shifts.
  - Tracks hours and approves timesheets.
  - Invoices clients.
  - Reviews guard profiles and compliance status.

- **Security Guard**
  - Creates profile and onboarding details.
  - Submits SIA details for verification.
  - Accepts jobs and shifts.
  - Performs patrol check-ins via NFC.
  - Files incident reports and daily logs.
  - Uses messaging, safety check calls, and panic button.

---

## 3) Functional Requirements

### Company-side features
1. Company profile fields:
   - Company name
   - Company registration number
   - Address
   - Contact details
2. Job advertising and application handling.
3. Employ guards on projects/sites.
4. Track worked hours and manage approvals.
5. Generate and send client invoices.
6. Access guard profiles and compliance documents.

### Guard-side features
1. Guard profile registration with onboarding checklist.
2. SIA licence number entry + verification workflow.
3. Optional location sharing with active/recruited companies.
4. Patrol verification by scanning NFC tags at checkpoints.
5. Incident reporting (photos, notes, severity, timestamp, location).
6. Daily log book entries.
7. In-app messaging with companies/supervisors.
8. Automated safety check calls/check-ins.
9. Emergency panic button with immediate alert dispatch.

---

## 4) Recommended Tech Stack

### Mobile App
- **Flutter** (single codebase for Android/iOS).
- Local storage: `sqflite` or Hive for offline queue.
- Push notifications: Firebase Cloud Messaging (FCM).
- Maps/geolocation: Google Maps SDK + platform location services.
- NFC: Flutter NFC plugin with platform permissions.

### Backend
- **Node.js (NestJS)** or **Python (FastAPI)**.
- REST API (+ WebSockets for live chat and panic alerts).
- PostgreSQL for transactional data.
- Redis for queues/realtime pub/sub.
- Object storage for documents/photos (S3-compatible).

### Integrations
- SIA licence verification (official API if available; otherwise compliant manual verification pipeline).
- Payments/invoicing: Stripe (or region-appropriate billing provider).
- Telephony/safety check calls: Twilio or equivalent.

### Infrastructure
- Dockerized services.
- Cloud hosting (AWS/Azure/GCP).
- Monitoring: Sentry + Prometheus/Grafana.

---

## 5) Data Model (High-level)
- `users` (common auth account)
- `companies`
- `guards`
- `sia_verifications`
- `jobs`
- `applications`
- `sites`
- `projects`
- `shifts`
- `timesheets`
- `invoices`
- `patrol_checkpoints` (NFC tag mapping)
- `patrol_events`
- `incidents`
- `daily_logs`
- `messages`
- `safety_check_events`
- `panic_alerts`

---

## 6) Security, Compliance, and Privacy
- Role-based access control (RBAC).
- Multi-factor authentication for company admins.
- Encryption in transit (TLS) and at rest.
- Audit logging for sensitive actions.
- Granular location-sharing consent and session-based tracking.
- Data retention policies for incident and employment records.
- UK GDPR compliance approach if operating in UK.

---

## 7) Suggested MVP Scope (Phase 1)
1. Authentication + role selection (company/guard).
2. Company profile + guard profile creation.
3. Job posting, application, assignment to shifts.
4. Timesheet capture + approval.
5. Basic invoicing generation.
6. SIA capture + verification status tracking.
7. Incident reports + daily logs.
8. Messaging.
9. Panic button + alert notifications.

Out-of-scope for MVP (Phase 2): advanced analytics, complex payroll, AI incident classification.

---

## 8) Build Roadmap (12-Week Example)
- **Weeks 1-2:** Product discovery, UX wireframes, schema design.
- **Weeks 3-4:** Auth, profiles, role-based dashboards.
- **Weeks 5-6:** Jobs, recruitment flow, scheduling.
- **Weeks 7-8:** Timesheets, invoicing, guard profile access.
- **Weeks 9-10:** Incident logs, messaging, NFC patrol.
- **Weeks 11-12:** Safety check calls, panic flow, QA, pilot launch.

---

## 9) Next Steps to Start Implementation
1. Confirm target launch region(s) and legal/compliance requirements.
2. Finalize SIA verification method (API/manual/hybrid).
3. Approve MVP scope and non-functional requirements (uptime, latency).
4. Produce clickable UX prototype.
5. Start backend contract-first API design (OpenAPI).
6. Build Flutter app with feature flags for phased rollout.
