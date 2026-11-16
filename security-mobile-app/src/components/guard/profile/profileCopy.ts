/**
 * S4 Guard Profile — the wording the Guard reads about S4 screening, requirement levels and who can see their
 * personal information (Profile Phase 2A / 2B).
 *
 * Every sentence here is a factual claim about the system, so it lives in one table that a spec checks against the
 * backend source in this repository (scripts/guard-profile-foundations.spec.cjs):
 *
 *   - S4 screening is optional. The deployment gate (ComplianceService.assertGuardAssignable) deliberately does not
 *     consult screening, so nothing here may say that screening is needed to register, use the marketplace, apply,
 *     be employed or be deployed. Deployment depends on each company's own compliance checks, which the app shows
 *     from the backend's `assignable` status.
 *   - The privacy notes describe exactly who the backend lets read each kind of personal information, including
 *     platform administrators and whether a read or reveal is audited. They must never say "only you" where an
 *     administrator or a company can also see the value.
 *
 * Pure: no React, no API. Changing a sentence here changes what the Guard is told, so change it only together with
 * the backend behaviour it describes.
 */

// ─────────────────────────────── S4 screening ───────────────────────────────

export const SCREENING_COPY = {
  /** Eyebrow on the Profile screening summary. */
  eyebrow: 'OPTIONAL S4 SCREENING',
  /** Accessible name of the summary card. */
  summaryAccessibilityLabel: 'Your optional S4 screening summary',
  /** The one-line statement of what S4 screening is and is not. */
  optionalStatement:
    'S4 screening is optional. You do not need it to use S4, apply for work or be employed by a company on S4.',
  /** How screening relates to the checks that decide deployment. */
  separateFromCompanyChecks:
    'It is separate from the checks a company makes before deploying you. Your deployment status is shown in your Compliance summary.',
  /** Shown under the summary progress. */
  marketplaceAccess: 'Marketplace access: Available',
  /** Replaces the old screening-derived "Work eligibility" line. */
  deploymentLine: 'Deployment: decided by each company’s own checks, not by S4 screening',
  /** What completing screening can offer, without implying it is needed. */
  benefit: 'Completing it lets companies you work with see that S4 has screened you.',
  /** Title of the screening journey before it has been started. */
  journeyStartTitle: 'Optional S4 screening',
  /** Body of the screening journey before it has been started. */
  journeyStartBody:
    'Your account is active. You can browse and apply for jobs now. S4 screening is optional and is separate from the checks a company makes before deploying you. Complete it at your own pace if you choose to.',
  /** Shown in the journey once a file exists and is complete. */
  vettedLine: 'S4 screening complete. Each company still makes its own deployment checks.',
} as const;

/**
 * Phrases that would tell a Guard screening is required. The spec scans every Guard-facing and company-facing mobile
 * source for them.
 */
export const MANDATORY_SCREENING_PATTERNS: readonly RegExp[] = [
  /complete (your )?screening to (become|be) eligible/i,
  /require[sd]? completed screening/i,
  /must complete screening/i,
  /screening is (required|mandatory)/i,
  /(hiring|assignment|deployment|employment) requires? (completed )?screening/i,
];

// ─────────────────────────────── Compliance (deployment) ───────────────────────────────

export const COMPLIANCE_COPY = {
  /** The row that used to be called "Vetting": the company compliance file, not S4 screening. */
  checksLabel: 'Compliance checks',
  /** Under the compliance status hero. */
  deploymentNote: 'This is your deployment status from compliance checks. It does not depend on S4 screening.',
  /**
   * SIA & compliance section: how a Guard updates their SIA licence or right to work today. The only Guard-side write
   * for those fields is PUT /screening/mine/compliance (ScreeningService.updateCandidateCompliance, which refuses with
   * "Start screening first."): PATCH /guards/me accepts only name, phone and location sharing. So the action is shown
   * for what it is — an update made in the optional S4 screening file — never as a plain "Manage compliance".
   */
  updateTitle: 'Updating your SIA licence or right to work',
  updateBody:
    'S4 does not yet have a separate form for these details. For now you can update them only in your optional S4 screening file. Opening it does not make screening required.',
  updateUnderReview: 'If your screening file is being reviewed, a change is accepted only when the reviewer asks for it.',
  companyChecks: 'Each company you work for may also record its own SIA and right-to-work checks.',
  updateAction: 'Update in S4 screening file',
  updateActionAccessibilityLabel: 'Update your SIA licence or right to work in your optional S4 screening file',
} as const;

/**
 * The compliance panel's check label, worded so it cannot be mistaken for S4 screening's "Vetted". The input is
 * exactly what getGuardVettingLabel (navigation/guard-lifecycle.ts) returns; that function is unchanged.
 */
export function complianceChecksDisplayLabel(label: string): string {
  if (label === 'Vetted') return 'Complete';
  // "Expiring" so StatusBadge's inferred tone is a warning, never the success green of "Complete".
  if (label === 'Vetted — expires soon') return 'Expiring soon';
  return label;
}

// ─────────────────────────────── Requirement levels ───────────────────────────────

