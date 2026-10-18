/**
 * Shift Attendance and Welfare Monitoring reports (Welfare & Reporting Remediation, Phase 3).
 *
 * Real OperationsExportService, real projection, real PostgreSQL. Every fixture instant is fixed and the
 * service is given its own "now", so each cell asserted below is exact. Company context comes from a stub
 * that applies the REAL role-permission matrix, so the permission tests prove which permission the reports
 * ask for and which roles hold it.
 *
 * Needs OPERATIONS_EXPORT_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Company } from '../src/company/entities/company.entity';
import { Client } from '../src/client/entities/client.entity';
import { Site } from '../src/site/entities/site.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { AttendanceEvent, AttendanceEventType } from '../src/attendance/entities/attendance.entity';
import { DailyLog, DailyLogType } from '../src/daily-log/entities/daily-log.entity';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { Timesheet } from '../src/timesheet/entities/timesheet.entity';
import { SafetyAlert, SafetyAlertPriority, SafetyAlertStatus, SafetyAlertType } from '../src/safety-alert/entities/safety-alert.entity';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import { WelfareWindowService } from '../src/operations/welfare-window.service';
import { LogBookWindowService } from '../src/operations/log-book-window.service';
import { OperationsProjectionService } from '../src/coverage/operations-projection.service';
import { CompanyMembershipRole, CompanyPermission, hasPermission } from '../src/company-membership/company-membership-types';
import {
  OperationsExportService,
  REPORT_MAX_SHIFTS,
  parseReportRange,
} from '../src/report/operations-export.service';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}
async function refused(fn: () => Promise<unknown>, type: new (...a: never[]) => Error, because: string) {
  try { await fn(); } catch (error) {
    assert.ok(error instanceof type, `${because}: expected ${type.name}, got ${(error as Error)?.constructor?.name}: ${(error as Error)?.message}`);
    return (error as Error).message;
  }
  throw new Error(`expected refusal: ${because}`);
}

const Z = (iso: string) => new Date(iso);
const H = 3_600_000;
const M = 60_000;
/** The reports' clock: 18-10-2026 12:00 BST. */
const NOW = Z('2026-10-18T11:00:00Z');

