/**
 * P1H-C Controlled Client Billing Re-approval — Dedicated spec.
 *
 * Proves the complete six-layer evidence model is correctly implemented:
 *
 * Layer 1: Scheduled shift (immutable)
 * Layer 2: Attendance evidence (immutable)
 * Layer 3: Guard claim (immutable post-submit)
 * Layer 4: Company Guard-pay approval (payroll-authoritative; frozen after Client submission)
 * Layer 5: Company Client-billing correction (P1H-C only; cleared at resubmit)
 * Layer 6: Client-submitted snapshot (immutable per version)
 *
 * Run: ts-node -r tsconfig-paths/register scripts/p1hc-re-approval.spec.ts
 */
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ValidationPipe } from '@nestjs/common';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ClientWeeklyApprovalStatus } from '../src/client-weekly-approval/entities/client-weekly-approval-request.entity';
import { ClientShiftDisputeStatus } from '../src/client-weekly-approval/entities/client-shift-dispute.entity';
import { TimesheetStatus, TimesheetBillingStatus } from '../src/timesheet/entities/timesheet.entity';
import { ClientWeeklyApprovalService } from '../src/client-weekly-approval/client-weekly-approval.service';
import { ReviseApprovedTimeDto } from '../src/client-weekly-approval/dto/revise-approved-time.dto';

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
const results = { pass: 0, fail: 0, failures: [] as string[] };
const test = (name: string, run: Test['run']) => tests.push({ name, run });
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };

const backend = (file: string) => readFileSync(resolve(__dirname, '../src', file), 'utf8');
const mobile  = (file: string) => readFileSync(resolve(__dirname, '../../security-mobile-app/src', file), 'utf8');

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

// ═══════════════════════════════════════════════════════
// MIGRATION CORRECTNESS
// ═══════════════════════════════════════════════════════

test('MC-1 migration: file 1720800000004 exists and has no conflicts with 1720800000003', () => {
  const m4 = backend('database/migrations/1720800000004-AddClientBillingApprovalFields.ts');
  const m3 = backend('database/migrations/1720800000003-AddCompanyApprovedTimes.ts');
  assert(m4.includes('1720800000004'), 'Migration file must reference timestamp 1720800000004');
  assert(m4.includes('AddClientBillingApprovalFields1720800000004'), 'Migration class name must include timestamp');
  assert(!m3.includes('clientBillingApproved'), 'Migration 1720800000003 must not reference P1H-C fields');
});

test('MC-2 migration: all four Layer 5 columns present in up()', () => {
  const m = backend('database/migrations/1720800000004-AddClientBillingApprovalFields.ts');
  assert(m.includes('"clientBillingApprovedStartAt"'), 'clientBillingApprovedStartAt missing from migration');
  assert(m.includes('"clientBillingApprovedEndAt"'), 'clientBillingApprovedEndAt missing from migration');
  assert(m.includes('"clientBillingApprovedMinutes"'), 'clientBillingApprovedMinutes missing from migration');
  assert(m.includes('"clientBillingCorrectionReason"'), 'clientBillingCorrectionReason missing from migration');
});

test('MC-3 migration: idx_cwal_timesheet_superseded index created', () => {
  const m = backend('database/migrations/1720800000004-AddClientBillingApprovalFields.ts');
  assert(m.includes('idx_cwal_timesheet_superseded'), 'Index for freeze check missing from migration');
  assert(m.includes('"timesheetId", "superseded"'), 'Index must include both timesheetId and superseded');
});

test('MC-4 migration: IF NOT EXISTS / IF EXISTS guards for idempotency', () => {
  const m = backend('database/migrations/1720800000004-AddClientBillingApprovalFields.ts');
  assert(m.includes('ADD IF NOT EXISTS'), 'ADD IF NOT EXISTS missing — migration not idempotent');
  assert(m.includes('DROP COLUMN IF EXISTS'), 'DROP COLUMN IF EXISTS missing — down() not idempotent');
  assert(m.includes('DROP INDEX IF EXISTS'), 'DROP INDEX IF EXISTS missing — down() not idempotent');
});

test('MC-5 migration: columns are NULL (no default required)', () => {
  const m = backend('database/migrations/1720800000004-AddClientBillingApprovalFields.ts');
  assert(m.includes('TIMESTAMP NULL'), 'Start/end columns must be nullable TIMESTAMP');
  assert(m.includes('INTEGER NULL'), 'Minutes column must be nullable INTEGER');
  assert(m.includes('TEXT NULL'), 'Reason column must be nullable TEXT');
});

// ═══════════════════════════════════════════════════════
// SIX-LAYER ENTITY MODEL
// ═══════════════════════════════════════════════════════

test('L4-1 entity: Layer 4 payroll fields exist on Timesheet', () => {
  const entity = backend('timesheet/entities/timesheet.entity.ts');
  assert(entity.includes('approvedMinutes'), 'approvedMinutes missing — Layer 4 payroll field');
  assert(entity.includes('approvedHours'), 'approvedHours missing — Layer 4 payroll field');
  assert(entity.includes('companyApprovedStartAt'), 'companyApprovedStartAt missing — Layer 4 field');
  assert(entity.includes('companyApprovedEndAt'), 'companyApprovedEndAt missing — Layer 4 field');
  assert(entity.includes('overrideReason'), 'overrideReason missing — Layer 4 audit field');
});

