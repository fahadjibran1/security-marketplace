/**
 * S4-CV-01: company verification, as both portals present it.
 *
 * The backend is authoritative (SEC-PUBLIC-03): only a Platform Admin decides, every decision is a permitted
 * transition, rejection and suspension need a reason the company is shown, and CompanyApprovalInterceptor refuses
 * what a state does not allow with 403 COMPANY_NOT_APPROVED. This module only mirrors those rules so the screens can
 * offer the right actions and words; it never grants anything.
 */

export type CompanyVerificationStatus = 'pending_verification' | 'approved' | 'rejected' | 'suspended';

export const COMPANY_VERIFICATION_STATUSES: readonly CompanyVerificationStatus[] = ['pending_verification', 'approved', 'rejected', 'suspended'];

// The 403 COMPANY_NOT_APPROVED detector and its message live in services/api.ts (no runtime import there).

/** The backend accepts at most 1000 characters for a reason or a reconsideration message. */
export const VERIFICATION_REASON_MAX = 1000;

export const VERIFICATION_STATUS_LABEL: Record<CompanyVerificationStatus, string> = {
  pending_verification: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  suspended: 'Suspended',
};

export type VerificationTone = 'info' | 'success' | 'warning' | 'danger';

export const VERIFICATION_STATUS_TONE: Record<CompanyVerificationStatus, VerificationTone> = {
  pending_verification: 'warning',
  approved: 'success',
  rejected: 'danger',
  suspended: 'danger',
};

export function isVerificationStatus(value: unknown): value is CompanyVerificationStatus {
  return typeof value === 'string' && (COMPANY_VERIFICATION_STATUSES as readonly string[]).includes(value);
}

// ─── Platform Admin ──────────────────────────────────────────────────────────

export type VerificationActionKey = 'approve' | 'reject' | 'suspend' | 'reinstate';

export interface VerificationAction {
  key: VerificationActionKey;
  target: CompanyVerificationStatus;
  label: string;
  reasonRequired: boolean;
  danger: boolean;
}

const ACTION: Record<VerificationActionKey, VerificationAction> = {
  approve: { key: 'approve', target: 'approved', label: 'Approve', reasonRequired: false, danger: false },
  reject: { key: 'reject', target: 'rejected', label: 'Reject', reasonRequired: true, danger: true },
  suspend: { key: 'suspend', target: 'suspended', label: 'Suspend', reasonRequired: true, danger: true },
  reinstate: { key: 'reinstate', target: 'approved', label: 'Reinstate', reasonRequired: false, danger: false },
};

/**
 * The actions offered for a company in a state: exactly the backend's COMPANY_VERIFICATION_TRANSITIONS, named for the
 * administrator (suspended → approved is "Reinstate"). Rejected → pending is the company's own reconsideration request,
 * so it is not offered here.
 */
export function verificationActionsFor(status: CompanyVerificationStatus | string | null | undefined): VerificationAction[] {
  switch (status) {
    case 'pending_verification': return [ACTION.approve, ACTION.reject];
    case 'approved': return [ACTION.suspend];
    case 'suspended': return [ACTION.reinstate, ACTION.reject];
    case 'rejected': return [ACTION.approve];
    default: return [];
  }
}

/** A blank or missing reason where one is required, or one that is too long; null when the reason is acceptable. */
export function verificationReasonError(action: VerificationAction, reason: string): string | null {
  const trimmed = reason.trim();
  if (action.reasonRequired && !trimmed) {
    return action.key === 'reject'
      ? 'Enter the reason for rejecting this company. The company is shown it.'
      : 'Enter the reason for suspending this company. The company is shown it.';
  }
  if (trimmed.length > VERIFICATION_REASON_MAX) return `Keep the reason under ${VERIFICATION_REASON_MAX} characters.`;
  return null;
}

/** The confirmation an administrator reads before a decision is sent. */
export function verificationConfirmation(action: VerificationAction, companyName: string): { title: string; message: string; confirmLabel: string } {
  const name = companyName || 'this company';
  switch (action.key) {
    case 'approve':
      return { title: 'Approve company?', confirmLabel: 'Approve company', message: `${name} will be able to publish jobs, invite Guards and create shifts. Its jobs become visible to Guards.` };
    case 'reinstate':
      return { title: 'Reinstate company?', confirmLabel: 'Reinstate company', message: `${name} will be able to start new work again, and its jobs and invitations return for Guards. The suspension reason is cleared from its record and kept in the audit history.` };
    case 'reject':
      return { title: 'Reject company?', confirmLabel: 'Reject company', message: `${name} will not be able to operate on S4. It is shown your reason and can correct its details and ask S4 to reconsider.` };
    case 'suspend':
      return { title: 'Suspend company?', confirmLabel: 'Suspend company', message: `${name} will not be able to start new work, and its jobs and invitations are hidden from Guards. Safety alerts, incidents and work already in place continue, so Guards stay safe and are paid. It is shown your reason.` };
  }
}

export interface AdminVerificationCompany {
  id: number;
  name: string;
  companyNumber?: string | null;
  address?: string | null;
  contactDetails?: string | null;
  verificationStatus: CompanyVerificationStatus;
  verificationNote?: string | null;
  verificationDecidedAt?: string | null;
  registeredAt?: string | null;
  owner?: { id: number; email: string; phone?: string | null } | null;
}

export type VerificationListFilter = CompanyVerificationStatus | 'all';

export const VERIFICATION_LIST_FILTERS: ReadonlyArray<{ key: VerificationListFilter; label: string }> = [
  { key: 'pending_verification', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'all', label: 'All' },
];

