import { PATROL_VERIFICATION_FINAL_HOURS } from './patrol-constants';

/**
 * The patrol state rules (Patrols P1-B), pure: no database, no clock, no Nest. The sweep and the Guard API call these;
 * scripts/patrol-schedule.spec.ts tests each rule by name.
 *
 * Three SEPARATE deadlines (owner-approved, 28 Oct 2026):
 *   START       windowEnd + startGrace                                    nothing started for the window ⇒ MISSED.
 *                                                                         Started at/after windowEnd but before this ⇒
 *                                                                         the run is flagged lateStart (not an alert).
 *   COMPLETION  min(startedAt + maxDuration, windowEnd + completionGrace)  started, not completed ⇒ ABANDONED (overdue).
 *               (startedAt + maxDuration for a run with no window)          Starting never cancels this check.
 *   SYNC        completion deadline + syncGrace (operational, 60 min)      required evidence not on the server ⇒
 *                                                                         UNVERIFIED (Patrols only unless the policy
 *                                                                         escalates it); settled 24 h later.
 * At completion, required checkpoints or photos missing without a reason ⇒ CHECKPOINT_MISSED / INCOMPLETE; completing
 * with a reason ⇒ INCOMPLETE, which needs action when the policy says so (incompleteNeedsAction).
 *
 * Boundaries: a deadline is reached AT its instant (now ≥ deadline), as Welfare's missedFrom is. A window is half-open
 * [start, end): starting exactly at windowEnd is a late start; starting exactly at windowEnd + startGrace is too late to
 * count for that window.
 */

const MINUTE = 60_000;

export type PatrolGraceMinutes = {
  startGraceMinutes: number;
  maxPatrolDurationMinutes: number;
  completionGraceMinutes: number;
  syncGraceMinutes: number;
};

export function startDeadline(windowEnd: Date, startGraceMinutes: number): Date {
  return new Date(windowEnd.getTime() + Math.max(0, startGraceMinutes) * MINUTE);
}

export function completionDeadline(startedAt: Date, windowEnd: Date | null, policy: Pick<PatrolGraceMinutes, 'maxPatrolDurationMinutes' | 'completionGraceMinutes'>): Date {
  const byDuration = startedAt.getTime() + policy.maxPatrolDurationMinutes * MINUTE;
  if (!windowEnd) return new Date(byDuration);
  return new Date(Math.min(byDuration, windowEnd.getTime() + policy.completionGraceMinutes * MINUTE));
}

export function syncDeadline(completionDeadlineAt: Date, syncGraceMinutes: number): Date {
  return new Date(completionDeadlineAt.getTime() + Math.max(0, syncGraceMinutes) * MINUTE);
}

export function verificationFinalAt(syncDeadlineAt: Date): Date {
  return new Date(syncDeadlineAt.getTime() + PATROL_VERIFICATION_FINAL_HOURS * 60 * MINUTE);
}

/** A run started at `startedAt` for a window ending `windowEnd`: late iff windowEnd ≤ startedAt < windowEnd + grace. */
export function isLateStart(startedAt: Date, windowEnd: Date, startGraceMinutes: number): boolean {
  const t = startedAt.getTime();
  return t >= windowEnd.getTime() && t < startDeadline(windowEnd, startGraceMinutes).getTime();
}

/** A window with nothing started: MISSED once the start deadline is reached, DUE before. */
export function windowState(input: { hasRun: boolean; windowEnd: Date; startGraceMinutes: number; now: Date }): 'started' | 'due' | 'missed' {
  if (input.hasRun) return 'started';
  return input.now.getTime() >= startDeadline(input.windowEnd, input.startGraceMinutes).getTime() ? 'missed' : 'due';
}

/** A started run: ABANDONED once its completion deadline is reached while still in progress. */
export function runProgressState(input: { status: string; completionDeadline: Date; now: Date }): 'in_progress' | 'abandoned' | 'finished' {
  if (input.status !== 'in_progress') return 'finished';
  return input.now.getTime() >= input.completionDeadline.getTime() ? 'abandoned' : 'in_progress';
}