test('L5-1 entity: Layer 5 billing correction fields exist on Timesheet', () => {
  const entity = backend('timesheet/entities/timesheet.entity.ts');
  assert(entity.includes('clientBillingApprovedStartAt'), 'clientBillingApprovedStartAt missing — Layer 5 field');
  assert(entity.includes('clientBillingApprovedEndAt'), 'clientBillingApprovedEndAt missing — Layer 5 field');
  assert(entity.includes('clientBillingApprovedMinutes'), 'clientBillingApprovedMinutes missing — Layer 5 field');
  assert(entity.includes('clientBillingCorrectionReason'), 'clientBillingCorrectionReason missing — Layer 5 field');
});

test('L5-2 entity: Layer 5 fields are nullable (no payroll impact on existing rows)', () => {
  const entity = backend('timesheet/entities/timesheet.entity.ts');
  const l5Block = entity.match(/clientBillingApproved[\s\S]{0,500}clientBillingCorrectionReason/)?.[0] ?? '';
  assert(l5Block.includes('nullable: true'), 'Layer 5 fields must be nullable');
});

test('L6-1 entity: Layer 6 snapshot fields on ClientWeeklyApprovalLine', () => {
  const entity = backend('client-weekly-approval/entities/client-weekly-approval-line.entity.ts');
  assert(entity.includes('approvedHoursAtSubmission'), 'approvedHoursAtSubmission missing — Layer 6 snapshot');
  assert(entity.includes('companyApprovedStartAtSubmission'), 'companyApprovedStartAtSubmission missing — Layer 6 snapshot');
  assert(entity.includes('companyApprovedEndAtSubmission'), 'companyApprovedEndAtSubmission missing — Layer 6 snapshot');
  assert(entity.includes('superseded'), 'superseded flag missing from approval line entity');
  assert(entity.includes('submissionVersion'), 'submissionVersion missing from approval line entity');
});

// ═══════════════════════════════════════════════════════
// GENERIC PATCH FREEZE (Layer 4 protection)
// ═══════════════════════════════════════════════════════

test('FRZ-1 freeze: approvedTimeUpdate branch contains active-line freeze check', () => {
  const svc = backend('timesheet/timesheet.service.ts');
  assert(svc.includes('client_weekly_approval_lines'), 'Freeze check must query client_weekly_approval_lines');
  assert(svc.includes('"superseded" = FALSE'), 'Freeze check must filter for non-superseded lines');
  assert(svc.includes('ForbiddenException'), 'Freeze check must throw ForbiddenException');
});

test('FRZ-2 freeze: freeze error message references billing correction workflow', () => {
  const svc = backend('timesheet/timesheet.service.ts');
  assert(
    svc.includes('controlled Client billing correction workflow'),
    'Freeze error message must guide user to P1H-C endpoint',
  );
  assert(
    svc.includes('after Client submission'),
    'Freeze error message must reference Client submission as the trigger',
  );
});

test('FRZ-3 freeze: freeze check is INSIDE the approvedTimeUpdate branch', () => {
  const svc = backend('timesheet/timesheet.service.ts');
  // Extract only the content of the `if (approvedTimeUpdate) { ... }` block
  const blockStart = svc.indexOf('if (approvedTimeUpdate) {');
  assert(blockStart !== -1, 'if (approvedTimeUpdate) block must exist');
  // The block ends when we hit the next top-level else/conditional at the same level
  // Use a generous slice (2000 chars) to capture the full block content
  const blockContent = svc.slice(blockStart, blockStart + 2000);
  assert(
    blockContent.includes('client_weekly_approval_lines'),
    'Freeze check must appear INSIDE the if (approvedTimeUpdate) block',
  );
  assert(
    blockContent.includes('ForbiddenException'),
    'ForbiddenException must be thrown from INSIDE the if (approvedTimeUpdate) block',
  );
});

// ═══════════════════════════════════════════════════════
// P1H-C ENDPOINT — DTO VALIDATION
// ═══════════════════════════════════════════════════════

test('DTO-1 dto: ReviseApprovedTimeDto exists and exports', () => {
  const dto = backend('client-weekly-approval/dto/revise-approved-time.dto.ts');
  assert(dto.includes('ReviseApprovedTimeDto'), 'ReviseApprovedTimeDto class missing');
  assert(dto.includes('timesheetId'), 'timesheetId field missing');
  assert(dto.includes('newBillingStartAt'), 'newBillingStartAt field missing');
  assert(dto.includes('newBillingEndAt'), 'newBillingEndAt field missing');
  assert(dto.includes('clientCorrectionReason'), 'clientCorrectionReason field missing');
});

