# S4 retention decision register — unresolved

**Status:** OPEN. No retention period below has been decided, and none may be invented. Every row is
**LEGAL/OWNER DECISION REQUIRED**.

Until a decision is recorded, Gate 2 account deletion **preserves** every category here (it anonymises the
account in place and deletes no operational record). The deletion audit entry lists these categories as
`retainedRecordCategories` so the retention is explicit, not accidental.

| Record | Why it exists | Risk of deleting too early | Risk of keeping indefinitely | Considerations that may apply |
|---|---|---|---|---|
| **SIA licence number** (guard profile; screening) | Proves the Guard was licensed for the work; uniqueness prevents duplicate identities | Cannot later show a deployed Guard was licensed; weakens defence of a licensing complaint or SIA inspection | Long-term holding of an identifier tied to a regulated status after the relationship ends | Regulatory (SIA / Private Security Industry Act 2001 licensing evidence), contractual (client requirements), evidential |
| **GPS / location** (attendance Book On/Off coordinates, accuracy, distance) | Verifies the Guard was at site when booking on/off | Loses proof of attendance for disputed shifts, pay or incidents | Location history of individuals is sensitive and intrusive; data-minimisation risk | Evidential (pay disputes, incidents, claims), contractual (client SLAs), employment |
| **Screening documents & evidence** (BS 7858 workflow, ID, address history, references, consents, compliance documents) | Pre-employment screening and right-to-work checks | Cannot evidence that screening/right-to-work checks were done | Holding identity documents and references far beyond need; potential criminal-offence data | Legal (right-to-work record-keeping), standard-based (BS 7858 record keeping), regulatory, contractual |
| **Attendance** (Book On/Off events) | Basis for verified hours, live operations and evidence of presence | Payroll and client billing can no longer be substantiated | Detailed work-pattern history of individuals | Employment / working-time, payroll, contractual, evidential |
| **Timesheets** (and payroll/invoice snapshots) | Hours worked, approved, paid and billed | Cannot answer pay, tax or billing queries | Financial personal data held beyond need | Tax/accounting record-keeping, employment, contractual |
| **Welfare Checks** (submissions and missed-window evidence) | Duty-of-care record for lone and remote workers | Cannot show welfare duties were (or were not) met after an incident | Free text may contain health information | Health & safety, evidential (incident/insurance), contractual |
| **Log Book / Daily Site Log** | The site occurrence record clients and companies rely on | Destroys the evidential record of what happened on site | Free text about third parties (visitors, members of the public) kept forever | Contractual (client reporting), evidential, insurance |
| **Incidents** (reports, resolution reason/note) | Incident record and its resolution | Loses evidence for claims, police or insurance enquiries | Third-party personal data and potentially special-category data | Evidential, insurance, legal claims limitation, health & safety (possibly RIDDOR) |
| **Safety alerts** (emergency, Site Requests, missed Welfare, missing Book Off) | Proof that alerts were raised, seen and handled | Cannot show response to an emergency | Persistent record of individuals' emergencies | Health & safety, evidential, contractual |
| **Audit logs** | Security and accountability: who did what, when, with before/after data | Cannot investigate misuse, disputes or a breach | Audit entries contain personal data (and for some actions, email addresses) indefinitely | Security, regulatory accountability, evidential |

## Related items also preserved pending a decision

- Guard **full name** on operational records (it attributes the evidence above).
- Guard personnel records held for the employing company: employment, payroll, bank details, emergency
  contact (a third party), driving/transport details, National Insurance number and UTR (encrypted).
- Company relationships and company memberships.
- Client-portal user accounts (a separate principal — not deletable through the S4 account deletion path).

## What a decision needs to state, per row

Retention period and trigger (e.g. end of engagement, end of tax year, incident closure); who decides
(S4 or the security company as controller); deletion vs anonymisation at expiry; legal-hold override;
and who executes it. Implementation follows only once decided — Gate 2 built no general retention engine.
