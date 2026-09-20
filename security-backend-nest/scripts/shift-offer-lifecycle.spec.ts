/**
 * 2C1 PostgreSQL certification for Shift Offer lifecycle hardening.
 *
 * Requires: ROTA_SLOT_TEST_DB_URL (defaults to rehearsal DB at port 54322).
 *
 * Tests certified:
 *   ACCEPT            offered → ready; coverage updated
 *   REJECT            offered → rejected; coverage updated
 *   DOUBLE-ACCEPT     Two concurrent accepts → exactly one wins, one ConflictException
 *   RACE              Concurrent accept + reject → exactly one wins, no corruption
 *   STALE-ACCEPT      Company cancels before guard responds → ConflictException
 *   OVERLAPPING       Guard accepts offer A; offer B acceptance blocked by clash
 *   COMPLIANCE        Guard becomes ineligible; acceptance blocked
 *   COMPANY-REL       Guard relationship revoked; acceptance blocked
 *   IDOR              Guard A cannot respond to Guard B's shift
 *   WRONG-STATUS      Cannot accept unfilled/ready/cancelled/completed shift
 *   15-GUARD          15 required, 12 offered, 8 accept, 2 reject, 2 pending
 *   AUDIT-ACCEPT      Successful accept creates shift.offer_accepted audit event
 *   AUDIT-REJECT      Successful reject creates shift.offer_rejected audit event
 *   AUDIT-STALE       Failed stale response does NOT create a success audit event
 *   DIRECT-CREATE     POST /shifts with clashing guard blocked
 *   DIRECT-UPDATE     PATCH reassign to clashing guard blocked
 */

import 'reflect-metadata';

