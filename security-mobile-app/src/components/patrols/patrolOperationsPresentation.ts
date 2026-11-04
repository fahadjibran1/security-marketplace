import type { PatrolAttentionCase, PatrolOperationsAttention, PatrolResolvedMissedWindow } from '../../types/patrols';
import { resolutionLabel } from '../company/alertResolution';
import { patrolAlertTitle } from './patrolPresentation';

/**
 * S3 Stage 3 (owner-approved 4 Nov 2026): the words Live Operations uses for patrol cases, from
 * GET /patrols/operations/attention. Pure — no request, no state. "Acknowledged by" names who took it up; it is not an
 * assignment, so the dashboard never says "Handling" or "Case owner".
 */

export const RECONCILIATION_TITLE = 'Reconciliation required';
export const DATA_INCONSISTENCY_LABEL = 'Data inconsistency';
export const RECONCILIATION_NOTE = 'Resolving this summary does not resolve the patrol windows it lists; each stays open until resolved.';
export const INCONSISTENCY_NOTE = 'The alert and its patrol record disagree. S4 does not change either automatically — review it in Patrol Management.';

/** The case's headline: the alert type, or "Reconciliation required" for an outage summary. */
export function patrolCaseTitle(c: Pick<PatrolAttentionCase, 'kind' | 'alertType'>): string {
  return c.kind === 'reconciliation_summary' ? RECONCILIATION_TITLE : patrolAlertTitle(c.alertType);
}

/** Its lifecycle in words: Open, Acknowledged by …, or Data inconsistency. */
export function patrolCaseStatusLabel(c: Pick<PatrolAttentionCase, 'status' | 'acknowledgedByName' | 'stateMismatch'>): string {
  if (c.stateMismatch) return DATA_INCONSISTENCY_LABEL;
  if (c.status === 'acknowledged') return c.acknowledgedByName ? `Acknowledged by ${c.acknowledgedByName}` : 'Acknowledged';
  return 'Open';
}

/** "3 patrol windows affected (2 still open)" — null when the summary has no window count (the unjudged horizon). */
export function affectedWindowsText(affected: PatrolAttentionCase['affectedWindows']): string | null {
  if (!affected) return null;
  const windows = `${affected.total} patrol window${affected.total === 1 ? '' : 's'} affected`;
  return `${windows} (${affected.open} still open)`;
}

/** The lines shown under a case in Attention Now. */
export function patrolCaseNotes(c: PatrolAttentionCase): string[] {
  const notes: string[] = [];
  if (c.kind === 'reconciliation_summary') {
    const affected = affectedWindowsText(c.affectedWindows);
    if (affected) notes.push(affected);
    notes.push(RECONCILIATION_NOTE);
  }
  if (c.stateMismatch) notes.push(INCONSISTENCY_NOTE);
  if (c.lateEvidence) notes.push('Evidence reached S4 after the alert was raised.');
  return notes;
}

/** The site's own calendar date of an instant (YYYY-MM-DD). */
export function siteLocalDate(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export type MissedTodayRow =
  | { key: string; state: 'open' | 'acknowledged' | 'inconsistent'; statusLabel: string; case: PatrolAttentionCase; windowStart: string | null; siteName: string; guardName: string | null }
  | { key: string; state: 'resolved'; statusLabel: string; resolved: PatrolResolvedMissedWindow; windowStart: string | null; siteName: string; guardName: string | null };

export type MissedTodayView = {
  rows: MissedTodayRow[];
  total: number;
  open: number;
  resolved: number;
  /** Open missed windows today with no case of their own (found by outage reconciliation: see its summary). */
  openWithoutCase: number;
  /** More resolved windows than listed (the server lists the newest 200). */
  resolvedMore: boolean;
};

/**
 * Missed Today: every sweep-confirmed missed window of today (each site's own date), the open and acknowledged ones from
 * the case queue and the resolved ones from the day's history, newest window first. The counts are the server's.
 */
export function missedTodayView(attention: PatrolOperationsAttention, now: Date = new Date()): MissedTodayView {
  const open: MissedTodayRow[] = attention.cases
    .filter((c) => c.kind === 'exception' && c.type === 'patrol_missed' && c.site && c.siteDate === siteLocalDate(now, c.site.timeZone))
    .map((c) => ({
      key: c.caseKey,
      state: c.stateMismatch ? 'inconsistent' : c.status === 'acknowledged' ? 'acknowledged' : 'open',
      statusLabel: patrolCaseStatusLabel(c),
      case: c,
      windowStart: c.windowStart,
      siteName: c.site?.name ?? 'Patrol site',
      guardName: c.guardName,
    }));
  const resolved: MissedTodayRow[] = attention.resolvedMissedToday.items.map((r) => ({
    key: `resolved:${r.exceptionId}`,
    state: 'resolved',
    statusLabel: resolvedLabel(r),
    resolved: r,
    windowStart: r.windowStart,
    siteName: r.site?.name ?? 'Patrol site',
    guardName: r.guardName,
  }));
  const rows = [...open, ...resolved].sort((a, b) => (b.windowStart ?? '').localeCompare(a.windowStart ?? ''));
  return {
    rows,
    total: attention.counts.missedToday,
    open: attention.counts.missedTodayOpen,
    resolved: attention.counts.missedTodayResolved,
    openWithoutCase: Math.max(0, attention.counts.missedTodayOpen - open.length),
    resolvedMore: attention.resolvedMissedToday.more,
  };
}

/** "Resolved by Ben Controller · Guard contacted". */
export function resolvedLabel(r: Pick<PatrolResolvedMissedWindow, 'resolvedByName' | 'resolution'>): string {
  const by = r.resolvedByName ? `Resolved by ${r.resolvedByName}` : 'Resolved';
  const reason = r.resolution ? resolutionLabel('patrol_late_sync', r.resolution) : '';
  return reason ? `${by} · ${reason}` : by;
}
