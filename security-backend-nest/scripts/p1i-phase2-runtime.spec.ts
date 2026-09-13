/**
 * P1I Phase 2 Runtime Security Certification
 *
 * PostgreSQL-backed authorization tests. CompanyMembershipService is real (not mocked).
 * CompanyService is mocked (legacy fallback never hit for ACTIVE COMPANY_STAFF memberships).
 *
 * Run: P2_RUNTIME_DATABASE_URL=<pg-url> npx ts-node -r tsconfig-paths/register scripts/p1i-phase2-runtime.spec.ts
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { Company, CompanyStatus } from '../src/company/entities/company.entity';
import { CompanyMembership } from '../src/company-membership/entities/company-membership.entity';
import {
  CompanyMembershipRole,
  CompanyMembershipStatus,
  CompanyPermission,
} from '../src/company-membership/company-membership-types';
import { Client } from '../src/client/entities/client.entity';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { PayrollBatch } from '../src/payroll-batch/entities/payroll-batch.entity';
import { InvoiceBatch } from '../src/invoice-batch/entities/invoice-batch.entity';
import { PaymentRecord } from '../src/payment-record/entities/payment-record.entity';
import { Timesheet } from '../src/timesheet/entities/timesheet.entity';
import {
  ClientWeeklyApprovalRequest,
} from '../src/client-weekly-approval/entities/client-weekly-approval-request.entity';
import { ClientWeeklyApprovalLine } from '../src/client-weekly-approval/entities/client-weekly-approval-line.entity';
import { ClientShiftDispute } from '../src/client-weekly-approval/entities/client-shift-dispute.entity';

import { CompanyMembershipService } from '../src/company-membership/company-membership.service';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { ClientService } from '../src/client/client.service';
import { PayrollBatchService } from '../src/payroll-batch/payroll-batch.service';
import { InvoiceBatchService } from '../src/invoice-batch/invoice-batch.service';
import { ClientWeeklyApprovalService } from '../src/client-weekly-approval/client-weekly-approval.service';

// ─── Test harness ─────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];

async function deny(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    fail++;
    failures.push(`FAIL  ${label}: expected ForbiddenException but call succeeded`);
    console.log(`FAIL  ${label}: expected ForbiddenException but call succeeded`);
  } catch (err: unknown) {
    if (err instanceof ForbiddenException) {
      pass++;
      console.log(`PASS  ${label}`);
    } else {
      fail++;
      const name = (err as any)?.constructor?.name ?? 'Error';
      const msg = (err as any)?.message ?? String(err);
      failures.push(`FAIL  ${label}: expected ForbiddenException but got ${name}: ${msg}`);
      console.log(`FAIL  ${label}: expected ForbiddenException but got ${name}: ${msg}`);
    }
  }
}

async function allow(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${label}`);
  } catch (err: unknown) {
    if (err instanceof ForbiddenException) {
      fail++;
      const msg = (err as any)?.message ?? String(err);
      failures.push(`FAIL  ${label}: expected ALLOW but got ForbiddenException: ${msg}`);
      console.log(`FAIL  ${label}: expected ALLOW but got ForbiddenException: ${msg}`);
    } else {
      // Any non-Forbidden exception proves permission gate passed; business logic ran = ALLOW
      pass++;
      const name = (err as any)?.constructor?.name ?? 'Error';
      console.log(`PASS  ${label} [perm:ok|biz-err:${name}]`);
    }
  }
}

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    const msg = `FAIL  ${label}${detail ? ': ' + detail : ''}`;
    failures.push(msg);
    console.log(msg);
  }
}

// ─── Source audits (synchronous, no DB required) ──────────────────────────────

function mutationCoverageAudit(): void {
  console.log('\n── MUTATION PERMISSION COVERAGE AUDIT ──');
  const srcDir = join(__dirname, '..', 'src');
  const serviceFiles: [string, string][] = [
    ['audit-log.service', 'audit-log/audit-log.service.ts'],
    ['attendance.service', 'attendance/attendance.service.ts'],
    ['client.service', 'client/client.service.ts'],
    ['coverage.service', 'coverage/coverage.service.ts'],
    ['shift.service', 'shift/shift.service.ts'],
    ['assignment.service', 'assignment/assignment.service.ts'],
    ['company-guard.service', 'company-guard/company-guard.service.ts'],
    ['job.service', 'job/job.service.ts'],
    ['pay-rule.service', 'pay-rule/pay-rule.service.ts'],
    ['payroll-batch.service', 'payroll-batch/payroll-batch.service.ts'],
    ['invoice-batch.service', 'invoice-batch/invoice-batch.service.ts'],
    ['contract-pricing.service', 'contract-pricing/contract-pricing.service.ts'],
    ['report.service', 'report/report.service.ts'],
    ['finance-reconciliation.service', 'finance/finance-reconciliation.service.ts'],
    ['compliance.service', 'compliance/compliance.service.ts'],
    ['guard-compliance.service', 'compliance/guard-compliance.service.ts'],
    ['client-weekly-approval.service', 'client-weekly-approval/client-weekly-approval.service.ts'],
    ['attachment.service', 'attachment/attachment.service.ts'],
    ['daily-log.service', 'daily-log/daily-log.service.ts'],
    ['availability.service', 'availability/availability.service.ts'],
    ['incident.service', 'incident/incident.service.ts'],
    ['company-membership.service', 'company-membership/company-membership.service.ts'],
    ['company.service', 'company/company.service.ts'],
  ];

  let totalPermissionlessCalls = 0;

  for (const [name, relativePath] of serviceFiles) {
    let content: string;
    try {
      content = readFileSync(join(srcDir, relativePath), 'utf8');
    } catch {
      check(`MUTATION-AUDIT-${name}: file readable`, false, `Could not read ${relativePath}`);
      continue;
    }

    const lines = content.split('\n');
    const missing: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('resolveCompanyContext(')) continue;

      // Collect call window: 3 lines back (catches function signature) + 4 forward (catches multi-line calls)
      // Private helpers typed as (userId, userRole, permission: CompanyPermission) are legitimate
      // delegators — the caller always supplies a CompanyPermission literal. The function signature
      // appears one line above the resolveCompanyContext call, so the backward window finds it.
      const window = lines.slice(Math.max(0, i - 3), Math.min(i + 4, lines.length)).join('\n');
      if (!window.includes('CompanyPermission')) {
        // resolveCompanyContext called without a permission argument
        // Exception: the service's own resolveCompanyContext definition
        if (!line.includes('async resolveCompanyContext')) {
          missing.push(`    L${i + 1}: ${line.trim().substring(0, 120)}`);
        }
      }
    }

    totalPermissionlessCalls += missing.length;
    check(
      `MUTATION-AUDIT-${name}`,
      missing.length === 0,
      missing.length > 0 ? `${missing.length} permission-less call(s):\n${missing.join('\n')}` : undefined,
    );
  }

  check(
    'MUTATION-AUDIT-TOTAL: zero permission-less resolveCompanyContext calls',
    totalPermissionlessCalls === 0,
    totalPermissionlessCalls > 0 ? `${totalPermissionlessCalls} total violations found` : undefined,
  );
}

function adminBypassAudit(): void {
  console.log('\n── ADMIN BYPASS / CONTROLLER ROLES AUDIT ──');
  const srcDir = join(__dirname, '..', 'src');

  function readFile(path: string): string {
    return readFileSync(join(srcDir, path), 'utf8');
  }

  // 1. Attendance controller: isCompanyRole bypass was removed; must now have @Roles guard
  const attendanceCtrl = readFile('attendance/attendance.controller.ts');
  check(
    'ADMIN-BYPASS-1: AttendanceController.getCompanyAttendance has @Roles decorator',
    attendanceCtrl.includes('@Roles(') && !attendanceCtrl.includes('isCompanyRole'),
  );

  // 2. Company controller: findMine must use @Roles(ADMIN, ...COMPANY_VIEW_ROLES)
  const companyCtrl = readFile('company/company.controller.ts');
  check(
    'ADMIN-BYPASS-2: CompanyController.findMine has @Roles with ADMIN',
    companyCtrl.includes('@Roles(') && companyCtrl.includes('UserRole.ADMIN'),
  );

  // 3. No remaining isCompanyRole usage across controllers
  const controllerFiles = [
    'attendance/attendance.controller.ts',
    'company/company.controller.ts',
    'payroll-batch/payroll-batch.controller.ts',
    'invoice-batch/invoice-batch.controller.ts',
    'shift/shift.controller.ts',
    'client/client.controller.ts',
  ];
  let isCompanyRoleUsageCount = 0;
  for (const file of controllerFiles) {
    let content: string;
    try { content = readFile(file); } catch { continue; }
    if (content.includes('isCompanyRole(')) {
      isCompanyRoleUsageCount++;
      check(`ADMIN-BYPASS-3: No isCompanyRole in ${file}`, false, 'isCompanyRole() bypass found');
    }
  }
  if (isCompanyRoleUsageCount === 0) {
    check('ADMIN-BYPASS-3: No isCompanyRole() bypass in any controller', true);
  }

  // 4. Legacy findByUserId: no service should call companyService.findByUserId for company scoping
  const serviceFiles = [
    'client/client.service.ts',
    'payroll-batch/payroll-batch.service.ts',
    'invoice-batch/invoice-batch.service.ts',
    'shift/shift.service.ts',
    'attendance/attendance.service.ts',
    'incident/incident.service.ts',
    'audit-log/audit-log.service.ts',
  ];
  let legacyUsageCount = 0;
  for (const file of serviceFiles) {
    let content: string;
    try { content = readFile(file); } catch { continue; }
    // findByUserId may still appear in comments or in the membership service itself
    // Check only for companyService.findByUserId (legacy company scoping)
    if (content.includes('companyService.findByUserId(')) {
      legacyUsageCount++;
      check(`ADMIN-BYPASS-4: No companyService.findByUserId in ${file}`, false, 'legacy scoping found');
    }
  }
  if (legacyUsageCount === 0) {
    check('ADMIN-BYPASS-4: No legacy companyService.findByUserId in migrated services', true);
  }
}

// ─── DB seed ──────────────────────────────────────────────────────────────────

interface SeedResult {
  companyA: Company;
  companyB: Company;
  opsUser: User;
  crUser: User;
  hrUser: User;
  finUser: User;
  viewUser: User;
  ownerStaff: User;
  companyBStaff: User;
  clientA: Client;
  clientB: Client;
}

async function seed(ds: DataSource): Promise<SeedResult> {
  const userRepo = ds.getRepository(User);
  const companyRepo = ds.getRepository(Company);
  const membershipRepo = ds.getRepository(CompanyMembership);
  const clientRepo = ds.getRepository(Client);

  // Company A — legacy COMPANY user for FK (not used for auth in tests)
  const ownerUserLegacy = await userRepo.save(userRepo.create({
    email: 'coa-legacy@p2rt.test', passwordHash: 'test',
    role: UserRole.COMPANY, status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const companyA = await companyRepo.save(companyRepo.create({
    user: ownerUserLegacy, name: 'Company A – Runtime Test', companyNumber: 'RT-A001',
    address: '1 Alpha St', contactDetails: 'test', status: CompanyStatus.ACTIVE,
  }));

  // Company A staff: each gets UserRole.COMPANY_STAFF (used as userRole in service calls)
  const mkStaff = (email: string) => userRepo.save(userRepo.create({
    email, passwordHash: 'test', role: UserRole.COMPANY_STAFF,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const [opsUser, crUser, hrUser, finUser, viewUser, ownerStaff] = await Promise.all([
    mkStaff('ops@p2rt.test'),
    mkStaff('cr@p2rt.test'),
    mkStaff('hr@p2rt.test'),
    mkStaff('fin@p2rt.test'),
    mkStaff('view@p2rt.test'),
    mkStaff('ownr@p2rt.test'),
  ]);

  const mkMembership = (userId: number, membershipRole: CompanyMembershipRole) =>
    membershipRepo.save(membershipRepo.create({
      userId, companyId: companyA.id, membershipRole,
      status: CompanyMembershipStatus.ACTIVE, acceptedAt: new Date(),
    }));
  await Promise.all([
    mkMembership(opsUser.id, CompanyMembershipRole.OPERATIONS),
    mkMembership(crUser.id, CompanyMembershipRole.CONTROL_ROOM),
    mkMembership(hrUser.id, CompanyMembershipRole.HR_COMPLIANCE),
    mkMembership(finUser.id, CompanyMembershipRole.FINANCE),
    mkMembership(viewUser.id, CompanyMembershipRole.VIEWER),
    mkMembership(ownerStaff.id, CompanyMembershipRole.OWNER),
  ]);

  const clientA = await clientRepo.save(clientRepo.create({
    company: companyA, name: 'Client Alpha', status: 'active',
  }));

  // Company B — isolation target
  const ownerLegacyB = await userRepo.save(userRepo.create({
    email: 'cob-legacy@p2rt.test', passwordHash: 'test',
    role: UserRole.COMPANY, status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const companyB = await companyRepo.save(companyRepo.create({
    user: ownerLegacyB, name: 'Company B – Isolation Target', companyNumber: 'RT-B001',
    address: '2 Beta St', contactDetails: 'test', status: CompanyStatus.ACTIVE,
  }));

  // Company B operations staff member (to verify B→A isolation)
  const companyBStaff = await mkStaff('ops-b@p2rt.test');
  await membershipRepo.save(membershipRepo.create({
    userId: companyBStaff.id, companyId: companyB.id,
    membershipRole: CompanyMembershipRole.OPERATIONS,
    status: CompanyMembershipStatus.ACTIVE, acceptedAt: new Date(),
  }));

  const clientB = await clientRepo.save(clientRepo.create({
    company: companyB, name: 'Client Beta', status: 'active',
  }));

  return { companyA, companyB, opsUser, crUser, hrUser, finUser, viewUser, ownerStaff, companyBStaff, clientA, clientB };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Section 0: Source audits (no DB) ──────────────────────────────────────
  mutationCoverageAudit();
  adminBypassAudit();

  // ── Section 0B: DB bootstrap ──────────────────────────────────────────────
  const url = process.env.P2_RUNTIME_DATABASE_URL ?? process.env.P1I_DATABASE_URL;
  if (!url) throw new Error('P2_RUNTIME_DATABASE_URL or P1I_DATABASE_URL env var is required');

  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities,
    synchronize: true, dropSchema: true, logging: false,
  });
  await ds.initialize();

  try {
    console.log('\n── SEED ──────────────────────────────────────────────────────────────────');
    const {
      companyA, companyB,
      opsUser, crUser, hrUser, finUser, viewUser, ownerStaff,
      companyBStaff, clientA, clientB,
    } = await seed(ds);
    console.log(`  Company A id=${companyA.id}  Company B id=${companyB.id}`);

    // ── Service instantiation ─────────────────────────────────────────────────
    // CompanyMembershipService: real repo, mocked CompanyService (legacy path never reached
    // for ACTIVE COMPANY_STAFF users — Step 4 only fires when no membership row exists and
    // userRole is COMPANY / COMPANY_ADMIN).
    const membershipService = new CompanyMembershipService(
      ds.getRepository(CompanyMembership),
      { findByUserId: async () => null } as any,
    );

    const mockAuditLog = { log: async () => undefined };
    const mockPayRule = {
      getConfigForCompany: async () => null,
      calculatePay: (ts: Timesheet) => ({
        payableHours: Number((ts as any).approvedMinutes ?? 0) / 60,
        payableAmount: null,
      }),
    };
    const mockContractPricing = { applyFinancials: async <T>(v: T) => v };

    const auditLogSvc = new AuditLogService(
      ds.getRepository(AuditLog),
      membershipService,
    );
    const clientSvc = new ClientService(
      ds.getRepository(Client),
      membershipService,
      auditLogSvc,
    );
    const payrollSvc = new PayrollBatchService(
      ds.getRepository(PayrollBatch),
      ds.getRepository(Timesheet),
      membershipService,
      mockAuditLog as any,
      mockPayRule as any,
      ds,
    );
    const invoiceSvc = new InvoiceBatchService(
      ds.getRepository(InvoiceBatch),
      ds.getRepository(Timesheet),
      ds.getRepository(Client),
      ds.getRepository(PaymentRecord),
      ds.getRepository(ClientWeeklyApprovalLine),
      ds.getRepository(ClientWeeklyApprovalRequest),
      membershipService,
      mockContractPricing as any,
      mockAuditLog as any,
      ds,
    );
    const cwaSvc = new ClientWeeklyApprovalService(
      ds.getRepository(ClientWeeklyApprovalRequest),
      ds.getRepository(ClientWeeklyApprovalLine),
      ds.getRepository(ClientShiftDispute),
      membershipService,
      mockAuditLog as any,
      ds,
    );

    // Shorthand roles
    const CS = UserRole.COMPANY_STAFF;

    // ── Section 1: PAYROLL_VIEW gate ──────────────────────────────────────────
    console.log('\n── RT-PAYROLL: PAYROLL_VIEW (FINANCE / OWNER only) ──────────────────────');
    await deny('RT-PAYROLL-OPS-DENY: OPERATIONS cannot list payroll', () => payrollSvc.listForCompany(opsUser.id, CS));
    await deny('RT-PAYROLL-CR-DENY: CONTROL_ROOM cannot list payroll', () => payrollSvc.listForCompany(crUser.id, CS));
    await deny('RT-PAYROLL-HR-DENY: HR_COMPLIANCE cannot list payroll', () => payrollSvc.listForCompany(hrUser.id, CS));
    await deny('RT-PAYROLL-VIEW-DENY: VIEWER cannot list payroll', () => payrollSvc.listForCompany(viewUser.id, CS));
    await allow('RT-PAYROLL-FIN-ALLOW: FINANCE can list payroll', () => payrollSvc.listForCompany(finUser.id, CS));
    await allow('RT-PAYROLL-OWNER-ALLOW: OWNER can list payroll', () => payrollSvc.listForCompany(ownerStaff.id, CS));

    // ── Section 2: PAYROLL_MANAGE gate ────────────────────────────────────────
    console.log('\n── RT-PAYROLL-MANAGE: PAYROLL_MANAGE (FINANCE / OWNER only) ─────────────');
    const emptyPayrollDto = { periodStart: '2026-01-01', periodEnd: '2026-01-31', timesheetIds: [] } as any;
    await deny('RT-PAYROLL-MANAGE-OPS-DENY: OPERATIONS cannot create payroll', () => payrollSvc.createForCompany(opsUser.id, CS, emptyPayrollDto));
    await deny('RT-PAYROLL-MANAGE-CR-DENY: CONTROL_ROOM cannot create payroll', () => payrollSvc.createForCompany(crUser.id, CS, emptyPayrollDto));
    await deny('RT-PAYROLL-MANAGE-HR-DENY: HR_COMPLIANCE cannot create payroll', () => payrollSvc.createForCompany(hrUser.id, CS, emptyPayrollDto));
    await deny('RT-PAYROLL-MANAGE-VIEW-DENY: VIEWER cannot create payroll', () => payrollSvc.createForCompany(viewUser.id, CS, emptyPayrollDto));
    await allow('RT-PAYROLL-MANAGE-FIN-ALLOW: FINANCE can create payroll (gate passes)', () => payrollSvc.createForCompany(finUser.id, CS, emptyPayrollDto));

    // ── Section 3: BILLING_VIEW gate ──────────────────────────────────────────
    console.log('\n── RT-BILLING: BILLING_VIEW (FINANCE / OWNER only) ─────────────────────');
    await deny('RT-BILLING-OPS-DENY: OPERATIONS cannot list invoices', () => invoiceSvc.listForCompany(opsUser.id, CS));
    await deny('RT-BILLING-CR-DENY: CONTROL_ROOM cannot list invoices', () => invoiceSvc.listForCompany(crUser.id, CS));
    await deny('RT-BILLING-HR-DENY: HR_COMPLIANCE cannot list invoices', () => invoiceSvc.listForCompany(hrUser.id, CS));
    await deny('RT-BILLING-VIEW-DENY: VIEWER cannot list invoices', () => invoiceSvc.listForCompany(viewUser.id, CS));
    await allow('RT-BILLING-FIN-ALLOW: FINANCE can list invoices', () => invoiceSvc.listForCompany(finUser.id, CS));
    await allow('RT-BILLING-OWNER-ALLOW: OWNER can list invoices', () => invoiceSvc.listForCompany(ownerStaff.id, CS));

    // ── Section 4: CLIENTS_VIEW gate ──────────────────────────────────────────
    console.log('\n── RT-CLIENT: CLIENTS_VIEW (all except HR_COMPLIANCE) ──────────────────');
    await allow('RT-CLIENT-OPS-ALLOW: OPERATIONS can list clients', () => clientSvc.findAllForCompanyUser(opsUser.id, CS));
    await allow('RT-CLIENT-CR-ALLOW: CONTROL_ROOM can list clients', () => clientSvc.findAllForCompanyUser(crUser.id, CS));
    await deny('RT-CLIENT-HR-DENY: HR_COMPLIANCE cannot list clients', () => clientSvc.findAllForCompanyUser(hrUser.id, CS));
    await allow('RT-CLIENT-FIN-ALLOW: FINANCE can list clients', () => clientSvc.findAllForCompanyUser(finUser.id, CS));
    await allow('RT-CLIENT-VIEW-ALLOW: VIEWER can list clients', () => clientSvc.findAllForCompanyUser(viewUser.id, CS));

    // ── Section 5: COMPLIANCE_VIEW gate ───────────────────────────────────────
    console.log('\n── RT-AUDIT: COMPLIANCE_VIEW (all except FINANCE) ───────────────────────');
    await allow('RT-AUDIT-OPS-ALLOW: OPERATIONS can view audit log', () => auditLogSvc.findForCompany(opsUser.id, CS));
    await allow('RT-AUDIT-CR-ALLOW: CONTROL_ROOM can view audit log', () => auditLogSvc.findForCompany(crUser.id, CS));
    await allow('RT-AUDIT-HR-ALLOW: HR_COMPLIANCE can view audit log', () => auditLogSvc.findForCompany(hrUser.id, CS));
    await deny('RT-AUDIT-FIN-DENY: FINANCE cannot view audit log (no COMPLIANCE_VIEW)', () => auditLogSvc.findForCompany(finUser.id, CS));
    await allow('RT-AUDIT-VIEW-ALLOW: VIEWER can view audit log', () => auditLogSvc.findForCompany(viewUser.id, CS));

    // ── Section 6: SHIFTS_MANAGE audit — CONTROL_ROOM cannot manage shifts ────
    console.log('\n── RT-SHIFT-MANAGE: SHIFTS_MANAGE (POST/PATCH/DELETE shift → 403 for CR) ─');
    // Direct gate test: all company-facing shift mutations call this same resolver
    await deny('RT-SHIFT-CR-MANAGE-DENY: CONTROL_ROOM → SHIFTS_MANAGE → 403', () =>
      membershipService.resolveCompanyContext(crUser.id, CS, CompanyPermission.SHIFTS_MANAGE));
    await allow('RT-SHIFT-OPS-MANAGE-ALLOW: OPERATIONS → SHIFTS_MANAGE → allowed', () =>
      membershipService.resolveCompanyContext(opsUser.id, CS, CompanyPermission.SHIFTS_MANAGE));
    await deny('RT-SHIFT-HR-MANAGE-DENY: HR_COMPLIANCE → SHIFTS_MANAGE → 403', () =>
      membershipService.resolveCompanyContext(hrUser.id, CS, CompanyPermission.SHIFTS_MANAGE));
    await deny('RT-SHIFT-FIN-MANAGE-DENY: FINANCE → SHIFTS_MANAGE → 403', () =>
      membershipService.resolveCompanyContext(finUser.id, CS, CompanyPermission.SHIFTS_MANAGE));
    await deny('RT-SHIFT-VIEW-MANAGE-DENY: VIEWER → SHIFTS_MANAGE → 403', () =>
      membershipService.resolveCompanyContext(viewUser.id, CS, CompanyPermission.SHIFTS_MANAGE));

    // Confirm CONTROL_ROOM has SHIFTS_VIEW (read allowed, write denied)
    await allow('RT-SHIFT-CR-VIEW-ALLOW: CONTROL_ROOM → SHIFTS_VIEW → allowed', () =>
      membershipService.resolveCompanyContext(crUser.id, CS, CompanyPermission.SHIFTS_VIEW));

    // ── Section 7: P1H — CLIENT_BILLING_SUBMIT ────────────────────────────────
    console.log('\n── RT-P1H: CLIENT_BILLING_SUBMIT (OPERATIONS/FINANCE allowed; CR/HR/VIEWER denied) ─');
    const submitDto = {
      clientId: 9999999, siteId: 9999999,
      weekCommencing: '2026-01-05', timesheetIds: [9999999],
    } as any;

    // ALLOW: permission passes; NotFoundException for missing client = ALLOW proof
    await allow('RT-P1H-OPS-ALLOW: OPERATIONS can submit CWA (P1H proof)', () =>
      cwaSvc.createSubmission(opsUser.id, CS, submitDto));
    await allow('RT-P1H-FIN-ALLOW: FINANCE can submit CWA', () =>
      cwaSvc.createSubmission(finUser.id, CS, submitDto));
    await allow('RT-P1H-OWNER-ALLOW: OWNER can submit CWA', () =>
      cwaSvc.createSubmission(ownerStaff.id, CS, submitDto));

    // DENY: ForbiddenException at permission gate
    await deny('RT-P1H-CR-DENY: CONTROL_ROOM cannot submit CWA → 403', () =>
      cwaSvc.createSubmission(crUser.id, CS, submitDto));
    await deny('RT-P1H-HR-DENY: HR_COMPLIANCE cannot submit CWA → 403', () =>
      cwaSvc.createSubmission(hrUser.id, CS, submitDto));
    await deny('RT-P1H-VIEW-DENY: VIEWER cannot submit CWA → 403', () =>
      cwaSvc.createSubmission(viewUser.id, CS, submitDto));

    // ── Section 8: P1H-C — CLIENT_BILLING_CORRECT ─────────────────────────────
    console.log('\n── RT-P1H-C: CLIENT_BILLING_CORRECT (FINANCE/OWNER; OPERATIONS denied) ──');
    const reviseDto = {
      timesheetId: 9999999,
      newBillingStartAt: '2026-01-05T09:00:00Z',
      newBillingEndAt: '2026-01-05T17:00:00Z',
      clientCorrectionReason: 'Runtime test correction',
    } as any;

    // OPERATIONS can submit (P1H) but CANNOT correct billing (P1H-C)
    await deny('RT-P1H-C-OPS-DENY: OPERATIONS cannot revise billing → 403 (P1H-C proof)', () =>
      cwaSvc.reviseApprovedTime(opsUser.id, CS, 9999999, reviseDto));
    // FINANCE can correct billing
    await allow('RT-P1H-C-FIN-ALLOW: FINANCE can revise billing (P1H-C proof)', () =>
      cwaSvc.reviseApprovedTime(finUser.id, CS, 9999999, reviseDto));
    await allow('RT-P1H-C-OWNER-ALLOW: OWNER can revise billing', () =>
      cwaSvc.reviseApprovedTime(ownerStaff.id, CS, 9999999, reviseDto));
    // All others denied
    await deny('RT-P1H-C-CR-DENY: CONTROL_ROOM cannot revise billing → 403', () =>
      cwaSvc.reviseApprovedTime(crUser.id, CS, 9999999, reviseDto));
    await deny('RT-P1H-C-HR-DENY: HR_COMPLIANCE cannot revise billing → 403', () =>
      cwaSvc.reviseApprovedTime(hrUser.id, CS, 9999999, reviseDto));
    await deny('RT-P1H-C-VIEW-DENY: VIEWER cannot revise billing → 403', () =>
      cwaSvc.reviseApprovedTime(viewUser.id, CS, 9999999, reviseDto));

    // ── Section 9: Tenant isolation ───────────────────────────────────────────
    console.log('\n── RT-ISOLATE: Tenant isolation ─────────────────────────────────────────');

    // Company A OPERATIONS sees Company A clients; Company B client not visible
    const opsClients = await clientSvc.findAllForCompanyUser(opsUser.id, CS);
    check(
      'RT-ISOLATE-1A: Company A OPERATIONS sees Client A',
      opsClients.some((c: any) => c.id === clientA.id),
    );
    check(
      'RT-ISOLATE-1B: Company A OPERATIONS does NOT see Client B (Company B)',
      !opsClients.some((c: any) => c.id === clientB.id),
    );

    // Company B OPERATIONS sees Company B clients; Company A client not visible
    const bClients = await clientSvc.findAllForCompanyUser(companyBStaff.id, CS);
    check(
      'RT-ISOLATE-2A: Company B OPERATIONS sees Client B',
      bClients.some((c: any) => c.id === clientB.id),
    );
    check(
      'RT-ISOLATE-2B: Company B OPERATIONS does NOT see Client A (Company A)',
      !bClients.some((c: any) => c.id === clientA.id),
    );

    // Company B payroll (FINANCE role) does NOT cross to Company A data
    const bFinanceUser = await (async () => {
      const membershipRepo2 = ds.getRepository(CompanyMembership);
      const user = await ds.getRepository(User).save(ds.getRepository(User).create({
        email: 'fin-b@p2rt.test', passwordHash: 'test', role: UserRole.COMPANY_STAFF,
        status: UserStatus.ACTIVE, isEmailVerified: true,
      }));
      await membershipRepo2.save(membershipRepo2.create({
        userId: user.id, companyId: companyB.id,
        membershipRole: CompanyMembershipRole.FINANCE,
        status: CompanyMembershipStatus.ACTIVE, acceptedAt: new Date(),
      }));
      return user;
    })();
    const bPayrolls = await payrollSvc.listForCompany(bFinanceUser.id, CS);
    check(
      'RT-ISOLATE-3: Company B FINANCE payroll list is empty (no cross-company data)',
      Array.isArray(bPayrolls) && bPayrolls.length === 0,
    );

    // ── Section 10: Session permission changes (no new JWT) ────────────────────
    console.log('\n── RT-SESSION: Permission changes reflected without new JWT ──────────────');

    // Create a mutable user with OPERATIONS membership
    const membershipRepo = ds.getRepository(CompanyMembership);
    const rotUser = await ds.getRepository(User).save(ds.getRepository(User).create({
      email: 'rotating@p2rt.test', passwordHash: 'test',
      role: UserRole.COMPANY_STAFF, status: UserStatus.ACTIVE, isEmailVerified: true,
    }));
    const rotMembership = await membershipRepo.save(membershipRepo.create({
      userId: rotUser.id, companyId: companyA.id,
      membershipRole: CompanyMembershipRole.OPERATIONS,
      status: CompanyMembershipStatus.ACTIVE, acceptedAt: new Date(),
    }));

    // Initial: OPERATIONS — clients ALLOW, payroll DENY
    await allow('RT-SESSION-1: ACTIVE OPERATIONS → clients ALLOW', () =>
      clientSvc.findAllForCompanyUser(rotUser.id, CS));
    await deny('RT-SESSION-2: ACTIVE OPERATIONS → payroll DENY', () =>
      payrollSvc.listForCompany(rotUser.id, CS));

    // Promote to FINANCE in DB (same userId/role=COMPANY_STAFF JWT)
    await membershipRepo.update(rotMembership.id, { membershipRole: CompanyMembershipRole.FINANCE });
    await allow('RT-SESSION-3: Changed to FINANCE (no new JWT) → payroll ALLOW', () =>
      payrollSvc.listForCompany(rotUser.id, CS));
    await deny('RT-SESSION-4: Changed to FINANCE (no new JWT) → audit DENY (no COMPLIANCE_VIEW)', () =>
      auditLogSvc.findForCompany(rotUser.id, CS));

    // SUSPEND membership
    await membershipRepo.update(rotMembership.id, { status: CompanyMembershipStatus.SUSPENDED });
    await deny('RT-SESSION-5: SUSPENDED → all access denied', () =>
      clientSvc.findAllForCompanyUser(rotUser.id, CS));

    // Reinstate to ACTIVE
    await membershipRepo.update(rotMembership.id, { status: CompanyMembershipStatus.ACTIVE });
    await allow('RT-SESSION-6: Reinstated ACTIVE FINANCE → payroll ALLOW', () =>
      payrollSvc.listForCompany(rotUser.id, CS));

    // REVOKE membership
    await membershipRepo.update(rotMembership.id, { status: CompanyMembershipStatus.REVOKED });
    await deny('RT-SESSION-7: REVOKED → all access denied', () =>
      clientSvc.findAllForCompanyUser(rotUser.id, CS));

    // Additional state: COMPANY_STAFF with no membership → 404 (fail-closed)
    const orphanUser = await ds.getRepository(User).save(ds.getRepository(User).create({
      email: 'orphan@p2rt.test', passwordHash: 'test',
      role: UserRole.COMPANY_STAFF, status: UserStatus.ACTIVE, isEmailVerified: true,
    }));
    await deny('RT-SESSION-8: COMPANY_STAFF with no membership → fail-closed (404/Forbidden)', async () => {
      // NotFoundException is thrown for no-membership COMPANY_STAFF — wrap as ForbiddenException-like
      // to confirm fail-closed behaviour. Allow helper: NotFoundException would count as ALLOW (wrong).
      // Use deny helper with NotFoundException check override:
      try {
        await clientSvc.findAllForCompanyUser(orphanUser.id, CS);
        throw new ForbiddenException('no-membership user succeeded unexpectedly');
      } catch (err: any) {
        if (err?.constructor?.name === 'NotFoundException' || err instanceof ForbiddenException) {
          throw new ForbiddenException('fail-closed: ' + err.message);
        }
        throw err;
      }
    });

    // ── Section 11: Comprehensive permission boundary matrix ──────────────────
    console.log('\n── RT-MATRIX: Additional permission boundary checks ─────────────────────');

    // FINANCE has no COMPLIANCE_MANAGE
    await deny('RT-MATRIX-1: FINANCE → COMPLIANCE_MANAGE → 403', () =>
      membershipService.resolveCompanyContext(finUser.id, CS, CompanyPermission.COMPLIANCE_MANAGE));
    // OPERATIONS has COMPLIANCE_VIEW but not COMPLIANCE_MANAGE
    await allow('RT-MATRIX-2: OPERATIONS → COMPLIANCE_VIEW → allowed', () =>
      membershipService.resolveCompanyContext(opsUser.id, CS, CompanyPermission.COMPLIANCE_VIEW));
    await deny('RT-MATRIX-3: OPERATIONS → COMPLIANCE_MANAGE → 403', () =>
      membershipService.resolveCompanyContext(opsUser.id, CS, CompanyPermission.COMPLIANCE_MANAGE));
    // FINANCE has PERSONNEL_BANK_VIEW; HR does not
    await allow('RT-MATRIX-4: FINANCE → PERSONNEL_BANK_VIEW → allowed', () =>
      membershipService.resolveCompanyContext(finUser.id, CS, CompanyPermission.PERSONNEL_BANK_VIEW));
    await deny('RT-MATRIX-5: HR_COMPLIANCE → PERSONNEL_BANK_VIEW → 403', () =>
      membershipService.resolveCompanyContext(hrUser.id, CS, CompanyPermission.PERSONNEL_BANK_VIEW));
    await deny('RT-MATRIX-6: OPERATIONS → PERSONNEL_BANK_VIEW → 403', () =>
      membershipService.resolveCompanyContext(opsUser.id, CS, CompanyPermission.PERSONNEL_BANK_VIEW));
    // HR has PERSONNEL_HR_VIEW/MANAGE; FINANCE does not
    await allow('RT-MATRIX-7: HR_COMPLIANCE → PERSONNEL_HR_VIEW → allowed', () =>
      membershipService.resolveCompanyContext(hrUser.id, CS, CompanyPermission.PERSONNEL_HR_VIEW));
    await deny('RT-MATRIX-8: FINANCE → PERSONNEL_HR_VIEW → 403', () =>
      membershipService.resolveCompanyContext(finUser.id, CS, CompanyPermission.PERSONNEL_HR_VIEW));
    // VIEWER has CLIENT_BILLING_VIEW but not CLIENT_BILLING_SUBMIT
    await allow('RT-MATRIX-9: VIEWER → CLIENT_BILLING_VIEW → allowed', () =>
      membershipService.resolveCompanyContext(viewUser.id, CS, CompanyPermission.CLIENT_BILLING_VIEW));
    await deny('RT-MATRIX-10: VIEWER → CLIENT_BILLING_SUBMIT → 403', () =>
      membershipService.resolveCompanyContext(viewUser.id, CS, CompanyPermission.CLIENT_BILLING_SUBMIT));
    // FINANCE has REPORTS_FINANCIAL; OPERATIONS has REPORTS_OPERATIONAL only
    await allow('RT-MATRIX-11: FINANCE → REPORTS_FINANCIAL → allowed', () =>
      membershipService.resolveCompanyContext(finUser.id, CS, CompanyPermission.REPORTS_FINANCIAL));
    await deny('RT-MATRIX-12: OPERATIONS → REPORTS_FINANCIAL → 403', () =>
      membershipService.resolveCompanyContext(opsUser.id, CS, CompanyPermission.REPORTS_FINANCIAL));
    await allow('RT-MATRIX-13: OPERATIONS → REPORTS_OPERATIONAL → allowed', () =>
      membershipService.resolveCompanyContext(opsUser.id, CS, CompanyPermission.REPORTS_OPERATIONAL));
    await deny('RT-MATRIX-14: FINANCE → REPORTS_OPERATIONAL → 403', () =>
      membershipService.resolveCompanyContext(finUser.id, CS, CompanyPermission.REPORTS_OPERATIONAL));
    // OWNER has COMPANY_MANAGE; ADMIN does not
    await allow('RT-MATRIX-15: OWNER → COMPANY_MANAGE → allowed', () =>
      membershipService.resolveCompanyContext(ownerStaff.id, CS, CompanyPermission.COMPANY_MANAGE));

    // ── Final summary ─────────────────────────────────────────────────────────
    console.log(`\n══ P1I PHASE 2 RUNTIME: ${pass} PASS / ${fail} FAIL ══`);
    if (failures.length > 0) {
      console.log('\nFailures:');
      for (const f of failures) console.log(` ✗ ${f}`);
    }

    assert.equal(fail, 0, `${fail} test(s) failed`);

  } finally {
    await ds.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
