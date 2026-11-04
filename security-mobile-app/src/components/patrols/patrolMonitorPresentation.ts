// S4 Patrol Monitor S2: the pure rules of the compact Monitor (owner-approved 3 Nov 2026). Every state the server
// decides (S1 API) is shown with a text label AND a symbol, never by colour alone. Colours:
//   green  verified on time only (server-verified)
//   amber  late · verified, awaiting verification, incomplete, needs review (flagged / not verified), overdue,
//          awaiting check
//   red    missed only: a patrol_missed exception the sweep raised
//   blue   due now, in progress
//   grey   upcoming, no guard on duty, not assessed
//   blank  no window that hour, off duty, no patrol required

import type {
  PatrolMonitorCell,
  PatrolMonitorCellState,
  PatrolMonitorCounts,
  PatrolMonitorHour,
  PatrolMonitorLane,
  PatrolMonitorRun,
  PatrolMonitorSiteStatus,
  PatrolMonitorSummarySite,
  PatrolMonitorWindow,
} from '../../types/patrols';
import type { PatrolLayout, PatrolTone } from './patrolPresentation';

export type MonitorTone = PatrolTone | 'blank';

export type MonitorStateInfo = { label: string; symbol: string; tone: MonitorTone; description: string };

export const MONITOR_STATE_INFO: Record<PatrolMonitorCellState, MonitorStateInfo> = {
  verified: { label: 'Verified', symbol: '✓', tone: 'success', description: 'Started on time; the patrol was verified automatically by S4.' },
  late_verified: { label: 'Late · Verified', symbol: '◷', tone: 'warning', description: 'Verified automatically by S4, but started after the start deadline.' },
  awaiting_verification: { label: 'Awaiting verification', symbol: '…', tone: 'warning', description: 'Completed; S4 has not finished verifying it yet.' },
  incomplete: { label: 'Incomplete', symbol: '◐', tone: 'warning', description: 'Started but not completed in time.' },
  flagged: { label: 'Needs review', symbol: '⚑', tone: 'warning', description: 'Completed with a flagged scan. Review the patrol record.' },
  not_verified: { label: 'Needs review', symbol: '⚑', tone: 'warning', description: 'Completed but S4 could not verify it. Review the patrol record.' },
  overdue: { label: 'Overdue', symbol: '!', tone: 'warning', description: 'The patrol window has ended and no patrol has started yet.' },
  awaiting_check: { label: 'Awaiting check', symbol: '?', tone: 'warning', description: 'The start deadline has passed; S4 has not yet checked whether it was missed.' },
  missed: { label: 'Missed', symbol: '✕', tone: 'danger', description: 'Confirmed missed by S4.' },
  in_progress: { label: 'In progress', symbol: '▶', tone: 'info', description: 'A Guard is on this patrol now.' },
  due: { label: 'Due now', symbol: '●', tone: 'info', description: 'The patrol window is open now.' },
  future: { label: 'Upcoming', symbol: '○', tone: 'neutral', description: 'The patrol window has not opened yet.' },
  not_on_duty: { label: 'No guard on duty', symbol: '–', tone: 'neutral', description: 'Scheduled, but no Guard was booked on for it.' },
  not_judged: { label: 'Not assessed', symbol: '·', tone: 'neutral', description: 'S4 checked this window and did not record it as missed.' },
  none: { label: 'No patrol window', symbol: '', tone: 'blank', description: 'No patrol is scheduled in this hour.' },
  off_duty: { label: 'Off duty', symbol: '', tone: 'blank', description: 'Outside this shift.' },
  not_required: { label: 'No patrol required', symbol: '', tone: 'blank', description: 'This shift owes no patrols.' },
};

export function monitorStateInfo(state: string | null | undefined): MonitorStateInfo {
  return MONITOR_STATE_INFO[state as PatrolMonitorCellState] ?? MONITOR_STATE_INFO.none;
}

/** The colour a state is drawn in (MonitorTone): green ONLY for an on-time, server-verified patrol; red ONLY for missed. */
export function monitorStateTone(state: string | null | undefined): MonitorTone {
  return monitorStateInfo(state).tone;
}

/** Whether a cell can be opened: it holds a patrol window, or an ad-hoc patrol started in that hour. */
export function monitorCellOpens(cell: Pick<PatrolMonitorCell, 'total' | 'windowKeys' | 'adHoc'>): boolean {
  return (cell.total > 0 && cell.windowKeys.length > 0) || (cell.adHoc ?? 0) > 0;
}