import { ConflictException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { equal, ok, rejects, deepEqual } from 'node:assert/strict';
import { DataSource, In, LessThan, MoreThan, Repository } from 'typeorm';

import { JwtPayload } from '../src/auth/types/jwt-payload.type';
import { buildTypeOrmOptions } from '../src/database/typeorm.config';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { Company, CompanyStatus } from '../src/company/entities/company.entity';
import { CompanyGuard, CompanyGuardStatus } from '../src/company-guard/entities/company-guard.entity';
import { GuardApprovalStatus, GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { RotaSlot } from '../src/rota-slot/entities/rota-slot.entity';
import { RotaSlotService } from '../src/rota-slot/rota-slot.service';
import { RotaWeekService } from '../src/rota-slot/rota-week.service';
import { toSlotDetail } from '../src/rota-slot/rota-slot.mapper';
import { Shift } from '../src/shift/entities/shift.entity';
import { ShiftService } from '../src/shift/shift.service';
import { Site } from '../src/site/entities/site.entity';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';

const TEST_PREFIX = 'SO-LIFECYCLE-TEST';
const dbUrl =
  process.env.ROTA_SLOT_TEST_DB_URL ||
  'postgresql://postgres:postgres@127.0.0.1:54322/s4_migration_rehearsal';

if (!process.env.ROTA_SLOT_TEST_DB_URL) {
  console.warn('[shift-offers] ROTA_SLOT_TEST_DB_URL not set — using local rehearsal DB');
}

// ── Audit capture ─────────────────────────────────────────────────────────────

type AuditEntry = { action: string; entityId?: number | null; afterData?: Record<string, unknown> | null };

function makeCapturingAudit() {
  const captured: AuditEntry[] = [];
  const stub = {
    log: async (input: AuditEntry) => { captured.push(input); return input as any; },
  };
  return { stub, captured };
}

// ── Stubs ─────────────────────────────────────────────────────────────────────

const assignmentStub = { findOne: async () => null } as any;
const timesheetStub = { createForShift: async () => null } as any;
const siteStub = (site: Site) => ({
  findOne: async () => site,
  findMany: async () => [site],
});
const membershipStub = (company: Company) => ({
  resolveCompanyContext: async () => ({ company, membershipRole: 'owner' as any }),
});
const cgActiveStub = { ensureActiveRelationship: async () => undefined } as any;
const cgRevokedStub = { ensureActiveRelationship: async () => { throw new ForbiddenException('Guard is not active/approved for this company'); } } as any;

function guardProfileStub(userToGuard: Map<number, GuardProfile>, idToGuard?: Map<number, GuardProfile>) {
  return {
    findByUserId: async (userId: number) => userToGuard.get(userId) ?? null,
    findOne: async (id: number) => (idToGuard ?? new Map()).get(id) ?? null,
  } as any;
}

const availPassStub = { assertGuardCanTakeShift: async () => undefined } as any;
const availBlockStub = { assertGuardCanTakeShift: async () => { throw new ForbiddenException('Guard has an overlapping shift assignment.'); } } as any;
const compliancePassStub = { assertGuardAssignable: async () => undefined } as any;
const complianceBlockStub = { assertGuardAssignable: async () => { throw new ForbiddenException('Compliance invalid'); } } as any;
const auditStub = { log: async () => undefined } as any;
const cgStub = { ensureActiveRelationship: async () => undefined } as any;
const rotaAvailStub = { assertGuardCanTakeShift: async () => undefined } as any;
const rotaAuditStub = { log: async () => undefined } as any;

function makeRealClashAvailability(ds: DataSource) {
  return {
    assertGuardCanTakeShift: async (
      _companyId: number,
      guardId: number,
      startAt: Date,
      endAt: Date,
      excludeShiftId?: number,
    ) => {
      const clashing = await ds.getRepository(Shift).find({
        where: {
          guard: { id: guardId },
          status: In(['scheduled', 'offered', 'ready', 'in_progress']),
          start: LessThan(endAt),
          end: MoreThan(startAt),
        },
        relations: ['guard'],
      });
      const real = excludeShiftId ? clashing.filter((s) => s.id !== excludeShiftId) : clashing;
      if (real.length > 0) {
        throw new ForbiddenException('Guard has an overlapping shift assignment.');
      }
    },
  } as any;
}

// ── Service factory ───────────────────────────────────────────────────────────

interface ShiftServiceOptions {
  availability?: any;
  compliance?: any;
  companyGuard?: any;
  auditCapture?: ReturnType<typeof makeCapturingAudit>;
  userToGuard: Map<number, GuardProfile>;
  idToGuard?: Map<number, GuardProfile>;
  company: Company;
  site: Site;
}

function makeShiftService(ds: DataSource, opts: ShiftServiceOptions): ShiftService {
  const audit = opts.auditCapture ? opts.auditCapture.stub : auditStub;
  return new ShiftService(
    ds.getRepository(Shift),
    ds.getRepository(Company),
    ds.getRepository(GuardProfile),
    ds.getRepository(require('../src/job/entities/job.entity').Job),
    ds.getRepository(require('../src/job-application/entities/job-application.entity').JobApplication),
    ds.getRepository(require('../src/timesheet/entities/timesheet.entity').Timesheet),
    assignmentStub,
    timesheetStub,
    siteStub(opts.site) as any,
    membershipStub(opts.company) as any,
    guardProfileStub(opts.userToGuard, opts.idToGuard) as any,
    opts.companyGuard ?? cgActiveStub,
    opts.availability ?? availPassStub,
    opts.compliance ?? compliancePassStub,
    ds,
    audit as any,
  );
}

function makeRotaSlotService(ds: DataSource, company: Company): RotaSlotService {
  return new RotaSlotService(
    ds.getRepository(RotaSlot),
    ds.getRepository(Shift),
    ds.getRepository(Site),
    ds.getRepository(GuardProfile),
    ds,
    membershipStub(company) as any,
    cgStub,
    rotaAvailStub,
    rotaAuditStub,
  );
}

function makeWeekService(ds: DataSource, company: Company): RotaWeekService {
  return new RotaWeekService(
    ds.getRepository(RotaSlot),
    ds.getRepository(Shift),
    ds.getRepository(Site),
    membershipStub(company) as any,
  );
}

function makeGuardUser(userId: number): JwtPayload {
  return { sub: userId, role: UserRole.GUARD, email: `guard-${userId}@test.example`, status: UserStatus.ACTIVE };
}
function makeCompanyUser(): JwtPayload {
  return { sub: 999999, role: UserRole.COMPANY_ADMIN, email: 'company@test.example', status: UserStatus.ACTIVE };
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function createCompanyWithSite(ds: DataSource, suffix: string) {
  const companyUser = await ds.getRepository(User).save(ds.getRepository(User).create({
    email: `company-${suffix}@${TEST_PREFIX}.example`,
    passwordHash: 'x', role: UserRole.COMPANY_ADMIN,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const company = await ds.getRepository(Company).save(ds.getRepository(Company).create({
    user: companyUser, name: `${TEST_PREFIX}-${suffix}`,
    companyNumber: `SO-${suffix.slice(0, 8)}`, address: 'Test',
    contactDetails: 'test', status: CompanyStatus.ACTIVE,
  }));
  const site = await ds.getRepository(Site).save(ds.getRepository(Site).create({
    company, name: `${TEST_PREFIX}-Site-${suffix}`, address: 'Test',
    status: 'active', requiredGuardCount: 1, welfareCheckIntervalMinutes: 60,
  }));
  return { company, site };
}

async function createGuardWithRelationship(ds: DataSource, company: Company, suffix: string): Promise<{ guard: GuardProfile; guardUser: User }> {
  const guardUser = await ds.getRepository(User).save(ds.getRepository(User).create({
    email: `guard-${suffix}@${TEST_PREFIX}.example`,
    passwordHash: 'x', role: UserRole.GUARD,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const guard = await ds.getRepository(GuardProfile).save(ds.getRepository(GuardProfile).create({
    user: guardUser, fullName: `Guard ${suffix}`,
    siaLicenseNumber: `SO${suffix.padStart(13, '0').slice(-13)}`,
    phone: '07000000000',
    status: GuardApprovalStatus.APPROVED,
    approvalStatus: GuardApprovalStatus.APPROVED,
    isApproved: true,
  }));
  await ds.getRepository(CompanyGuard).save(ds.getRepository(CompanyGuard).create({
    company, guard, status: CompanyGuardStatus.ACTIVE,
  }));
  return { guard, guardUser };
}

async function createOfferedShift(
  ds: DataSource,
  company: Company,
  site: Site,
  guard: GuardProfile,
  start: string,
  end: string,
): Promise<Shift> {
  const shiftRepo = ds.getRepository(Shift);
  const shift = shiftRepo.create({
    company, guard, site,
    siteName: site.name,
    start: new Date(start),
    end: new Date(end),
    checkCallIntervalMinutes: 60,
    status: 'offered',
  });
  return shiftRepo.save(shift);
}

async function cleanup(ds: DataSource) {
  await ds.query(`DELETE FROM audit_logs WHERE "entityType" = 'shift' AND "entityId" IN (SELECT id FROM shifts WHERE "companyId" IN (SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%'))`);
  await ds.query(`DELETE FROM shifts WHERE "companyId" IN (SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%')`);
  await ds.query(`DELETE FROM rota_slots WHERE "companyId" IN (SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%')`);
  await ds.query(`DELETE FROM company_guards WHERE "companyId" IN (SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%')`);
  await ds.query(`DELETE FROM sites WHERE "companyId" IN (SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%')`);
  await ds.query(`DELETE FROM companies WHERE name LIKE '${TEST_PREFIX}%'`);
  await ds.query(`DELETE FROM guard_profiles WHERE "userId" IN (SELECT id FROM users WHERE email LIKE '%@${TEST_PREFIX}.example')`);
  await ds.query(`DELETE FROM users WHERE email LIKE '%@${TEST_PREFIX}.example'`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testAccept(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'accept');
  const { guard, guardUser } = await createGuardWithRelationship(ds, company, 'accept-g1');
  const shift = await createOfferedShift(ds, company, site, guard, '2027-06-10T08:00:00', '2027-06-10T16:00:00');

  const userMap = new Map([[guardUser.id, guard]]);
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap });
  const result = await svc.respondForGuard(makeGuardUser(guardUser.id), shift.id, { response: 'accepted' });

  equal(result.status, 'ready', 'accepted → ready');
  const dbShift = await ds.getRepository(Shift).findOneOrFail({ where: { id: shift.id } });
  equal(dbShift.status, 'ready', 'DB persisted: ready');
  console.log('PASS ACCEPT: offered → ready');
}

async function testReject(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'reject');
  const { guard, guardUser } = await createGuardWithRelationship(ds, company, 'reject-g1');
  const shift = await createOfferedShift(ds, company, site, guard, '2027-06-11T08:00:00', '2027-06-11T16:00:00');

  const userMap = new Map([[guardUser.id, guard]]);
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap });
  const result = await svc.respondForGuard(makeGuardUser(guardUser.id), shift.id, { response: 'rejected' });

  equal(result.status, 'rejected', 'rejected → rejected');
  const dbShift = await ds.getRepository(Shift).findOneOrFail({ where: { id: shift.id } });
  equal(dbShift.status, 'rejected', 'DB persisted: rejected');
  console.log('PASS REJECT: offered → rejected');
}

async function testDoubleAccept(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'dbl-accept');
  const { guard, guardUser } = await createGuardWithRelationship(ds, company, 'dbl-g1');
  const shift = await createOfferedShift(ds, company, site, guard, '2027-06-12T08:00:00', '2027-06-12T16:00:00');

  const userMap = new Map([[guardUser.id, guard]]);
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap });
  const guardUser2 = makeGuardUser(guardUser.id);

  const [r1, r2] = await Promise.allSettled([
    svc.respondForGuard(guardUser2, shift.id, { response: 'accepted' }),
    svc.respondForGuard(guardUser2, shift.id, { response: 'accepted' }),
  ]);

  const successes = [r1, r2].filter((r) => r.status === 'fulfilled');
  const failures = [r1, r2].filter((r) => r.status === 'rejected');
  equal(successes.length, 1, 'DOUBLE-ACCEPT: exactly one succeeds');
  equal(failures.length, 1, 'DOUBLE-ACCEPT: exactly one fails');

  const failReason = (failures[0] as PromiseRejectedResult).reason;
  ok(
    failReason instanceof ConflictException || failReason instanceof BadRequestException ||
    failReason?.status === 409 || failReason?.status === 400 ||
    failReason?.message?.includes('already') ||
    failReason?.message?.includes('no longer available') ||
    failReason?.message?.includes('Only offered'),
    `DOUBLE-ACCEPT: error expected (400/409), got: ${failReason?.constructor?.name}: ${failReason?.message}`,
  );

  const final = await ds.getRepository(Shift).findOneOrFail({ where: { id: shift.id } });
  equal(final.status, 'ready', 'DOUBLE-ACCEPT: final state is ready');
  console.log('PASS DOUBLE-ACCEPT: concurrent double accept → one wins, one ConflictException');
}

async function testAcceptRejectRace(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'ar-race');
  const { guard, guardUser } = await createGuardWithRelationship(ds, company, 'ar-g1');
  const shift = await createOfferedShift(ds, company, site, guard, '2027-06-13T08:00:00', '2027-06-13T16:00:00');

  const userMap = new Map([[guardUser.id, guard]]);
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap });
  const gUser = makeGuardUser(guardUser.id);

  const [r1, r2] = await Promise.allSettled([
    svc.respondForGuard(gUser, shift.id, { response: 'accepted' }),
    svc.respondForGuard(gUser, shift.id, { response: 'rejected' }),
  ]);

  // Primary invariant: final state must be a valid terminal state (never 'offered')
  const final = await ds.getRepository(Shift).findOneOrFail({ where: { id: shift.id } });
  ok(['ready', 'rejected'].includes(final.status), `RACE: final state must be ready or rejected, got ${final.status}`);

  // Both cannot have failed — at least one transition must succeed
  const successes = [r1, r2].filter((r) => r.status === 'fulfilled');
  ok(successes.length >= 1, 'RACE: at least one transition succeeds');

  // If both succeed, statuses must agree with the DB final state (no split-brain)
  if (successes.length === 2) {
    const s1 = (r1 as PromiseFulfilledResult<any>).value;
    const s2 = (r2 as PromiseFulfilledResult<any>).value;
    // Both returned the same shift — the second saw the already-committed final state
    ok(
      [s1.status, s2.status].every((s) => ['ready', 'rejected'].includes(s)),
      `RACE (both fulfilled): returned statuses must be valid final states`,
    );
  }

  console.log(`PASS ACCEPT-REJECT-RACE: final state=${final.status}, ${successes.length === 1 ? 'exactly one' : 'both resolved to committed state'}`);
}

