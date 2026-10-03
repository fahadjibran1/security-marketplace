// The Daily Site Log (Occurrence Book): one site's operational day, assembled from records only.
//
// EVERY EVENT IS TRACEABLE. Each entry in the stream comes from a stored row — an attendance time, a
// daily log, an incident, a safety alert — or from a required period the backend's own window engine
// graded. Nothing is added to make the day look complete, and a record type with nothing in it
// produces no events rather than a reassuring "none".
//
// It is pure, so the screen, the printed A4 page and the export are three renderings of ONE reading
// of the day and cannot quietly disagree.

import { formatInstantTime, formatUkDateTime, formatUkRange } from '../../services/siteTime';
import { isLogBookEntry, logBookCompliance, logBookPeriods, type LogBookCompliance, type LogBookPeriod } from './logBookRegister';
import { isWelfareEvidence } from '../shifts/welfareEvidence';
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
  const dayLogs = input.dailyLogs.filter((log) => log.shift?.id != null && shiftIds.has(log.shift.id));

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
    logBookRequired += compliance.required;
    logBookCompleted += compliance.completed;
    logBookMissing += compliance.missing;

    logBookPeriods(operations).forEach((period) => {
      periods.push(period);
      if (period.status === 'missing') {
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
  const dayIncidents = input.incidents.filter((incident) => incident.shift?.id != null && shiftIds.has(incident.shift.id));
  dayIncidents.forEach((incident) => {
    const guardName = incident.guard?.fullName || '';
    push(
      'incident_reported', `inc-${incident.id}`, incident.reportedAt || incident.createdAt,
      `Incident #${incident.id} reported`, incident.title || '', guardName,
    );
    const status = (incident.status || '').toLowerCase();
    if (incident.reviewedAt && status !== 'resolved' && status !== 'closed') {
      push('incident_in_review', `inc-${incident.id}-rev`, incident.reviewedAt,
        `Incident #${incident.id} marked In Review`, '', '');
    }
    if (status === 'resolved' || status === 'closed') {
      // The row keeps only the latest review time, which for a resolved incident IS the resolution.
      push('incident_resolved', `inc-${incident.id}-res`, incident.closedAt || incident.reviewedAt,
        `Incident #${incident.id} resolved`, incident.resolutionReason ? '' : '', '');
    }
  });

  // ── site requests and emergencies ─────────────────────────────────────────
  const dayAlerts = input.alerts.filter((alert) => alert.shift?.id != null && shiftIds.has(alert.shift.id));
  let siteRequests = 0;
  let emergencies = 0;

  dayAlerts.forEach((alert) => {
    const type = (alert.type || '').toLowerCase();
    const guardName = alert.guard?.fullName || '';
    if (SITE_REQUEST_TYPES.has(type)) {
      siteRequests += 1;
      push('site_request', `req-${alert.id}`, alert.createdAt, 'Site Request raised', alert.message || '', guardName);
      if (alert.closedAt) {
        push('site_request_resolved', `req-${alert.id}-done`, alert.closedAt, 'Site Request resolved', '', '');
      }
    } else if (type === 'panic') {
      emergencies += 1;
      push('emergency', `sos-${alert.id}`, alert.createdAt, 'Emergency raised', alert.message || '', guardName);
      if (alert.closedAt) {
        push('emergency_resolved', `sos-${alert.id}-done`, alert.closedAt, 'Emergency resolved', '', '');
      }
    }
    // Welfare alerts are summarised below, not listed as occurrences.
  });

  // ── welfare summary, from the existing projection ─────────────────────────
  let welfareRequired = 0;
  let welfareCompleted = 0;
  let welfareMissed = 0;
  let welfareApplicable = false;
  input.shifts.forEach((shift) => {
    const welfare = input.operationsByShiftId.get(shift.id)?.welfare;
    if (!welfare || !welfare.enabled) return;
    welfareApplicable = true;
    welfareRequired += welfare.requiredCount ?? 0;
    welfareCompleted += welfare.completedCount ?? 0;
    welfareMissed += welfare.missedCount ?? 0;
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
