import { equal, ok } from 'node:assert/strict';
import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getMetadataArgsStorage } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import { PublicRegistrationRole, RegisterDto } from '../src/auth/dto/register.dto';
import { JwtPayload } from '../src/auth/types/jwt-payload.type';
import { AttendanceEvent } from '../src/attendance/entities/attendance.entity';
import { ClientPortalUser } from '../src/client-portal-user/entities/client-portal-user.entity';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { CompanyController } from '../src/company/company.controller';
import { CompanyService } from '../src/company/company.service';
import { CompanyStatus } from '../src/company/entities/company.entity';
import { ContractPricingService } from '../src/contract-pricing/contract-pricing.service';
import { GuardApprovalStatus } from '../src/guard-profile/entities/guard-profile.entity';
import { InvoiceBatchService } from '../src/invoice-batch/invoice-batch.service';
import { PayRuleService } from '../src/pay-rule/pay-rule.service';
import { PayrollBatchService } from '../src/payroll-batch/payroll-batch.service';
import { Site } from '../src/site/entities/site.entity';
import { TimesheetService } from '../src/timesheet/timesheet.service';
import { TimesheetStatus } from '../src/timesheet/entities/timesheet.entity';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';

type Calls = {
  userCreates: any[];
  companyCreates: any[];
  guardCreates: any[];
};

function buildHarness() {
  const calls: Calls = {
    userCreates: [],
    companyCreates: [],
    guardCreates: [],
  };

  let companyProfile: any = null;
  let guardProfile: any = null;

  const usersService = {
    create: async (input: any) => {
      calls.userCreates.push(input);
      return {
        id: calls.userCreates.length,
        email: input.email,
        role: input.role,
        status: input.status,
        passwordHash: 'unused',
      };
    },
    findByEmail: async () => null,
    updateLastLogin: async () => undefined,
  };

  const jwtService = {
    sign: (payload: unknown) => `test-token:${JSON.stringify(payload)}`,
  };

  const companyService = {
    create: async (input: any) => {
      calls.companyCreates.push(input);
      companyProfile = { id: 101, ...input };
      return companyProfile;
    },
    findByUserId: async () => companyProfile,
  };

  const guardProfileService = {
    create: async (input: any) => {
      calls.guardCreates.push(input);
      guardProfile = { id: 201, ...input };
      return guardProfile;
    },
    findByUserId: async () => guardProfile,
  };

  const service = new AuthService(
    usersService as any,
    jwtService as any,
    companyService as any,
    guardProfileService as any,
    {} as any,
    {} as any,
  );

  return { service, calls };
}

async function expectBadRequest(action: () => Promise<unknown>) {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }

  ok(thrown instanceof BadRequestException, 'Expected BadRequestException');
}

function assertColumnExcluded(target: Function, propertyName: string, label: string) {
  const column = getMetadataArgsStorage().columns.find(
    (candidate) => candidate.target === target && candidate.propertyName === propertyName,
  );

  ok(column, `${label} column metadata must exist`);
  equal(column.options.select, false, `${label} must use select:false`);
}

async function testPrivilegedRoleCannotSelfRegister() {
  const { service, calls } = buildHarness();

  await expectBadRequest(() =>
    service.register({
      email: 'attacker@example.test',
      password: 'secret123',
      role: UserRole.ADMIN,
    } as unknown as RegisterDto),
  );

  equal(calls.userCreates.length, 0, 'Privileged registration must not create a user');
}

async function testInvalidGuardPayloadHasNoSideEffects() {
  const { service, calls } = buildHarness();

  await expectBadRequest(() =>
    service.register({
      email: 'guard@example.test',
      password: 'secret123',
      role: PublicRegistrationRole.GUARD,
      fullName: 'Test Guard',
    }),
  );

  equal(calls.userCreates.length, 0, 'Invalid guard registration must not create a user');
  equal(calls.guardCreates.length, 0, 'Invalid guard registration must not create a profile');
}

