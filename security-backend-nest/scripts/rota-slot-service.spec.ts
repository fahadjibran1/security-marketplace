/**
 * R4B2 PostgreSQL certification for RotaSlotService.
 *
 * Requires a real PostgreSQL database with all migrations applied.
 *
 * Environment variables:
 *   ROTA_SLOT_TEST_DB_URL — connection URL (defaults to local dev DB at port 54322)
 *
 * Usage:
 *   npm run test:rota-slot
 *   ROTA_SLOT_TEST_DB_URL=postgresql://... npm run test:rota-slot
 *
 * Tests certified:
 *   CREATE-1: createSlot fans out N shifts atomically
 *   CREATE-ROLLBACK: fan-out failure rolls back slot creation
 *   REQ-INC: changeRequirement increase adds unfilled positions
 *   REQ-DEC: changeRequirement decrease cancels surplus (unfilled-first)
 *   REQ-FLOOR: changeRequirement blocked below committed floor
 *   CHANGE-TIME: changeTime propagates to all non-cancelled child shifts
 *   CHANGE-INTERVAL: changeCheckCallInterval propagates to active children only
 *   ASSIGN-CONCURRENCY: two simultaneous assignPosition calls, exactly one wins
 *   CANCEL-POS: cancelPosition rejects blocked statuses, accepts cancellable ones
 *   CANCEL-SLOT: cancelSlot cancels active positions, preserves completed/missed
 */

import 'reflect-metadata';

import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { DataSource } from 'typeorm';

