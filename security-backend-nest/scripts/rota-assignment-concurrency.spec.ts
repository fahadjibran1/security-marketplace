/**
 * Rota assignment concurrency (Phase 0, 22 Oct 2026): concurrent assignments are answered truthfully and can
 * never double-book a Guard.
 *
 *   RAC-01  two Guards, one position, at once: exactly one wins; the other gets a 409; one audit entry
 *   RAC-02  one Guard, two overlapping positions, at once: exactly one wins; the other is refused as overlapping
 *   RAC-03  one Guard, two non-overlapping positions, at once: both succeed (the lock does not over-serialise)
 *   RAC-04  two Guards, two positions of the same slot, at once: both succeed
 *   RAC-05  across paths: a shift created with a Guard and a rota assignment of that Guard, overlapping, at once
 *   RAC-06  across paths: a shift reassigned to a Guard and a rota assignment of that Guard, overlapping, at once
 *   RAC-07  a write refused after the checks (the position was cancelled in between): 409, no audit, no Guard
 *   RAC-08  across paths: a rota time change into an overlap and a rota assignment, at once: exactly one succeeds
 *   RAC-09  mixed load across three Guards: every request settles, only expected refusals, no Guard double-booked
 *
 * The overlap check is the real AvailabilityService one. A hook holds each check open briefly, so without the
 * Guard assignment lock both concurrent requests would pass their checks before either wrote.
 */
import 'reflect-metadata';

import { ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { equal, ok } from 'node:assert/strict';
import { DataSource } from 'typeorm';

import { JwtPayload } from '../src/auth/types/jwt-payload.type';
import { AvailabilityService } from '../src/availability/availability.service';
import { GuardAvailabilityOverride } from '../src/availability/entities/guard-availability-override.entity';
import { GuardAvailabilityRule } from '../src/availability/entities/guard-availability-rule.entity';
import { Company, CompanyStatus } from '../src/company/entities/company.entity';
import { CompanyGuard, CompanyGuardStatus } from '../src/company-guard/entities/company-guard.entity';
import { OperationsProjectionService } from '../src/coverage/operations-projection.service';
import { buildTypeOrmOptions } from '../src/database/typeorm.config';
import { AttendanceEvent } from '../src/attendance/entities/attendance.entity';
import { DailyLog } from '../src/daily-log/entities/daily-log.entity';
import { GuardApprovalStatus, GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Job } from '../src/job/entities/job.entity';
import { JobApplication } from '../src/job-application/entities/job-application.entity';
import { LogBookWindowService } from '../src/operations/log-book-window.service';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import { WelfareWindowService } from '../src/operations/welfare-window.service';
import { RotaSlot } from '../src/rota-slot/entities/rota-slot.entity';
import { RotaSlotService } from '../src/rota-slot/rota-slot.service';
import { SafetyAlert } from '../src/safety-alert/entities/safety-alert.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { ShiftService } from '../src/shift/shift.service';
import { Site } from '../src/site/entities/site.entity';
import { Timesheet } from '../src/timesheet/entities/timesheet.entity';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';

const TEST_PREFIX = 'RAC-TEST';
const dbUrl =
  process.env.ROTA_SLOT_TEST_DB_URL ||
  'postgresql://postgres:postgres@127.0.0.1:54322/s4_migration_rehearsal';

if (!process.env.ROTA_SLOT_TEST_DB_URL) {
  console.warn('[rota-assignment-concurrency] ROTA_SLOT_TEST_DB_URL not set — using local rehearsal DB');
}

const CHECK_HOLD_MS = 150;
const COMMITTED = ['scheduled', 'offered', 'ready', 'in_progress'];

let passed = 0;
const pass = (id: string, detail: string) => { passed += 1; console.log(`PASS  ${id}: ${detail}`); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Services ──────────────────────────────────────────────────────────────────

type AuditEntry = { action: string; entityId?: number | null; afterData?: Record<string, unknown> | null };

function makeCapturingAudit() {
  const captured: AuditEntry[] = [];
  return { captured, stub: { log: async (input: AuditEntry) => { captured.push(input); return input; } } as any };
}

const membershipStub = (company: Company) => ({
  resolveCompanyContext: async () => ({ company, membershipRole: 'owner' as any }),
}) as any;
const passStub = { ensureActiveRelationship: async () => undefined, assertGuardAssignable: async () => undefined } as any;

/** The real overlap check, held open after it passes so concurrent requests overlap in time. */
function makeAvailability(ds: DataSource, afterCheck?: (args: unknown[]) => Promise<void>) {
  const real = new AvailabilityService(
    ds.getRepository(GuardAvailabilityRule),
    ds.getRepository(GuardAvailabilityOverride),
    ds.getRepository(Shift),
    ds.getRepository(CompanyGuard),
    {} as any,
    {} as any,
    {} as any,
    { hasApprovedLeaveOverlap: async () => false } as any,
    passStub,
    { log: async () => undefined } as any,
  );
  return {
    assertGuardCanTakeShift: async (...args: Parameters<AvailabilityService['assertGuardCanTakeShift']>) => {
      const result = await real.assertGuardCanTakeShift(...args);
      await sleep(CHECK_HOLD_MS);
      if (afterCheck) await afterCheck(args);
      return result;
    },
  } as any;
}

function makeRota(ds: DataSource, company: Company, availability: any, audit: any): RotaSlotService {
  return new RotaSlotService(
    ds.getRepository(RotaSlot), ds.getRepository(Shift), ds.getRepository(Site), ds.getRepository(GuardProfile),
    ds, membershipStub(company), passStub, availability, audit,
  );
}

function makeShifts(ds: DataSource, company: Company, site: Site, guards: GuardProfile[], availability: any): ShiftService {
  const byId = new Map(guards.map((g) => [g.id, g]));
  const windowEngine = new OperationalWindowService();
  return new ShiftService(
    ds.getRepository(Shift), ds.getRepository(Company), ds.getRepository(GuardProfile),
    ds.getRepository(Job), ds.getRepository(JobApplication), ds.getRepository(Timesheet),
    { findOne: async () => null } as any,
    { createForShift: async () => null } as any,
    { findOne: async () => site, findMany: async () => [site] } as any,
    membershipStub(company),
    { findByUserId: async () => null, findOne: async (id: number) => byId.get(id) ?? null } as any,
    passStub,
    availability,
    passStub,
    ds,
    { log: async () => undefined, logInTransaction: async () => undefined } as any,
    new OperationsProjectionService(
      ds.getRepository(AttendanceEvent), ds.getRepository(DailyLog), ds.getRepository(SafetyAlert), windowEngine,
      new WelfareWindowService(windowEngine), new LogBookWindowService(windowEngine),
    ),
  );
}

const companyUser: JwtPayload = {
  sub: 999998, role: UserRole.COMPANY_ADMIN, email: 'company@rac.example', status: UserStatus.ACTIVE,
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function createCompany(ds: DataSource, suffix: string) {
  const owner = await ds.getRepository(User).save(ds.getRepository(User).create({
    email: `company-${suffix}@${TEST_PREFIX}.example`, passwordHash: 'x', role: UserRole.COMPANY_ADMIN,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const company = await ds.getRepository(Company).save(ds.getRepository(Company).create({
    user: owner, name: `${TEST_PREFIX}-${suffix}`, companyNumber: `RAC-${suffix.slice(0, 8)}`, address: 'Test',
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
    user, fullName: `RAC Guard ${suffix}`, siaLicenseNumber: `RA${suffix.padStart(14, '0').slice(-14)}`,
    phone: '07700900000', status: GuardApprovalStatus.APPROVED, approvalStatus: GuardApprovalStatus.APPROVED,
    isApproved: true,
  }));
  await ds.getRepository(CompanyGuard).save(ds.getRepository(CompanyGuard).create({
    company, guard, status: CompanyGuardStatus.ACTIVE,
  }));
  return guard;
}

async function createSlot(rota: RotaSlotService, site: Site, startAt: string, endAt: string, required = 1) {
  const slot = await rota.createSlot(companyUser, { siteId: site.id, startAt, endAt, requiredGuardCount: required });
  return slot;
}

async function positions(ds: DataSource, slotId: number): Promise<Shift[]> {
  return ds.getRepository(Shift).find({ where: { rotaSlotId: slotId }, order: { id: 'ASC' } });
}

function settle<T>(results: PromiseSettledResult<T>[]) {
  return {
    ok: results.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled'),
    failed: results.filter((r): r is PromiseRejectedResult => r.status === 'rejected'),
  };
}

/** No Guard of this company holds two committed shifts that overlap. */
async function assertNoDoubleBooking(ds: DataSource, company: Company, label: string) {
  const [{ n }] = await ds.query(
    `SELECT count(*)::int AS n FROM shifts a JOIN shifts b
       ON a."guardId" = b."guardId" AND a.id < b.id AND a.start < b."end" AND a."end" > b.start
     WHERE a."companyId" = $1 AND b."companyId" = $1
       AND a.status = ANY($2) AND b.status = ANY($2)`,
    [company.id, COMMITTED],
  );
  equal(n, 0, `${label}: no Guard is double-booked`);
}

async function cleanup(ds: DataSource) {
  const companies = `SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%'`;
  await ds.query(`DELETE FROM timesheets WHERE "companyId" IN (${companies})`);
  await ds.query(`DELETE FROM shifts WHERE "companyId" IN (${companies})`);
  await ds.query(`DELETE FROM rota_slots WHERE "companyId" IN (${companies})`);
  await ds.query(`DELETE FROM company_guards WHERE "companyId" IN (${companies})`);
  await ds.query(`DELETE FROM sites WHERE "companyId" IN (${companies})`);
  await ds.query(`DELETE FROM companies WHERE name LIKE '${TEST_PREFIX}%'`);
  await ds.query(`DELETE FROM guard_profiles WHERE "userId" IN (SELECT id FROM users WHERE email LIKE '%@${TEST_PREFIX}.example')`);
  await ds.query(`DELETE FROM users WHERE email LIKE '%@${TEST_PREFIX}.example'`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function rac01(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'rac01');
  const g1 = await createGuard(ds, company, 'rac01a');
  const g2 = await createGuard(ds, company, 'rac01b');
  for (let round = 0; round < 3; round += 1) {
    const audit = makeCapturingAudit();
    const rota = makeRota(ds, company, makeAvailability(ds), audit.stub);
    const day = 10 + round;
    const slot = await createSlot(rota, site, `2027-08-${day}T08:00:00Z`, `2027-08-${day}T16:00:00Z`);
    const [position] = await positions(ds, slot.id);
    const r = settle(await Promise.allSettled([
      rota.assignPosition(companyUser, slot.id, { shiftId: position.id, guardId: g1.id }),
      rota.assignPosition(companyUser, slot.id, { shiftId: position.id, guardId: g2.id }),
    ]));
    equal(r.ok.length, 1, 'RAC-01: exactly one assignment succeeds');
    ok(r.failed[0].reason instanceof ConflictException, 'RAC-01: the other is a 409');
    const final = await ds.getRepository(Shift).findOneOrFail({ where: { id: position.id } });
    equal(final.status, 'offered', 'RAC-01: the position is offered');
    equal(final.guard?.id, r.ok[0].value.guard?.id, 'RAC-01: the response names the committed Guard');
    const entries = audit.captured.filter((a) => a.action === 'rota_slot.position_assigned');
    equal(entries.length, 1, 'RAC-01: exactly one audit entry');
    equal(entries[0].afterData?.guardId, final.guard?.id, 'RAC-01: the audit entry names the committed Guard');
  }
  pass('RAC-01', 'two Guards, one position, 3 rounds: one winner, one 409, one audit entry each time');
}

async function rac02(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'rac02');
  const guard = await createGuard(ds, company, 'rac02a');
  const audit = makeCapturingAudit();
  const rota = makeRota(ds, company, makeAvailability(ds), audit.stub);
  const a = await createSlot(rota, site, '2027-08-20T08:00:00Z', '2027-08-20T16:00:00Z');
  const b = await createSlot(rota, site, '2027-08-20T12:00:00Z', '2027-08-20T20:00:00Z');
  const [pa] = await positions(ds, a.id);
  const [pb] = await positions(ds, b.id);
  const r = settle(await Promise.allSettled([
    rota.assignPosition(companyUser, a.id, { shiftId: pa.id, guardId: guard.id }),
    rota.assignPosition(companyUser, b.id, { shiftId: pb.id, guardId: guard.id }),
  ]));
  equal(r.ok.length, 1, 'RAC-02: exactly one overlapping assignment succeeds');
  ok(r.failed[0].reason instanceof ForbiddenException, 'RAC-02: the other is refused');
  ok(/overlapping/i.test(r.failed[0].reason.message), 'RAC-02: refused as overlapping');
  equal(audit.captured.filter((a) => a.action === 'rota_slot.position_assigned').length, 1, 'RAC-02: exactly one position_assigned audit entry');
  await assertNoDoubleBooking(ds, company, 'RAC-02');
  pass('RAC-02', 'one Guard, two overlapping positions at once: one assigned, one refused as overlapping');
}

async function rac03(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'rac03');
  const guard = await createGuard(ds, company, 'rac03a');
  const audit = makeCapturingAudit();
  const rota = makeRota(ds, company, makeAvailability(ds), audit.stub);
  const a = await createSlot(rota, site, '2027-08-21T06:00:00Z', '2027-08-21T12:00:00Z');
  const b = await createSlot(rota, site, '2027-08-21T12:00:00Z', '2027-08-21T18:00:00Z');
  const [pa] = await positions(ds, a.id);
  const [pb] = await positions(ds, b.id);
  const r = settle(await Promise.allSettled([
    rota.assignPosition(companyUser, a.id, { shiftId: pa.id, guardId: guard.id }),
    rota.assignPosition(companyUser, b.id, { shiftId: pb.id, guardId: guard.id }),
  ]));
  equal(r.ok.length, 2, 'RAC-03: both back-to-back assignments succeed');
  equal(audit.captured.filter((a) => a.action === 'rota_slot.position_assigned').length, 2, 'RAC-03: two position_assigned audit entries');
  pass('RAC-03', 'one Guard, two back-to-back positions at once: both assigned');
}

async function rac04(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'rac04');
  const g1 = await createGuard(ds, company, 'rac04a');
  const g2 = await createGuard(ds, company, 'rac04b');
  const audit = makeCapturingAudit();
  const rota = makeRota(ds, company, makeAvailability(ds), audit.stub);
  const slot = await createSlot(rota, site, '2027-08-22T08:00:00Z', '2027-08-22T16:00:00Z', 2);
  const [p1, p2] = await positions(ds, slot.id);
  const r = settle(await Promise.allSettled([
    rota.assignPosition(companyUser, slot.id, { shiftId: p1.id, guardId: g1.id }),
    rota.assignPosition(companyUser, slot.id, { shiftId: p2.id, guardId: g2.id }),
  ]));
  equal(r.ok.length, 2, 'RAC-04: both positions are filled');
  const final = await positions(ds, slot.id);
  equal(new Set(final.map((s) => s.guard?.id)).size, 2, 'RAC-04: by two different Guards');
  pass('RAC-04', 'two Guards, two positions of one slot at once: both filled');
}

async function rac05(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'rac05');
  const guard = await createGuard(ds, company, 'rac05a');
  const availability = makeAvailability(ds);
  const rota = makeRota(ds, company, availability, makeCapturingAudit().stub);
  const shifts = makeShifts(ds, company, site, [guard], availability);
  const slot = await createSlot(rota, site, '2027-08-23T08:00:00Z', '2027-08-23T16:00:00Z');
  const [position] = await positions(ds, slot.id);
  const r = settle(await Promise.allSettled([
    rota.assignPosition(companyUser, slot.id, { shiftId: position.id, guardId: guard.id }),
    shifts.createForUser(companyUser, {
      siteId: site.id, guardId: guard.id, start: '2027-08-23T10:00:00Z', end: '2027-08-23T18:00:00Z',
    } as any),
  ]));
  equal(r.ok.length, 1, 'RAC-05: exactly one of create / assign succeeds');
  ok(r.failed[0].reason instanceof ForbiddenException, 'RAC-05: the other is refused as overlapping');
  await assertNoDoubleBooking(ds, company, 'RAC-05');
  pass('RAC-05', 'shift created with a Guard vs rota assignment of that Guard, overlapping: exactly one');
}

async function rac06(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'rac06');
  const guard = await createGuard(ds, company, 'rac06a');
  const availability = makeAvailability(ds);
  const rota = makeRota(ds, company, availability, makeCapturingAudit().stub);
  const shifts = makeShifts(ds, company, site, [guard], availability);
  const unassigned = await ds.getRepository(Shift).save(ds.getRepository(Shift).create({
    company, site, siteName: site.name, start: new Date('2027-08-24T10:00:00Z'), end: new Date('2027-08-24T18:00:00Z'),
    checkCallIntervalMinutes: 60, status: 'unfilled',
  }));
  const slot = await createSlot(rota, site, '2027-08-24T08:00:00Z', '2027-08-24T16:00:00Z');
  const [position] = await positions(ds, slot.id);
  const r = settle(await Promise.allSettled([
    rota.assignPosition(companyUser, slot.id, { shiftId: position.id, guardId: guard.id }),
    shifts.updateForUser(companyUser, unassigned.id, { guardId: guard.id } as any),
  ]));
  equal(r.ok.length, 1, 'RAC-06: exactly one of reassign / assign succeeds');
  ok(r.failed[0].reason instanceof ForbiddenException, 'RAC-06: the other is refused as overlapping');
  await assertNoDoubleBooking(ds, company, 'RAC-06');
  pass('RAC-06', 'shift reassigned to a Guard vs rota assignment of that Guard, overlapping: exactly one');
}

async function rac07(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'rac07');
  const guard = await createGuard(ds, company, 'rac07a');
  const audit = makeCapturingAudit();
  let positionId = 0;
  // The position is cancelled after every check has passed and before the write: the write must be refused.
  const availability = makeAvailability(ds, async () => {
    await ds.query(`UPDATE "shifts" SET "status" = 'cancelled' WHERE "id" = $1`, [positionId]);
  });
  const rota = makeRota(ds, company, availability, audit.stub);
  const slot = await createSlot(rota, site, '2027-08-25T08:00:00Z', '2027-08-25T16:00:00Z');
  const [position] = await positions(ds, slot.id);
  positionId = position.id;
  let error: unknown = null;
  try {
    await rota.assignPosition(companyUser, slot.id, { shiftId: position.id, guardId: guard.id });
  } catch (e) {
    error = e;
  }
  ok(error instanceof ConflictException, 'RAC-07: a refused write is a 409, not a success');
  equal(audit.captured.filter((a) => a.action === 'rota_slot.position_assigned').length, 0, 'RAC-07: no position_assigned audit entry for a refused write');
  const final = await ds.getRepository(Shift).findOneOrFail({ where: { id: position.id } });
  equal(final.status, 'cancelled', 'RAC-07: the position stays cancelled');
  equal(final.guard ?? null, null, 'RAC-07: no Guard was written');
  pass('RAC-07', 'position cancelled between check and write: 409, no audit entry, no Guard written');
}

async function rac08(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'rac08');
  const guard = await createGuard(ds, company, 'rac08a');
  const availability = makeAvailability(ds);
  const rota = makeRota(ds, company, availability, makeCapturingAudit().stub);
  const first = await createSlot(rota, site, '2027-08-26T06:00:00Z', '2027-08-26T10:00:00Z');
  const [firstPosition] = await positions(ds, first.id);
  await rota.assignPosition(companyUser, first.id, { shiftId: firstPosition.id, guardId: guard.id });
  const second = await createSlot(rota, site, '2027-08-26T13:00:00Z', '2027-08-26T17:00:00Z');
  const [secondPosition] = await positions(ds, second.id);
  const r = settle(await Promise.allSettled([
    rota.changeTime(companyUser, first.id, { startAt: '2027-08-26T12:00:00Z', endAt: '2027-08-26T16:00:00Z' }),
    rota.assignPosition(companyUser, second.id, { shiftId: secondPosition.id, guardId: guard.id }),
  ]));
  equal(r.ok.length, 1, 'RAC-08: exactly one of time change / assign succeeds');
  ok(
    r.failed[0].reason instanceof ForbiddenException || r.failed[0].reason instanceof UnprocessableEntityException,
    'RAC-08: the other is refused (overlap / time-change conflict)',
  );
  await assertNoDoubleBooking(ds, company, 'RAC-08');
  pass('RAC-08', 'rota time change into an overlap vs assignment of the same Guard: exactly one');
}