/**
 * A cell's aggregate count when the hour has more than one window, on the SAME basis as the site card: verified of the
 * windows due so far, and apart the windows still to come — "0/1 +1" (none of the 1 due verified, 1 later), "2/2",
 * "+2". Windows neither due nor later (no Guard on duty, not assessed) are in neither number. An older API without
 * `later` keeps the earlier verified/total reading.
 */
export function monitorCellCount(cell: Pick<PatrolMonitorCell, 'total' | 'owed' | 'verified' | 'later'>): string | null {
  if (cell.total <= 1) return null;
  if (cell.later == null) return `${cell.verified}/${cell.total}`;
  const due = cell.owed > 0 ? `${cell.verified}/${cell.owed}` : '';
  const later = cell.later > 0 ? `+${cell.later}` : '';
  return [due, later].filter(Boolean).join(' ') || null;
}

/** The same count in words, for screen readers and the cell detail: "0 of 1 due verified, 1 later". */
export function monitorCountWords(c: { verified: number; owed: number; later?: number | null }): string {
  const parts = [`${c.verified} of ${c.owed} due verified`];
  if (c.later) parts.push(`${c.later} later`);
  return parts.join(', ');
}

/**
 * The site card's patrol counts, on the same basis as the cells (usability update, 4 Nov 2026): verified of the patrols
 * due so far, and — a separate chip — the windows still to come. Ad-hoc patrols are never in either number.
 */
export function monitorCardVerified(counts: Pick<PatrolMonitorCounts, 'verified' | 'owed' | 'future'>): { label: string; hint: string | null; later: string | null } {
  return {
    label: `Due: ${counts.verified}/${counts.owed} verified`,
    hint: null,
    later: counts.future > 0 ? `Later: ${counts.future}` : null,
  };
}

/**
 * Row titles for a site's lanes. A Guard with more than one shift row that day gets the shift's times AND reference
 * ("Shift 77") on every one of their rows, in the row and in what a screen reader hears, so rows are never confused.
 */
export function monitorLaneLabels(
  lanes: ReadonlyArray<Pick<PatrolMonitorLane, 'key' | 'kind' | 'guardName' | 'guardId' | 'shiftId' | 'shiftStart' | 'shiftEnd' | 'requirement'>>,
  timeZone: string,
  day: string | null,
): Map<string, { title: string; sub: string; spoken: string }> {
  const titles = lanes.filter((l) => l.kind === 'shift').map((l) => monitorLaneTitle(l));
  const repeated = new Set(titles.filter((t, i) => titles.indexOf(t) !== i));
  const out = new Map<string, { title: string; sub: string; spoken: string }>();
  for (const lane of lanes) {
    const title = monitorLaneTitle(lane);
    if (lane.kind === 'site') { out.set(lane.key, { title, sub: 'Any Guard on duty', spoken: title }); continue; }
    const times = lane.requirement && !lane.requirement.effectiveRequired ? 'No patrols required' : monitorShiftTimes(lane, timeZone, day);
    const ref = repeated.has(title) && lane.shiftId != null ? `Shift ${lane.shiftId}` : null;
    out.set(lane.key, { title, sub: [times, ref].filter(Boolean).join(' · '), spoken: ref ? `${title} (${ref})` : title });
  }
  return out;
}

const STATE_PHRASES: Record<string, string> = {
  verified: 'verified automatically',
  late_verified: 'verified automatically, but started late',
  awaiting_verification: 'completed, awaiting automatic verification',
  incomplete: 'incomplete',
  flagged: 'needs review (a scan was flagged)',
  not_verified: 'needs review (not verified automatically)',
  overdue: 'overdue: no patrol has started',
  awaiting_check: 'start deadline passed, awaiting S4\'s missed-patrol check',
  missed: 'missed (confirmed by S4)',
  in_progress: 'in progress',
  due: 'due now',
  future: 'not open yet',
  not_on_duty: 'no Guard on duty',
  not_judged: 'not assessed',
};

/**
 * One plain-English sentence for an opened hour cell, from data already on screen, e.g.
 * "1 patrol in this hour: 14:35–15:05 verified automatically (Ava Thompson, started 14:35, 2 photos)."
 */