test('DTO-2 dto: validation rejects blank correction reason', async () => {
  let threw = false;
  try {
    await pipe.transform(
      { timesheetId: 1, newBillingStartAt: '2026-01-12T08:00:00Z', newBillingEndAt: '2026-01-12T15:00:00Z', clientCorrectionReason: '' },
      { type: 'body', metatype: ReviseApprovedTimeDto },
    );
  } catch { threw = true; }
  assert(threw, 'Empty clientCorrectionReason must be rejected');
});

test('DTO-3 dto: validation rejects missing timesheetId', async () => {
  let threw = false;
  try {
    await pipe.transform(
      { newBillingStartAt: '2026-01-12T08:00:00Z', newBillingEndAt: '2026-01-12T15:00:00Z', clientCorrectionReason: 'reason' },
      { type: 'body', metatype: ReviseApprovedTimeDto },
    );
  } catch { threw = true; }
  assert(threw, 'Missing timesheetId must be rejected');
});

test('DTO-4 dto: validation rejects invalid ISO date', async () => {
  let threw = false;
  try {
    await pipe.transform(
      { timesheetId: 1, newBillingStartAt: 'not-a-date', newBillingEndAt: '2026-01-12T15:00:00Z', clientCorrectionReason: 'reason' },
      { type: 'body', metatype: ReviseApprovedTimeDto },
    );
  } catch { threw = true; }
  assert(threw, 'Invalid ISO date must be rejected');
});

test('DTO-5 dto: validation accepts valid payload', async () => {
  let threw = false;
  try {
    await pipe.transform(
      { timesheetId: 1, newBillingStartAt: '2026-01-12T08:00:00Z', newBillingEndAt: '2026-01-12T15:00:00Z', clientCorrectionReason: 'Client dispute confirmed' },
      { type: 'body', metatype: ReviseApprovedTimeDto },
    );
  } catch { threw = true; }
  assert(!threw, 'Valid ReviseApprovedTimeDto was rejected');
});

// ═══════════════════════════════════════════════════════
// P1H-C SERVICE — SOURCE INSPECTION
// ═══════════════════════════════════════════════════════

test('SVC-1 service: reviseApprovedTime method exists in service', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('reviseApprovedTime'), 'reviseApprovedTime method missing from service');
  assert(svc.includes('ReviseApprovedTimeDto'), 'ReviseApprovedTimeDto not imported in service');
});

test('SVC-2 service: gate — request must be DISPUTED', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(
    svc.includes('ClientWeeklyApprovalStatus.DISPUTED') && svc.includes("DISPUTED requests"),
    'Service must gate on DISPUTED status',
  );
});

test('SVC-3 service: gate — OPEN dispute required for this timesheet/version', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('openDispute'), 'openDispute lookup missing');
  assert(svc.includes('No open dispute found'), 'Error message for missing open dispute missing');
});

test('SVC-4 service: gate — correction reason must be non-empty', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('Correction reason is required'), 'Blank reason gate missing in service');
});

test('SVC-5 service: gate — billing end must be after billing start', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('Billing end must be after billing start'), 'Date order validation missing in service');
});

test('SVC-6 service: gate — not invoiced check present', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('already invoiced'), 'Invoice check missing in reviseApprovedTime');
});

test('SVC-7 service: writes ONLY Layer 5 — approvedMinutes not touched', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  // The reviseApprovedTime method must not assign to approvedMinutes
  // (The existing P1H T52 test already checks the whole service; here we check the specific update SQL)
  assert(
    svc.includes('clientBillingApprovedStartAt') && svc.includes('clientBillingApprovedEndAt'),
    'Layer 5 fields must be written in reviseApprovedTime',
  );
  assert(
    !svc.includes('"approvedMinutes" = $'),
    'reviseApprovedTime must not write to approvedMinutes via SQL',
  );
});

test('SVC-8 service: audit event client_billing_correction_applied emitted', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(
    svc.includes("'timesheet.client_billing_correction_applied'"),
    "Audit event 'timesheet.client_billing_correction_applied' missing",
  );
  assert(svc.includes('relatedDisputeId'), 'Audit must link to related dispute');
  assert(svc.includes('relatedRequestId'), 'Audit must link to related request');
  assert(svc.includes('requestVersion'), 'Audit must record request version');
});

test('SVC-9 service: uses FOR UPDATE row lock in reviseApprovedTime transaction', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  const reviseBlock = svc.slice(svc.indexOf('reviseApprovedTime'));
  assert(reviseBlock.includes('FOR UPDATE'), 'reviseApprovedTime must lock the timesheet row');
});

// ═══════════════════════════════════════════════════════
// RESUBMIT — LAYER 5 PREFERENCE + LAYER 5 CLEAR
// ═══════════════════════════════════════════════════════

test('RSB-1 resubmit: prefers Layer 5 when clientBillingApprovedMinutes is set', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(
    svc.includes('clientBillingApprovedMinutes != null'),
    'resubmit() must check clientBillingApprovedMinutes before choosing billing hours',
  );
});

test('RSB-2 resubmit: uses clientBillingApprovedStartAt for new line snapshot when set', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(
    svc.includes('clientBillingApprovedStartAt') && svc.includes('billingStart'),
    'resubmit() must use clientBillingApprovedStartAt for the line snapshot',
  );
});

