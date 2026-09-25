import type { StatusTone } from '../StatusBadge';
import type { CompanyGuardRelationshipType } from '../../types/models';

/**
 * Two independent facts about a guard, deliberately never merged into one label.
 *
 *   1. What S4 has screened  — answered only by the screening record.
 *   2. Who vouches for them  — answered by the workforce relationship.
 *
 * A guard can be both S4 Screened and in a company's workforce; those are different parties making
 * different statements. Collapsing them into a single status is exactly how a company would come to
 * believe S4 had checked someone it has never looked at.
 */

export type S4ScreeningLabel = 'S4 Screened' | 'S4 Screening in Progress' | 'Not S4 Screened';

export type S4ScreeningPresentation = {
  label: S4ScreeningLabel;
  tone: StatusTone;
  /** Shown where there is room for a sentence; omitted in dense table rows. */
  detail: string;
};

const IN_PROGRESS_STATUSES = new Set([
  'IN_PROGRESS',
  'READY_FOR_REVIEW',
  'UNDER_REVIEW',
  'REQUIRES_ATTENTION',
]);

/**
 * `status` is the raw screening status from GET /screening/company/outcomes, or undefined when the
 * company has no outcome row for this guard at all.
 *
 * "Not S4 Screened" is presented as neutral, never as a warning or an error: a company that vets its
 * own guards has not failed anything by declining to buy the S4 screening service.
 */
export function s4ScreeningPresentation(status?: string | null): S4ScreeningPresentation {
  const normalised = (status || '').trim().toUpperCase();

  if (normalised === 'VETTED') {
    return {
      label: 'S4 Screened',
      tone: 'success',
      detail: 'S4 has completed its screening process for this guard.',
    };
  }

  if (IN_PROGRESS_STATUSES.has(normalised)) {
    return {
      label: 'S4 Screening in Progress',
      tone: 'info',
      detail: 'S4 screening has started and is not yet complete.',
    };
  }

  // No record, NOT_STARTED, REJECTED and EXPIRED all reduce to the same honest statement: S4 has not
  // completed screening. The reason is S4's own business and is not a company-facing judgement.
  return {
    label: 'Not S4 Screened',
    tone: 'neutral',
    detail: 'S4 has not screened this guard. Your company manages its own compliance.',
  };
}

/** True when the company carries responsibility because S4 has not screened this guard. */
export function isCompanyManaged(relationshipActive: boolean, screeningStatus?: string | null): boolean {
  return relationshipActive && s4ScreeningPresentation(screeningStatus).label !== 'S4 Screened';
}

export const COMPANY_MANAGED_LABEL = 'Company Managed';
export const COMPANY_MANAGED_DETAIL =
  'S4 has not screened this guard. Your company manages its own compliance.';

const RELATIONSHIP_LABELS: Record<CompanyGuardRelationshipType, string> = {
  EMPLOYEE: 'Employee',
  PREFERRED: 'Preferred',
  APPROVED_CONTRACTOR: 'Approved Contractor',
};

export function relationshipTypeLabel(value?: string | null): string {
  if (!value) return 'Approved Contractor';
  return RELATIONSHIP_LABELS[value as CompanyGuardRelationshipType] ?? value;
}

export const RELATIONSHIP_TYPE_OPTIONS: Array<{ value: CompanyGuardRelationshipType; label: string }> = [
  { value: 'EMPLOYEE', label: 'Employee' },
  { value: 'PREFERRED', label: 'Preferred' },
  { value: 'APPROVED_CONTRACTOR', label: 'Approved Contractor' },
];

// ─── Invitation presentation ──────────────────────────────────────────────────

export type InvitationStateLabel = 'Pending' | 'Accepted' | 'Declined' | 'Revoked' | 'Expired';

export function invitationStatePresentation(state: string): { label: InvitationStateLabel; tone: StatusTone } {
  switch (state) {
    case 'ACCEPTED':
      return { label: 'Accepted', tone: 'success' };
    case 'DECLINED':
      return { label: 'Declined', tone: 'neutral' };
    case 'REVOKED':
      return { label: 'Revoked', tone: 'neutral' };
    case 'EXPIRED':
      return { label: 'Expired', tone: 'neutral' };
    default:
      return { label: 'Pending', tone: 'pending' };
  }
}

/** Shows enough of a target licence to recognise it, without reprinting the whole number. */
export function maskSiaLicence(value?: string | null): string | null {
  const digits = (value || '').trim();
  if (!digits) return null;
  if (digits.length <= 4) return digits;
  return `••••••••••••${digits.slice(-4)}`;
}

// ─── Error mapping ────────────────────────────────────────────────────────────

/**
 * One message for every way a code can fail, matching the backend's deliberately uniform response:
 * unknown, malformed, expired, used, declined, revoked, or issued to a different licence.
 */
export const INVALID_CODE_MESSAGE = 'This invitation code is not valid.';
export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';
export const BLOCKED_RELATIONSHIP_MESSAGE =
  'This company relationship cannot be activated. Please contact the company.';

/**
 * Turns a thrown API error into something a person can act on. Raw server payloads are never shown:
 * they leak framework detail and, for a bearer-secret endpoint, would undo the uniform failure.
 */
export function invitationErrorMessage(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  const raw = (error as { message?: string } | null)?.message ?? '';

  // The backend answers 403 only for a relationship the company has blocked.
  if (status === 403 || /blocked/i.test(raw)) return BLOCKED_RELATIONSHIP_MESSAGE;
  if (status === 404 || status === 400) return INVALID_CODE_MESSAGE;
  return GENERIC_ERROR_MESSAGE;
}