export type ProfileRequirement = 'required' | 'company' | 'optional' | 'setByCompany' | 'invitation';

export const REQUIREMENT_LABELS: Record<ProfileRequirement, { label: string; description: string }> = {
  required: { label: 'Required', description: 'Needed for your S4 account.' },
  company: {
    label: 'May be requested by company',
    description: 'A company you work for may ask you for this, for example for payroll or deployment checks.',
  },
  optional: { label: 'Optional', description: 'Add it only if you want to.' },
  setByCompany: { label: 'Set by company', description: 'Your company keeps this up to date. Contact them if it is wrong.' },
  invitation: { label: 'By invitation', description: 'A company adds you by sending an invitation. You choose whether to accept it.' },
};

// ─────────────────────────────── Who can see what ───────────────────────────────

export type PrivacyTopic = 'taxIdentifiers' | 'drivingLicence' | 'emergencyContact' | 'bankDetails';

/** Who can read a kind of personal information, as the backend enforces it. */
export interface PrivacyAccess {
  /** The Guard can see the full value in the app. */
  guardSeesFull: boolean;
  /** Stored encrypted at rest. */
  encryptedAtRest: boolean;
  /** What a company with an ACTIVE relationship can read. */
  company: 'none' | 'notNumber' | 'full' | 'masked';
  /** Which company members (membership roles), when company access is not 'none'. */
  companyRoles: readonly ('OWNER' | 'ADMIN' | 'FINANCE')[];
  /** The company view needs an ACTIVE company–guard relationship. */
  companyNeedsActiveRelationship: boolean;
  /** A company read is written to the audit log. */
  companyReadAudited: boolean;
  /** What an S4 platform administrator can do. */
  platformAdmin: 'reveal' | 'view' | 'masked';
  /** A platform administrator's reveal or view is written to the audit log. */
  platformAdminAudited: boolean;
  /** The Guard's own reveal is written to the audit log. */
  guardRevealAudited: boolean;
  /** The note shown under the Profile card. */
  note: string;
}

export const PRIVACY_COPY: Record<PrivacyTopic, PrivacyAccess> = {
  taxIdentifiers: {
    guardSeesFull: true,
    encryptedAtRest: true,
    company: 'none',
    companyRoles: [],
    companyNeedsActiveRelationship: false,
    companyReadAudited: false,
    platformAdmin: 'reveal',
    platformAdminAudited: true,
    guardRevealAudited: true,
    note:
      'Your NINO and UTR are encrypted at rest. Companies cannot see them. Authorised S4 platform administrators can reveal them, and every reveal, including yours, is recorded in the audit log.',
  },
  drivingLicence: {
    guardSeesFull: true,
    encryptedAtRest: true,
    company: 'notNumber',
    companyRoles: ['OWNER'],
    companyNeedsActiveRelationship: true,
    companyReadAudited: false,
    platformAdmin: 'reveal',
    platformAdminAudited: true,
    guardRevealAudited: true,
    note:
      'Your licence number is encrypted at rest and is never shown to companies. The owner of a company you currently work for can see your licence status, categories, expiry date and travel preferences. Authorised S4 platform administrators can reveal the licence number, and every reveal is recorded in the audit log.',
  },
  emergencyContact: {
    guardSeesFull: true,
    encryptedAtRest: true,
    company: 'full',
    companyRoles: ['OWNER'],
    companyNeedsActiveRelationship: true,
    companyReadAudited: true,
    platformAdmin: 'view',
    platformAdminAudited: true,
    guardRevealAudited: false,
    note:
      'Contact name and phone numbers are encrypted at rest. The owner of a company you currently work for can see them in full, and authorised S4 platform administrators can too. Every time a company or administrator views them, it is recorded in the audit log.',
  },
  bankDetails: {
    guardSeesFull: true,
    encryptedAtRest: true,
    company: 'masked',
    companyRoles: ['OWNER', 'ADMIN', 'FINANCE'],
    companyNeedsActiveRelationship: true,
    companyReadAudited: false,
    platformAdmin: 'masked',
    platformAdminAudited: false,
    guardRevealAudited: true,
    note:
      'Bank details are encrypted at rest and only you can see them in full. The owner, administrators and finance staff of a company you currently work for, which holds your employment record, see only a masked sort code and account number (the last digits). Companies never see the account holder name. S4 platform administrators see masked details only.',
  },
};

/** Short "who can see this" summary for a future section footer, derived from the table so it cannot drift. */
export function privacySummary(topic: PrivacyTopic): string {
  const access = PRIVACY_COPY[topic];
  const company =
    access.company === 'none'
      ? 'Companies: no access'
      : access.company === 'masked'
        ? 'Companies: masked only'
        : access.company === 'notNumber'
          ? 'Companies: not the licence number'
          : 'Companies: company owner';
  const admin =
    access.platformAdmin === 'masked'
      ? 'S4 administrators: masked only'
      : `S4 administrators: can ${access.platformAdmin}${access.platformAdminAudited ? ' (audited)' : ''}`;
  return `${company} · ${admin}`;
}
