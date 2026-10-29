// How a Guard's patrols read on the phone (Patrols P1-E). PURE presentation over two sources:
//   * the outbox (what this phone recorded and whether each step has been sent), and
//   * the server (GET /patrols/mine/plan and /mine/runs, and the answers to each step).
// Nothing here decides a due time, a window, or a verification: due times are the plan's `windows` (the server's own
// site-local windows), and a patrol is VERIFIED only when the server says verificationStatus = 'verified' — never
// because the phone believes everything was sent.

import { formatInstantTime } from '../../../services/siteTime';
import type { GuardPatrolPlan, GuardPatrolPlanWindow, GuardPatrolRun } from '../../../types/patrols';
import { NOT_SENT_MESSAGE, type OutboxItem } from './patrolOutbox';

export type PatrolPhase =
  | 'pending_sync' // recorded on the phone, not yet accepted by S4
  | 'in_progress'
  | 'incomplete'
  | 'awaiting_verification' // completed; S4 has not yet confirmed every required item
  | 'verified' // S4 confirmed every required item
  | 'closed_by_system'
  | 'not_sent'; // S4 refused it (e.g. the sync window closed): contact the control room

export const PATROL_PHASE_LABELS: Record<PatrolPhase, string> = {
  pending_sync: 'Waiting to send',
  in_progress: 'In progress',
  incomplete: 'Incomplete',
  awaiting_verification: 'Completed — awaiting verification',
  verified: 'Verified',
  closed_by_system: 'Closed by S4',
  not_sent: 'Not sent',
};

export type LocalPatrol = {
  clientRunId: string;
  shiftId: number;
  start: OutboxItem;
  scans: OutboxItem[];
  photos: OutboxItem[];
  exceptions: OutboxItem[];
  complete: OutboxItem | null;
};

/** The phone's patrols, newest first (optionally for one shift). */
export function localPatrols(items: OutboxItem[], shiftId?: number | null): LocalPatrol[] {
  const starts = items.filter((i) => i.kind === 'start' && (shiftId == null || i.shiftId === shiftId));
  return starts
    .map((start) => {
      const mine = items.filter((i) => i.clientRunId === start.clientRunId);
      return {
        clientRunId: start.clientRunId,
        shiftId: start.shiftId,
        start,
        scans: mine.filter((i) => i.kind === 'scan').sort((a, b) => a.seq - b.seq),
        photos: mine.filter((i) => i.kind === 'photo').sort((a, b) => a.seq - b.seq),
        exceptions: mine.filter((i) => i.kind === 'exception').sort((a, b) => a.seq - b.seq),
        complete: mine.find((i) => i.kind === 'complete') ?? null,
      };
    })
    .sort((a, b) => b.start.seq - a.start.seq);
}

/** The patrol the Guard is on right now on this shift (started on this phone, not completed on it), if any. */
export function activePatrol(items: OutboxItem[], shiftId: number): LocalPatrol | null {
  return localPatrols(items, shiftId).find((p) => !p.complete && p.start.status !== 'refused' && p.start.status !== 'failed') ?? null;
}

const sendable = (i: OutboxItem) => i.kind !== 'exception';

export type PatrolView = {
  phase: PatrolPhase;
  label: string;
  /** Steps recorded on the phone that S4 has not accepted yet. */
  waiting: number;
  /** Steps S4 will not accept: shown with NOT_SENT_MESSAGE, never hidden. */
  notSent: OutboxItem[];
  startedAtDevice: string;
  startedAtServer: string | null;
  completedAtDevice: string | null;
  completedAtServer: string | null;
};

/** One patrol's state. `serverRun` is GET /patrols/mine/runs's row for it (matched by clientRunId), when known. */
export function patrolView(local: LocalPatrol, serverRun: GuardPatrolRun | null): PatrolView {
  const all = [local.start, ...local.scans, ...local.photos, ...(local.complete ? [local.complete] : [])];
  const waiting = all.filter((i) => sendable(i) && i.status === 'pending').length;
  const notSent = all.filter((i) => i.status === 'refused' || i.status === 'failed');
  const status = serverRun?.status ?? local.complete?.server?.runStatus ?? local.start.server?.runStatus ?? null;
  const verification = serverRun?.verificationStatus ?? local.complete?.server?.verificationStatus ?? null;
  let phase: PatrolPhase;
  if (local.start.status === 'refused' || local.start.status === 'failed') phase = 'not_sent';
  else if (status === 'closed_by_system') phase = 'closed_by_system';
  else if (local.complete && local.complete.status === 'pending') phase = 'pending_sync';
  else if (local.complete && local.complete.status !== 'done') phase = 'not_sent';
  else if (status === 'incomplete') phase = 'incomplete';
  else if (status === 'completed') phase = verification === 'verified' ? 'verified' : 'awaiting_verification';
  else if (local.start.status === 'pending') phase = 'pending_sync';
  else phase = 'in_progress';
  return {
    phase,
    label: PATROL_PHASE_LABELS[phase],
    waiting,
    notSent,
    startedAtDevice: local.start.createdAt,
    startedAtServer: serverRun?.startedAtServer ?? local.start.server?.receivedAt ?? null,
    completedAtDevice: local.complete?.createdAt ?? null,
    completedAtServer: serverRun?.completedAtServer ?? local.complete?.server?.receivedAt ?? null,
  };
}

