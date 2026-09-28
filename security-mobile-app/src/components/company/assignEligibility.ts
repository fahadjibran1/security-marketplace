// Pure presentation model for the Rota Planner "assign a guard" candidate list (UAT-DEPLOY-01).
// No React / React Native imports, so the exact functions the drawer calls can be unit-tested.
//
// This module NEVER decides eligibility. `isEligible` and every reason come verbatim from the backend
// eligibility projection (GET /coverage/shifts/:id/eligible-guards -> AvailabilityService
// .evaluateGuardForShift), which is the same function the assignment endpoint enforces with. All this
// module does is SPLIT what the server already said into the part that genuinely blocks assignment and
// the part that is merely unknown, and choose which EXISTING workflow to offer as the way out.
//
// The split is driven by the server's structured flags, never by reading prose:
//
//   hasApprovedLeave / hasShiftClash / !complianceValid / availabilityStatus 'unavailable'  -> blocking
//   availabilityStatus 'no_rule'                                                           -> unknown
//
// `no_rule` is informational by backend design: it is deliberately absent from `hardBlocked` in
// evaluateGuardForShift and from every throw in assertGuardCanTakeShift, so a guard with no availability
// rule IS assignable. Production currently holds zero availability rules, so this line would otherwise
// appear against every candidate forever. See scripts/availability-semantics.spec.ts for the backend
// certification of that rule.

import type { EligibleGuardRow } from '../../types/models';

/** One thing that genuinely prevents assignment, in the server's own words. */
export type CandidateBlocker = {
  key: string;
  text: string;
  /** Practical next step, from the EXISTING compliance remediation mapping. Null when none applies. */
  nextStep: string | null;
};

export type AvailabilityPresentation = {
  label: string;
  tone: 'success' | 'warning' | 'neutral';
};

/** Which existing workflow to offer. `none` when there is no accurate action to point at. */
export type CandidateAction = 'fix_compliance' | 'none';

export type CandidateAssessment = {
  /** Straight from the server. The only thing that gates the Assign button. */
  isEligible: boolean;
  /** Every blocking reason the server gave, minus the informational availability line. */
  blockers: CandidateBlocker[];
  /** Rendered for every candidate. `no_rule` becomes "Not set" — never the raw enum. */
  availability: AvailabilityPresentation;
  action: CandidateAction;
  /** True when compliance is (one of) the reasons this candidate cannot be assigned. */
  complianceBlocked: boolean;
};

/**
 * A compliance blocker as the existing model produces it. Injected rather than imported so this module
 * stays dependency-free: the caller composes it from buildBlockers(summary, canManage) in
 * compliance-model.ts, which returns ALL of a guard's blocking reasons rather than only the first.
 */
export type ComplianceBlockerInput = { text: string; nextStep?: string | null };

export type AssessCandidateOptions = {
  /**
   * ALL current compliance blockers for this guard, from the authoritative /compliance/statuses
   * projection. Optional: when it has not loaded, the assessment degrades to the single compliance
   * reason the eligibility projection itself carries (assertGuardAssignable throws with blockers[0]).
   */
  complianceBlockers?: ComplianceBlockerInput[] | null;
  /** compliance.view — whether the Fix Compliance route may be offered at all. */
  canFixCompliance?: boolean;
};

const AVAILABILITY_LABELS: Record<string, AvailabilityPresentation> = {
  available: { label: 'Available', tone: 'success' },
  unavailable: { label: 'Unavailable', tone: 'warning' },
  no_rule: { label: 'Not set', tone: 'neutral' },
};

/**
 * Never renders a raw backend enum. An unrecognised value is treated as "not set" for the same reason
 * `no_rule` is: an availability state this build does not know about is unknown, not a judgement.
 */
export function availabilityPresentation(status: string | null | undefined): AvailabilityPresentation {
  return AVAILABILITY_LABELS[String(status ?? '')] ?? { label: 'Not set', tone: 'neutral' };
}

/** The server's own informational availability line. Matched only when the FLAG also says unknown. */
const NO_RULE_REASON = /^no availability rule found/i;

function isInformationalReason(reason: string, row: EligibleGuardRow): boolean {
  return row.availabilityStatus === 'no_rule' && NO_RULE_REASON.test(String(reason).trim());
}

// The server nests its own prefixes: assertGuardCanTakeShift re-wraps the ForbiddenException message
// from assertGuardAssignable, so the eligibility reason reads
// "Compliance invalid: Guard compliance invalid: Missing SIA licence document".
const COMPLIANCE_PREFIX = /^(compliance invalid|guard compliance invalid)\s*:\s*/i;

/** Strips the nested server prefixes for display. Presentation only — the text itself is the server's. */
export function stripCompliancePrefix(reason: string): string {
  let text = String(reason ?? '').trim();
  for (let guard = 0; guard < 4 && COMPLIANCE_PREFIX.test(text); guard += 1) {
    text = text.replace(COMPLIANCE_PREFIX, '').trim();
  }
  return text;
}

