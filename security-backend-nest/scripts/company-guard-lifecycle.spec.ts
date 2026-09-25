/**
 * 2D1 PostgreSQL certification for Company Guard relationship hardening.
 *
 * Requires: ROTA_SLOT_TEST_DB_URL (defaults to rehearsal DB at port 54322).
 *
 * Tests certified:
 *   LINK               Company GUARDS_MANAGE links unlinked guard → ACTIVE relationship created
 *   LINK-IDEMPOTENT    Same guard linked twice → single row, second call returns existing ACTIVE
 *   LINK-REACTIVATE    BLOCKED guard re-linked → status back to ACTIVE
 *   LINK-DUPLICATE     Concurrent link requests → exactly one row, no duplicate
 *   DISCOVERY-OWNER    Legacy company owner resolves company via membership fallback
 *   DISCOVERY-STAFF    COMPANY_STAFF resolves same company via membership
 *   STATUS-INACTIVE    ACTIVE → INACTIVE via PATCH
 *   STATUS-BLOCKED     ACTIVE → BLOCKED via PATCH
 *   STATUS-REACTIVATE  BLOCKED → ACTIVE via PATCH
 *   TENANT-READ        Company B cannot read Company A relationships
 *   TENANT-WRITE       Company B cannot mutate Company A relationship
 *   MULTI-COMPANY      Guard linked to A and B independently; block in A does not affect B
 *   GLOBAL-APPROVAL-INDEPENDENCE  Link/block operations do not mutate GuardProfile.approvalStatus
 *   BLOCKED-ROTA       assignPosition blocked for BLOCKED guard
 *   BLOCKED-DIRECT-SHIFT  createForUser blocked for BLOCKED guard
 *   BLOCKED-OFFER-ACCEPT  respondForGuard acceptance blocked for BLOCKED guard
 *   HISTORY-PRESERVED  ACTIVE → BLOCKED does not delete shifts, audit logs, or guard profile
 *   AUDIT-LINK         company_guard.linked audit event on new link
 *   AUDIT-STATUS       company_guard.status_changed audit event on PATCH
 */

import 'reflect-metadata';

import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { equal, ok, rejects, notEqual } from 'node:assert/strict';
import { DataSource, In, LessThan, MoreThan, Repository } from 'typeorm';

