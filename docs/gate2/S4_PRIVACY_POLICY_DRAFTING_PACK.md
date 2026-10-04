# S4 Privacy Policy — factual drafting pack

**Status:** DRAFTING INPUT FOR OWNER / LEGAL REVIEW. Not a privacy policy. Not legal advice. Do not publish.
**Product name:** S4 (not "S4 Security", not "S4 Guard", not "Security Marketplace").
**Prepared:** S4 Pilot Gate 2, branch `release/s4-pilot-rc1`.

The documents currently at `sfour.co.uk/privacy` and `sfour.co.uk/terms` were identified as **PatrolSafe**
documents. They must not be treated as S4's, and they must not be overwritten from this repository — see
[`S4_ACCOUNT_DELETION_PAGE_SPEC.md`](./S4_ACCOUNT_DELETION_PAGE_SPEC.md) for where the site lives. This pack
describes only what S4 actually does today, so that a privacy policy can be written from facts. Where a
fact needs a decision, it is marked **LEGAL/OWNER DECISION REQUIRED**.

## Claims that must NOT appear in an S4 policy

These are PatrolSafe-style or otherwise false for S4:

- S4 is **not** "local-first". Operational records are stored on S4's servers, not only on the device.
- Operational evidence does **not** "remain only on the user's device".
- S4 does **not** erase every record when an account is deleted (see "Account deletion" below).
- S4 is **not** a certified lone-worker monitoring service and does **not** guarantee an emergency response.
- S4 does **not** use session replay, product analytics, or advertising trackers.
- Error monitoring (Sentry) is **not** enabled in production at the time of writing.

## 1. Who S4 is for, and who the controller is

S4 is a workforce and operations platform for UK private security companies: companies, their staff, the
Guards they deploy, and (through a client portal) their clients.

- **LEGAL/OWNER DECISION REQUIRED — controller/processor roles.** For most operational data (shifts,
  attendance, Welfare, Log Book, incidents, timesheets), the security company decides why and how the
  data is used; S4 may act as that company's processor. For S4 accounts, platform administration, S4
  Screening (if offered) and platform security records, S4's operator may be a controller. The legal
  entity that operates S4 must be named (the Google Play organisation is recorded as **Vesoft Services
  Limited** — confirm whether this is also the data controller for S4).
- **LEGAL/OWNER DECISION REQUIRED — contact details** for privacy requests and, if appointed, a DPO.

## 2. What S4 processes (as built)

| Category | What is held | Where it comes from |
|---|---|---|
| Account | email address, bcrypt password hash, role, account status, email-verification state, last login time, deletion request/completion timestamps | the account holder |
| Sessions | refresh-session records (only a SHA-256 hash of the token), creation/expiry/revocation times | the app |
| Emailed links | password-reset and email-verification tokens (SHA-256 hash only), expiry, use and invalidation times | S4 |
| Guard profile | full name, phone, SIA licence number and expiry, right-to-work status and expiry, availability, location-sharing preference | the Guard |
| Guard personnel (company-held) | employment details; payroll set-up; bank details; emergency contact (a third party); driving/transport details; National Insurance number and UTR (encrypted at rest) | the Guard and/or the employing company |
| Company / client / site | company details; client organisations and contacts; sites, addresses, site coordinates and geofence radius, site instructions | the company |
| Rota and shifts | shift schedules, assignments, offers and responses, rota slots | the company and the Guard |
| Attendance | Book On / Book Off events with time, and — when the site requires GPS — latitude, longitude, GPS accuracy, distance from site, verified flag; optional NFC tag reference | the Guard's device at Book On / Book Off |
| Timesheets & finance | worked/verified/approved hours, pay and billing snapshots, payroll and invoice batches, client weekly approvals and disputes | derived and entered by the company / client |
| Welfare Checks | Welfare Check submissions and missed-window evidence | the Guard / S4 |
| Log Book & Daily Site Log | Log Book, patrol, observation, visitor and delivery entries (free text) | the Guard |
| Incidents | incident reports (title, notes, severity, status, site, times) and resolution reason/note | the Guard / the company |
| Safety alerts | emergency (panic) alerts, Site Requests, missed Welfare / missing Book Off alerts, acknowledgement and resolution | the Guard / S4 |
| Screening (BS 7858 workflow) | identity, address history, references, consents, exceptions, evidence files in private storage | the Guard, referees, the company |
| Compliance documents | uploaded licence / right-to-work evidence and verification state | the Guard / the company |
| Leave and availability | availability rules, overrides, leave | the Guard / the company |
| Notifications | in-app notifications | S4 |
| Audit logs | who did what and when, with before/after data for many actions; fields exist for IP address and user agent | S4 |
| Client portal | client user email, password hash, role | the company |

