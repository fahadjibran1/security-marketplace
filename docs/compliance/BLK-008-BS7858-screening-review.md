# BLK-008 — Guard Screening Workflow: Compliance Review Record

**Document purpose:** This document describes how S4 v1.0.0-rc1 implements guard screening workflow management and evidence collection. It asks the designated Product/Business Owner or organisation Compliance Owner to assess whether the workflow is appropriately designed for use by organisations operating under a BS 7858-based screening obligation. This document is NOT a legal opinion, does NOT constitute certification of conformity with BS 7858 or any other standard, and does NOT guarantee that use of S4 satisfies any statutory or contractual screening requirement. The owner acceptance section records the owner's internal acceptance decision. Independent professional advice may be obtained by the organisation where considered necessary.

**Standard reference:** This document refers to BS 7858 (Security Screening of Individuals Employed in a Security Environment). The owner or their nominated reviewer must consult an authorised and current copy of the applicable edition of that standard when conducting this review. This document does not reproduce the text of BS 7858 and is not a substitute for reading the standard directly.

**Release gate:** BLK-008. Status remains OPEN until this document is accepted by the designated Product/Business Owner or organisation Compliance Owner.

**Branch / SHA under review:** `release/v1.0.0-rc1` — `38c14d4`

---

## 1. What S4 implements — factual summary

This section describes only what the application code technically enforces, as derived from the codebase and confirmed by UAT execution. No claim is made about whether this satisfies any specific standard or statutory requirement.

### 1.1 Screening lifecycle

A guard screening file passes through the following states, enforced by the API:

```
NOT_STARTED → IN_PROGRESS → READY_FOR_REVIEW → UNDER_REVIEW → VETTED
                                            ↘→ REQUIRES_ATTENTION → IN_PROGRESS
                                            ↘→ REJECTED
```

A VETTED screening may subsequently transition to EXPIRED.

State transitions are role-controlled. Only a guard user can start and submit a screening; only an admin user can begin review, verify checks, request information, complete (VETTED) or reject.

### 1.2 Candidate-supplied information

The application collects and stores the following from the guard:

| Field | Enforced at submission? |
|---|---|
| Legal full name | Yes — required before submit |
| Previous names | No — optional |
| Date of birth | Yes — required before submit |
| Nationality | Yes — required before submit |
| Current address | Yes — at least one current address required |
| Address history (structured or free-text) | Yes — gap-free coverage of configured period required |
| Activity history (employment, education, self-employment, unemployment, career break, overseas, other) | Yes — gap-free coverage of configured period required |
| SIA licence number and expiry date | Yes — both required before review can be marked VETTED |
| Right-to-work status and expiry (where applicable) | Yes — required before review can be marked VETTED |
| Active screening consent | Yes — required before submit |
| At least one reference linked to a history record | Yes — required before submit |

### 1.3 History continuity check

The service (`screening.service.ts: assessContinuousHistory`) performs a date-gap analysis over both employment/activity history and address history for a configurable period (default: 5 years, set at screening creation via `screeningPeriodYears`). Gaps are calculated in days and presented as blocking items to the candidate. Overlapping periods are detected and reported. The system rejects submission if any gap remains unaccounted for.

The history coverage period is configurable per screening file. See Section 2 item 7 regarding the operator's responsibility for setting this value correctly.

### 1.4 Evidence upload

Four evidence categories must be uploaded by the guard before submission is accepted:

- Identity evidence (`identity`)
- Address evidence (`address`)
- SIA evidence (`sia`)
- Right-to-work evidence (`right_to_work`)

Evidence is stored as files (PDF, JPEG, or PNG; maximum 10 MiB each) in private object storage. Files are not publicly accessible; access requires a time-limited signed URL generated per-access and recorded in the audit log.

### 1.5 Admin verification checks

Before a screening can be marked VETTED, an admin user must complete all of the following. The system technically prevents `complete()` if any are incomplete:

| Check | Stored fields | Required state to complete |
|---|---|---|
| Identity verification | `identityVerification`, `identityVerificationMethod`, `identityVerifiedByUserId`, `identityVerifiedAt` | VERIFIED |
| Current address verification | `verificationState` on the current `ScreeningAddress` record | VERIFIED |
| SIA register check | `siaRegisterVerification`, `siaVerifiedByUserId`, `siaVerifiedAt` | VERIFIED |
| Right-to-work check | `rightToWorkVerification`, `rightToWorkCheckMethod`, `rightToWorkCheckDate`, `rightToWorkVerifiedByUserId`, `rightToWorkVerifiedAt` | VERIFIED |
| All evidence verified | `verificationState` on each `ScreeningEvidence` record | VERIFIED |
| Source-verified reference | `ScreeningReference.status = VERIFIED` and `sourceVerified = true` | At least one required |