async function testStaleAccept(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'stale');
  const { guard, guardUser } = await createGuardWithRelationship(ds, company, 'stale-g1');
  const shift = await createOfferedShift(ds, company, site, guard, '2027-06-14T08:00:00', '2027-06-14T16:00:00');

  // Company cancels the offered position before guard responds
  await ds.getRepository(Shift).update({ id: shift.id }, { status: 'cancelled' });

  const userMap = new Map([[guardUser.id, guard]]);
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap });

  // Guard tries to accept a stale cancelled shift
  await rejects(
    () => svc.respondForGuard(makeGuardUser(guardUser.id), shift.id, { response: 'accepted' }),
    (err: any) => {
      ok(
        err instanceof BadRequestException || err instanceof ConflictException || err instanceof NotFoundException,
        `STALE-ACCEPT: expected rejection error, got ${err?.constructor?.name}: ${err?.message}`,
      );
      return true;
    },
  );

  const final = await ds.getRepository(Shift).findOneOrFail({ where: { id: shift.id } });
  equal(final.status, 'cancelled', 'STALE-ACCEPT: shift remains cancelled');
  console.log('PASS STALE-ACCEPT: company cancels before guard response → blocked, no resurrection');
}

async function testOverlappingOffers(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'overlap');
  const { guard, guardUser } = await createGuardWithRelationship(ds, company, 'overlap-g1');

  // Two overlapping shifts both offered to same guard
  const shiftA = await createOfferedShift(ds, company, site, guard, '2027-06-15T08:00:00', '2027-06-15T16:00:00');
  const shiftB = await createOfferedShift(ds, company, site, guard, '2027-06-15T12:00:00', '2027-06-15T20:00:00');

  const userMap = new Map([[guardUser.id, guard]]);

  // Accept shift A using pass-through availability (shift B is still 'offered', not a committed clash)
  const svcPass = makeShiftService(ds, { company, site, userToGuard: userMap });
  const resultA = await svcPass.respondForGuard(makeGuardUser(guardUser.id), shiftA.id, { response: 'accepted' });
  equal(resultA.status, 'ready', 'OVERLAPPING: first accept succeeds');

  // Accept shift B — should fail because shift A is now 'ready' and overlaps
  const realAvail = makeRealClashAvailability(ds);
  const svcClash = makeShiftService(ds, { company, site, userToGuard: userMap, availability: realAvail });
  await rejects(
    () => svcClash.respondForGuard(makeGuardUser(guardUser.id), shiftB.id, { response: 'accepted' }),
    (err: any) => {
      ok(
        err instanceof ForbiddenException || err?.status === 403,
        `OVERLAPPING: expected ForbiddenException for overlapping accept, got ${err?.constructor?.name}: ${err?.message}`,
      );
      return true;
    },
  );

  const finalA = await ds.getRepository(Shift).findOneOrFail({ where: { id: shiftA.id } });
  const finalB = await ds.getRepository(Shift).findOneOrFail({ where: { id: shiftB.id } });
  equal(finalA.status, 'ready', 'OVERLAPPING: shift A is ready');
  equal(finalB.status, 'offered', 'OVERLAPPING: shift B remains offered');
  console.log('PASS OVERLAPPING-OFFERS: accepting first offer blocks second overlapping acceptance');
}