import { JwtPayload } from '../src/auth/types/jwt-payload.type';
import { buildTypeOrmOptions } from '../src/database/typeorm.config';
import { GuardApprovalStatus, GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { RotaSlot } from '../src/rota-slot/entities/rota-slot.entity';
import { RotaSlotService } from '../src/rota-slot/rota-slot.service';
import { Shift } from '../src/shift/entities/shift.entity';
import { Site } from '../src/site/entities/site.entity';
import { Company, CompanyStatus } from '../src/company/entities/company.entity';
import { CompanyGuard, CompanyGuardStatus } from '../src/company-guard/entities/company-guard.entity';
import { CompanyGuardService } from '../src/company-guard/company-guard.service';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';

const TEST_PREFIX = 'ROTA-TEST';

const dbUrl =
  process.env.ROTA_SLOT_TEST_DB_URL ||
  'postgresql://postgres:postgres@127.0.0.1:54322/s4_migration_rehearsal';

if (!process.env.ROTA_SLOT_TEST_DB_URL) {
  console.warn('[rota-slot] ROTA_SLOT_TEST_DB_URL not set — using local dev DB at 127.0.0.1:54322');
}

// ── Stubs for external service dependencies ──────────────────────────────────

const membershipStub = (company: Company) => ({
  resolveCompanyContext: async () => ({ company, membershipRole: 'owner' as any }),
});

const companyGuardStub = {
  ensureActiveRelationship: async () => undefined,
} as any as CompanyGuardService;

const availabilityStub = {
  assertGuardCanTakeShift: async () => undefined,
} as any;

const auditStub = {
  log: async () => undefined,
} as any;

const stubUser: JwtPayload = {
  sub: 999999,
  role: UserRole.COMPANY_ADMIN,
  email: 'test@rota-test.example',
  status: UserStatus.ACTIVE,
};

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function seedFixture(ds: DataSource) {
  const users = ds.getRepository(User);
  const companyUser = await users.save(users.create({
    email: `company@${TEST_PREFIX}.example`,
    passwordHash: 'not-used',
    role: UserRole.COMPANY_ADMIN,
    status: UserStatus.ACTIVE,
    isEmailVerified: true,
  }));
  const guardUser1 = await users.save(users.create({
    email: `guard1@${TEST_PREFIX}.example`,
    passwordHash: 'not-used',
    role: UserRole.GUARD,
    status: UserStatus.ACTIVE,
    isEmailVerified: true,
  }));
  const guardUser2 = await users.save(users.create({
    email: `guard2@${TEST_PREFIX}.example`,
    passwordHash: 'not-used',
    role: UserRole.GUARD,
    status: UserStatus.ACTIVE,
    isEmailVerified: true,
  }));

  const companies = ds.getRepository(Company);
  const company = await companies.save(companies.create({
    user: companyUser,
    name: `${TEST_PREFIX}-Company`,
    companyNumber: `RT-001`,
    address: 'Test Address',
    contactDetails: 'test@rota-test.example',
    status: CompanyStatus.ACTIVE,
  }));

  const guards = ds.getRepository(GuardProfile);
  const guard1 = await guards.save(guards.create({
    user: guardUser1,
    fullName: 'Rota Test Guard One',
    siaLicenseNumber: 'RT00000000001',
    phone: '07000000001',
    status: GuardApprovalStatus.APPROVED,
    approvalStatus: GuardApprovalStatus.APPROVED,
    isApproved: true,
  }));
  const guard2 = await guards.save(guards.create({
    user: guardUser2,
    fullName: 'Rota Test Guard Two',
    siaLicenseNumber: 'RT00000000002',
    phone: '07000000002',
    status: GuardApprovalStatus.APPROVED,
    approvalStatus: GuardApprovalStatus.APPROVED,
    isApproved: true,
  }));

  const cg = ds.getRepository(CompanyGuard);
  await cg.save(cg.create({ company, guard: guard1, status: CompanyGuardStatus.ACTIVE }));
  await cg.save(cg.create({ company, guard: guard2, status: CompanyGuardStatus.ACTIVE }));

  const sites = ds.getRepository(Site);
  const site = await sites.save(sites.create({
    company,
    name: `${TEST_PREFIX}-Site`,
    address: 'Test Site Address',
    status: 'active',
    requiredGuardCount: 2,
    welfareCheckIntervalMinutes: 60,
  }));

  return { company, site, guard1, guard2 };
}

async function cleanupFixture(ds: DataSource) {
  await ds.query(`
    DELETE FROM shifts WHERE "companyId" IN (
      SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%'
    )
  `);
  await ds.query(`
    DELETE FROM rota_slots WHERE "companyId" IN (
      SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%'
    )
  `);
  await ds.query(`DELETE FROM company_guards WHERE "companyId" IN (
    SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%'
  )`);
  await ds.query(`DELETE FROM sites WHERE "companyId" IN (
    SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%'
  )`);
  await ds.query(`DELETE FROM companies WHERE name LIKE '${TEST_PREFIX}%'`);
  await ds.query(`DELETE FROM guard_profiles WHERE "userId" IN (
    SELECT id FROM users WHERE email LIKE '%@${TEST_PREFIX}.example'
  )`);
  await ds.query(`DELETE FROM users WHERE email LIKE '%@${TEST_PREFIX}.example'`);
}

function makeService(ds: DataSource, company: Company): RotaSlotService {
  return new RotaSlotService(
    ds.getRepository(RotaSlot),
    ds.getRepository(Shift),
    ds.getRepository(Site),
    ds.getRepository(GuardProfile),
    ds,
    membershipStub(company) as any,
    companyGuardStub,
    availabilityStub,
    auditStub,
  );
}

// ── Test cases ────────────────────────────────────────────────────────────────

async function testCreate(ds: DataSource, company: Company, siteId: number) {
  const svc = makeService(ds, company);
  const GUARDS = 3;
  const slot = await svc.createSlot(stubUser, {
    siteId,
    startAt: '2027-01-10T08:00:00Z',
    endAt: '2027-01-10T16:00:00Z',
    requiredGuardCount: GUARDS,
    title: 'Night Patrol',
  });

  equal(slot.requiredGuardCount, GUARDS, 'slot.requiredGuardCount');
  equal(slot.status, 'active', 'slot.status');
  equal(slot.companyId, company.id, 'slot.companyId');
  equal(slot.title, 'Night Patrol', 'slot.title');

  const shifts = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id } });
  equal(shifts.length, GUARDS, 'fan-out shift count');
  ok(shifts.every((s) => s.status === 'unfilled'), 'all shifts unfilled');
  ok(shifts.every((s) => s.rotaSlotId === slot.id), 'all shifts linked to slot');

  console.log('PASS CREATE-1: createSlot fans out N shifts');
}

