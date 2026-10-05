import type { UrgentOperationalItem } from './CompanyLiveOperationsWorkspace';
import { classifyLiveOperation } from './liveOperationsPolicy';
import { welfareCell, type OperationsTone } from './operationsPresentation';
import {
  DEFAULT_SITE_TIME_ZONE,
  formatSiteDateInput,
  formatSiteDateLong,
  formatSiteTime,
  shiftSiteDateInput,
  siteToday,
} from '../../services/siteTime';
import type { ShiftOperationsView } from '../../types/models';

/**
 * The Company Dashboard, as pure presentation over data the screen has already loaded.
 *
 * The dashboard answers one question — what needs the operator's attention right now — and then who is
 * working, whether shifts are covered, what is next and whether compliance needs action. It summarises
 * the operational surfaces and leads into them; it never recalculates what they decide. Live is the
 * Live Operations policy's own "in progress", Welfare wording is the board's own cell, compliance counts
 * are the Compliance screen's own metrics, and every time is read on the SITE's clock.
 *
 * KPI definitions (the numbers on the top row):
 *  - Active Sites   — company sites whose status is not archived.
 *  - Live Shifts    — shifts the Live Operations policy classifies as in progress right now (status
 *                     in_progress, or started with a successful Book On). The same set the Live Operations
 *                     "Live Shifts" count reads with no filters applied. Accepted shifts that have not
 *                     started are NOT live.
 *  - Coverage Gaps  — uncovered shifts reported by the coverage endpoint (uncoveredOnly).
 *  - Open Incidents — incidents with status open or in_review.
 *  - Alerts         — safety alerts that are not closed AND are actionable: a missed Welfare Check's
 *                     per-window evidence rows are excluded, leaving its one shift-level summary, exactly
 *                     as Attention Now counts it.
 */

const MINUTE_MS = 60_000;

// ─── Attention Required ──────────────────────────────────────────────────────

/**
 * Priority rank per attention category. Lower is more urgent.
 *
 *  0 active panic / SOS
 *  1 other immediate safety and welfare alerts
 *  2 incident explicitly marked critical
 *  3 other unresolved incident
 *  4 missed Welfare Check
 *  5 missing or late Book On (Guard not booked on, missed shift)
 *  6 missing Book Off
 *  7 coverage (uncovered shift, rejected offer)
 *  8 lower-priority warnings (upcoming risk, Site Request)
 *
 * This only ORDERS the existing categories, using the incident's own recorded severity; it decides
 * nothing about whether an item exists.
 */
export const ATTENTION_PRIORITY_RANK: Record<UrgentOperationalItem['category'], number> = {
  panic: 0,
  safety: 1,
  incident: 3,
  missed_check_call: 4,
  late_start: 5,
  missed_shift: 5,
  missing_book_off: 6,
  uncovered_shift: 7,
  rejected_offer: 7,
  upcoming_risk: 8,
  site_request: 8,
};

export const DASHBOARD_ATTENTION_LIMIT = 5;

/** The incident severity an operator recorded as critical; the only severity that outranks other incidents. */
export function isCriticalIncident(item: { category: string; severity?: string | null }): boolean {
  return item.category === 'incident' && (item.severity || '').trim().toLowerCase() === 'critical';
}

export function attentionRank(item: UrgentOperationalItem): number {
  if (isCriticalIncident(item)) return 2;
  return ATTENTION_PRIORITY_RANK[item.category] ?? 8;
}

const tierOf = attentionRank;

