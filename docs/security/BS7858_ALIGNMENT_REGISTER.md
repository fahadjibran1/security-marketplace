# BS 7858 Alignment Register

Status: implementation ready for review against the organisation's licensed, current copy of BS 7858. This register does not claim certification or formal compliance.

| S4 feature | Source/control | Evidence generated | Classification | Status |
|---|---|---|---|---|
| Separate account and vetting lifecycle | SEC-015/SEC-017 server state machine | Attributable lifecycle audit events | ORGANISATIONAL POLICY | Implemented |
| Configurable screening period (pilot default five years) | `GuardScreening.screeningPeriodYears`, constrained 1–10 | Screening configuration and chronology assessment | BS 7858 CLAUSE — REQUIRES LICENSED STANDARD REVIEW | Implemented; duration/configuration requires review |
| Continuous employment/education/activity history | Normalized chronology entries and server gap/overlap assessment | Dated entries, reported gaps and overlaps | BS 7858 CLAUSE — REQUIRES LICENSED STANDARD REVIEW | Implemented; licensed-standard acceptance rules pending review |
| Identity and address history | Restricted screening profile and normalized address records | Verification state, method, actor and time | PUBLIC SIA/ACS REQUIREMENT | Implemented |
| SIA register verification | Separate reviewer-controlled check; does not imply VETTED | Verification actor/time and private evidence | PUBLIC SIA/ACS REQUIREMENT | Implemented |
| Right to Work check | Minimal method/date/follow-up metadata and private evidence | Verification actor/time | ORGANISATIONAL POLICY | Implemented; legal process review required |
| References tied to chronology | Reference-to-history foreign key and source-authenticity state | Request/receipt/verification audit trail | BS 7858 CLAUSE — REQUIRES LICENSED STANDARD REVIEW | Implemented; reference sufficiency rules pending licensed review |
| Private screening evidence | SEC-013 S3-compatible signed PUT, HEAD validation and signed GET | MIME, size, category and completion metadata; no signed URL in audit | ORGANISATIONAL POLICY | Implemented |
| Candidate consent | Versioned acceptance, candidate identity, server time, withdrawal hook | Consent record without evidence content | ORGANISATIONAL POLICY | Implemented; wording/version requires legal approval |
| Authorised review | ADMIN-only start, verify, request-information, complete and reject routes | Server-derived reviewer and timestamps | PUBLIC SIA/ACS REQUIREMENT | Implemented |
| VETTED decision | Server requires identity, address/current history, continuous chronology, verified SIA/RTW, source-verified reference, evidence, consent and resolved exceptions | `screening.vetted` audit event | BS 7858 CLAUSE — REQUIRES LICENSED STANDARD REVIEW | Implemented; mandatory-check matrix pending licensed review |
| Work eligibility | Operational compliance AND screening status VETTED | Server-side assignment/hiring denial | ORGANISATIONAL POLICY | Implemented for pilot |
| Company minimisation | Linked company receives status/outcome only | No raw evidence, reference correspondence, historic addresses or review notes | ORGANISATIONAL POLICY | Implemented |

## Restricted data and retention hooks

Screening tables are separated from the normal Guard profile. Candidate and Platform Admin are the only principals permitted to access evidence; companies receive a minimal outcome for an active `CompanyGuard` relationship. Object keys never appear in API views, access is short-lived and signed, and audit payloads contain metadata only. Review notes and reference outcome notes are excluded from default ORM selection.

`retentionReviewAt` is set when vetting completes, providing a policy-driven review/deletion hook. Automated deletion is intentionally not implemented until the controller has approved retention periods, legal holds, subject-access handling and evidence disposal procedures. Criminal-record material and unnecessary immigration data are outside the implemented model and must not be added without a separate data-protection review.

## Licensed-standard review gaps

- Validate the configured screening-period policy and chronology tolerance against the licensed current standard.
- Validate the number, coverage, provenance and exception treatment of references.
- Validate acceptable identity, address, overseas, self-employment and unexplained-period evidence.
- Validate conditional offers, provisional employment, re-screening/expiry, transfers and continuity rules.
- Validate reviewer competence, segregation of duties, quality sampling and record-retention schedules.
- Map the implementation to exact clauses only during licensed-standard review; no clause numbers are asserted here.
