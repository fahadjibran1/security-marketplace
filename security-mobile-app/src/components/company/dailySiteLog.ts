// The Daily Site Log (Occurrence Book): one site's operational day, assembled from records only.
//
// EVERY EVENT IS TRACEABLE. Each entry in the stream comes from a stored row — an attendance time, a
// daily log, an incident, a safety alert — or from a required period the backend's own window engine
// graded. Nothing is added to make the day look complete, and a record type with nothing in it
// produces no events rather than a reassuring "none".
//
// It is pure, so the screen, the printed A4 page and the export are three renderings of ONE reading
// of the day and cannot quietly disagree.

import {
  formatInstantTime, formatUkDate, formatUkDateTime, formatUkRange,
  isWithinSiteDay, siteDayWindow, type SiteDayWindow,
} from '../../services/siteTime';
import { isLogBookEntry, logBookCompliance, logBookPeriods, type LogBookCompliance, type LogBookPeriod } from './logBookRegister';
import { isWelfareEvidence } from '../shifts/welfareEvidence';
import { resolutionLabel } from './alertResolution';
import type { DailyLog, Incident, SafetyAlert, Shift, ShiftOperationsView } from '../../types/models';

export const NOT_RECORDED = '—';

export type SiteLogEventKind =
  | 'book_on'
  | 'log_book'
  | 'welfare_check'
  | 'log_book_missed'
  | 'incident_reported'
  | 'incident_in_review'
  | 'incident_resolved'
  | 'site_request'
  | 'site_request_resolved'
  | 'emergency'
  | 'emergency_resolved'
  | 'book_off'
  | 'handover';

export type SiteLogEvent = {
  key: string;
  kind: SiteLogEventKind;
  /** The time shown, on the site's clock. */
  at: string;
  atMs: number;
  /** The short name of what happened. */
  label: string;
  /**
   * The body. For a Log Book entry this is the guard's FULL text — the occurrence book is the place
   * it is read in full. For an incident it is a one-line reference, never the Incident Report.
   */
  detail: string;
  guardName: string;
};

export type ShiftAttendanceRow = {
  shiftId: number;
  guardName: string;
  scheduled: string;
  bookOn: string;
  bookOff: string;
  state: string;
};

/**
 * A durable item raised on the report date whose outcome landed later.
 *
 * It is NOT in the occurrence record, because it did not happen on this day — but dropping it
 * silently would leave a client reading "Incident #4 reported" with no idea it was dealt with. Every
 * later timestamp carries its own DATE, so nothing here can be mistaken for the report date.
 */
export type FollowUpOutcome = {
  key: string;
  /** e.g. "Incident #4 — Broken fence". */
  title: string;
  /** Label/value pairs, each already formatted with its full date where it is a later day. */
  lines: Array<{ label: string; value: string }>;
  /** True when nothing has closed it yet. */
  outstanding: boolean;
};

export type DailySiteLogModel = {
  companyName: string;
  clientName: string;
  siteName: string;
  /** The site-local day this report covers, already formatted for a reader. */
  dateLabel: string;
  dateKey: string;
  timeZone: string;
  shifts: ShiftAttendanceRow[];
  events: SiteLogEvent[];
  logBook: LogBookCompliance;
  /** The periods behind the compliance counts, for the surfaces that show them. */
  periods: LogBookPeriod[];
  /** Items raised today whose outcome came later. Empty when there are none. */
  followUps: FollowUpOutcome[];
  welfare: { required: number; completed: number; missed: number; applicable: boolean };
  operational: { incidents: number; siteRequests: number; emergencies: number };
};

export type DailySiteLogInput = {
  siteId: number;
  /** Site-local YYYY-MM-DD. */
  dateKey: string;
  dateLabel: string;
  timeZone: string;
  companyName: string;
  shifts: Shift[];
  operationsByShiftId: Map<number, ShiftOperationsView>;
  dailyLogs: DailyLog[];
  incidents: Incident[];
  alerts: SafetyAlert[];
};

