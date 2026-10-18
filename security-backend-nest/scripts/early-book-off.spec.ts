/**
 * Early Book Off and coverage correctness (Welfare & Reporting Remediation, Phase 4).
 *
 * Pilot shift 33 booked off at 02:09 BST against a 07:00 scheduled end, and Live Operations called it
 * "Completed" — "Closed cleanly" in the drawer — with no word about the five hours left. These tests certify
 * the classification (more than 15 minutes early), the coverage assessment from other Guards' actual
 * attendance and assignments, and that nothing is written, closed or alerted along the way.
 *
 * Pure rule cases run first; the rest use the real EarlyBookOffService, CoverageService and
 * OperationsExportService on a real, disposable PostgreSQL database, with fixed instants and an explicit now.
 *
 * Needs EARLY_BOOK_OFF_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource, Repository } from 'typeorm';
import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Company } from '../src/company/entities/company.entity';
import { Site } from '../src/site/entities/site.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { AttendanceEvent, AttendanceEventType } from '../src/attendance/entities/attendance.entity';
import { DailyLog } from '../src/daily-log/entities/daily-log.entity';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { Timesheet } from '../src/timesheet/entities/timesheet.entity';
import { SafetyAlert } from '../src/safety-alert/entities/safety-alert.entity';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import { WelfareWindowService } from '../src/operations/welfare-window.service';
import { LogBookWindowService } from '../src/operations/log-book-window.service';
import { OperationsProjectionService } from '../src/coverage/operations-projection.service';
import { CoverageService } from '../src/coverage/coverage.service';
import { EarlyBookOffService } from '../src/coverage/early-book-off.service';
import { OperationsExportService } from '../src/report/operations-export.service';
import { CompanyMembershipRole, CompanyPermission, hasPermission } from '../src/company-membership/company-membership-types';
import { EARLY_BOOK_OFF_MINUTES, assessCoverage, assessStaffing, earlyBookOff } from '../src/operations/early-book-off';
import { RotaSlot } from '../src/rota-slot/entities/rota-slot.entity';
import { IncidentAnalyticsService } from '../src/report/incident-analytics.service';
import { Incident } from '../src/incident/entities/incident.entity';
import { DailyLogType } from '../src/daily-log/entities/daily-log.entity';
import { SafetyAlertPriority, SafetyAlertStatus, SafetyAlertType } from '../src/safety-alert/entities/safety-alert.entity';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

const Z = (iso: string) => new Date(iso);
const H = 3_600_000;
const M = 60_000;

async function main() {
  // ═══════════════════ the rules, pure ═══════════════════

  await test('EBO-01-THE-THRESHOLD-IS-MORE-THAN-15-MINUTES', () => {
    const end = Z('2026-10-18T06:00:00Z');
    assert.equal(EARLY_BOOK_OFF_MINUTES, 15);
    assert.equal(earlyBookOff(end, new Date(end.getTime() - 15 * M)), null, 'exactly 15 minutes early is not early');
    assert.equal(earlyBookOff(end, new Date(end.getTime() - 14 * M)), null, '14 minutes early is not early');
    assert.deepEqual(earlyBookOff(end, new Date(end.getTime() - 16 * M)), { minutesEarly: 16, remainingMinutes: 16 }, '16 minutes early is');
    assert.deepEqual(earlyBookOff(end, new Date(end.getTime() - 15 * M - 1000)), { minutesEarly: 15, remainingMinutes: 15 }, 'a second past the threshold is');
    assert.equal(earlyBookOff(end, new Date(end.getTime() + 10 * M)), null, 'a late Book Off is not early');
    assert.equal(earlyBookOff(end, null), null, 'no Book Off is never early');
    // Pilot shift 33: 02:09:36 BST (01:09:36Z) against 07:00 BST (06:00Z).
    assert.deepEqual(earlyBookOff(end, Z('2026-10-18T01:09:36Z')), { minutesEarly: 290, remainingMinutes: 290 });
  });

  await test('EBO-02-REMAINING-TIME-IS-REAL-TIME-ACROSS-THE-CLOCK-CHANGE', () => {
    // 25-10-2026: 07:00 GMT end, Book Off 00:30 BST (23:30Z on the 24th) — 7h30m of real time, though the
    // site clock reads 00:30 to 07:00.
    assert.equal(earlyBookOff(Z('2026-10-25T07:00:00Z'), Z('2026-10-24T23:30:00Z'))!.remainingMinutes, 450);
  });

  await test('EBO-03-COVERAGE-RULES', () => {
    const from = Z('2026-10-18T01:00:00Z');
    const to = Z('2026-10-18T06:00:00Z');
    const after = Z('2026-10-18T09:00:00Z');
    const other = (o: Partial<Parameters<typeof assessCoverage>[2][number]>) => ({
      shiftId: 9, status: 'completed', start: Z('2026-10-17T20:00:00Z'), end: Z('2026-10-18T06:00:00Z'), hasGuard: true, bookOnAt: null, bookOffAt: null, ...o,
    });
    assert.equal(assessCoverage(from, to, [], after).status, 'uncovered', 'nobody else');
    const present = assessCoverage(from, to, [other({ bookOnAt: Z('2026-10-17T19:55:00Z'), bookOffAt: Z('2026-10-18T06:02:00Z') })], after);
    assert.equal(present.status, 'maintained');
    assert.deepEqual(present.coveringShiftIds, [9]);
    const partial = assessCoverage(from, to, [other({ bookOnAt: Z('2026-10-17T19:55:00Z'), bookOffAt: Z('2026-10-18T03:00:00Z') })], after);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.coveredMinutes, 120);
    assert.equal(partial.uncoveredMinutes, 180);
    const unknown = assessCoverage(from, to, [other({ bookOnAt: Z('2026-10-17T19:55:00Z') })], after);
    assert.equal(unknown.status, 'undetermined', 'closed without a Book Off: when that Guard left is not known');
    const noShow = assessCoverage(from, to, [other({ status: 'missed' })], after);
    assert.equal(noShow.status, 'uncovered', 'a shift nobody worked covers nothing');
    // A future gap, from the schedule: an assigned shift that has not started.
    const now = Z('2026-10-18T02:00:00Z');
    const planned = assessCoverage(from, to, [
      other({ shiftId: 7, status: 'in_progress', bookOnAt: Z('2026-10-18T00:55:00Z') }),
    ], now);
    assert.equal(planned.status, 'maintained');
    assert.equal(planned.reliesOnSchedule, true, 'the part still ahead rests on the schedule, and says so');
    const unassigned = assessCoverage(from, to, [other({ status: 'unfilled', hasGuard: false })], now);
    assert.equal(unassigned.status, 'uncovered', 'an unfilled shift covers nothing');
  });

  await test('EBO-14-STAFFING-RULES', () => {
    const from = Z('2026-10-18T01:00:00Z');
    const to = Z('2026-10-18T06:00:00Z');
    const after = Z('2026-10-18T09:00:00Z');
    const other = (id: number, on: string | null, off: string | null, status = 'completed') => ({
      shiftId: id, status, start: Z('2026-10-17T20:00:00Z'), end: Z('2026-10-18T06:00:00Z'), hasGuard: true,
      bookOnAt: on ? Z(on) : null, bookOffAt: off ? Z(off) : null,
    });
    const staying = other(1, '2026-10-17T19:55:00Z', '2026-10-18T06:02:00Z');
    assert.equal(assessStaffing(from, to, [staying], after, 1).status, 'fully_staffed', 'one required, one stayed');
    const two = assessStaffing(from, to, [staying], after, 2);
    assert.equal(two.status, 'partially_staffed', 'two required, one stayed');
    assert.equal(two.minOnDuty, 1);
    assert.equal(two.shortMinutes, 300);
    assert.equal(assessStaffing(from, to, [], after, 2).status, 'unstaffed');
    assert.equal(assessStaffing(from, to, [staying, other(2, '2026-10-18T00:50:00Z', '2026-10-18T06:00:00Z')], after, 2).status, 'fully_staffed',
      'a replacement brings it back to two');
    assert.equal(assessStaffing(from, to, [staying, other(3, '2026-10-17T19:55:00Z', null)], after, 2).status, 'undetermined',
      'short of two while another departure is unrecorded');
    assert.equal(assessStaffing(from, to, [staying, other(3, '2026-10-17T19:55:00Z', null)], after, 1).status, 'fully_staffed',
      'enough without the unknown one');
  });

  // ═══════════════════ the real services ═══════════════════

  const url = process.env.EARLY_BOOK_OFF_DATABASE_URL;
  if (!url) throw new Error('EARLY_BOOK_OFF_DATABASE_URL is required (use a disposable database)');
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('early book off database must be local');
  const ds = new DataSource({ type: 'postgres', url, entities: appEntities, synchronize: true, dropSchema: true, logging: false });
  await ds.initialize();
  const repo = <T extends object>(entity: new () => T): Repository<T> => ds.getRepository(entity);

  const engine = new OperationalWindowService();
  const projection = new OperationsProjectionService(
    repo(AttendanceEvent), repo(DailyLog), repo(SafetyAlert), engine, new WelfareWindowService(engine), new LogBookWindowService(engine),
  );
  const earlyService = new EarlyBookOffService(repo(Shift), repo(AttendanceEvent), repo(RotaSlot));
  const actors = new Map<number, Company>();
  const membership = {
    resolveCompanyContext: async (userId: number, _role: UserRole, permission: CompanyPermission) => {
      if (!hasPermission(CompanyMembershipRole.OWNER, permission)) throw new Error('permission');
      return { company: actors.get(userId)! };
    },
  };
  const coverage = new CoverageService(repo(Shift), membership as never, {} as never, projection, earlyService);
  const reports = new OperationsExportService(
    repo(Shift), repo(AttendanceEvent), repo(Timesheet), repo(SafetyAlert), repo(AuditLog), repo(User), membership as never, projection, earlyService,
  );

  let seq = 0;
  const tenant = async (label: string) => {
    const owner = await repo(User).save(repo(User).create({ email: `${label}.${(seq += 1)}@example.invalid`, passwordHash: 'x', role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE }));
    const company = await repo(Company).save(repo(Company).create({ user: owner, name: `${label} Ltd`, companyNumber: String(70000000 + (seq += 1)), address: 'x', contactDetails: 'x' }));
    actors.set(owner.id, company);
    const site = (name: string) => repo(Site).save(repo(Site).create({ company, name, address: 'x', welfareCheckIntervalMinutes: 60, timezone: 'Europe/London' }));
    return { owner, company, gate: await site(`${label} Gate`), dock: await site(`${label} Dock`) };
  };
  type Tenant = Awaited<ReturnType<typeof tenant>>;
  const guard = async (name: string) => {
    const u = await repo(User).save(repo(User).create({ email: `g${(seq += 1)}@example.invalid`, passwordHash: 'x', role: UserRole.GUARD, status: UserStatus.ACTIVE }));
    return repo(GuardProfile).save(repo(GuardProfile).create({ user: u, fullName: name, siaLicenseNumber: String(6600000000000000 + seq), phone: '0' }));
  };
  const shift = async (t: Tenant, site: Site, g: GuardProfile | null, start: string, end: string, status: string, on?: string, off?: string) => {
    const row = await repo(Shift).save(repo(Shift).create({
      company: t.company, site, siteName: site.name, guard: g ?? undefined, start: Z(start), end: Z(end), status, checkCallIntervalMinutes: 60,
    }));
    if (on) await repo(AttendanceEvent).save(repo(AttendanceEvent).create({ shift: row, guard: g!, type: AttendanceEventType.CHECK_IN, occurredAt: Z(on) }));
    if (off) await repo(AttendanceEvent).save(repo(AttendanceEvent).create({ shift: row, guard: g!, type: AttendanceEventType.CHECK_OUT, occurredAt: Z(off) }));
    return row;
  };

  const alpha = await tenant('Alpha');
  const bravo = await tenant('Bravo');
  const [uma, rowan, theo, rhys, lena] = [await guard('Uma'), await guard('Rowan'), await guard('Theo'), await guard('Rhys'), await guard('Lena')];
  const NOW = Z('2026-10-18T11:00:00Z');
  const early = (o: { operations: { earlyBookOff?: unknown } | null }) => (o.operations?.earlyBookOff ?? null) as {
    minutesEarly: number; remainingMinutes: number; bookOffAt: string; scheduledEnd: string;
    coverage: { status: string; coveringShiftIds: number[]; coveredMinutes: number; uncoveredMinutes: number; unknownMinutes: number; reliesOnSchedule: boolean };
  } | null;
  const ops = async (t: Tenant, ids: number[], now = NOW) =>
    (await coverage.listShiftOperations(t.owner.id, UserRole.COMPANY_ADMIN, ids.join(','), now)) as Array<{ shiftId: number; operations: { earlyBookOff?: unknown } | null }>;

  // Gate, 17-18 Oct: Uma books off at 02:09 BST; Rowan is on the same 21:00-07:00 BST shift and stays.
  const umaGate = await shift(alpha, alpha.gate, uma, '2026-10-17T20:00:00Z', '2026-10-18T06:00:00Z', 'completed', '2026-10-17T18:29:00Z', '2026-10-18T01:09:36Z');
  const rowanGate = await shift(alpha, alpha.gate, rowan, '2026-10-17T20:00:00Z', '2026-10-18T06:00:00Z', 'completed', '2026-10-17T19:50:00Z', '2026-10-18T06:03:00Z');
  // Dock, 16-17 Oct: Theo books off at 01:00; Rhys's replacement shift starts at 03:00: partial.
  const theoDock = await shift(alpha, alpha.dock, theo, '2026-10-16T20:00:00Z', '2026-10-17T06:00:00Z', 'completed', '2026-10-16T19:55:00Z', '2026-10-17T00:00:00Z');
  const rhysReplacement = await shift(alpha, alpha.dock, rhys, '2026-10-17T02:00:00Z', '2026-10-17T06:00:00Z', 'completed', '2026-10-17T02:00:00Z', '2026-10-17T06:00:00Z');

  try {
    await test('EBO-04-ANOTHER-GUARD-PRESENT-KEEPS-COVERAGE', async () => {
      const [row] = (await ops(alpha, [umaGate.id])).filter((r) => r.shiftId === umaGate.id);
      const e = early(row)!;
      assert.equal(e.minutesEarly, 290);
      assert.equal(e.bookOffAt, '2026-10-18T01:09:36.000Z', 'the recorded Book Off, unchanged');
      assert.equal(e.scheduledEnd, '2026-10-18T06:00:00.000Z');
      assert.equal(e.coverage.status, 'maintained');
      assert.deepEqual(e.coverage.coveringShiftIds, [rowanGate.id]);
      assert.equal(early((await ops(alpha, [rowanGate.id]))[0]), null, 'Rowan, 3 minutes late off, is not early');
    });

    await test('EBO-05-A-REPLACEMENT-PART-WAY-THROUGH-IS-A-PARTIAL-GAP', async () => {
      const e = early((await ops(alpha, [theoDock.id]))[0])!;
      assert.equal(e.coverage.status, 'partial');
      assert.equal(e.coverage.uncoveredMinutes, 120, '01:00-03:00 BST before the replacement');
      assert.equal(e.coverage.coveredMinutes, 240);
      assert.deepEqual(e.coverage.coveringShiftIds, [rhysReplacement.id]);
    });

    await test('EBO-06-A-REPLACEMENT-FROM-THE-BOOK-OFF-MAINTAINS-COVERAGE', async () => {
      const left = await shift(alpha, alpha.dock, lena, '2026-10-14T07:00:00Z', '2026-10-14T15:00:00Z', 'completed', '2026-10-14T07:00:00Z', '2026-10-14T11:00:00Z');
      await shift(alpha, alpha.dock, rhys, '2026-10-14T11:00:00Z', '2026-10-14T15:00:00Z', 'completed', '2026-10-14T10:58:00Z', '2026-10-14T15:01:00Z');
      assert.equal(early((await ops(alpha, [left.id]))[0])!.coverage.status, 'maintained');
    });

    await test('EBO-07-A-GENUINELY-UNCOVERED-PERIOD', async () => {
      const alone = await shift(alpha, alpha.gate, theo, '2026-10-15T07:00:00Z', '2026-10-15T15:00:00Z', 'completed', '2026-10-15T07:00:00Z', '2026-10-15T10:00:00Z');
      // Another Gate shift that never happened, and one at the Dock (a different site), cover nothing.
      await shift(alpha, alpha.gate, rowan, '2026-10-15T07:00:00Z', '2026-10-15T15:00:00Z', 'missed');
      await shift(alpha, alpha.dock, rhys, '2026-10-15T07:00:00Z', '2026-10-15T15:00:00Z', 'completed', '2026-10-15T07:00:00Z', '2026-10-15T15:00:00Z');
      const e = early((await ops(alpha, [alone.id]))[0])!;
      assert.equal(e.coverage.status, 'uncovered');
      assert.equal(e.coverage.uncoveredMinutes, 300);
      assert.deepEqual(e.coverage.coveringShiftIds, []);
    });

    await test('EBO-08-AN-OVERLAP-CLOSED-WITHOUT-BOOK-OFF-IS-UNDETERMINED', async () => {
      const left = await shift(alpha, alpha.gate, uma, '2026-10-13T19:00:00Z', '2026-10-14T05:00:00Z', 'completed', '2026-10-13T18:55:00Z', '2026-10-13T23:00:00Z');
      await shift(alpha, alpha.gate, rowan, '2026-10-13T19:00:00Z', '2026-10-14T05:00:00Z', 'completed', '2026-10-13T18:50:00Z');
      assert.equal(early((await ops(alpha, [left.id]))[0])!.coverage.status, 'undetermined', 'never claimed covered or uncovered');
    });

    await test('EBO-09-A-GAP-STILL-AHEAD-USES-THE-SCHEDULE-AND-SAYS-SO', async () => {
      const left = await shift(alpha, alpha.dock, uma, '2026-10-19T07:00:00Z', '2026-10-19T15:00:00Z', 'completed', '2026-10-19T07:00:00Z', '2026-10-19T09:00:00Z');
      const later = await shift(alpha, alpha.dock, rowan, '2026-10-19T09:00:00Z', '2026-10-19T15:00:00Z', 'ready');
      const e = early((await ops(alpha, [left.id], Z('2026-10-19T09:30:00Z')))[0])!;
      assert.equal(e.coverage.status, 'partial', 'the replacement has not booked on: 09:00-09:30 is not covered');
      assert.equal(e.coverage.reliesOnSchedule, true);
      assert.deepEqual(e.coverage.coveringShiftIds, [later.id]);
    });

    await test('EBO-10-TWO-EARLY-LEAVERS-AT-ONE-SITE-COUNT-FOR-EACH-OTHER', async () => {
      const first = await shift(alpha, alpha.gate, uma, '2026-10-12T20:00:00Z', '2026-10-13T06:00:00Z', 'completed', '2026-10-12T20:00:00Z', '2026-10-13T01:00:00Z');
      const second = await shift(alpha, alpha.gate, rowan, '2026-10-12T20:00:00Z', '2026-10-13T06:00:00Z', 'completed', '2026-10-12T20:00:00Z', '2026-10-13T03:00:00Z');
      const rows = await ops(alpha, [first.id, second.id]);
      const f = early(rows.find((r) => r.shiftId === first.id)!)!;
      const s = early(rows.find((r) => r.shiftId === second.id)!)!;
      assert.equal(f.coverage.status, 'partial', 'the second Guard stayed two more hours');
      assert.equal(f.coverage.coveredMinutes, 120);
      assert.equal(s.coverage.status, 'uncovered', 'and nobody after the second left');
    });

    await test('EBO-11-COMPANY-ISOLATION', async () => {
      // Bravo has a Guard at a site of its own, at the same times: it never covers Alpha, and Alpha never sees it.
      const theirs = await shift(bravo, bravo.gate, lena, '2026-10-15T07:00:00Z', '2026-10-15T15:00:00Z', 'completed', '2026-10-15T07:00:00Z', '2026-10-15T15:00:00Z');
      const mine = (await ops(alpha, [umaGate.id, theirs.id])).map((r) => r.shiftId);
      assert.deepEqual(mine, [umaGate.id], "another company's shift is absent");
      const bravoLeft = await shift(bravo, bravo.gate, lena, '2026-10-15T07:00:00Z', '2026-10-15T15:00:00Z', 'completed', '2026-10-15T07:00:00Z', '2026-10-15T09:00:00Z');
      const e = early((await ops(bravo, [bravoLeft.id]))[0])!;
      assert.deepEqual(e.coverage.coveringShiftIds, [theirs.id], 'only its own company covers it');
    });

    await test('EBO-12-NOTHING-IS-WRITTEN', async () => {
      const count = async () => (await ds.query(`SELECT (SELECT count(*)::int FROM attendance_events) a, (SELECT count(*)::int FROM safety_alerts) s,
        (SELECT count(*)::int FROM shifts WHERE status <> 'completed') open, (SELECT count(*)::int FROM audit_logs) l, (SELECT count(*)::int FROM timesheets) t`))[0];
      const before = await count();
      await ops(alpha, [umaGate.id, theoDock.id]);
      await reports.shiftAttendance(alpha.owner.id, UserRole.COMPANY_ADMIN, { from: '2026-10-12', to: '2026-10-19' }, NOW);
      assert.deepEqual(await count(), before, 'no attendance, alert, status, audit or timesheet change');
    });

    await test('EBO-13-THE-ATTENDANCE-REPORT-STATES-IT', async () => {
      const sheet = await reports.shiftAttendance(alpha.owner.id, UserRole.COMPANY_ADMIN, { from: '2026-10-16', to: '2026-10-17' }, NOW);
      const col = (name: string) => sheet.columns.indexOf(name);
      const row = (id: number) => sheet.rows.find((r) => r[col('Shift ID')] === String(id))!;
      const uma33 = row(umaGate.id);
      assert.equal(uma33[col('Attendance status')], 'Booked off early');
      assert.equal(uma33[col('Book Off')], '18-10-2026 02:09');
      assert.equal(uma33[col('Scheduled end')], '18-10-2026 07:00');
      assert.equal(uma33[col('Early Book Off')], 'Yes — 290 min before scheduled end');
      assert.equal(uma33[col('Remaining scheduled time')], '4h 50m');
      assert.equal(uma33[col('Coverage after early Book Off')], 'Coverage maintained (covered 4h 50m)');
      assert.equal(uma33[col('Covering shift IDs')], String(rowanGate.id));
      const theo = row(theoDock.id);
      assert.equal(theo[col('Coverage after early Book Off')], 'Partial coverage gap (covered 4h, uncovered 2h)');
      const rowan = row(rowanGate.id);
      assert.equal(rowan[col('Early Book Off')], 'No');
      assert.equal(rowan[col('Coverage after early Book Off')], '', 'nothing claimed for a shift that was not early');
      assert.ok(sheet.summary.some((r) => r[0] === 'Partial coverage gap' && r[1] === '1'));
    });

    // ═══════════════════ staffing against the Rota Planner requirement (Phase 5) ═══════════════════

    const slot = async (t: Tenant, site: Site, start: string, end: string, required: number) =>
      repo(RotaSlot).save(repo(RotaSlot).create({ company: t.company, site, startAt: Z(start), endAt: Z(end), requiredGuardCount: required }));
    const inSlot = async (s: Shift, slotRow: RotaSlot) => { await ds.query('UPDATE shifts SET "rotaSlotId" = $1 WHERE id = $2', [slotRow.id, s.id]); };

    await test('EBO-15-A-TWO-GUARD-SLOT-WITH-ONE-LEFT-IS-PARTIALLY-STAFFED', async () => {
      const night = await slot(alpha, alpha.gate, '2026-10-11T20:00:00Z', '2026-10-12T06:00:00Z', 2);
      const leaver = await shift(alpha, alpha.gate, uma, '2026-10-11T20:00:00Z', '2026-10-12T06:00:00Z', 'completed', '2026-10-11T19:58:00Z', '2026-10-12T02:00:00Z');
      const stayer = await shift(alpha, alpha.gate, rowan, '2026-10-11T20:00:00Z', '2026-10-12T06:00:00Z', 'completed', '2026-10-11T19:58:00Z', '2026-10-12T06:01:00Z');
      await inSlot(leaver, night);
      await inSlot(stayer, night);
      const e = early((await ops(alpha, [leaver.id]))[0]) as unknown as { coverage: { status: string }; staffing: { status: string; required: number; minOnDuty: number; shortMinutes: number; rotaSlotId: number } };
      assert.equal(e.coverage.status, 'maintained', 'the site was still guarded');
      assert.equal(e.staffing.status, 'partially_staffed', 'but one short of the two the slot requires');
      assert.equal(e.staffing.required, 2);
      assert.equal(e.staffing.minOnDuty, 1);
      assert.equal(e.staffing.shortMinutes, 240);
      assert.equal(e.staffing.rotaSlotId, night.id);
    });

    await test('EBO-16-AN-AD-HOC-REPLACEMENT-FILLS-THE-SLOT-ANOTHER-SLOT-DOES-NOT', async () => {
      const day = await slot(alpha, alpha.dock, '2026-10-11T07:00:00Z', '2026-10-11T15:00:00Z', 1);
      const otherPost = await slot(alpha, alpha.dock, '2026-10-11T07:00:00Z', '2026-10-11T15:00:00Z', 1);
      const leaver = await shift(alpha, alpha.dock, uma, '2026-10-11T07:00:00Z', '2026-10-11T15:00:00Z', 'completed', '2026-10-11T07:00:00Z', '2026-10-11T11:00:00Z');
      await inSlot(leaver, day);
      const elsewhere = await shift(alpha, alpha.dock, rowan, '2026-10-11T07:00:00Z', '2026-10-11T15:00:00Z', 'completed', '2026-10-11T07:00:00Z', '2026-10-11T15:00:00Z');
      await inSlot(elsewhere, otherPost);
      let e = early((await ops(alpha, [leaver.id]))[0]) as unknown as { coverage: { status: string }; staffing: { status: string } };
      assert.equal(e.coverage.status, 'maintained', 'another post was guarded');
      assert.equal(e.staffing.status, 'unstaffed', "but that post's Guard does not fill this one");
      await shift(alpha, alpha.dock, theo, '2026-10-11T11:00:00Z', '2026-10-11T15:00:00Z', 'completed', '2026-10-11T10:59:00Z', '2026-10-11T15:00:00Z');
      e = early((await ops(alpha, [leaver.id]))[0]) as unknown as { coverage: { status: string }; staffing: { status: string } };
      assert.equal(e.staffing.status, 'fully_staffed', 'an ad hoc replacement (no slot) does');
    });

    await test('EBO-17-NO-ROTA-SLOT-MEANS-NO-ASSUMED-REQUIREMENT', async () => {
      const e = early((await ops(alpha, [umaGate.id]))[0]) as unknown as { staffing: unknown };
      assert.equal(e.staffing, null, 'not a Rota Planner shift: no requirement is assumed, even though sites default to 1');
      const sheet = await reports.shiftAttendance(alpha.owner.id, UserRole.COMPANY_ADMIN, { from: '2026-10-11', to: '2026-10-17' }, NOW);
      const col = (name: string) => sheet.columns.indexOf(name);
      const rowOf = (id: number) => sheet.rows.find((r) => r[col('Shift ID')] === String(id))!;
      assert.equal(rowOf(umaGate.id)[col('Staffing after early Book Off')], 'No staffing requirement set (not a Rota Planner shift)');
      const slotRows = sheet.rows.filter((r) => /^Partially staffed \(1 of 2 required at the lowest, short 4h\)$/.test(r[col('Staffing after early Book Off')]));
      assert.equal(slotRows.length, 1, 'the two-Guard slot reads partially staffed in the report');
    });

    // ═══════════════════ the corrected /reports/welfare counts (Phase 5) ═══════════════════

    await test('EBO-18-THE-WELFARE-REPORT-COUNTS-BOTH-CHECK-TYPES-AND-EACH-MISS-ONCE', async () => {
      const analytics = new IncidentAnalyticsService(
        repo(Incident), repo(SafetyAlert), repo(Shift), repo(AttendanceEvent), repo(DailyLog),
        { findByUserId: async (id: number) => actors.get(id) } as never, {} as never,
      );
      const s = await shift(bravo, bravo.dock, rhys, '2026-10-10T07:00:00Z', '2026-10-10T11:00:00Z', 'completed', '2026-10-10T07:00:00Z', '2026-10-10T11:00:00Z');
      for (const [at, type] of [['2026-10-10T07:20:00Z', DailyLogType.WELFARE_CHECK], ['2026-10-10T08:20:00Z', DailyLogType.CHECK_CALL], ['2026-10-10T10:20:00Z', DailyLogType.WELFARE_CHECK]] as const) {
        const log = await repo(DailyLog).save(repo(DailyLog).create({ company: bravo.company, guard: rhys, shift: s, message: 'ok', logType: type }));
        await ds.query('UPDATE daily_logs SET "createdAt" = $1 WHERE id = $2', [Z(at), log.id]);
      }
      // Window 2 missed: one evidence row and the shift's summary alert.
      for (const idx of [2, null]) {
        await repo(SafetyAlert).save(repo(SafetyAlert).create({
          company: bravo.company, guard: rhys, shift: s, type: SafetyAlertType.MISSED_CHECKCALL, priority: SafetyAlertPriority.HIGH,
          status: idx === null ? SafetyAlertStatus.OPEN : SafetyAlertStatus.CLOSED, welfareWindowIndex: idx, message: 'm',
        }));
      }
      const report = await analytics.getWelfareReport(bravo.owner.id, { startDate: '2026-10-10', endDate: '2026-10-10' } as never);
      const rows = report.records as unknown as Array<{ shiftId: number; expectedCheckCalls: number; completedCheckCalls: number; missedCheckCalls: number; complianceRate: number }>;
      const row = rows.find((r) => r.shiftId === s.id)!;
      assert.equal(row.expectedCheckCalls, 4);
      assert.equal(row.completedCheckCalls, 3, 'welfare_check and check_call both count, each once');
      assert.equal(row.missedCheckCalls, 1, 'one missed window, not two (the summary is not a second miss)');
      assert.equal(row.complianceRate, 75);
    });

    console.log(JSON.stringify({ event: 'early_book_off_certified', tests: passed }));
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(`\nFAIL  ${error?.message ?? error}`);
  console.error(error);
  process.exit(1);
});
