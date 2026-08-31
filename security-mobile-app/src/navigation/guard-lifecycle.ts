import type { GuardComplianceSummary, GuardProfile } from '../types/models';

const NO_EXPIRY_RTW = ['permanent', 'indefinite', 'settled', 'british', 'citizen', 'no_expiry'];

export function isGuardProfileComplete(guard?: Partial<GuardProfile> | null): boolean {
  if (!guard?.fullName?.trim() || !guard.phone?.trim() || !(guard.siaLicenseNumber || guard.siaLicenceNumber)?.trim()) return false;
  if (!guard.siaExpiryDate) return false;
  const rightToWork = guard.rightToWorkStatus?.trim().toLocaleLowerCase();
  if (!rightToWork) return false;
  return NO_EXPIRY_RTW.includes(rightToWork) || Boolean(guard.rightToWorkExpiryDate);
}

export function getGuardVettingLabel(summary?: GuardComplianceSummary | null): string {
  if (!summary) return 'Not started';
  if (summary.complianceStatus === 'valid') return 'Vetted';
  if (summary.complianceStatus === 'expiring') return 'Vetted — expires soon';
  if (summary.complianceStatus === 'expired') return 'Expired';
  const required = new Set(['sia_licence', 'right_to_work']);
  const completed = summary.documents.filter((document) => document.uploadCompletedAt && required.has(String(document.type)));
  const verified = completed.filter((document) => document.verified);
  if (!completed.length && !summary.siaExpiryDate && !summary.rightToWorkStatus) return 'Not started';
  if (required.size === new Set(completed.map((document) => String(document.type))).size && verified.length < required.size) return 'Ready for review';
  if (verified.length && summary.blockingReasons.length) return 'Requires attention';
  return 'In progress';
}

export function getGuardWorkEligibilityLabel(summary?: GuardComplianceSummary | null): string {
  return summary?.assignable ? 'Eligible' : 'Not eligible';
}
