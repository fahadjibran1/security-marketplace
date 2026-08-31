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
| **Owner full name** | Fahad Jibran |
| **Role** | Product / Business Owner |
| **Organisation** | S4 Security Platform |
| **Basis of authority** | Product/Business Owner responsible for internal release risk acceptance for S4 v1.0.0-rc1 |
| **Edition of BS 7858 consulted** | BS 7858:2019 — *Security Screening of Individuals Employed in a Security Environment — Code of Practice* (current release per BSI public information; no licensed copy held; no clause-by-clause conformity assessment performed by this review) |
| **Acceptance date** | 31 August 2026 |
| **Branch / SHA reviewed** | `release/v1.0.0-rc1` — `04a2493` |
| **Sections of this document reviewed** | Sections 1, 2, 3, and 4 |

### Decision

- [ ] **ACCEPTED** — The screening workflow is appropriately designed for its stated purpose as a workflow management and evidence-collection system for use alongside a BS 7858-based screening process. The scope limitations in Section 2 are acknowledged. No conditions.
- [x] **ACCEPTED WITH CONDITIONS** — The screening workflow is appropriately designed for its stated purpose, subject to the conditions and procedural controls listed below.
- [ ] **NOT ACCEPTED** — The screening workflow is not accepted for pilot use. Reasons are listed below.

### Conditions

**Condition 1 — General operator responsibility for controls not technically enforced by S4**
Where S4 does not technically enforce a required screening activity, the operator remains responsible for completing and evidencing that activity through the organisation's documented screening procedure. This applies across all items where S4 records data or workflow state but does not independently validate compliance with the applicable standard.

**Condition 2 — Mandatory fields (B1)**
The mandatory fields currently implemented are acceptable for the RC1 pilot. The operator remains responsible for obtaining any additional information or evidence required by the applicable screening procedure or BS 7858 that is not collected by S4.

**Condition 3 — Screening period: configurable default not standard-verified (C1, G)**
The pilot default of `screeningPeriodYears = 5` is a configurable technical default only. It has not been independently verified against BS 7858:2019 or any other edition by this review. The operator is responsible for determining the correct required screening period from the applicable current edition of BS 7858, applicable customer requirements, and organisational policy, and for configuring each screening file accordingly before use. The 5-year default must not be relied upon as verified against the standard.

**Condition 4 — Acceptable document and evidence types (D1)**
The operator must maintain a documented procedure or list of acceptable document and evidence types for each evidence category (identity, address, SIA, right-to-work). S4 accepts any PDF, JPEG, or PNG file and does not validate document type against any standard. Determination that submitted documents are acceptable is a human and procedural responsibility.

**Condition 5 — Historical address verification (E4)**
Where historical address verification is required by BS 7858 or the operator's screening procedure, and is not technically enforced by S4, the operator must complete and evidence it procedurally.

**Condition 6 — Overseas history (F1)**
Where a candidate has an overseas history period, the operator must determine and perform any appropriate additional screening checks or evidence requirements outside S4. S4's capture of `OVERSEAS` activity history type alone does not constitute completion of those checks.

**Condition 7 — Repeat screening, re-checks, and retention (H1)**
Repeat screening, re-check requirements, and retention review activities that S4 does not automate must be controlled through documented operational procedures. The operator is responsible for monitoring and acting on time-limited screening requirements.

**Condition 8 — Audit records (J1)**
S4 audit records support the screening process as a record-keeping control. They do not replace the underlying screening evidence or the human screening decision, and do not constitute conformity with BS 7858 in themselves.

**Condition 9 — Independence of the screening function (I1)**
S4 does not mandate an independent screening provider. The organisation remains responsible for determining whether independence of the screening function is required by the applicable edition of BS 7858, any accreditation scheme, customer contract, or organisational policy.

**Condition 10 — Limitations of this acceptance**
This acceptance is an internal product/process risk acceptance by the Product/Business Owner. It is NOT a clause-by-clause conformity assessment against BS 7858:2019 or any other edition. It is NOT BS 7858 certification. Controls recorded as "PENDING LICENSED STANDARD VERIFICATION" in the BS 7858 Alignment Register (`docs/security/BS7858_ALIGNMENT_REGISTER.md`) must remain identified as such. S4 must not be marketed or represented as guaranteeing BS 7858 compliance on the basis of this acceptance. A licensed-standard conformity review against a licensed copy of BS 7858:2019 remains a post-RC1 compliance action before any claim of full BS 7858 alignment or compliance is made.

### Post-RC1 compliance action (required before any claim of full BS 7858 alignment/compliance)

A licensed-standard conformity review against an authorised copy of BS 7858:2019 must be completed before S4 makes any claim of full BS 7858 alignment or compliance. The following items from the BS 7858 Alignment Register remain explicitly unverified against the licensed standard as of this acceptance:

- Configurable screening period (pilot default five years)
- Continuous employment/activity history acceptance rules
- VETTED decision criteria (mandatory-check matrix)

This post-RC1 action must be completed and recorded separately. BLK-008 owner gate is satisfied for the RC1 pilot scope only.

### Signature / Recorded Approval

By completing this record, the owner confirms that they have read Sections 1 through 4 of this document, that they have consulted or ensured consultation of the applicable edition of BS 7858 to the extent described in the acceptance table above, that this is their internal acceptance decision as Product/Business Owner, and that they understand that conformity with BS 7858 — and all legally required screening obligations — remains the responsibility of the operator, not of the S4 application or its developers. Independent professional advice may be obtained by the organisation where considered appropriate.

```
Signature / recorded approval: Electronically approved by Fahad Jibran, Product / Business Owner, on 31 August 2026.

Printed name: Fahad Jibran

Role: Product / Business Owner

Organisation: S4 Security Platform

Date: 31 August 2026
```

_This document should be retained as part of the release evidence record for S4 v1.0.0-rc1._

---

**BLK-008 status:** ACCEPTED WITH CONDITIONS — owner gate satisfied for RC1 pilot (31 August 2026).
Post-RC1 compliance action required: licensed-standard conformity review against BS 7858:2019 before any claim of full BS 7858 alignment or compliance is made.