export function monitorCellSummary(input: {
  windows: ReadonlyArray<Pick<PatrolMonitorWindow, 'start' | 'end' | 'state' | 'runId'>>;
  runs: Record<string, Pick<PatrolMonitorRun, 'guardName' | 'guardId' | 'startedAtDevice' | 'photos'> | undefined>;
  laneGuard: string | null;
  adHoc: number;
  timeZone: string;
  day: string | null;
}): string {
  const { windows, runs, timeZone, day } = input;
  const extra = input.adHoc ? `${input.adHoc} additional patrol${input.adHoc === 1 ? '' : 's'} not counted` : '';
  if (!windows.length) return extra ? `No scheduled patrol in this hour; ${extra}.` : 'No scheduled patrol in this hour.';
  const items = windows.map((w) => {
    const run = w.runId != null ? runs[String(w.runId)] : undefined;
    const when = `${monitorClockOnDay(w.start, timeZone, day)}–${monitorClockOnDay(w.end, timeZone, day)}`;
    const phrase = STATE_PHRASES[w.state] ?? monitorStateInfo(w.state).label.toLowerCase();
    if (!run) return `${when} ${phrase}`;
    const who = run.guardName ?? input.laneGuard ?? `Guard #${run.guardId}`;
    const photos = run.photos.taken ? `, ${run.photos.taken} photo${run.photos.taken === 1 ? '' : 's'}` : '';
    return `${when} ${phrase} (${who}, started ${monitorClock(run.startedAtDevice, timeZone)}${photos})`;
  });
  const head = `${windows.length} patrol${windows.length === 1 ? '' : 's'} in this hour: `;
  return `${head}${items.join('; ')}${extra ? `; plus ${extra}` : ''}.`;
}

/** Ad-hoc patrols per hour for the Additional patrols row: hour index → count. */
export function monitorAdHocByHour(otherRuns: ReadonlyArray<{ hour?: number | null }>): Map<number, number> {
  const out = new Map<number, number>();
  for (const o of otherRuns) if (o.hour != null) out.set(o.hour, (out.get(o.hour) ?? 0) + 1);
  return out;
}

/**
 * Why a patrol's received evidence has not (yet) satisfied its window, from the run's COUNTS (no evidence is read): the
 * photos S4 still needs, and the required QR checkpoints not verified. Nothing for a verified window.
 */
export function monitorEvidenceGaps(
  run: Pick<PatrolMonitorRun, 'photos' | 'checkpoints' | 'status'>,
  state: string,
): string[] {
  if (state === 'verified' || state === 'late_verified') return [];
  const out: string[] = [];
  if (run.photos.missing > 0) {
    out.push(`${run.photos.taken} photo${run.photos.taken === 1 ? '' : 's'} received; S4 still needs ${run.photos.missing} more for this patrol.`);
  } else if (run.photos.taken > run.photos.verified) {
    const waiting = run.photos.taken - run.photos.verified;
    out.push(`${waiting} photo${waiting === 1 ? ' is' : 's are'} still being received and checked by S4.`);
  }
  const { required, verified } = run.checkpoints;
  if (required != null && (verified ?? 0) < required) out.push(`${verified ?? 0} of ${required} required QR checkpoints verified.`);
  if (run.checkpoints.qrRuleMissing) out.push('QR is required but this site has no checkpoint route, so S4 cannot verify it.');
  if (!out.length && run.status === 'in_progress') out.push('The patrol is still in progress.');
  return out;
}

/** Why an ad-hoc patrol counts towards no scheduled window, in plain English. */
export function monitorAdHocExplanation(code: string | null | undefined): string {
  switch (code) {
    case 'ambiguous':
      return 'More than one scheduled patrol window was open when it started, so S4 could not tell which one it was for. It counts towards neither.';
    case 'route_not_shown':
      return 'A scheduled QR patrol was open, but the Guard\'s phone was not showing its checkpoints for this patrol, so S4 did not link it (the Guard could not see what it required).';
    case 'already_covered':
      return 'Its scheduled patrol window already had a patrol, so this is an extra patrol. It does not count again.';
    case 'unmatched':
      return 'It names a scheduled patrol window that is not shown for this day.';
    default:
      return 'The Guard\'s phone started it without a scheduled patrol window (for example, its patrol plan was out of date), so it does not count towards a scheduled patrol.';
  }
}