async function testCreateRollback(ds: DataSource, company: Company, siteId: number) {
  const slotsBefore = await ds.getRepository(RotaSlot).count({ where: { companyId: company.id } });
  const [{ count: shiftsBefore }] = await ds.query(
    `SELECT COUNT(*)::int AS count FROM shifts WHERE "rotaSlotId" IN (SELECT id FROM rota_slots WHERE "companyId" = $1)`,
    [company.id],
  );

  // Create a service with an injected dataSource that fails on 2nd shift save
  let shiftSaveCount = 0;
  const faultDs = Object.create(ds) as DataSource;
  faultDs.transaction = async (work: any) => {
    return ds.transaction(async (manager) => {
      const originalShiftRepo = manager.getRepository(Shift);
      const proxiedSave = originalShiftRepo.save.bind(originalShiftRepo);
      const patchedRepo = Object.create(originalShiftRepo);
      patchedRepo.save = async (entity: any) => {
        shiftSaveCount++;
        if (shiftSaveCount === 2) throw new Error('injected fan-out failure');
        return proxiedSave(entity);
      };
      const originalGetRepo = manager.getRepository.bind(manager);
      manager.getRepository = (<T>(entity: any) => {
        const repo = originalGetRepo(entity);
        if (repo.metadata?.tableName === 'shifts') return patchedRepo as any;
        return repo;
      }) as typeof manager.getRepository;
      return work(manager);
    });
  };

  const svc = new RotaSlotService(
    ds.getRepository(RotaSlot),
    ds.getRepository(Shift),
    ds.getRepository(Site),
    ds.getRepository(GuardProfile),
    faultDs,
    membershipStub(company) as any,
    companyGuardStub,
    availabilityStub,
    auditStub,
  );

  await rejects(
    () => svc.createSlot(stubUser, {
      siteId,
      startAt: '2027-01-11T08:00:00Z',
      endAt: '2027-01-11T16:00:00Z',
      requiredGuardCount: 3,
    }),
    /injected fan-out failure/,
  );

  const slotsAfter = await ds.getRepository(RotaSlot).count({ where: { companyId: company.id } });
  const [{ count: shiftsAfter }] = await ds.query(
    `SELECT COUNT(*)::int AS count FROM shifts WHERE "rotaSlotId" IN (SELECT id FROM rota_slots WHERE "companyId" = $1)`,
    [company.id],
  );
  equal(slotsAfter, slotsBefore, 'slot rolled back on fan-out failure');
  equal(shiftsAfter, shiftsBefore, 'shifts rolled back on fan-out failure');

  console.log('PASS CREATE-ROLLBACK: fan-out failure rolls back slot and shifts atomically');
}

async function testChangeRequirementIncrease(ds: DataSource, company: Company, siteId: number) {
  const svc = makeService(ds, company);
  const slot = await svc.createSlot(stubUser, {
    siteId,
    startAt: '2027-01-12T08:00:00Z',
    endAt: '2027-01-12T16:00:00Z',
    requiredGuardCount: 2,
  });

  const result = await svc.changeRequirement(stubUser, slot.id, 4);
  equal(result.slot.requiredGuardCount, 4, 'slot.requiredGuardCount after increase');
  equal(result.addedShiftIds.length, 2, 'addedShiftIds count');
  equal(result.cancelledShiftIds.length, 0, 'no cancellations on increase');

  const totalShifts = await ds.getRepository(Shift).count({ where: { rotaSlotId: slot.id } });
  equal(totalShifts, 4, 'total shifts after increase');

  console.log('PASS REQ-INC: changeRequirement increase adds unfilled positions');
}