async function testGuardRegistrationRemainsPending() {
  const { service, calls } = buildHarness();

  const result = await service.register({
    email: 'guard@example.test',
    password: 'secret123',
    role: PublicRegistrationRole.GUARD,
    fullName: 'Test Guard',
    siaLicenseNumber: 'SIA123456',
    phone: '07000000000',
  });

  equal(calls.userCreates.length, 1);
  equal(calls.userCreates[0].role, UserRole.GUARD);
  equal(calls.userCreates[0].status, UserStatus.PENDING);
  equal(calls.guardCreates.length, 1);
  equal(calls.guardCreates[0].status, GuardApprovalStatus.PENDING);
  equal(calls.guardCreates[0].approvalStatus, GuardApprovalStatus.PENDING);
  equal(calls.guardCreates[0].isApproved, false);
  equal(result.user.status, UserStatus.PENDING);
}

async function testCompanyRegistrationMapsToCompanyAdmin() {
  const { service, calls } = buildHarness();

  const result = await service.register({
    email: 'company@example.test',
    password: 'secret123',
    role: PublicRegistrationRole.COMPANY,
    companyName: 'Example Security Ltd',
    companyNumber: '12345678',
    address: '1 Test Street',
    contactDetails: 'operations@example.test',
  });

  equal(calls.userCreates.length, 1);
  equal(calls.userCreates[0].role, UserRole.COMPANY_ADMIN);
  equal(calls.userCreates[0].status, UserStatus.ACTIVE);
  equal(calls.companyCreates.length, 1);
  equal(calls.companyCreates[0].status, CompanyStatus.ONBOARDING);
  equal(result.user.role, UserRole.COMPANY_ADMIN);
}