The admin user must explicitly confirm independent source verification when recording a reference outcome (`confirmed: true` required in the API payload).

**Important:** The system technically enforces that all six checks above reach VERIFIED state before a screening can be marked VETTED. However, the system records what the admin user confirms, not whether the underlying check was conducted to an adequate standard. The adequacy of the method used for each check, the qualifications of the reviewer, and the sufficiency of documentary evidence are all subject to the operational responsibilities described in Section 2.

### 1.6 Screening exceptions

The application supports recording exceptions against a screening file (`ScreeningException` table: `code`, `description`, `resolved`, `resolvedByUserId`, `resolvedAt`). Unresolved exceptions block submission.

### 1.7 Audit trail

All significant screening events are written to the `audit_logs` table with `userId`, `action`, `entityType`, `entityId`, `beforeData`, and `afterData`. Events recorded include: `screening.started`, `screening.submitted`, `screening.review_started`, `screening.check_verified`, `screening.reference_verified`, `screening.vetted`, `screening.rejected`, `screening.expired`, `screening.candidate_compliance_updated`, `screening.consent_accepted`, `screening.consent_withdrawn`, `screening.evidence_accessed`, and others.

### 1.8 Retention

When a screening is marked VETTED, `retentionReviewAt` is set to 365 days from that date. The application stores this field; it does not automatically delete records or enforce a deletion process. Retention management is an operational responsibility. Operators should verify that this default retention period is consistent with their obligations under BS 7858, any applicable contractual requirements, and the UK GDPR before relying on this field.

---

## 2. What S4 does NOT technically enforce — known scope limitations

The following are **not** enforced or validated by the application code. These represent areas where the operator must apply procedural controls. The reviewer is asked to assess these limitations in Section 3.

1. **Verification method requirements.** The system records what method was used (free text: `identityVerificationMethod`, `rightToWorkCheckMethod`) but does not validate that the method meets any particular standard. The reviewer must assess whether the methods used in practice are adequate.

2. **Who may perform checks.** Any user with an `admin` role can verify any check. The system does not enforce separation of duties, seniority requirements, or training prerequisites for reviewers.

3. **Minimum number or type of references.** The system requires at least one source-verified reference. It does not enforce a minimum period covered, a required relationship type, or a required form of contact.

4. **Address verification scope.** The system verifies the current address only (`CURRENT_ADDRESS_ONLY`). Verification of historical addresses is not technically enforced.

5. **Overseas history.** Activity history entries of type `OVERSEAS` are captured but no enhanced check is technically required or enforced by the system.

6. **Document type validation.** The system accepts any PDF, JPEG, or PNG as evidence of any category. It does not validate that the specific document type presented meets any documentary requirement under BS 7858 or the SIA licensing framework.

7. **Screening period.** The `screeningPeriodYears` value defaults to 5 but is configurable per screening file. BS 7858 specifies the required history coverage period; the operator must ensure this field is set in accordance with the applicable edition of the standard and any additional contractual requirements. The operator bears responsibility for setting this correctly.

8. **Repeat / follow-up checks.** The `rightToWorkFollowUpDate` field is stored but not enforced. No automated re-screening is triggered on expiry.

9. **Retention enforcement.** `retentionReviewAt` is stored; the application does not enforce deletion after this date. See Section 1.8.

10. **Independence of the screening function.** The application does not prevent the same organisation that employs the guard from performing the screening review.

---

## 3. What the owner is asked to accept

The owner is asked to make a reasoned acceptance decision on the following questions, with reference to BS 7858 (current edition), any applicable contractual requirements, and the organisation's obligations. Independent professional advice may be obtained where the organisation considers it necessary.

**3.1** Is the guard screening workflow described in Section 1 appropriately designed as a workflow management and evidence-collection system for use alongside a BS 7858-based screening process? Does it collect and record the categories of information that a screening process conducted under BS 7858 would require to be documented?

**3.2** Are the scope limitations listed in Section 2 acknowledged? For each limitation that is material to the operator's obligations under BS 7858 or associated contractual requirements, will the operator put in place documented procedural controls to address it?

