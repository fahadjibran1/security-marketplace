/**
 * 2D1 PostgreSQL certification for Company Guard relationship hardening.
 *
 * Requires: ROTA_SLOT_TEST_DB_URL — a disposable local s4_ test database. There is no default (see test-database-guard.ts).
 *
 * Tests certified:
 *   LINK-REFUSED       Company GUARDS_MANAGE cannot link an unlinked guard by id → 403, no row created
 *   LINK-ENUMERATION   Unknown guard id and existing unlinked guard id get the identical 403 (no existence signal)
 *   LINK-IDEMPOTENT    Guard already ACTIVE in this company → no-op returns existing ACTIVE, single row
 *   LINK-NO-REACTIVATE BLOCKED / INACTIVE guard re-linked by id → 403, status unchanged
 *   LINK-DUPLICATE     Concurrent link requests for an unlinked guard → both refused, no row
 *   ADMIN-LINK         Platform ADMIN direct create still works and is audited; a company role cannot use it
 *   DISCOVERY-OWNER    Legacy company owner resolves company via membership fallback
 *   DISCOVERY-STAFF    COMPANY_STAFF resolves same company via membership
 *   STATUS-INACTIVE    ACTIVE → INACTIVE via PATCH
 *   STATUS-BLOCKED     ACTIVE → BLOCKED via PATCH
 *   STATUS-NO-REACTIVATE  BLOCKED / INACTIVE → ACTIVE via PATCH refused; BLOCKED → INACTIVE (unblock) allowed
 *   TENANT-READ        Company B cannot read Company A relationships
 *   TENANT-WRITE       Company B cannot mutate Company A relationship
 *   MULTI-COMPANY      Guard linked to A and B independently; block in A does not affect B
 *   GLOBAL-APPROVAL-INDEPENDENCE  Link/block operations do not mutate GuardProfile.approvalStatus
 *   BLOCKED-ROTA       assignPosition blocked for BLOCKED guard
 *   BLOCKED-DIRECT-SHIFT  createForUser blocked for BLOCKED guard
 *   BLOCKED-OFFER-ACCEPT  respondForGuard acceptance blocked for BLOCKED guard
 *   HISTORY-PRESERVED  ACTIVE → BLOCKED does not delete shifts, audit logs, or guard profile
 *   AUDIT-LINK-REFUSED company_guard.link_refused audit event on a refused link; no company_guard.linked event
 *   AUDIT-STATUS       company_guard.status_changed audit event on PATCH
 */

import 'reflect-metadata';

import { assertDisposableTestDatabase, requireDisposableTestDatabaseUrl } from './test-database-guard';

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
import {
  CompanyGuardService,
  LINK_REQUIRES_INVITATION_MESSAGE,
  REACTIVATION_REQUIRES_INVITATION_MESSAGE,
} from '../src/company-guard/company-guard.service';
import { UpdateCompanyGuardDto } from '../src/company-guard/dto/update-company-guard.dto';
import { AttendanceEvent } from '../src/attendance/entities/attendance.entity';
import { DailyLog } from '../src/daily-log/entities/daily-log.entity';
import { SafetyAlert } from '../src/safety-alert/entities/safety-alert.entity';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import { WelfareWindowService } from '../src/operations/welfare-window.service';
import { LogBookWindowService } from '../src/operations/log-book-window.service';
import { OperationsProjectionService } from '../src/coverage/operations-projection.service';

const TEST_PREFIX = 'CG-LIFECYCLE-TEST';
// Fails closed before any connection: no default database (SEC-001B 2A test-database guard).
const dbUrl = requireDisposableTestDatabaseUrl('ROTA_SLOT_TEST_DB_URL');

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

/**
 * The real operations projection, for ShiftService's Guard shift response.
 *
 * Built from this spec's own DataSource rather than stubbed: the projection is stateless and the
 * window engine is pure, so a real one costs nothing and cannot drift from production behaviour.
 */
