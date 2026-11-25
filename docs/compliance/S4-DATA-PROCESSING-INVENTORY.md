# S4 data-processing inventory (derived from code)

**Purpose of this document.** Input for the owner's legal review. It lists what personal data the S4 code stores, where
the code collects it, what the code uses it for, which outside services the code is wired to send it to, and what the
code does with it on account deletion.

**What this document is not.** It is not a privacy policy, a record of processing activities in legal form, a lawful-basis
analysis or a statement of compliance. It makes no claim that any processing is lawful or compliant. "Purpose" below means
only *what the code does with the data*. Wherever a retention period is needed and the code does not already contain an
owner-approved one, it says **OWNER TO DECIDE**.

**Source.** `security-backend-nest/src/**/entities/*.entity.ts` (67 tables), `security-backend-nest/src/auth/account-deletion*.ts`,
`render.yaml`, `security-mobile-app/package.json`, `security-mobile-app/app.json`, `security-mobile-app/src/services/*`.
Branch `feature/s4-rel-account-deletion` (base `release/s4-pilot-rc1` @ `a700c20`), 24 Nov 2026. Production configuration
values were not read; where the code allows a choice, the entry says so.

---

## 1. Outside services the code is wired to

| Service (as named in code) | What the code sends | Where in code | Enabled by |
|---|---|---|---|
| **Render** (API hosting) | All API traffic and every record below passes through the API process. | `render.yaml` (`security-marketplace-api`, plan starter) | Deployment |
| **PostgreSQL database** at `DATABASE_URL` | Every table below. The code does not name the database provider. | `src/database/*`, `render.yaml` (`DATABASE_URL`, value not in repo) | `DATABASE_URL` — **owner to confirm the provider and region** |
| **Vercel** (web app at `https://app.sfour.co.uk`) | Serves the web build of the app; the browser then calls the API directly. The web session is held in the browser's `localStorage` (`src/services/session.ts`). | `S4_WEB_APP_URL` in `render.yaml`; web build of `security-mobile-app` | Deployment |
| **Resend** (`https://api.resend.com/emails`) | Recipient email address and message body for three kinds of email: `password_reset`, `email_verification` (both carry a one-time link), `shift_amendment_confirmation`. | `src/email/transactional-email.service.ts`, `src/auth/account-recovery.service.ts`, `src/shift-amendment/shift-amendment.service.ts` | `RESEND_API_KEY` + `EMAIL_FROM`; without them nothing is sent |
| **Expo push service** (`https://exp.host`), which delivers through **Google FCM** (Android) and **Apple APNs** (iOS) | Push token, notification title and body (Welfare Check reminders and Guard notifications, e.g. shift amendments). Bodies can name a site. (Company-user push for Emergency alerts is in the separate, unmerged EM-01 branch, not this base.) | `src/welfare-push/expo-push.client.ts`, `welfare-push/*`, `guard-notification/*`; mobile `src/services/pushNotifications.ts`, `expo-notifications`; Android `GOOGLE_SERVICES_JSON` in `app.config.js` | Push enabled per company/feature in code |
| **S3-compatible object store — compliance / screening evidence** | Uploaded documents (right-to-work, SIA, ID, address and other screening evidence). Private bucket, short-lived signed URLs (`EVIDENCE_SIGNED_URL_TTL_SECONDS`, 180 s in `render.yaml`). | `src/compliance/evidence-storage.service.ts` | `EVIDENCE_STORAGE_*` — **owner to confirm provider/region** |
| **S3-compatible object store — patrol photo evidence** (code comments name Cloudflare R2 as the expected provider) | Patrol checkpoint photos and evidence export ZIPs. Separate bucket and keys. | `src/patrol/evidence/patrol-object-store.ts` | `PATROL_EVIDENCE_STORAGE_*` — **owner to confirm provider/region** |
| **Sentry** (`@sentry/node`) | Server error reports. | `src/monitoring/monitoring.ts` | Only if `SENTRY_DSN` is set. `render.yaml` deliberately does not declare it, so it is **off** unless added by hand. |
| Mobile app | No analytics, crash-reporting or advertising SDK in `security-mobile-app/package.json`. | — | — |