/** Hour heading: "14", and the repeated autumn hour marked "01 (2nd)". */
export function monitorHourLabel(hour: Pick<PatrolMonitorHour, 'label' | 'repeated'>): string {
  return hour.repeated ? `${hour.label} (2nd)` : hour.label;
}

/** Where to show the UTC offset under an hour: the first hour, and wherever it changes (a clock change). */
export function monitorHourOffsetShown(hours: ReadonlyArray<Pick<PatrolMonitorHour, 'offset'>>, index: number): boolean {
  return index === 0 || hours[index].offset !== hours[index - 1]?.offset;
}

export function monitorLaneTitle(lane: Pick<PatrolMonitorLane, 'kind' | 'guardName' | 'guardId'>): string {
  if (lane.kind === 'site') return 'Site Patrol';
  if (lane.guardName) return lane.guardName;
  return lane.guardId == null ? 'Unassigned shift' : `Guard #${lane.guardId}`;
}

export function monitorCellA11yLabel(
  laneTitle: string,
  hour: Pick<PatrolMonitorHour, 'label' | 'repeated' | 'offset'>,
  cell: Pick<PatrolMonitorCell, 'state' | 'total' | 'owed' | 'verified' | 'later' | 'adHoc'>,
): string {
  const info = monitorStateInfo(cell.state);
  const when = `${hour.label}:00${hour.repeated ? ` (second time, ${hour.offset})` : ''}`;
  const count = cell.total > 1
    ? cell.later == null ? `, ${cell.verified} of ${cell.total} verified` : `, ${monitorCountWords(cell)}`
    : '';
  const adHoc = cell.adHoc ? `, ${cell.adHoc} ad-hoc patrol${cell.adHoc === 1 ? '' : 's'}` : '';
  return `${laneTitle}, ${when}: ${info.label}${count}${adHoc}`;
}

/** The windows a cell holds, in time order. */
export function monitorCellWindows(lane: Pick<PatrolMonitorLane, 'windows'>, cell: Pick<PatrolMonitorCell, 'windowKeys'>): PatrolMonitorWindow[] {
  const keys = new Set(cell.windowKeys);
  return lane.windows.filter((w) => keys.has(w.key)).sort((a, b) => a.start.localeCompare(b.start));
}

// ─── sites ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MONITOR_SITE_STATUS: Record<PatrolMonitorSiteStatus, { label: string; symbol: string; tone: PatrolTone }> = {
  attention: { label: 'Needs attention', symbol: '!', tone: 'warning' },
  watch: { label: 'Watch', symbol: '⚑', tone: 'warning' },
  on_track: { label: 'On track', symbol: '✓', tone: 'info' },
  not_started: { label: 'Not started yet', symbol: '○', tone: 'neutral' },
  no_patrols: { label: 'No patrols due', symbol: '–', tone: 'neutral' },
};

export function monitorSiteStatusInfo(status: string | null | undefined) {
  return MONITOR_SITE_STATUS[status as PatrolMonitorSiteStatus] ?? MONITOR_SITE_STATUS.no_patrols;
}

export type MonitorSiteGroup = 'attention' | 'healthy' | 'none';

export const MONITOR_SITE_GROUPS: Array<{ id: MonitorSiteGroup; label: string }> = [
  { id: 'attention', label: 'Needs attention' },
  { id: 'healthy', label: 'On track' },
  { id: 'none', label: 'No patrols due' },
];

/** Sites needing attention first, then healthy sites, then sites with no patrols due (yet or at all). */
export function monitorSiteGroup(status: string | null | undefined): MonitorSiteGroup {
  if (status === 'attention' || status === 'watch') return 'attention';
  if (status === 'on_track') return 'healthy';
  return 'none';
}

/** Flagged and not-verified patrols, which both read "Needs review". */
export function monitorNeedsReview(counts: Pick<PatrolMonitorCounts, 'flagged' | 'notVerified'> | null | undefined): number {
  return (counts?.flagged ?? 0) + (counts?.notVerified ?? 0);
}

const STATUS_ORDER: PatrolMonitorSiteStatus[] = ['attention', 'watch', 'on_track', 'not_started', 'no_patrols'];
const GROUP_ORDER: MonitorSiteGroup[] = ['attention', 'healthy', 'none'];