test('RSB-3 resubmit: falls back to Layer 4 when Layer 5 is null', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(
    svc.includes('ts.approvedMinutes') && svc.includes('billingMinutes'),
    'resubmit() must fall back to approvedMinutes when clientBillingApprovedMinutes is null',
  );
});

test('RSB-4 resubmit: Layer 5 fields cleared after creating new lines', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(
    svc.includes('"clientBillingApprovedStartAt" = NULL'),
    'clientBillingApprovedStartAt must be cleared after resubmit',
  );
  assert(
    svc.includes('"clientBillingApprovedMinutes" = NULL'),
    'clientBillingApprovedMinutes must be cleared after resubmit',
  );
});

test('RSB-5 resubmit: clear happens inside the SAME transaction as line creation', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  const resubmitFn = svc.slice(svc.indexOf('async resubmit('), svc.indexOf('async reviseApprovedTime('));
  const linesSaveIdx = resubmitFn.indexOf('lineRepo.save(newLines)');
  const clearIdx = resubmitFn.indexOf('"clientBillingApprovedStartAt" = NULL');
  assert(clearIdx > linesSaveIdx, 'Layer 5 clear must happen after new lines are saved, within same transaction');
  assert(
    resubmitFn.includes('dataSource.transaction'),
    'resubmit must use a transaction (Layer 5 clear must be atomic with line creation)',
  );
});

test('RSB-6 resubmit: audit event for Layer 5 clear emitted', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(
    svc.includes("'timesheet.client_billing_correction_cleared'"),
    "Audit event 'timesheet.client_billing_correction_cleared' missing",
  );
  assert(svc.includes('capturedInVersion'), 'Clear audit must record capturedInVersion');
});

// ═══════════════════════════════════════════════════════
// PAYROLL INDEPENDENCE
// ═══════════════════════════════════════════════════════

test('PAY-1 payroll: reviseApprovedTime does not modify approvedMinutes/approvedHours', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  // Locate the reviseApprovedTime method block only
  const reviseBlock = svc.slice(
    svc.indexOf('async reviseApprovedTime('),
    svc.indexOf('async getEligibleTimesheets('),
  );
  assert(!reviseBlock.includes('approvedMinutes ='), 'reviseApprovedTime must not set approvedMinutes');
  assert(!reviseBlock.includes('approvedHours ='), 'reviseApprovedTime must not set approvedHours');
  assert(!reviseBlock.includes('overrideReason ='), 'reviseApprovedTime must not set overrideReason');
  assert(!reviseBlock.includes('overrideBy ='), 'reviseApprovedTime must not set overrideBy');
});

test('PAY-2 payroll: payroll gate NOT blocking P1H-C (billing correction allowed with existing payroll)', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  const reviseBlock = svc.slice(
    svc.indexOf('async reviseApprovedTime('),
    svc.indexOf('async getEligibleTimesheets('),
  );
  // No payroll batch check in reviseApprovedTime — by design, billing correction
  // can be applied even after payroll is committed (they are independent)
  assert(!reviseBlock.includes('payrollBatch'), 'reviseApprovedTime must NOT block on payrollBatch (payroll is independent)');
  assert(!reviseBlock.includes('payrollStatus'), 'reviseApprovedTime must NOT block on payrollStatus');
});

test('PAY-3 payroll: approvedHoursSnapshot (payroll) uses approvedMinutes, not Layer 5', () => {
  const invoiceSvc = backend('invoice-batch/invoice-batch.service.ts');
  assert(
    invoiceSvc.includes('approvedMinutes != null ? Number(timesheet.approvedMinutes) / 60'),
    'approvedHoursSnapshot must derive from approvedMinutes (payroll-authoritative), not Layer 5',
  );
});

test('PAY-4 payroll: clientBilledHoursSnapshot uses Layer 6 approval line snapshot', () => {
  const invoiceSvc = backend('invoice-batch/invoice-batch.service.ts');
  assert(
    invoiceSvc.includes('approvedHoursAtSubmission'),
    'clientBilledHoursSnapshot must use approvedHoursAtSubmission from the approval line (Layer 6)',
  );
  assert(
    invoiceSvc.includes('clientBilledHoursSnapshot'),
    'clientBilledHoursSnapshot field must be set in invoice-batch service',
  );
});

// ═══════════════════════════════════════════════════════
// RBAC / TENANT ISOLATION
// ═══════════════════════════════════════════════════════

test('RBAC-1 controller: revise-approved-time route exists on controller', () => {
  const ctrl = backend('client-weekly-approval/client-weekly-approval.controller.ts');
  assert(ctrl.includes('revise-approved-time'), 'revise-approved-time route missing from controller');
  assert(ctrl.includes('@Patch'), '@Patch decorator missing');
  assert(ctrl.includes('ReviseApprovedTimeDto'), 'ReviseApprovedTimeDto not used in controller');
});