async function main() {
  const url = process.env.OPERATIONS_EXPORT_DATABASE_URL;
  if (!url) throw new Error('OPERATIONS_EXPORT_DATABASE_URL is required (use a disposable database)');
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('operations export database must be local');
  const ds = new DataSource({ type: 'postgres', url, entities: appEntities, synchronize: true, dropSchema: true, logging: false });
  await ds.initialize();
  const repo = <T extends object>(entity: new () => T): Repository<T> => ds.getRepository(entity);

  const engine = new OperationalWindowService();
  const projection = new OperationsProjectionService(
    repo(AttendanceEvent), repo(DailyLog), repo(SafetyAlert), engine, new WelfareWindowService(engine), new LogBookWindowService(engine),
  );

  // userId -> { company, role } ; the owner of a company acts as OWNER.
  const actors = new Map<number, { company: Company; role: CompanyMembershipRole }>();
  const membership = {
    resolveCompanyContext: async (userId: number, _role: UserRole, permission: CompanyPermission) => {
      const actor = actors.get(userId);
      if (!actor) throw new ForbiddenException('No company');
      if (!hasPermission(actor.role, permission)) throw new ForbiddenException('Insufficient permissions.');
      return { company: actor.company, membership: null };
    },
  };
  const service = (s = repo(Shift)) => new OperationsExportService(
    s, repo(AttendanceEvent), repo(Timesheet), repo(SafetyAlert), repo(AuditLog), repo(User), membership as never, projection,
  );
  const exportService = service();

  let seq = 0;
  const makeUser = async (role: UserRole, first?: string, last?: string) => repo(User).save(repo(User).create({
    email: `u${(seq += 1)}@example.invalid`, passwordHash: 'x', role, status: UserStatus.ACTIVE, firstName: first ?? null, lastName: last ?? null,
  }));
  const makeTenant = async (label: string) => {
    const owner = await makeUser(UserRole.COMPANY_ADMIN, label, 'Owner');
    const company = await repo(Company).save(repo(Company).create({
      user: owner, name: `${label} Security Ltd`, companyNumber: String(60000000 + (seq += 1)), address: 'x', contactDetails: 'x',
    }));
    actors.set(owner.id, { company, role: CompanyMembershipRole.OWNER });
    const client = await repo(Client).save(repo(Client).create({ company, name: `${label} Client` } as Partial<Client>));
    const site = await repo(Site).save(repo(Site).create({
      company, client, name: `${label} Site`, address: 'x', welfareCheckIntervalMinutes: 60, timezone: 'Europe/London',
    }));
    const guardUser = await makeUser(UserRole.GUARD);
    const guard = await repo(GuardProfile).save(repo(GuardProfile).create({
      user: guardUser, fullName: `${label} Guard`, siaLicenseNumber: String(6500000000000000 + (seq += 1)), phone: '0',
    }));
    return { company, client, site, guard, owner };
  };
  type Tenant = Awaited<ReturnType<typeof makeTenant>>;
  const alpha = await makeTenant('Alpha');
  const bravo = await makeTenant('Bravo');

  const shift = async (t: Tenant, start: string, hours: number, status: string, opts: { on?: string; off?: string; checks?: string[]; guard?: GuardProfile } = {}) => {
    const row = await repo(Shift).save(repo(Shift).create({
      company: t.company, site: t.site, siteName: t.site.name, guard: opts.guard ?? t.guard,
      start: Z(start), end: new Date(Z(start).getTime() + hours * H), status, checkCallIntervalMinutes: 60,
    }));
    if (opts.on) await repo(AttendanceEvent).save(repo(AttendanceEvent).create({ shift: row, guard: opts.guard ?? t.guard, type: AttendanceEventType.CHECK_IN, occurredAt: Z(opts.on) }));
    if (opts.off) await repo(AttendanceEvent).save(repo(AttendanceEvent).create({ shift: row, guard: opts.guard ?? t.guard, type: AttendanceEventType.CHECK_OUT, occurredAt: Z(opts.off) }));
    for (const at of opts.checks ?? []) {
      const log = await repo(DailyLog).save(repo(DailyLog).create({ company: t.company, guard: opts.guard ?? t.guard, shift: row, message: 'ok', logType: DailyLogType.WELFARE_CHECK }));
      await ds.query('UPDATE daily_logs SET "createdAt" = $1 WHERE id = $2', [Z(at), log.id]);
    }
    return row;
  };
  const alertRow = async (t: Tenant, s: Shift, fields: Partial<SafetyAlert>, createdAt: string) => {
    const row = await repo(SafetyAlert).save(repo(SafetyAlert).create({
      company: t.company, guard: t.guard, shift: s, type: SafetyAlertType.MISSED_CHECKCALL, priority: SafetyAlertPriority.HIGH, message: 'm', ...fields,
    }));
    await ds.query('UPDATE safety_alerts SET "createdAt" = $1 WHERE id = $2', [Z(createdAt), row.id]);
    return row;
  };
  const audit = async (t: Tenant, action: string, entityType: string, entityId: number, userId: number | null, afterData: object, at: string) => {
    const row = await repo(AuditLog).save(repo(AuditLog).create({ company: t.company, user: userId ? { id: userId } as User : null, action, entityType, entityId, afterData } as Partial<AuditLog>));
    await ds.query('UPDATE audit_logs SET "createdAt" = $1 WHERE id = $2', [Z(at), row.id]);
    return row;
  };

  // ── Alpha's week, 12-18 October 2026 (BST) ─────────────────────────────────────────────────────
  const controller = await makeUser(UserRole.COMPANY_STAFF, 'Cara', 'Control');
  actors.set(controller.id, { company: alpha.company, role: CompanyMembershipRole.CONTROL_ROOM });
  const finance = await makeUser(UserRole.COMPANY_STAFF, 'Finn', 'Finance');
  actors.set(finance.id, { company: alpha.company, role: CompanyMembershipRole.FINANCE });
  const viewer = await makeUser(UserRole.COMPANY_STAFF, 'Vic', 'Viewer');
  actors.set(viewer.id, { company: alpha.company, role: CompanyMembershipRole.VIEWER });

  // Booked off on time, timesheet approved.
  const onTime = await shift(alpha, '2026-10-12T07:00:00Z', 8, 'completed', { on: '2026-10-12T06:58:00Z', off: '2026-10-12T15:02:00Z', checks: Array.from({ length: 8 }, (_, i) => new Date(Z('2026-10-12T07:20:00Z').getTime() + i * H).toISOString()) });
  await repo(Timesheet).save(repo(Timesheet).create({ shift: onTime, guard: alpha.guard, company: alpha.company, hoursWorked: 8, approvalStatus: 'approved' } as Partial<Timesheet>));
  // Early Book Off, like pilot shift 33: 21:00-07:00 BST, booked off 02:09 BST.
  const early = await shift(alpha, '2026-10-17T20:00:00Z', 10, 'completed', {
    on: '2026-10-17T18:29:00Z', off: '2026-10-18T01:09:36Z',
    checks: ['2026-10-17T20:45:00Z', '2026-10-17T21:02:00Z', '2026-10-17T22:01:00Z', '2026-10-17T23:01:00Z', '2026-10-18T00:03:00Z'],
  });
  // Reconciled: booked on, never booked off, closed by Control with a reason.
  const reconciled = await shift(alpha, '2026-10-13T19:00:00Z', 10, 'completed', { on: '2026-10-13T18:49:00Z', checks: ['2026-10-13T19:30:00Z'] });
  const reconAudit = await audit(alpha, 'shift.reconciled_without_book_off', 'shift', reconciled.id, alpha.owner.id,
    { shiftId: reconciled.id, reason: 'app_connectivity_failure', reconciledAt: '2026-10-17T17:02:19.000Z', bookOffAt: null }, '2026-10-17T17:02:19Z');
  // Live and overdue: booked on, past end + 15 minutes, a missing Book Off alert open.
  const missing = await shift(alpha, '2026-10-17T22:00:00Z', 10, 'in_progress', { on: '2026-10-17T21:55:00Z' });
  const mbo = await alertRow(alpha, missing, { type: SafetyAlertType.MISSING_BOOK_OFF, priority: SafetyAlertPriority.MEDIUM, status: SafetyAlertStatus.OPEN }, '2026-10-18T08:18:00Z');
  // Never booked on; cancelled; scheduled later today.
  await shift(alpha, '2026-10-14T07:00:00Z', 8, 'missed');
  await shift(alpha, '2026-10-15T07:00:00Z', 8, 'cancelled');
  const tonight = await shift(alpha, '2026-10-18T20:00:00Z', 10, 'ready');
  // A guard whose name begins like a spreadsheet formula.
  const hostile = await repo(GuardProfile).save(repo(GuardProfile).create({
    user: await makeUser(UserRole.GUARD), fullName: '=HYPERLINK("http://example.invalid","x")', siaLicenseNumber: String(6599999999999999), phone: '0',
  }));
  await shift(alpha, '2026-10-16T07:00:00Z', 2, 'completed', { on: '2026-10-16T07:00:00Z', off: '2026-10-16T09:00:00Z', guard: hostile, checks: ['2026-10-16T07:10:00Z', '2026-10-16T08:10:00Z'] });

  // Welfare history on the reconciled shift: window 1 missed and raised, resolved by the controller; window 2
  // missed under an alert the previous rule closed by itself; window 3 recorded after that closure: no alert.
  const ev1 = await alertRow(alpha, reconciled, { status: SafetyAlertStatus.CLOSED, closedAt: Z('2026-10-13T21:08:00Z'), welfareWindowIndex: 1 }, '2026-10-13T21:08:00Z');
  const s1 = await alertRow(alpha, reconciled, {
    status: SafetyAlertStatus.CLOSED, welfareWindowIndex: null, acknowledgedAt: Z('2026-10-13T21:15:00Z'), acknowledgedByUserId: controller.id,
    closedAt: Z('2026-10-13T21:30:00Z'), closedByUserId: controller.id, resolutionReason: 'guard_confirmed_safe',
  }, '2026-10-13T21:08:00Z');
  await audit(alpha, 'welfare_check.window_missed', 'safety_alert', ev1.id, null, { shiftId: reconciled.id }, '2026-10-13T21:08:00Z');
  await audit(alpha, 'welfare_check.summary_opened', 'safety_alert', s1.id, null, { shiftId: reconciled.id }, '2026-10-13T21:08:00Z');
  await audit(alpha, 'safety_alert.closed', 'safety_alert', s1.id, controller.id, { shiftId: reconciled.id }, '2026-10-13T21:30:00Z');
  const ev2 = await alertRow(alpha, reconciled, { status: SafetyAlertStatus.CLOSED, closedAt: Z('2026-10-13T22:08:00Z'), welfareWindowIndex: 2 }, '2026-10-13T22:08:00Z');
  const s2 = await alertRow(alpha, reconciled, { status: SafetyAlertStatus.CLOSED, welfareWindowIndex: null, closedAt: Z('2026-10-13T22:40:00Z') }, '2026-10-13T22:08:00Z');
  const ev3 = await alertRow(alpha, reconciled, { status: SafetyAlertStatus.CLOSED, closedAt: Z('2026-10-13T23:08:00Z'), welfareWindowIndex: 3 }, '2026-10-13T23:08:00Z');

  // Bravo: a shift on the same day, which Alpha must never see.
  const theirs = await shift(bravo, '2026-10-17T20:00:00Z', 10, 'completed', { on: '2026-10-17T20:00:00Z', off: '2026-10-18T06:00:00Z' });

  const week = { from: '2026-10-12', to: '2026-10-18' };
  const attendance = () => exportService.shiftAttendance(alpha.owner.id, UserRole.COMPANY_ADMIN, week, NOW);
  const welfare = () => exportService.welfareMonitoring(alpha.owner.id, UserRole.COMPANY_ADMIN, week, NOW);
  const col = (sheet: { columns: string[] }, name: string) => {
    const i = sheet.columns.indexOf(name);
    assert.ok(i >= 0, `column ${name}`);
    return i;
  };
  const rowFor = (sheet: { columns: string[]; rows: string[][] }, shiftId: number) => sheet.rows.filter((r) => r[col(sheet, 'Shift ID')] === String(shiftId));

  try {
    await test('EXP-01-RANGES-ARE-VALIDATED', async () => {
      for (const bad of [{}, { from: '2026-10-01' }, { from: '01-10-2026', to: '2026-10-02' }, { from: '2026-02-31', to: '2026-03-01' }]) {
        assert.throws(() => parseReportRange(bad), BadRequestException, JSON.stringify(bad));
      }
      assert.throws(() => parseReportRange({ from: '2026-10-05', to: '2026-10-04' }), /before/);
      assert.throws(() => parseReportRange({ from: '2026-10-01', to: '2026-11-01' }), /31 days/, '32 days refused');
      assert.equal(parseReportRange({ from: '2026-10-01', to: '2026-10-31' }).days, 31, 'a 31-day month is allowed');
      assert.equal(parseReportRange({ from: '2026-10-18', to: '2026-10-18' }).days, 1, 'a single day');
      const autumn = parseReportRange({ from: '2026-10-25', to: '2026-10-25' });
      assert.equal(autumn.endExclusive.getTime() - autumn.start.getTime(), 25 * H, 'the clock-change day is 25 hours long');
      await refused(() => exportService.shiftAttendance(alpha.owner.id, UserRole.COMPANY_ADMIN, { ...week, siteId: 'x' }, NOW), BadRequestException, 'site id');
    });

    await test('EXP-02-ATTENDANCE-REPORTS-WHAT-WAS-RECORDED-AND-NOTHING-ELSE', async () => {
      const sheet = await attendance();
      const status = (id: number) => rowFor(sheet, id)[0][col(sheet, 'Attendance status')];
      assert.equal(status(onTime.id), 'Booked off');
      assert.equal(status(early.id), 'Booked off early');
      assert.equal(status(reconciled.id), 'Closed without Book Off');
      assert.equal(status(missing.id), 'Missing Book Off');
      assert.equal(status(tonight.id), 'Scheduled');
      const e = rowFor(sheet, early.id)[0];
      assert.equal(e[col(sheet, 'Early Book Off')], 'Yes — 290 min before scheduled end', '02:09 against 07:00 BST');
      assert.equal(e[col(sheet, 'Book Off')], '18-10-2026 02:09');
      assert.equal(e[col(sheet, 'Book Off (UTC)')], '2026-10-18T01:09:36Z');
      assert.equal(e[col(sheet, 'Scheduled start')], '17-10-2026 21:00');
      assert.equal(e[col(sheet, 'Site timezone')], 'Europe/London');
      const r = rowFor(sheet, reconciled.id)[0];
      assert.equal(r[col(sheet, 'Book Off')], '', 'no Book Off is invented');
      assert.equal(r[col(sheet, 'Book Off (UTC)')], '');
      assert.equal(r[col(sheet, 'Reconciliation')], 'Closed without Book Off — Application/connectivity failure, by Alpha Owner, 17-10-2026 18:02');
      assert.equal(r[col(sheet, 'Reconciliation audit ref')], `audit #${reconAudit.id}`);
      const m = rowFor(sheet, missing.id)[0];
      assert.equal(m[col(sheet, 'Missing Book Off')], `Yes (alert #${mbo.id}, Open)`);
      assert.equal(m[col(sheet, 'Book Off')], '');
      assert.equal(rowFor(sheet, onTime.id)[0][col(sheet, 'Timesheet status')], 'Approved');
      assert.equal(rowFor(sheet, early.id)[0][col(sheet, 'Timesheet status')], 'No timesheet', 'never an invented approval');
      assert.equal(rowFor(sheet, onTime.id)[0][col(sheet, 'Early Book Off')], 'No');
    });

    await test('EXP-03-WELFARE-ROWS-SEPARATE-HISTORY-FROM-ALERTS', async () => {
      const sheet = await welfare();
      const rows = rowFor(sheet, reconciled.id);
      assert.equal(rows.length, 10, 'one row per window');
      const w = (i: number) => rows[i];
      assert.equal(w(0)[col(sheet, 'Status')], 'Completed');
      assert.equal(w(0)[col(sheet, 'Check recorded at')], '13-10-2026 20:30');
      assert.equal(w(0)[col(sheet, 'Check recorded at (UTC)')], '2026-10-13T19:30:00Z');

      assert.equal(w(1)[col(sheet, 'Status')], 'Missed');
      assert.equal(w(1)[col(sheet, 'Missed-window record')], `Record #${ev1.id} (history, not an alert)`);
      assert.match(w(1)[col(sheet, 'Missed-window audit ref')], /recorded$/);
      assert.equal(w(1)[col(sheet, 'Alert')], `#${s1.id}`);
      assert.equal(w(1)[col(sheet, 'Alert status')], 'Resolved by control room');
      assert.equal(w(1)[col(sheet, 'Acknowledged')], '13-10-2026 22:15 by Cara Control');
      assert.equal(w(1)[col(sheet, 'Resolved')], '13-10-2026 22:30 by Cara Control');
      assert.equal(w(1)[col(sheet, 'Resolution reason')], 'Guard confirmed safe');
      assert.match(w(1)[col(sheet, 'Alert audit refs')], /opened; .* closed$/);

      assert.equal(w(2)[col(sheet, 'Alert')], `#${s2.id}`);
      assert.equal(w(2)[col(sheet, 'Alert status')], 'Closed automatically (previous rule)', 'never "resolved" for what no person resolved');
      assert.match(w(2)[col(sheet, 'Resolved')], /automatically \(previous rule\)$/);
      assert.ok(!/Resolved by/.test(w(2).join('|')));

      assert.equal(w(3)[col(sheet, 'Missed-window record')], `Record #${ev3.id} (history, not an alert)`);
      assert.equal(w(3)[col(sheet, 'Alert')], 'No alert raised');
      assert.equal(w(3)[col(sheet, 'Alert status')], '');
      // Windows 4-9 were missed too but never recorded: no record and no alert is invented for them.
      assert.equal(w(4)[col(sheet, 'Status')], 'Missed');
      assert.equal(w(4)[col(sheet, 'Missed-window record')], '');
      assert.equal(w(4)[col(sheet, 'Alert')], '');
    });

    await test('EXP-04-EARLY-BOOK-OFF-AND-UPCOMING-WINDOWS', async () => {
      const sheet = await welfare();
      const statuses = rowFor(sheet, early.id).map((r) => r[col(sheet, 'Status')]);
      assert.deepEqual(statuses, ['Completed', 'Completed', 'Completed', 'Completed', 'Completed', 'Ended at Book Off',
        'Not required', 'Not required', 'Not required', 'Not required']);
      assert.ok(rowFor(sheet, tonight.id).every((r) => r[col(sheet, 'Status')] === 'Upcoming'), 'tonight, not yet booked on');
      assert.equal(rowFor(sheet, early.id)[3][col(sheet, 'Window')], '00:00–01:00', 'site-local, across midnight');
      assert.equal(rowFor(sheet, early.id)[3][col(sheet, 'Window start')], '18-10-2026 00:00');
    });

    await test('EXP-05-AUTUMN-CLOCK-CHANGE', async () => {
      const night = await shift(alpha, '2026-10-24T20:00:00Z', 11, 'completed', { on: '2026-10-24T20:00:00Z', off: '2026-10-25T07:00:00Z' });
      const sheet = await exportService.welfareMonitoring(alpha.owner.id, UserRole.COMPANY_ADMIN, { from: '2026-10-24', to: '2026-10-25' }, Z('2026-10-25T12:00:00Z'));
      const rows = rowFor(sheet, night.id);
      assert.equal(rows.length, 11, 'eleven real hours, eleven windows');
      const starts = rows.map((r) => r[col(sheet, 'Window start')]);
      assert.equal(starts.filter((s) => s === '25-10-2026 01:00').length, 2, '01:00 happens twice on the site clock');
      const utcStarts = new Set(rows.map((r) => r[col(sheet, 'Window start (UTC)')]));
      assert.equal(utcStarts.size, 11, 'and the UTC column tells them apart');
      assert.match(sheet.timezoneNote, /Europe\/London/);
    });

    await test('EXP-06-COMPANY-ISOLATION', async () => {
      const sheet = await attendance();
      const ids = sheet.rows.map((r) => r[col(sheet, 'Shift ID')]);
      assert.ok(!ids.includes(String(theirs.id)), "another company's shift is never in the report");
      assert.ok(sheet.rows.every((r) => r[col(sheet, 'Company')] === alpha.company.name));
      // Alpha naming Bravo's site gets nothing; the company always comes from the signed-in user.
      const forged = await exportService.shiftAttendance(alpha.owner.id, UserRole.COMPANY_ADMIN, { ...week, siteId: String(bravo.site.id) }, NOW);
      assert.deepEqual(forged.rows, []);
      const bravoSheet = await exportService.welfareMonitoring(bravo.owner.id, UserRole.COMPANY_ADMIN, week, NOW);
      assert.ok(bravoSheet.rows.every((r) => r[col(bravoSheet, 'Shift ID')] === String(theirs.id)));
    });

    await test('EXP-07-PERMISSIONS-ARE-THE-OPERATIONAL-REPORTS-PERMISSION', async () => {
      const asControl = await exportService.shiftAttendance(controller.id, UserRole.COMPANY_STAFF, week, NOW);
      assert.ok(asControl.rows.length > 0, 'control room may export');
      await refused(() => exportService.shiftAttendance(finance.id, UserRole.COMPANY_STAFF, week, NOW), ForbiddenException, 'finance');
      await refused(() => exportService.welfareMonitoring(viewer.id, UserRole.COMPANY_STAFF, week, NOW), ForbiddenException, 'viewer');
      for (const role of [CompanyMembershipRole.OWNER, CompanyMembershipRole.ADMIN, CompanyMembershipRole.OPERATIONS, CompanyMembershipRole.CONTROL_ROOM]) {
        assert.ok(hasPermission(role, CompanyPermission.REPORTS_OPERATIONAL), `${role} holds reports.operational`);
      }
    });

    await test('EXP-08-VALUES-ARE-DATA-NOT-FORMULAS-AND-NO-CONTACT-DETAILS', async () => {
      const sheet = await attendance();
      const hostileRow = sheet.rows.find((r) => r[col(sheet, 'Guard')].startsWith('=HYPERLINK'));
      assert.ok(hostileRow, 'the name is reported verbatim as data; the file writer guards it (mobile spec)');
      const all = JSON.stringify(await welfare()) + JSON.stringify(sheet);
      assert.doesNotMatch(all, /@example\.invalid/, 'no email addresses');
      assert.doesNotMatch(all, /passwordHash|siaLicenseNumber|65\d{14}/, 'no credentials or licence numbers');
    });

    await test('EXP-09-EMPTY-AND-OVERSIZED-REPORTS', async () => {
      const empty = await exportService.welfareMonitoring(alpha.owner.id, UserRole.COMPANY_ADMIN, { from: '2026-09-01', to: '2026-09-07' }, NOW);
      assert.deepEqual(empty.rows, []);
      assert.ok(empty.columns.length > 10 && empty.summary.length > 0, 'headings and a summary, never an error');
      const big = await makeTenant('Big');
      await ds.query(
        `INSERT INTO shifts ("companyId", "siteId", "siteName", start, "end", status, "checkCallIntervalMinutes")
           SELECT $1, $2, 'Big Site', timestamp '2026-10-01 08:00' + (g || ' minutes')::interval,
                  timestamp '2026-10-01 09:00' + (g || ' minutes')::interval, 'unfilled', 60
             FROM generate_series(1, $3) g`,
        [big.company.id, big.site.id, REPORT_MAX_SHIFTS + 1],
      );
      await refused(() => exportService.shiftAttendance(big.owner.id, UserRole.COMPANY_ADMIN, { from: '2026-10-01', to: '2026-10-07' }, NOW), BadRequestException, 'over the shift cap');
    });

    await test('EXP-10-READS-DO-NOT-GROW-WITH-THE-NUMBER-OF-SHIFTS', async () => {
      let statements = 0;
      const pg = require('pg');
      const original = pg.Client.prototype.query;
      pg.Client.prototype.query = function (...args: unknown[]) { statements += 1; return original.apply(this, args); };
      try {
        statements = 0;
        await exportService.welfareMonitoring(alpha.owner.id, UserRole.COMPANY_ADMIN, { from: '2026-10-12', to: '2026-10-12' }, NOW);
        const oneDay = statements;
        statements = 0;
        await exportService.welfareMonitoring(alpha.owner.id, UserRole.COMPANY_ADMIN, week, NOW);
        const wholeWeek = statements;
        assert.ok(wholeWeek <= oneDay + 2, `bounded statements: ${oneDay} for one shift, ${wholeWeek} for the week`);
        statements = 0;
        await exportService.shiftAttendance(alpha.owner.id, UserRole.COMPANY_ADMIN, week, NOW);
        assert.ok(statements <= 8, `attendance report: ${statements} statements`);
        console.log(JSON.stringify({ event: 'operations_export_statements', welfareOneDay: oneDay, welfareWeek: wholeWeek, attendanceWeek: statements }));
      } finally {
        pg.Client.prototype.query = original;
      }
    });

    console.log(JSON.stringify({ event: 'operations_export_certified', tests: passed }));
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(`\nFAIL  ${error?.message ?? error}`);
  console.error(error);
  process.exit(1);
});
