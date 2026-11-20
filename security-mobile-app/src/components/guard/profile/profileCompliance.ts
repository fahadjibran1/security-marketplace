import { profileDate } from './profileOverview';
import type { Tone } from './profileOverview';

/**
 * S4 Guard Profile — how the Guard's own right-to-work status is described (UX-02 Package B, owner decision R4).
 *
 * `rightToWorkStatus` is free text the Guard types in the optional S4 screening file ("Right to Work status / type"),
 * so a value such as "Psw" has no agreed full name anywhere in S4 and is never shown to the Guard as if it were a
 * status label. Instead the app says what the backend actually does with the value
 * (GuardComplianceService.assessGuardDeclarations in security-backend-nest/src/compliance/guard-compliance.service.ts):
 *
 *   - a value in RTW_NOT_VALID_STATUSES is a deployment blocker ("Right-to-work status is …");
 *   - a value in RTW_NO_EXPIRY_STATUSES needs no expiry date (requiresRightToWorkExpiry);
 *   - any other value needs an expiry date (the backend makes no further judgement about it).
 *
 * The expiry date is the Guard's own current record (getMyGuard, or the compliance summary built from the same row).
 *
 * Both lists are copied from that file, and scripts/guard-home-ux01.spec.cjs fails if they ever differ. Nothing here
 * decides eligibility: deployment still comes only from the backend's `assignable` flag and blocking reasons.
 */
export const RTW_NOT_VALID_STATUSES: readonly string[] = ['invalid', 'expired', 'revoked', 'refused', 'suspended'];
export const RTW_NO_EXPIRY_STATUSES: readonly string[] = ['permanent', 'indefinite', 'settled', 'british', 'citizen', 'no_expiry'];

export interface RightToWorkDescription {
  text: string;
  tone: Tone;
}

export function rightToWorkStatusDescription(status: string | null | undefined, expiryDate: string | null | undefined): RightToWorkDescription {
  const value = String(status ?? '').trim().toLowerCase();
  if (!value) return { text: 'Status not added yet', tone: 'warning' };
  if (RTW_NOT_VALID_STATUSES.includes(value)) return { text: 'Status recorded as not valid', tone: 'danger' };
  if (RTW_NO_EXPIRY_STATUSES.includes(value)) return { text: 'Status recorded · no expiry date needed', tone: 'neutral' };
  // Any other value (including an unrecognised code such as "Psw" or a typo) needs an expiry date. The backend does not
  // say the status IS time-limited, so neither does the app: it states only that a status is recorded and its expiry.
  return expiryDate
    ? { text: `Status recorded · expiry ${profileDate(expiryDate)}`, tone: 'neutral' }
    : { text: 'Status recorded · expiry date needed', tone: 'warning' };
}
