/**
 * Replace Guard — the one copy of the client-side guidance, shared by both company entry points (the Shift Offers
 * drawer and the Rota Planner's Guard positions).
 *
 * The SERVER decides (security-backend-nest/src/shift/replace-guard-policy.ts and ShiftService.replaceGuard). This
 * module only explains, before the user tries, why the server would refuse — so an unavailable Replace Guard is shown
 * disabled with a specific reason instead of silently disappearing. When the client cannot know something (a hire link
 * on a shift it has no payload for, the replacement's eligibility or fatigue), it says nothing and the server's
 * refusal message is shown instead.
 *
 * Pure: no React, no clock of its own (the caller passes `nowMs`), so it is executed directly by
 * scripts/replace-guard-ui.spec.cjs.
 */

export type ReplaceGuardReasonCategory = 'operational_change' | 'cover_rearranged' | 'schedule_change';

export type ReplaceGuardInput = {
  replacementGuardId: number;
  reasonCategory: ReplaceGuardReasonCategory;
  reason: string;
  noShow?: boolean;
  fatigueAcknowledged?: boolean;
};

/** One of the company's active Guards, offered as a replacement. The server re-checks eligibility. */
export type ReplacementGuardOption = { id: number; name: string };

/** The neutral reasons the outgoing Guard may be shown (the server holds the same fixed set). */
export const REPLACE_GUARD_REASON_CATEGORIES: ReadonlyArray<{ key: ReplaceGuardReasonCategory; label: string }> = [
  { key: 'operational_change', label: 'Operational change' },
  { key: 'cover_rearranged', label: 'Cover rearranged' },
  { key: 'schedule_change', label: 'Schedule change' },
];

/** Mirrors the backend's NO_SHOW_GRACE_MINUTES (= MISSED_SHIFT_GRACE_MINUTES in shift-edit-policy.ts). */
export const REPLACE_GUARD_NO_SHOW_GRACE_MINUTES = 15;

/** The refusal after which the form asks for an explicit fatigue acknowledgement and lets the user send again. */
export const REPLACE_GUARD_FATIGUE_ACK_CODE = 'REPLACE_GUARD_FATIGUE_ACKNOWLEDGEMENT_REQUIRED';

/** Statuses the server can replace a Guard on (REPLACEABLE_STATUSES). */
const REPLACEABLE = new Set(['offered', 'ready']);

export type ReplaceGuardUnavailableKey =
  | 'no_guard'
  | 'booked_on'
  | 'completed'
  | 'ended'
  | 'cancelled'
  | 'declined'
  | 'missed'
  | 'not_replaceable'
  | 'hire_linked'
  | 'no_show_grace'
  | 'no_candidates';

export const REPLACE_GUARD_UNAVAILABLE_REASONS: Record<ReplaceGuardUnavailableKey, string> = {
  no_guard: 'No Guard to replace — assign this position instead',
  booked_on: 'Booked On — use Book Off or Close without Book Off, then create a new shift',
  completed: 'Completed — a finished shift keeps its Guard',
  ended: 'This shift has ended — its Guard can no longer be replaced',
  cancelled: 'Cancelled — there is no shift to replace a Guard on',
  declined: 'Declined — assign another Guard to this position instead',
  missed: 'Marked missed — plan cover with a new shift instead',
  not_replaceable: 'Only an offered or accepted shift can have its Guard replaced',
  hire_linked: "Marketplace hire shifts can't be replaced yet",
  no_show_grace: `Wait until ${REPLACE_GUARD_NO_SHOW_GRACE_MINUTES} minutes after the start to replace as a no-show`,
  no_candidates: 'No other active Guards in your company',
};

export type ReplaceGuardAvailability =
  | { available: true; noShow: boolean }
  | { available: false; key: ReplaceGuardUnavailableKey; reason: string };

/** What the guidance needs to know about one shift (or Rota Planner position). */
export type ReplaceGuardFacts = {
  status?: string | null;
  guardId?: number | null;
  start?: string | null;
  end?: string | null;
  /**
   * The shift belongs to a marketplace hire. The company shift list carries `assignment` and `jobApplication` (the
   * exact relations the server checks); when the client has no payload for the shift this is false and the server's
   * REPLACE_GUARD_HIRE_LINKED refusal is what the user sees.
   */
  hireLinked?: boolean;
};

type HireLinkFields = {
  assignment?: unknown;
  assignmentId?: number | null;
  jobApplication?: unknown;
  jobApplicationId?: number | null;
};

/** True when the shift payload shows a marketplace hire: the server refuses REPLACE_GUARD_HIRE_LINKED for it. */
export function isHireLinkedShift(shift: HireLinkFields | null | undefined): boolean {
  if (!shift) return false;
  return Boolean(shift.assignment || shift.jobApplication || shift.assignmentId != null || shift.jobApplicationId != null);
}

function timeOf(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function unavailable(key: ReplaceGuardUnavailableKey): ReplaceGuardAvailability {
  return { available: false, key, reason: REPLACE_GUARD_UNAVAILABLE_REASONS[key] };
}

/**
 * Whether Replace Guard can be offered for this shift at `nowMs`, and if not, the one-line reason.
 * `otherCandidateCount` is how many active company Guards OTHER than the current one could be chosen.
 *
 * Mirrors replaceGuardStateRefusal (status first, then end, then the no-show grace) plus the hire link and the
 * candidate list. Where the client cannot know (an unparseable time), it allows the attempt and the server decides.
 */
export function replaceGuardAvailability(
  facts: ReplaceGuardFacts,
  nowMs: number,
  otherCandidateCount: number,
): ReplaceGuardAvailability {
  const status = (facts.status || '').toLowerCase().trim();
  if (status === 'in_progress') return unavailable('booked_on');
  if (status === 'completed') return unavailable('completed');
  if (status === 'cancelled') return unavailable('cancelled');
  if (status === 'rejected') return unavailable('declined');
  if (status === 'missed') return unavailable('missed');
  if (!facts.guardId) return unavailable('no_guard');
  if (!REPLACEABLE.has(status)) return unavailable('not_replaceable');

  const startMs = timeOf(facts.start);
  const endMs = timeOf(facts.end);
  if (endMs !== null && nowMs >= endMs) return unavailable('ended');

  if (facts.hireLinked) return unavailable('hire_linked');

  const startedAndAccepted = status === 'ready' && startMs !== null && nowMs >= startMs;
  if (startedAndAccepted && nowMs < startMs! + REPLACE_GUARD_NO_SHOW_GRACE_MINUTES * 60_000) {
    return unavailable('no_show_grace');
  }

  if (otherCandidateCount <= 0) return unavailable('no_candidates');

  return { available: true, noShow: startedAndAccepted };
}

/** The candidates for a shift: every active company Guard except the one who holds it. */
export function replacementCandidatesFor(
  guards: ReadonlyArray<ReplacementGuardOption> | null | undefined,
  currentGuardId: number | null | undefined,
): ReplacementGuardOption[] {
  return (guards ?? []).filter((g) => g.id !== currentGuardId);
}

/** The success line both entry points show once the server has accepted the replacement. */
export function replaceGuardSuccessMessage(replacementName: string | null | undefined): string {
  return `Now offered to ${replacementName || 'the replacement Guard'} — Awaiting until they accept it.`;
}
