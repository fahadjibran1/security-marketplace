# BLK-010 — Right-to-Work Process: Legal/HR Review Record

**Document purpose:** This document describes how S4 v1.0.0-rc1 implements right-to-work data collection, enforcement, and recording. It asks the designated Product/Business Owner or organisation Right-to-Work/Compliance Owner to review whether the workflow is appropriately designed for use alongside a UK employer right-to-work checking process. This document is NOT a legal opinion, does NOT constitute legal advice, and does NOT guarantee that use of S4 satisfies any statutory obligation under UK right-to-work law. The owner acceptance section records the owner's internal acceptance decision. Independent professional legal or HR advice may be obtained by the organisation where considered necessary.

**Legislative context:** UK employers are required to conduct right-to-work checks under the Immigration, Asylum and Nationality Act 2006, as amended. The Home Office publishes guidance for employers — currently the "Employer's guide to right to work checks" — which is updated periodically and is the authoritative reference for employers conducting checks. The owner or their nominated reviewer must consult the current edition of that guidance when conducting this review. This document does not reproduce Home Office guidance text and is not a substitute for reading that guidance directly. Independent professional legal or HR advice may be obtained where the organisation considers it necessary.

**Release gate:** BLK-010. Status remains OPEN until this document is accepted by the designated Product/Business Owner or organisation Right-to-Work/Compliance Owner.

**Branch / SHA under review:** `release/v1.0.0-rc1` — `38c14d4`

---

## 1. Background context

UK employers are required by law to conduct checks that establish a person's right to work before employment begins. Responsibility for conducting, recording, and retaining evidence of those checks rests with the employer, not with any software system. Carrying out a compliant check may, depending on the circumstances, provide the employer with a statutory excuse against a civil penalty under the Immigration, Asylum and Nationality Act 2006.

S4 is a workflow and record-keeping tool. Nothing in this document or in the S4 application constitutes a right-to-work check, changes the employer's legal obligation, or provides a statutory excuse. The operator must conduct checks in accordance with the current Home Office employer guidance and retain evidence accordingly.

---

## 2. What S4 technically enforces — factual summary

This section describes only what the application code technically enforces. S4 enforces the conditions listed below as system-level gates. These gates confirm that the system has recorded the required data; they do not confirm that the underlying check was conducted correctly, that documents are genuine, or that a statutory excuse has been established. See Section 3 for the operational responsibilities that accompany system use.

### 2.1 Compliance status and assignability gate

The compliance assessment service (`guard-compliance.service.ts: assessGuard`) evaluates a guard's right-to-work state and gates operational deployment. A guard is marked `assignable: false` and cannot be hired or assigned to a shift if any of the following is true:

| Condition | Blocking reason reported |
|---|---|
| `rightToWorkStatus` field is empty | "Missing right-to-work status" |
| `rightToWorkStatus` is one of: `invalid`, `expired`, `revoked`, `refused`, `suspended` | "Right-to-work status is [value]" |
| `rightToWorkExpiryDate` is missing when status is not permanent/indefinite/settled/british/citizen/no_expiry | "Missing right-to-work clearance expiry date" |
| `rightToWorkExpiryDate` is in the past | "Right-to-work clearance expired" |
| No Right-to-work document uploaded and completed | "Missing Right-to-work document" |
| Right-to-work document exists but is not verified | "Right-to-work document is not verified" |

These checks are evaluated every time `GET /compliance/mine/status` or `GET /compliance/statuses` is called, against the live values in the database.

**Important:** Passing these checks confirms the system will permit assignment. It does not confirm that a right-to-work check has been conducted to the standard required by law, that the documents examined are genuine, or that a statutory excuse has been established. See Section 3 for the operational responsibilities that accompany system use.

### 2.2 Compliance status values

The overall compliance status can be: `valid`, `expiring`, `expired`, or `invalid`. Only `valid` and `expiring` result in `assignable: true`. The system generates an expiry warning when the recorded `rightToWorkExpiryDate` is within 30 days. Operators should verify whether this warning period is appropriate for their obligations under the current Home Office guidance.

### 2.3 Right-to-work document storage and verification

The `guard_documents` table stores uploaded right-to-work evidence files:

| Field | Purpose |
|---|---|
| `type = 'right_to_work'` | Document category |
| `originalFileName`, `mimeType`, `sizeBytes` | File metadata |
| `uploadCompletedAt` | Timestamp of confirmed upload |
| `expiryDate` | Optional expiry date recorded on the document |
| `verified` | Boolean — set to `true` when a company user explicitly verifies the document |
| `verifiedByUserId`, `verifiedAt` | Who verified it and when |
| `storageProvider`, `storageKey` | Private object storage reference |

Document files are not publicly accessible. Access requires a time-limited signed URL, which is generated per-access and written to the audit log.

A document is only counted as present for compliance purposes after `uploadCompletedAt` is set (i.e. the upload has been confirmed complete). An uploaded but unconfirmed document does not satisfy the requirement.

The `verified` flag is set by a company user clicking to verify the document in the application. The system records that a user performed this action; it does not independently authenticate the document, validate its genuineness, or confirm it is an acceptable document type under the current Home Office list of acceptable documents. See Section 3.

### 2.4 Right-to-work fields in the guard profile

The `guard_profiles` table stores:

| Field | Purpose |
|---|---|
| `rightToWorkStatus` | Status value (see recognised values below) |
| `rightToWorkExpiryDate` | Date of expiry, where applicable |

The system recognises the following specific string values as indicating indefinite or non-expiring right-to-work status (and therefore not requiring an expiry date): `permanent`, `indefinite`, `settled`, `british`, `citizen`, `no_expiry`. Any other value entered in this field will be treated by the system as requiring an expiry date. Operators must ensure that guards enter a recognised value or that staff are trained to enter values the system will interpret correctly. An unrecognised free-text value (e.g. `british citizen` rather than `british`) will cause the system to require an expiry date, which may create a false compliance block.

Changes to `rightToWorkStatus` or `rightToWorkExpiryDate` reset the `rightToWorkVerification` state on the guard's screening file to UNVERIFIED, requiring re-verification by an admin.

### 2.5 Right-to-work check record in the screening workflow

Within the full screening flow (`screening.service.ts`), an admin must explicitly complete a right-to-work check before a screening can be marked VETTED. The system stores:

| Field | Purpose |
|---|---|
| `rightToWorkVerification` | UNVERIFIED / PENDING / VERIFIED / REJECTED |
| `rightToWorkCheckMethod` | Free-text description of the method used (e.g. "Home Office online check", "manual document inspection") |
| `rightToWorkCheckDate` | Date the check was performed |
| `rightToWorkVerifiedByUserId` | ID of the admin who recorded the check |
| `rightToWorkVerifiedAt` | Timestamp of the verification action |
| `rightToWorkFollowUpDate` | Optional follow-up date for time-limited right to work |

The system requires an uploaded and verified `right_to_work` evidence file (via `ScreeningEvidence` with `category = 'right_to_work'`) before the screening file can be completed.

**Right-to-work follow-up date:** Storing a `rightToWorkFollowUpDate` value records the date for information purposes only. The system does not generate an automated reminder notification when this date approaches or passes, and does not automatically block assignment or flag the guard as non-compliant when the follow-up date is reached. Monitoring and acting on time-limited right-to-work follow-up dates is an entirely manual, operational responsibility. See Section 3 item 3.

### 2.6 Compliance reminders

The system runs a daily compliance reminder process (`runDailyComplianceReminders`). Where a guard's RTW record is in `expiring` or `expired` state — as determined by the `rightToWorkExpiryDate` field — an in-app notification is sent to the linked company user, subject to a 24-hour deduplication window. This reminder is triggered by the expiry date field, not by the `rightToWorkFollowUpDate` field.

### 2.7 Audit trail

The following RTW-related events are recorded in `audit_logs`:

- `guard_document.uploaded` — when an RTW document upload is confirmed
- `guard_document.verified` — when a company user marks the document verified (includes `verifiedByUserId`, `documentType`, `guardId`)
- `guard_document.accessed` — when a signed download URL is generated for the document
- `screening.check_verified` — when an admin records the RTW check in the screening workflow (includes `check: "rtw"`, `state`, `method`, `verifiedByUserId`, `verifiedAt`)
- `screening.candidate_compliance_updated` — when the guard updates RTW status or expiry