/** Priority order: group, then status, then the most missed / needing review, then by name. Never mutates its input. */
export function sortMonitorSites<T extends Pick<PatrolMonitorSummarySite, 'siteId' | 'siteName' | 'status' | 'counts'>>(sites: readonly T[]): T[] {
  const rank = (s: T) => STATUS_ORDER.indexOf(s.status) < 0 ? STATUS_ORDER.length : STATUS_ORDER.indexOf(s.status);
  return [...sites].sort((a, b) =>
    GROUP_ORDER.indexOf(monitorSiteGroup(a.status)) - GROUP_ORDER.indexOf(monitorSiteGroup(b.status))
    || rank(a) - rank(b)
    || (b.counts?.missed ?? 0) - (a.counts?.missed ?? 0)
    || monitorNeedsReview(b.counts) - monitorNeedsReview(a.counts)
    || a.siteName.localeCompare(b.siteName)
    || a.siteId - b.siteId);
}

export type MonitorStatusFilter = 'all' | MonitorSiteGroup;

export function filterMonitorSites<T extends Pick<PatrolMonitorSummarySite, 'clientId' | 'status'>>(sites: readonly T[], filter: { clientId: number | null; status: MonitorStatusFilter }): T[] {
  return sites.filter((s) => (filter.clientId == null || s.clientId === filter.clientId) && (filter.status === 'all' || monitorSiteGroup(s.status) === filter.status));
}

/** The clients the summary names (no extra request), by name. */
export function monitorClients(sites: ReadonlyArray<Pick<PatrolMonitorSummarySite, 'clientId' | 'clientName'>>): Array<{ id: number; name: string }> {
  const seen = new Map<number, string>();
  for (const s of sites) if (s.clientId != null && !seen.has(s.clientId)) seen.set(s.clientId, s.clientName || `Client #${s.clientId}`);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

// ─── times (always the site's own zone) ───────────────────────────────────────────────────────────────────────────

const clockFormatters = new Map<string, Intl.DateTimeFormat>();
function clockParts(iso: string, timeZone: string): { date: string; time: string } | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  let f = clockFormatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    }
    clockFormatters.set(timeZone, f);
  }
  const parts = f.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/** "HH:MM" at the site. */
export function monitorClock(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  return clockParts(iso, timeZone)?.time ?? '—';
}

/** "HH:MM", marked with the day when it is not the site day shown: "06:00 (+1 day)", "22:00 (−1 day)". */
export function monitorClockOnDay(iso: string | null | undefined, timeZone: string, day: string | null): string {
  if (!iso) return '—';
  const p = clockParts(iso, timeZone);
  if (!p) return '—';
  if (!day || p.date === day) return p.time;
  const diff = Math.round((Date.parse(`${p.date}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(diff) || diff === 0) return p.time;
  return `${p.time} (${diff > 0 ? '+' : '−'}${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'})`;
}

/** A shift lane's times on the site day: "22:00 – 06:00 (+1 day)" for an overnight shift. */
export function monitorShiftTimes(lane: Pick<PatrolMonitorLane, 'shiftStart' | 'shiftEnd'>, timeZone: string, day: string | null): string {
  if (!lane.shiftStart || !lane.shiftEnd) return '';
  return `${monitorClockOnDay(lane.shiftStart, timeZone, day)} – ${monitorClockOnDay(lane.shiftEnd, timeZone, day)}`;
}

export function monitorNextWindowLabel(iso: string | null | undefined, timeZone: string, day: string | null): string {
  return iso ? `Next ${monitorClockOnDay(iso, timeZone, day)}` : 'No more patrols due';
}

/** YYYY-MM-DD ± days, on the calendar (no zone involved). */
export function shiftMonitorDate(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return at.toISOString().slice(0, 10);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Tue 03/11/2026". */
export function monitorDateLabel(date: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!m) return '';
  return `${WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()]} ${m[3]}/${m[2]}/${m[1]}`;
}

// ─── layout ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The hour grid: the lane-name column stays fixed while the hours scroll. Cells keep a 44 px touch target. */
export function monitorGridLayout(layout: Pick<PatrolLayout, 'mode'>): { nameWidth: number; cellSize: number } {
  if (layout.mode === 'mobile') return { nameWidth: 112, cellSize: 44 };
  if (layout.mode === 'tablet') return { nameWidth: 160, cellSize: 44 };
  return { nameWidth: 200, cellSize: 44 };
}