export type RequirementVisit = { checkpointId: number | null; result: string; visitId: number };
export type RequirementEvidence = {
  kind: string;
  visitId: number | null;
  uploadStatus: string;
  /** The P1-C retention state (absent ⇒ 'active', as a row that never entered the deletion state machine). */
  retentionStatus?: string | null;
  /** The hash the SERVER computed when it verified the bytes (null until verified). */
  sha256Stored?: string | null;
  id?: number;
};

export type RequirementInput = {
  /** The route's required, active checkpoints (none for a run without a route). Ignored when `methods` excludes 'qr'. */
  requiredCheckpointIds: number[];
  /** Checkpoints whose own setting asks for a photo. */
  photoRequiredCheckpointIds: number[];
  /** Any value > 0 means "a photo is required for each patrol" (S4 1.2.1: Yes/No, not a count). */
  photosPerRun: number;
  /** Any value > 0 means "a photo is required at each checkpoint visited" (Yes/No, not a count). */
  photosPerCheckpoint: number;
  visits: RequirementVisit[];
  evidence: RequirementEvidence[];
  /**
   * The policy's methods (S4 1.2.1). 'photo' requires a run photo; 'qr' requires a checkpoint rule (a route with required
   * checkpoints). Absent: the pre-1.2.1 reading (no QR-rule check, a run photo only when photosPerRun > 0).
   */
  methods?: readonly string[];
};

export type RequirementResult = {
  missingCheckpointIds: number[];
  /** Photos the Guard has not TAKEN at all (no evidence row, or refused / corrupt): Guard completeness. */
  missingRunPhotos: number;
  missingCheckpointPhotos: number;
  /**
   * Required photos taken but not (yet) SERVER-VERIFIED and eligible (uploadStatus 'verified' and retention 'active' or
   * 'claimed'; one image counts once). Pending, uploaded (pre-inspection), quarantined, purged … never count. Before the
   * sync deadline this only keeps verification pending; after it, it is reported as evidence_unverified.
   */
  photosNotVerified: number;
  /** The pre-1.2.1 name of photosNotVerified (the same value). */
  photosNotOnServer: number;
  anyFlaggedScan: boolean;
  /** QR is required but the run has no route with required checkpoints: no valid checkpoint rule, so never verified. */
  qrRuleMissing: boolean;
  /** Verified photos whose server hash repeats one already counted in this run (counted once, flagged for review). */
  duplicateEvidenceIds: number[];
};

/** Taken (any state except refused / corrupt on the device): what Guard completeness counts. */
const recorded = (e: RequirementEvidence) => !['rejected', 'local_corrupt'].includes(e.uploadStatus);
/** Server-verified and still eligible: the ONLY evidence that counts towards verification (S4 1.2.1). */
export const verifiedEligible = (e: Pick<RequirementEvidence, 'uploadStatus' | 'retentionStatus'>) =>
  e.uploadStatus === 'verified' && ['active', 'claimed'].includes(e.retentionStatus ?? 'active');

/** The scans that count towards a run: an identified checkpoint, not flagged. */
function countedVisits<V extends Pick<RequirementVisit, 'checkpointId' | 'result'>>(visits: readonly V[]): V[] {
  return visits.filter((v) => v.checkpointId != null && v.result !== 'flagged');
}

/**
 * THE definition of "a checkpoint visited in this run" (#76), used by the requirement rules below AND by every company
 * read that reports progress (patrol-query.service.ts), so the History list and the run detail can never disagree:
 * the DISTINCT checkpoints with at least one scan that was not flagged. A flagged scan (duplicate in the run, off-route,
 * another site's label, revoked, tampered …) proves nothing and never counts; scanning one checkpoint twice counts once;
 * an unverified (unsigned) scan counts, as it does for the checkpoint_missed rule.
 */