test('RBAC-2 controller: revise-approved-time uses COMPANY_ADMIN_ROLES', () => {
  const ctrl = backend('client-weekly-approval/client-weekly-approval.controller.ts');
  // Find the route decorated with revise-approved-time (the path appears inside ':id/revise-approved-time')
  const routeIdx = ctrl.indexOf('revise-approved-time');
  assert(routeIdx !== -1, 'revise-approved-time route not found in controller');
  // @Roles(...COMPANY_ADMIN_ROLES) immediately follows the @Patch decorator on the next line
  const routeBlock = ctrl.slice(routeIdx, routeIdx + 300);
  assert(
    routeBlock.includes('COMPANY_ADMIN_ROLES'),
    'revise-approved-time must be guarded by COMPANY_ADMIN_ROLES',
  );
});

test('RBAC-3 tenant: requireCompany called in reviseApprovedTime', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  const reviseBlock = svc.slice(
    svc.indexOf('async reviseApprovedTime('),
    svc.indexOf('async getEligibleTimesheets('),
  );
  assert(reviseBlock.includes('requireCompany'), 'requireCompany must be called in reviseApprovedTime');
});

test('RBAC-4 tenant: company.id used to scope request lookup', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  const reviseBlock = svc.slice(
    svc.indexOf('async reviseApprovedTime('),
    svc.indexOf('async getEligibleTimesheets('),
  );
  assert(
    reviseBlock.includes('company: { id: company.id }'),
    'Request lookup must be scoped to company.id to prevent cross-tenant access',
  );
});

// ═══════════════════════════════════════════════════════
// DATA BOUNDARY — CLIENT CANNOT SEE CORRECTION REASON
// ═══════════════════════════════════════════════════════

test('DATA-1 boundary: clientBillingCorrectionReason not exposed in client portal service', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  const dtoBlock = svc.match(/toClientDetailDto[\s\S]{0,3000}/)?.[0] ?? svc;
  assert(
    !dtoBlock.includes('clientBillingCorrectionReason:'),
    'clientBillingCorrectionReason must NOT be included in client-facing DTO',
  );
});

test('DATA-2 boundary: clientBillingApprovedMinutes not exposed in client portal service', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  const dtoBlock = svc.match(/toClientDetailDto[\s\S]{0,3000}/)?.[0] ?? svc;
  assert(
    !dtoBlock.includes('clientBillingApprovedMinutes:'),
    'clientBillingApprovedMinutes (pending correction) must NOT be in client-facing DTO',
  );
});

// ═══════════════════════════════════════════════════════
// MOBILE UX
// ═══════════════════════════════════════════════════════

test('MOB-1 mobile: reviseApprovedTime API call exists', () => {
  const api = mobile('services/api.ts');
  assert(api.includes('reviseApprovedTime'), 'reviseApprovedTime function missing from api.ts');
  assert(api.includes('revise-approved-time'), 'revise-approved-time endpoint path missing from api.ts');
  assert(api.includes('clientCorrectionReason'), 'clientCorrectionReason missing from API call payload');
});

test('MOB-2 mobile: Layer 5 fields added to CompanyApprovalLine type', () => {
  const models = mobile('types/models.ts');
  assert(models.includes('clientBillingApprovedMinutes'), 'clientBillingApprovedMinutes missing from CompanyApprovalLine type');
  assert(models.includes('clientBillingApprovedStartAt'), 'clientBillingApprovedStartAt missing from CompanyApprovalLine type');
  assert(models.includes('clientBillingCorrectionReason'), 'clientBillingCorrectionReason missing from CompanyApprovalLine type');
});

test('MOB-3 mobile: billing correction handler exists on screen', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('handleBillingCorrection'), 'handleBillingCorrection handler missing');
  assert(screen.includes('reviseApprovedTime'), 'reviseApprovedTime not called in screen');
});

test('MOB-4 mobile: Adjust Billing Hours button shown for DISPUTED requests with open dispute', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('Adjust Billing Hours'), '"Adjust Billing Hours" label missing from screen');
  assert(
    screen.includes("detail.status === 'disputed'"),
    'Billing correction button must only show for disputed requests',
  );
});

test('MOB-5 mobile: billing correction form has correction reason field', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('billingCorrectionReason'), 'billingCorrectionReason state missing from screen');
  assert(screen.includes('Save Billing Correction'), '"Save Billing Correction" button label missing');
});

test('MOB-6 mobile: Layer 5 pending correction shown as CLIENT BILLING CORRECTION, not as payroll', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('CLIENT BILLING CORRECTION'), 'Layer 5 section label must say CLIENT BILLING CORRECTION');
  assert(
    screen.includes('CLIENT BILLING') && !screen.includes('PAYROLL CORRECTION'),
    'Must label billing correction as CLIENT BILLING, not PAYROLL',
  );
});

test('MOB-7 mobile: Guard pay label clearly separate from billing correction', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('COMPANY GUARD-PAY APPROVAL'), 'Layer D must clearly label Guard pay approval separately');
  assert(screen.includes('Guard pay'), 'Pending billing correction display must note that guard pay is unchanged');
});

test('MOB-8 mobile: billing correction form warns about payroll independence', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(
    screen.includes('CLIENT BILLING ONLY') && screen.includes('Guard pay remains unchanged'),
    'Form must warn that this is a billing-only change and guard pay is unchanged',
  );
});

