import type { GuardComplianceSummary } from '../compliance/guard-compliance.service';
import type { ComplianceLapseCategory, ComplianceLapseReason } from './entities/safety-alert.entity';

/**
 * How long after a shift's scheduled END an in_progress shift is still watched for compliance lapses.
 *
 * The same twelve hours as Book On's stale boundary (STALE_BOOK_ON_GRACE_HOURS). Past it, a shift that
 * was never booked off is an abandoned record already covered by its Missing Book Off alert, not a Guard
 * at work: raising a compliance alert on it would page the company about someone who went home days ago.
 */
export const COMPLIANCE_LAPSE_MONITOR_HOURS_AFTER_END = 12;

export type ComplianceLapse = {
  category: ComplianceLapseCategory;
  reason: ComplianceLapseReason;
  /** The company check that lapsed; null when there is no current check at all. */
  checkId: number | null;
  /** The lapsed check's expiry (YYYY-MM-DD), when the reason is expiry. */
  expiryDate: string | null;
  /** category:checkId|none:reason. One alert per key per shift, ever. */
  key: string;
};

const REQUIREMENT_KEYS: Array<{ key: string; category: ComplianceLapseCategory }> = [
  { key: 'sia_check', category: 'sia' },
  { key: 'right_to_work_check', category: 'right_to_work' },
];

const LAPSED_STATES: Record<string, ComplianceLapseReason> = {
  expired: 'expired',
  not_confirmed: 'not_confirmed',
  missing: 'missing',
};

/**
 * The lapses in ONE company's assessment of ONE Guard.
 *
 * Read straight from the authoritative assessment (GuardComplianceService.getGuardSummary with a
 * companyId) — its requirement states — so this cannot disagree with the assignment and Book On gates.
 * 'met' and 'expiring' are not lapses. A continuous right to work is 'met' for as long as it is
 * confirmed, so it can only lapse by being re-recorded as not confirmed.
 */
export function complianceLapsesFrom(summary: Pick<GuardComplianceSummary, 'requirements' | 'companyChecks'>): ComplianceLapse[] {
  if (!summary.companyChecks) return [];
  const lapses: ComplianceLapse[] = [];
  for (const { key, category } of REQUIREMENT_KEYS) {
    const requirement = summary.requirements.find((item) => item.key === key);
    const reason = requirement ? LAPSED_STATES[requirement.state] : undefined;
    if (!reason) continue;
    const check = category === 'sia' ? summary.companyChecks.sia : summary.companyChecks.rightToWork;
    const checkId = check?.id ?? null;
    lapses.push({
      category,
      reason,
      checkId,
      expiryDate: reason === 'expired' ? check?.expiryDate ?? null : null,
      key: `${category}:${checkId ?? 'none'}:${reason}`,
    });
  }
  return lapses;
}

const CATEGORY_LABELS: Record<ComplianceLapseCategory, string> = { sia: 'SIA licence', right_to_work: 'Right to work' };

const ukDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * What lapsed, in plain words. Deliberately generic: no method, excuse type, permission category,
 * document, reference or other immigration detail — this text goes into an operational queue.
 */
export function describeLapse(lapse: Pick<ComplianceLapse, 'category' | 'reason' | 'expiryDate'>): string {
  const label = CATEGORY_LABELS[lapse.category];
  if (lapse.reason === 'expired') return `${label} check expired${lapse.expiryDate ? ` on ${ukDate(lapse.expiryDate)}` : ''}`;
  if (lapse.reason === 'not_confirmed') return `${label} check recorded as not confirmed`;
  return `No current ${label.toLowerCase()} check recorded by the company`;
}

/** The alert as raised. The Live Operations item, so it says what to do and what S4 did not do. */
export function lapseAlertMessage(lapse: Pick<ComplianceLapse, 'category' | 'reason' | 'expiryDate'>): string {
  return `Urgent compliance review required: ${describeLapse(lapse)} while the Guard is on shift. ` +
    'S4 has not ended the shift and Book Off remains available. Decide the operational response.';
}