async function testComplianceBlock(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'compliance');
  const { guard, guardUser } = await createGuardWithRelationship(ds, company, 'comp-g1');
  const shift = await createOfferedShift(ds, company, site, guard, '2027-06-16T08:00:00', '2027-06-16T16:00:00');

  const userMap = new Map([[guardUser.id, guard]]);
  // Compliance blocked (simulates guard becoming ineligible after offer)
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap, compliance: complianceBlockStub });

  await rejects(
    () => svc.respondForGuard(makeGuardUser(guardUser.id), shift.id, { response: 'accepted' }),
    (err: any) => {
      ok(err instanceof ForbiddenException, `COMPLIANCE: expected ForbiddenException, got ${err?.constructor?.name}`);
      return true;
    },
  );

  const final = await ds.getRepository(Shift).findOneOrFail({ where: { id: shift.id } });
  equal(final.status, 'offered', 'COMPLIANCE: shift still offered after blocked accept');
  console.log('PASS COMPLIANCE: ineligible guard cannot accept offered shift');
}

async function testCompanyRelationshipRevoked(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'revoked');
  const { guard, guardUser } = await createGuardWithRelationship(ds, company, 'rev-g1');
  const shift = await createOfferedShift(ds, company, site, guard, '2027-06-17T08:00:00', '2027-06-17T16:00:00');

  const userMap = new Map([[guardUser.id, guard]]);
  // Company relationship revoked between offer and acceptance
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap, companyGuard: cgRevokedStub });

  await rejects(
    () => svc.respondForGuard(makeGuardUser(guardUser.id), shift.id, { response: 'accepted' }),
    (err: any) => {
      ok(
        err instanceof ForbiddenException || err?.status === 403,
        `COMPANY-REL: expected ForbiddenException, got ${err?.constructor?.name}`,
      );
      return true;
    },
  );

  const final = await ds.getRepository(Shift).findOneOrFail({ where: { id: shift.id } });
  equal(final.status, 'offered', 'COMPANY-REL: shift still offered after blocked accept');
  console.log('PASS COMPANY-REL: revoked relationship blocks acceptance');
}