/** Order for events recorded at the same instant. Lower sorts first. */
const EVENT_RANK: Record<SiteLogEventKind, number> = {
  book_on: 0,
  log_book: 1,
  welfare_check: 1,
  site_request: 1,
  site_request_resolved: 1,
  incident_reported: 1,
  incident_in_review: 1,
  incident_resolved: 1,
  emergency: 1,
  emergency_resolved: 1,
  // A missed period is reported at the moment the period closed, after anything recorded within it.
  log_book_missed: 2,
  book_off: 3,
  handover: 4,
};

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);
const ok = (value: number): boolean => Number.isFinite(value);

/** Site Request is the current name; `welfare` is the historical stored type for the same thing. */
const SITE_REQUEST_TYPES = new Set(['site_request', 'welfare']);

/**
 * Assemble the day.
 *
 * The shifts given are the ones that belong to this site and day; everything else is filtered to
 * those shifts, so a record from another site or another night can never appear.
 */
export function buildDailySiteLog(input: DailySiteLogInput): DailySiteLogModel {
  const { timeZone } = input;
  const shiftIds = new Set(input.shifts.map((shift) => shift.id));
  const at = (iso: string) => formatInstantTime(iso, timeZone);
  /** The site's own midnight-to-midnight, DST included. Null only for a malformed date key. */
  const dayWindow: SiteDayWindow | null = siteDayWindow(input.dateKey, timeZone);
  const inDay = (iso: string | null | undefined) => isWithinSiteDay(iso, dayWindow);
  /** A later-day moment always carries its date, so it can never read as the report date. */
  const stamped = (iso: string | null | undefined) => formatUkDateTime(iso, timeZone, NOT_RECORDED);

  const site = input.shifts[0]?.site ?? null;
  const siteName = site?.name || input.shifts[0]?.siteName || '';
  const clientName = site?.client?.name || site?.clientName || '';

  const events: SiteLogEvent[] = [];
  const push = (
    kind: SiteLogEventKind, key: string, iso: string | null | undefined,
    label: string, detail: string, guardName: string,
  ) => {
    const stamp = ms(iso);
    if (!ok(stamp)) return; // A record with no usable time is omitted, never placed by guesswork.
    /**
     * THE DAY IS THE BOUNDARY, NOT THE SHIFT.
     *
     * A record reached this report because it belongs to a shift that touched the day; that is not
     * the same as having happened on it. A Welfare Check made two days later, or an incident
     * resolved two days later, is a fact about ITS day — rendering it time-only in this one made a
     * 02-10 action read as 30-09 on a client document. Anything outside the window is dropped here
     * and, where it is a durable outcome, reported separately under Follow-up with its full date.
     */
    if (!isWithinSiteDay(iso, dayWindow)) return;
    events.push({ key, kind, at: at(iso as string), atMs: stamp, label, detail, guardName });
  };

  // ── attendance ────────────────────────────────────────────────────────────
  const shiftRows: ShiftAttendanceRow[] = input.shifts.map((shift) => {
    const operations = input.operationsByShiftId.get(shift.id);
    const guardName = shift.guard?.fullName || 'Unassigned';

    push('book_on', `on-${shift.id}`, operations?.bookOnAt, 'Book On', `${guardName} booked on`, guardName);
    push('book_off', `off-${shift.id}`, operations?.bookOffAt, 'Book Off', `${guardName} booked off`, guardName);
    if (shift.closeOutNotes?.trim()) {
      // Anchored to Book Off, or to the scheduled end when the guard never booked off.
      push(
        'handover', `handover-${shift.id}`, operations?.bookOffAt || shift.end,
        'Handover note', shift.closeOutNotes.trim(), guardName,
      );
    }

    return {
      shiftId: shift.id,
      guardName,
      scheduled: formatUkRange(shift.start, shift.end, timeZone, NOT_RECORDED),
      bookOn: operations?.bookOnAt ? at(operations.bookOnAt) : NOT_RECORDED,
      bookOff: operations?.bookOffAt ? at(operations.bookOffAt) : NOT_RECORDED,
      state: attendanceState(operations),
    };
  });

  // ── log book and welfare ──────────────────────────────────────────────────
  /**
   * The day's logs: on one of this report's shifts AND recorded on this site-local day.
   *
   * The shift filter alone counted an overnight shift's small-hours entries on the previous day's
   * report too, so "Entries recorded" could say 2 while the occurrence record listed 1.
   */
  const dayLogs = input.dailyLogs.filter((log) => log.shift?.id != null
    && shiftIds.has(log.shift.id)
    && inDay(log.createdAt));

  dayLogs.forEach((log) => {
    const guardName = log.guard?.fullName || '';
    if (isLogBookEntry(log)) {
      // The full text. This is the occurrence book; it is where the entry is read in full.
      push('log_book', `log-${log.id}`, log.createdAt, 'Log Book', log.message || '', guardName);
    } else if (isWelfareEvidence(log)) {
      push('welfare_check', `welfare-${log.id}`, log.createdAt, 'Welfare Check', log.message || '', guardName);
    }
    // Any other stored type (observation, patrol, …) is neither, and is not reclassified into one.
  });

  // Missed required periods, exactly as the backend graded them.
  const periods: LogBookPeriod[] = [];
  let logBookRequired = 0;
  let logBookCompleted = 0;
  let logBookMissing = 0;
  let anyScheduled = false;

  input.shifts.forEach((shift) => {
    const operations = input.operationsByShiftId.get(shift.id);
    const compliance = logBookCompliance(operations, 0);
    if (!compliance.scheduled) return;

    anyScheduled = true;

    /**
     * Only the periods that INTERSECT this site-local day.
     *
     * An overnight shift's grid spans two reports, and assigning the whole grid to the scheduled
     * start date would show a client periods that belong to the following morning. A window is
     * clipped by overlap, not by its start, so one genuinely crossing midnight appears on both days
     * — which is the truth about it. Nothing is re-graded: the engine's verdict travels unchanged.
     */
    logBookPeriods(operations)
      .filter((period) => {
        if (!dayWindow) return true;
        const startMs = ms(period.start);
        const endMs = ms(period.end);
        if (!ok(startMs) || !ok(endMs)) return false;
        return startMs < dayWindow.endMs && endMs > dayWindow.startMs;
      })
      .forEach((period) => {
        periods.push(period);
        /**
         * The counts describe THIS day, so they are tallied from the clipped periods rather than
         * taken from the shift-wide projection. For a single-day shift the two agree; for an
         * overnight one, reporting the whole shift's totals on both days would double-count the
         * obligation and overstate what either day actually required.
         */
        if (period.status === 'not_applicable') return;
        logBookRequired += 1;
        if (period.status === 'completed') logBookCompleted += 1;
        if (period.status === 'missing') {
          logBookMissing += 1;
          push(
            'log_book_missed', `missed-${shift.id}-${period.index}`, period.end,
            'Log Book period missed',
            `No entry recorded for ${at(period.start)}–${at(period.end)}`,
            shift.guard?.fullName || '',
          );
        }
      });
  });

  // ── incidents ─────────────────────────────────────────────────────────────
  // Referenced, never reproduced: the Incident Report remains the detailed evidence document.
  const followUps: FollowUpOutcome[] = [];
  const shiftIncidents = input.incidents.filter((incident) => incident.shift?.id != null && shiftIds.has(incident.shift.id));

  /** Only incidents REPORTED on this day are this day's incidents. */
  const dayIncidents = shiftIncidents.filter((incident) => inDay(incident.reportedAt || incident.createdAt));

  dayIncidents.forEach((incident) => {
    const guardName = incident.guard?.fullName || '';
    push(
      'incident_reported', `inc-${incident.id}`, incident.reportedAt || incident.createdAt,
      `Incident #${incident.id} reported`, incident.title || '', guardName,
    );

    const status = (incident.status || '').toLowerCase();
    const settled = status === 'resolved' || status === 'closed';
    const reviewedAt = incident.reviewedAt || null;
    const resolvedAt = settled ? (incident.closedAt || incident.reviewedAt || null) : null;

    // An outcome that landed TODAY is part of today's chronology.
    if (reviewedAt && !settled && inDay(reviewedAt)) {
      push('incident_in_review', `inc-${incident.id}-rev`, reviewedAt,
        `Incident #${incident.id} marked In Review`, '', '');
    }
    if (settled && inDay(resolvedAt)) {
      push('incident_resolved', `inc-${incident.id}-res`, resolvedAt,
        `Incident #${incident.id} resolved`, '', '');
    }

    /**
     * An outcome that landed LATER is reported here instead, dated.
     *
     * Suppressing it entirely would leave a client reading that an incident was raised and never
     * hearing what happened; placing it in the chronology made a 02-10 action read as 30-09. This is
     * the honest third option: a separate section, every timestamp carrying its own date.
     */
    const laterReview = reviewedAt && !inDay(reviewedAt) && !settled;
    const laterResolve = settled && resolvedAt && !inDay(resolvedAt);
    const unresolved = !settled;

    if (laterReview || laterResolve || unresolved) {
      const lines: Array<{ label: string; value: string }> = [
        { label: 'Reported', value: stamped(incident.reportedAt || incident.createdAt) },
      ];
      /**
       * "Marked In Review" only while the incident is still in review.
       *
       * The row keeps ONE `reviewedAt`, and resolving overwrites it — so on a resolved incident that
       * column is the resolution moment, not the review. Printing it under both labels would show a
       * client two events at the same minute and imply a review step the record cannot evidence.
       * The Incident Report can tell them apart because it reads the audit log; this summary does
       * not, so it says only what it knows.
       */
      if (reviewedAt && !settled && !inDay(reviewedAt)) {
        lines.push({ label: 'Marked In Review', value: stamped(reviewedAt) });
      }
      if (settled && resolvedAt && !inDay(resolvedAt)) {
        lines.push({ label: 'Resolved', value: stamped(resolvedAt) });
        if (incident.resolutionReason) {
          lines.push({ label: 'Resolution', value: resolutionLabel('incident', incident.resolutionReason) });
        }
        if (incident.resolutionNote?.trim()) {
          lines.push({ label: 'Resolution note', value: incident.resolutionNote.trim() });
        }
      }
      // Nothing is invented for an item still open: it is simply outstanding.
      if (unresolved) lines.push({ label: 'Status', value: 'Outstanding' });

      // Only worth a section when something is actually said beyond "reported".
      if (lines.length > 1) {
        followUps.push({
          key: `incident-${incident.id}`,
          title: `Incident #${incident.id}${incident.title ? ` — ${incident.title}` : ''}`,
          lines,
          outstanding: unresolved,
        });
      }
    }
  });

  // ── site requests and emergencies ─────────────────────────────────────────
  const dayAlerts = input.alerts.filter((alert) => alert.shift?.id != null && shiftIds.has(alert.shift.id));
  let siteRequests = 0;
  let emergencies = 0;

  dayAlerts.forEach((alert) => {
    const type = (alert.type || '').toLowerCase();
    const guardName = alert.guard?.fullName || '';
    const isRequest = SITE_REQUEST_TYPES.has(type);
    const isPanic = type === 'panic';
    if (!isRequest && !isPanic) return; // Welfare alerts are summarised, not listed as occurrences.

    // Raised on another day? Then it belongs to that day's report, not this one.
    if (!inDay(alert.createdAt)) return;

    const noun = isRequest ? 'Site Request' : 'Emergency';
    if (isRequest) siteRequests += 1; else emergencies += 1;

    push(
      isRequest ? 'site_request' : 'emergency',
      `${isRequest ? 'req' : 'sos'}-${alert.id}`,
      alert.createdAt, `${noun} raised`, alert.message || '', guardName,
    );

    if (alert.closedAt && inDay(alert.closedAt)) {
      push(
        isRequest ? 'site_request_resolved' : 'emergency_resolved',
        `${isRequest ? 'req' : 'sos'}-${alert.id}-done`,
        alert.closedAt, `${noun} resolved`, '', '',
      );
    } else if (alert.closedAt) {
      // Closed on a later day: reported as an outcome, with its date.
      followUps.push({
        key: `alert-${alert.id}`,
        title: `${noun} — ${alert.message || `#${alert.id}`}`,
        lines: [
          { label: 'Raised', value: stamped(alert.createdAt) },
          { label: 'Resolved', value: stamped(alert.closedAt) },
        ],
        outstanding: false,
      });
    } else if ((alert.status || '').toLowerCase() !== 'closed') {
      followUps.push({
        key: `alert-${alert.id}`,
        title: `${noun} — ${alert.message || `#${alert.id}`}`,
        lines: [
          { label: 'Raised', value: stamped(alert.createdAt) },
          { label: 'Status', value: 'Outstanding' },
        ],
        outstanding: true,
      });
    }
  });

  // ── welfare summary, from the existing projection ─────────────────────────
  let welfareRequired = 0;
  let welfareCompleted = 0;
  let welfareMissed = 0;
  let welfareApplicable = false;
  /**
   * The Welfare summary describes THIS day too.
   *
   * The projection's counts are shift-wide, so on an overnight shift they would report the whole
   * night on both days' reports. The engine's published windows carry their own instants, so the
   * day's figures are counted from the windows that intersect it — the same verdicts, narrowed to
   * the day. The Welfare engine itself is untouched; nothing here recomputes a window.
   *
   * A projection that publishes no windows falls back to its own counts, because a shift-wide
   * number is better than silently reporting zero.
   */
  input.shifts.forEach((shift) => {
    const welfare = input.operationsByShiftId.get(shift.id)?.welfare;
    if (!welfare || !welfare.enabled) return;
    welfareApplicable = true;

    const windows = welfare.windows ?? [];
    if (windows.length === 0) {
      welfareRequired += welfare.requiredCount ?? 0;
      welfareCompleted += welfare.completedCount ?? 0;
      welfareMissed += welfare.missedCount ?? 0;
      return;
    }

    windows.forEach((window) => {
      if (window.applicable === false) return;
      if (dayWindow) {
        const startMs = ms(window.start);
        const endMs = ms(window.end);
        if (!ok(startMs) || !ok(endMs)) return;
        if (!(startMs < dayWindow.endMs && endMs > dayWindow.startMs)) return;
      }
      welfareRequired += 1;
      if (window.state === 'completed') welfareCompleted += 1;
      if (window.state === 'missed' || window.state === 'overdue') welfareMissed += 1;
    });
  });

  /**
   * Chronological, with a deliberate order for events that share an instant.
   *
   * A handover note is anchored to Book Off and therefore carries the same timestamp, so without a
   * rank the two would be ordered by whatever their keys happened to sort as. A day opens with the
   * guard arriving and closes with what they handed over; the rank says so instead of leaving it to
   * an alphabetical accident.
   */
  events.sort((a, b) => (a.atMs - b.atMs) || (EVENT_RANK[a.kind] - EVENT_RANK[b.kind]) || a.key.localeCompare(b.key));

  return {
    companyName: input.companyName,
    clientName,
    siteName,
    dateLabel: input.dateLabel,
    dateKey: input.dateKey,
    timeZone,
    shifts: shiftRows,
    events,
    logBook: {
      scheduled: anyScheduled,
      intervalMinutes: input.shifts
        .map((shift) => input.operationsByShiftId.get(shift.id)?.logBook?.intervalMinutes ?? null)
        .find((value) => value != null) ?? null,
      required: logBookRequired,
      completed: logBookCompleted,
      missing: logBookMissing,
      entries: dayLogs.filter(isLogBookEntry).length,
    },
    periods,
    followUps,
    welfare: {
      required: welfareRequired,
      completed: welfareCompleted,
      missed: welfareMissed,
      applicable: welfareApplicable,
    },
    operational: { incidents: dayIncidents.length, siteRequests, emergencies },
  };
}

function attendanceState(operations: ShiftOperationsView | null | undefined): string {
  if (!operations) return NOT_RECORDED;
  if (operations.bookOffAt) return 'Booked off';
  if (operations.missingBookOff) return 'Missing Book Off';
  if (operations.bookOnAt) return 'On site';
  return 'Not booked on';
}

/** The report's own heading date, formatted once so every surface agrees. */
export function dailySiteLogTitle(model: DailySiteLogModel): string {
  return `Daily Site Log — ${model.siteName || 'Site'} — ${model.dateLabel}`;
}

/** A readable stamp for "generated at". */
export function generatedAtLabel(nowIso: string, timeZone: string): string {
  return formatUkDateTime(nowIso, timeZone);
}