export function visitedCheckpointIds(visits: ReadonlyArray<Pick<RequirementVisit, 'checkpointId' | 'result'>>): Set<number> {
  return new Set(countedVisits(visits).map((v) => Number(v.checkpointId)));
}

/**
 * A run's checkpoint progress as the company dashboard shows it ("x of y checkpoints"): x is visitedCheckpointIds, y the
 * number of checkpoints on the run's route (null without a route, when there is no y).
 */
export function checkpointProgress(
  visits: ReadonlyArray<Pick<RequirementVisit, 'checkpointId' | 'result'>>,
  routeCheckpointCount: number | null,
): { checkpointsVisited: number; checkpointsTotal: number | null } {
  return { checkpointsVisited: visitedCheckpointIds(visits).size, checkpointsTotal: routeCheckpointCount };
}

/**
 * What a finished run lacks (S4 1.2.1 rules).
 *   Checkpoints  only when the policy's methods include 'qr': the route's required checkpoints, each visited by a scan that
 *                was not flagged. QR required but no route with required checkpoints ⇒ qrRuleMissing (one scan is never
 *                enough; the run can never be QR-verified). Methods without 'qr' (photo-only) require no checkpoint.
 *   Photos       Yes/No, never a count: ONE run photo when the methods include 'photo' or photosPerRun > 0; ONE photo for
 *                each visited checkpoint when photosPerCheckpoint > 0 or the checkpoint asks for one.
 * Two counts are kept: TAKEN (any photo the Guard recorded that was not refused) decides the completeness findings ("photo
 * not taken"), so photos still in the outbox never make a run look incomplete; VERIFIED-ELIGIBLE (server-verified, retention
 * active / claimed, one image hash counted once) decides verification.
 */
export function evaluateRequirements(input: RequirementInput): RequirementResult {
  const methods = input.methods;
  const qrRequired = methods ? methods.includes('qr') : true;
  const counted = countedVisits(input.visits);
  const visited = visitedCheckpointIds(input.visits);
  const required = qrRequired ? [...new Set(input.requiredCheckpointIds.map(Number))] : [];
  const missingCheckpointIds = required.filter((id) => !visited.has(id)).sort((a, b) => a - b);
  const qrRuleMissing = methods ? qrRequired && required.length === 0 : false;

  // The photo requirements ("buckets"): the run, then each visited checkpoint that needs one. Each needs 0 or 1 photo.
  type Bucket = { photos: RequirementEvidence[]; run: boolean };
  const buckets: Bucket[] = [];
  if (input.photosPerRun > 0 || (methods?.includes('photo') ?? false)) {
    buckets.push({ photos: input.evidence.filter((e) => e.kind === 'run_photo'), run: true });
  }
  const photoRequired = new Set(input.photoRequiredCheckpointIds.map(Number));
  const needingPhotos = new Set([...required, ...photoRequired].filter((id) => visited.has(id)));
  for (const checkpointId of [...needingPhotos].sort((a, b) => a - b)) {
    if (!(input.photosPerCheckpoint > 0 || photoRequired.has(checkpointId))) continue;
    const visitIds = new Set(counted.filter((v) => Number(v.checkpointId) === checkpointId).map((v) => v.visitId));
    buckets.push({ photos: input.evidence.filter((e) => e.kind === 'checkpoint_photo' && e.visitId != null && visitIds.has(e.visitId)), run: false });
  }

  // Each verified image counts ONCE in the run: a hash already used satisfies nothing else. Requirements with the fewest
  // candidate photos choose first, so one image never starves a requirement another image could have met.
  const used = new Set<string>();
  const imageKey = (e: RequirementEvidence, i: number, b: number) => e.sha256Stored ?? `row:${e.id ?? `${b}.${i}`}`;
  const order = buckets
    .map((b, index) => ({ b, index, options: b.photos.filter(verifiedEligible).length }))
    .sort((x, y) => x.options - y.options || x.index - y.index);
  let missingRunPhotos = 0;
  let missingCheckpointPhotos = 0;
  let notVerified = 0;
  for (const { b, index } of order) {
    const taken = b.photos.filter(recorded).length;
    const missing = taken > 0 ? 0 : 1;
    if (b.run) missingRunPhotos += missing;
    else missingCheckpointPhotos += missing;
    const counts = b.photos.find((e, i) => verifiedEligible(e) && !used.has(imageKey(e, i, index)));
    if (counts) used.add(imageKey(counts, b.photos.indexOf(counts), index));
    else if (taken > 0) notVerified += 1;
  }

  // Repeated images among ALL verified, eligible photos of the run (whatever requirement they were taken for).
  const seen = new Set<string>();
  const duplicateEvidenceIds: number[] = [];
  for (const e of input.evidence.filter(verifiedEligible).sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0))) {
    if (!e.sha256Stored) continue;
    if (seen.has(e.sha256Stored)) {
      if (e.id != null) duplicateEvidenceIds.push(Number(e.id));
    } else {
      seen.add(e.sha256Stored);
    }
  }
  return {
    missingCheckpointIds,
    missingRunPhotos,
    missingCheckpointPhotos,
    photosNotVerified: notVerified,
    photosNotOnServer: notVerified,
    anyFlaggedScan: input.visits.some((v) => v.result === 'flagged'),
    qrRuleMissing,
    duplicateEvidenceIds,
  };
}