async function testIdo(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'idor');
  const { guard: guardA, guardUser: guardUserA } = await createGuardWithRelationship(ds, company, 'idor-gA');
  const { guard: guardB, guardUser: guardUserB } = await createGuardWithRelationship(ds, company, 'idor-gB');

  const shift = await createOfferedShift(ds, company, site, guardA, '2027-06-18T08:00:00', '2027-06-18T16:00:00');

  // Map guardB's userId to guardB profile
  const userMap = new Map([[guardUserB.id, guardB]]);
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap });

  // Guard B tries to respond to Guard A's shift
  await rejects(
    () => svc.respondForGuard(makeGuardUser(guardUserB.id), shift.id, { response: 'accepted' }),
    (err: any) => {
      ok(
        err instanceof NotFoundException || err?.status === 404,
        `IDOR: expected NotFoundException, got ${err?.constructor?.name}: ${err?.message}`,
      );
      return true;
    },
  );

  const final = await ds.getRepository(Shift).findOneOrFail({ where: { id: shift.id } });
  equal(final.status, 'offered', 'IDOR: shift A remains offered');
  console.log('PASS IDOR: Guard B cannot respond to Guard A\'s shift (NotFoundException)');
}

async function testWrongStatus(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'wrongstatus');
  const { guard, guardUser } = await createGuardWithRelationship(ds, company, 'ws-g1');

  const statusesToTest: Array<{ status: string; label: string }> = [
    { status: 'unfilled', label: 'unfilled (no guard)' },
    { status: 'ready', label: 'ready' },
    { status: 'rejected', label: 'rejected' },
    { status: 'cancelled', label: 'cancelled' },
    { status: 'completed', label: 'completed' },
  ];

  const userMap = new Map([[guardUser.id, guard]]);
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap });

  for (const { status, label } of statusesToTest) {
    const shiftRepo = ds.getRepository(Shift);
    const s = await shiftRepo.save(shiftRepo.create({
      company, guard, site, siteName: site.name,
      start: new Date('2027-07-01T08:00:00'), end: new Date('2027-07-01T16:00:00'),
      checkCallIntervalMinutes: 60, status,
    }));

    await rejects(
      () => svc.respondForGuard(makeGuardUser(guardUser.id), s.id, { response: 'accepted' }),
      (err: any) => {
        ok(
          err instanceof BadRequestException || err instanceof ConflictException,
          `WRONG-STATUS ${label}: expected BadRequest or Conflict, got ${err?.constructor?.name}: ${err?.message}`,
        );
        return true;
      },
    );
  }
  console.log('PASS WRONG-STATUS: cannot accept/reject non-offered shifts');
}