function isComplianceReason(reason: string): boolean {
  return COMPLIANCE_PREFIX.test(String(reason ?? '').trim());
}

/**
 * Splits one server eligibility row into what blocks assignment and what is merely unknown.
 *
 * Compliance detail is preferred from `complianceBlockers` (the full authoritative list) and falls back
 * to the single reason the eligibility row carries, so the drawer is useful either way.
 */
export function assessCandidate(
  row: EligibleGuardRow,
  options: AssessCandidateOptions = {},
): CandidateAssessment {
  const reasons = Array.isArray(row.reasons) ? row.reasons : [];
  const complianceBlocked = row.complianceValid === false;
  const blockers: CandidateBlocker[] = [];

  // Non-compliance blockers keep the server's wording verbatim; the informational line is removed.
  reasons.forEach((reason, index) => {
    if (isInformationalReason(reason, row)) return;
    if (isComplianceReason(reason)) return; // handled below, in full
    const text = String(reason ?? '').trim();
    if (!text) return;
    blockers.push({ key: `reason-${index}`, text, nextStep: null });
  });

  if (complianceBlocked) {
    const supplied = (options.complianceBlockers ?? []).filter((item) => String(item?.text ?? '').trim());
    if (supplied.length) {
      supplied.forEach((item, index) => {
        blockers.push({
          key: `compliance-${index}`,
          text: stripCompliancePrefix(item.text),
          nextStep: item.nextStep ?? null,
        });
      });
    } else {
      // Degraded: only the first compliance blocker is knowable from the eligibility projection.
      reasons.forEach((reason, index) => {
        if (!isComplianceReason(reason)) return;
        const text = stripCompliancePrefix(reason);
        if (text) blockers.push({ key: `compliance-reason-${index}`, text, nextStep: null });
      });
    }
  }

  return {
    isEligible: row.isEligible === true,
    blockers,
    availability: availabilityPresentation(row.availabilityStatus),
    // Offered only for a compliance blocker, and only to someone who can open Compliance. A clash or
    // approved leave is not fixed in the Compliance workspace, so pointing there would be wrong.
    action: complianceBlocked && options.canFixCompliance === true ? 'fix_compliance' : 'none',
    complianceBlocked,
  };
}

/** Heading for the blocker list. Compliance-led when compliance is the cause, neutral otherwise. */
export function candidateBlockerHeading(assessment: CandidateAssessment): string {
  if (assessment.isEligible) return '';
  return assessment.complianceBlocked ? 'Compliance action required' : 'Cannot be assigned';
}

// ─── Assignment failure banner ───────────────────────────────────────────────
//
// The disabled Assign button keeps the normal journey away from the known refusal, but eligibility can
// still change between loading the candidates and clicking (evidence unverified, a clash created, leave
// approved, the position taken). That refusal must read as a sentence, never as transport wreckage:
// UAT saw `403 - {"message":...}`, which tells a control-room manager nothing.

/** Pulls a human sentence out of whatever the transport threw. Never returns JSON or a status code. */
function extractMessage(error: unknown): string {
  if (typeof error === 'string') return error.trim();
  const source = (error ?? {}) as { message?: unknown; body?: unknown };

  const body = source.body;
  if (typeof body === 'string' && body.trim() && !body.trim().startsWith('{')) return body.trim();
  if (body && typeof body === 'object') {
    const inner = (body as { message?: unknown }).message;
    if (typeof inner === 'string' && inner.trim()) return inner.trim();
    if (Array.isArray(inner) && inner.length) return inner.map((part) => String(part)).join(', ');
  }

  const message = typeof source.message === 'string' ? source.message.trim() : '';
  if (!message) return '';
  // `403 - {"message":"…","statusCode":403}` — recover the sentence, discard the envelope.
  const embedded = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message);
  if (embedded) return embedded[1].replace(/\\"/g, '"').trim();
  if (message.includes('{') || message.includes('}')) return '';
  return message.replace(/^\s*\d{3}\s*[-:]\s*/, '').trim();
}

/**
 * The banner text for a failed assignment. Compliance refusals are rewritten into the same language the
 * candidate list uses, so the manager sees one consistent explanation and a route forward.
 */
export function assignFailureMessage(error: unknown): string {
  const raw = extractMessage(error);
  if (!raw) return 'Unable to assign guard. Reopen this position and try again.';

  if (/already been filled|no longer available/i.test(raw)) {
    return 'This position has already been filled or is no longer available.';
  }
  if (isComplianceReason(raw)) {
    const detail = stripCompliancePrefix(raw);
    return detail
      ? `This guard cannot be assigned yet: ${detail}. Add and verify the outstanding compliance evidence, then try again.`
      : 'This guard cannot be assigned yet because their compliance evidence is incomplete.';
  }
  return raw;
}
