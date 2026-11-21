/**
 * SEC-PUBLIC-03: the S4 company verification lifecycle.
 *
 * Self-registered companies start PENDING_VERIFICATION. Only an S4 platform administrator moves a company between
 * states (PUT /admin/companies/:companyId/verification, audited). Only an APPROVED company may perform operational
 * actions (CompanyApprovalInterceptor) or be discovered by Guards (job discovery, invitations, applications).
 *
 *   pending_verification ──approve──▶ approved ──suspend──▶ suspended ──approve──▶ approved
 *            │                                                  │
 *            └──reject──▶ rejected ──reopen──▶ pending_verification   └──reject──▶ rejected
 *
 * Kept apart from the legacy `companies.status` column (onboarding / active / inactive / suspended), which nothing
 * reads and whose production values are not known; Migration 76 does not touch it.
 */
export enum CompanyVerificationStatus {
  PENDING_VERIFICATION = 'pending_verification',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended',
}

export const COMPANY_VERIFICATION_STATUSES = Object.values(CompanyVerificationStatus);

/** The transitions an administrator may make. Anything else is refused (409), so a decision is never silently undone. */
export const COMPANY_VERIFICATION_TRANSITIONS: Readonly<Record<CompanyVerificationStatus, readonly CompanyVerificationStatus[]>> = {
  [CompanyVerificationStatus.PENDING_VERIFICATION]: [CompanyVerificationStatus.APPROVED, CompanyVerificationStatus.REJECTED],
  [CompanyVerificationStatus.APPROVED]: [CompanyVerificationStatus.SUSPENDED],
  [CompanyVerificationStatus.SUSPENDED]: [CompanyVerificationStatus.APPROVED, CompanyVerificationStatus.REJECTED],
  [CompanyVerificationStatus.REJECTED]: [CompanyVerificationStatus.PENDING_VERIFICATION, CompanyVerificationStatus.APPROVED],
};

/** A rejection or suspension must tell the company why (shown to it as `verificationNote`). */
export const COMPANY_VERIFICATION_REASON_REQUIRED: readonly CompanyVerificationStatus[] = [
  CompanyVerificationStatus.REJECTED,
  CompanyVerificationStatus.SUSPENDED,
];

export function isCompanyApproved(company: { verificationStatus?: CompanyVerificationStatus | string | null } | null | undefined): boolean {
  return company?.verificationStatus === CompanyVerificationStatus.APPROVED;
}

/** The error code every refusal carries, so the apps can show the verification state instead of a generic error. */
export const COMPANY_NOT_APPROVED_CODE = 'COMPANY_NOT_APPROVED';
