/**
 * Phase 0b scheduling safety (owner-approved 22 Oct 2026).
 *
 * Retiming a shift that keeps its Guard runs the Guard's full eligibility check against the new window:
 *   SS-01  a ready shift retimed into an overlap is refused; times and status are unchanged
 *   SS-02  an offered shift retimed into an overlap is refused
 *   SS-03  a retime into the Guard's approved leave is refused
 *   SS-04  a retime while the Guard's compliance is invalid is refused
 *   SS-05  a retime after the company relationship is revoked is refused
 *   SS-06  a clean retime saves, and the status is unchanged (no new acceptance is asked of the Guard)
 *   SS-07  a shift may move over its own previous window
 *   SS-08  an unfilled shift is retimed without any Guard check
 *   SS-09  an in-progress shift still cannot be retimed (409)
 *   SS-10  another company's shift is not found (404)
 *   SS-11  a retime racing a rota assignment of the same Guard into the same window: exactly one succeeds
 *
 * Close without Book Off:
 *   SS-12  deterministic deadlock regression: while reconciliation waits for the welfare sweep's per-shift lock, the
 *          sweep's own alert insert for that shift completes; both commit, nobody is aborted
 *   SS-13  reconciliation still waits for Book Off's row lock (stays serialised against a real Book Off)
 *   SS-14  reconciliation fabricates no Book Off and leaves the Book On evidence exactly as it was
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';

import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { equal, ok } from 'node:assert/strict';
import { DataSource } from 'typeorm';

import { AttendanceEvent, AttendanceEventType } from '../src/attendance/entities/attendance.entity';
import { JwtPayload } from '../src/auth/types/jwt-payload.type';
import { AvailabilityService } from '../src/availability/availability.service';
import { GuardAvailabilityOverride } from '../src/availability/entities/guard-availability-override.entity';
import { GuardAvailabilityRule } from '../src/availability/entities/guard-availability-rule.entity';
import { Company, CompanyStatus } from '../src/company/entities/company.entity';
import { CompanyGuard, CompanyGuardStatus } from '../src/company-guard/entities/company-guard.entity';
import { OperationsProjectionService } from '../src/coverage/operations-projection.service';
import { DailyLog } from '../src/daily-log/entities/daily-log.entity';
import { buildTypeOrmOptions } from '../src/database/typeorm.config';
import { GuardApprovalStatus, GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Job } from '../src/job/entities/job.entity';
import { JobApplication } from '../src/job-application/entities/job-application.entity';
import { WELFARE_SWEEP_LOCK_NAMESPACE } from '../src/operations/advisory-locks';
import { LogBookWindowService } from '../src/operations/log-book-window.service';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import { WelfareWindowService } from '../src/operations/welfare-window.service';
import { RotaSlot } from '../src/rota-slot/entities/rota-slot.entity';
import { RotaSlotService } from '../src/rota-slot/rota-slot.service';
import {
  SafetyAlert, SafetyAlertPriority, SafetyAlertStatus, SafetyAlertType,
} from '../src/safety-alert/entities/safety-alert.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { ShiftReconciliationService } from '../src/shift/shift-reconciliation.service';
import { ShiftService } from '../src/shift/shift.service';
import { Site } from '../src/site/entities/site.entity';
import { Timesheet } from '../src/timesheet/entities/timesheet.entity';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';

const TEST_PREFIX = 'SS-TEST';
const dbUrl =
  process.env.ROTA_SLOT_TEST_DB_URL ||
  'postgresql://postgres:postgres@127.0.0.1:54322/s4_migration_rehearsal';
if (!process.env.ROTA_SLOT_TEST_DB_URL) {
  console.warn('[scheduling-safety] ROTA_SLOT_TEST_DB_URL not set — using local rehearsal DB');
}

const MIN = 60_000;
const HOLD_MS = 150;
let passed = 0;
const pass = (id: string, detail: string) => { passed += 1; console.log(`PASS  ${id}: ${detail}`); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const companyUser: JwtPayload = {
  sub: 999997, role: UserRole.COMPANY_ADMIN, email: 'company@ss.example', status: UserStatus.ACTIVE,
};

/** What the Guard's eligibility looks like for this test: leave windows, compliance, relationship. */
type Policy = { leave: Array<{ guardId: number; start: Date; end: Date }>; complianceValid: boolean; relationshipActive: boolean };