---

## 3. What S4 does NOT technically enforce — known scope limitations

The following are **not** enforced by the application. Each represents an area requiring operator-level procedural controls. The reviewer is asked to assess these limitations in Section 4.

The table below distinguishes between the type of responsibility that applies to each limitation:

| # | Scope limitation | Type of responsibility |
|---|---|---|
| 1 | **Document type validation.** S4 accepts any PDF, JPEG, or PNG as an RTW document. The application does not validate that the specific document type or combination of documents constitutes acceptable evidence under the current Home Office list of acceptable documents. | Employer process / document checking |
| 2 | **Timing of the check relative to start of employment.** S4 records when a document was verified, but does not enforce that this occurred before the guard's first shift. Establishing that checks are completed before employment commences is a statutory requirement and an operational responsibility. | Statutory excuse / employer process |
| 3 | **Repeat check enforcement.** `rightToWorkFollowUpDate` is stored in the database but no automated process blocks assignment, generates a reminder notification, or triggers a mandatory re-check when this date passes. Ongoing monitoring and repeat checks for time-limited right to work are entirely an operational responsibility. | Employer process / human decision-making |
| 4 | **Distinction between document lists.** S4 does not classify RTW evidence as List A or List B under the Home Office scheme. This classification — and any different treatment between the two — is the operator's responsibility. | Document checking / statutory excuse |
| 5 | **Who may verify documents.** Any user with a `company` role may verify a right-to-work document for their company's guards. The application does not restrict verification to designated trained personnel. The operator must ensure only authorised individuals perform checks and that those individuals understand what they are attesting to. | Employer process / human decision-making |
| 6 | **Genuineness of documents.** S4 stores an uploaded file and marks it verified when a user clicks verify. The application does not authenticate, OCR, or validate the content of uploaded documents. Responsibility for assessing whether a document is genuine rests with the human reviewer. | Document checking / human decision-making |
| 7 | **Retention after employment ends.** S4 does not automatically enforce deletion or archival of RTW records after the required retention period. The Home Office guidance specifies retention obligations; retention management is an operational responsibility. | Employer process |
| 8 | **Status vocabulary.** The `rightToWorkStatus` field accepts free-text values. S4 recognises specific strings to determine whether an expiry date is required (see Section 2.4). Operators must maintain consistent vocabulary. An unrecognised value will cause the system to require an expiry date. | Employer process / human decision-making |
| 9 | **Cross-border / overseas workers.** S4 does not apply any enhanced checks for workers who declare an overseas history period. | Employer process |

---

## 4. What the owner is asked to accept

The owner is asked to make a reasoned acceptance decision on the following, with reference to UK right-to-work law, the current Home Office Employer's guide to right to work checks, and the organisation's obligations. Independent professional legal or HR advice may be obtained where the organisation considers it necessary.

**4.1** Is the right-to-work data collection and blocking mechanism described in Section 2 appropriately designed to support the employer's right-to-work checking process? Does it collect and record the categories of information that a responsible employer would need to document in connection with a right-to-work check?

**4.2** Are the scope limitations in Section 3 acknowledged, and will the operator put in place documented procedural controls to address each one that is material to their obligations?

**4.3** Is the owner satisfied that, given the above, S4 v1.0.0-rc1 may be used in a pilot deployment as a supporting tool for the right-to-work checking process, subject to any conditions noted below?

The owner is NOT being asked to certify that use of S4 satisfies UK right-to-work law, that S4 produces a statutory excuse, or that candidates processed through S4 have had their right to work lawfully established. Those obligations — including conducting legally required checks, assessing documents, and establishing any statutory excuse — rest with the employer, not with the S4 application or its developers. The owner is being asked to confirm that the tool is fit for use as a record-keeping and workflow aid within a properly operated checking process.

---

## 5. Supporting evidence from the repository

The following artefacts, all present in the `release/v1.0.0-rc1` branch, provide supporting evidence of the implemented technical controls described in Section 2. The reviewer may refer to these to verify the factual accuracy of this document.

