import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';

import { AttendanceEvent, AttendanceEventType } from '../attendance/entities/attendance.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { coverageCalendarBoundary } from '../coverage/coverage.service';
import {
  OperationsProjectionService,
  WelfareWindowAlertView,
  WelfareWindowView,
} from '../coverage/operations-projection.service';
import { SafetyAlert, SafetyAlertStatus, SafetyAlertType } from '../safety-alert/entities/safety-alert.entity';
import { Shift } from '../shift/entities/shift.entity';
import {
  SHIFT_RECONCILIATION_REASON_LABELS,
  ShiftReconciliationReason,
} from '../shift/shift-reconciliation';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { EarlyBookOffService, EarlyBookOffView } from '../coverage/early-book-off.service';
import { COVERAGE_STATUS_WORD, STAFFING_STATUS_WORD, earlyBookOff, formatMinutes } from '../operations/early-book-off';
import { welfareWindowDuty } from '../operations/welfare-window.service';
import { User, UserRole } from '../user/entities/user.entity';

/**
 * Shift Attendance and Welfare Monitoring reports (S4 Welfare & Reporting Remediation, Phase 3).
 *
 * Every value comes from the database through the same projection Live Operations draws, never from what a
 * screen happens to have loaded: the export's welfare columns used to read "Not required" for any shift the
 * board had no windows for. The response is a sheet — column headings, string rows and a summary — that the
 * web app writes to CSV or XLSX unchanged, so the file says exactly what the API says.
 *
 * NOTHING IS INVENTED. A Book Off, a check, a timesheet status or an alert that does not exist is a blank
 * cell, never a default. A missed-window history record (written closed by the sweep) is reported as a
 * record; only an alert says whether anyone resolved it, and one the previous automatic rule closed is
 * reported as exactly that.
 *
 * Company isolation is the query: the company comes from the signed-in user's own context, and every read is
 * bounded by that company's shift ids. A site or shift id from another company matches nothing.
 */

/** The longest range one report covers. */
export const REPORT_MAX_DAYS = 31;
/** Shifts per report; past this the caller narrows the range or picks a site. */
export const REPORT_MAX_SHIFTS = 2000;
/** Welfare rows per report (one per window). */
export const REPORT_MAX_WELFARE_ROWS = 50_000;
/** No Book Off this long after the scheduled end reads as a missing Book Off (as the sweep raises it). */
const MISSING_BOOK_OFF_GRACE_MINUTES = 15;
const REPORT_TIME_ZONE_FALLBACK = 'Europe/London';

export type ReportQuery = { from?: string; to?: string; siteId?: string };

export type OperationsReportSheet = {
  report: 'shift-attendance' | 'welfare-monitoring';
  title: string;
  company: string;
  /** DD-MM-YYYY, the UK calendar days the report covers (a shift belongs to the day it starts). */
  period: { from: string; to: string; fromUtc: string; toUtc: string; days: number };
  site: string | null;
  generatedAtUtc: string;
  timezoneNote: string;
  columns: string[];
  rows: string[][];
  /** Label / value pairs and small tables for the XLSX summary sheet. */
  summary: string[][];
};

const ATTENDANCE_COLUMNS = [
  'Company', 'Client', 'Site', 'Site timezone', 'Shift ID', 'Guard', 'Shift date',
  'Scheduled start', 'Scheduled end', 'Scheduled start (UTC)', 'Scheduled end (UTC)',
  'Book On', 'Book Off', 'Book On (UTC)', 'Book Off (UTC)',
  'Shift status', 'Attendance status', 'Missing Book Off', 'Early Book Off',
  'Remaining scheduled time', 'Coverage after early Book Off', 'Covering shift IDs', 'Staffing after early Book Off',
  'Reconciliation', 'Reconciliation audit ref', 'Timesheet status',
];

const WELFARE_COLUMNS = [
  'Company', 'Site', 'Site timezone', 'Shift ID', 'Guard', 'Shift date', 'Welfare interval (min)',
  'Window', 'Window start', 'Window end', 'Window start (UTC)', 'Window end (UTC)',
  'Status', 'Time on duty in window', 'Check recorded at', 'Check recorded at (UTC)',
  'Missed-window record', 'Missed-window recorded at', 'Missed-window recorded at (UTC)', 'Missed-window audit ref',
  'Alert', 'Alert status', 'Acknowledged', 'Resolved', 'Resolution reason', 'Alert audit refs',
];

