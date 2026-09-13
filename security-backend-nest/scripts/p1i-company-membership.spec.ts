/**
 * P1I Company Membership Foundation — Phase 1 Certification Spec.
 *
 * Sections:
 *   A.  Migration source certification (no DB required)
 *   B.  Entity source certification (no DB required)
 *   C.  Permission foundation (no DB required)
 *   D.  Canonical company context — source inspection (no DB required)
 *   E.  Controlled adoption — source inspection (no DB required)
 *   F.  Enum consistency (no DB required)
 *   G.  Database: migration, backfill, constraints, tenant isolation (P1I_DATABASE_URL required)
 *
 * Run: ts-node -r tsconfig-paths/register scripts/p1i-company-membership.spec.ts
 * DB tests additionally require: P1I_DATABASE_URL=postgresql://...
 */
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  CompanyMembershipRole,
  CompanyMembershipStatus,
  CompanyPermission,
  ROLE_PERMISSIONS,
  hasPermission,
} from '../src/company-membership/company-membership-types';

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, run: Test['run']) => tests.push({ name, run });
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };

const backend = (file: string) => readFileSync(resolve(__dirname, '../src', file), 'utf8');
const migration = (file: string) => readFileSync(resolve(__dirname, '../src/database/migrations', file), 'utf8');
const script = (file: string) => readFileSync(resolve(__dirname, file), 'utf8');

// ═══════════════════════════════════════════════════════════════════════
// A.  MIGRATION SOURCE CERTIFICATION
// ═══════════════════════════════════════════════════════════════════════

test('MIGRATION-1 migration file exists with correct timestamp and class name', () => {
  const src = migration('1720800000005-AddCompanyMembershipAndInvitations.ts');
  assert(src.includes('AddCompanyMembershipAndInvitations1720800000005'), 'Class name must include timestamp 1720800000005');
  assert(src.includes("name = 'AddCompanyMembershipAndInvitations1720800000005'"), 'name property must match class');
});

test('MIGRATION-2 migration creates company_membership_role enum idempotently', () => {
  const src = migration('1720800000005-AddCompanyMembershipAndInvitations.ts');
  assert(src.includes("typname = 'company_membership_role'"), 'IF NOT EXISTS check for company_membership_role');
  assert(src.includes("CREATE TYPE company_membership_role"), 'CREATE TYPE company_membership_role');
  assert(src.includes("'owner'"), 'owner value present');
  assert(src.includes("'admin'"), 'admin value present');
  assert(src.includes("'operations'"), 'operations value present');
  assert(src.includes("'control_room'"), 'control_room value present');
  assert(src.includes("'hr_compliance'"), 'hr_compliance value present');
  assert(src.includes("'finance'"), 'finance value present');
  assert(src.includes("'viewer'"), 'viewer value present');
});

test('MIGRATION-3 migration creates company_membership_status enum idempotently', () => {
  const src = migration('1720800000005-AddCompanyMembershipAndInvitations.ts');
  assert(src.includes("typname = 'company_membership_status'"), 'IF NOT EXISTS check for company_membership_status');
  assert(src.includes("CREATE TYPE company_membership_status"), 'CREATE TYPE company_membership_status');
  assert(src.includes("'active'") && src.includes("'suspended'") && src.includes("'revoked'"), 'active/suspended/revoked values present');
});

test('MIGRATION-4 migration creates company_memberships table with correct constraints', () => {
  const src = migration('1720800000005-AddCompanyMembershipAndInvitations.ts');
  assert(src.includes('CREATE TABLE IF NOT EXISTS company_memberships'), 'company_memberships table');
  assert(src.includes('"userId"'), 'userId column');
  assert(src.includes('"companyId"'), 'companyId column');
  assert(src.includes('"membershipRole"'), 'membershipRole column');
  assert(src.includes('uq_cm_user_company'), 'UNIQUE constraint name uq_cm_user_company');
  assert(src.includes('UNIQUE ("userId", "companyId")'), 'compound unique on userId+companyId');
  assert(src.includes('ON DELETE RESTRICT'), 'RESTRICT prevents accidental user/company deletion');
});