On the device, the app stores the session (refresh/access token) in `expo-secure-store` (native) or `localStorage` (web),
and queues patrol scans/photos for upload in `expo-sqlite` and the app's file system until they sync.

---

## 2. Personal data by table

Columns are listed by name. "Enc" columns are encrypted at rest with `GUARD_DATA_ENCRYPTION_KEY`; `ninoHmac` is a keyed
hash used for duplicate detection. "On self-deletion / admin completion" refers to
`AccountDeletionService.anonymiseUserInTransaction` (shared by both paths) and, for owners and client logins,
`AccountDeletionAdminService`.

### 2.1 Accounts and sign-in

| Table | Personal data (columns) | Collected where | What the code uses it for | On account deletion | Retention |
|---|---|---|---|---|---|
| `users` | `email`, `firstName`, `lastName`, `phone`, `passwordHash` (bcrypt), `role`, `status`, `lastLoginAt`, `isEmailVerified`, `deletionRequestedAt`, `deletionCompletedAt` | Registration (`AuthScreen`), invitations, operator CLI (admins) | Sign-in, contact, attributing actions | Row kept. `email` → `deleted-user-{id}@deleted.invalid`; names and phone → null; password → unusable sentinel; `status` inactive; `deletionCompletedAt` set | Anonymised row: **OWNER TO DECIDE** |
| `client_portal_users` | `email`, `firstName`, `lastName`, `passwordHash`, `role`, `lastLoginAt` | Created by a company for its client | Client portal sign-in | Row kept (admin completion). `email` → `deleted-client-{id}@deleted.invalid`; names → empty; password → sentinel; `isActive` false; `lastLoginAt` null | **OWNER TO DECIDE** |
| `auth_sessions` | `tokenHash` (SHA-256 of refresh token), `familyId`, timestamps | Mobile sign-in | Renewable mobile sessions | All revoked (`revokedAt`, reason `account_deleted`; members of a closed company: `company_closed`). Rows kept. | **OWNER TO DECIDE** |
| `user_verification_tokens` | `tokenHash`, `purpose`, timestamps | Password reset, email verification | One-time emailed links | Outstanding ones invalidated. Rows kept. | **OWNER TO DECIDE** |
| `push_devices` | `token` (Expo push token), `platform`, `appVersion`, `lastSeenAt` | Guard app sign-in (`src/services/pushNotifications.ts`) | Sending push notifications | **Rows deleted** for the deleted user | n/a after deletion; otherwise **OWNER TO DECIDE** |
| `audit_logs` | `user` (id), `company`, `action`, `beforeData`/`afterData` (JSON, may contain names/emails written by other actions, e.g. client portal user create/update, invitations), `ipAddress`, `userAgent` (set by some routes, e.g. Guard invitation acceptance) | Server, on audited actions | Security and change history | **Not changed.** Deletion audit entries themselves carry ids only (`account.deletion_*`, `company.closed_for_owner_deletion`). Earlier entries that contain the person's email or name stay as they are. | **OWNER TO DECIDE** |

### 2.2 Guard profile and personnel records (company-held)