export type CompletionFinding = { type: 'checkpoint_missed' | 'patrol_incomplete'; actionable: boolean; reason: string };

/**
 * The exceptions a FINISHED run raises.
 *   status incomplete (the Guard gave a reason, or the system closed it as guard_replaced)  ⇒ patrol_incomplete,
 *     actionable when the policy says an incomplete patrol needs action (incompleteNeedsAction);
 *   status completed, a required checkpoint not visited                                     ⇒ checkpoint_missed (actionable);
 *   status completed, required photos not recorded                                          ⇒ patrol_incomplete (actionable).
 * A system closure after the sync window (closed_by_system) raises nothing here: its abandonment was already raised.
 */
export function completionFindings(input: { status: string; exceptionReason: string | null; incompleteNeedsAction: boolean; requirements: RequirementResult }): CompletionFinding[] {
  if (input.status === 'incomplete') {
    return [{ type: 'patrol_incomplete', actionable: input.incompleteNeedsAction, reason: input.exceptionReason ?? 'incomplete' }];
  }
  if (input.status !== 'completed') return [];
  const out: CompletionFinding[] = [];
  if (input.requirements.missingCheckpointIds.length) {
    out.push({ type: 'checkpoint_missed', actionable: true, reason: `checkpoints not scanned: ${input.requirements.missingCheckpointIds.join(', ')}` });
  }
  const photos = input.requirements.missingRunPhotos + input.requirements.missingCheckpointPhotos;
  if (photos > 0) out.push({ type: 'patrol_incomplete', actionable: true, reason: `${photos} required photo(s) not taken` });
  return out;
}

/**
 * Verification of a finished run, separate from its completion:
 *   flagged     a scan was flagged;
 *   verified    every required item is server-verified and eligible — and, when QR is required, the run has a valid
 *               checkpoint rule (a run with qrRuleMissing is NEVER verified);
 *   unverified  the sync deadline passed with a requirement still unmet (or no checkpoint rule);
 *   pending     otherwise (completed · pending sync), so a late upload is never judged before the sync deadline.
 */
export function verificationState(input: { requirements: RequirementResult; now: Date; syncDeadline: Date }): 'flagged' | 'verified' | 'unverified' | 'pending' {
  const r = input.requirements;
  if (r.anyFlaggedScan) return 'flagged';
  const notVerified = r.photosNotVerified ?? r.photosNotOnServer;
  const missing = r.missingCheckpointIds.length + r.missingRunPhotos + r.missingCheckpointPhotos + notVerified;
  if (missing === 0 && !r.qrRuleMissing) return 'verified';
  return input.now.getTime() >= input.syncDeadline.getTime() ? 'unverified' : 'pending';
}