async function testChangeRequirementDecrease(ds: DataSource, company: Company, siteId: number) {
  const svc = makeService(ds, company);
  const slot = await svc.createSlot(stubUser, {
    siteId,
    startAt: '2027-01-13T08:00:00Z',
    endAt: '2027-01-13T16:00:00Z',
    requiredGuardCount: 4,
  });

  const result = await svc.changeRequirement(stubUser, slot.id, 2);
  equal(result.slot.requiredGuardCount, 2, 'slot.requiredGuardCount after decrease');
  equal(result.cancelledShiftIds.length, 2, 'exactly 2 positions cancelled');
  equal(result.addedShiftIds.length, 0, 'no additions on decrease');

  const allShifts = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id } });
  const cancelled = allShifts.filter((s) => s.status === 'cancelled');
  const unfilled = allShifts.filter((s) => s.status === 'unfilled');
  equal(cancelled.length, 2, 'two cancelled shifts');
  equal(unfilled.length, 2, 'two unfilled shifts remain');

  console.log('PASS REQ-DEC: changeRequirement decrease cancels surplus unfilled-first');
}

async function testChangeRequirementFloor(
  ds: DataSource,
  company: Company,
  siteId: number,
  guard1: GuardProfile,
) {
  const svc = makeService(ds, company);
  const slot = await svc.createSlot(stubUser, {
    siteId,
    startAt: '2027-01-14T08:00:00Z',
    endAt: '2027-01-14T16:00:00Z',
    requiredGuardCount: 3,
  });

  // Manually advance one shift to 'offered' (simulating assignment)
  const shifts = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id } });
  shifts[0].status = 'offered';
  shifts[0].guard = guard1;
  await ds.getRepository(Shift).save(shifts[0]);

  // Floor is 1. Reducing to 2 is fine (2 >= 1).
  const ok1 = await svc.changeRequirement(stubUser, slot.id, 2);
  equal(ok1.slot.requiredGuardCount, 2, 'reduce to 2 succeeds (above floor=1)');

  // Reducing to 0 is blocked at validation
  await rejects(
    () => svc.changeRequirement(stubUser, slot.id, 0),
    /at least 1/,
  );

  // Reducing below floor (1 < floor=1 means trying to reduce to 0 which is already blocked)
  // Try with a committed count of 2: advance second shift to offered
  const remainingShifts = await ds.getRepository(Shift).find({
    where: { rotaSlotId: slot.id, status: 'unfilled' },
  });
  if (remainingShifts.length > 0) {
    remainingShifts[0].status = 'offered';
    await ds.getRepository(Shift).save(remainingShifts[0]);
  }

  // Now floor=2. Reducing to 1 should be blocked
  await rejects(
    () => svc.changeRequirement(stubUser, slot.id, 1),
    /Cannot reduce below/,
  );

  console.log('PASS REQ-FLOOR: changeRequirement blocked below committed floor');
}

async function testChangeTime(ds: DataSource, company: Company, siteId: number) {
  const svc = makeService(ds, company);
  const slot = await svc.createSlot(stubUser, {
    siteId,
    startAt: '2027-01-15T08:00:00Z',
    endAt: '2027-01-15T16:00:00Z',
    requiredGuardCount: 2,
  });

  const updatedSlot = await svc.changeTime(stubUser, slot.id, {
    startAt: '2027-01-15T09:00:00Z',
    endAt: '2027-01-15T17:00:00Z',
  });

  equal(updatedSlot.startAt.toISOString(), '2027-01-15T09:00:00.000Z', 'slot startAt updated');
  equal(updatedSlot.endAt.toISOString(), '2027-01-15T17:00:00.000Z', 'slot endAt updated');

  const shifts = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id } });
  ok(
    shifts.every((s) => s.start.toISOString() === '2027-01-15T09:00:00.000Z'),
    'all child shifts start updated',
  );
  ok(
    shifts.every((s) => s.end.toISOString() === '2027-01-15T17:00:00.000Z'),
    'all child shifts end updated',
  );

  console.log('PASS CHANGE-TIME: changeTime propagates to all non-cancelled child shifts');
}