/** The window state, worded as the board does, with the clock's Upcoming split. */
const WELFARE_STATUS_WORD: Record<string, string> = {
  upcoming: 'Upcoming',
  due: 'Due',
  overdue: 'Overdue',
  completed: 'Completed',
  missed: 'Missed',
  ended_at_book_off: 'Ended at Book Off',
  not_applicable: 'Not required',
};

/**
 * "Full window", or "Partial — 40 of 60 min (Book Off 10:40)": how much of the window the Guard was on duty
 * for, so a partial-window miss never reads the same as a full missed window (release gate). Blank where no
 * duty applies yet (Upcoming, Due) or at all (Not required). From the recorded Book On and Book Off only.
 */
export function dutyWords(
  w: { start: Date | string; end: Date | string },
  status: string,
  bookOnAt: string | null,
  bookOffAt: string | null,
  tz: string,
): string {
  if (!['Completed', 'Overdue', 'Missed', 'Ended at Book Off'].includes(status)) return '';
  const on = bookOnAt ? new Date(bookOnAt) : null;
  const off = bookOffAt ? new Date(bookOffAt) : null;
  const duty = welfareWindowDuty({ start: new Date(w.start), end: new Date(w.end) }, on, off);
  if (!duty.partial) return 'Full window';
  const why = [
    duty.bookedOnLate && on ? `Book On ${hhmm(on, tz)}` : '',
    duty.bookedOffEarly && off ? `Book Off ${hhmm(off, tz)}` : '',
  ].filter(Boolean).join(', ');
  return `Partial — ${duty.onDutyMinutes} of ${duty.windowMinutes} min (${why})`;
}

/** "YYYY-MM-DD" to [from 00:00, to + 1 day 00:00) on the UK calendar, with the number of days; refused otherwise. */
export function parseReportRange(query: ReportQuery, now = new Date()) {
  const valid = (value: string | undefined) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!valid(query.from) || !valid(query.to)) {
    throw new BadRequestException('from and to are required, as YYYY-MM-DD.');
  }
  const day = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  const fromDay = day(query.from!);
  const toDay = day(query.to!);
  const roundTrip = (ms: number, value: string) => new Date(ms).toISOString().slice(0, 10) === value;
  if (!roundTrip(fromDay, query.from!) || !roundTrip(toDay, query.to!)) {
    throw new BadRequestException('from and to must be real calendar dates.');
  }
  if (toDay < fromDay) throw new BadRequestException('to must not be before from.');
  const days = Math.round((toDay - fromDay) / 86_400_000) + 1;
  if (days > REPORT_MAX_DAYS) throw new BadRequestException(`A report covers at most ${REPORT_MAX_DAYS} days.`);
  const start = coverageCalendarBoundary(query.from, false, now);
  // The boundary helper returns the last millisecond of the day; the exclusive end is one millisecond later.
  const endExclusive = new Date(coverageCalendarBoundary(query.to, true, now).getTime() + 1);
  return { start, endExclusive, days, from: query.from!, to: query.to! };
}

export function parseSiteId(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647) {
    throw new BadRequestException('siteId must be a positive whole number.');
  }
  return Number(value);
}

/** "17-10-2026 23:00" on the given zone's clock. */
export function ukDateTime(value: Date | string | null | undefined, timeZone: string): string {
  if (!value) return '';
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')}-${part('month')}-${part('year')} ${part('hour')}:${part('minute')}`;
}

export function ukDate(value: Date | string | null | undefined, timeZone: string): string {
  return ukDateTime(value, timeZone).slice(0, 10);
}

function hhmm(value: Date | string | null | undefined, timeZone: string): string {
  return ukDateTime(value, timeZone).slice(11);
}

/** "2026-10-17T22:00:00Z": the instant itself, for audit. */
export function utc(value: Date | string | null | undefined): string {
  if (!value) return '';
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isNaN(instant.getTime()) ? '' : `${instant.toISOString().slice(0, 19)}Z`;
}