| Artefact | Location | Relevance |
|---|---|---|
| Compliance assessment service | `security-backend-nest/src/compliance/guard-compliance.service.ts` | Implements the six blocking conditions in Section 2.1; runs on every compliance status call |
| Guard profile entity | `security-backend-nest/src/guard-profile/entities/guard-profile.entity.ts` | `rightToWorkStatus`, `rightToWorkExpiryDate` fields |
| Document entity and verification DTOs | `security-backend-nest/src/compliance/entities/guard-document.entity.ts`, `security-backend-nest/src/compliance/dto/verify-guard-document.dto.ts` | Upload, confirm, verify, access-log logic described in Section 2.3 |
| Screening service (RTW check) | `security-backend-nest/src/screening/screening.service.ts` | `rightToWorkVerification`, `rightToWorkCheckMethod`, `rightToWorkFollowUpDate` described in Section 2.5 |
| Notification service | `security-backend-nest/src/notification/notification.service.ts` | Daily reminder process described in Section 2.6 |
| Audit log service | `security-backend-nest/src/audit-log/audit-log.service.ts` | Implements audit events described in Section 2.7 |
| UAT execution log | `docs/uat/UAT_EXECUTION_LOG.md` | Wave 2 (guard onboarding/compliance) contains executed test results against compliance APIs |
| UAT defect register | `docs/uat/UAT_DEFECT_REGISTER.md` | Records all defects raised and closed during UAT |

All 45 UAT cases have been executed and returned PASS as of `38c14d4`. No open defects remain.

---

## 6. Owner Compliance Acceptance

| Field | Value |
|---|---|
| **Owner full name** | Fahad Jibran |
| **Role** | Product / Business Owner |
| **Organisation** | S4 Security Platform |
| **Basis of authority** | Product/Business Owner making an internal RC1 product/process risk acceptance |
| **Home Office guidance consulted** | Home Office Employer's guide to right to work checks dated 26 June 2025 (the published guide available as at 31 August 2026; GOV.UK also shows a draft update dated 16 July 2026, which is not confirmed as the operative final guide and is NOT relied upon as such by this acceptance). The operator must consult and apply the current Home Office Right-to-Work guidance and applicable code of practice in force at the time each check is conducted. |
| **Acceptance date** | 31 August 2026 |
| **Branch / SHA reviewed** | `release/v1.0.0-rc1` — `8512efd` |
| **Sections of this document reviewed** | Sections 1, 2, 3, and 4 |

### Decision

- [ ] **ACCEPTED** — The right-to-work workflow is appropriately designed to support a compliant checking process as a workflow management and record-keeping tool. The scope limitations in Section 3 are acknowledged. No conditions.
- [x] **ACCEPTED WITH CONDITIONS** — The workflow is appropriately designed for its stated purpose, subject to the conditions and procedural controls listed below.
- [ ] **NOT ACCEPTED** — The workflow is not accepted for pilot use. Reasons are listed below.

### Overarching operator responsibility

S4 may capture, store, workflow-manage, and technically restrict right-to-work information where implemented. It is not itself the prescribed right-to-work check. The employer/operator remains responsible for:

- selecting the legally appropriate checking method;
- examining or obtaining the required evidence;
- confirming identity and work restrictions;
- completing online/share-code checks where applicable;
- using the Employer Checking Service where applicable;
- obtaining and retaining the evidence required to establish or maintain a statutory excuse;
- performing follow-up checks when required;
- making the final employment or eligibility decision.

Any automated S4 flag or status must not be treated as a substitute for those responsibilities.

### Conditions

**Condition 1 — S4 is a workflow and evidence-management tool, not a prescribed RTW check**
S4 is a workflow/evidence-management and technical-control system. It is not itself a prescribed right-to-work check under UK legislation.

**Condition 2 — Employer/operator carries out the legally appropriate check**
The employer/operator remains responsible for carrying out the legally appropriate check before employment or engagement begins where required by law.

**Condition 3 — Verified/status fields do not establish a statutory excuse**
S4's `verified` flag and status fields do not by themselves establish a statutory excuse. The `verified` flag records that a user confirmed a document; it does not authenticate the document, validate its genuineness, or confirm it is an acceptable document type under Home Office requirements.

**Condition 4 — Prescribed checking procedures remain the operator's responsibility**
Online/share-code checks, manual document checks, Document Verification Service/Identity Document Validation Technology processes, and Employer Checking Service processes must be performed using the appropriate current Home Office procedure where applicable, independently of what S4 technically records.