/** Everything on this phone that S4 refused, for the banner that stays until the retention period ends. */
export function notSentItems(items: OutboxItem[]): Array<{ item: OutboxItem; message: string }> {
  return items
    .filter((i) => sendable(i) && (i.status === 'refused' || i.status === 'failed'))
    .map((item) => ({ item, message: NOT_SENT_MESSAGE }));
}

export function waitingCount(items: OutboxItem[]): number {
  return items.filter((i) => sendable(i) && i.status === 'pending').length;
}

/** Whether the patrol card belongs on the current shift: the company's Patrols switch is on (the plan loaded) and the
 * site actually has patrols (checkpoints or schedules). A plan error (404 PATROLS_NOT_ENABLED, no site) hides it. */
export function patrolCardVisible(input: { shiftStatus: string | null | undefined; plan: GuardPatrolPlan | null }): boolean {
  if (String(input.shiftStatus ?? '').toLowerCase() !== 'in_progress') return false;
  if (!input.plan) return false;
  return input.plan.checkpoints.length > 0 || input.plan.schedules.length > 0;
}

export type WindowRow = { windowKey: string; scheduleId: number; routeId: number | null; scheduleName: string; time: string; state: 'due_now' | 'upcoming' | 'covered' };

/**
 * The next scheduled patrols of the shift, on the SITE's clock. null when the backend sent no windows (an older
 * backend): the app then shows no due times rather than inventing any.
 */
export function upcomingWindows(plan: GuardPatrolPlan, now: Date, limit = 4): WindowRow[] | null {
  if (!Array.isArray(plan.windows)) return null;
  const t = now.getTime();
  const tz = plan.site.timezone;
  return plan.windows
    .filter((w) => new Date(w.end).getTime() > t)
    .slice(0, limit)
    .map((w: GuardPatrolPlanWindow) => ({
      windowKey: w.windowKey,
      scheduleId: w.scheduleId,
      routeId: w.routeId,
      scheduleName: w.scheduleName,
      time: `${formatInstantTime(w.start, tz)}–${formatInstantTime(w.end, tz)}`,
      state: w.covered ? 'covered' : new Date(w.start).getTime() <= t ? 'due_now' : 'upcoming',
    }));
}

/** The window open right now and not yet covered, which a new patrol is started for (its schedule and route). */
export function dueWindow(plan: GuardPatrolPlan, now: Date): GuardPatrolPlanWindow | null {
  if (!Array.isArray(plan.windows)) return null;
  const t = now.getTime();
  return plan.windows.find((w) => !w.covered && new Date(w.start).getTime() <= t && t < new Date(w.end).getTime()) ?? null;
}

export type CheckpointRow = { publicId: string; label: string; required: boolean; photoRequired: boolean; scanned: boolean; exception: string | null };

/** The checkpoints this patrol should cover: its route's (in order) when it has one, else every active checkpoint of the site. */
export function patrolCheckpoints(plan: GuardPatrolPlan, routeId: number | null, local: LocalPatrol | null): CheckpointRow[] {
  const route = routeId != null ? plan.routes.find((r) => r.id === routeId) : null;
  const base = route
    ? route.checkpoints.map((c) => ({ publicId: c.publicId, label: c.label, required: c.required, photoRequired: plan.checkpoints.find((p) => p.publicId === c.publicId)?.photoRequired ?? false }))
    : plan.checkpoints.map((c) => ({ publicId: c.publicId, label: c.label, required: true, photoRequired: c.photoRequired }));
  const scanned = new Set((local?.scans ?? []).map((s) => String(s.meta.publicId ?? '')));
  return base.map((c) => {
    const exception = local?.exceptions.find((e) => e.meta.publicId === c.publicId);
    return { ...c, scanned: scanned.has(c.publicId), exception: exception ? String(exception.meta.reason ?? '') : null };
  });
}

export type CompletionSummary = {
  checkpointsTotal: number;
  checkpointsScanned: number;
  missing: CheckpointRow[];
  missingWithoutReason: CheckpointRow[];
  photosTaken: number;
  photosRequired: number;
  /** A reason is needed before completing (a required checkpoint was neither scanned nor explained). */
  needsReason: boolean;
};

export function completionSummary(plan: GuardPatrolPlan, routeId: number | null, local: LocalPatrol): CompletionSummary {
  const rows = patrolCheckpoints(plan, routeId, local);
  const missing = rows.filter((r) => r.required && !r.scanned);
  const missingWithoutReason = missing.filter((r) => !r.exception);
  // The policy's photos per run, plus for each scan the policy's photos per checkpoint (at least one where the
  // checkpoint itself requires a photo). The server makes the final judgement; this only guides the Guard.
  const perScan = local.scans.reduce((n, scan) => {
    const row = rows.find((r) => r.publicId === scan.meta.publicId);
    return n + Math.max(plan.policy.photosPerCheckpoint, row?.photoRequired ? 1 : 0);
  }, 0);
  const photosRequired = plan.policy.photosPerRun + perScan;
  return {
    checkpointsTotal: rows.length,
    checkpointsScanned: rows.filter((r) => r.scanned).length,
    missing,
    missingWithoutReason,
    photosTaken: local.photos.length,
    photosRequired,
    needsReason: missingWithoutReason.length > 0,
  };
}

/** A device time and, once known, the server's receipt time, on the site's clock. */
export function timePair(deviceIso: string | null, serverIso: string | null, timeZone: string): string {
  const device = deviceIso ? formatInstantTime(deviceIso, timeZone) : '—';
  return serverIso ? `${device} (received by S4 ${formatInstantTime(serverIso, timeZone)})` : `${device} (on this phone)`;
}