function makeServices(ds: DataSource, company: Company, site: Site, guards: GuardProfile[], policy: Policy, holdChecks = false) {
  const compliance = {
    assertGuardAssignable: async () => {
      if (!policy.complianceValid) throw new ForbiddenException('Compliance invalid: SIA licence expired');
    },
  } as any;
  const companyGuards = {
    ensureActiveRelationship: async () => {
      if (!policy.relationshipActive) throw new ForbiddenException('Guard is not active/approved for this company');
    },
  } as any;
  const real = new AvailabilityService(
    ds.getRepository(GuardAvailabilityRule), ds.getRepository(GuardAvailabilityOverride), ds.getRepository(Shift),
    ds.getRepository(CompanyGuard), {} as any, {} as any, {} as any,
    {
      hasApprovedLeaveOverlap: async (_c: number, guardId: number, start: Date, end: Date) =>
        policy.leave.some((l) => l.guardId === guardId && l.start < end && l.end > start),
    } as any,
    compliance, { log: async () => undefined } as any,
  );
  // The real check, optionally held open so that concurrent requests overlap in time.
  const availability = {
    assertGuardCanTakeShift: async (...args: Parameters<AvailabilityService['assertGuardCanTakeShift']>) => {
      const result = await real.assertGuardCanTakeShift(...args);
      if (holdChecks) await sleep(HOLD_MS);
      return result;
    },
  } as any;
  const byId = new Map(guards.map((g) => [g.id, g]));
  const membership = { resolveCompanyContext: async () => ({ company, membershipRole: 'owner' as any }) } as any;
  const windowEngine = new OperationalWindowService();
  const shifts = new ShiftService(
    ds.getRepository(Shift), ds.getRepository(Company), ds.getRepository(GuardProfile),
    ds.getRepository(Job), ds.getRepository(JobApplication), ds.getRepository(Timesheet),
    { findOne: async () => null } as any, { createForShift: async () => null } as any,
    { findOne: async () => site, findMany: async () => [site] } as any,
    membership,
    { findByUserId: async () => null, findOne: async (id: number) => byId.get(id) ?? null } as any,
    companyGuards, availability, compliance, ds,
    { log: async () => undefined, logInTransaction: async () => undefined } as any,
    new OperationsProjectionService(
      ds.getRepository(AttendanceEvent), ds.getRepository(DailyLog), ds.getRepository(SafetyAlert), windowEngine,
      new WelfareWindowService(windowEngine), new LogBookWindowService(windowEngine),
    ),
  );
  const rota = new RotaSlotService(
    ds.getRepository(RotaSlot), ds.getRepository(Shift), ds.getRepository(Site), ds.getRepository(GuardProfile),
    ds, membership, companyGuards, availability, { log: async () => undefined } as any,
  );
  const reconciliation = new ShiftReconciliationService(
    ds, membership, { log: async () => undefined, logInTransaction: async () => undefined } as any,
  );
  return { shifts, rota, reconciliation };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function createCompany(ds: DataSource, suffix: string) {
  const owner = await ds.getRepository(User).save(ds.getRepository(User).create({
    email: `company-${suffix}@${TEST_PREFIX}.example`, passwordHash: 'x', role: UserRole.COMPANY_ADMIN,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const company = await ds.getRepository(Company).save(ds.getRepository(Company).create({
    user: owner, name: `${TEST_PREFIX}-${suffix}`, companyNumber: `SS-${suffix.slice(0, 8)}`, address: 'Test',
    contactDetails: 'test', status: CompanyStatus.ACTIVE,
  }));
  const site = await ds.getRepository(Site).save(ds.getRepository(Site).create({
    company, name: `${TEST_PREFIX}-Site-${suffix}`, address: 'Test', status: 'active',
    requiredGuardCount: 1, welfareCheckIntervalMinutes: 60,
  }));
  return { company, site };
}

async function createGuard(ds: DataSource, company: Company, suffix: string): Promise<GuardProfile> {
  const user = await ds.getRepository(User).save(ds.getRepository(User).create({
    email: `guard-${suffix}@${TEST_PREFIX}.example`, passwordHash: 'x', role: UserRole.GUARD,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const guard = await ds.getRepository(GuardProfile).save(ds.getRepository(GuardProfile).create({
    user, fullName: `SS Guard ${suffix}`, siaLicenseNumber: `SS${suffix.padStart(14, '0').slice(-14)}`,
    phone: '07700900000', status: GuardApprovalStatus.APPROVED, approvalStatus: GuardApprovalStatus.APPROVED,
    isApproved: true,
  }));
  await ds.getRepository(CompanyGuard).save(ds.getRepository(CompanyGuard).create({
    company, guard, status: CompanyGuardStatus.ACTIVE,
  }));
  return guard;
}

async function createShift(
  ds: DataSource, company: Company, site: Site, guard: GuardProfile | null, start: Date | string, end: Date | string, status: string,
): Promise<Shift> {
  return ds.getRepository(Shift).save(ds.getRepository(Shift).create({
    company, site, guard, siteName: site.name, start: new Date(start), end: new Date(end),
    checkCallIntervalMinutes: 60, status,
  }));
}

const reload = (ds: DataSource, id: number) => ds.getRepository(Shift).findOneOrFail({ where: { id } });
const okPolicy = (): Policy => ({ leave: [], complianceValid: true, relationshipActive: true });

async function expectRefused(promise: Promise<unknown>, type: Function, pattern: RegExp, label: string) {
  try {
    await promise;
  } catch (e: any) {
    const message = String(e?.message);
    ok(e instanceof type, `${label}: refused with ${type.name} (got ${e?.constructor?.name}: ${message})`);
    ok(pattern.test(message), `${label}: reason matches ${pattern} (got "${message}")`);
    return;
  }
  throw new Error(`${label}: expected a refusal, but the request succeeded`);
}

async function assertUnchanged(ds: DataSource, before: Shift, label: string) {
  const after = await reload(ds, before.id);
  equal(after.start.getTime(), before.start.getTime(), `${label}: start unchanged`);
  equal(after.end.getTime(), before.end.getTime(), `${label}: end unchanged`);
  equal(after.status, before.status, `${label}: status unchanged`);
}

async function cleanup(ds: DataSource) {
  const companies = `SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%'`;
  await ds.query(`DELETE FROM safety_alerts WHERE "companyId" IN (${companies})`);
  await ds.query(`DELETE FROM attendance_events WHERE "shiftId" IN (SELECT id FROM shifts WHERE "companyId" IN (${companies}))`);
  await ds.query(`DELETE FROM timesheets WHERE "companyId" IN (${companies})`);
  await ds.query(`DELETE FROM shifts WHERE "companyId" IN (${companies})`);
  await ds.query(`DELETE FROM rota_slots WHERE "companyId" IN (${companies})`);
  await ds.query(`DELETE FROM company_guards WHERE "companyId" IN (${companies})`);
  await ds.query(`DELETE FROM sites WHERE "companyId" IN (${companies})`);
  await ds.query(`DELETE FROM companies WHERE name LIKE '${TEST_PREFIX}%'`);
  await ds.query(`DELETE FROM guard_profiles WHERE "userId" IN (SELECT id FROM users WHERE email LIKE '%@${TEST_PREFIX}.example')`);
  await ds.query(`DELETE FROM users WHERE email LIKE '%@${TEST_PREFIX}.example'`);
}

// ── Retiming ──────────────────────────────────────────────────────────────────

async function retimeTests(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'retime');
  const guard = await createGuard(ds, company, 'retime-g1');
  const policy = okPolicy();
  const { shifts } = makeServices(ds, company, site, [guard], policy);

  // The Guard's other committed shift, 2027-09-10 14:00–20:00.
  await createShift(ds, company, site, guard, '2027-09-10T14:00:00Z', '2027-09-10T20:00:00Z', 'ready');

  const ready = await createShift(ds, company, site, guard, '2027-09-10T06:00:00Z', '2027-09-10T12:00:00Z', 'ready');
  await expectRefused(
    shifts.updateForUser(companyUser, ready.id, { start: '2027-09-10T08:00:00Z', end: '2027-09-10T15:00:00Z' } as any),
    ForbiddenException, /overlapping shift/i, 'SS-01',
  );
  await assertUnchanged(ds, ready, 'SS-01');
  pass('SS-01', 'ready shift retimed into an overlap: 403, times and status unchanged');

  const offered = await createShift(ds, company, site, guard, '2027-09-11T06:00:00Z', '2027-09-11T12:00:00Z', 'offered');
  await createShift(ds, company, site, guard, '2027-09-11T13:00:00Z', '2027-09-11T18:00:00Z', 'offered');
  await expectRefused(
    shifts.updateForUser(companyUser, offered.id, { end: '2027-09-11T14:00:00Z' } as any),
    ForbiddenException, /overlapping shift/i, 'SS-02',
  );
  await assertUnchanged(ds, offered, 'SS-02');
  pass('SS-02', 'offered shift retimed into an overlap: 403, unchanged');

  const leaveShift = await createShift(ds, company, site, guard, '2027-09-12T06:00:00Z', '2027-09-12T12:00:00Z', 'ready');
  policy.leave.push({ guardId: guard.id, start: new Date('2027-09-13T00:00:00Z'), end: new Date('2027-09-14T00:00:00Z') });
  await expectRefused(
    shifts.updateForUser(companyUser, leaveShift.id, { start: '2027-09-13T06:00:00Z', end: '2027-09-13T12:00:00Z' } as any),
    ForbiddenException, /approved leave/i, 'SS-03',
  );
  await assertUnchanged(ds, leaveShift, 'SS-03');
  pass('SS-03', 'retime into approved leave: 403, unchanged');

  policy.complianceValid = false;
  await expectRefused(
    shifts.updateForUser(companyUser, leaveShift.id, { end: '2027-09-12T13:00:00Z' } as any),
    ForbiddenException, /compliance/i, 'SS-04',
  );
  await assertUnchanged(ds, leaveShift, 'SS-04');
  policy.complianceValid = true;
  pass('SS-04', 'retime while compliance is invalid: 403, unchanged');

  policy.relationshipActive = false;
  await expectRefused(
    shifts.updateForUser(companyUser, leaveShift.id, { end: '2027-09-12T13:00:00Z' } as any),
    ForbiddenException, /not active/i, 'SS-05',
  );
  await assertUnchanged(ds, leaveShift, 'SS-05');
  policy.relationshipActive = true;
  pass('SS-05', 'retime after the relationship is revoked: 403, unchanged');

  const saved = await shifts.updateForUser(companyUser, leaveShift.id, { start: '2027-09-12T07:00:00Z', end: '2027-09-12T13:00:00Z' } as any);
  const afterClean = await reload(ds, leaveShift.id);
  equal(afterClean.start.toISOString(), '2027-09-12T07:00:00.000Z', 'SS-06: start saved');
  equal(afterClean.end.toISOString(), '2027-09-12T13:00:00.000Z', 'SS-06: end saved');
  equal(afterClean.status, 'ready', 'SS-06: status unchanged (no new acceptance asked of the Guard)');
  equal(saved.guard?.id, guard.id, 'SS-06: the Guard keeps the shift');
  pass('SS-06', 'clean retime saves; status stays ready, Guard kept');

  await shifts.updateForUser(companyUser, leaveShift.id, { start: '2027-09-12T08:00:00Z', end: '2027-09-12T14:00:00Z' } as any);
  equal((await reload(ds, leaveShift.id)).start.toISOString(), '2027-09-12T08:00:00.000Z', 'SS-07: moved over its own old window');
  pass('SS-07', 'a shift may move over its own previous window');

  policy.complianceValid = false;
  const unfilled = await createShift(ds, company, site, null, '2027-09-10T15:00:00Z', '2027-09-10T19:00:00Z', 'unfilled');
  await shifts.updateForUser(companyUser, unfilled.id, { end: '2027-09-10T20:00:00Z' } as any);
  equal((await reload(ds, unfilled.id)).end.toISOString(), '2027-09-10T20:00:00.000Z', 'SS-08: unfilled retime saved');
  policy.complianceValid = true;
  pass('SS-08', 'an unfilled shift is retimed with no Guard check');

  const live = await createShift(ds, company, site, guard, '2027-09-15T06:00:00Z', '2027-09-15T12:00:00Z', 'in_progress');
  await expectRefused(
    shifts.updateForUser(companyUser, live.id, { end: '2027-09-15T13:00:00Z' } as any),
    ConflictException, /in progress/i, 'SS-09',
  );
  await assertUnchanged(ds, live, 'SS-09');
  pass('SS-09', 'an in-progress shift still cannot be retimed (409)');

  const other = await createCompany(ds, 'retime-other');
  const otherGuard = await createGuard(ds, other.company, 'retime-other-g1');
  const foreign = await createShift(ds, other.company, other.site, otherGuard, '2027-09-16T06:00:00Z', '2027-09-16T12:00:00Z', 'ready');
  await expectRefused(
    shifts.updateForUser(companyUser, foreign.id, { end: '2027-09-16T13:00:00Z' } as any),
    NotFoundException, /not found/i, 'SS-10',
  );
  await assertUnchanged(ds, foreign, 'SS-10');
  pass('SS-10', "another company's shift: 404, unchanged");
}

async function retimeRace(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'race');
  const guard = await createGuard(ds, company, 'race-g1');
  const { shifts, rota } = makeServices(ds, company, site, [guard], okPolicy(), true);
  const mine = await createShift(ds, company, site, guard, '2027-09-20T06:00:00Z', '2027-09-20T10:00:00Z', 'ready');
  const slot = await rota.createSlot(companyUser, {
    siteId: site.id, startAt: '2027-09-20T12:00:00Z', endAt: '2027-09-20T16:00:00Z', requiredGuardCount: 1,
  });
  const [position] = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id } });
  const results = await Promise.allSettled([
    shifts.updateForUser(companyUser, mine.id, { start: '2027-09-20T11:00:00Z', end: '2027-09-20T15:00:00Z' } as any),
    rota.assignPosition(companyUser, slot.id, { shiftId: position.id, guardId: guard.id }),
  ]);
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  equal(succeeded, 1, 'SS-11: exactly one of retime / assign succeeds');
  const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
  ok(refused.reason instanceof ForbiddenException, `SS-11: the other is refused as overlapping (got ${refused.reason?.message})`);
  const [{ n }] = await ds.query(
    `SELECT count(*)::int AS n FROM shifts a JOIN shifts b ON a."guardId" = b."guardId" AND a.id < b.id
       AND a.start < b."end" AND a."end" > b.start
     WHERE a."companyId" = $1 AND a.status IN ('scheduled','offered','ready','in_progress')
       AND b.status IN ('scheduled','offered','ready','in_progress')`,
    [company.id],
  );
  equal(n, 0, 'SS-11: no Guard is double-booked');
  pass('SS-11', 'retime racing a rota assignment of the same Guard: exactly one succeeds, nobody double-booked');
}

// ── Close without Book Off ─────────────────────────────────────────────────────

async function liveShiftAwaitingBookOff(ds: DataSource, company: Company, site: Site, guard: GuardProfile) {
  const now = Date.now();
  const shift = await createShift(ds, company, site, guard, new Date(now - 5 * 60 * MIN), new Date(now - 60 * MIN), 'in_progress');
  await ds.getRepository(AttendanceEvent).save(ds.getRepository(AttendanceEvent).create({
    shift, guard, type: AttendanceEventType.CHECK_IN, occurredAt: new Date(now - 5 * 60 * MIN + 2 * MIN),
  }));
  return shift;
}

const attendanceRows = async (ds: DataSource, shiftId: number) =>
  ds.query(`SELECT id, type, "occurredAt" FROM attendance_events WHERE "shiftId" = $1 ORDER BY id`, [shiftId]);

async function reconciliationTests(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'recon');
  const guard = await createGuard(ds, company, 'recon-g1');
  const { reconciliation } = makeServices(ds, company, site, [guard], okPolicy());

  // SS-12: the welfare sweep holds the per-shift lock and, while reconciliation waits for it, inserts an alert for
  // the shift (as recordWelfareMiss / maintainMissingBookOff do). The insert's foreign-key check takes FOR KEY SHARE
  // on the shift row, which reconciliation's row lock must not block.
  const shift = await liveShiftAwaitingBookOff(ds, company, site, guard);
  const evidenceBefore = await attendanceRows(ds, shift.id);
  const sweep = ds.createQueryRunner();
  await sweep.connect();
  await sweep.startTransaction();
  let sweepError: any = null;
  let reconcileError: any = null;
  try {
    await sweep.query('SELECT pg_advisory_xact_lock($1, $2)', [WELFARE_SWEEP_LOCK_NAMESPACE, shift.id]);
    const reconcile = reconciliation
      .reconcileWithoutBookOff(companyUser, shift.id, { reason: 'guard_forgot_book_off' } as any)
      .catch((e) => { reconcileError = e; return null; });
    await sleep(500); // reconciliation now holds its row lock and waits for the sweep's lock
    try {
      await sweep.manager.getRepository(SafetyAlert).save(sweep.manager.getRepository(SafetyAlert).create({
        company, guard, shift, type: SafetyAlertType.OTHER, status: SafetyAlertStatus.OPEN,
        priority: SafetyAlertPriority.HIGH, message: `${TEST_PREFIX} sweep insert during reconciliation`,
      }));
      await sweep.commitTransaction();
    } catch (e) {
      sweepError = e;
      await sweep.rollbackTransaction();
    }
    const result = await reconcile;
    ok(!sweepError, `SS-12: the sweep's insert completes (got ${sweepError?.code} ${sweepError?.message})`);
    ok(!reconcileError, `SS-12: reconciliation completes (got ${reconcileError?.code} ${reconcileError?.message})`);
    ok(result, 'SS-12: reconciliation returns its result');
  } finally {
    if (sweep.isTransactionActive) await sweep.rollbackTransaction();
    await sweep.release();
  }
  equal((await reload(ds, shift.id)).status, 'completed', 'SS-12: the shift is closed');
  const [{ n: sweepAlerts }] = await ds.query(
    `SELECT count(*)::int AS n FROM safety_alerts WHERE "shiftId" = $1 AND message LIKE $2`, [shift.id, `${TEST_PREFIX}%`],
  );
  equal(sweepAlerts, 1, "SS-12: the sweep's alert is recorded");
  pass('SS-12', 'reconciliation waiting on the sweep lock no longer deadlocks with the sweep\'s alert insert; both commit');

  // SS-14 on the same shift: no Book Off fabricated, the Book On untouched.
  const evidenceAfter = await attendanceRows(ds, shift.id);
  equal(JSON.stringify(evidenceAfter), JSON.stringify(evidenceBefore), 'SS-14: attendance evidence byte-identical');
  ok(!evidenceAfter.some((e: any) => e.type === AttendanceEventType.CHECK_OUT), 'SS-14: no Book Off was written');
  pass('SS-14', 'reconciliation writes no Book Off and leaves the Book On exactly as it was');

  // SS-13: a Book Off holds FOR UPDATE on the shift row (attendance.service checkOut); reconciliation must wait.
  const second = await liveShiftAwaitingBookOff(ds, company, site, guard);
  const bookOff = ds.createQueryRunner();
  await bookOff.connect();
  await bookOff.startTransaction();
  try {
    await bookOff.query('SELECT "status" FROM "shifts" WHERE "id" = $1 FOR UPDATE', [second.id]);
    let settled = false;
    const reconcile = reconciliation
      .reconcileWithoutBookOff(companyUser, second.id, { reason: 'guard_forgot_book_off' } as any)
      .finally(() => { settled = true; });
    await sleep(700);
    equal(settled, false, 'SS-13: reconciliation waits while a Book Off holds the shift row');
    await bookOff.rollbackTransaction();
    await reconcile;
    equal((await reload(ds, second.id)).status, 'completed', 'SS-13: reconciliation completes once the row is free');
  } finally {
    if (bookOff.isTransactionActive) await bookOff.rollbackTransaction();
    await bookOff.release();
  }
  pass('SS-13', "reconciliation is still serialised against Book Off's row lock");
}

async function main() {
  const ds = new DataSource(buildTypeOrmOptions({
    DATABASE_URL: dbUrl, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test',
  }));
  await ds.initialize();
  try {
    await cleanup(ds);
    await retimeTests(ds);
    await retimeRace(ds);
    await reconciliationTests(ds);
    console.log(`\n${passed} scheduling safety checks passed`);
  } finally {
    await cleanup(ds);
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('[scheduling-safety] FAILED:', err);
  process.exit(1);
});