**Condition 5 — Time-limited RTW: follow-up checks must be managed procedurally**
Time-limited right-to-work cases must receive required follow-up checks. S4 stores `rightToWorkFollowUpDate` for information only — it does not generate automated reminders, block assignment, or trigger re-checks when this date is reached. The operator must control these procedurally through documented operational procedures.

**Condition 6 — List A / List B treatment is the operator's responsibility**
S4 does not classify RTW evidence as List A or List B under the Home Office scheme and does not apply different treatment between the two. The operator must apply the appropriate current Home Office evidence and checking procedure where this distinction is relevant.

**Condition 7 — Retention and deletion must be managed according to current requirements**
Evidence retention, deletion, and archival must be managed according to current Home Office requirements, applicable data-protection obligations, and any applicable legal hold requirements, where S4 does not automate these activities.

**Condition 8 — Overseas history alone is not a right-to-work determination**
Recording overseas activity history in S4 does not establish right to work and does not substitute for any checking procedure applicable to that individual's immigration or eligibility circumstances.

**Condition 9 — Human decision-making and legal advice remain the employer's responsibility**
Human and employer decision-making remains required at all stages. S4 must not be relied upon as providing legal advice or determining immigration status. The employer makes the final employment and eligibility decision.

**Condition 10 — Current Home Office guidance must be applied at time of each check**
Home Office right-to-work guidance and checking procedures change over time. The operator must consult and apply the current Home Office guidance and applicable code of practice in force at the time each check is conducted. This acceptance does not hard-code reliance on any specific edition.

**Condition 11 — Limitations of this acceptance**
This acceptance is an internal product/process risk acceptance by the Product/Business Owner. It is NOT independent legal advice, NOT Home Office approval, NOT certification of S4, and NOT a guarantee of statutory compliance. S4 must not be marketed as guaranteeing UK right-to-work compliance on the basis of this acceptance.

**Condition 12 — RTW status vocabulary is internal workflow terminology only (B1)**
The right-to-work status values used by S4 (including `permanent`, `indefinite`, `settled`, `british`, `citizen`, `no_expiry`, `invalid`, `expired`, and others) are internal workflow terminology only. They must not be interpreted as Home Office immigration classifications, legal determinations, or evidence that a prescribed right-to-work check has been completed. The employer/operator must determine the worker's actual right-to-work position from the prescribed check and underlying evidence in accordance with the current Home Office procedure. The operator must maintain a controlled vocabulary list and ensure staff are trained on valid status values to avoid misconfiguration.

**Condition 13 — S4 role permissions do not establish legal competence or organisational authority (C2)**
S4 technical role permissions determine who can perform workflow actions within the application but do not by themselves establish legal competence or organisational authority to conduct a right-to-work check. The employer/operator must ensure that only an appropriately authorised and trained/designated person records the organisation's right-to-work verification decision in S4, in accordance with the organisation's right-to-work procedure.

### Signature / Recorded Approval

By completing this record, the owner confirms that they have read Sections 1 through 4 of this document, that they have consulted or ensured consultation of the current Home Office Employer's guide to right to work checks to the extent described in the acceptance table above, that this is their internal acceptance decision as Product/Business Owner, and that they understand that responsibility for UK right-to-work compliance — including conducting legally required checks, assessing documents, and establishing any statutory excuse — rests with the employer, not with the S4 application or its developers. Independent professional legal or HR advice may be obtained by the organisation where considered appropriate.

```
Signature / recorded approval: Electronically approved by Fahad Jibran, Product / Business Owner, on 31 August 2026.

Printed name: Fahad Jibran

Role: Product / Business Owner

Organisation: S4 Security Platform

Date: 31 August 2026
```

_This document should be retained as part of the release evidence record for S4 v1.0.0-rc1 and as part of the employer's right-to-work compliance records for the duration required by the applicable Home Office guidance._

---

**BLK-010 status:** ACCEPTED WITH CONDITIONS — owner gate satisfied for RC1 pilot (31 August 2026).
Current Home Office guidance must be consulted at the time each check is conducted; this acceptance does not constitute certification or guarantee of statutory compliance.
