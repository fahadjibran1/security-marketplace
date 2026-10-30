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
export type RequirementEvidence = { kind: string; visitId: number | null; uploadStatus: string };

export type RequirementInput = {
  /** The route's required, active checkpoints (none for a run without a route). */
  requiredCheckpointIds: number[];
  /** Checkpoints whose own setting asks for a photo. */
  photoRequiredCheckpointIds: number[];
  photosPerRun: number;
  photosPerCheckpoint: number;
  visits: RequirementVisit[];
  evidence: RequirementEvidence[];
};

export type RequirementResult = {
  missingCheckpointIds: number[];
  /** Photos the Guard has not recorded at all (no evidence row). */
  missingRunPhotos: number;
  missingCheckpointPhotos: number;
  /** Required photos recorded but not yet on the server (uploaded or verified). */
  photosNotOnServer: number;
  anyFlaggedScan: boolean;
};

/** Recorded (any state except refused / corrupt on the device). */
const recorded = (e: RequirementEvidence) => !['rejected', 'local_corrupt'].includes(e.uploadStatus);
/** On the server (P1-C sets these after the upload completes). */
const onServer = (e: RequirementEvidence) => ['uploaded', 'verified'].includes(e.uploadStatus);

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
 * What a finished run lacks. A checkpoint counts as visited only by a scan that was not flagged (a flagged scan — wrong
 * site, revoked, tampered — proves nothing). Photos: photosPerRun run photos; for each required (or photo-required)
 * checkpoint visited, max(photosPerCheckpoint, 1 if the checkpoint asks for one) checkpoint photos linked to its visit.
 */
export function evaluateRequirements(input: RequirementInput): RequirementResult {
  const counted = countedVisits(input.visits);
  const visited = visitedCheckpointIds(input.visits);
  const missingCheckpointIds = [...new Set(input.requiredCheckpointIds.map(Number))].filter((id) => !visited.has(id)).sort((a, b) => a - b);

  const runPhotos = input.evidence.filter((e) => e.kind === 'run_photo');
  const missingRunPhotos = Math.max(0, input.photosPerRun - runPhotos.filter(recorded).length);
  let notOnServer = Math.max(0, Math.min(input.photosPerRun, runPhotos.filter(recorded).length) - runPhotos.filter(onServer).length);

  let missingCheckpointPhotos = 0;
  const photoRequired = new Set(input.photoRequiredCheckpointIds.map(Number));
  const needingPhotos = new Set([...input.requiredCheckpointIds.map(Number), ...photoRequired].filter((id) => visited.has(id)));
  for (const checkpointId of needingPhotos) {
    const need = Math.max(input.photosPerCheckpoint, photoRequired.has(checkpointId) ? 1 : 0);
    if (need === 0) continue;
    const visitIds = new Set(counted.filter((v) => Number(v.checkpointId) === checkpointId).map((v) => v.visitId));
    const photos = input.evidence.filter((e) => e.kind === 'checkpoint_photo' && e.visitId != null && visitIds.has(e.visitId));
    const have = photos.filter(recorded).length;
    missingCheckpointPhotos += Math.max(0, need - have);
    notOnServer += Math.max(0, Math.min(need, have) - photos.filter(onServer).length);
  }
  return {
    missingCheckpointIds,
    missingRunPhotos,
    missingCheckpointPhotos,
    photosNotOnServer: notOnServer,
    anyFlaggedScan: input.visits.some((v) => v.result === 'flagged'),
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
 *   verified    every required item is on the server;
 *   unverified  the sync deadline passed with required evidence missing from the server;
 *   pending     otherwise (completed · pending sync).
 */
export function verificationState(input: { requirements: RequirementResult; now: Date; syncDeadline: Date }): 'flagged' | 'verified' | 'unverified' | 'pending' {
  if (input.requirements.anyFlaggedScan) return 'flagged';
  const missing = input.requirements.missingCheckpointIds.length + input.requirements.missingRunPhotos
    + input.requirements.missingCheckpointPhotos + input.requirements.photosNotOnServer;
  if (missing === 0) return 'verified';
  return input.now.getTime() >= input.syncDeadline.getTime() ? 'unverified' : 'pending';
}