async function testChangeInterval(ds: DataSource, company: Company, siteId: number) {
  const svc = makeService(ds, company);
  const slot = await svc.createSlot(stubUser, {
    siteId,
    startAt: '2027-01-16T08:00:00Z',
    endAt: '2027-01-16T16:00:00Z',
    requiredGuardCount: 3,
    checkCallIntervalMinutes: 60,
  });

  // Cancel one shift manually (its interval should NOT be updated)
  const shifts = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id } });
  shifts[0].status = 'cancelled';
  await ds.getRepository(Shift).save(shifts[0]);
  const cancelledId = shifts[0].id;

  const updatedSlot = await svc.changeCheckCallInterval(stubUser, slot.id, 30);
  equal(updatedSlot.checkCallIntervalMinutes, 30, 'slot interval updated');

  const allShifts = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id } });
  const active = allShifts.filter((s) => s.id !== cancelledId);
  const cancelled = allShifts.find((s) => s.id === cancelledId);

  ok(
    active.every((s) => s.checkCallIntervalMinutes === 30),
    'active shifts interval updated to 30',
  );
  equal(cancelled!.checkCallIntervalMinutes, 60, 'cancelled shift interval unchanged');

  console.log('PASS CHANGE-INTERVAL: changeCheckCallInterval propagates to active children only');
}

async function testAssignConcurrency(
  ds: DataSource,
  company: Company,
  siteId: number,
  guard1: GuardProfile,
  guard2: GuardProfile,
) {
  const svc = makeService(ds, company);
  const slot = await svc.createSlot(stubUser, {
    siteId,
    startAt: '2027-01-17T08:00:00Z',
    endAt: '2027-01-17T16:00:00Z',
    requiredGuardCount: 1,
  });

  const [shift] = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id } });

  // Two concurrent assignment attempts targeting the same shift position
  const [r1, r2] = await Promise.allSettled([
    svc.assignPosition(stubUser, slot.id, { shiftId: shift.id, guardId: guard1.id }),
    svc.assignPosition(stubUser, slot.id, { shiftId: shift.id, guardId: guard2.id }),
  ]);

  const successes = [r1, r2].filter((r) => r.status === 'fulfilled');
  const failures = [r1, r2].filter((r) => r.status === 'rejected');

  equal(successes.length, 1, 'exactly one concurrent assignment succeeds');
  equal(failures.length, 1, 'exactly one concurrent assignment is rejected');

  const failureReason = (failures[0] as PromiseRejectedResult).reason;
  ok(
    failureReason?.message?.includes('already been filled') ||
      failureReason?.message?.includes('no longer available') ||
      failureReason?.status === 409,
    `rejected with conflict: ${failureReason?.message}`,
  );

  // Verify database state: exactly one guard assigned
  const finalShift = await ds.getRepository(Shift).findOneOrFail({ where: { id: shift.id } });
  equal(finalShift.status, 'offered', 'shift is offered after successful assignment');
  ok(finalShift.guard, 'shift has a guard assigned');
  ok(
    [guard1.id, guard2.id].includes(finalShift.guard!.id),
    'assigned guard is one of the two competitors',
  );

  console.log('PASS ASSIGN-CONCURRENCY: conditional UPDATE ensures exactly one concurrent winner');
}

async function testCancelPosition(
  ds: DataSource,
  company: Company,
  siteId: number,
  guard1: GuardProfile,
) {
  const svc = makeService(ds, company);
  const slot = await svc.createSlot(stubUser, {
    siteId,
    startAt: '2027-01-18T08:00:00Z',
    endAt: '2027-01-18T16:00:00Z',
    requiredGuardCount: 3,
  });

  const shifts = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id } });

  // Cancel an unfilled position
  const cancelled = await svc.cancelPosition(stubUser, slot.id, shifts[0].id);
  equal(cancelled.status, 'cancelled', 'unfilled → cancelled');

  // Idempotent: cancel again
  const idempotent = await svc.cancelPosition(stubUser, slot.id, shifts[0].id);
  equal(idempotent.status, 'cancelled', 'cancel idempotent');

  // Block: manually set one to in_progress and try to cancel
  shifts[1].status = 'in_progress';
  shifts[1].guard = guard1;
  await ds.getRepository(Shift).save(shifts[1]);

  await rejects(
    () => svc.cancelPosition(stubUser, slot.id, shifts[1].id),
    /Cannot cancel a position with status 'in_progress'/,
  );

  console.log('PASS CANCEL-POS: cancelPosition blocks in_progress, accepts unfilled');
}