async function rac09(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'rac09');
  const guards = [await createGuard(ds, company, 'rac09a'), await createGuard(ds, company, 'rac09b'), await createGuard(ds, company, 'rac09c')];
  const availability = makeAvailability(ds);
  const rota = makeRota(ds, company, availability, makeCapturingAudit().stub);
  const shifts = makeShifts(ds, company, site, guards, availability);
  const windows = [['06:00', '12:00'], ['10:00', '16:00'], ['14:00', '20:00'], ['18:00', '23:00']];
  const slots = [];
  for (const [s, e] of windows) slots.push(await createSlot(rota, site, `2027-08-27T${s}:00Z`, `2027-08-27T${e}:00Z`, 2));
  const ops: Array<Promise<unknown>> = [];
  for (const slot of slots) {
    const ps = await positions(ds, slot.id);
    ps.forEach((p, i) => guards.forEach((g, gi) => {
      if ((i + gi) % 2 === 0) ops.push(rota.assignPosition(companyUser, slot.id, { shiftId: p.id, guardId: g.id }));
    }));
  }
  guards.forEach((g) => ops.push(shifts.createForUser(companyUser, {
    siteId: site.id, guardId: g.id, start: '2027-08-27T11:00:00Z', end: '2027-08-27T13:00:00Z',
  } as any)));
  const started = Date.now();
  const results = await Promise.race([
    Promise.allSettled(ops),
    sleep(120_000).then(() => { throw new Error('RAC-09: requests did not settle (possible deadlock)'); }),
  ]) as PromiseSettledResult<unknown>[];
  const r = settle(results);
  const unexpected = r.failed.filter((f) => !(f.reason instanceof ConflictException || f.reason instanceof ForbiddenException));
  equal(unexpected.length, 0, `RAC-09: only expected refusals (${unexpected.map((u) => String(u.reason?.message ?? u.reason)).join('; ')})`);
  ok(r.ok.length > 0, 'RAC-09: some requests succeed');
  await assertNoDoubleBooking(ds, company, 'RAC-09');
  pass('RAC-09', `${ops.length} mixed requests across 3 Guards settled in ${Date.now() - started} ms: ${r.ok.length} succeeded, ${r.failed.length} refused, nobody double-booked`);
}

async function main() {
  const ds = new DataSource(buildTypeOrmOptions({
    DATABASE_URL: dbUrl, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test',
  }));
  await ds.initialize();
  try {
    await cleanup(ds);
    await rac01(ds);
    await rac02(ds);
    await rac03(ds);
    await rac04(ds);
    await rac05(ds);
    await rac06(ds);
    await rac07(ds);
    await rac08(ds);
    await rac09(ds);
    console.log(`\n${passed} rota assignment concurrency checks passed`);
  } finally {
    await cleanup(ds);
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('[rota-assignment-concurrency] FAILED:', err);
  process.exit(1);
});