// ═══════════════════════════════════════════════════════
// CONCURRENCY
// ═══════════════════════════════════════════════════════

test('CON-1 concurrency: resubmit uses FOR UPDATE row locking', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  const resubmitFn = svc.slice(svc.indexOf('async resubmit('), svc.indexOf('async reviseApprovedTime('));
  assert(resubmitFn.includes('FOR UPDATE'), 'resubmit() must lock timesheet rows for concurrency safety');
});

test('CON-2 concurrency: reviseApprovedTime uses FOR UPDATE row locking', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  const reviseBlock = svc.slice(
    svc.indexOf('async reviseApprovedTime('),
    svc.indexOf('async getEligibleTimesheets('),
  );
  assert(reviseBlock.includes('FOR UPDATE'), 'reviseApprovedTime() must lock the timesheet row');
});

test('CON-3 concurrency: createSubmission uses FOR UPDATE (TOCTOU prevention)', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  const createBlock = svc.slice(svc.indexOf('async createSubmission('), svc.indexOf('async listForCompany('));
  assert(createBlock.includes('FOR UPDATE'), 'createSubmission() must lock timesheets to prevent TOCTOU with PATCH');
});

test('CON-4 concurrency: Layer 5 clear inside transaction with line save', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  const resubmitFn = svc.slice(svc.indexOf('async resubmit('), svc.indexOf('async reviseApprovedTime('));
  assert(
    resubmitFn.includes('"clientBillingApprovedMinutes" = NULL'),
    'Layer 5 clear must be inside the resubmit transaction',
  );
});

// ═══════════════════════════════════════════════════════
// VERSIONING INVARIANTS
// ═══════════════════════════════════════════════════════

test('VER-1 versioning: resubmit supersedes old lines before creating new ones', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  const resubmitFn = svc.slice(svc.indexOf('async resubmit('), svc.indexOf('async reviseApprovedTime('));
  const supersededIdx = resubmitFn.indexOf('"superseded" = TRUE');
  const newLinesIdx = resubmitFn.indexOf('lineRepo.create({');
  assert(supersededIdx !== -1, 'resubmit() must set superseded = TRUE on old lines');
  assert(newLinesIdx !== -1, 'resubmit() must create new lines');
  assert(supersededIdx < newLinesIdx, 'Old lines must be superseded before new lines are created');
});

test('VER-2 versioning: V1 snapshot not modified by reviseApprovedTime', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  const reviseBlock = svc.slice(
    svc.indexOf('async reviseApprovedTime('),
    svc.indexOf('async getEligibleTimesheets('),
  );
  // reviseApprovedTime must not update any approval_lines columns
  assert(!reviseBlock.includes('approval_lines'), 'reviseApprovedTime must NOT modify approval lines (Layer 6 is immutable)');
  assert(!reviseBlock.includes('approvedHoursAtSubmission'), 'reviseApprovedTime must NOT touch approvedHoursAtSubmission');
});

test('VER-3 versioning: submissionVersion incremented on resubmit', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('newVersion = request.currentVersion + 1'), 'currentVersion must increment on resubmit');
});

// ═══════════════════════════════════════════════════════
// FUNCTIONAL HARNESS — reviseApprovedTime unit tests
// ═══════════════════════════════════════════════════════

function buildP1HCServiceHarness() {
  const auditLogs: any[] = [];
  const dbRows = new Map<number, any>();
  const queryLog: string[] = [];

  const makeRequest = (overrides: any = {}) => ({
    id: 100,
    status: ClientWeeklyApprovalStatus.DISPUTED,
    currentVersion: 1,
    company: { id: 501 },
    ...overrides,
  });
  const makeDispute = (overrides: any = {}) => ({
    id: 200,
    weeklyApprovalRequest: { id: 100 },
    timesheet: { id: 1 },
    submissionVersion: 1,
    status: ClientShiftDisputeStatus.OPEN,
    ...overrides,
  });
  const makeTimesheet = (overrides: any = {}) => ({
    id: 1,
    company: { id: 501 },
    approvalStatus: TimesheetStatus.APPROVED,
    billingStatus: TimesheetBillingStatus.UNINVOICED,
    invoiceBatch: null,
    approvedMinutes: 450,
    approvedHours: 7.5,
    companyApprovedStartAt: new Date('2026-01-12T08:00:00Z'),
    companyApprovedEndAt: new Date('2026-01-12T15:30:00Z'),
    overrideReason: null,
    clientBillingApprovedMinutes: null,
    clientBillingApprovedStartAt: null,
    clientBillingApprovedEndAt: null,
    clientBillingCorrectionReason: null,
    ...overrides,
  });

  let requestOverride: any = null;
  let disputeOverride: any = null;
  let timesheetOverride: any = null;

  const manager = {
    getRepository: (entity: any) => {
      const name = typeof entity === 'function' ? entity.name : '';
      if (name === 'ClientWeeklyApprovalRequest') {
        return {
          findOne: async () => requestOverride ?? makeRequest(),
        };
      }
      if (name === 'ClientShiftDispute') {
        return {
          findOne: async () => disputeOverride,
        };
      }
      if (name === 'Timesheet') {
        return {
          findOne: async () => timesheetOverride ?? makeTimesheet(),
        };
      }
      return {};
    },
    query: async (sql: string, _params?: any[]) => {
      queryLog.push(sql.trim());
      return [{ count: 0 }];
    },
  };

  const dataSource = {
    transaction: async (work: (m: any) => Promise<any>) => work(manager),
  };

  const companyService = { findByUserId: async (id: number) => id === 501 ? { id: 501 } : null };
  const auditLogService = { log: async (entry: any) => { auditLogs.push(entry); } };

  const service = new ClientWeeklyApprovalService(
    {} as any, {} as any, {} as any,
    companyService as any,
    auditLogService as any,
    dataSource as any,
  );

  return {
    service, auditLogs, queryLog,
    setRequest: (r: any) => { requestOverride = r; },
    setDispute: (d: any) => { disputeOverride = d; },
    setTimesheet: (t: any) => { timesheetOverride = t; },
    makeRequest, makeDispute, makeTimesheet,
  };
}