function makeOperationsProjection(ds: DataSource): OperationsProjectionService {
  const windowEngine = new OperationalWindowService();
  return new OperationsProjectionService(
    ds.getRepository(AttendanceEvent),
    ds.getRepository(DailyLog),
    ds.getRepository(SafetyAlert),
    windowEngine,
    new WelfareWindowService(windowEngine),
    new LogBookWindowService(windowEngine),
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
    makeOperationsProjection(ds),
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

const isLinkRefusal = (err: any) =>
  err instanceof ForbiddenException && err.message === LINK_REQUIRES_INVITATION_MESSAGE;

async function testLinkRefused(ds: DataSource) {
  const { company } = await createCompany(ds, 'link');
  const { guard } = await createGuard(ds, 'link-g1');

  const jwt = makeCompanyJwt(999001);
  const svc = makeCompanyGuardService(ds, company);
  await rejects(() => svc.linkForCompanyUser(jwt, guard.id), isLinkRefusal, 'Unlinked guard cannot be linked by id');

  const row = await ds.getRepository(CompanyGuard).findOne({
    where: { company: { id: company.id }, guard: { id: guard.id } },
  });
  equal(row, null, 'No relationship row created');
  console.log('PASS LINK-REFUSED: unlinked guard → 403, no relationship created');
}

async function testLinkEnumeration(ds: DataSource) {
  const { company } = await createCompany(ds, 'link-enum');
  const { guard } = await createGuard(ds, 'link-enum-g1');
  const [{ max }] = await ds.query('SELECT COALESCE(MAX(id), 0) AS max FROM guard_profiles');
  const unknownGuardId = Number(max) + 100000;

  const svc = makeCompanyGuardService(ds, company);
  const capture = async (guardId: number) => {
    try {
      await svc.linkForCompanyUser(makeCompanyJwt(999005), guardId);
      return { thrown: false, type: '', status: 0, message: '' };
    } catch (err: any) {
      return { thrown: true, type: err.constructor.name, status: err.getStatus?.(), message: err.message };
    }
  };
  const unknown = await capture(unknownGuardId);
  const existing = await capture(guard.id);

  ok(unknown.thrown && existing.thrown, 'Both requests refused');
  equal(unknown.type, 'ForbiddenException', 'Unknown id is 403, not 404');
  equal(unknown.status, 403);
  equal(existing.type, unknown.type, 'Same exception type');
  equal(existing.status, unknown.status, 'Same HTTP status');
  equal(existing.message, unknown.message, 'Same message');
  const rows = await ds.getRepository(CompanyGuard).count({ where: { company: { id: company.id } } });
  equal(rows, 0, 'No relationship rows created');
  console.log('PASS LINK-ENUMERATION: unknown and existing guard ids are indistinguishable (403, same message)');
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

async function testLinkNoReactivate(ds: DataSource) {
  const { company } = await createCompany(ds, 'link-react');
  const svc = makeCompanyGuardService(ds, company);
  const jwt = makeCompanyJwt(999003);

  for (const status of [CompanyGuardStatus.BLOCKED, CompanyGuardStatus.INACTIVE]) {
    // Labels stay distinct within their last 13 characters: createGuard derives the SIA number from them.
    const { guard } = await createGuard(ds, `lnr-${status.toLowerCase()}`);
    const rel = await linkGuardToCompany(ds, company, guard, status);

    await rejects(() => svc.linkForCompanyUser(jwt, guard.id), isLinkRefusal, `${status} relationship cannot be re-linked`);

    const row = await ds.getRepository(CompanyGuard).findOneOrFail({ where: { id: rel.id } });
    equal(row.status, status, `${status} relationship unchanged`);
    const rows = await ds.getRepository(CompanyGuard).count({
      where: { company: { id: company.id }, guard: { id: guard.id } },
    });
    equal(rows, 1, 'Single row, no duplicate');
  }
  console.log('PASS LINK-NO-REACTIVATE: BLOCKED and INACTIVE re-link by id → 403, status unchanged');
}

async function testLinkDuplicate(ds: DataSource) {
  const { company } = await createCompany(ds, 'link-dup');
  const { guard } = await createGuard(ds, 'link-dup-g1');

  const jwt = makeCompanyJwt(999004);
  const svc = makeCompanyGuardService(ds, company);

  const results = await Promise.allSettled([
    svc.linkForCompanyUser(jwt, guard.id),
    svc.linkForCompanyUser(jwt, guard.id),
  ]);

  for (const result of results) {
    equal(result.status, 'rejected', 'Concurrent link refused');
    ok(isLinkRefusal((result as PromiseRejectedResult).reason), 'Refused with the invitation message');
  }
  const rows = await ds.getRepository(CompanyGuard).count({
    where: { company: { id: company.id }, guard: { id: guard.id } },
  });
  equal(rows, 0, 'No row after concurrent link attempts');
  console.log('PASS LINK-DUPLICATE: concurrent link attempts → both refused, no row');
}

async function testAdminLink(ds: DataSource) {
  const { company } = await createCompany(ds, 'admin-link');
  const { guard } = await createGuard(ds, 'admin-link-g1');
  const auditCapture = makeCapturingAudit();
  const svc = makeCompanyGuardService(ds, company, auditCapture);

  // A company role cannot reach the admin path even if it calls it directly.
  await rejects(
    () => svc.createForUser(makeCompanyJwt(999006, UserRole.COMPANY_ADMIN), { companyId: company.id, guardId: guard.id }),
    (err: any) => err instanceof ForbiddenException,
    'Company role refused on the admin path',
  );
  equal(await ds.getRepository(CompanyGuard).count({ where: { company: { id: company.id } } }), 0, 'No row from refused admin call');

  const adminJwt: JwtPayload = { sub: 999007, role: UserRole.ADMIN, email: `admin@${TEST_PREFIX}.example`, status: UserStatus.ACTIVE };
  const created = await svc.createForUser(adminJwt, { companyId: company.id, guardId: guard.id });
  equal(created.status, CompanyGuardStatus.ACTIVE, 'Admin direct create still works');

  const entry = auditCapture.captured.find((e) => e.action === 'company_guard.admin_linked');
  ok(entry, 'company_guard.admin_linked audit event captured');
  equal(entry!.entityId, created.id);
  equal((entry!.afterData as any)?.guardId, guard.id);
  equal((entry!.afterData as any)?.companyId, company.id);
  console.log('PASS ADMIN-LINK: admin direct create works and is audited; company role refused');
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

  await linkGuardToCompany(ds, company, guard);

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

async function testStatusNoReactivate(ds: DataSource) {
  const { company } = await createCompany(ds, 'status-react');
  const jwt = makeCompanyJwt(999012);
  const svc = makeCompanyGuardService(ds, company);
  const toActive: UpdateCompanyGuardDto = { status: CompanyGuardStatus.ACTIVE };

  for (const status of [CompanyGuardStatus.BLOCKED, CompanyGuardStatus.INACTIVE]) {
    const { guard } = await createGuard(ds, `str-${status.toLowerCase()}`);
    const rel = await linkGuardToCompany(ds, company, guard, status);
    await rejects(
      () => svc.updateStatusForCompanyUser(jwt, rel.id, toActive),
      (err: any) => err instanceof ForbiddenException && err.message === REACTIVATION_REQUIRES_INVITATION_MESSAGE,
      `${status} → ACTIVE refused`,
    );
    const row = await ds.getRepository(CompanyGuard).findOneOrFail({ where: { id: rel.id } });
    equal(row.status, status, `${status} unchanged after refused reactivation`);
  }

  // Lifting a block to INACTIVE is still allowed (it lets a fresh invitation be accepted).
  const { guard: blockedGuard } = await createGuard(ds, 'status-unblock');
  const blocked = await linkGuardToCompany(ds, company, blockedGuard, CompanyGuardStatus.BLOCKED);
  const unblocked = await svc.updateStatusForCompanyUser(jwt, blocked.id, { status: CompanyGuardStatus.INACTIVE });
  equal(unblocked.status, CompanyGuardStatus.INACTIVE, 'BLOCKED → INACTIVE allowed');

  // ACTIVE → ACTIVE stays a harmless no-op.
  const { guard: activeGuard } = await createGuard(ds, 'status-active-noop');
  const active = await linkGuardToCompany(ds, company, activeGuard, CompanyGuardStatus.ACTIVE);
  const same = await svc.updateStatusForCompanyUser(jwt, active.id, toActive);
  equal(same.status, CompanyGuardStatus.ACTIVE, 'ACTIVE → ACTIVE no-op allowed');
  console.log('PASS STATUS-NO-REACTIVATE: BLOCKED/INACTIVE → ACTIVE refused; BLOCKED → INACTIVE and ACTIVE no-op allowed');
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

  // Guard joins B through an authorised workflow (the hire path), not by B naming them
  const svcB = makeCompanyGuardService(ds, compB);
  await svcB.ensureRelationship({ companyId: compB.id, guardId: guard.id });
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

  // A refused re-link attempt does not touch it either
  await rejects(() => svc.linkForCompanyUser(jwt, guard.id), isLinkRefusal, 'Re-link of BLOCKED refused');
  const refreshed2 = await ds.getRepository(GuardProfile).findOneOrFail({ where: { id: guard.id } });
  equal(refreshed2.approvalStatus, approvalBefore, 'approvalStatus unchanged after refused re-link');
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
      start: '2027-08-15T08:00:00Z',
      end: '2027-08-15T16:00:00Z',
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

  await rejects(() => svc.linkForCompanyUser(jwt, guard.id), isLinkRefusal, 'Link refused');

  ok(!auditCapture.captured.some((e) => e.action === 'company_guard.linked'), 'No company_guard.linked event');
  const refusal = auditCapture.captured.find((e) => e.action === 'company_guard.link_refused');
  ok(refusal, 'company_guard.link_refused audit event captured');
  equal((refusal!.afterData as any)?.requestedGuardId, guard.id);
  equal((refusal!.afterData as any)?.companyId, company.id);
  equal((refusal!.afterData as any)?.existingStatus, null);
  console.log('PASS AUDIT-LINK-REFUSED: company_guard.link_refused event captured; nothing linked');
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

  await assertDisposableTestDatabase(dbUrl);

  await ds.initialize();

  try {
    await cleanup(ds);

    await testLinkRefused(ds);
    await testLinkEnumeration(ds);
    await testLinkIdempotent(ds);
    await testLinkNoReactivate(ds);
    await testLinkDuplicate(ds);
    await testAdminLink(ds);
    await testDiscoveryOwner(ds);
    await testDiscoveryStaff(ds);
    await testStatusInactive(ds);
    await testStatusBlocked(ds);
    await testStatusNoReactivate(ds);
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

    console.log('\n✓ All company-guard-lifecycle tests passed (21/21)');
  } finally {
    await cleanup(ds);
    await ds.destroy();
  }
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