export function countByVerificationStatus(rows: readonly AdminVerificationCompany[]): Record<CompanyVerificationStatus, number> {
  const counts: Record<CompanyVerificationStatus, number> = { pending_verification: 0, approved: 0, rejected: 0, suspended: 0 };
  for (const row of rows) if (isVerificationStatus(row.verificationStatus)) counts[row.verificationStatus] += 1;
  return counts;
}

/**
 * Filter by state and search by name, company number, owner email, address or id. Pending companies are listed
 * oldest registration first (the queue to work through); every other list is newest decision first.
 */
export function filterVerificationCompanies(rows: readonly AdminVerificationCompany[], filter: VerificationListFilter, query: string): AdminVerificationCompany[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = rows.filter((row) => (filter === 'all' || row.verificationStatus === filter)
    && (!needle || [row.id, row.name, row.companyNumber, row.owner?.email, row.address, row.contactDetails]
      .some((value) => String(value ?? '').toLocaleLowerCase().includes(needle))));
  const time = (value?: string | null) => (value ? Date.parse(value) || 0 : 0);
  return [...matches].sort((a, b) => (filter === 'pending_verification'
    ? time(a.registeredAt) - time(b.registeredAt) || a.id - b.id
    : time(b.verificationDecidedAt) - time(a.verificationDecidedAt) || b.id - a.id));
}

export interface VerificationHistoryEntry {
  id: number;
  action: 'company.verification_changed' | 'company.verification_reconsideration_requested' | string;
  at: string;
  actor: { id: number; email: string; role: string } | null;
  fromStatus: CompanyVerificationStatus | null;
  toStatus: CompanyVerificationStatus | null;
  note: string | null;
}

/** One line of the verification history in plain words. */
export function verificationHistoryTitle(entry: VerificationHistoryEntry): string {
  if (entry.action === 'company.verification_reconsideration_requested') return 'Company asked S4 to reconsider';
  const to = entry.toStatus;
  if (to === 'approved') return entry.fromStatus === 'suspended' ? 'Reinstated' : 'Approved';
  if (to === 'rejected') return 'Rejected';
  if (to === 'suspended') return 'Suspended';
  if (to === 'pending_verification') return 'Returned to pending';
  return 'Verification changed';
}

/** Turns the backend's decision errors into what the administrator should do next. */
export function verificationDecisionError(status: number | undefined, code: string | undefined, fallback: string): string {
  if (code === 'COMPANY_VERIFICATION_CHANGED') return 'This company\'s verification changed while you were deciding. The list has been reloaded; check it and decide again.';
  if (code === 'COMPANY_VERIFICATION_TRANSITION_NOT_ALLOWED') return 'That decision is not available for this company\'s current state. The list has been reloaded.';
  if (code === 'COMPANY_VERIFICATION_REASON_REQUIRED') return 'A reason is required to reject or suspend a company.';
  if (status === 403) return 'Only an S4 Platform Admin can decide company verification.';
  if (status === 404) return 'This company no longer exists.';
  return fallback;
}

// ─── Company portal ──────────────────────────────────────────────────────────

export interface CompanyVerificationBannerModel {
  tone: VerificationTone;
  title: string;
  body: string;
  /** What the company can still do, and what it cannot yet. */
  points: string[];
  reason: string | null;
  /** Rejected, and the signed-in user may manage the company: may correct details and ask S4 to reconsider. */
  canRequestReconsideration: boolean;
  /** Pending or rejected, and the user may manage the company: registration details may be corrected. */
  canCorrectDetails: boolean;
  supportGuidance: string | null;
}

/** null when the company is approved (no banner) or its state is unknown. */
export function companyVerificationBanner(
  status: CompanyVerificationStatus | string | null | undefined,
  note: string | null | undefined,
  canManageCompany: boolean,
): CompanyVerificationBannerModel | null {
  const reason = typeof note === 'string' && note.trim() ? note.trim() : null;
  switch (status) {
    case 'pending_verification':
      return {
        tone: 'warning',
        title: 'Your company is awaiting verification by S4',
        body: 'S4 checks every new company before it can work with Guards. This usually needs no action from you.',
        points: [
          'You can set up now: clients, sites, pricing, pay rules and your team\'s settings.',
          'Publishing jobs, inviting Guards and creating shifts become available once S4 approves your company.',
          'Safety alerts and incidents are never blocked.',
        ],
        reason: null,
        canRequestReconsideration: false,
        canCorrectDetails: canManageCompany,
        supportGuidance: canManageCompany ? 'Make sure your registered company name, number, address and contact details are correct: S4 verifies them.' : 'Your company owner or admin can check the registration details S4 verifies.',
      };
    case 'rejected':
      return {
        tone: 'danger',
        title: 'S4 did not approve your company',
        body: 'Your company cannot publish jobs, invite Guards, create shifts or set up new work.',
        points: canManageCompany
          ? ['Correct your registration details below, then ask S4 to reconsider. Your company returns to pending while S4 checks again.']
          : ['Your company owner or admin can correct the registration details and ask S4 to reconsider.'],
        reason,
        canRequestReconsideration: canManageCompany,
        canCorrectDetails: canManageCompany,
        supportGuidance: 'If you think this is a mistake, contact S4 support.',
      };
    case 'suspended':
      return {
        tone: 'danger',
        title: 'Your company has been suspended by S4',
        body: 'You cannot start new work: publishing jobs, inviting Guards, creating shifts and new set-up are unavailable.',
        points: [
          'Safety alerts, incidents and patrol exceptions continue to work. Keep responding to them.',
          'Work already in place continues: attendance, timesheets, approvals, invoicing and payroll for time worked, and changes or cancellations to existing shifts.',
        ],
        reason,
        canRequestReconsideration: false,
        canCorrectDetails: false,
        supportGuidance: 'Only S4 can lift a suspension. Contact S4 support to discuss it.',
      };
    default:
      return null;
  }
}