test('UNIT-1 unit: reviseApprovedTime succeeds with valid inputs', async () => {
  const h = buildP1HCServiceHarness();
  h.setDispute(h.makeDispute());
  const result = await h.service.reviseApprovedTime(501, 100, {
    timesheetId: 1,
    newBillingStartAt: '2026-01-12T08:00:00Z',
    newBillingEndAt: '2026-01-12T15:00:00Z',
    clientCorrectionReason: 'Client confirmed guard left at 15:00',
  });
  assert(result.message === 'Client billing correction applied.', 'Expected success message');
});

test('UNIT-2 unit: reviseApprovedTime emits correct audit event', async () => {
  const h = buildP1HCServiceHarness();
  h.setDispute(h.makeDispute({ id: 200 }));
  await h.service.reviseApprovedTime(501, 100, {
    timesheetId: 1,
    newBillingStartAt: '2026-01-12T08:00:00Z',
    newBillingEndAt: '2026-01-12T15:00:00Z',
    clientCorrectionReason: 'Test reason',
  });
  const auditEntry = h.auditLogs.find((e) => e.action === 'timesheet.client_billing_correction_applied');
  assert(auditEntry, 'Audit event client_billing_correction_applied must be emitted');
  assert(auditEntry.afterData.relatedDisputeId === 200, 'Audit must link to dispute');
  assert(auditEntry.afterData.relatedRequestId === 100, 'Audit must link to request');
  assert(auditEntry.afterData.clientBillingApprovedMinutes === 420, 'Audit must record 7h = 420 min');
});

test('UNIT-3 unit: reviseApprovedTime rejects non-DISPUTED request', async () => {
  const h = buildP1HCServiceHarness();
  h.setRequest(h.makeRequest({ status: ClientWeeklyApprovalStatus.PENDING_APPROVAL }));
  h.setDispute(h.makeDispute());
  let threw: any = null;
  try {
    await h.service.reviseApprovedTime(501, 100, {
      timesheetId: 1, newBillingStartAt: '2026-01-12T08:00:00Z', newBillingEndAt: '2026-01-12T15:00:00Z',
      clientCorrectionReason: 'reason',
    });
  } catch (e) { threw = e; }
  assert(threw instanceof BadRequestException, 'Must throw BadRequestException for non-DISPUTED request');
});

test('UNIT-4 unit: reviseApprovedTime rejects when no open dispute for timesheet', async () => {
  const h = buildP1HCServiceHarness();
  h.setDispute(null);
  let threw: any = null;
  try {
    await h.service.reviseApprovedTime(501, 100, {
      timesheetId: 1, newBillingStartAt: '2026-01-12T08:00:00Z', newBillingEndAt: '2026-01-12T15:00:00Z',
      clientCorrectionReason: 'reason',
    });
  } catch (e) { threw = e; }
  assert(threw instanceof BadRequestException, 'Must throw BadRequestException when no open dispute');
  assert(String(threw.message).includes('No open dispute'), 'Error message must mention missing dispute');
});

test('UNIT-5 unit: reviseApprovedTime rejects end <= start', async () => {
  const h = buildP1HCServiceHarness();
  h.setDispute(h.makeDispute());
  let threw: any = null;
  try {
    await h.service.reviseApprovedTime(501, 100, {
      timesheetId: 1,
      newBillingStartAt: '2026-01-12T15:00:00Z',
      newBillingEndAt: '2026-01-12T08:00:00Z',
      clientCorrectionReason: 'reason',
    });
  } catch (e) { threw = e; }
  assert(threw instanceof BadRequestException, 'Must throw BadRequestException for end <= start');
  assert(String(threw.message).includes('after'), 'Error message must mention end-after-start requirement');
});