function timeOf(value: string | null | undefined): number {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Attention items, most urgent first: by priority tier, then the longest-outstanding first within a
 * tier (the item that has waited longest is the one a control room clears next), then by id so the
 * order is stable between refreshes.
 */
export function prioritiseAttention(items: readonly UrgentOperationalItem[]): UrgentOperationalItem[] {
  return [...items].sort((a, b) =>
    tierOf(a) - tierOf(b)
    || timeOf(a.occurredAt) - timeOf(b.occurredAt)
    || a.id.localeCompare(b.id));
}

export type AttentionSummary = {
  total: number;
  shown: UrgentOperationalItem[];
  hasMore: boolean;
};

export function summariseAttention(
  items: readonly UrgentOperationalItem[],
  limit = DASHBOARD_ATTENTION_LIMIT,
): AttentionSummary {
  const ordered = prioritiseAttention(items);
  return { total: ordered.length, shown: ordered.slice(0, limit), hasMore: ordered.length > limit };
}

/** "8 min", "1h 05m", "2d 3h". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The one timing line an attention row has room for, from the item's own timestamp.
 *
 * Shift-derived items are dated by the shift's scheduled start; persisted alerts and incidents by when
 * they were raised. A missing Book Off already carries the backend-derived "how overdue" summary,
 * counted from the scheduled end, so that is used as it is.
 */
export function attentionTiming(item: UrgentOperationalItem, now: Date): string {
  if (item.category === 'missing_book_off') return item.message;
  const at = Date.parse(item.occurredAt);
  if (!Number.isFinite(at)) return '';
  const delta = now.getTime() - at;
  switch (item.category) {
    case 'late_start':
      return `${formatDuration(delta)} late`;
    case 'uncovered_shift':
    case 'rejected_offer':
    case 'missed_shift':
    case 'upcoming_risk':
      return delta < 0 ? `Starts in ${formatDuration(-delta)}` : `Started ${formatDuration(delta)} ago`;
    default:
      return delta < 0 ? 'Raised just now' : `Raised ${formatDuration(delta)} ago`;
  }
}

// ─── Live Operations ─────────────────────────────────────────────────────────

export type DashboardShift = {
  id: number;
  start: string;
  end: string;
  status?: string | null;
  siteId?: number | null;
  siteName?: string | null;
  site?: { id?: number | null; name?: string | null } | null;
  guardId?: number | null;
  guard?: { id?: number | null; fullName?: string | null } | null;
};

export type AttendanceTimes = { checkInAt: string | null; checkOutAt: string | null };

/** Live rows shown on the dashboard; the rest are counted and one click away in Live Operations. */
export const DASHBOARD_LIVE_ROWS_LIMIT = 6;

export type LiveShiftRow = {
  shiftId: number;
  siteName: string;
  guardName: string;
  timeRange: string;
  bookedOn: string | null;
  welfare: { label: string; detail: string | null; tone: OperationsTone } | null;
  lastActivity: string | null;
  /** Open attention items for this shift. */
  attentionCount: number;
  /** "In progress", or "Past scheduled end" for a shift still being worked after its end. */
  stateLabel: string;
};

export function siteIdOf(shift: DashboardShift): number | null {
  return shift.site?.id ?? shift.siteId ?? null;
}

export function siteNameOf(shift: DashboardShift): string {
  return shift.site?.name || shift.siteName || 'Unnamed site';
}

export function guardNameOf(shift: DashboardShift): string | null {
  return shift.guard?.fullName || null;
}

export function isUnassigned(shift: DashboardShift): boolean {
  const status = (shift.status || '').trim().toLowerCase();
  return !(shift.guard?.id ?? shift.guardId ?? null) || ['unfilled', 'unassigned', 'planned', 'scheduled'].includes(status);
}

/** The shifts Live Operations itself counts as in progress — no filters, same policy, same clock. */
export function selectLiveShifts<T extends DashboardShift>(
  shifts: readonly T[],
  attendanceByShiftId: ReadonlyMap<number, AttendanceTimes>,
  now: Date,
): T[] {
  return shifts.filter((shift) => {
    const decision = classifyLiveOperation(
      { id: shift.id, start: shift.start, end: shift.end, status: shift.status || '' },
      { now, bookedOn: Boolean(attendanceByShiftId.get(shift.id)?.checkInAt) },
    );
    return decision.include && decision.reason === 'in_progress';
  });
}

function latest(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = Date.parse(value || '');
    if (Number.isFinite(ms) && ms > bestMs) {
      best = value as string;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * One compact row per live shift, carrying only fields the loaded data supports.
 *
 * Booked on is the backend operations projection's Book On, falling back to the attendance record.
 * Welfare is the Live Operations board's own cell, and only when the shift has a Welfare obligation.
 * Last activity is the latest recorded Book On, Welfare Check or Log Book entry. Rows with open
 * attention items come first, then by scheduled start.
 */
export function buildLiveShiftRows(
  shifts: readonly DashboardShift[],
  input: {
    attendanceByShiftId: ReadonlyMap<number, AttendanceTimes>;
    operationsByShiftId: ReadonlyMap<number, ShiftOperationsView>;
    attentionItems: readonly UrgentOperationalItem[];
    resolveZone: (siteId: number | null) => string;
    now: Date;
  },
): LiveShiftRow[] {
  const attentionByShift = new Map<number, number>();
  input.attentionItems.forEach((item) => {
    if (item.shiftId != null) attentionByShift.set(item.shiftId, (attentionByShift.get(item.shiftId) || 0) + 1);
  });

  return selectLiveShifts(shifts, input.attendanceByShiftId, input.now)
    .map((shift) => {
      const zone = input.resolveZone(siteIdOf(shift));
      const operations = input.operationsByShiftId.get(shift.id) ?? null;
      const bookOnAt = operations?.bookOnAt || input.attendanceByShiftId.get(shift.id)?.checkInAt || null;
      const welfareView = operations?.welfare && operations.welfare.enabled && operations.welfare.status !== 'not_applicable'
        ? welfareCell(operations.welfare, zone)
        : null;
      const lastActivityAt = latest([bookOnAt, operations?.welfare?.lastWelfareAt, operations?.logBook?.lastEntryAt]);
      const endMs = Date.parse(shift.end);
      return {
        shiftId: shift.id,
        siteName: siteNameOf(shift),
        guardName: guardNameOf(shift) || 'No Guard recorded',
        timeRange: `${formatSiteTime(shift.start, zone)}–${formatSiteTime(shift.end, zone)}`,
        bookedOn: bookOnAt ? formatSiteTime(bookOnAt, zone) : null,
        welfare: welfareView
          ? {
            label: welfareView.label,
            detail: [welfareView.detail, welfareView.missedSummary].filter(Boolean).join(' · ') || null,
            tone: welfareView.tone,
          }
          : null,
        lastActivity: lastActivityAt ? formatSiteTime(lastActivityAt, zone) : null,
        attentionCount: attentionByShift.get(shift.id) || 0,
        stateLabel: Number.isFinite(endMs) && input.now.getTime() > endMs ? 'Past scheduled end' : 'In progress',
        _start: timeOf(shift.start),
      };
    })
    .sort((a, b) => (b.attentionCount > 0 ? 1 : 0) - (a.attentionCount > 0 ? 1 : 0) || a._start - b._start)
    .map(({ _start, ...row }) => row);
}

// ─── Today's Coverage ────────────────────────────────────────────────────────

export type CoverageSummary = { liveNow: number; uncovered: number; gapSites: number };

export function summariseCoverage(
  liveNow: number,
  uncoveredShifts: ReadonlyArray<{ siteId?: number | null }>,
): CoverageSummary {
  return {
    liveNow,
    uncovered: uncoveredShifts.length,
    gapSites: new Set(uncoveredShifts.map((row) => row.siteId).filter((id) => id != null)).size,
  };
}

// ─── Upcoming Shifts ─────────────────────────────────────────────────────────

export const DASHBOARD_UPCOMING_LIMIT = 5;
/** An unassigned shift starting inside this window is pulled into the list ahead of later assigned work. */
export const UNASSIGNED_PRIORITY_HOURS = 24;

export type UpcomingShiftRow = {
  shiftId: number;
  dayLabel: string;
  timeRange: string;
  siteName: string;
  guardName: string | null;
  unassigned: boolean;
};

export type UpcomingGroup = { label: string; rows: UpcomingShiftRow[] };

/**
 * The next few shifts that have not started, grouped by site-local day (Today, Tomorrow, then the date).
 *
 * Selection favours what needs action: unassigned shifts starting within the next 24 hours are taken
 * first, then the remaining places go to the next shifts by start time. The rows are then shown in
 * start order.
 */
export function buildUpcomingShifts(
  shifts: readonly DashboardShift[],
  input: { resolveZone: (siteId: number | null) => string; now: Date; limit?: number },
): UpcomingGroup[] {
  const limit = input.limit ?? DASHBOARD_UPCOMING_LIMIT;
  const nowMs = input.now.getTime();
  const candidates = shifts
    .filter((shift) => {
      const status = (shift.status || '').trim().toLowerCase();
      return timeOf(shift.start) > nowMs && !['completed', 'cancelled', 'in_progress'].includes(status);
    })
    .sort((a, b) => timeOf(a.start) - timeOf(b.start));

  const urgentUnassigned = candidates.filter(
    (shift) => isUnassigned(shift) && timeOf(shift.start) - nowMs <= UNASSIGNED_PRIORITY_HOURS * 60 * MINUTE_MS,
  );
  const picked = new Set<number>(urgentUnassigned.slice(0, limit).map((shift) => shift.id));
  for (const shift of candidates) {
    if (picked.size >= limit) break;
    picked.add(shift.id);
  }

  const groups: UpcomingGroup[] = [];
  candidates
    .filter((shift) => picked.has(shift.id))
    .forEach((shift) => {
      const zone = input.resolveZone(siteIdOf(shift));
      const today = siteToday(zone, input.now);
      const day = formatSiteDateInput(shift.start, zone);
      const dayLabel = day === today
        ? 'Today'
        : day === shiftSiteDateInput(today, 1)
          ? 'Tomorrow'
          : formatDayLong(shift.start, zone);
      const row: UpcomingShiftRow = {
        shiftId: shift.id,
        dayLabel,
        timeRange: `${formatSiteTime(shift.start, zone)}–${formatSiteTime(shift.end, zone)}`,
        siteName: siteNameOf(shift),
        guardName: guardNameOf(shift),
        unassigned: isUnassigned(shift),
      };
      const group = groups.find((entry) => entry.label === dayLabel);
      if (group) group.rows.push(row);
      else groups.push({ label: dayLabel, rows: [row] });
    });
  return groups;
}

// ─── Header freshness ────────────────────────────────────────────────────────

/**
 * The zone the dashboard header reads its clock in.
 *
 * Site timezone is S4's authority and there is no company-level zone. When every active site shares one
 * zone that is the company's operational clock; otherwise the platform default is used and the header
 * names it, so a multi-zone company is never shown an unlabelled time.
 */
export function dashboardDisplayZone(sites: ReadonlyArray<{ timezone?: string | null; status?: string | null }>): {
  zone: string;
  mixed: boolean;
} {
  const zones = new Set(
    sites
      .filter((site) => (site.status || 'active').toLowerCase() !== 'archived')
      .map((site) => site.timezone || DEFAULT_SITE_TIME_ZONE),
  );
  if (zones.size === 1) return { zone: [...zones][0], mixed: false };
  return { zone: DEFAULT_SITE_TIME_ZONE, mixed: zones.size > 1 };
}

/**
 * "Monday, 5 October" on the given zone's calendar.
 *
 * Assembled from Intl's parts rather than taken from its long format, whose punctuation differs between
 * ICU versions (some print "Monday 5 October"), so every runtime shows the same label.
 */
export function formatDayLong(iso: string, zone: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '—';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' })
      .formatToParts(instant);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('weekday')}, ${get('day')} ${get('month')}`;
  } catch {
    return formatSiteDateLong(iso, zone);
  }
}

/** "Monday, 5 October · 18:55". */
export function formatDashboardClock(now: Date, zone: string): string {
  const iso = now.toISOString();
  return `${formatDayLong(iso, zone)} · ${formatSiteTime(iso, zone)}`;
}

export type SuccessfulLoad<S extends string = string> = { section: S; at: Date };

/**
 * The freshness record after a load. Only a load in which EVERY source succeeded moves it forward; a
 * partial or total failure keeps the previous record, so the header never claims an update that did not
 * fully happen.
 */
export function nextSuccessfulLoad<S extends string>(
  previous: SuccessfulLoad<S> | null,
  section: S,
  failureCount: number,
  at: Date,
): SuccessfulLoad<S> | null {
  return failureCount === 0 ? { section, at } : previous;
}

/** "Updated 18:55", or null before the first successful load. */
export function formatUpdatedLabel(updatedAt: Date | null, zone: string): string | null {
  return updatedAt ? `Updated ${formatSiteTime(updatedAt.toISOString(), zone)}` : null;
}