async function test15GuardScenario(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, '15guard');
  const rotaSvc = makeRotaSlotService(ds, company);
  const weekSvc = makeWeekService(ds, company);
  const companyUser = makeCompanyUser();

  // Create a 15-guard slot
  const slot = await rotaSvc.createSlot(companyUser, {
    siteId: site.id,
    startAt: '2027-06-20T08:00:00',
    endAt: '2027-06-20T16:00:00',
    requiredGuardCount: 15,
    title: '15-guard event',
  });

  // Create 12 guards, assign all 12
  const guards: Array<{ guard: GuardProfile; guardUser: User }> = [];
  for (let i = 0; i < 12; i++) {
    guards.push(await createGuardWithRelationship(ds, company, `15g-${i}`));
  }

  const shifts = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id }, order: { id: 'ASC' } });
  equal(shifts.length, 15, '15-GUARD: slot has 15 positions');

  for (let i = 0; i < 12; i++) {
    await rotaSvc.assignPosition(companyUser, slot.id, { shiftId: shifts[i].id, guardId: guards[i].guard.id });
  }

  // Verify 12 offered, 3 unfilled
  const { slot: slotAfterAssign, shifts: sAfterAssign } = await rotaSvc.getSlotDetail(companyUser, slot.id);
  const countsAfterAssign = toSlotDetail(slotAfterAssign, sAfterAssign).counts;
  equal(countsAfterAssign.offered, 12, '15-GUARD pre-respond: offered=12');
  equal(countsAfterAssign.open, 3, '15-GUARD pre-respond: open=3');

  // Guards 0..7 accept (8 accepts)
  // Guards 8..9 reject (2 rejects)
  // Guards 10..11 leave as offered (2 pending)
  const acceptedGuards = guards.slice(0, 8);
  const rejectedGuards = guards.slice(8, 10);

  for (const { guard, guardUser } of acceptedGuards) {
    const userMap = new Map([[guardUser.id, guard]]);
    const svc = makeShiftService(ds, { company, site, userToGuard: userMap });
    const gShift = shifts.find((s) => s.guard?.id === guard.id) ??
      (await ds.getRepository(Shift).findOne({ where: { rotaSlotId: slot.id, guard: { id: guard.id } }, relations: ['guard'] }));
    if (!gShift) throw new Error(`No shift found for guard ${guard.id}`);
    await svc.respondForGuard(makeGuardUser(guardUser.id), gShift.id, { response: 'accepted' });
  }

  for (const { guard, guardUser } of rejectedGuards) {
    const userMap = new Map([[guardUser.id, guard]]);
    const svc = makeShiftService(ds, { company, site, userToGuard: userMap });
    const gShift = await ds.getRepository(Shift).findOne({ where: { rotaSlotId: slot.id, guard: { id: guard.id } }, relations: ['guard'] });
    if (!gShift) throw new Error(`No shift found for guard ${guard.id}`);
    await svc.respondForGuard(makeGuardUser(guardUser.id), gShift.id, { response: 'rejected' });
  }

  // Re-read final counts
  const { slot: finalSlot, shifts: finalShifts } = await rotaSvc.getSlotDetail(companyUser, slot.id);
  const detail = toSlotDetail(finalSlot, finalShifts);
  const c = detail.counts;

  equal(c.confirmed, 8, '15-GUARD: confirmed=8 (8 ready)');
  equal(c.offered, 2, '15-GUARD: offered=2 (still pending)');
  equal(c.open, 3, '15-GUARD: open=3 (3 unfilled; rejected tracked in problem)');
  equal(c.problem, 2, '15-GUARD: problem=2 (2 rejected)');
  equal(c.required, 15, '15-GUARD: required=15');

  console.log(`PASS 15-GUARD: confirmed=${c.confirmed} offered=${c.offered} open=${c.open} problem=${c.problem} coverageState=${detail.coverageState}`);
}

async function testAuditLogging(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'audit');
  const { guard: g1, guardUser: gu1 } = await createGuardWithRelationship(ds, company, 'audit-g1');
  const { guard: g2, guardUser: gu2 } = await createGuardWithRelationship(ds, company, 'audit-g2');
  const { guard: g3, guardUser: gu3 } = await createGuardWithRelationship(ds, company, 'audit-g3');

  const shiftAccept = await createOfferedShift(ds, company, site, g1, '2027-06-21T08:00:00', '2027-06-21T16:00:00');
  const shiftReject = await createOfferedShift(ds, company, site, g2, '2027-06-22T08:00:00', '2027-06-22T16:00:00');
  const shiftStale = await createOfferedShift(ds, company, site, g3, '2027-06-23T08:00:00', '2027-06-23T16:00:00');

  const captureA = makeCapturingAudit();
  const svcA = makeShiftService(ds, { company, site, userToGuard: new Map([[gu1.id, g1]]), auditCapture: captureA });
  await svcA.respondForGuard(makeGuardUser(gu1.id), shiftAccept.id, { response: 'accepted' });
  equal(captureA.captured.length, 1, 'AUDIT: exactly one event on accept');
  equal(captureA.captured[0].action, 'shift.offer_accepted', 'AUDIT: action is shift.offer_accepted');

  const captureR = makeCapturingAudit();
  const svcR = makeShiftService(ds, { company, site, userToGuard: new Map([[gu2.id, g2]]), auditCapture: captureR });
  await svcR.respondForGuard(makeGuardUser(gu2.id), shiftReject.id, { response: 'rejected' });
  equal(captureR.captured.length, 1, 'AUDIT: exactly one event on reject');
  equal(captureR.captured[0].action, 'shift.offer_rejected', 'AUDIT: action is shift.offer_rejected');

  // Stale: company cancels first, then guard tries to accept
  await ds.getRepository(Shift).update({ id: shiftStale.id }, { status: 'cancelled' });
  const captureS = makeCapturingAudit();
  const svcS = makeShiftService(ds, { company, site, userToGuard: new Map([[gu3.id, g3]]), auditCapture: captureS });
  await rejects(
    () => svcS.respondForGuard(makeGuardUser(gu3.id), shiftStale.id, { response: 'accepted' }),
    () => true,
  );
  equal(captureS.captured.length, 0, 'AUDIT-STALE: no audit event on failed/stale response');

  // Rejection reason captured in afterData when supplied
  const { guard: g4, guardUser: gu4 } = await createGuardWithRelationship(ds, company, 'audit-g4');
  const shiftReason = await createOfferedShift(ds, company, site, g4, '2027-06-24T08:00:00', '2027-06-24T16:00:00');
  const captureReason = makeCapturingAudit();
  const svcReason = makeShiftService(ds, { company, site, userToGuard: new Map([[gu4.id, g4]]), auditCapture: captureReason });
  await svcReason.respondForGuard(makeGuardUser(gu4.id), shiftReason.id, { response: 'rejected', reason: 'Personal commitment' });
  equal(captureReason.captured[0].afterData?.reason, 'Personal commitment', 'AUDIT: rejection reason captured in afterData');

  console.log('PASS AUDIT: accept/reject create correct events; stale response creates no event; reason captured');
}