// RB-006: build a minimal fake ExecutionContext carrying only what RolesGuard
// reads (context.getHandler()/getClass() for @Roles metadata, and
// request.user for the authenticated JWT payload) so the *real*
// CompanyController route decorators and the *real* RolesGuard logic are
// exercised, without needing a full Nest application bootstrap.
function buildRoleContext(handler: Function, role: UserRole | undefined): ExecutionContext {
  const user: JwtPayload | undefined = role
    ? { sub: 1, email: 'user@example.test', role, status: 'active' }
    : undefined;

  return {
    getHandler: () => handler,
    getClass: () => CompanyController,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

async function testCompanySideRolesCannotEnumerateOrFetchAnyCompany() {
  const guard = new RolesGuard(new Reflector());
  const tenantRoles = [UserRole.COMPANY, UserRole.COMPANY_ADMIN, UserRole.COMPANY_STAFF];

  for (const role of tenantRoles) {
    equal(
      guard.canActivate(buildRoleContext(CompanyController.prototype.findAll, role)),
      false,
      `${role} must not be able to call GET /companies (tenant enumeration)`,
    );
    equal(
      guard.canActivate(buildRoleContext(CompanyController.prototype.findOne, role)),
      false,
      `${role} must not be able to call GET /companies/:id (cross-tenant IDOR)`,
    );
  }
}

async function testPlatformAdminRetainsCompanyDirectoryAccess() {
  const guard = new RolesGuard(new Reflector());

  ok(
    guard.canActivate(buildRoleContext(CompanyController.prototype.findAll, UserRole.ADMIN)),
    'Platform admin must still be able to call GET /companies',
  );
  ok(
    guard.canActivate(buildRoleContext(CompanyController.prototype.findOne, UserRole.ADMIN)),
    'Platform admin must still be able to call GET /companies/:id',
  );
}

async function testCompanyFindByUserIdNeverResolvesAnotherTenant() {
  const companyA = { id: 101, user: { id: 1 }, name: 'Company A' };
  const companyB = { id: 102, user: { id: 2 }, name: 'Company B' };

  const companyRepo = {
    findOne: async ({ where }: { where: { user: { id: number } } }) =>
      [companyA, companyB].find((company) => company.user.id === where.user.id) ?? null,
  };

  const service = new CompanyService(companyRepo as any, {} as any);

  const resolvedForUserA = await service.findByUserId(1);
  const resolvedForUserB = await service.findByUserId(2);

  equal(resolvedForUserA?.id, companyA.id, "Company A's user must resolve Company A via JWT-derived findMine()");
  equal(resolvedForUserB?.id, companyB.id, "Company B's user must resolve Company B via JWT-derived findMine()");
  ok(resolvedForUserA?.id !== resolvedForUserB?.id, "Company A's session must never resolve Company B's record");
}

// RB-007: fake TimesheetService dependencies. findOne()/save() model a real ORM
// round trip — findOne() returns a deep clone so mutating the returned entity
// (as the service does in place) never silently "persists" without save().
function buildTimesheetHarness(seedTimesheets: any[]) {
  const store = new Map<number, any>(seedTimesheets.map((timesheet) => [timesheet.id, timesheet]));
  const auditLogs: any[] = [];
  const notifications: any[] = [];

  const timesheetRepo = {
    findOne: async ({ where }: any) => {
      const timesheet = store.get(where.id);
      if (!timesheet) return null;
      if (where.company && timesheet.company?.id !== where.company.id) return null;
      if (where.shift && timesheet.shift?.id !== where.shift.id) return null;
      return structuredClone(timesheet);
    },
    save: async (entity: any) => {
      if (Array.isArray(entity)) {
        entity.forEach((item) => store.set(item.id, structuredClone(item)));
        return entity;
      }
      store.set(entity.id, structuredClone(entity));
      return entity;
    },
  };

  const companyService = { findByUserId: async (userId: number) => (userId === 501 ? { id: 501, name: 'Test Co' } : null) };
  const guardProfileService = { findByUserId: async (userId: number) => (userId === 301 ? { id: 301 } : null) };
  const contractPricingService = { applyFinancials: async (x: any) => x };
  const payRuleService = { applyPayCalculations: async (x: any) => x };
  const notificationService = { createForUser: async (input: any) => { notifications.push(input); } };
  const auditLogService = { log: async (input: any) => { auditLogs.push(input); return input; } };

  const service = new TimesheetService(
    timesheetRepo as any,
    companyService as any,
    contractPricingService as any,
    guardProfileService as any,
    auditLogService as any,
    notificationService as any,
    payRuleService as any,
  );

  return { service, store, auditLogs, notifications };
}

function buildSubmittedTimesheet(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    company: { id: 501 },
    guard: { id: 301, user: { id: 9001 } },
    shift: { id: 701 },
    hoursWorked: 8,
    approvalStatus: TimesheetStatus.SUBMITTED,
    scheduledStartAt: null,
    scheduledEndAt: null,
    actualCheckInAt: null,
    actualCheckOutAt: null,
    guardNote: null,
    companyNote: null,
    approvedHours: null,
    approvedHoursSnapshot: null,
    hourlyRateSnapshot: null,
    payableHoursSnapshot: null,
    payableAmountSnapshot: null,
    billingRateSnapshot: null,
    payrollStatus: 'unpaid',
    payrollIncludedAt: null,
    payrollPaidAt: null,
    payrollBatch: null,
    billingStatus: 'uninvoiced',
    invoiceIssuedAt: null,
    invoicePaidAt: null,
    invoiceBatch: null,
    workedMinutes: 480,
    breakMinutes: 0,
    roundedMinutes: 480,
    submittedAt: new Date('2026-01-01T00:00:00Z'),
    reviewedAt: null,
    reviewedByUserId: null,
    rejectionReason: null,
    verifiedMinutes: null,
    approvedMinutes: null,
    overrideReason: null,
    overrideBy: null,
    overrideAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ✓ Normal attendance: manager approves with no override input, approvedMinutes
// must default to the attendance-verified duration, not the guard's claimed hoursWorked.
async function testNormalAttendanceApprovalDefaultsToVerifiedMinutes() {
  const timesheet = buildSubmittedTimesheet({ id: 1, hoursWorked: 8, verifiedMinutes: 235 });
  const { service, auditLogs } = buildTimesheetHarness([timesheet]);

  const result = await service.updateForCompany(501, 1, { approvalStatus: TimesheetStatus.APPROVED } as any);

  equal(result.approvedMinutes, 235, 'approvedMinutes must default to verifiedMinutes, not hoursWorked (480)');
  equal(result.approvedHours, 3.92, 'approvedHours must be derived from verifiedMinutes (235/60)');
  equal(result.overrideReason, null, 'No override reason expected when using the verified default');
  equal(result.overrideBy, null, 'No override actor expected when using the verified default');
  equal(result.overrideAt, null, 'No override timestamp expected when using the verified default');
  ok(
    !auditLogs.some((entry) => entry.action === 'timesheet.approved_duration_overridden'),
    'A non-override approval must not emit an override audit entry',
  );
}

// ✓ Override: manager approves a different duration than verified, with a reason.
async function testManagerOverrideRequiresReasonAndRecordsAudit() {
  const timesheet = buildSubmittedTimesheet({ id: 2, hoursWorked: 8, verifiedMinutes: 235 });
  const { service, auditLogs } = buildTimesheetHarness([timesheet]);

  const result = await service.updateForCompany(501, 2, {
    approvalStatus: TimesheetStatus.APPROVED,
    approvedMinutes: 300,
    overrideReason: 'Guard stayed late per site supervisor confirmation',
  } as any);

  equal(result.approvedMinutes, 300, 'approvedMinutes must reflect the manager override, not verifiedMinutes');
  equal(result.overrideReason, 'Guard stayed late per site supervisor confirmation');
  equal(result.overrideBy, 501, 'overrideBy must be the server-derived reviewer id, never client-supplied');
  ok(result.overrideAt instanceof Date, 'overrideAt must be a server-derived timestamp');

  const overrideEntry = auditLogs.find((entry) => entry.action === 'timesheet.approved_duration_overridden');
  ok(overrideEntry, 'An override must emit a dedicated audit log entry');
  equal(overrideEntry.afterData.approvedMinutes, 300);
  equal(overrideEntry.afterData.overrideReason, 'Guard stayed late per site supervisor confirmation');
  equal(overrideEntry.beforeData.verifiedMinutes, 235);
}

// ✓ Missing reason: overriding without a reason must be rejected, and nothing persisted.
async function testApprovalWithoutOverrideReasonIsRejected() {
  const timesheet = buildSubmittedTimesheet({ id: 3, hoursWorked: 8, verifiedMinutes: 235 });
  const { service, store } = buildTimesheetHarness([timesheet]);

  await expectBadRequest(() =>
    service.updateForCompany(501, 3, { approvalStatus: TimesheetStatus.APPROVED, approvedMinutes: 300 } as any),
  );

  const persisted = store.get(3);
  equal(persisted.approvalStatus, TimesheetStatus.SUBMITTED, 'Rejected override attempt must not change approval status');
  equal(persisted.approvedMinutes, null, 'Rejected override attempt must not persist approvedMinutes');

  // Also reject when there is no verified duration at all and no override is supplied.
  const noAttendance = buildSubmittedTimesheet({ id: 4, hoursWorked: 8, verifiedMinutes: null });
  const harness2 = buildTimesheetHarness([noAttendance]);
  await expectBadRequest(() =>
    harness2.service.updateForCompany(501, 4, { approvalStatus: TimesheetStatus.APPROVED } as any),
  );
}

// ✓ Payroll totals (1/2): PayRuleService must compute pay from approvedMinutes, ignoring
// an inflated hoursWorked claim.
async function testPayRuleServiceUsesApprovedMinutesNotHoursWorked() {
  const configRepo = { findOne: async () => null };
  const companyService = { findByUserId: async () => null };
  const payRuleService = new PayRuleService(configRepo as any, companyService as any);

  const timesheet: any = {
    approvalStatus: TimesheetStatus.APPROVED,
    hoursWorked: 999,
    approvedHoursSnapshot: null,
    approvedMinutes: 235,
    hourlyRateSnapshot: 20,
    company: { id: 501 },
    shift: {},
  };

  const result = payRuleService.calculatePay(timesheet, null);

  equal(result.baseHours, 3.92, 'PayRuleService must use approvedMinutes/60 (3.92h), not the claimed hoursWorked (999h)');
  equal(result.payableHours, 3.92);
  equal(result.payableAmount, 78.4, 'payableAmount must be 3.92h * £20/h, not 999h * £20/h');
}

// ✓ Payroll totals (2/2): payroll batch creation snapshots approvedMinutes-derived
// hours, not hoursWorked.
async function testPayrollBatchSnapshotUsesApprovedMinutesNotHoursWorked() {
  const timesheet = {
    id: 10,
    company: { id: 501 },
    approvalStatus: TimesheetStatus.APPROVED,
    payrollStatus: 'unpaid',
    payrollBatch: null,
    payrollIncludedAt: null,
    payrollPaidAt: null,
    hoursWorked: 999,
    approvedMinutes: 235,
    approvedHoursSnapshot: null,
    hourlyRateSnapshot: 20,
    payableHoursSnapshot: null,
    payableAmountSnapshot: null,
    shift: {},
  };

  const timesheetStore = new Map<number, any>([[10, timesheet]]);
  const timesheetRepo = {
    find: async ({ where }: any) => {
      const ids = (Array.isArray(where) ? where : [where]).map((clause: any) => clause.id);
      return Array.from(timesheetStore.values()).filter((t) => ids.includes(t.id));
    },
    save: async (entities: any[]) => {
      entities.forEach((entity) => timesheetStore.set(entity.id, entity));
      return entities;
    },
  };

  let savedBatch: any = null;
  const payrollBatchRepo = {
    create: (input: any) => ({ id: 900, timesheets: [], ...input }),
    save: async (batch: any) => {
      savedBatch = batch;
      return batch;
    },
    findOne: async () => ({ ...savedBatch, timesheets: Array.from(timesheetStore.values()) }),
  };

  const companyService = { findByUserId: async () => ({ id: 501 }) };
  const auditLogService = { log: async () => undefined };
  const configRepo = { findOne: async () => null };
  const payRuleService = new PayRuleService(configRepo as any, companyService as any);

  const service = new PayrollBatchService(
    payrollBatchRepo as any,
    timesheetRepo as any,
    companyService as any,
    auditLogService as any,
    payRuleService as any,
  );

  const batch = await service.createForCompany(501, {
    periodStart: '2026-01-01',
    periodEnd: '2026-01-07',
    timesheetIds: [10],
  } as any);

  equal(batch.totals.approvedHours, 3.92, 'Payroll batch totals must derive from approvedMinutes (3.92h), not hoursWorked (999h)');
}

// ✓ Existing behaviour preserved: guards can still self-edit their claimed hours, but
// the approval-duration fields remain out of their reach even if smuggled into the DTO;
// reject/return still clear approval-duration state as before.
async function testExistingBehaviourPreserved() {
  const timesheet = buildSubmittedTimesheet({
    id: 5,
    approvalStatus: TimesheetStatus.DRAFT,
    approvedMinutes: null,
    verifiedMinutes: 235,
  });
  const { service } = buildTimesheetHarness([timesheet]);

  // Guard-editable whitelist: hoursWorked passes through, approvedMinutes/verifiedMinutes do not.
  (service as any).applyGuardEditableUpdates(timesheet, {
    hoursWorked: 5,
    approvedMinutes: 999,
    verifiedMinutes: 999,
  });
  equal(timesheet.hoursWorked, 5, 'Guard must still be able to edit their claimed hoursWorked');
  equal(timesheet.approvedMinutes, null, 'Guard-editable path must not be able to set approvedMinutes');
  equal(timesheet.verifiedMinutes, 235, 'Guard-editable path must not be able to overwrite verifiedMinutes');

  // Reject flow still requires a reason and clears approval-duration state, as before.
  const approvedTimesheet = buildSubmittedTimesheet({
    id: 6,
    approvedMinutes: 235,
    overrideReason: null,
    overrideBy: null,
    overrideAt: null,
  });
  const harness2 = buildTimesheetHarness([approvedTimesheet]);
  await expectBadRequest(() =>
    harness2.service.updateForCompany(501, 6, { approvalStatus: TimesheetStatus.REJECTED } as any),
  );

  const rejected = await harness2.service.updateForCompany(501, 6, {
    approvalStatus: TimesheetStatus.REJECTED,
    rejectionReason: 'Duplicate submission',
  } as any);
  equal(rejected.approvedMinutes, null, 'Rejecting a timesheet must clear approvedMinutes as before');
  equal(rejected.approvalStatus, TimesheetStatus.REJECTED);
}

// RB-007B: real ContractPricingService with a fake ruleRepo (no contract rules
// configured — exercises the fallback job.billingRate/hourlyRate path).
function buildContractPricingService() {
  const ruleRepo = { find: async () => [] };
  const clientRepo = {};
  const siteRepo = {};
  const timesheetRepo = {};
  const companyService = {};
  return new ContractPricingService(ruleRepo as any, clientRepo as any, siteRepo as any, timesheetRepo as any, companyService as any);
}

function buildBillableTimesheet(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    company: { id: 501 },
    approvalStatus: TimesheetStatus.APPROVED,
    hoursWorked: 999,
    approvedMinutes: 235,
    approvedHours: null,
    approvedHoursSnapshot: null,
    hourlyRateSnapshot: null,
    billingRateSnapshot: null,
    billingStatus: 'uninvoiced',
    invoiceBatch: null,
    companyNote: null,
    scheduledStartAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    shift: {
      job: { hourlyRate: 20, billingRate: 25 },
      site: { client: { id: 601, name: 'Test Client' } },
    },
    ...overrides,
  } as any;
}

// ✓ contract pricing uses approvedMinutes, ✓ hoursWorked ignored
async function testContractPricingUsesApprovedMinutesNotHoursWorked() {
  const service = buildContractPricingService();
  const timesheet = buildBillableTimesheet({ hoursWorked: 999, approvedMinutes: 235 });

  const result = service.deriveTimesheetFinancials(timesheet, []);

  equal(result.costAmount, 78.33, 'costAmount must derive from approvedMinutes (3.92h * £20), not hoursWorked (999h)');
  equal(result.revenueAmount, 98, 'revenueAmount must derive from approvedMinutes (3.92h * £25), not hoursWorked (999h)');

  // Changing only hoursWorked (guard editing their claim) must not move the result at all.
  const inflated = buildBillableTimesheet({ hoursWorked: 100000, approvedMinutes: 235 });
  const resultAfterGuardEdit = service.deriveTimesheetFinancials(inflated, []);
  equal(resultAfterGuardEdit.costAmount, result.costAmount, 'hoursWorked must have zero effect on billing costAmount');
  equal(resultAfterGuardEdit.revenueAmount, result.revenueAmount, 'hoursWorked must have zero effect on billing revenueAmount');
}

// ✓ missing approvedMinutes rejected (contract-pricing side): no verified/approved
// duration at all must yield "not billable", never a silent hoursWorked-derived figure.
async function testContractPricingRejectsMissingApprovedDuration() {
  const service = buildContractPricingService();
  const timesheet = buildBillableTimesheet({ hoursWorked: 999, approvedMinutes: null, approvedHours: null, approvedHoursSnapshot: null });

  const result = service.deriveTimesheetFinancials(timesheet, []);

  equal(result.revenueAmount, null, 'No approved duration must yield a null revenueAmount, never a figure derived from hoursWorked');
  equal(result.costAmount, null, 'No approved duration must yield a null costAmount, never a figure derived from hoursWorked');
}

// RB-007B: fake InvoiceBatchService dependencies, mirroring the payroll-batch harness style.
function buildInvoiceBatchHarness(seedTimesheets: any[]) {
  const timesheetStore = new Map<number, any>(seedTimesheets.map((t) => [t.id, t]));
  let savedBatch: any = null;

  const invoiceBatchRepo = {
    create: (input: any) => ({ id: 900, timesheets: [], ...input }),
    save: async (batch: any) => {
      savedBatch = batch;
      return batch;
    },
    findOne: async () => ({ ...savedBatch, timesheets: Array.from(timesheetStore.values()) }),
    count: async () => 0,
  };
  const timesheetRepo = {
    find: async ({ where }: any) => {
      const ids = (Array.isArray(where) ? where : [where]).map((clause: any) => clause.id);
      return Array.from(timesheetStore.values()).filter((t) => ids.includes(t.id));
    },
    save: async (entities: any[]) => {
      entities.forEach((entity) => timesheetStore.set(entity.id, entity));
      return entities;
    },
  };
  const clientRepo = { findOne: async ({ where }: any) => ({ id: where.id, company: { id: where.company.id }, name: 'Test Client' }) };
  const paymentRecordRepo = {};
  const companyService = { findByUserId: async () => ({ id: 501 }) };
  const contractPricingService = buildContractPricingService();
  const auditLogService = { log: async () => undefined };

  const service = new InvoiceBatchService(
    invoiceBatchRepo as any,
    timesheetRepo as any,
    clientRepo as any,
    paymentRecordRepo as any,
    companyService as any,
    contractPricingService as any,
    auditLogService as any,
  );

  return { service, timesheetStore };
}

// ✓ invoice uses approvedMinutes, ✓ hoursWorked ignored, ✓ invoice totals unchanged after guard edits hoursWorked
async function testInvoiceBatchUsesApprovedMinutesNotHoursWorked() {
  const timesheet = buildBillableTimesheet({ id: 21, hoursWorked: 999, approvedMinutes: 235 });
  const { service } = buildInvoiceBatchHarness([timesheet]);

  const batch = await service.createForCompany(501, {
    clientId: 601,
    periodStart: '2026-01-01',
    periodEnd: '2026-01-07',
    timesheetIds: [21],
  } as any);

  equal(batch.totals.approvedHours, 3.92, 'Invoice batch approvedHours total must derive from approvedMinutes (3.92h), not hoursWorked (999h)');
  equal(batch.totals.invoiceAmount, 98, 'Invoice amount must derive from approvedMinutes-based revenue, not hoursWorked');

  // A guard editing hoursWorked on an already-invoiced timesheet must never move the total:
  // simulate the edit directly on the stored record and recompute the summary.
  timesheet.hoursWorked = 5000000;
  const batchAfterGuardEdit = await service.findOneForCompany(501, batch.id);
  equal(batchAfterGuardEdit.totals.invoiceAmount, 98, 'Invoice total must be unchanged after a guard edits hoursWorked');
  equal(batchAfterGuardEdit.totals.approvedHours, 3.92, 'Invoice hours total must be unchanged after a guard edits hoursWorked');
}

// ✓ missing approvedMinutes rejected (invoice-batch side): creating an invoice batch
// for a timesheet with no approved duration must fail safely, not silently bill $0
// or fall back to hoursWorked.
async function testInvoiceBatchRejectsTimesheetWithNoApprovedDuration() {
  const timesheet = buildBillableTimesheet({
    id: 22,
    hoursWorked: 999,
    approvedMinutes: null,
    approvedHours: null,
    approvedHoursSnapshot: null,
  });
  const { service, timesheetStore } = buildInvoiceBatchHarness([timesheet]);

  await expectBadRequest(() =>
    service.createForCompany(501, {
      clientId: 601,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-07',
      timesheetIds: [22],
    } as any),
  );

  const persisted = timesheetStore.get(22);
  equal(persisted.invoiceBatch, null, 'Rejected invoice creation must not attach the timesheet to a batch');
  equal(persisted.billingStatus, 'uninvoiced', 'Rejected invoice creation must not change billing status');
}

async function main() {
  await testPrivilegedRoleCannotSelfRegister();
  await testInvalidGuardPayloadHasNoSideEffects();
  await testGuardRegistrationRemainsPending();
  await testCompanyRegistrationMapsToCompanyAdmin();
  await testCompanySideRolesCannotEnumerateOrFetchAnyCompany();
  await testPlatformAdminRetainsCompanyDirectoryAccess();
  await testCompanyFindByUserIdNeverResolvesAnotherTenant();
  await testNormalAttendanceApprovalDefaultsToVerifiedMinutes();
  await testManagerOverrideRequiresReasonAndRecordsAudit();
  await testApprovalWithoutOverrideReasonIsRejected();
  await testPayRuleServiceUsesApprovedMinutesNotHoursWorked();
  await testPayrollBatchSnapshotUsesApprovedMinutesNotHoursWorked();
  await testExistingBehaviourPreserved();
  await testContractPricingUsesApprovedMinutesNotHoursWorked();
  await testContractPricingRejectsMissingApprovedDuration();
  await testInvoiceBatchUsesApprovedMinutesNotHoursWorked();
  await testInvoiceBatchRejectsTimesheetWithNoApprovedDuration();
  assertColumnExcluded(User, 'passwordHash', 'User.passwordHash');
  assertColumnExcluded(ClientPortalUser, 'passwordHash', 'ClientPortalUser.passwordHash');
  assertColumnExcluded(Site, 'attendanceNfcTag', 'Site.attendanceNfcTag');
  assertColumnExcluded(AttendanceEvent, 'nfcTag', 'AttendanceEvent.nfcTag');

  console.log(
    JSON.stringify({
      event: 'release_smoke_passed',
      tests: 21,
      scope:
        'auth-registration-credential-attendance-secret-exposure-RB006-tenant-isolation-RB007-payroll-integrity-and-RB007B-client-billing-integrity',
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