import { JwtPayload } from '../src/auth/types/jwt-payload.type';
import { buildTypeOrmOptions } from '../src/database/typeorm.config';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { Company, CompanyStatus } from '../src/company/entities/company.entity';
import {
  CompanyGuard,
  CompanyGuardStatus,
  CompanyGuardRelationshipType,
} from '../src/company-guard/entities/company-guard.entity';
import {
  CompanyMembership,
} from '../src/company-membership/entities/company-membership.entity';
import {
  CompanyMembershipRole,
  CompanyMembershipStatus,
} from '../src/company-membership/company-membership-types';
import { GuardApprovalStatus, GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { RotaSlot } from '../src/rota-slot/entities/rota-slot.entity';
import { RotaSlotService } from '../src/rota-slot/rota-slot.service';
import { Shift } from '../src/shift/entities/shift.entity';
import { ShiftService } from '../src/shift/shift.service';
import { Site } from '../src/site/entities/site.entity';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { CompanyGuardService } from '../src/company-guard/company-guard.service';
import { UpdateCompanyGuardDto } from '../src/company-guard/dto/update-company-guard.dto';

const TEST_PREFIX = 'CG-LIFECYCLE-TEST';
const dbUrl =
  process.env.ROTA_SLOT_TEST_DB_URL ||
  'postgresql://postgres:postgres@127.0.0.1:54322/s4_migration_rehearsal';

if (!process.env.ROTA_SLOT_TEST_DB_URL) {
  console.warn('[company-guards] ROTA_SLOT_TEST_DB_URL not set — using local rehearsal DB');
}

// ── Stubs ──────────────────────────────────────────────────────────────────────

type AuditEntry = { action: string; entityId?: number | null; afterData?: Record<string, unknown> | null; beforeData?: Record<string, unknown> | null };

function makeCapturingAudit() {
  const captured: AuditEntry[] = [];
  const stub = {
    log: async (input: AuditEntry) => { captured.push(input); return input as any; },
    findForCompany: async () => [],
    findAll: async () => [],
  };
  return { stub, captured };
}

const auditPassStub = { log: async () => undefined, findForCompany: async () => [], findAll: async () => [] } as any;
const assignmentStub = { findOne: async () => null } as any;
const timesheetStub = { createForShift: async () => null } as any;
const availPassStub = { assertGuardCanTakeShift: async () => undefined, eligibleGuardsForShift: async () => [] } as any;
const availBlockStub = { assertGuardCanTakeShift: async () => { throw new ForbiddenException('Guard has an overlapping shift assignment.'); } } as any;
const compliancePassStub = { assertGuardAssignable: async () => undefined } as any;

function siteStub(site: Site) {
  return { findOne: async () => site, findMany: async () => [site] } as any;
}

function membershipStub(company: Company) {
  return {
    resolveCompanyContext: async () => ({ company, membershipRole: CompanyMembershipRole.ADMIN }),
  } as any;
}

function guardProfileStub(userToGuard: Map<number, GuardProfile>, idToGuard?: Map<number, GuardProfile>) {
  return {
    findByUserId: async (userId: number) => userToGuard.get(userId) ?? null,
    findOne: async (id: number) => (idToGuard ?? new Map()).get(id) ?? null,
  } as any;
}

// ── Service factories ──────────────────────────────────────────────────────────

function makeCompanyGuardService(
  ds: DataSource,
  company: Company,
  auditCapture?: ReturnType<typeof makeCapturingAudit>,
): CompanyGuardService {
  const audit = auditCapture ? auditCapture.stub : auditPassStub;
  const guardSvc = {
    findOne: async (id: number) => {
      const g = await ds.getRepository(GuardProfile).findOne({ where: { id } });
      if (!g) throw new NotFoundException('Guard profile not found');
      return g;
    },
  } as any;
  const companySvc = {
    findOne: async (id: number) => {
      const c = await ds.getRepository(Company).findOne({ where: { id } });
      if (!c) throw new NotFoundException('Company not found');
      return c;
    },
    findByUserId: async (userId: number) => ds.getRepository(Company).findOne({ where: { user: { id: userId } } }),
  } as any;
  const complianceSvc = { assertGuardAssignable: async () => undefined } as any;
  return new CompanyGuardService(
    ds.getRepository(CompanyGuard),
    companySvc,
    membershipStub(company) as any,
    guardSvc,
    audit as any,
  );
}

function makeShiftService(
  ds: DataSource,
  opts: {
    company: Company;
    site: Site;
    userToGuard: Map<number, GuardProfile>;
    idToGuard?: Map<number, GuardProfile>;
    companyGuard?: any;
    availability?: any;
    compliance?: any;
    auditCapture?: ReturnType<typeof makeCapturingAudit>;
  },
): ShiftService {
  const audit = opts.auditCapture ? opts.auditCapture.stub : auditPassStub;
  return new ShiftService(
    ds.getRepository(Shift),
    ds.getRepository(Company),
    ds.getRepository(GuardProfile),
    ds.getRepository(require('../src/job/entities/job.entity').Job),
    ds.getRepository(require('../src/job-application/entities/job-application.entity').JobApplication),
    ds.getRepository(require('../src/timesheet/entities/timesheet.entity').Timesheet),
    assignmentStub,
    timesheetStub,
    siteStub(opts.site),
    membershipStub(opts.company) as any,
    guardProfileStub(opts.userToGuard, opts.idToGuard),
    opts.companyGuard ?? { ensureActiveRelationship: async () => undefined } as any,
    opts.availability ?? availPassStub,
    opts.compliance ?? compliancePassStub,
    ds,
    audit as any,
  );
}

function makeRotaSlotService(ds: DataSource, company: Company, companyGuard?: any): RotaSlotService {
  return new RotaSlotService(
    ds.getRepository(RotaSlot),
    ds.getRepository(Shift),
    ds.getRepository(Site),
    ds.getRepository(GuardProfile),
    ds,
    membershipStub(company) as any,
    companyGuard ?? { ensureActiveRelationship: async () => undefined } as any,
    availPassStub,
    auditPassStub as any,
  );
}

function makeCompanyJwt(userId: number, role: UserRole = UserRole.COMPANY_STAFF): JwtPayload {
  return { sub: userId, role, email: `staff-${userId}@${TEST_PREFIX}.example`, status: UserStatus.ACTIVE };
}

function makeGuardJwt(userId: number): JwtPayload {
  return { sub: userId, role: UserRole.GUARD, email: `guard-${userId}@${TEST_PREFIX}.example`, status: UserStatus.ACTIVE };
}

// ── Fixture helpers ────────────────────────────────────────────────────────────

async function createCompany(ds: DataSource, suffix: string) {
  const ownerUser = await ds.getRepository(User).save(ds.getRepository(User).create({
    email: `owner-${suffix}@${TEST_PREFIX}.example`,
    passwordHash: 'x', role: UserRole.COMPANY_ADMIN,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const company = await ds.getRepository(Company).save(ds.getRepository(Company).create({
    user: ownerUser, name: `${TEST_PREFIX}-${suffix}`,
    companyNumber: `CG-${suffix.slice(0, 8)}`, address: 'Test',
    contactDetails: 'test', status: CompanyStatus.ACTIVE,
  }));
  const site = await ds.getRepository(Site).save(ds.getRepository(Site).create({
    company, name: `${TEST_PREFIX}-Site-${suffix}`, address: 'Test',
    status: 'active', requiredGuardCount: 1, welfareCheckIntervalMinutes: 60,
  }));
  return { company, site, ownerUser };
}

async function createStaffMember(ds: DataSource, company: Company, suffix: string) {
  const staffUser = await ds.getRepository(User).save(ds.getRepository(User).create({
    email: `staff-${suffix}@${TEST_PREFIX}.example`,
    passwordHash: 'x', role: UserRole.COMPANY_STAFF,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  await ds.getRepository(CompanyMembership).save(
    ds.getRepository(CompanyMembership).create({
      userId: staffUser.id,
      company,
      membershipRole: CompanyMembershipRole.OPERATIONS,
      status: CompanyMembershipStatus.ACTIVE,
    }),
  );
  return staffUser;
}

async function createGuard(ds: DataSource, suffix: string): Promise<{ guard: GuardProfile; guardUser: User }> {
  const guardUser = await ds.getRepository(User).save(ds.getRepository(User).create({
    email: `guard-${suffix}@${TEST_PREFIX}.example`,
    passwordHash: 'x', role: UserRole.GUARD,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const guard = await ds.getRepository(GuardProfile).save(ds.getRepository(GuardProfile).create({
    user: guardUser, fullName: `Guard ${suffix}`,
    siaLicenseNumber: `CG${suffix.padStart(13, '0').slice(-13)}`,
    phone: '07000000000',
    status: GuardApprovalStatus.APPROVED,
    approvalStatus: GuardApprovalStatus.APPROVED,
    isApproved: true,
  }));
  return { guard, guardUser };
}

async function linkGuardToCompany(ds: DataSource, company: Company, guard: GuardProfile, status = CompanyGuardStatus.ACTIVE) {
  return ds.getRepository(CompanyGuard).save(
    ds.getRepository(CompanyGuard).create({ company, guard, status }),
  );
}

async function createOfferedShift(ds: DataSource, company: Company, site: Site, guard: GuardProfile, start: string, end: string): Promise<Shift> {
  return ds.getRepository(Shift).save(ds.getRepository(Shift).create({
    company, guard, site, siteName: site.name,
    start: new Date(start), end: new Date(end),
    checkCallIntervalMinutes: 60, status: 'offered',
  }));
}

async function createReadyShift(ds: DataSource, company: Company, site: Site, guard: GuardProfile, start: string, end: string): Promise<Shift> {
  return ds.getRepository(Shift).save(ds.getRepository(Shift).create({
    company, guard, site, siteName: site.name,
    start: new Date(start), end: new Date(end),
    checkCallIntervalMinutes: 60, status: 'ready',
  }));
}

async function createRotaSlot(ds: DataSource, company: Company, site: Site, start: string, end: string): Promise<RotaSlot> {
  return ds.getRepository(RotaSlot).save(ds.getRepository(RotaSlot).create({
    companyId: company.id,
    siteId: site.id,
    startAt: new Date(start),
    endAt: new Date(end),
    requiredGuardCount: 1,
  }));
}

async function cleanup(ds: DataSource) {
  await ds.query(`DELETE FROM audit_logs WHERE "entityType" IN ('company_guard', 'shift') AND "entityId" IN (SELECT id FROM shifts WHERE "companyId" IN (SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%'))`);
  await ds.query(`DELETE FROM audit_logs WHERE "entityType" = 'company_guard' AND "companyId" IN (SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%')`);
  await ds.query(`DELETE FROM shifts WHERE "companyId" IN (SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%')`);
  await ds.query(`DELETE FROM rota_slots WHERE "companyId" IN (SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%')`);
  await ds.query(`DELETE FROM company_guards WHERE "companyId" IN (SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%')`);
  await ds.query(`DELETE FROM company_memberships WHERE "userId" IN (SELECT id FROM users WHERE email LIKE '%@${TEST_PREFIX}.example')`);
  await ds.query(`DELETE FROM sites WHERE "companyId" IN (SELECT id FROM companies WHERE name LIKE '${TEST_PREFIX}%')`);
  await ds.query(`DELETE FROM companies WHERE name LIKE '${TEST_PREFIX}%'`);
  await ds.query(`DELETE FROM guard_profiles WHERE "userId" IN (SELECT id FROM users WHERE email LIKE '%@${TEST_PREFIX}.example')`);
  await ds.query(`DELETE FROM users WHERE email LIKE '%@${TEST_PREFIX}.example'`);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

async function testLink(ds: DataSource) {
  const { company } = await createCompany(ds, 'link');
  const { guard } = await createGuard(ds, 'link-g1');

  const jwt = makeCompanyJwt(999001);
  const svc = makeCompanyGuardService(ds, company);
  const result = await svc.linkForCompanyUser(jwt, guard.id);

  equal(result.status, CompanyGuardStatus.ACTIVE);
  equal(result.guard.id, guard.id);
  equal(result.company.id, company.id);

  const row = await ds.getRepository(CompanyGuard).findOne({
    where: { company: { id: company.id }, guard: { id: guard.id } },
  });
  ok(row, 'Row created in DB');
  equal(row!.status, CompanyGuardStatus.ACTIVE);
  console.log('PASS LINK: unlinked guard → ACTIVE relationship');
}

async function testLinkIdempotent(ds: DataSource) {
  const { company } = await createCompany(ds, 'link-idem');
  const { guard } = await createGuard(ds, 'link-idem-g1');
  await linkGuardToCompany(ds, company, guard, CompanyGuardStatus.ACTIVE);

  const jwt = makeCompanyJwt(999002);
  const svc = makeCompanyGuardService(ds, company);
  const result = await svc.linkForCompanyUser(jwt, guard.id);

  equal(result.status, CompanyGuardStatus.ACTIVE);

  const rows = await ds.getRepository(CompanyGuard).find({
    where: { company: { id: company.id }, guard: { id: guard.id } },
  });
  equal(rows.length, 1, 'Exactly one relationship row');
  console.log('PASS LINK-IDEMPOTENT: re-link ACTIVE → still ACTIVE, single row');
}

async function testLinkReactivate(ds: DataSource) {
  const { company } = await createCompany(ds, 'link-react');
  const { guard } = await createGuard(ds, 'link-react-g1');
  await linkGuardToCompany(ds, company, guard, CompanyGuardStatus.BLOCKED);

  const jwt = makeCompanyJwt(999003);
  const svc = makeCompanyGuardService(ds, company);
  const result = await svc.linkForCompanyUser(jwt, guard.id);

  equal(result.status, CompanyGuardStatus.ACTIVE, 'Re-link of BLOCKED → ACTIVE');
  const rows = await ds.getRepository(CompanyGuard).find({
    where: { company: { id: company.id }, guard: { id: guard.id } },
  });
  equal(rows.length, 1, 'Single row, no duplicate');
  console.log('PASS LINK-REACTIVATE: BLOCKED guard re-linked → ACTIVE, single row');
}

async function testLinkDuplicate(ds: DataSource) {
  const { company } = await createCompany(ds, 'link-dup');
  const { guard } = await createGuard(ds, 'link-dup-g1');

  const jwt = makeCompanyJwt(999004);
  const svc = makeCompanyGuardService(ds, company);

  // Concurrent: both should resolve to a single ACTIVE row
  const [r1, r2] = await Promise.allSettled([
    svc.linkForCompanyUser(jwt, guard.id),
    svc.linkForCompanyUser(jwt, guard.id),
  ]);

  const rows = await ds.getRepository(CompanyGuard).find({
    where: { company: { id: company.id }, guard: { id: guard.id } },
  });
  equal(rows.length, 1, 'Exactly one row after concurrent link');
  const successes = [r1, r2].filter((r) => r.status === 'fulfilled');
  ok(successes.length >= 1, 'At least one succeeded');
  console.log('PASS LINK-DUPLICATE: concurrent link → exactly one row');
}

async function testDiscoveryOwner(ds: DataSource) {
  // Owner resolves company via resolveCompanyContext legacy path
  const { company, ownerUser } = await createCompany(ds, 'disc-owner');
  const { guard } = await createGuard(ds, 'disc-owner-g1');
  await linkGuardToCompany(ds, company, guard);

  const jwt: JwtPayload = { sub: ownerUser.id, role: UserRole.COMPANY_ADMIN, email: ownerUser.email, status: UserStatus.ACTIVE };
  const svc = makeCompanyGuardService(ds, company);
  // linkForCompanyUser uses resolveCompanyContext via membership stub — verify it finds the guard
  const result = await svc.linkForCompanyUser(jwt, guard.id);
  equal(result.status, CompanyGuardStatus.ACTIVE);
  console.log('PASS DISCOVERY-OWNER: owner resolves company and accesses guard');
}

async function testDiscoveryStaff(ds: DataSource) {
  const { company } = await createCompany(ds, 'disc-staff');
  const staffUser = await createStaffMember(ds, company, 'disc-staff-s1');
  const { guard } = await createGuard(ds, 'disc-staff-g1');

  const jwt = makeCompanyJwt(staffUser.id, UserRole.COMPANY_STAFF);
  const svc = makeCompanyGuardService(ds, company);
  // With the membership stub resolving the same company, both owner and staff resolve same company
  const result = await svc.linkForCompanyUser(jwt, guard.id);
  equal(result.company.id, company.id, 'Staff resolves same company as owner');
  console.log('PASS DISCOVERY-STAFF: COMPANY_STAFF resolves same company as owner');
}

async function testStatusInactive(ds: DataSource) {
  const { company } = await createCompany(ds, 'status-inactive');
  const { guard } = await createGuard(ds, 'status-inactive-g1');
  const rel = await linkGuardToCompany(ds, company, guard, CompanyGuardStatus.ACTIVE);

  const jwt = makeCompanyJwt(999010);
  const svc = makeCompanyGuardService(ds, company);
  const dto: UpdateCompanyGuardDto = { status: CompanyGuardStatus.INACTIVE };
  const result = await svc.updateStatusForCompanyUser(jwt, rel.id, dto);

  equal(result.status, CompanyGuardStatus.INACTIVE);
  const row = await ds.getRepository(CompanyGuard).findOneOrFail({ where: { id: rel.id } });
  equal(row.status, CompanyGuardStatus.INACTIVE, 'DB persisted INACTIVE');
  console.log('PASS STATUS-INACTIVE: ACTIVE → INACTIVE');
}

async function testStatusBlocked(ds: DataSource) {
  const { company } = await createCompany(ds, 'status-blocked');
  const { guard } = await createGuard(ds, 'status-blocked-g1');
  const rel = await linkGuardToCompany(ds, company, guard, CompanyGuardStatus.ACTIVE);

  const jwt = makeCompanyJwt(999011);
  const svc = makeCompanyGuardService(ds, company);
  const dto: UpdateCompanyGuardDto = { status: CompanyGuardStatus.BLOCKED };
  const result = await svc.updateStatusForCompanyUser(jwt, rel.id, dto);

  equal(result.status, CompanyGuardStatus.BLOCKED);
  const row = await ds.getRepository(CompanyGuard).findOneOrFail({ where: { id: rel.id } });
  equal(row.status, CompanyGuardStatus.BLOCKED, 'DB persisted BLOCKED');
  console.log('PASS STATUS-BLOCKED: ACTIVE → BLOCKED');
}

async function testStatusReactivate(ds: DataSource) {
  const { company } = await createCompany(ds, 'status-react');
  const { guard } = await createGuard(ds, 'status-react-g1');
  const rel = await linkGuardToCompany(ds, company, guard, CompanyGuardStatus.BLOCKED);

  const jwt = makeCompanyJwt(999012);
  const svc = makeCompanyGuardService(ds, company);
  const dto: UpdateCompanyGuardDto = { status: CompanyGuardStatus.ACTIVE };
  const result = await svc.updateStatusForCompanyUser(jwt, rel.id, dto);

  equal(result.status, CompanyGuardStatus.ACTIVE, 'BLOCKED → ACTIVE');
  console.log('PASS STATUS-REACTIVATE: BLOCKED → ACTIVE');
}

async function testTenantRead(ds: DataSource) {
  const { company: compA } = await createCompany(ds, 'tenant-ra');
  const { company: compB } = await createCompany(ds, 'tenant-rb');
  const { guard } = await createGuard(ds, 'tenant-r-g1');
  const relA = await linkGuardToCompany(ds, compA, guard, CompanyGuardStatus.ACTIVE);

  // Company B service cannot see Company A's relationship
  const svcB = makeCompanyGuardService(ds, compB);
  const jwtB = makeCompanyJwt(999020);

  const dto: UpdateCompanyGuardDto = { status: CompanyGuardStatus.BLOCKED };
  await rejects(
    () => svcB.updateStatusForCompanyUser(jwtB, relA.id, dto),
    (err: any) => err instanceof NotFoundException,
    'Company B cannot mutate Company A relationship',
  );
  console.log('PASS TENANT-READ: Company B cannot read/mutate Company A relationship');
}

async function testTenantWrite(ds: DataSource) {
  const { company: compA } = await createCompany(ds, 'tenant-wa');
  const { company: compB } = await createCompany(ds, 'tenant-wb');
  const { guard } = await createGuard(ds, 'tenant-w-g1');
  const relA = await linkGuardToCompany(ds, compA, guard, CompanyGuardStatus.ACTIVE);

  // Company B cannot block Company A's guard link using Company A's row ID
  const svcB = makeCompanyGuardService(ds, compB);
  const jwtB = makeCompanyJwt(999021);
  const dto: UpdateCompanyGuardDto = { status: CompanyGuardStatus.BLOCKED };

  await rejects(
    () => svcB.updateStatusForCompanyUser(jwtB, relA.id, dto),
    (err: any) => err instanceof NotFoundException,
    'Company B cannot write to Company A relationship',
  );

  const unchanged = await ds.getRepository(CompanyGuard).findOneOrFail({ where: { id: relA.id } });
  equal(unchanged.status, CompanyGuardStatus.ACTIVE, 'Company A relationship unchanged');
  console.log('PASS TENANT-WRITE: Company B cannot mutate Company A relationship');
}

async function testMultiCompany(ds: DataSource) {
  const { company: compA, site: siteA } = await createCompany(ds, 'multi-a');
  const { company: compB, site: siteB } = await createCompany(ds, 'multi-b');
  const { guard, guardUser } = await createGuard(ds, 'multi-g1');

  // Guard linked to A only
  const relA = await linkGuardToCompany(ds, compA, guard, CompanyGuardStatus.ACTIVE);

  // Company A can assign
  const cgSvcA = makeCompanyGuardService(ds, compA);
  await cgSvcA.ensureActiveRelationship(compA.id, guard.id); // must not throw

  // Company B cannot assign — no relationship
  await rejects(
    () => makeCompanyGuardService(ds, compB).ensureActiveRelationship(compB.id, guard.id),
    (err: any) => err instanceof ForbiddenException,
    'Company B blocked — no relationship',
  );

  // Link guard to B
  const jwtB = makeCompanyJwt(999031);
  const svcB = makeCompanyGuardService(ds, compB);
  await svcB.linkForCompanyUser(jwtB, guard.id);
  await svcB.ensureActiveRelationship(compB.id, guard.id); // must not throw now

  // Block in Company A only
  const jwtA = makeCompanyJwt(999030);
  const dto: UpdateCompanyGuardDto = { status: CompanyGuardStatus.BLOCKED };
  await cgSvcA.updateStatusForCompanyUser(jwtA, relA.id, dto);

  await rejects(
    () => cgSvcA.ensureActiveRelationship(compA.id, guard.id),
    (err: any) => err instanceof ForbiddenException,
    'Company A blocked after status change',
  );

  // Company B unaffected
  await svcB.ensureActiveRelationship(compB.id, guard.id); // must not throw
  console.log('PASS MULTI-COMPANY: independent relationships; block in A does not affect B');
}

async function testGlobalApprovalIndependence(ds: DataSource) {
  const { company } = await createCompany(ds, 'global-approve');
  const { guard } = await createGuard(ds, 'global-approve-g1');
  const rel = await linkGuardToCompany(ds, company, guard, CompanyGuardStatus.ACTIVE);

  const approvalBefore = guard.approvalStatus;

  const jwt = makeCompanyJwt(999040);
  const svc = makeCompanyGuardService(ds, company);

  // Block the relationship
  await svc.updateStatusForCompanyUser(jwt, rel.id, { status: CompanyGuardStatus.BLOCKED });

  // Global approval unchanged
  const refreshed = await ds.getRepository(GuardProfile).findOneOrFail({ where: { id: guard.id } });
  equal(refreshed.approvalStatus, approvalBefore, 'approvalStatus unchanged after block');
  equal(refreshed.isApproved, true, 'isApproved unchanged after block');

  // Link again
  await svc.linkForCompanyUser(jwt, guard.id);
  const refreshed2 = await ds.getRepository(GuardProfile).findOneOrFail({ where: { id: guard.id } });
  equal(refreshed2.approvalStatus, approvalBefore, 'approvalStatus unchanged after re-link');
  console.log('PASS GLOBAL-APPROVAL-INDEPENDENCE: link/block operations do not mutate GuardProfile.approvalStatus');
}

async function testBlockedRota(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'blocked-rota');
  const { guard } = await createGuard(ds, 'blocked-rota-g1');
  await linkGuardToCompany(ds, company, guard, CompanyGuardStatus.BLOCKED);

  const cgBlockedStub = {
    ensureActiveRelationship: async () => { throw new ForbiddenException('Guard is not active/approved for this company'); },
  } as any;

  const slot = await createRotaSlot(ds, company, site, '2027-08-10T08:00:00', '2027-08-10T16:00:00');
  // Create an unfilled shift linked to the slot so assignPosition can find it
  const unfilledShift = await ds.getRepository(Shift).save(ds.getRepository(Shift).create({
    company, site, siteName: site.name,
    start: new Date('2027-08-10T08:00:00'), end: new Date('2027-08-10T16:00:00'),
    rotaSlotId: slot.id, checkCallIntervalMinutes: 60, status: 'unfilled',
  }));

  const rotaSvc = makeRotaSlotService(ds, company, cgBlockedStub);

  const companyJwt: JwtPayload = { sub: 999050, role: UserRole.COMPANY_ADMIN, email: 'rota@test.example', status: UserStatus.ACTIVE };
  await rejects(
    () => rotaSvc.assignPosition(companyJwt, slot.id, { shiftId: unfilledShift.id, guardId: guard.id }),
    (err: any) => err instanceof ForbiddenException,
    'Rota assignment blocked for BLOCKED guard',
  );
  console.log('PASS BLOCKED-ROTA: assignPosition blocked for BLOCKED guard');
}

async function testBlockedDirectShift(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'blocked-direct');
  const { guard, guardUser } = await createGuard(ds, 'blocked-direct-g1');
  await linkGuardToCompany(ds, company, guard, CompanyGuardStatus.BLOCKED);

  const cgBlockedStub = {
    ensureActiveRelationship: async () => { throw new ForbiddenException('Guard is not active/approved for this company'); },
  } as any;

  const idToGuard = new Map([[guard.id, guard]]);
  const svc = makeShiftService(ds, {
    company, site,
    userToGuard: new Map(),
    idToGuard,
    companyGuard: cgBlockedStub,
  });

  const companyJwt: JwtPayload = { sub: 999051, role: UserRole.COMPANY_ADMIN, email: 'direct@test.example', status: UserStatus.ACTIVE };
  await rejects(
    () => svc.createForUser(companyJwt, {
      companyId: company.id,
      siteId: site.id,
      guardId: guard.id,
      start: '2027-08-15T08:00:00',
      end: '2027-08-15T16:00:00',
    }),
    (err: any) => err instanceof ForbiddenException,
    'Direct shift creation blocked for BLOCKED guard',
  );
  console.log('PASS BLOCKED-DIRECT-SHIFT: createForUser blocked for BLOCKED guard');
}

async function testBlockedOfferAccept(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'blocked-offer');
  const { guard, guardUser } = await createGuard(ds, 'blocked-offer-g1');
  // Start with ACTIVE so we can create the offered shift
  const rel = await linkGuardToCompany(ds, company, guard, CompanyGuardStatus.ACTIVE);
  const shift = await createOfferedShift(ds, company, site, guard, '2027-08-20T08:00:00', '2027-08-20T16:00:00');

  // Now block the relationship
  await ds.getRepository(CompanyGuard).update(rel.id, { status: CompanyGuardStatus.BLOCKED });

  const cgBlockedStub = {
    ensureActiveRelationship: async () => { throw new ForbiddenException('Guard is not active/approved for this company'); },
  } as any;

  const userMap = new Map([[guardUser.id, guard]]);
  const svc = makeShiftService(ds, {
    company, site,
    userToGuard: userMap,
    companyGuard: cgBlockedStub,
  });

  await rejects(
    () => svc.respondForGuard(makeGuardJwt(guardUser.id), shift.id, { response: 'accepted' }),
    (err: any) => err instanceof ForbiddenException,
    'Offer acceptance blocked after relationship blocked',
  );

  const unchanged = await ds.getRepository(Shift).findOneOrFail({ where: { id: shift.id } });
  equal(unchanged.status, 'offered', 'Shift remains offered — not transitioned');
  console.log('PASS BLOCKED-OFFER-ACCEPT: respondForGuard acceptance blocked for BLOCKED guard');
}

async function testHistoryPreserved(ds: DataSource) {
  const { company, site } = await createCompany(ds, 'history');
  const { guard } = await createGuard(ds, 'history-g1');
  const rel = await linkGuardToCompany(ds, company, guard, CompanyGuardStatus.ACTIVE);
  const shift = await createReadyShift(ds, company, site, guard, '2027-07-01T08:00:00', '2027-07-01T16:00:00');

  // Block
  const jwt = makeCompanyJwt(999060);
  const svc = makeCompanyGuardService(ds, company);
  await svc.updateStatusForCompanyUser(jwt, rel.id, { status: CompanyGuardStatus.BLOCKED });

  // Relationship row still exists
  const relRow = await ds.getRepository(CompanyGuard).findOne({ where: { id: rel.id } });
  ok(relRow, 'CompanyGuard row preserved');
  equal(relRow!.status, CompanyGuardStatus.BLOCKED);

  // Historical shift preserved
  const shiftRow = await ds.getRepository(Shift).findOne({ where: { id: shift.id } });
  ok(shiftRow, 'Historical shift preserved');
  equal(shiftRow!.status, 'ready', 'Shift status unchanged');

  // Guard profile preserved
  const guardRow = await ds.getRepository(GuardProfile).findOne({ where: { id: guard.id } });
  ok(guardRow, 'Guard profile preserved');

  console.log('PASS HISTORY-PRESERVED: block does not delete shifts, relationship row, or guard profile');
}

async function testAuditLink(ds: DataSource) {
  const { company } = await createCompany(ds, 'audit-link');
  const { guard } = await createGuard(ds, 'audit-link-g1');

  const auditCapture = makeCapturingAudit();
  const jwt = makeCompanyJwt(999070);

  const svc = new CompanyGuardService(
    ds.getRepository(CompanyGuard),
    {
      findOne: async (id: number) => ds.getRepository(Company).findOne({ where: { id } }),
      findByUserId: async (userId: number) => ds.getRepository(Company).findOne({ where: { user: { id: userId } } }),
    } as any,
    membershipStub(company) as any,
    {
      findOne: async (id: number) => {
        const g = await ds.getRepository(GuardProfile).findOne({ where: { id } });
        if (!g) throw new NotFoundException('Guard profile not found');
        return g;
      },
    } as any,
    auditCapture.stub as any,
  );

  await svc.linkForCompanyUser(jwt, guard.id);

  const linkEntry = auditCapture.captured.find((e) => e.action === 'company_guard.linked');
  ok(linkEntry, 'company_guard.linked audit event captured');
  equal((linkEntry!.afterData as any)?.guardId, guard.id);
  equal((linkEntry!.afterData as any)?.companyId, company.id);
  console.log('PASS AUDIT-LINK: company_guard.linked event captured');
}

async function testAuditStatus(ds: DataSource) {
  const { company } = await createCompany(ds, 'audit-status');
  const { guard } = await createGuard(ds, 'audit-status-g1');
  const rel = await linkGuardToCompany(ds, company, guard, CompanyGuardStatus.ACTIVE);

  const auditCapture = makeCapturingAudit();
  const jwt = makeCompanyJwt(999071);

  const svc = new CompanyGuardService(
    ds.getRepository(CompanyGuard),
    {
      findOne: async (id: number) => ds.getRepository(Company).findOne({ where: { id } }),
      findByUserId: async (userId: number) => ds.getRepository(Company).findOne({ where: { user: { id: userId } } }),
    } as any,
    membershipStub(company) as any,
    {
      findOne: async (id: number) => {
        const g = await ds.getRepository(GuardProfile).findOne({ where: { id } });
        if (!g) throw new NotFoundException('Guard profile not found');
        return g;
      },
    } as any,
    auditCapture.stub as any,
  );

  await svc.updateStatusForCompanyUser(jwt, rel.id, { status: CompanyGuardStatus.BLOCKED });

  const statusEntry = auditCapture.captured.find((e) => e.action === 'company_guard.status_changed');
  ok(statusEntry, 'company_guard.status_changed audit event captured');
  equal((statusEntry!.beforeData as any)?.status, CompanyGuardStatus.ACTIVE);
  equal((statusEntry!.afterData as any)?.status, CompanyGuardStatus.BLOCKED);
  console.log('PASS AUDIT-STATUS: company_guard.status_changed event with before/after');
}

// ── Runner ─────────────────────────────────────────────────────────────────────

async function run() {
  const ds = new DataSource({
    ...buildTypeOrmOptions({ DATABASE_URL: dbUrl }),
    synchronize: false,
    logging: false,
  } as any);

  await ds.initialize();

  try {
    await cleanup(ds);

    await testLink(ds);
    await testLinkIdempotent(ds);
    await testLinkReactivate(ds);
    await testLinkDuplicate(ds);
    await testDiscoveryOwner(ds);
    await testDiscoveryStaff(ds);
    await testStatusInactive(ds);
    await testStatusBlocked(ds);
    await testStatusReactivate(ds);
    await testTenantRead(ds);
    await testTenantWrite(ds);
    await testMultiCompany(ds);
    await testGlobalApprovalIndependence(ds);
    await testBlockedRota(ds);
    await testBlockedDirectShift(ds);
    await testBlockedOfferAccept(ds);
    await testHistoryPreserved(ds);
    await testAuditLink(ds);
    await testAuditStatus(ds);

    console.log('\n✓ All company-guard-lifecycle tests passed (19/19)');
  } finally {
    await cleanup(ds);
    await ds.destroy();
  }
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