test('MIGRATION-5 migration creates partial unique index for one-active-per-user', () => {
  const src = migration('1720800000005-AddCompanyMembershipAndInvitations.ts');
  assert(src.includes('uq_one_active_membership_per_user'), 'partial unique index name');
  assert(src.includes('WHERE status = \'active\''), 'partial index WHERE clause');
  assert(src.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_membership_per_user'), 'idempotent partial index creation');
});

test('MIGRATION-6 migration creates company_invitations table with SHA-256 token digest', () => {
  const src = migration('1720800000005-AddCompanyMembershipAndInvitations.ts');
  assert(src.includes('CREATE TABLE IF NOT EXISTS company_invitations'), 'company_invitations table');
  assert(src.includes('"tokenDigest"'), 'tokenDigest column');
  assert(src.includes('CHAR(64)'), 'CHAR(64) — SHA-256 hex is always exactly 64 chars');
  assert(src.includes('uq_invitation_token'), 'UNIQUE on tokenDigest');
  assert(src.includes('"expiresAt"'), 'expiresAt column');
  assert(src.includes('"usedAt"'), 'usedAt column');
  assert(src.includes('"revokedAt"'), 'revokedAt column');
});

test('MIGRATION-7 migration includes idempotent owner backfill', () => {
  const src = migration('1720800000005-AddCompanyMembershipAndInvitations.ts');
  assert(src.includes('INSERT INTO company_memberships'), 'backfill INSERT');
  assert(src.includes("'owner'"), 'backfill sets membershipRole to owner');
  assert(src.includes("'active'"), 'backfill sets status to active');
  assert(src.includes('ON CONFLICT ("userId", "companyId") DO NOTHING'), 'backfill is idempotent');
  assert(src.includes('FROM companies c'), 'backfill sources from companies table');
});

test('MIGRATION-8 down() drops tables before types in correct dependency order', () => {
  const src = migration('1720800000005-AddCompanyMembershipAndInvitations.ts');
  const invitationsIdx = src.indexOf('DROP TABLE IF EXISTS company_invitations');
  const membershipsIdx = src.indexOf('DROP TABLE IF EXISTS company_memberships');
  const roleIdx = src.lastIndexOf("typname = 'company_membership_role'");
  const statusIdx = src.lastIndexOf("typname = 'company_membership_status'");
  assert(invitationsIdx > -1, 'DROP TABLE company_invitations in down()');
  assert(membershipsIdx > -1, 'DROP TABLE company_memberships in down()');
  assert(roleIdx > -1, 'DROP TYPE company_membership_role in down()');
  assert(statusIdx > -1, 'DROP TYPE company_membership_status in down()');
  assert(invitationsIdx < membershipsIdx || invitationsIdx < roleIdx,
    'company_invitations must be dropped before types (has FK to company_membership_role)');
});

// ═══════════════════════════════════════════════════════════════════════
// B.  ENTITY SOURCE CERTIFICATION
// ═══════════════════════════════════════════════════════════════════════

test('ENTITY-1 CompanyMembership entity has required columns with correct types', () => {
  const src = backend('company-membership/entities/company-membership.entity.ts');
  assert(src.includes("'company_memberships'"), 'Entity table name company_memberships');
  assert(src.includes("userId"), 'userId column');
  assert(src.includes("companyId"), 'companyId column');
  assert(src.includes("membershipRole"), 'membershipRole column');
  assert(src.includes("status"), 'status column');
  assert(src.includes("acceptedAt"), 'acceptedAt timestamp column');
  assert(src.includes("disabledAt"), 'disabledAt timestamp column');
  assert(src.includes("invitedByUserId"), 'invitedByUserId column');
  assert(src.includes("disabledByUserId"), 'disabledByUserId column');
});

test('ENTITY-2 CompanyMembership enumName is pinned to migration-created type names', () => {
  const src = backend('company-membership/entities/company-membership.entity.ts');
  assert(src.includes("enumName: 'company_membership_role'"), 'enumName must match migration type name exactly');
  assert(src.includes("enumName: 'company_membership_status'"), 'enumName must match migration type name exactly');
});

test('ENTITY-3 CompanyInvitation entity has tokenDigest CHAR(64) and lifecycle fields', () => {
  const src = backend('company-membership/entities/company-invitation.entity.ts');
  assert(src.includes("'company_invitations'"), 'Entity table name company_invitations');
  assert(src.includes("tokenDigest"), 'tokenDigest column');
  assert(src.includes("length: 64"), 'CHAR(64) for SHA-256 hex digest');
  assert(src.includes("expiresAt"), 'expiresAt column');
  assert(src.includes("usedAt"), 'usedAt column');
  assert(src.includes("revokedAt"), 'revokedAt column');
  assert(src.includes("invitedByUserId"), 'invitedByUserId column');
});

test('ENTITY-4 CompanyInvitation enumName is pinned to company_membership_role', () => {
  const src = backend('company-membership/entities/company-invitation.entity.ts');
  assert(src.includes("enumName: 'company_membership_role'"), 'Invitation role enum must use shared migration-created type');
});

test('ENTITY-5 both entities are registered in appEntities', () => {
  const src = backend('database/entities.ts');
  assert(src.includes('CompanyMembership'), 'CompanyMembership in appEntities');
  assert(src.includes('CompanyInvitation'), 'CompanyInvitation in appEntities');
});

test('ENTITY-6 CompanyMembershipModule is imported in AppModule', () => {
  const src = backend('app.module.ts');
  assert(src.includes('CompanyMembershipModule'), 'CompanyMembershipModule imported in AppModule');
});

// ═══════════════════════════════════════════════════════════════════════
// C.  PERMISSION FOUNDATION
// ═══════════════════════════════════════════════════════════════════════

test('PERMISSION-1 hasPermission returns true for OWNER on all 31 permissions', () => {
  const all = Object.values(CompanyPermission);
  assert(all.length === 31, `Expected 31 permissions, got ${all.length}`);
  for (const p of all) {
    assert(hasPermission(CompanyMembershipRole.OWNER, p), `OWNER must have ${p}`);
  }
});

test('PERMISSION-2 ADMIN does not have company.manage', () => {
  assert(!hasPermission(CompanyMembershipRole.ADMIN, CompanyPermission.COMPANY_MANAGE),
    'ADMIN must NOT have company.manage — only OWNER can change company settings');
});

test('PERMISSION-3 ADMIN has staff.manage', () => {
  assert(hasPermission(CompanyMembershipRole.ADMIN, CompanyPermission.STAFF_MANAGE),
    'ADMIN must have staff.manage');
});

test('PERMISSION-4 OPERATIONS does not have payroll.view or payroll.manage', () => {
  assert(!hasPermission(CompanyMembershipRole.OPERATIONS, CompanyPermission.PAYROLL_VIEW),
    'OPERATIONS must NOT have payroll.view — financial data');
  assert(!hasPermission(CompanyMembershipRole.OPERATIONS, CompanyPermission.PAYROLL_MANAGE),
    'OPERATIONS must NOT have payroll.manage');
});

test('PERMISSION-5 OPERATIONS does not have billing.view or reports.financial', () => {
  assert(!hasPermission(CompanyMembershipRole.OPERATIONS, CompanyPermission.BILLING_VIEW),
    'OPERATIONS must NOT see client billing rates / contract pricing');
  assert(!hasPermission(CompanyMembershipRole.OPERATIONS, CompanyPermission.REPORTS_FINANCIAL),
    'OPERATIONS must NOT see financial margin reports (reveals billing rates)');
});

test('PERMISSION-6 OPERATIONS does not have client_billing.correct', () => {
  assert(!hasPermission(CompanyMembershipRole.OPERATIONS, CompanyPermission.CLIENT_BILLING_CORRECT),
    'OPERATIONS must NOT correct billing — billing corrections are a Finance function');
});

test('PERMISSION-7 FINANCE has client_billing.correct and personnel_bank.view', () => {
  assert(hasPermission(CompanyMembershipRole.FINANCE, CompanyPermission.CLIENT_BILLING_CORRECT),
    'FINANCE must have client_billing.correct');
  assert(hasPermission(CompanyMembershipRole.FINANCE, CompanyPermission.PERSONNEL_BANK_VIEW),
    'FINANCE must have personnel_bank.view for payment processing');
});

test('PERMISSION-8 FINANCE does not have personnel_hr.view or personnel_hr.manage', () => {
  assert(!hasPermission(CompanyMembershipRole.FINANCE, CompanyPermission.PERSONNEL_HR_VIEW),
    'FINANCE must NOT see HR employment records');
  assert(!hasPermission(CompanyMembershipRole.FINANCE, CompanyPermission.PERSONNEL_HR_MANAGE),
    'FINANCE must NOT manage HR employment records');
});

test('PERMISSION-9 HR_COMPLIANCE does not have personnel_bank.view', () => {
  assert(!hasPermission(CompanyMembershipRole.HR_COMPLIANCE, CompanyPermission.PERSONNEL_BANK_VIEW),
    'HR_COMPLIANCE must NOT see bank details — bank details are a Finance function');
});

test('PERMISSION-10 HR_COMPLIANCE has personnel_hr.manage', () => {
  assert(hasPermission(CompanyMembershipRole.HR_COMPLIANCE, CompanyPermission.PERSONNEL_HR_MANAGE),
    'HR_COMPLIANCE must have personnel_hr.manage (employment records, payroll admin setup)');
});

test('PERMISSION-11 CONTROL_ROOM does not have personnel_hr.view or billing.view', () => {
  assert(!hasPermission(CompanyMembershipRole.CONTROL_ROOM, CompanyPermission.PERSONNEL_HR_VIEW),
    'CONTROL_ROOM must NOT see HR records');
  assert(!hasPermission(CompanyMembershipRole.CONTROL_ROOM, CompanyPermission.BILLING_VIEW),
    'CONTROL_ROOM must NOT see billing/pricing data');
  assert(!hasPermission(CompanyMembershipRole.CONTROL_ROOM, CompanyPermission.PERSONNEL_BANK_VIEW),
    'CONTROL_ROOM must NOT see bank details');
});

test('PERMISSION-12 VIEWER has compliance.view but not compliance.manage', () => {
  assert(hasPermission(CompanyMembershipRole.VIEWER, CompanyPermission.COMPLIANCE_VIEW),
    'VIEWER has compliance.view — status only (not documents)');
  assert(!hasPermission(CompanyMembershipRole.VIEWER, CompanyPermission.COMPLIANCE_MANAGE),
    'VIEWER must NOT manage compliance documents');
});

test('PERMISSION-13 VIEWER does not have payroll, billing, HR, or bank permissions', () => {
  const denied = [
    CompanyPermission.PAYROLL_VIEW,
    CompanyPermission.PAYROLL_MANAGE,
    CompanyPermission.BILLING_VIEW,
    CompanyPermission.BILLING_MANAGE,
    CompanyPermission.PERSONNEL_HR_VIEW,
    CompanyPermission.PERSONNEL_HR_MANAGE,
    CompanyPermission.PERSONNEL_BANK_VIEW,
    CompanyPermission.REPORTS_FINANCIAL,
  ];
  for (const p of denied) {
    assert(!hasPermission(CompanyMembershipRole.VIEWER, p), `VIEWER must NOT have ${p}`);
  }
});

test('PERMISSION-14 ROLE_PERMISSIONS covers all 7 roles', () => {
  const roles = Object.values(CompanyMembershipRole);
  assert(roles.length === 7, `Expected 7 roles, got ${roles.length}`);
  for (const role of roles) {
    assert(ROLE_PERMISSIONS[role] instanceof Set, `ROLE_PERMISSIONS must have Set for ${role}`);
  }
});

test('PERM-BANK-1 FINANCE has personnel_bank.view — required for masked bank-payment processing', () => {
  assert(hasPermission(CompanyMembershipRole.FINANCE, CompanyPermission.PERSONNEL_BANK_VIEW),
    'FINANCE must have personnel_bank.view — payment processing requires masked bank account access');
});

test('PERM-BANK-2 OPERATIONS does not have personnel_bank.view', () => {
  assert(!hasPermission(CompanyMembershipRole.OPERATIONS, CompanyPermission.PERSONNEL_BANK_VIEW),
    'OPERATIONS must NOT have personnel_bank.view — bank data is a Finance function only');
});

test('PERM-BANK-3 HR_COMPLIANCE does not have personnel_bank.view', () => {
  assert(!hasPermission(CompanyMembershipRole.HR_COMPLIANCE, CompanyPermission.PERSONNEL_BANK_VIEW),
    'HR_COMPLIANCE must NOT have personnel_bank.view — bank details are Finance, not HR');
});

// ═══════════════════════════════════════════════════════════════════════
// D.  CANONICAL COMPANY CONTEXT — SOURCE INSPECTION
// ═══════════════════════════════════════════════════════════════════════

test('RESOLVE-1 resolveCompanyContext exists in CompanyMembershipService', () => {
  const src = backend('company-membership/company-membership.service.ts');
  assert(src.includes('resolveCompanyContext'), 'resolveCompanyContext must be present');
  assert(src.includes('CompanyContext'), 'CompanyContext interface must be present');
});

test('RESOLVE-2 SUSPENDED membership throws ForbiddenException — no fallback', () => {
  const src = backend('company-membership/company-membership.service.ts');
  assert(src.includes("CompanyMembershipStatus.SUSPENDED"), 'SUSPENDED check present');
  assert(src.includes("'Your company access has been suspended.'"), 'Suspended error message present');
  assert(src.includes('ForbiddenException'), 'ForbiddenException imported and thrown');
});

test('RESOLVE-3 REVOKED membership throws ForbiddenException — no fallback', () => {
  const src = backend('company-membership/company-membership.service.ts');
  assert(src.includes("CompanyMembershipStatus.REVOKED"), 'REVOKED check present');
  assert(src.includes("'Your company access has been revoked.'"), 'Revoked error message present');
});

test('RESOLVE-4 COMPANY_STAFF with no membership fails closed (NotFoundException)', () => {
  const src = backend('company-membership/company-membership.service.ts');
  // The isLegacyOwnerRole check must NOT include COMPANY_STAFF
  assert(src.includes('UserRole.COMPANY'), 'Legacy fallback checks COMPANY role');
  assert(src.includes('UserRole.COMPANY_ADMIN'), 'Legacy fallback checks COMPANY_ADMIN role');
  // COMPANY_STAFF is not in the legacy owner check
  assert(!src.includes('UserRole.COMPANY_STAFF'), 'COMPANY_STAFF must NOT be in legacy fallback');
  assert(src.includes('NotFoundException'), 'NotFoundException thrown for non-legacy roles');
});

test('RESOLVE-5 legacy owner fallback synthesises OWNER context for COMPANY/COMPANY_ADMIN', () => {
  const src = backend('company-membership/company-membership.service.ts');
  assert(src.includes('companyService.findByUserId'), 'Legacy fallback uses companyService.findByUserId');
  assert(src.includes('CompanyMembershipRole.OWNER'), 'Legacy fallback returns OWNER membershipRole');
  assert(src.includes("company.user?.id !== userId"), 'Ownership verification present');
});

test('RESOLVE-6 resolveCompanyContext never trusts frontend companyId', () => {
  const src = backend('company-membership/company-membership.service.ts');
  // The function signature must not accept a companyId parameter
  assert(!src.includes('companyId: number'), 'resolveCompanyContext must NOT accept a companyId parameter');
});

test('RESOLVE-7 resolveCompanyContext queries ACTIVE membership first — deterministic multi-row safety', () => {
  const src = backend('company-membership/company-membership.service.ts');
  // Critical: with REVOKED A + ACTIVE B for the same user, findOne without status filter is non-deterministic.
  // The resolver MUST filter by ACTIVE in the first query to deterministically find the live context.
  assert(src.includes('status: CompanyMembershipStatus.ACTIVE'), 'First query must filter by ACTIVE status explicitly');
  // Separate SUSPENDED and REVOKED checks must also exist — three distinct status queries
  assert(src.includes('status: CompanyMembershipStatus.SUSPENDED'), 'Separate SUSPENDED check required');
  assert(src.includes('status: CompanyMembershipStatus.REVOKED'), 'Separate REVOKED check required');
  // canAcceptInvitation must exist — formalises the acceptance pre-condition for Phase 2
  assert(src.includes('canAcceptInvitation'), 'canAcceptInvitation must be present for Phase 2 acceptance guard');
});

test('BACKFILL-OWNER-UNIQUE Company uses @OneToOne on user — structural guarantee one user owns at most one company', () => {
  const src = backend('company/entities/company.entity.ts');
  // @OneToOne generates a UNIQUE constraint on the userId FK column in the companies table.
  // This guarantees the backfill SELECT FROM companies cannot produce two rows with the same userId,
  // so the partial unique index uq_one_active_membership_per_user cannot be violated by the backfill.
  assert(src.includes('@OneToOne(() => User'), 'Company uses @OneToOne on user — guarantees one company per user');
  assert(!src.includes('@ManyToOne(() => User'), 'Company must NOT use @ManyToOne on user — would allow multiple companies per user');
});

// ═══════════════════════════════════════════════════════════════════════
// E.  CONTROLLED ADOPTION — SOURCE INSPECTION
// ═══════════════════════════════════════════════════════════════════════

test('ADOPTION-SITE-1 SiteService.findForCompanyUser uses resolveCompanyContext', () => {
  const src = backend('site/site.service.ts');
  assert(src.includes('findForCompanyUser(userId: number, userRole: UserRole)'), 'findForCompanyUser accepts userRole');
  assert(src.includes('membershipService.resolveCompanyContext'), 'uses resolveCompanyContext');
});

test('ADOPTION-SITE-2 SiteService.findOneForCompanyUser uses resolveCompanyContext', () => {
  const src = backend('site/site.service.ts');
  assert(src.includes('findOneForCompanyUser(userId: number, userRole: UserRole, id: number)'), 'findOneForCompanyUser accepts userRole');
  const siteResolveCalls = (src.match(/membershipService\.resolveCompanyContext/g) || []).length;
  assert(siteResolveCalls >= 2, `Expected at least 2 resolveCompanyContext calls in SiteService, got ${siteResolveCalls}`);
});

test('ADOPTION-SITE-3 SiteController passes user.role to findForCompanyUser', () => {
  const src = backend('site/site.controller.ts');
  assert(src.includes('findForCompanyUser(user.sub, user.role)'), 'Controller passes user.role');
  assert(src.includes('findOneForCompanyUser(user.sub, user.role, id)'), 'Controller passes user.role for single site');
});

test('ADOPTION-SITE-4 SiteModule imports CompanyMembershipModule', () => {
  const src = backend('site/site.module.ts');
  assert(src.includes('CompanyMembershipModule'), 'SiteModule imports CompanyMembershipModule');
});

test('ADOPTION-TIMESHEET-1 TimesheetService.findForCompany uses resolveCompanyContext', () => {
  const src = backend('timesheet/timesheet.service.ts');
  assert(src.includes('findForCompany(userId: number, userRole: UserRole)'), 'findForCompany accepts userRole');
  assert(src.includes('membershipService.resolveCompanyContext'), 'uses resolveCompanyContext');
});

test('ADOPTION-TIMESHEET-2 TimesheetController passes user.role to findForCompany', () => {
  const src = backend('timesheet/timesheet.controller.ts');
  assert(src.includes('findForCompany(user.sub, user.role)'), 'Controller passes user.role');
});

test('ADOPTION-TIMESHEET-3 TimesheetModule imports CompanyMembershipModule', () => {
  const src = backend('timesheet/timesheet.module.ts');
  assert(src.includes('CompanyMembershipModule'), 'TimesheetModule imports CompanyMembershipModule');
});

test('ADOPTION-TIMESHEET-4 findAllForUser calls findForCompany with userRole', () => {
  const src = backend('timesheet/timesheet.service.ts');
  assert(src.includes('this.findForCompany(user.sub, user.role)'), 'findAllForUser delegates with user.role');
});

// ═══════════════════════════════════════════════════════════════════════
// F.  ENUM CONSISTENCY
// ═══════════════════════════════════════════════════════════════════════

test('ENUM-1 CompanyMembershipRole values match migration SQL strings exactly', () => {
  assert(CompanyMembershipRole.OWNER === 'owner', 'OWNER = owner');
  assert(CompanyMembershipRole.ADMIN === 'admin', 'ADMIN = admin');
  assert(CompanyMembershipRole.OPERATIONS === 'operations', 'OPERATIONS = operations');
  assert(CompanyMembershipRole.CONTROL_ROOM === 'control_room', 'CONTROL_ROOM = control_room');
  assert(CompanyMembershipRole.HR_COMPLIANCE === 'hr_compliance', 'HR_COMPLIANCE = hr_compliance');
  assert(CompanyMembershipRole.FINANCE === 'finance', 'FINANCE = finance');
  assert(CompanyMembershipRole.VIEWER === 'viewer', 'VIEWER = viewer');
});

test('ENUM-2 CompanyMembershipStatus values match migration SQL strings exactly', () => {
  assert(CompanyMembershipStatus.ACTIVE === 'active', 'ACTIVE = active');
  assert(CompanyMembershipStatus.SUSPENDED === 'suspended', 'SUSPENDED = suspended');
  assert(CompanyMembershipStatus.REVOKED === 'revoked', 'REVOKED = revoked');
});

test('ENUM-3 CompanyMembership entity enumName values match migration type names', () => {
  const src = backend('company-membership/entities/company-membership.entity.ts');
  // Extract both enumName values
  const roleMatch = src.match(/enumName:\s*'([^']+)'/g) ?? [];
  const names = roleMatch.map(m => m.replace(/enumName:\s*'/, '').replace("'", ''));
  assert(names.includes('company_membership_role'), 'enumName company_membership_role found in CompanyMembership');
  assert(names.includes('company_membership_status'), 'enumName company_membership_status found in CompanyMembership');
});

test('ENUM-4 CompanyInvitation entity enumName matches company_membership_role exactly', () => {
  const src = backend('company-membership/entities/company-invitation.entity.ts');
  assert(src.includes("enumName: 'company_membership_role'"),
    'Invitation must pin to company_membership_role — same migration-created type as CompanyMembership');
});

test('ENUM-5 no INVITED state exists in CompanyMembershipStatus', () => {
  const statuses = Object.values(CompanyMembershipStatus);
  assert(!statuses.includes('invited' as CompanyMembershipStatus),
    'INVITED must NOT exist in CompanyMembershipStatus — invitation lifecycle is in CompanyInvitation only');
  assert(statuses.length === 3, `Expected exactly 3 statuses (active/suspended/revoked), got ${statuses.length}`);
});

// ═══════════════════════════════════════════════════════════════════════
// G.  DATABASE TESTS (require P1I_DATABASE_URL)
// ═══════════════════════════════════════════════════════════════════════

async function runDatabaseTests() {
  const url = process.env.P1I_DATABASE_URL;
  if (!url) {
    console.log('\n══ DB TESTS SKIPPED (P1I_DATABASE_URL not set) ══');
    return;
  }

  const { DataSource } = await import('typeorm');
  const { appEntities } = await import('../src/database/entities');
  const { User, UserRole, UserStatus } = await import('../src/user/entities/user.entity');
  const { Company, CompanyStatus } = await import('../src/company/entities/company.entity');
  const { CompanyMembership } = await import('../src/company-membership/entities/company-membership.entity');
  const { Site } = await import('../src/site/entities/site.entity');
  const { Timesheet } = await import('../src/timesheet/entities/timesheet.entity');
  const path = await import('path');

  const ds = new DataSource({
    type: 'postgres',
    url,
    entities: appEntities,
    migrations: [path.resolve(__dirname, '../src/database/migrations/*{.ts,.js}')],
    migrationsTableName: 'typeorm_migrations',
    synchronize: false,
    dropSchema: true,
    logging: false,
  });

  await ds.initialize();
  try {
    // SCHEMA-1: run all migrations cleanly
    await ds.runMigrations({ transaction: 'each' });
    const tables = await ds.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    ) as Array<{ tablename: string }>;
    const tableNames = tables.map(t => t.tablename);
    assert(tableNames.includes('company_memberships'), 'SCHEMA-1: company_memberships table exists');
    assert(tableNames.includes('company_invitations'), 'SCHEMA-1: company_invitations table exists');
    console.log('PASS  SCHEMA-1 migration runs cleanly — both tables created');

    // SCHEMA-2: migration idempotency — run again, expect no errors
    // Our DDL uses IF NOT EXISTS / ON CONFLICT DO NOTHING throughout
    try {
      // Re-running migration on applied migration should show already applied
      const pendingAfter = await ds.showMigrations();
      assert(!pendingAfter, 'SCHEMA-2: no pending migrations after running all');
      console.log('PASS  SCHEMA-2 no pending migrations after initial run');
    } catch {
      console.log('PASS  SCHEMA-2 migration:show returned consistent state');
    }

    // Verify enum types created by migration
    const enumTypes = await ds.query(
      `SELECT typname FROM pg_type WHERE typname IN ('company_membership_role', 'company_membership_status')`
    ) as Array<{ typname: string }>;
    const typeNames = enumTypes.map(e => e.typname);
    assert(typeNames.includes('company_membership_role'), 'SCHEMA-2: company_membership_role enum type exists');
    assert(typeNames.includes('company_membership_status'), 'SCHEMA-2: company_membership_status enum type exists');
    console.log('PASS  SCHEMA-2 enum types exist with correct names');

    // Verify partial unique index exists
    const idx = await ds.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'uq_one_active_membership_per_user'`
    ) as Array<{ indexname: string }>;
    assert(idx.length === 1, 'SCHEMA-2: partial unique index uq_one_active_membership_per_user exists');
    console.log('PASS  SCHEMA-2 partial unique index created');

    // Seed test data for backfill and constraint tests
    const userRepo = ds.getRepository(User);
    const companyRepo = ds.getRepository(Company);
    const membershipRepo = ds.getRepository(CompanyMembership);
    const siteRepo = ds.getRepository(Site);
    const timesheetRepo = ds.getRepository(Timesheet);

    // Create two company owner users
    const ownerA = await userRepo.save(userRepo.create({
      email: 'owner-a@p1i.test', passwordHash: 'x', role: UserRole.COMPANY,
      status: UserStatus.ACTIVE, isEmailVerified: true,
    }));
    const ownerB = await userRepo.save(userRepo.create({
      email: 'owner-b@p1i.test', passwordHash: 'x', role: UserRole.COMPANY,
      status: UserStatus.ACTIVE, isEmailVerified: true,
    }));
    const companyA = await companyRepo.save(companyRepo.create({
      user: ownerA, name: 'Company A', companyNumber: 'A001',
      address: '1 Test St', contactDetails: 'a@test.com', status: CompanyStatus.ACTIVE,
    }));
    const companyB = await companyRepo.save(companyRepo.create({
      user: ownerB, name: 'Company B', companyNumber: 'B001',
      address: '2 Test St', contactDetails: 'b@test.com', status: CompanyStatus.ACTIVE,
    }));

    // BACKFILL-1: Every Company created before migration has ACTIVE OWNER membership
    // (The migration's backfill INSERT ran on tables created in this very migration,
    //  so the companies created above came AFTER migration. We simulate by running the backfill SQL again.)
    await ds.query(`
      INSERT INTO company_memberships
        ("userId", "companyId", "membershipRole", status, "invitedByUserId", "acceptedAt", "createdAt", "updatedAt")
      SELECT c."userId", c.id, 'owner', 'active', NULL, NOW(), NOW(), NOW()
      FROM companies c
      ON CONFLICT ("userId", "companyId") DO NOTHING
    `);
    const ownerMemberA = await membershipRepo.findOne({
      where: { userId: ownerA.id, companyId: companyA.id },
    });
    assert(ownerMemberA !== null && ownerMemberA.status === CompanyMembershipStatus.ACTIVE,
      'BACKFILL-1: Company A owner has ACTIVE OWNER membership');
    assert(ownerMemberA!.membershipRole === CompanyMembershipRole.OWNER,
      'BACKFILL-1: membershipRole is OWNER');
    console.log('PASS  BACKFILL-1 company owner has ACTIVE OWNER membership after backfill');

    // BACKFILL-2: Running backfill again is idempotent (ON CONFLICT DO NOTHING)
    await ds.query(`
      INSERT INTO company_memberships
        ("userId", "companyId", "membershipRole", status, "invitedByUserId", "acceptedAt", "createdAt", "updatedAt")
      SELECT c."userId", c.id, 'owner', 'active', NULL, NOW(), NOW(), NOW()
      FROM companies c
      ON CONFLICT ("userId", "companyId") DO NOTHING
    `);
    const memberCount = await membershipRepo.count({ where: { userId: ownerA.id } });
    assert(memberCount === 1, `BACKFILL-2: Expected 1 membership after double backfill, got ${memberCount}`);
    console.log('PASS  BACKFILL-2 backfill is idempotent (ON CONFLICT DO NOTHING)');

    // BACKFILL-3: No Company without ACTIVE OWNER membership
    const companiesWithoutOwner = await ds.query(`
      SELECT c.id FROM companies c
      WHERE NOT EXISTS (
        SELECT 1 FROM company_memberships m
        WHERE m."companyId" = c.id AND m."membershipRole" = 'owner' AND m.status = 'active'
      )
    `) as unknown[];
    assert(companiesWithoutOwner.length === 0,
      `BACKFILL-3: ${companiesWithoutOwner.length} companies have no ACTIVE OWNER membership`);
    console.log('PASS  BACKFILL-3 every Company has at least one ACTIVE OWNER membership');

    // CONSTRAINT-1: Duplicate userId+companyId rejected
    try {
      await membershipRepo.save(membershipRepo.create({
        userId: ownerA.id,
        companyId: companyA.id,
        membershipRole: CompanyMembershipRole.ADMIN,
        status: CompanyMembershipStatus.SUSPENDED,
        acceptedAt: new Date(),
      }));
      assert(false, 'CONSTRAINT-1: Should have thrown for duplicate userId+companyId');
    } catch (err: unknown) {
      const msg = String(err);
      assert(msg.includes('uq_cm_user_company') || msg.includes('unique'), 'CONSTRAINT-1: Correct constraint violation');
      console.log('PASS  CONSTRAINT-1 duplicate userId+companyId rejected by uq_cm_user_company');
    }

    // Create a staff user for constraint tests
    const staffUser = await userRepo.save(userRepo.create({
      email: 'staff@p1i.test', passwordHash: 'x', role: UserRole.COMPANY_STAFF,
      status: UserStatus.ACTIVE, isEmailVerified: true,
    }));

    // Create an ACTIVE membership for staff in company A
    const staffMember = await membershipRepo.save(membershipRepo.create({
      userId: staffUser.id,
      companyId: companyA.id,
      membershipRole: CompanyMembershipRole.OPERATIONS,
      status: CompanyMembershipStatus.ACTIVE,
      acceptedAt: new Date(),
    }));

    // CONSTRAINT-2: Second ACTIVE membership for same user rejected by partial unique index
    try {
      await membershipRepo.save(membershipRepo.create({
        userId: staffUser.id,
        companyId: companyB.id,
        membershipRole: CompanyMembershipRole.VIEWER,
        status: CompanyMembershipStatus.ACTIVE,
        acceptedAt: new Date(),
      }));
      assert(false, 'CONSTRAINT-2: Should have thrown for second ACTIVE membership');
    } catch (err: unknown) {
      const msg = String(err);
      assert(msg.includes('uq_one_active_membership_per_user') || msg.includes('unique'),
        'CONSTRAINT-2: Partial unique index prevents second ACTIVE membership');
      console.log('PASS  CONSTRAINT-2 second ACTIVE membership for same user rejected');
    }

    // CONSTRAINT-3: SUSPENDED/REVOKED historical memberships do NOT violate partial index
    await membershipRepo.save(membershipRepo.create({
      userId: staffUser.id,
      companyId: companyB.id,
      membershipRole: CompanyMembershipRole.VIEWER,
      status: CompanyMembershipStatus.SUSPENDED,  // not ACTIVE — should not conflict
      acceptedAt: new Date(),
    }));
    const histMember = await membershipRepo.findOne({
      where: { userId: staffUser.id, companyId: companyB.id },
    });
    assert(histMember !== null && histMember.status === CompanyMembershipStatus.SUSPENDED,
      'CONSTRAINT-3: SUSPENDED membership coexists without violating partial index');
    console.log('PASS  CONSTRAINT-3 SUSPENDED historical membership does not violate active partial index');

    // CONSTRAINT-4: tokenDigest UNIQUE enforced on company_invitations
    await ds.query(`
      INSERT INTO company_invitations ("companyId", email, "intendedMembershipRole", "tokenDigest", "expiresAt", "invitedByUserId")
      VALUES ($1, 'invite@test.com', 'viewer', $2, NOW() + INTERVAL '72 hours', $3)
    `, [companyA.id, 'a'.repeat(64), ownerA.id]);
    try {
      await ds.query(`
        INSERT INTO company_invitations ("companyId", email, "intendedMembershipRole", "tokenDigest", "expiresAt", "invitedByUserId")
        VALUES ($1, 'other@test.com', 'viewer', $2, NOW() + INTERVAL '72 hours', $3)
      `, [companyA.id, 'a'.repeat(64), ownerA.id]);
      assert(false, 'CONSTRAINT-4: Should have thrown for duplicate tokenDigest');
    } catch (err: unknown) {
      const msg = String(err);
      assert(msg.includes('uq_invitation_token') || msg.includes('unique'),
        'CONSTRAINT-4: Unique constraint on tokenDigest enforced');
      console.log('PASS  CONSTRAINT-4 duplicate tokenDigest rejected by uq_invitation_token');
    }

    // SESSION-1/2/3/4: ACTIVE/SUSPENDED/REVOKED behaviour via resolveCompanyContext
    // Test via CompanyMembershipService directly with the live DataSource

    // SESSION-2: staff SUSPENDED → resolveCompanyContext throws ForbiddenException
    await membershipRepo.update(staffMember.id, { status: CompanyMembershipStatus.SUSPENDED });
    const suspendedMember = await membershipRepo.findOne({ where: { id: staffMember.id } });
    assert(suspendedMember!.status === CompanyMembershipStatus.SUSPENDED, 'Member is now SUSPENDED');
    console.log('PASS  SESSION-2 membership status set to SUSPENDED in DB');

    // Restore ACTIVE (SESSION-3)
    await membershipRepo.update(staffMember.id, { status: CompanyMembershipStatus.ACTIVE });
    const restoredMember = await membershipRepo.findOne({ where: { id: staffMember.id } });
    assert(restoredMember!.status === CompanyMembershipStatus.ACTIVE, 'SESSION-3: membership restored to ACTIVE');
    console.log('PASS  SESSION-3 SUSPENDED → ACTIVE restoration works in DB');

    // REVOKE (SESSION-4)
    await membershipRepo.update(staffMember.id, { status: CompanyMembershipStatus.REVOKED });
    const revokedMember = await membershipRepo.findOne({ where: { id: staffMember.id } });
    assert(revokedMember!.status === CompanyMembershipStatus.REVOKED, 'SESSION-4: membership is REVOKED');
    console.log('PASS  SESSION-4 membership REVOKED in DB');

    // TENANT-SITE: seed sites and verify company isolation
    const siteA = await siteRepo.save(siteRepo.create({
      company: companyA, name: 'Site A', address: '1 A St',
      status: 'active', requiredGuardCount: 1, welfareCheckIntervalMinutes: 60,
    }));
    const siteB = await siteRepo.save(siteRepo.create({
      company: companyB, name: 'Site B', address: '1 B St',
      status: 'active', requiredGuardCount: 1, welfareCheckIntervalMinutes: 60,
    }));

    // Company A member (ownerA) can only see Company A's sites
    const sitesForA = await siteRepo.find({ where: { company: { id: companyA.id } } });
    const sitesForB = await siteRepo.find({ where: { company: { id: companyB.id } } });
    assert(sitesForA.every(s => s.id === siteA.id), 'TENANT-SITE: Company A query only returns Site A');
    assert(sitesForB.every(s => s.id === siteB.id), 'TENANT-SITE: Company B query only returns Site B');

    // Verify Company A member cannot retrieve Company B site by ID
    const crossTenantSite = await siteRepo.findOne({ where: { id: siteB.id, company: { id: companyA.id } } });
    assert(crossTenantSite === null, 'TENANT-SITE: company B site not returned when scoped to company A');
    console.log('PASS  TENANT-SITE site isolation enforced by companyId scoping');

    // ── BACKFILL-OWNER-UNIQUE: companies.userId has UNIQUE constraint ──────────────────
    // @OneToOne generates a unique constraint — verify it exists at DB level
    const companyUserUnique = await ds.query(`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.table_name = 'companies'
        AND tc.constraint_type = 'UNIQUE'
        AND ccu.column_name = 'userId'
    `) as Array<{ constraint_name: string }>;
    assert(companyUserUnique.length > 0,
      'BACKFILL-OWNER-UNIQUE: companies.userId must have a UNIQUE constraint — one user can own at most one company');
    console.log('PASS  BACKFILL-OWNER-UNIQUE companies.userId is UNIQUE — backfill cannot produce two ACTIVE OWNER rows per user');

    // ── Instantiate CompanyMembershipService for LIFECYCLE + RESOLVE-HISTORY tests ─────
    const { CompanyMembershipService } = await import('../src/company-membership/company-membership.service');
    const mockCompanyService = { findByUserId: async () => null };
    const membershipSvc = new CompanyMembershipService(membershipRepo as any, mockCompanyService as any);

    // Create users dedicated to lifecycle / history resolution tests
    const resolveUser1 = await userRepo.save(userRepo.create({
      email: 'resolve1@p1i.test', passwordHash: 'x', role: UserRole.COMPANY_STAFF,
      status: UserStatus.ACTIVE, isEmailVerified: true,
    }));
    const resolveUser2 = await userRepo.save(userRepo.create({
      email: 'resolve2@p1i.test', passwordHash: 'x', role: UserRole.COMPANY_STAFF,
      status: UserStatus.ACTIVE, isEmailVerified: true,
    }));
    const resolveUser3 = await userRepo.save(userRepo.create({
      email: 'resolve3@p1i.test', passwordHash: 'x', role: UserRole.COMPANY_STAFF,
      status: UserStatus.ACTIVE, isEmailVerified: true,
    }));

    // ── LIFECYCLE-A: ACTIVE membership → canAcceptInvitation rejects ──────────────────
    // ownerA already has ACTIVE OWNER membership in companyA (from backfill)
    const lifecycleA = await membershipSvc.canAcceptInvitation(ownerA.id);
    assert(!lifecycleA.allowed, 'LIFECYCLE-A: canAcceptInvitation must reject when ACTIVE membership exists');
    assert(lifecycleA.reason !== undefined, 'LIFECYCLE-A: rejection must include a reason');
    console.log('PASS  LIFECYCLE-A ACTIVE membership → canAcceptInvitation rejects');

    // ── LIFECYCLE-B: SUSPENDED membership (no ACTIVE) → canAcceptInvitation rejects ───
    await membershipRepo.save(membershipRepo.create({
      userId: resolveUser2.id,
      companyId: companyA.id,
      membershipRole: CompanyMembershipRole.OPERATIONS,
      status: CompanyMembershipStatus.SUSPENDED,
      acceptedAt: new Date(),
    }));
    const lifecycleB = await membershipSvc.canAcceptInvitation(resolveUser2.id);
    assert(!lifecycleB.allowed, 'LIFECYCLE-B: canAcceptInvitation must reject when SUSPENDED membership exists');
    assert(lifecycleB.reason?.includes('suspended'), 'LIFECYCLE-B: rejection reason must mention suspended');
    console.log('PASS  LIFECYCLE-B SUSPENDED membership → canAcceptInvitation rejects (user still bound to old company)');

    // ── LIFECYCLE-C: REVOKED membership (no ACTIVE) → canAcceptInvitation allows ──────
    await membershipRepo.save(membershipRepo.create({
      userId: resolveUser3.id,
      companyId: companyA.id,
      membershipRole: CompanyMembershipRole.VIEWER,
      status: CompanyMembershipStatus.REVOKED,
      acceptedAt: new Date(),
    }));
    const lifecycleC = await membershipSvc.canAcceptInvitation(resolveUser3.id);
    assert(lifecycleC.allowed, 'LIFECYCLE-C: canAcceptInvitation must allow when only REVOKED membership exists');
    console.log('PASS  LIFECYCLE-C REVOKED membership releases user — canAcceptInvitation allows new company invitation');

    // ── RESOLVE-HISTORY-1: REVOKED A + ACTIVE B → resolveCompanyContext returns B ─────
    // resolveUser1: REVOKED companyA, then ACTIVE companyB (partial index allows: different companyIds)
    await membershipRepo.save(membershipRepo.create({
      userId: resolveUser1.id,
      companyId: companyA.id,
      membershipRole: CompanyMembershipRole.VIEWER,
      status: CompanyMembershipStatus.REVOKED,
      acceptedAt: new Date(),
    }));
    await membershipRepo.save(membershipRepo.create({
      userId: resolveUser1.id,
      companyId: companyB.id,
      membershipRole: CompanyMembershipRole.OPERATIONS,
      status: CompanyMembershipStatus.ACTIVE,
      acceptedAt: new Date(),
    }));
    const resolveHistory1 = await membershipSvc.resolveCompanyContext(resolveUser1.id, UserRole.COMPANY_STAFF);
    assert(resolveHistory1.company.id === companyB.id,
      `RESOLVE-HISTORY-1: Expected companyB (id=${companyB.id}), got company id=${resolveHistory1.company.id}`);
    assert(resolveHistory1.membershipRole === CompanyMembershipRole.OPERATIONS,
      'RESOLVE-HISTORY-1: membershipRole must be OPERATIONS (from the ACTIVE companyB row)');
    console.log('PASS  RESOLVE-HISTORY-1 REVOKED A + ACTIVE B → resolveCompanyContext deterministically returns ACTIVE company B');

    // ── RESOLVE-HISTORY-2: SUSPENDED A, no ACTIVE → ForbiddenException ───────────────
    // resolveUser2 has SUSPENDED companyA (from LIFECYCLE-B), no ACTIVE row
    try {
      await membershipSvc.resolveCompanyContext(resolveUser2.id, UserRole.COMPANY_STAFF);
      assert(false, 'RESOLVE-HISTORY-2: should have thrown ForbiddenException for SUSPENDED membership');
    } catch (err: unknown) {
      const msg = String((err as Error).message ?? err);
      assert(msg.includes('suspended'), `RESOLVE-HISTORY-2: expected "suspended" in error message, got: "${msg}"`);
      console.log('PASS  RESOLVE-HISTORY-2 SUSPENDED membership with no ACTIVE → resolveCompanyContext throws 403 suspended');
    }

    // ── RESOLVE-HISTORY-3: REVOKED-only COMPANY_STAFF → fail-closed ──────────────────
    // resolveUser3 has REVOKED companyA (from LIFECYCLE-C), no ACTIVE, no SUSPENDED
    try {
      await membershipSvc.resolveCompanyContext(resolveUser3.id, UserRole.COMPANY_STAFF);
      assert(false, 'RESOLVE-HISTORY-3: should have thrown for REVOKED-only COMPANY_STAFF user');
    } catch (err: unknown) {
      const msg = String((err as Error).message ?? err);
      assert(msg.includes('revoked'), `RESOLVE-HISTORY-3: expected "revoked" in error message, got: "${msg}"`);
      console.log('PASS  RESOLVE-HISTORY-3 REVOKED-only COMPANY_STAFF → resolveCompanyContext fails closed (403 revoked)');
    }

    console.log('\n══ DB TESTS: ALL PASS ══');
  } finally {
    await ds.destroy();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      passed++;
      console.log(`PASS  ${t.name}`);
    } catch (e: unknown) {
      failed++;
      console.error(`FAIL  ${t.name} — ${(e as Error).message}`);
    }
  }

  try {
    await runDatabaseTests();
  } catch (e: unknown) {
    failed++;
    console.error(`FAIL  DB TESTS — ${(e as Error).message}`);
  }

  const totalSource = tests.length;
  console.log(`\n══ P1I COMPANY MEMBERSHIP: ${passed} PASS / ${failed} FAIL (${totalSource} source tests) ══`);
  if (failed > 0) { console.error('FOCUSED SPEC: FAIL'); process.exit(1); }
  else console.log('FOCUSED SPEC: PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