async function testCancelSlot(
  ds: DataSource,
  company: Company,
  siteId: number,
  guard1: GuardProfile,
) {
  const svc = makeService(ds, company);
  const slot = await svc.createSlot(stubUser, {
    siteId,
    startAt: '2027-01-19T08:00:00Z',
    endAt: '2027-01-19T16:00:00Z',
    requiredGuardCount: 4,
  });

  const shifts = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id } });

  // Mark one as completed and one as missed (historical records)
  shifts[0].status = 'completed';
  shifts[0].guard = guard1;
  shifts[1].status = 'missed';
  await ds.getRepository(Shift).save([shifts[0], shifts[1]]);

  const cancelledSlot = await svc.cancelSlot(stubUser, slot.id);
  equal(cancelledSlot.status, 'cancelled', 'slot status is cancelled');

  // Verify: completed and missed preserved, unfilled cancelled
  const finalShifts = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id } });
  const byId = Object.fromEntries(finalShifts.map((s) => [s.id, s]));

  equal(byId[shifts[0].id].status, 'completed', 'completed shift preserved');
  equal(byId[shifts[1].id].status, 'missed', 'missed shift preserved');
  equal(byId[shifts[2].id].status, 'cancelled', 'unfilled[2] cancelled');
  equal(byId[shifts[3].id].status, 'cancelled', 'unfilled[3] cancelled');

  // Idempotent: cancel again
  const idempotent = await svc.cancelSlot(stubUser, slot.id);
  equal(idempotent.status, 'cancelled', 'cancelSlot idempotent');

  // Block: test in_progress prevents slot cancellation
  const slot2 = await svc.createSlot(stubUser, {
    siteId,
    startAt: '2027-01-20T08:00:00Z',
    endAt: '2027-01-20T16:00:00Z',
    requiredGuardCount: 1,
  });
  const [liveShift] = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot2.id } });
  liveShift.status = 'in_progress';
  liveShift.guard = guard1;
  await ds.getRepository(Shift).save(liveShift);

  await rejects(
    () => svc.cancelSlot(stubUser, slot2.id),
    /while guards are on shift/,
  );

  console.log('PASS CANCEL-SLOT: cancelSlot cancels active, preserves completed/missed, blocks in_progress');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const dataSource = new DataSource(
    buildTypeOrmOptions({
      DATABASE_URL: dbUrl,
      DATABASE_SSL: 'false',
      DATABASE_SYNCHRONIZE: 'false',
      NODE_ENV: 'test',
    }),
  );
  await dataSource.initialize();

  try {
    await dataSource.runMigrations({ transaction: 'each' });

    // Seed fixture once; clean up between tests via cleanupFixture
    await cleanupFixture(dataSource);
    const { company, site, guard1, guard2 } = await seedFixture(dataSource);

    const cleanup = async () => {
      // Remove only rota_slots and shifts between tests; keep company/guards
      await dataSource.query(
        `DELETE FROM shifts WHERE "companyId" = $1`, [company.id],
      );
      await dataSource.query(
        `DELETE FROM rota_slots WHERE "companyId" = $1`, [company.id],
      );
    };

    await testCreate(dataSource, company, site.id);
    await cleanup();

    await testCreateRollback(dataSource, company, site.id);
    await cleanup();

    await testChangeRequirementIncrease(dataSource, company, site.id);
    await cleanup();

    await testChangeRequirementDecrease(dataSource, company, site.id);
    await cleanup();

    await testChangeRequirementFloor(dataSource, company, site.id, guard1);
    await cleanup();

    await testChangeTime(dataSource, company, site.id);
    await cleanup();

    await testChangeInterval(dataSource, company, site.id);
    await cleanup();

    await testAssignConcurrency(dataSource, company, site.id, guard1, guard2);
    await cleanup();

    await testCancelPosition(dataSource, company, site.id, guard1);
    await cleanup();

    await testCancelSlot(dataSource, company, site.id, guard1);
    await cleanup();

    console.log(JSON.stringify({
      event: 'rota_slot_service_postgres_certified',
      tests: 10,
      phase: 'R4B2',
    }));
  } finally {
    await cleanupFixture(dataSource).catch(() => undefined);
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