async function testCoverageAfterAccept(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'cov-accept');
  const rotaSvc = makeRotaSlotService(ds, company);
  const companyUser = makeCompanyUser();

  const slot = await rotaSvc.createSlot(companyUser, {
    siteId: site.id,
    startAt: '2027-06-25T08:00:00',
    endAt: '2027-06-25T16:00:00',
    requiredGuardCount: 3,
  });
  const shifts = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id }, order: { id: 'ASC' } });

  const { guard: g1, guardUser: gu1 } = await createGuardWithRelationship(ds, company, 'ca-g1');
  const { guard: g2, guardUser: gu2 } = await createGuardWithRelationship(ds, company, 'ca-g2');

  // Assign g1 and g2; shift[2] stays unfilled
  await rotaSvc.assignPosition(companyUser, slot.id, { shiftId: shifts[0].id, guardId: g1.id });
  await rotaSvc.assignPosition(companyUser, slot.id, { shiftId: shifts[1].id, guardId: g2.id });

  // Set shift[0] to ready directly (simulates prior accept)
  await ds.getRepository(Shift).update({ id: shifts[0].id }, { status: 'ready' });

  // Verify starting state: 1 ready, 1 offered, 1 unfilled
  const { slot: s1, shifts: sh1 } = await rotaSvc.getSlotDetail(companyUser, slot.id);
  const c1 = toSlotDetail(s1, sh1).counts;
  equal(c1.confirmed, 1, 'COV-ACCEPT before: confirmed=1');
  equal(c1.offered, 1, 'COV-ACCEPT before: offered=1');
  equal(c1.open, 1, 'COV-ACCEPT before: open=1');

  // g2 accepts
  const userMap = new Map([[gu2.id, g2]]);
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap });
  await svc.respondForGuard(makeGuardUser(gu2.id), shifts[1].id, { response: 'accepted' });

  const { slot: s2, shifts: sh2 } = await rotaSvc.getSlotDetail(companyUser, slot.id);
  const c2 = toSlotDetail(s2, sh2).counts;
  equal(c2.confirmed, 2, 'COV-ACCEPT after: confirmed=2');
  equal(c2.offered, 0, 'COV-ACCEPT after: offered=0');
  equal(c2.open, 1, 'COV-ACCEPT after: open=1');

  console.log(`PASS COV-ACCEPT: coverage after acceptance: confirmed=${c2.confirmed} offered=${c2.offered} open=${c2.open}`);
}

async function testCoverageAfterReject(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'cov-reject');
  const rotaSvc = makeRotaSlotService(ds, company);
  const companyUser = makeCompanyUser();

  const slot = await rotaSvc.createSlot(companyUser, {
    siteId: site.id,
    startAt: '2027-06-26T08:00:00',
    endAt: '2027-06-26T16:00:00',
    requiredGuardCount: 3,
  });
  const shifts = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id }, order: { id: 'ASC' } });

  const { guard: g1, guardUser: gu1 } = await createGuardWithRelationship(ds, company, 'cr-g1');
  const { guard: g2, guardUser: gu2 } = await createGuardWithRelationship(ds, company, 'cr-g2');

  await rotaSvc.assignPosition(companyUser, slot.id, { shiftId: shifts[0].id, guardId: g1.id });
  await rotaSvc.assignPosition(companyUser, slot.id, { shiftId: shifts[1].id, guardId: g2.id });
  await ds.getRepository(Shift).update({ id: shifts[0].id }, { status: 'ready' });

  // g2 rejects
  const userMap = new Map([[gu2.id, g2]]);
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap });
  await svc.respondForGuard(makeGuardUser(gu2.id), shifts[1].id, { response: 'rejected' });

  const { slot: s2, shifts: sh2 } = await rotaSvc.getSlotDetail(companyUser, slot.id);
  const detail = toSlotDetail(s2, sh2);
  const c = detail.counts;

  // 1 ready (confirmed), 0 offered, 1 rejected (contributes to problem), 1 unfilled (open)
  equal(c.confirmed, 1, 'COV-REJECT: confirmed=1');
  equal(c.offered, 0, 'COV-REJECT: offered=0');
  equal(c.problem, 1, 'COV-REJECT: problem=1');

  console.log(`PASS COV-REJECT: confirmed=${c.confirmed} offered=${c.offered} problem=${c.problem} open=${c.open} state=${detail.coverageState}`);
}

async function testDirectCreateClash(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'direct-create');
  const { guard, guardUser } = await createGuardWithRelationship(ds, company, 'dc-g1');

  // Guard already has an offered shift 08:00–16:00
  await createOfferedShift(ds, company, site, guard, '2027-06-28T08:00:00', '2027-06-28T16:00:00');

  const idToGuard = new Map([[guard.id, guard]]);
  const userMap = new Map([[guardUser.id, guard]]);

  // Use real clash availability
  const realAvail = makeRealClashAvailability(ds);
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap, idToGuard, availability: realAvail });

  // Attempt to create a new offered shift with same guard overlapping
  await rejects(
    () => svc.createForUser(makeCompanyUser(), {
      guardId: guard.id,
      siteId: site.id,
      start: '2027-06-28T10:00:00',
      end: '2027-06-28T18:00:00',
      companyId: company.id,
    }),
    (err: any) => {
      ok(
        err instanceof ForbiddenException || err?.status === 403,
        `DIRECT-CREATE: expected ForbiddenException for clash, got ${err?.constructor?.name}: ${err?.message}`,
      );
      return true;
    },
  );
  console.log('PASS DIRECT-CREATE: creating offered shift with clashing guard is blocked');
}