function humanise(value: string | null | undefined): string {
  const words = (value ?? '').replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

export type AttendanceFacts = {
  status: string;
  start: Date;
  end: Date;
  bookOnAt: Date | null;
  bookOffAt: Date | null;
  reconciled: boolean;
  now: Date;
};

/**
 * One word for where attendance stands, from recorded facts only. A shift with a Book On and no Book Off is
 * never given a Book Off: it is on shift, overdue, closed without one by Control, or completed with it missing.
 */
export function attendanceStatus(f: AttendanceFacts): string {
  const status = (f.status || '').trim().toLowerCase();
  if (status === 'cancelled') return 'Cancelled';
  if (!f.bookOnAt) {
    if (status === 'missed') return 'Missed (no Book On)';
    if (f.start.getTime() > f.now.getTime()) return 'Scheduled';
    return status === 'completed' ? 'Completed — no Book On recorded' : 'Not booked on';
  }
  if (f.bookOffAt) return earlyBookOffMinutes(f) !== null ? 'Booked off early' : 'Booked off';
  if (status === 'completed') return f.reconciled ? 'Closed without Book Off' : 'Completed — Book Off missing';
  return f.now.getTime() > f.end.getTime() + MISSING_BOOK_OFF_GRACE_MINUTES * 60_000 ? 'Missing Book Off' : 'On shift';
}

/**
 * Minutes a Book Off came before the scheduled end, when it was more than 15 minutes early; otherwise null.
 * The one rule Live Operations uses too (operations/early-book-off.ts).
 */
export function earlyBookOffMinutes(f: Pick<AttendanceFacts, 'end' | 'bookOffAt'>): number | null {
  return earlyBookOff(f.end, f.bookOffAt)?.minutesEarly ?? null;
}

/**
 * "Partially staffed (1 of 2 required, short 4h 50m)", or that no requirement is set — the shift is not from
 * the Rota Planner, so S4 holds no genuine requirement for it and none is assumed.
 */
export function staffingWords(view: EarlyBookOffView | null | undefined): string {
  if (!view) return '';
  const s = view.staffing;
  if (!s) return 'No staffing requirement set (not a Rota Planner shift)';
  const parts = [`${s.minOnDuty} of ${s.required} required at the lowest`];
  if (s.shortMinutes) parts.push(`short ${formatMinutes(s.shortMinutes)}`);
  if (s.unstaffedMinutes) parts.push(`unstaffed ${formatMinutes(s.unstaffedMinutes)}`);
  if (s.unknownMinutes) parts.push(`unknown ${formatMinutes(s.unknownMinutes)}`);
  if (s.reliesOnSchedule) parts.push('partly from the schedule');
  return `${STAFFING_STATUS_WORD[s.status]} (${parts.join(', ')})`;
}

/** "Coverage maintained (another Guard on duty: shifts 41)" and the like, from the assessment. */
export function coverageWords(view: EarlyBookOffView | null | undefined): { status: string; shifts: string } {
  if (!view) return { status: '', shifts: '' };
  const c = view.coverage;
  const parts: string[] = [];
  if (c.coveredMinutes) parts.push(`covered ${formatMinutes(c.coveredMinutes)}`);
  if (c.uncoveredMinutes) parts.push(`uncovered ${formatMinutes(c.uncoveredMinutes)}`);
  if (c.unknownMinutes) parts.push(`unknown ${formatMinutes(c.unknownMinutes)}`);
  if (c.reliesOnSchedule) parts.push('partly from the schedule');
  return {
    status: `${COVERAGE_STATUS_WORD[c.status]}${parts.length ? ` (${parts.join(', ')})` : ''}`,
    shifts: c.coveringShiftIds.join(' '),
  };
}

/** Status for one welfare window: the engine's state, with a future window read as Upcoming exactly as the board does. */
export function welfareStatusWord(window: Pick<WelfareWindowView, 'state' | 'start'>, nowMs: number, awaitingBookOn: boolean): string {
  const ahead = Date.parse(window.start) > nowMs;
  const state = String(window.state);
  const key = ahead && (state === 'due' || (state === 'not_applicable' && awaitingBookOn)) ? 'upcoming' : state;
  return WELFARE_STATUS_WORD[key] ?? 'Not required';
}

/** How an alert stands. Never "resolved" for something no person resolved. */
export function alertStatusWord(alert: Pick<WelfareWindowAlertView, 'status' | 'closedBySystem'>): string {
  if (alert.status === SafetyAlertStatus.OPEN) return 'Open';
  if (alert.status === SafetyAlertStatus.ACKNOWLEDGED) return 'Acknowledged';
  return alert.closedBySystem ? 'Closed automatically (previous rule)' : 'Resolved by control room';
}

@Injectable()
export class OperationsExportService {
  constructor(
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(AttendanceEvent) private readonly attendanceRepo: Repository<AttendanceEvent>,
    @InjectRepository(Timesheet) private readonly timesheetRepo: Repository<Timesheet>,
    @InjectRepository(SafetyAlert) private readonly safetyAlertRepo: Repository<SafetyAlert>,
    @InjectRepository(AuditLog) private readonly auditRepo: Repository<AuditLog>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly membershipService: CompanyMembershipService,
    private readonly projection: OperationsProjectionService,
    @Optional() private readonly earlyBookOffService?: EarlyBookOffService,
  ) {}

  async shiftAttendance(userId: number, userRole: UserRole, query: ReportQuery, now = new Date()): Promise<OperationsReportSheet> {
    const range = parseReportRange(query, now);
    const siteId = parseSiteId(query.siteId);
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.REPORTS_OPERATIONAL);
    const shifts = await this.shiftsFor(company.id, range, siteId);
    const ids = shifts.map((shift) => shift.id);

    const attendance = ids.length
      ? await this.attendanceRepo.find({ where: { shift: { id: In(ids) } }, relations: { shift: true }, loadEagerRelations: false })
      : [];
    const timesheets = ids.length
      ? await this.timesheetRepo.find({ where: { shift: { id: In(ids) } }, relations: { shift: true }, loadEagerRelations: false, order: { id: 'ASC' } })
      : [];
    const missingBookOff = ids.length
      ? await this.safetyAlertRepo.find({
          where: { shift: { id: In(ids) }, type: SafetyAlertType.MISSING_BOOK_OFF },
          relations: { shift: true }, loadEagerRelations: false, order: { id: 'ASC' },
        })
      : [];
    const reconciliations: Array<{ id: number; entityId: number; userId: number | null; createdAt: Date; reason: string | null; reconciledAt: string | null }> = ids.length
      ? await this.auditRepo.query(
          `SELECT DISTINCT ON ("entityId") id, "entityId", "userId", "createdAt", "afterData"->>'reason' AS reason,
                  "afterData"->>'reconciledAt' AS "reconciledAt"
             FROM audit_logs
            WHERE "companyId" = $1 AND action = 'shift.reconciled_without_book_off' AND "entityType" = 'shift'
              AND "entityId" = ANY($2::int[])
            ORDER BY "entityId", id DESC`,
          [company.id, ids],
        )
      : [];
    const names = await this.userNames(reconciliations.map((r) => r.userId));

    const byShift = <T extends { shift?: { id: number } | null }>(rows: T[]) => {
      const map = new Map<number, T[]>();
      for (const row of rows) {
        const id = row.shift?.id;
        if (id === undefined) continue;
        map.set(id, [...(map.get(id) ?? []), row]);
      }
      return map;
    };
    const attendanceBy = byShift(attendance);
    const timesheetBy = byShift(timesheets);
    const missingBy = byShift(missingBookOff);
    const reconBy = new Map(reconciliations.map((r) => [Number(r.entityId), r]));
    // Welfare Phase 4: whether another Guard covered the rest of each early-booked-off shift.
    const bookOffBy = new Map<number, Date | null>(shifts.map((shift) => {
      const offs = (attendanceBy.get(shift.id) ?? [])
        .filter((e) => e.type === AttendanceEventType.CHECK_OUT)
        .map((e) => e.occurredAt.getTime());
      return [shift.id, offs.length ? new Date(Math.max(...offs)) : null];
    }));
    const earlyBy = this.earlyBookOffService
      ? await this.earlyBookOffService.assess(company.id, shifts, bookOffBy, now)
      : new Map<number, EarlyBookOffView>();
    const coverageCounts = new Map<string, number>();

    const counts = new Map<string, number>();
    const rows = shifts.map((shift) => {
      const tz = shift.site?.timezone || REPORT_TIME_ZONE_FALLBACK;
      const events = attendanceBy.get(shift.id) ?? [];
      const times = (type: AttendanceEventType) => events.filter((e) => e.type === type).map((e) => e.occurredAt.getTime());
      const ons = times(AttendanceEventType.CHECK_IN);
      const offs = times(AttendanceEventType.CHECK_OUT);
      const bookOnAt = ons.length ? new Date(Math.min(...ons)) : null;
      const bookOffAt = offs.length ? new Date(Math.max(...offs)) : null;
      const recon = reconBy.get(shift.id) ?? null;
      const facts: AttendanceFacts = {
        status: shift.status, start: new Date(shift.start), end: new Date(shift.end), bookOnAt, bookOffAt, reconciled: Boolean(recon), now,
      };
      const word = attendanceStatus(facts);
      counts.set(word, (counts.get(word) ?? 0) + 1);
      const early = earlyBookOffMinutes(facts);
      const mbo = (missingBy.get(shift.id) ?? []).slice(-1)[0];
      const timesheet = (timesheetBy.get(shift.id) ?? []).slice(-1)[0];
      const reasonLabel = recon?.reason
        ? SHIFT_RECONCILIATION_REASON_LABELS[recon.reason as ShiftReconciliationReason] ?? humanise(recon.reason)
        : '';

      return [
        company.name,
        shift.site?.client?.name ?? '',
        shift.site?.name || shift.siteName || '',
        tz,
        String(shift.id),
        shift.guard?.fullName ?? '',
        ukDate(shift.start, tz),
        ukDateTime(shift.start, tz),
        ukDateTime(shift.end, tz),
        utc(shift.start),
        utc(shift.end),
        ukDateTime(bookOnAt, tz),
        ukDateTime(bookOffAt, tz),
        utc(bookOnAt),
        utc(bookOffAt),
        humanise(shift.status),
        word,
        mbo
          ? `Yes (alert #${mbo.id}, ${mbo.status === SafetyAlertStatus.CLOSED ? (mbo.closedByUserId == null ? 'closed by the late Book Off' : 'resolved') : humanise(mbo.status)})`
          : word === 'Missing Book Off' || word === 'Completed — Book Off missing' ? 'Yes' : 'No',
        bookOffAt ? (early !== null ? `Yes — ${early} min before scheduled end` : 'No') : '',
        early !== null ? formatMinutes(early) : '',
        ...(() => {
          const words = coverageWords(earlyBy.get(shift.id));
          if (words.status) {
            const key = COVERAGE_STATUS_WORD[earlyBy.get(shift.id)!.coverage.status];
            coverageCounts.set(key, (coverageCounts.get(key) ?? 0) + 1);
          }
          return [words.status, words.shifts, staffingWords(earlyBy.get(shift.id))];
        })(),
        recon
          ? `Closed without Book Off — ${reasonLabel}, by ${names.get(recon.userId ?? -1) ?? 'unknown user'}, ${ukDateTime(recon.reconciledAt ?? recon.createdAt, tz)}`
          : '',
        recon ? `audit #${recon.id}` : '',
        timesheet ? humanise(timesheet.approvalStatus) : 'No timesheet',
      ];
    });

    const summary: string[][] = [
      ['Shifts', String(rows.length)],
      ...[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([word, n]) => [word, String(n)]),
      ...(coverageCounts.size ? [[], ['Early Book Off coverage', ''],
        ...[...coverageCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([word, n]) => [word, String(n)])] : []),
    ];
    return this.sheet('shift-attendance', 'Shift Attendance', company.name, range, siteId, shifts, ATTENDANCE_COLUMNS, rows, summary, now);
  }

  async welfareMonitoring(userId: number, userRole: UserRole, query: ReportQuery, now = new Date()): Promise<OperationsReportSheet> {
    const range = parseReportRange(query, now);
    const siteId = parseSiteId(query.siteId);
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.REPORTS_OPERATIONAL);
    const shifts = await this.shiftsFor(company.id, range, siteId);
    const operations = await this.projection.projectForShifts(shifts, now, { welfareHistory: true });

    // Audit references for every evidence row and every alert the windows name: one bounded read.
    const alertIds = new Set<number>();
    for (const view of operations.values()) {
      for (const w of view.welfare.windows) {
        if (w.evidenceAlertId) alertIds.add(w.evidenceAlertId);
        if (w.alert) alertIds.add(w.alert.id);
      }
    }
    const audits: Array<{ id: number; entityId: number; action: string }> = alertIds.size
      ? await this.auditRepo.query(
          `SELECT id, "entityId", action FROM audit_logs
            WHERE "companyId" = $1 AND "entityType" = 'safety_alert' AND "entityId" = ANY($2::int[])
              AND action IN ('welfare_check.window_missed', 'welfare_check.summary_opened', 'welfare_check.summary_escalated',
                             'welfare_check.summary_reopened', 'welfare_check.summary_resolved',
                             'safety_alert.acknowledged', 'safety_alert.closed')
            ORDER BY id ASC`,
          [company.id, [...alertIds]],
        )
      : [];
    const auditsBy = new Map<number, Array<{ id: number; action: string }>>();
    for (const a of audits) auditsBy.set(Number(a.entityId), [...(auditsBy.get(Number(a.entityId)) ?? []), a]);
    const actorIds: Array<number | null> = [];
    for (const view of operations.values()) {
      for (const w of view.welfare.windows) actorIds.push(w.alert?.acknowledgedByUserId ?? null, w.alert?.closedByUserId ?? null);
    }
    const names = await this.userNames(actorIds);
    const auditWord: Record<string, string> = {
      'welfare_check.window_missed': 'recorded', 'welfare_check.summary_opened': 'opened',
      'welfare_check.summary_escalated': 'escalated', 'welfare_check.summary_reopened': 'reopened',
      'welfare_check.summary_resolved': 'closed automatically', 'safety_alert.acknowledged': 'acknowledged',
      'safety_alert.closed': 'closed',
    };
    const refs = (id: number | null | undefined) =>
      id ? (auditsBy.get(id) ?? []).map((a) => `#${a.id} ${auditWord[a.action] ?? a.action}`).join('; ') : '';

    const rows: string[][] = [];
    const perSite = new Map<string, { windows: number; completed: number; missed: number; ended: number; alerts: Set<number>; open: Set<number> }>();
    for (const shift of shifts) {
      const view = operations.get(shift.id);
      if (!view) continue;
      const tz = shift.site?.timezone || view.timezone || REPORT_TIME_ZONE_FALLBACK;
      const site = shift.site?.name || shift.siteName || '';
      const awaitingBookOn = !view.bookOnAt && !['cancelled', 'completed', 'missed', 'rejected'].includes((shift.status || '').toLowerCase());
      const tally = perSite.get(site) ?? { windows: 0, completed: 0, missed: 0, ended: 0, alerts: new Set<number>(), open: new Set<number>() };
      perSite.set(site, tally);
      for (const w of view.welfare.windows) {
        if (rows.length >= REPORT_MAX_WELFARE_ROWS) {
          throw new BadRequestException(`More than ${REPORT_MAX_WELFARE_ROWS} welfare windows in this range: narrow the range or pick a site.`);
        }
        const status = welfareStatusWord(w, now.getTime(), awaitingBookOn);
        if (w.applicable) tally.windows += 1;
        if (status === 'Completed') tally.completed += 1;
        if (status === 'Missed') tally.missed += 1;
        if (status === 'Ended at Book Off') tally.ended += 1;
        const alert = w.alert ?? null;
        if (alert) {
          tally.alerts.add(alert.id);
          if (alert.status !== SafetyAlertStatus.CLOSED) tally.open.add(alert.id);
        }
        rows.push([
          company.name,
          site,
          tz,
          String(shift.id),
          shift.guard?.fullName ?? '',
          ukDate(shift.start, tz),
          view.welfare.intervalMinutes === null ? '' : String(view.welfare.intervalMinutes),
          `${hhmm(w.start, tz)}–${hhmm(w.end, tz)}`,
          ukDateTime(w.start, tz),
          ukDateTime(w.end, tz),
          utc(w.start),
          utc(w.end),
          status,
          dutyWords(w, status, view.bookOnAt, view.bookOffAt, tz),
          ukDateTime(w.completedAt, tz),
          utc(w.completedAt),
          w.evidenceAlertId ? `Record #${w.evidenceAlertId} (history, not an alert)` : '',
          ukDateTime(w.missRecordedAt ?? null, tz),
          utc(w.missRecordedAt ?? null),
          refs(w.evidenceAlertId),
          alert ? `#${alert.id}` : w.evidenceAlertId ? 'No alert raised' : '',
          alert ? alertStatusWord(alert) : '',
          alert?.acknowledgedAt ? `${ukDateTime(alert.acknowledgedAt, tz)} by ${names.get(alert.acknowledgedByUserId ?? -1) ?? 'unknown user'}` : '',
          alert && alert.status === SafetyAlertStatus.CLOSED
            ? alert.closedBySystem
              ? `${ukDateTime(alert.closedAt, tz)} automatically (previous rule)`
              : `${ukDateTime(alert.closedAt, tz)} by ${names.get(alert.closedByUserId ?? -1) ?? 'unknown user'}`
            : '',
          alert?.resolutionReason ? humanise(alert.resolutionReason) : '',
          alert ? refs(alert.id) : '',
        ]);
      }
    }

    const summary: string[][] = [
      ['Site', 'Windows required', 'Completed', 'Missed', 'Ended at Book Off', 'Alerts raised', 'Alerts still open'],
      ...[...perSite.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([site, t]) => [
        site, String(t.windows), String(t.completed), String(t.missed), String(t.ended), String(t.alerts.size), String(t.open.size),
      ]),
    ];
    return this.sheet('welfare-monitoring', 'Welfare Monitoring', company.name, range, siteId, shifts, WELFARE_COLUMNS, rows, summary, now);
  }

  /** The company's shifts starting in the range (a shift belongs to the day it starts), optionally one site. */
  private async shiftsFor(companyId: number, range: ReturnType<typeof parseReportRange>, siteId: number | null) {
    const shifts = await this.shiftRepo.find({
      where: {
        company: { id: companyId },
        start: Between(range.start, new Date(range.endExclusive.getTime() - 1)),
        ...(siteId !== null ? { site: { id: siteId } } : {}),
      },
      order: { start: 'ASC', id: 'ASC' },
      relations: { site: { client: true }, guard: true },
      loadEagerRelations: false,
      take: REPORT_MAX_SHIFTS + 1,
    });
    if (shifts.length > REPORT_MAX_SHIFTS) {
      throw new BadRequestException(`More than ${REPORT_MAX_SHIFTS} shifts in this range: narrow the range or pick a site.`);
    }
    return shifts;
  }

  /** "First Last" for the people who acted, or "User #id". Names only: no email or contact details. */
  private async userNames(ids: Array<number | null | undefined>): Promise<Map<number, string>> {
    const wanted = [...new Set(ids.filter((id): id is number => typeof id === 'number' && id > 0))];
    if (!wanted.length) return new Map();
    const users = await this.userRepo.find({ where: { id: In(wanted) }, select: { id: true, firstName: true, lastName: true }, loadEagerRelations: false });
    return new Map(users.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || `User #${u.id}`]));
  }

  private sheet(
    report: OperationsReportSheet['report'],
    title: string,
    company: string,
    range: ReturnType<typeof parseReportRange>,
    siteId: number | null,
    shifts: Shift[],
    columns: string[],
    rows: string[][],
    summary: string[][],
    now: Date,
  ): OperationsReportSheet {
    const zones = [...new Set(shifts.map((s) => s.site?.timezone || REPORT_TIME_ZONE_FALLBACK))];
    const site = siteId !== null ? shifts[0]?.site?.name ?? `Site #${siteId}` : null;
    const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
    return {
      report,
      title,
      company,
      period: { from: ddmmyyyy(range.from), to: ddmmyyyy(range.to), fromUtc: utc(range.start), toUtc: utc(range.endExclusive), days: range.days },
      site,
      generatedAtUtc: utc(now),
      timezoneNote:
        `Local times are each site's own clock (${zones.length ? zones.join(', ') : REPORT_TIME_ZONE_FALLBACK}); the (UTC) columns are the ` +
        'same instants in UTC. A shift is included on the UK calendar day it starts.',
      columns,
      rows,
      summary: [
        ['Report', title],
        ['Company', company],
        ['Period', `${ddmmyyyy(range.from)} to ${ddmmyyyy(range.to)} (${range.days} day${range.days === 1 ? '' : 's'})`],
        ['Site', site ?? 'All sites'],
        ['Generated (UTC)', utc(now)],
        [],
        ...summary,
      ],
    };
  }
}