| Table | Personal data | Collected where | Use in code | On account deletion | Retention |
|---|---|---|---|---|---|
| `guard_profiles` | `fullName`, `phone`, `siaLicenseNumber`, `siaExpiryDate`, `rightToWorkStatus`/`ExpiryDate`, `ninoEnc`, `ninoHmac`, `utrEnc`, `notes`, `locationSharingEnabled` | Guard registration and Profile | Identifying and vetting the Guard, attributing work | `phone` → `''`; location sharing off. **`fullName`, `siaLicenseNumber`, NI/UTR and the rest are kept** (`RETENTION_POLICY_CONTROLLED_RECORDS`) | **OWNER TO DECIDE** |
| `guard_bank_details` | `accountHolderNameEnc`, `sortCodeEnc`, `accountNumberEnc` | Guard Profile / company HR | Payroll | **Kept unchanged** | **OWNER TO DECIDE** |
| `guard_emergency_contacts` | `contactNameEnc`, `primaryPhoneEnc`, `alternatePhoneEnc`, `customRelationshipEnc` (a third party's data) | Guard Profile | Emergency contact | **Kept unchanged** | **OWNER TO DECIDE** |
| `guard_driving_profiles` | `licenceNumberEnc`, `licenceCategories`, `licenceExpiryDate`, travel and vehicle answers | Guard Profile | Deployment planning | **Kept unchanged** | **OWNER TO DECIDE** |
| `guard_documents`, `compliance_records`, `guard_compliance_checks`, `attachments` | Document metadata (`originalFileName`, `documentNumber`, `licenceNumber`, expiry/issue dates, `workRestrictions`, `rightToWorkExcuse`, `checkedByName`), object `storageKey`/`fileUrl` | Guard uploads; company compliance checks | Screening (BS 7858), right-to-work, SIA checks | **Kept unchanged**, including the stored files in the evidence bucket | **OWNER TO DECIDE** |
| `company_guards`, `company_guard_employment_records` (`internalNoteEnc`), `company_guard_payroll_records` (`payrollReference`, `payrollNoteEnc`), `company_guard_invitations` (`targetSiaLicenceNumber`) | Employment relationship, roles, dates, payroll references, encrypted notes | Company portal | Employment and payroll administration | **Kept unchanged** | **OWNER TO DECIDE** |
| `guard_availability_rules`, `guard_availability_overrides` (`note`), `guard_leave` (`reason`) | Availability and leave, free-text reasons | Guard app / company | Scheduling | **Kept unchanged** | **OWNER TO DECIDE** |

### 2.3 Operations (company-held)

| Table | Personal data | Collected where | Use in code | On account deletion | Retention |
|---|---|---|---|---|---|
| `shifts`, `assignments`, `jobs`, `job_applications`, `job_matches`, `job_slots`, `rota_slots`, `shift_amendments` | Guard id per shift/assignment; `assignments.checkIn/OutLat/Lng`; free-text `instructions`, `closeOutNotes`; amendment agreement and dispute text | Company portal, Guard app | Scheduling and work records | **Kept unchanged** | **OWNER TO DECIDE** |
| `attendance_events` | `latitude`, `longitude`, `gpsAccuracyMeters`, `distanceFromSiteMeters`, `nfcTag`, `notes`, `reason`, timestamps | Guard Book On/Off — **one foreground location reading** at sites that require it (`src/services/attendanceLocation.ts`); no background location | Proving attendance | **Kept unchanged** (`attendance_and_gps_evidence`) | **OWNER TO DECIDE** |
| `timesheets`, `client_weekly_approval_*`, `client_shift_disputes`, `payroll_batches`, `invoice_batches` (`billingAddressSnapshot`, `clientNameSnapshot`), `payment_records`, `pay_rule_configs`, `contract_pricing_rules` | Hours worked, pay/billing snapshots, client approver ids and notes | Company and client portals | Payroll, invoicing, client approval | **Kept unchanged** | **OWNER TO DECIDE** |
| `daily_logs` (Log Book), `incidents`, `safety_alerts`, `welfare_reminders`, `notifications`, `guard_notification_dispatches` | Free text (`message`, `notes`, `title`, `locationText`, resolution notes) — **may contain health or third-party information**; push ticket ids | Guard app, company portal | Operations, safety, Welfare Checks | **Kept unchanged** | **OWNER TO DECIDE** |

### 2.4 Patrols (company-held)

| Table / object | Personal data | Collected where | Use in code | On account deletion | Retention coded in `src/patrol/patrol-retention.ts` |
|---|---|---|---|---|---|
| Patrol photos (object store) + `patrol_evidence` | Photo of the checkpoint (may show people), `latitude`/`longitude`, capture times, `guardId` | Guard app camera (`expo-camera`, `GuardPatrolCamera.tsx`); photos are not saved to the phone's library | Proving a patrol checkpoint visit | **Kept unchanged** | Photos 30 days (90 where the site policy says) from receipt; coordinates 30 days. **Only photo deletion is implemented, and it runs in `report` mode (deletes nothing) unless `PATROL_EVIDENCE_RETENTION_MODE` is changed — owner to confirm the production value.** |
| `patrol_runs`, `patrol_checkpoint_visits`, `patrol_exceptions`, `patrol_sync_recovery_grants`, `patrol_evidence_holds`, `patrol_evidence_exports` | Guard id, times, scan coordinates, notes, hold reasons | Guard app, company portal | Patrol records, exceptions, evidence holds and exports | **Kept unchanged** | Visits 12 months; runs 24 months; audit 24 months; holds 6 years after release; exports 24 months — **recorded in code, no purge implemented** for these categories |

### 2.5 Companies and clients

| Table | Personal data | Collected where | Use in code | On owner deletion (admin completion) | Retention |
|---|---|---|---|---|---|
| `companies` | `name`, `companyNumber`, `address`, `contactDetails` (free text, may hold a person's contact), owner `userId`, `verificationNote` | Company registration | Company identity, S4 verification | Row kept. Closed: `verificationStatus` → `suspended` (or `rejected` if never approved) with a fixed note, through the audited verification decision | **OWNER TO DECIDE** |
| `company_memberships`, `company_invitations` (`email`) | Team membership, inviter ids; invitee email | Company portal | Team access | All memberships of the closed company → `revoked` (`disabledAt`, `disabledByUserId`); members' sessions revoked. Rows kept. Members' own accounts are not deleted. | **OWNER TO DECIDE** |
| `clients` | `contactName`, `contactEmail`, `contactPhone`, `contactDetails` | Company portal | The company's client records | **Kept unchanged** — company data, also when a client portal login is deleted | **OWNER TO DECIDE** |
| `sites` | `address`, `contactDetails`, `clientName`, site coordinates, `specialInstructions` | Company portal | Operations | **Kept unchanged** | **OWNER TO DECIDE** |

---

## 3. What each deletion path does (code behaviour)

| Account | Path | Result |
|---|---|---|
| Guard, company team member (not owner), users-table client user | In-app, password confirmed (`POST /account/deletion/confirm`), or Platform Admin completion of a recorded/emailed request | `users` row anonymised as in 2.1; Guard phone blanked and location sharing off; sessions revoked; outstanding emailed links invalidated; push devices deleted. Nothing else changes. |
| Company owner | In-app request is recorded (self-completion refused). Platform Admin completes it from **Account deletion requests** | Refused (409) while any owned company has a shift `in_progress`. Otherwise: each owned company closed (suspended / rejected, audited `company.verification_changed`), every membership revoked and members' sessions ended (audited `company.closed_for_owner_deletion`), then the owner anonymised as above (audited `account.deletion_completed_by_admin`). |
| Platform Admin | In-app request recorded (self-completion refused). Completed by a **different** Platform Admin only | Never self; never the last active Platform Admin. |
| Client portal login | In-app **Request account deletion** (Client portal › Account), or recorded by a Platform Admin from an emailed request | Request is an audit entry (`account.deletion_requested` / `account.deletion_requested_by_admin`, entity `client_portal_user`); the `client_portal_users` table has no deletion columns. Completion anonymises the login as in 2.1 and cuts off its live token at once. The company's `clients` row and all records about the client are kept. |
| Any account, by email | Platform Admin records the request by the registered email (audited `account.deletion_requested_by_admin`, ids only), then completes it as above | — |

Nothing in any path physically deletes a row except `push_devices`. The categories deliberately kept are listed in code as
`RETENTION_POLICY_CONTROLLED_RECORDS` (`src/auth/account-deletion.service.ts`) and written to every completion audit entry.

---

## 4. Decisions for the owner (from the code, not policy)

1. Retention period for every category above marked **OWNER TO DECIDE**, in particular: Guard name and SIA number after
   deletion; NI/UTR, bank details, emergency contacts and driving licence after deletion; screening documents and their
   stored files; attendance GPS; Log Book / incident / Welfare free text; audit logs (which can contain earlier emails and
   names); anonymised account rows.
2. Whether patrol photo deletion should run (`PATROL_EVIDENCE_RETENTION_MODE`), and confirmation of the production value.
3. Providers and regions for the database, the compliance evidence bucket and the patrol evidence bucket.
4. One support address: the app and the deletion page use `info@vesoft.co.uk`; `sfour.co.uk/support` also lists
   `support@sfour.co.uk`.
5. Whether a client portal deletion request should eventually get its own column (needs a migration) instead of the
   audit-entry record used now.