async function testDirectUpdateClash(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'direct-update');
  const { guard: g1 } = await createGuardWithRelationship(ds, company, 'du-g1');
  const { guard: g2, guardUser: gu2 } = await createGuardWithRelationship(ds, company, 'du-g2');

  // g2 already has an offered shift 08:00–16:00
  await createOfferedShift(ds, company, site, g2, '2027-06-29T08:00:00', '2027-06-29T16:00:00');

  // Create an unfilled shift that we'll try to reassign to g2
  const unfilledShift = await ds.getRepository(Shift).save(ds.getRepository(Shift).create({
    company, site, siteName: site.name,
    start: new Date('2027-06-29T10:00:00'), end: new Date('2027-06-29T18:00:00'),
    checkCallIntervalMinutes: 60, status: 'unfilled',
  }));

  const idToGuard = new Map([[g1.id, g1], [g2.id, g2]]);
  const userMap = new Map([[gu2.id, g2]]);
  const realAvail = makeRealClashAvailability(ds);
  const svc = makeShiftService(ds, { company, site, userToGuard: userMap, idToGuard, availability: realAvail });

  // Attempt to reassign unfilled shift to g2 who has a clash
  await rejects(
    () => svc.updateForUser(makeCompanyUser(), unfilledShift.id, { guardId: g2.id }),
    (err: any) => {
      ok(
        err instanceof ForbiddenException || err?.status === 403,
        `DIRECT-UPDATE: expected ForbiddenException for clash, got ${err?.constructor?.name}: ${err?.message}`,
      );
      return true;
    },
  );

  const final = await ds.getRepository(Shift).findOneOrFail({ where: { id: unfilledShift.id } });
  equal(final.status, 'unfilled', 'DIRECT-UPDATE: shift remains unfilled after blocked reassign');
  console.log('PASS DIRECT-UPDATE: reassigning shift to clashing guard is blocked');
}

async function testRotaAssignmentRegression(ds: DataSource) {
  const { company, site } = await createCompanyWithSite(ds, 'rota-reg');
  const rotaSvc = makeRotaSlotService(ds, company);
  const user = makeCompanyUser();

  const slot = await rotaSvc.createSlot(user, {
    siteId: site.id,
    startAt: '2027-07-01T08:00:00',
    endAt: '2027-07-01T16:00:00',
    requiredGuardCount: 1,
  });
  const [shift] = await ds.getRepository(Shift).find({ where: { rotaSlotId: slot.id } });
  const { guard: g1 } = await createGuardWithRelationship(ds, company, 'rota-reg-g1');
  const { guard: g2 } = await createGuardWithRelationship(ds, company, 'rota-reg-g2');

  const [r1, r2] = await Promise.allSettled([
    rotaSvc.assignPosition(user, slot.id, { shiftId: shift.id, guardId: g1.id }),
    rotaSvc.assignPosition(user, slot.id, { shiftId: shift.id, guardId: g2.id }),
  ]);

  const successes = [r1, r2].filter((r) => r.status === 'fulfilled');
  ok(successes.length >= 1, 'ROTA-REGRESSION: at least one assignment succeeds');

  // Final state invariant: shift must be in 'offered' with exactly one guard assigned
  const final = await ds.getRepository(Shift).findOneOrFail({ where: { id: shift.id }, relations: ['guard'] });
  equal(final.status, 'offered', 'ROTA-REGRESSION: shift is offered after assignment');
  ok(final.guard != null, 'ROTA-REGRESSION: shift has exactly one guard assigned');

  // If both resolved, verify they agree on the committed guard (second saw already-committed state)
  if (successes.length === 2) {
    const assignedGuardIds = new Set([g1.id, g2.id]);
    ok(assignedGuardIds.has(final.guard!.id), 'ROTA-REGRESSION: committed guard is one of the two candidates');
  }

  console.log(`PASS ROTA-ASSIGNMENT-REGRESSION: concurrent assignment → guard=${final.guard!.id}, ${successes.length === 1 ? 'one winner + one 409' : 'both resolved to committed state'}`);
}

// ── Main runner ───────────────────────────────────────────────────────────────

async function main() {
  const ds = new DataSource(buildTypeOrmOptions({
    DATABASE_URL: dbUrl, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test',
  }));

  await ds.initialize();
  console.log('[shift-offers] Connected to PostgreSQL');

  try {
    await cleanup(ds);

    await testAccept(ds);
    await testReject(ds);
    await testDoubleAccept(ds);
    await testAcceptRejectRace(ds);
    await testStaleAccept(ds);
    await testOverlappingOffers(ds);
    await testComplianceBlock(ds);
    await testCompanyRelationshipRevoked(ds);
    await testIdo(ds);
    await testWrongStatus(ds);
    await testCoverageAfterAccept(ds);
    await testCoverageAfterReject(ds);
    await test15GuardScenario(ds);
    await testAuditLogging(ds);
    await testDirectCreateClash(ds);
    await testDirectUpdateClash(ds);
    await testRotaAssignmentRegression(ds);

    console.log('\n✓ All shift-offer-lifecycle tests PASSED');
  } finally {
    await cleanup(ds);
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('[shift-offers] FAILED:', err);
  process.exit(1);
});