**Location.** The mobile app asks for "when in use" location permission and reads the device location
only when the Guard Books On or Books Off at a site that requires GPS verification. S4 does **not**
continuously track location and does not collect location in the background. (Text in the Android/iOS
permission prompt currently reads "Allow S4 Security to use your location when you Book On…" — the app
display name is a Gate 3 item.)

**Children.** S4 is for working adults in the security industry. **LEGAL/OWNER DECISION REQUIRED** — age statement.

## 3. Why (purposes) — LEGAL/OWNER DECISION REQUIRED for each lawful basis

Purposes as implemented: providing accounts and secure sign-in; scheduling and deploying Guards;
recording attendance and verifying presence at site; Welfare Checks and safety alerting; keeping the Log
Book, incident and site records that companies and their clients rely on; timesheets, payroll and
invoicing; compliance and screening; security, fraud prevention and audit; account recovery and deletion.

Lawful bases (contract, legal obligation, legitimate interests, consent for screening steps that require
it, special-category considerations for any health information written into Welfare/incident free text,
criminal-offence data considerations in screening) — **LEGAL/OWNER DECISION REQUIRED**.

## 4. Who it is shared with

- **The security company** the Guard works with (and only that company — company isolation is enforced
  in the API), and **its clients** for client-portal content (e.g. incident reports, approvals).
- **Service providers (sub-processors) as configured in this repository:**

| Provider | Role | Data | Location | Status |
|---|---|---|---|---|
| Supabase | PostgreSQL database and S3-compatible private evidence storage | all of the above | eu-west-1 (Ireland) per runbooks | live |
| Render | API hosting (the S4 backend) | all API traffic | **LEGAL/OWNER: confirm Render region** — `render.yaml` sets none, and Render's default is Oregon (US) | live |
| Vercel | hosting of the S4 web app (`app.sfour.co.uk`) | static app; request logs (IP, URL) | global edge | live (confirm project) |
| Resend | transactional email: password reset and email verification only | recipient email address, message content including a one-time link | **confirm Resend region** (US default; EU region available) | prepared, not yet configured in production |
| Sentry | error monitoring | scrubbed error reports: no request bodies, cookies, auth headers, tokens, emails, operational text, SIA numbers or GPS | **confirm Sentry data region** | prepared, **not enabled in production** |

- **International transfers.** Possible to the US (Render default region, Resend, Sentry, Vercel edge).
  **LEGAL/OWNER DECISION REQUIRED** — transfer mechanisms (UK IDTA / Addendum, adequacy) and region choices.

## 5. Security measures (factual)

Passwords bcrypt-hashed; refresh, reset and verification tokens stored only as SHA-256 hashes; refresh
tokens rotate with reuse detection; every authenticated request re-checks account status; password reset
ends every session; National Insurance number/UTR encrypted at rest; private evidence storage with
short-lived signed URLs; TLS to the database; company and Guard isolation enforced server-side; audit
logging. Rate limiting on sign-in, registration and recovery endpoints.

## 6. Retention

**No retention periods have been decided.** Do not publish any. Each category's open decision is in
[`S4_RETENTION_DECISION_REGISTER.md`](./S4_RETENTION_DECISION_REGISTER.md). The policy should say that
records are kept for as long as needed for the stated purposes and legal/contractual obligations, and
then give the decided periods once they exist. **LEGAL/OWNER DECISION REQUIRED.**

## 7. Account deletion (as built — describe exactly this)

- In the app: Settings / Account → Delete account → explanation → confirm with password. Outside the app:
  see the public page specified in [`S4_ACCOUNT_DELETION_PAGE_SPEC.md`](./S4_ACCOUNT_DELETION_PAGE_SPEC.md).
- On deletion S4: removes access (account set inactive, every session ended, outstanding emailed links
  cancelled); replaces the email address with a non-deliverable placeholder; deletes first name, last
  name and phone on the account; makes the password unusable; blanks the Guard profile phone number and
  turns off location sharing; records when deletion was requested and completed.
- S4 **keeps**, pending the retention decisions: the Guard's name and SIA licence number where they form
  part of operational records; shifts, attendance (including GPS evidence), timesheets and payroll
  records; Welfare, Log Book, incident and safety-alert records; screening and compliance evidence;
  company relationships; and audit logs. These are flagged as retention-policy controlled.
- An account that owns a company workspace, or a Platform Admin, cannot be deleted in-app (it would leave
  a company without an owner); the request is recorded and handled by S4 support.

## 8. Rights and contact

UK GDPR rights (access, rectification, erasure, restriction, objection, portability, complaint to the
ICO). Where S4 is a processor, requests may be referred to the security company. **LEGAL/OWNER DECISION
REQUIRED** — request route, identity verification process and response handling.

## 9. Cookies and device storage

The mobile app stores the renewable sign-in token in the device's secure store. The web app stores
session state in the browser. No advertising or analytics cookies are set by S4. **Confirm** Vercel's
own cookies/headers, if any.