test('UNIT-6 unit: reviseApprovedTime rejects blank correction reason', async () => {
  const h = buildP1HCServiceHarness();
  h.setDispute(h.makeDispute());
  let threw: any = null;
  try {
    await h.service.reviseApprovedTime(501, 100, {
      timesheetId: 1,
      newBillingStartAt: '2026-01-12T08:00:00Z',
      newBillingEndAt: '2026-01-12T15:00:00Z',
      clientCorrectionReason: '   ',
    });
  } catch (e) { threw = e; }
  assert(threw instanceof BadRequestException, 'Must throw BadRequestException for whitespace-only reason');
});

test('UNIT-7 unit: reviseApprovedTime rejects invoiced timesheet', async () => {
  const h = buildP1HCServiceHarness();
  h.setDispute(h.makeDispute());
  h.setTimesheet(h.makeTimesheet({ billingStatus: TimesheetBillingStatus.INCLUDED, invoiceBatch: { id: 99 } }));
  let threw: any = null;
  try {
    await h.service.reviseApprovedTime(501, 100, {
      timesheetId: 1, newBillingStartAt: '2026-01-12T08:00:00Z', newBillingEndAt: '2026-01-12T15:00:00Z',
      clientCorrectionReason: 'reason',
    });
  } catch (e) { threw = e; }
  assert(threw instanceof BadRequestException, 'Must throw BadRequestException for invoiced timesheet');
  assert(String(threw.message).includes('invoiced'), 'Error message must mention invoice state');
});

test('UNIT-8 unit: reviseApprovedTime succeeds even if timesheet has a payroll batch (payroll is independent)', async () => {
  const h = buildP1HCServiceHarness();
  h.setDispute(h.makeDispute());
  // Timesheet in a payroll batch — billing correction must still succeed
  h.setTimesheet(h.makeTimesheet({ payrollBatch: { id: 77 }, payrollStatus: 'included' }));
  let threw = false;
  try {
    await h.service.reviseApprovedTime(501, 100, {
      timesheetId: 1, newBillingStartAt: '2026-01-12T08:00:00Z', newBillingEndAt: '2026-01-12T15:00:00Z',
      clientCorrectionReason: 'Client confirmed 7h; guard payroll already processed at 7.5h',
    });
  } catch { threw = true; }
  assert(!threw, 'reviseApprovedTime must succeed even when a payroll batch exists (payroll independence)');
});

test('UNIT-9 unit: reviseApprovedTime rejects when company not found', async () => {
  const h = buildP1HCServiceHarness();
  h.setDispute(h.makeDispute());
  let threw: any = null;
  try {
    await h.service.reviseApprovedTime(999, 100, {
      timesheetId: 1, newBillingStartAt: '2026-01-12T08:00:00Z', newBillingEndAt: '2026-01-12T15:00:00Z',
      clientCorrectionReason: 'reason',
    });
  } catch (e) { threw = e; }
  assert(threw instanceof NotFoundException, 'Must throw NotFoundException when company not found');
});

test('UNIT-10 unit: computed billing minutes correct for 7h window', async () => {
  const h = buildP1HCServiceHarness();
  h.setDispute(h.makeDispute());
  await h.service.reviseApprovedTime(501, 100, {
    timesheetId: 1,
    newBillingStartAt: '2026-01-12T08:00:00Z',
    newBillingEndAt: '2026-01-12T15:00:00Z',
    clientCorrectionReason: 'Client dispute confirmed',
  });
  const auditEntry = h.auditLogs.find((e) => e.action === 'timesheet.client_billing_correction_applied');
  assert(auditEntry, 'Audit entry must exist');
  assert(
    auditEntry.afterData.clientBillingApprovedMinutes === 420,
    `Expected 420 minutes (7h), got ${auditEntry.afterData.clientBillingApprovedMinutes}`,
  );
});

// ═══════════════════════════════════════════════════════
// RELEASE CHAIN INCLUSION
// ═══════════════════════════════════════════════════════

test('REL-1 release: p1hc-re-approval.spec.ts included in test:release chain', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
  const releaseChain: string = pkg.scripts['test:release'] ?? '';
  assert(
    releaseChain.includes('p1hc-re-approval.spec.ts'),
    'p1hc-re-approval.spec.ts must be included in test:release script chain',
  );
});

// ═══════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════

async function main() {
  for (const t of tests) {
    try {
      await t.run();
      results.pass++;
      console.log(`PASS  ${t.name}`);
    } catch (err: any) {
      results.fail++;
      results.failures.push(`${t.name}: ${err?.message ?? err}`);
      console.log(`FAIL  ${t.name}: ${err?.message ?? err}`);
    }
  }

  console.log(`\n══ P1H-C SIX-LAYER BILLING RE-APPROVAL: ${results.pass} PASS / ${results.fail} FAIL ══`);

  if (results.failures.length > 0) {
    console.log('\nFailures:');
    results.failures.forEach((f) => console.log(` ✗ ${f}`));
    process.exit(1);
  } else {
    console.log('FOCUSED SPEC: PASS');
    console.log(JSON.stringify({
      event: 'p1hc_spec_passed',
      tests: results.pass,
      scope: 'six-layer-evidence-model-Layer5-billing-independence-payroll-freeze-resubmit-audit-rbac-mobile',
    }));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