**3.3** Is the owner satisfied that, given the above, S4 v1.0.0-rc1 may be used in a pilot deployment for the purpose of managing and recording screening information, subject to any conditions noted below?

The owner is NOT being asked to certify that S4 itself satisfies BS 7858 or any other standard, that use of S4 guarantees screening compliance, or that candidates processed through S4 have been screened to any particular standard. Conformity with BS 7858 — and all legally required screening obligations — remains the responsibility of the operator, not of the S4 application or its developers. S4 is a workflow management and record-keeping tool.

---

## 4. Supporting evidence from the repository

The following artefacts, all present in the `release/v1.0.0-rc1` branch, provide supporting evidence of the implemented technical controls described in Section 1. The reviewer may refer to these to verify the factual accuracy of this document.

| Artefact | Location | Relevance |
|---|---|---|
| Screening service implementation | `security-backend-nest/src/screening/screening.service.ts` | Implements state machine, continuity check, verification gate, VETTED completion logic |
| Screening controller (API routes) | `security-backend-nest/src/screening/screening.controller.ts` | Role-controlled endpoints; admin-only transitions |
| Screening entities | `security-backend-nest/src/screening/entities/` | Database schema for all screening fields listed in Sections 1.1–1.8 |
| Evidence upload flow | `security-mobile-app/src/components/guard/GuardScreeningPanel.tsx` | Guard-facing screening workflow UI |
| Audit log service | `security-backend-nest/src/audit-log/audit-log.service.ts` | Implements the audit events described in Section 1.7 |
| UAT execution log | `docs/uat/UAT_EXECUTION_LOG.md` | Wave 2 (guard onboarding/compliance) and Wave 3 (hire) contain executed test results against the screening and compliance APIs |
| UAT defect register | `docs/uat/UAT_DEFECT_REGISTER.md` | Records all defects raised and closed during UAT |

All 45 UAT cases have been executed and returned PASS as of `38c14d4`. No open defects remain.

---

## 5. Owner Compliance Acceptance

| Field | Value |
|---|---|
| **Owner full name** | |
| **Role** | |
| **Organisation** | |
| **Basis of authority** | (e.g. Product/Business Owner, organisation Compliance Owner, named responsible person for screening processes) |
| **Edition of BS 7858 consulted** | (state the edition and year consulted when completing this review) |
| **Acceptance date** | |
| **Branch / SHA reviewed** | `release/v1.0.0-rc1` — `2f59bc7` |
| **Sections of this document reviewed** | (confirm which sections were read — at minimum, Sections 1, 2, and 3) |

### Decision

Select one:

- [ ] **ACCEPTED** — The screening workflow is appropriately designed for its stated purpose as a workflow management and evidence-collection system for use alongside a BS 7858-based screening process. The scope limitations in Section 2 are acknowledged. No conditions.
- [ ] **ACCEPTED WITH CONDITIONS** — The screening workflow is appropriately designed for its stated purpose, subject to the conditions and procedural controls listed below.
- [ ] **NOT ACCEPTED** — The screening workflow is not accepted for pilot use. Reasons are listed below.

### Conditions / Notes

_(Required if ACCEPTED WITH CONDITIONS or NOT ACCEPTED. List any gaps, required procedural controls, training requirements, or remediation items. For each scope limitation in Section 2 that is material to the operator's obligation under BS 7858 or associated contractual requirements, note how it will be addressed procedurally.)_

```
[Enter conditions and procedural controls here]
```

### Signature / Recorded Approval

By completing this record, the owner confirms that they have read Sections 1 through 3 of this document, that they have consulted or ensured consultation of the applicable edition of BS 7858, that this is their internal acceptance decision as Product/Business Owner or organisation Compliance Owner, and that they understand that conformity with BS 7858 — and all legally required screening obligations — remains the responsibility of the operator, not of the S4 application or its developers. Independent professional advice may be obtained by the organisation where considered appropriate.

```
Signature / recorded approval: ___________________________

Printed name: ___________________________

Role: ___________________________

Organisation: ___________________________

Date: ___________________________
```

_This document should be retained as part of the release evidence record for S4 v1.0.0-rc1._

---

**BLK-008 status:** OPEN — awaiting owner compliance acceptance.
Do not mark this item PASS in the UAT log until the designated Product/Business Owner or organisation Compliance Owner completes Section 5 with an ACCEPTED or ACCEPTED WITH CONDITIONS decision.
