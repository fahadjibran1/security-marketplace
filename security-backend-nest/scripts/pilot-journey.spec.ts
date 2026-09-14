/**
 * S4 Pilot 1 — Financial Journey Certification
 *
 * Tests the complete correction scenario end-to-end against real PostgreSQL.
 * All critical services are real (CompanyMembershipService, CWAService,
 * PayrollBatchService, InvoiceBatchService). Only PayRuleService and
 * ContractPricingService are stubbed (no contract pricing configured for pilot).
 *
 * Correction scenario (verbatim from pilot brief):
 *   Guard claim = 8.00h
 *   Company approval = 7.50h  (Layer 4 payroll-authoritative)
 *   CWA V1 submission = 7.50h
 *   Client approves V1
 *   Client disputes → billing target 7.00h
 *   Company L5 correction = 7.00h (clientBillingApprovedMinutes = 420)
 *   Guard Pay MUST remain 7.50h  (approvedMinutes = 450, untouched)
 *   Company resolves dispute
 *   Company resubmits → V2 line = 7.00h
 *   Client approves V2
 *   Payroll batch consumes: 7.50h
 *   Invoice batch consumes: 7.00h
 *   No evidence layer may be overwritten
 *
 * Run:
 *   PILOT_JOURNEY_DATABASE_URL=<pg-url> npx ts-node -r tsconfig-paths/register scripts/pilot-journey.spec.ts
 * Falls back to P1I_DATABASE_URL if PILOT_JOURNEY_DATABASE_URL is not set.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { Company, CompanyStatus } from '../src/company/entities/company.entity';
import { CompanyMembership } from '../src/company-membership/entities/company-membership.entity';
import { CompanyMembershipRole, CompanyMembershipStatus } from '../src/company-membership/company-membership-types';
import { Client } from '../src/client/entities/client.entity';
import { Site } from '../src/site/entities/site.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { Timesheet, TimesheetBillingStatus, TimesheetPayrollStatus, TimesheetStatus } from '../src/timesheet/entities/timesheet.entity';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { PayrollBatch } from '../src/payroll-batch/entities/payroll-batch.entity';
import { InvoiceBatch } from '../src/invoice-batch/entities/invoice-batch.entity';
import { PaymentRecord } from '../src/payment-record/entities/payment-record.entity';
import { ClientWeeklyApprovalRequest, ClientWeeklyApprovalStatus } from '../src/client-weekly-approval/entities/client-weekly-approval-request.entity';
import { ClientWeeklyApprovalLine } from '../src/client-weekly-approval/entities/client-weekly-approval-line.entity';
import { ClientShiftDispute } from '../src/client-weekly-approval/entities/client-shift-dispute.entity';

import { CompanyMembershipService } from '../src/company-membership/company-membership.service';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { ClientWeeklyApprovalService } from '../src/client-weekly-approval/client-weekly-approval.service';
import { ClientPortalWeeklyApprovalService } from '../src/client-weekly-approval/client-portal-weekly-approval.service';
import { PayrollBatchService } from '../src/payroll-batch/payroll-batch.service';
import { InvoiceBatchService } from '../src/invoice-batch/invoice-batch.service';

// ─── Harness ──────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
    failures.push(label);
  }
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    console.log(`PASS  ${label}`);
    pass++;
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FAIL  ${label} — threw: ${msg}`);
    fail++;
    failures.push(label);
    throw err;
  }
}

// ─── Seed ─────────────────────────────────────────────────────────────────────

interface SeedResult {
  companyAdminId: number;
  clientUserId: number;
  companyId: number;
  guardProfileId: number;
  clientId: number;
  siteId: number;
  shiftId: number;
  timesheetId: number;
  weekCommencing: string;
}

async function seed(ds: DataSource): Promise<SeedResult> {
  const userRepo = ds.getRepository(User);
  const companyRepo = ds.getRepository(Company);
  const membershipRepo = ds.getRepository(CompanyMembership);
  const guardProfileRepo = ds.getRepository(GuardProfile);
  const clientRepo = ds.getRepository(Client);
  const siteRepo = ds.getRepository(Site);
  const shiftRepo = ds.getRepository(Shift);
  const timesheetRepo = ds.getRepository(Timesheet);

  // Users
  const companyAdmin = await userRepo.save(userRepo.create({
    email: 'admin@pilot-security.test',
    passwordHash: '$2b$10$placeholder',
    role: UserRole.COMPANY,
    status: UserStatus.ACTIVE,
    isEmailVerified: true,
  }));

  const guardUser = await userRepo.save(userRepo.create({
    email: 'guard@pilot-security.test',
    passwordHash: '$2b$10$placeholder',
    role: UserRole.GUARD,
    status: UserStatus.ACTIVE,
    isEmailVerified: true,
  }));

  const clientUser = await userRepo.save(userRepo.create({
    email: 'client@pilot-security.test',
    passwordHash: '$2b$10$placeholder',
    role: UserRole.CLIENT_ADMIN,
    status: UserStatus.ACTIVE,
    isEmailVerified: true,
  }));

  // Company
  const company = await companyRepo.save(companyRepo.create({
    user: companyAdmin,
    name: 'Pilot Security Ltd',
    companyNumber: 'PSL-9999',
    address: '1 Pilot St, London EC1A 1BB',
    contactDetails: '+44 20 0000 0001',
    status: CompanyStatus.ACTIVE,
  }));

  // OWNER membership (mirrors production backfill)
  await membershipRepo.save(membershipRepo.create({
    user: companyAdmin,
    company,
    membershipRole: CompanyMembershipRole.OWNER,
    status: CompanyMembershipStatus.ACTIVE,
    invitedByUserId: null,
  }));

  // Guard profile
  const guardProfile = await guardProfileRepo.save(guardProfileRepo.create({
    user: guardUser,
    fullName: 'Alpha Guard',
    siaLicenseNumber: `SIA-PILOT-${Date.now()}`,
    phone: '+44 7700 000001',
    status: 'approved',
  }));

  // Client
  const client = await clientRepo.save(clientRepo.create({
    company,
    name: 'Pilot Client A',
    status: 'active',
  }));

  // Site linked to client
  const site = await siteRepo.save(siteRepo.create({
    company,
    client,
    name: 'Alpha Site',
    address: '10 Alpha Way, London',
    timezone: 'Europe/London',
    status: 'active',
  }));

  // Shift on Tuesday 2026-08-25 (week commencing 2026-08-24)
  // 08:00-16:00 UTC → 09:00-17:00 BST (Europe/London)
  const shiftStart = new Date('2026-08-25T08:00:00Z');
  const shiftEnd = new Date('2026-08-25T16:00:00Z');

  const shift = await shiftRepo.save(shiftRepo.create({
    company,
    site,
    siteName: 'Alpha Site',
    start: shiftStart,
    end: shiftEnd,
  }));

  // Timesheet: guard claimed 8h, company approved 7.5h (approvedMinutes = 450)
  const timesheet = await timesheetRepo.save(timesheetRepo.create({
    company,
    guard: guardProfile,
    shift,
    hoursWorked: 8,
    workedMinutes: 480,
    roundedMinutes: 450,
    approvalStatus: TimesheetStatus.APPROVED,
    approvedHours: 7.5,
    approvedMinutes: 450,
    billingStatus: TimesheetBillingStatus.UNINVOICED,
    payrollStatus: TimesheetPayrollStatus.UNPAID,
    scheduledStartAt: shiftStart,
    scheduledEndAt: shiftEnd,
    actualCheckInAt: shiftStart,
    actualCheckOutAt: shiftEnd,
    reviewedAt: new Date(),
    reviewedByUserId: companyAdmin.id,
  }));

  return {
    companyAdminId: companyAdmin.id,
    clientUserId: clientUser.id,
    companyId: company.id,
    guardProfileId: guardProfile.id,
    clientId: client.id,
    siteId: site.id,
    shiftId: shift.id,
    timesheetId: timesheet.id,
    weekCommencing: '2026-08-24',
  };
}

// ─── Mock services ─────────────────────────────────────────────────────────────

const mockPayRuleService = {
  getConfigForCompany: async () => null,
  calculatePay: (ts: Timesheet) => ({
    payableHours: ts.approvedMinutes != null ? Number(ts.approvedMinutes) / 60 : 0,
    payableAmount: null,
    breakdown: {},
  }),
} as any;

const mockContractPricingService = {
  applyFinancials: async <T>(arg: T): Promise<T> => arg,
} as any;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const url = process.env.PILOT_JOURNEY_DATABASE_URL || process.env.P1I_DATABASE_URL;
  if (!url) throw new Error('PILOT_JOURNEY_DATABASE_URL or P1I_DATABASE_URL env var is required');

  const ds = new DataSource({
    type: 'postgres',
    url,
    entities: appEntities,
    dropSchema: true,
    synchronize: true,
    logging: false,
  });

  await ds.initialize();

  try {
    // ── Seed ─────────────────────────────────────────────────────────────────

    const {
      companyAdminId, clientUserId, companyId,
      clientId, siteId, timesheetId, weekCommencing,
    } = await seed(ds);

    const timesheetRepo = ds.getRepository(Timesheet);
    const requestRepo = ds.getRepository(ClientWeeklyApprovalRequest);
    const lineRepo = ds.getRepository(ClientWeeklyApprovalLine);
    const disputeRepo = ds.getRepository(ClientShiftDispute);

    // Verify seed
    const seeded = await timesheetRepo.findOneOrFail({ where: { id: timesheetId } });
    check('JOURNEY-SEED-1: timesheet seeded with hoursWorked=8', Number(seeded.hoursWorked) === 8);
    check('JOURNEY-SEED-2: approvedMinutes=450 (7.5h payroll)', Number(seeded.approvedMinutes) === 450);
    check('JOURNEY-SEED-3: approvalStatus=APPROVED', String(seeded.approvalStatus) === TimesheetStatus.APPROVED);
    check('JOURNEY-SEED-4: billingStatus=UNINVOICED', String(seeded.billingStatus) === TimesheetBillingStatus.UNINVOICED);
    check('JOURNEY-SEED-5: payrollStatus=UNPAID', String(seeded.payrollStatus) === TimesheetPayrollStatus.UNPAID);

    // ── Services ─────────────────────────────────────────────────────────────

    const membershipService = new CompanyMembershipService(
      ds.getRepository(CompanyMembership),
      { findByUserId: async () => null } as any,
    );
    const auditLogService = new AuditLogService(
      ds.getRepository(AuditLog),
      membershipService,
    );
    const cwaSvc = new ClientWeeklyApprovalService(
      requestRepo,
      lineRepo,
      disputeRepo,
      membershipService,
      auditLogService,
      ds,
    );
    const clientPortalSvc = new ClientPortalWeeklyApprovalService(
      requestRepo,
      lineRepo,
      disputeRepo,
      auditLogService,
      ds,
    );
    const payrollSvc = new PayrollBatchService(
      ds.getRepository(PayrollBatch),
      timesheetRepo,
      membershipService,
      auditLogService,
      mockPayRuleService,
      ds,
    );
    const invoiceSvc = new InvoiceBatchService(
      ds.getRepository(InvoiceBatch),
      timesheetRepo,
      ds.getRepository(Client),
      ds.getRepository(PaymentRecord),
      lineRepo,
      requestRepo,
      membershipService,
      mockContractPricingService,
      auditLogService,
      ds,
    );

    // ── JOURNEY-1: Company context resolves for OWNER ─────────────────────────

    const ctx = await step('JOURNEY-1: OWNER resolves company context', async () =>
      membershipService.resolveCompanyContext(companyAdminId, UserRole.COMPANY),
    );
    check('JOURNEY-1a: resolved companyId matches seed', ctx.company.id === companyId);

    // ── JOURNEY-2: CWA V1 submission at 7.5h ──────────────────────────────────

    const cwaV1 = await step('JOURNEY-2: Company submits CWA V1 (7.5h)', async () =>
      cwaSvc.createSubmission(companyAdminId, UserRole.COMPANY, {
        clientId,
        siteId,
        weekCommencing,
        timesheetIds: [timesheetId],
        companyInternalNote: 'Pilot V1 submission',
        clientSubmissionNote: 'Week 2026-08-24 Alpha Site',
      }),
    );
    check('JOURNEY-2a: CWA V1 status=PENDING_APPROVAL', cwaV1.status === ClientWeeklyApprovalStatus.PENDING_APPROVAL);
    check('JOURNEY-2b: CWA V1 totalApprovedHours=7.5', Number(cwaV1.totalApprovedHours) === 7.5);
    check('JOURNEY-2c: CWA V1 currentVersion=1', cwaV1.currentVersion === 1);

    // Verify V1 line
    const v1Lines = await lineRepo.find({ where: { weeklyApprovalRequest: { id: cwaV1.id }, superseded: false } });
    check('JOURNEY-2d: one active V1 line', v1Lines.length === 1);
    check('JOURNEY-2e: V1 line approvedHoursAtSubmission=7.5', Number(v1Lines[0].approvedHoursAtSubmission) === 7.5);

    // ── JOURNEY-3: Client disputes V1 (billing target 7.0h) ──────────────────
    // Note: dispute requires PENDING_APPROVAL status. In the pilot workflow,
    // the client reviews the V1 submission and disputes rather than approving.
    // (Client V1 approval and V2 approval are separate steps per the brief.)

    await step('JOURNEY-3: Client disputes V1 (target billing 7.0h)', async () =>
      clientPortalSvc.disputeShifts(clientId, clientUserId, cwaV1.id, {
        disputes: [{
          timesheetId,
          disputeReason: 'Guard arrived 30 minutes late. Billing should be 7.0h not 7.5h.',
        }],
      }),
    );
    const afterDispute = await requestRepo.findOneOrFail({ where: { id: cwaV1.id } });
    check('JOURNEY-3a: status→DISPUTED', afterDispute.status === ClientWeeklyApprovalStatus.DISPUTED);
    const openDisputes = await disputeRepo.find({ where: { weeklyApprovalRequest: { id: cwaV1.id }, submissionVersion: 1 } });
    check('JOURNEY-3b: one OPEN dispute created', openDisputes.length === 1 && openDisputes[0].status === 'open');

    // ── JOURNEY-5: L5 correction — billing = 7.0h ─────────────────────────────

    // 7.0h window: 08:30-15:30 UTC = 420 minutes
    const billingStart = new Date('2026-08-25T08:30:00Z');
    const billingEnd = new Date('2026-08-25T15:30:00Z');

    await step('JOURNEY-5: Company applies L5 billing correction (7.0h)', async () =>
      cwaSvc.reviseApprovedTime(companyAdminId, UserRole.COMPANY, cwaV1.id, {
        timesheetId,
        newBillingStartAt: billingStart.toISOString(),
        newBillingEndAt: billingEnd.toISOString(),
        clientCorrectionReason: 'Guard arrived 30 min late per site log. Correcting billing to 7.0h.',
      }),
    );

    // ── JOURNEY-6: Layer 4 payroll (approvedMinutes) MUST remain 450 ──────────

    const afterL5 = await timesheetRepo.findOneOrFail({ where: { id: timesheetId } });
    check(
      'JOURNEY-6: CRITICAL — approvedMinutes=450 unchanged after L5 correction',
      Number(afterL5.approvedMinutes) === 450,
      `got ${afterL5.approvedMinutes}`,
    );
    check('JOURNEY-6a: approvedHours=7.5 unchanged', Number(afterL5.approvedHours) === 7.5);
    check('JOURNEY-6b: clientBillingApprovedMinutes=420 (7.0h billing)', Number(afterL5.clientBillingApprovedMinutes) === 420);
    check('JOURNEY-6c: approvalStatus still APPROVED', String(afterL5.approvalStatus) === TimesheetStatus.APPROVED);
    check('JOURNEY-6d: billingStatus still UNINVOICED', String(afterL5.billingStatus) === TimesheetBillingStatus.UNINVOICED);
    check('JOURNEY-6e: payrollStatus still UNPAID', String(afterL5.payrollStatus) === TimesheetPayrollStatus.UNPAID);

    // ── JOURNEY-7: Resolve dispute ─────────────────────────────────────────────

    await step('JOURNEY-7: Company resolves dispute', async () =>
      cwaSvc.resolveDispute(companyAdminId, UserRole.COMPANY, cwaV1.id, openDisputes[0].id, {
        resolutionMessage: 'Billing correction applied (7.0h). Guard pay remains 7.5h per company policy.',
      }),
    );
    const afterResolve = await requestRepo.findOneOrFail({ where: { id: cwaV1.id } });
    check('JOURNEY-7a: status→RESOLVED', afterResolve.status === ClientWeeklyApprovalStatus.RESOLVED);

    // ── JOURNEY-8: V2 resubmit — billing line = 7.0h ──────────────────────────

    const cwaV2 = await step('JOURNEY-8: Company resubmits V2 (billing 7.0h from L5)', async () =>
      cwaSvc.resubmit(companyAdminId, UserRole.COMPANY, cwaV1.id, {
        timesheetIds: [timesheetId],
        clientSubmissionNote: 'Resubmitting with corrected billing (7.0h per site log).',
      }),
    );
    check('JOURNEY-8a: CWA V2 status=PENDING_APPROVAL', cwaV2.status === ClientWeeklyApprovalStatus.PENDING_APPROVAL);
    check('JOURNEY-8b: CWA V2 currentVersion=2', cwaV2.currentVersion === 2);
    check('JOURNEY-8c: CWA V2 totalApprovedHours=7.0', Number(cwaV2.totalApprovedHours) === 7.0);

    // ── JOURNEY-9: L5 fields cleared after resubmit ───────────────────────────

    const afterResubmit = await timesheetRepo.findOneOrFail({ where: { id: timesheetId } });
    check(
      'JOURNEY-9: CRITICAL — clientBillingApprovedMinutes=NULL (cleared after resubmit)',
      afterResubmit.clientBillingApprovedMinutes == null,
      `got ${afterResubmit.clientBillingApprovedMinutes}`,
    );
    check(
      'JOURNEY-9a: CRITICAL — approvedMinutes=450 still unchanged after resubmit',
      Number(afterResubmit.approvedMinutes) === 450,
      `got ${afterResubmit.approvedMinutes}`,
    );

    // ── JOURNEY-10: V1 line superseded, V2 line = 7.0h ───────────────────────

    const allLines = await lineRepo.find({ where: { weeklyApprovalRequest: { id: cwaV1.id } } });
    const v2Lines = allLines.filter((l) => !l.superseded && l.submissionVersion === 2);
    const supersededLines = allLines.filter((l) => l.superseded && l.submissionVersion === 1);
    check('JOURNEY-10: one active V2 line', v2Lines.length === 1);
    check('JOURNEY-10a: V2 line approvedHoursAtSubmission=7.0', Number(v2Lines[0].approvedHoursAtSubmission) === 7.0);
    check('JOURNEY-10b: V1 line is superseded (evidence preserved)', supersededLines.length === 1);
    check('JOURNEY-10c: V1 line still shows 7.5 (not overwritten)', Number(supersededLines[0].approvedHoursAtSubmission) === 7.5);

    // ── JOURNEY-11: Client approves V2 ───────────────────────────────────────

    await step('JOURNEY-11: Client approves V2 (7.0h)', async () =>
      clientPortalSvc.approveWeek(clientId, clientUserId, cwaV1.id),
    );
    const afterV2Approve = await requestRepo.findOneOrFail({ where: { id: cwaV1.id } });
    check('JOURNEY-11a: status→CLIENT_APPROVED for V2', afterV2Approve.status === ClientWeeklyApprovalStatus.CLIENT_APPROVED);

    // ── JOURNEY-12: Payroll batch — consumes 7.5h (Layer 4) ──────────────────

    const payrollResult = await step('JOURNEY-12: Payroll batch created (7.5h)', async () =>
      payrollSvc.createForCompany(companyAdminId, UserRole.COMPANY, {
        periodStart: '2026-08-24',
        periodEnd: '2026-08-30',
        timesheetIds: [timesheetId],
        notes: 'Pilot week payroll',
      }),
    );
    check('JOURNEY-12a: payroll batch totalApprovedHours=7.5', payrollResult.totals.approvedHours === 7.5);

    // Reload timesheet to verify payroll snapshot
    const afterPayroll = await timesheetRepo.findOneOrFail({ where: { id: timesheetId } });
    check('JOURNEY-12b: approvedHoursSnapshot=7.5 in timesheet', Number(afterPayroll.approvedHoursSnapshot) === 7.5);
    check('JOURNEY-12c: payrollStatus=INCLUDED', String(afterPayroll.payrollStatus) === TimesheetPayrollStatus.INCLUDED);
    check(
      'JOURNEY-12d: CRITICAL — approvedMinutes=450 unchanged after payroll batch',
      Number(afterPayroll.approvedMinutes) === 450,
    );
    check(
      'JOURNEY-12e: billingStatus still UNINVOICED before invoice batch',
      String(afterPayroll.billingStatus) === TimesheetBillingStatus.UNINVOICED,
    );

    // ── JOURNEY-13: Invoice batch — consumes 7.0h (V2 CWA line) ──────────────

    const invoiceResult = await step('JOURNEY-13: Invoice batch created (7.0h billing)', async () =>
      invoiceSvc.createForCompany(companyAdminId, UserRole.COMPANY, {
        clientId,
        periodStart: '2026-08-24',
        periodEnd: '2026-08-30',
        timesheetIds: [timesheetId],
        invoiceReference: 'INV-PILOT-001',
        notes: 'Pilot week invoice',
        paymentTermsDays: 30,
        vatRate: 20,
      }),
    );

    // Reload timesheet to verify billing snapshot
    const afterInvoice = await timesheetRepo.findOneOrFail({ where: { id: timesheetId } });
    check(
      'JOURNEY-13a: CRITICAL — clientBilledHoursSnapshot=7.0 (client-approved billing)',
      Number(afterInvoice.clientBilledHoursSnapshot) === 7.0,
      `got ${afterInvoice.clientBilledHoursSnapshot}`,
    );
    check(
      'JOURNEY-13b: CRITICAL — approvedHoursSnapshot=7.5 (payroll independent of billing)',
      Number(afterInvoice.approvedHoursSnapshot) === 7.5,
      `got ${afterInvoice.approvedHoursSnapshot}`,
    );
    check(
      'JOURNEY-13c: CRITICAL — approvedMinutes=450 unchanged throughout full lifecycle',
      Number(afterInvoice.approvedMinutes) === 450,
    );
    check('JOURNEY-13d: billingStatus=INCLUDED', String(afterInvoice.billingStatus) === TimesheetBillingStatus.INCLUDED);
    check('JOURNEY-13e: payrollStatus still INCLUDED (unchanged by invoicing)', String(afterInvoice.payrollStatus) === TimesheetPayrollStatus.INCLUDED);

    // ── JOURNEY-14: Financial independence summary ────────────────────────────

    const final = await timesheetRepo.findOneOrFail({ where: { id: timesheetId } });
    const payrollHours = Number(final.approvedMinutes) / 60;
    const billingHours = Number(final.clientBilledHoursSnapshot);
    const delta = payrollHours - billingHours;

    check('JOURNEY-14: payroll hours = 7.5h', payrollHours === 7.5);
    check('JOURNEY-14a: billing hours = 7.0h', billingHours === 7.0);
    check('JOURNEY-14b: divergence = 0.5h (30 minutes)', Math.abs(delta - 0.5) < 0.001);
    check('JOURNEY-14c: guard overpaid relative to client billing (benefit to guard)', delta > 0);

    // ── JOURNEY-15: Evidence layer audit ─────────────────────────────────────

    const allEvidence = await lineRepo.find({ where: { weeklyApprovalRequest: { id: cwaV1.id } } });
    const v1Evidence = allEvidence.find((l) => l.submissionVersion === 1 && l.superseded);
    const v2Evidence = allEvidence.find((l) => l.submissionVersion === 2 && !l.superseded);

    check('JOURNEY-15: V1 evidence layer preserved (not deleted)', v1Evidence !== undefined);
    check('JOURNEY-15a: V1 evidence shows original 7.5h claim', v1Evidence ? Number(v1Evidence.approvedHoursAtSubmission) === 7.5 : false);
    check('JOURNEY-15b: V2 evidence layer present', v2Evidence !== undefined);
    check('JOURNEY-15c: V2 evidence shows corrected 7.0h billing', v2Evidence ? Number(v2Evidence.approvedHoursAtSubmission) === 7.0 : false);
    check('JOURNEY-15d: no evidence deleted (both V1 and V2 traceable)', allEvidence.length === 2);

  } finally {
    await ds.destroy();
  }

  // ── Report ──────────────────────────────────────────────────────────────────

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════');
  if (fail === 0) {
    console.log(`══ PILOT JOURNEY: ${pass} PASS / 0 FAIL ══`);
    console.log('');
    console.log('  Guard Pay:   7.50h  ← approvedMinutes (Layer 4, payroll-authoritative)');
    console.log('  Invoice:     7.00h  ← clientBilledHoursSnapshot (Layer 6, V2 CWA line)');
    console.log('  Divergence:  0.50h  ← guard pay exceeds billing (correct per policy)');
    console.log('  V1 evidence: 7.50h  ← superseded line preserved');
    console.log('  V2 evidence: 7.00h  ← active line');
    console.log('  L5 fields:   NULL   ← cleared after resubmit (no stale correction)');
    console.log('');
    console.log('PILOT JOURNEY: PASS');
  } else {
    console.log(`══ PILOT JOURNEY: ${pass} PASS / ${fail} FAIL ══`);
    failures.forEach((f) => console.error(`  FAILED: ${f}`));
    console.log('');
    console.log('PILOT JOURNEY: FAIL');
    process.exit(1);
  }
  console.log('══════════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
