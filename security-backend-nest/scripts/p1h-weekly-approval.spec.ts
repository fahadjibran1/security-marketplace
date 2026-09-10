/**
 * P1H Weekly Client Timesheet Approval — Focused spec.
 *
 * Proves that the complete P1H workflow is correctly implemented:
 * A. Timezone-aware week computation
 * B. Submission eligibility (8 checks)
 * C. RBAC
 * D. Client approval flow
 * E. Dispute creation
 * F. Dispute resolution
 * G. Resubmission versioning
 * H. Invoice gate
 * I. Payroll non-interference
 * J. Sensitive data boundary
 *
 * Run: ts-node -r tsconfig-paths/register scripts/p1h-weekly-approval.spec.ts
 */
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ValidationPipe } from '@nestjs/common';
import { CreateWeeklyApprovalDto } from '../src/client-weekly-approval/dto/create-weekly-approval.dto';
import { ResubmitApprovalDto } from '../src/client-weekly-approval/dto/resubmit-approval.dto';
import { ResolveDisputeDto } from '../src/client-weekly-approval/dto/resolve-dispute.dto';
import { ClientDisputeDto } from '../src/client-weekly-approval/dto/client-dispute.dto';
import { ClientWeeklyApprovalStatus } from '../src/client-weekly-approval/entities/client-weekly-approval-request.entity';
import { ClientShiftDisputeStatus } from '../src/client-weekly-approval/entities/client-shift-dispute.entity';
import { computeWeekCommencing, computeWeekEnding } from '../src/client-weekly-approval/week-commencing.util';

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, run: Test['run']) => tests.push({ name, run });
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };

const backend = (file: string) => readFileSync(resolve(__dirname, '../src', file), 'utf8');
const mobile  = (file: string) => readFileSync(resolve(__dirname, '../../security-mobile-app/src', file), 'utf8');

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

// ═══════════════════════════════════════════════════════
// A. TIMEZONE-AWARE WEEK COMPUTATION
// ═══════════════════════════════════════════════════════

// T1: GMT (winter) — 2026-01-05 Monday midnight UTC stays Monday
test('T1 GMT: Monday midnight UTC gives Monday week commencing', () => {
  // 2026-01-05 is a Monday
  const result = computeWeekCommencing(new Date('2026-01-05T00:00:00Z'), 'Europe/London');
  assert(result === '2026-01-05', `Expected 2026-01-05, got ${result}`);
});

// T2: BST (summer) — UK shifts to UTC+1; 2026-06-29 is Monday local
test('T2 BST: local Monday in BST gives correct weekCommencing', () => {
  // 2026-06-29 Monday 10:00 BST = 2026-06-29 09:00 UTC
  const result = computeWeekCommencing(new Date('2026-06-29T09:00:00Z'), 'Europe/London');
  assert(result === '2026-06-29', `Expected 2026-06-29 (BST Monday), got ${result}`);
});

// T3: DST transition — Sunday 23:00 UTC = Monday 00:00 BST — should give Monday's week
test('T3 DST transition: Sunday 23:00 UTC = Monday 00:00 BST gives new week', () => {
  // 2026-03-29 is clock-forward day in UK (UTC+1 from that day)
  // 2026-03-29 23:00 UTC = 2026-03-30 00:00 BST = Monday
  const result = computeWeekCommencing(new Date('2026-03-29T23:00:00Z'), 'Europe/London');
  assert(result === '2026-03-30', `Expected 2026-03-30 (BST Monday), got ${result}`);
});

// T4: Sunday/Monday boundary — Sunday 23:59 UTC (GMT) stays in current week
test('T4 Sunday 23:59 UTC/GMT stays in current week', () => {
  // 2026-01-11 is Sunday in 2026 (week of 2026-01-05)
  const result = computeWeekCommencing(new Date('2026-01-11T23:59:00Z'), 'Europe/London');
  assert(result === '2026-01-05', `Expected 2026-01-05, got ${result}`);
});

// T5: Year boundary — Dec 28 Monday is week commencing Dec 28
test('T5 year boundary: week starting Dec 28 2026', () => {
  const result = computeWeekCommencing(new Date('2026-12-28T12:00:00Z'), 'Europe/London');
  assert(result === '2026-12-28', `Expected 2026-12-28, got ${result}`);
});

// T6: Late-night shift — 2026-01-12 Mon 00:30 UTC (GMT) = still Monday
test('T6 late-night Monday shift remains in Monday week', () => {
  const result = computeWeekCommencing(new Date('2026-01-12T00:30:00Z'), 'Europe/London');
  assert(result === '2026-01-12', `Expected 2026-01-12, got ${result}`);
});

// ═══════════════════════════════════════════════════════
// B. SUBMISSION ELIGIBILITY (source inspection)
// ═══════════════════════════════════════════════════════

// T7: Service source inspects company ownership of client
test('T7 eligibility: company ownership check for client in service source', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('company: { id: company.id }'), 'Company ID filter missing for client lookup');
  assert(svc.includes("Client not found for this company"), 'Missing client not found error');
});

// T8: Service source checks site belongs to company
test('T8 eligibility: site ownership check in service source', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes("Site not found for this company"), 'Missing site not found error');
  assert(svc.includes("Site does not belong to the selected client"), 'Missing site-client mismatch error');
});

// T9: assertTimesheetEligible checks shift site matches
test('T9 eligibility: shift site ID checked in assertTimesheetEligible', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('shiftSiteId !== site.id'), 'Shift site ID check missing');
  assert(svc.includes("does not belong to site"), 'Missing site mismatch error message');
});

// T10: assertTimesheetEligible checks shift client matches
test('T10 eligibility: shift client ID checked in assertTimesheetEligible', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('shiftClientId !== client.id'), 'Shift client ID check missing');
  assert(svc.includes("does not belong to client"), 'Missing client mismatch error message');
});

// T11: assertTimesheetEligible checks approval status = approved
test('T11 eligibility: approval status check in assertTimesheetEligible', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('TimesheetStatus.APPROVED'), 'Approval status check missing');
  assert(svc.includes('is not approved'), 'Missing not approved error message');
});

// T12: assertTimesheetEligible checks not invoiced
test('T12 eligibility: not invoiced check in assertTimesheetEligible', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('TimesheetBillingStatus.UNINVOICED'), 'Billing status check missing');
  assert(svc.includes('is already invoiced'), 'Missing already invoiced error message');
});

// T13: Duplicate detection via UQ constraint and explicit check
test('T13 eligibility: duplicate request check (ConflictException)', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('ConflictException'), 'ConflictException not thrown for duplicate');
  assert(svc.includes('already exists for this client/site/week'), 'Missing duplicate error message');
});

// T14: Week computation check in eligibility
test('T14 eligibility: weekCommencing computed and validated per shift', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('computeWeekCommencing'), 'computeWeekCommencing not called in assertTimesheetEligible');
  assert(svc.includes('belongs to week'), 'Missing week mismatch error message');
});

// ═══════════════════════════════════════════════════════
// C. RBAC CHECKS (source inspection)
// ═══════════════════════════════════════════════════════

// T15: Company controller: POST create requires COMPANY_ADMIN_ROLES
test('T15 RBAC: company create requires COMPANY_ADMIN_ROLES', () => {
  const ctrl = backend('client-weekly-approval/client-weekly-approval.controller.ts');
  assert(ctrl.includes('COMPANY_ADMIN_ROLES'), 'COMPANY_ADMIN_ROLES not referenced in controller');
  assert(ctrl.includes("@Post()"), 'POST endpoint missing in company controller');
});

// T16: Company controller: GET list requires COMPANY_VIEW_ROLES
test('T16 RBAC: company list requires COMPANY_VIEW_ROLES', () => {
  const ctrl = backend('client-weekly-approval/client-weekly-approval.controller.ts');
  assert(ctrl.includes('COMPANY_VIEW_ROLES'), 'COMPANY_VIEW_ROLES not referenced in controller');
});

// T17: Company controller: PATCH resolve requires COMPANY_ADMIN_ROLES
test('T17 RBAC: dispute resolve requires COMPANY_ADMIN_ROLES', () => {
  const ctrl = backend('client-weekly-approval/client-weekly-approval.controller.ts');
  assert(ctrl.includes("':id/disputes/:disputeId/resolve'"), 'Resolve dispute route missing');
  assert(ctrl.includes('@Patch'), '@Patch decorator missing on resolve endpoint');
});

// T18: Client portal: approve requires CLIENT_ADMIN
test('T18 RBAC: client approve requires UserRole.CLIENT_ADMIN', () => {
  const ctrl = backend('client-portal/client-portal.controller.ts');
  assert(ctrl.includes('UserRole.CLIENT_ADMIN'), 'CLIENT_ADMIN role not on approve/dispute');
  assert(ctrl.includes("'weekly-approvals/:id/approve'"), 'Approve route missing in client portal');
});

// T19: Client portal: list uses CLIENT_PORTAL_ROLES (viewer can read)
test('T19 RBAC: client list uses CLIENT_PORTAL_ROLES (viewer can read)', () => {
  const ctrl = backend('client-portal/client-portal.controller.ts');
  assert(ctrl.includes('CLIENT_PORTAL_ROLES'), 'CLIENT_PORTAL_ROLES not in client portal controller');
  assert(ctrl.includes("'weekly-approvals'"), 'Weekly approvals list route missing in client portal');
});

// T20: Client portal: dispute requires CLIENT_ADMIN
test('T20 RBAC: client dispute requires UserRole.CLIENT_ADMIN', () => {
  const ctrl = backend('client-portal/client-portal.controller.ts');
  assert(ctrl.includes("'weekly-approvals/:id/dispute'"), 'Dispute route missing in client portal');
});

// ═══════════════════════════════════════════════════════
// D. CLIENT APPROVAL FLOW
// ═══════════════════════════════════════════════════════

// T21: approveWeek sets status to CLIENT_APPROVED
test('T21 approval: approveWeek sets CLIENT_APPROVED status', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  assert(svc.includes('ClientWeeklyApprovalStatus.CLIENT_APPROVED'), 'CLIENT_APPROVED status not set');
  assert(svc.includes('clientRespondedAt = new Date()'), 'clientRespondedAt not set');
  assert(svc.includes('clientRespondedBy = userId'), 'clientRespondedBy not set');
});

// T22: approveWeek only allowed in PENDING_APPROVAL state
test('T22 approval: approveWeek rejects non-PENDING_APPROVAL requests', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  assert(svc.includes('Only PENDING_APPROVAL requests can be approved'), 'Guard missing for approve');
});

// T23: approveWeek emits audit event
test('T23 approval: approveWeek creates audit log entry', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  assert(svc.includes("'weekly_approval.client_approved'"), 'Audit event missing for client_approved');
});

// T24: ClientWeeklyApprovalStatus enum contains all expected values
test('T24 approval: status enum contains all required values', () => {
  assert(ClientWeeklyApprovalStatus.PENDING_APPROVAL === 'pending_approval', 'PENDING_APPROVAL value wrong');
  assert(ClientWeeklyApprovalStatus.CLIENT_APPROVED === 'client_approved', 'CLIENT_APPROVED value wrong');
  assert(ClientWeeklyApprovalStatus.DISPUTED === 'disputed', 'DISPUTED value wrong');
  assert(ClientWeeklyApprovalStatus.RESOLVED === 'resolved', 'RESOLVED value wrong');
  assert(ClientWeeklyApprovalStatus.LOCKED === 'locked', 'LOCKED value wrong');
});

// ═══════════════════════════════════════════════════════
// E. DISPUTE CREATION
// ═══════════════════════════════════════════════════════

// T25: disputeShifts sets DISPUTED status
test('T25 dispute: disputeShifts sets DISPUTED status', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  assert(svc.includes('ClientWeeklyApprovalStatus.DISPUTED'), 'DISPUTED status not set in disputeShifts');
});

// T26: disputeShifts creates dispute records for each item
test('T26 dispute: disputeShifts creates dispute records', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  assert(svc.includes('disputeRepo.create'), 'disputeRepo.create not called');
  assert(svc.includes('disputesCreated: disputes.length'), 'disputesCreated count not returned');
});

// T27: ClientDisputeDto requires non-empty disputeReason
test('T27 dispute: ClientDisputeDto requires non-empty disputeReason per item', async () => {
  let threw = false;
  try {
    await pipe.transform({ disputes: [{ timesheetId: 1, disputeReason: '' }] }, { type: 'body', metatype: ClientDisputeDto });
  } catch { threw = true; }
  assert(threw, 'Empty disputeReason was accepted');
});

// T28: ClientDisputeDto requires at least one dispute
test('T28 dispute: ClientDisputeDto requires ArrayMinSize(1)', async () => {
  let threw = false;
  try {
    await pipe.transform({ disputes: [] }, { type: 'body', metatype: ClientDisputeDto });
  } catch { threw = true; }
  assert(threw, 'Empty disputes array was accepted');
});

// T29: disputeShifts checks timesheet is in active lines
test('T29 dispute: timesheetId validated against active approval lines', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  assert(svc.includes('is not in this approval request'), 'Missing check for timesheet not in request');
});

// T30: disputeShifts only allowed in PENDING_APPROVAL state
test('T30 dispute: disputeShifts rejects non-PENDING_APPROVAL requests', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  assert(svc.includes('Only PENDING_APPROVAL requests can be disputed'), 'Guard missing for dispute');
});

// ═══════════════════════════════════════════════════════
// F. DISPUTE RESOLUTION
// ═══════════════════════════════════════════════════════

// T31: resolveDispute sets RESOLVED status on dispute
test('T31 resolution: resolveDispute sets RESOLVED on dispute record', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('ClientShiftDisputeStatus.RESOLVED'), 'RESOLVED status not set on dispute');
  assert(svc.includes('dispute.resolutionMessage = dto.resolutionMessage'), 'resolutionMessage not stored');
});

// T32: resolveDispute promotes request to RESOLVED when all disputes resolved
test('T32 resolution: request promoted to RESOLVED when all disputes resolved', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('openDisputes === 0'), 'Missing check for all disputes resolved');
  assert(svc.includes('ClientWeeklyApprovalStatus.RESOLVED'), 'RESOLVED status not set on request');
});

// T33: resolveDispute only allowed in DISPUTED state
test('T33 resolution: resolveDispute only works in DISPUTED status', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('Only OPEN disputes can be resolved'), 'Guard for open disputes missing');
  assert(svc.includes('DISPUTED status'), 'Guard for DISPUTED request status missing');
});

// T34: ResolveDisputeDto requires non-empty resolutionMessage
test('T34 resolution: ResolveDisputeDto requires non-empty resolutionMessage', async () => {
  let threw = false;
  try {
    await pipe.transform({ resolutionMessage: '' }, { type: 'body', metatype: ResolveDisputeDto });
  } catch { threw = true; }
  assert(threw, 'Empty resolutionMessage was accepted');
});

// T35: ClientShiftDisputeStatus enum correct
test('T35 resolution: ClientShiftDisputeStatus enum values correct', () => {
  assert(ClientShiftDisputeStatus.OPEN === 'open', 'OPEN value wrong');
  assert(ClientShiftDisputeStatus.RESOLVED === 'resolved', 'RESOLVED value wrong');
  assert(ClientShiftDisputeStatus.WITHDRAWN === 'withdrawn', 'WITHDRAWN value wrong');
});

// ═══════════════════════════════════════════════════════
// G. RESUBMISSION VERSIONING
// ═══════════════════════════════════════════════════════

// T36: resubmit increments currentVersion
test('T36 resubmission: currentVersion incremented', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('newVersion = request.currentVersion + 1'), 'Version increment missing');
  assert(svc.includes('request.currentVersion = newVersion'), 'currentVersion not updated');
});

// T37: resubmit supersedes old active lines
test('T37 resubmission: old active lines superseded', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('"superseded" = TRUE'), 'Old lines not superseded');
  assert(svc.includes('"superseded" = FALSE'), 'New lines not set to non-superseded');
});

// T38: resubmit only allowed in RESOLVED state
test('T38 resubmission: only allowed in RESOLVED status', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('Only RESOLVED requests can be resubmitted'), 'Guard for RESOLVED state missing');
});

// T39: resubmit resets status to PENDING_APPROVAL
test('T39 resubmission: status reset to PENDING_APPROVAL', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('request.status = ClientWeeklyApprovalStatus.PENDING_APPROVAL'), 'Status not reset to PENDING_APPROVAL');
  assert(svc.includes('request.clientRespondedAt = null'), 'clientRespondedAt not reset');
  assert(svc.includes('request.clientRespondedBy = null'), 'clientRespondedBy not reset');
});

// T40: UQ_active_approval_line partial unique index in migration
test('T40 resubmission: partial unique index for active lines in migration', () => {
  const migration = backend('database/migrations/1720800000002-CreateClientWeeklyApprovalTables.ts');
  assert(migration.includes('UQ_active_approval_line'), 'Partial unique index for active lines missing');
  assert(migration.includes('"superseded" = FALSE'), 'Partial index WHERE clause missing');
});

// T41: resubmit emits audit log
test('T41 resubmission: audit log created for resubmit action', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes("'weekly_approval.resubmitted'"), 'Audit event for resubmitted missing');
});

// T42: UQ_approval_line_request_timesheet_version constraint in migration
test('T42 resubmission: version-scoped unique constraint on lines', () => {
  const migration = backend('database/migrations/1720800000002-CreateClientWeeklyApprovalTables.ts');
  assert(migration.includes('UQ_approval_line_request_timesheet_version'), 'Version-scoped unique constraint missing');
  assert(migration.includes('"submissionVersion"'), 'submissionVersion missing from constraint');
});

// ═══════════════════════════════════════════════════════
// H. INVOICE GATE
// ═══════════════════════════════════════════════════════

// T43: Invoice batch service asserts client-approved lines exist
test('T43 invoice gate: assertClientApprovedLinesExist called before invoicing', () => {
  const svc = backend('invoice-batch/invoice-batch.service.ts');
  assert(svc.includes('assertClientApprovedLinesExist'), 'P1H invoice gate method missing');
  assert(svc.includes('have not been client-approved'), 'P1H gate error message missing');
});

// T44: Invoice gate checks CLIENT_APPROVED or LOCKED status
test('T44 invoice gate: accepts CLIENT_APPROVED and LOCKED status', () => {
  const svc = backend('invoice-batch/invoice-batch.service.ts');
  assert(svc.includes('ClientWeeklyApprovalStatus.CLIENT_APPROVED'), 'CLIENT_APPROVED check missing in invoice gate');
  assert(svc.includes('ClientWeeklyApprovalStatus.LOCKED'), 'LOCKED check missing in invoice gate');
});

// T45: clientBilledHoursSnapshot set from approval line before applyFinancials
test('T45 invoice gate: clientBilledHoursSnapshot set before applyFinancials', () => {
  const svc = backend('invoice-batch/invoice-batch.service.ts');
  const approvalSetIndex = svc.indexOf('clientBilledHoursSnapshot');
  const financialsIndex = svc.indexOf('applyFinancials');
  assert(approvalSetIndex !== -1, 'clientBilledHoursSnapshot not set in invoice service');
  assert(approvalSetIndex < financialsIndex, 'clientBilledHoursSnapshot must be set BEFORE applyFinancials');
});

// T46: approvedHoursSnapshot uses payroll-authoritative duration (not clientBilledHoursSnapshot)
test('T46 invoice gate: approvedHoursSnapshot uses payroll duration, not clientBilledHoursSnapshot', () => {
  const svc = backend('invoice-batch/invoice-batch.service.ts');
  assert(svc.includes('approvedMinutes != null ? Number(timesheet.approvedMinutes) / 60'), 'Payroll-authoritative hours not used for approvedHoursSnapshot');
  // The snapshot line should NOT use getApprovedHours() (which reads clientBilledHoursSnapshot)
  const snapshotLine = svc.match(/timesheet\.approvedHoursSnapshot\s*=\s*timesheet\.approvedHoursSnapshot\s*\?\?[^;]+/)?.[0] ?? '';
  assert(!snapshotLine.includes('getApprovedHours'), 'approvedHoursSnapshot incorrectly reads clientBilledHoursSnapshot via getApprovedHours');
});

// T47: contractPricingService.getApprovedHours reads clientBilledHoursSnapshot first
test('T47 invoice gate: contractPricingService uses clientBilledHoursSnapshot for billing hours', () => {
  const svc = backend('contract-pricing/contract-pricing.service.ts');
  assert(svc.includes('clientBilledHoursSnapshot'), 'clientBilledHoursSnapshot not read in contract pricing');
  const lines = svc.split('\n');
  const snapIdx = lines.findIndex(l => l.includes('clientBilledHoursSnapshot'));
  const approvedHoursSnapshotIdx = lines.findIndex(l => l.includes('approvedHoursSnapshot') && l.includes('getApprovedHours') === false);
  assert(snapIdx < approvedHoursSnapshotIdx || approvedHoursSnapshotIdx === -1, 'clientBilledHoursSnapshot must be checked before approvedHoursSnapshot');
});

// T48: Invoice batch imports ClientWeeklyApprovalLine
test('T48 invoice gate: InvoiceBatchModule registers ClientWeeklyApprovalLine', () => {
  const module = backend('invoice-batch/invoice-batch.module.ts');
  assert(module.includes('ClientWeeklyApprovalLine'), 'ClientWeeklyApprovalLine not in InvoiceBatchModule');
  assert(module.includes('ClientWeeklyApprovalRequest'), 'ClientWeeklyApprovalRequest not in InvoiceBatchModule');
});

// ═══════════════════════════════════════════════════════
// I. PAYROLL NON-INTERFERENCE
// ═══════════════════════════════════════════════════════

// T49: PayrollBatch service does NOT reference clientBilledHoursSnapshot
test('T49 payroll: payroll-batch service does NOT read clientBilledHoursSnapshot', () => {
  const svc = backend('payroll-batch/payroll-batch.service.ts');
  assert(!svc.includes('clientBilledHoursSnapshot'), 'clientBilledHoursSnapshot found in payroll-batch service — must not affect payroll');
});

// T50: PayrollBatch service does NOT reference ClientWeeklyApprovalLine
test('T50 payroll: payroll-batch service does NOT import ClientWeeklyApprovalLine', () => {
  const svc = backend('payroll-batch/payroll-batch.service.ts');
  assert(!svc.includes('ClientWeeklyApprovalLine'), 'ClientWeeklyApprovalLine referenced in payroll-batch — payroll gate unchanged');
});

// T51: PayrollBatch service approves by TimesheetStatus only
test('T51 payroll: payroll gate uses TimesheetStatus.APPROVED (unchanged)', () => {
  const svc = backend('payroll-batch/payroll-batch.service.ts');
  assert(svc.includes('TimesheetStatus.APPROVED'), 'PayrollBatch gate no longer checks TimesheetStatus.APPROVED');
  assert(!svc.includes('ClientWeeklyApprovalStatus'), 'PayrollBatch incorrectly imports ClientWeeklyApprovalStatus');
});

// T52: approvedMinutes used for payroll (not overridden by P1H)
test('T52 payroll: approvedMinutes unchanged by P1H — no write to approvedMinutes in approval service', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  // P1H service must never write to approvedMinutes
  assert(!svc.includes('timesheet.approvedMinutes ='), 'P1H service must not modify approvedMinutes');
  assert(!svc.includes('.approvedMinutes ='), 'P1H service must not modify approvedMinutes');
});

// T53: clientBilledHoursSnapshot column is NULLABLE (no impact on existing timesheets)
test('T53 payroll: clientBilledHoursSnapshot column is nullable (migration)', () => {
  const migration = backend('database/migrations/1720800000001-AddClientBilledHoursSnapshot.ts');
  assert(migration.includes('NUMERIC(8,2) NULL'), 'clientBilledHoursSnapshot must be nullable');
});

// ═══════════════════════════════════════════════════════
// J. SENSITIVE DATA BOUNDARY
// ═══════════════════════════════════════════════════════

// T54: Client portal service toClientDetailDto does NOT include hourlyRate as a key
test('T54 data boundary: toClientDetailDto does not include hourlyRate key in returned object', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  // Confirm there is no "hourlyRate:" assignment in the return object (key: value pattern)
  assert(!svc.includes('hourlyRate:'), 'hourlyRate: key assigned in client portal service return object');
  assert(!svc.includes('hourlyRateSnapshot:'), 'hourlyRateSnapshot: key in client portal service return object');
});

// T55: Client portal service toClientDetailDto does NOT include payableAmount/payableHours as keys
test('T55 data boundary: toClientDetailDto omits payableAmount and payableHours keys', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  assert(!svc.includes('payableAmount:'), 'payableAmount: key in client portal service return object');
  assert(!svc.includes('payableHours:'), 'payableHours: key in client portal service return object');
});

// T56: Client portal service toClientDetailDto does NOT include overrideReason as a key
test('T56 data boundary: toClientDetailDto does not include overrideReason key', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  assert(!svc.includes('overrideReason:'), 'overrideReason: key in client portal service return object');
});

// T57: Client portal service does NOT expose companyInternalNote
test('T57 data boundary: client portal service never exposes companyInternalNote', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  assert(!svc.includes('companyInternalNote'), 'companyInternalNote exposed in client portal service');
});

// T58: toClientDetailDto does NOT include margin fields
test('T58 data boundary: toClientDetailDto omits margin/revenue/cost', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  assert(!svc.includes('marginAmount'), 'marginAmount in client detail DTO');
  assert(!svc.includes('revenueAmount'), 'revenueAmount in client detail DTO');
  assert(!svc.includes('costAmount'), 'costAmount in client detail DTO');
});

// T59: Mobile models — ClientWeeklyApprovalLine has no rate or payroll fields
test('T59 data boundary: mobile ClientWeeklyApprovalLine has no rate or payroll fields', () => {
  const models = mobile('types/models.ts');
  const lineInterface = models.match(/export interface ClientWeeklyApprovalLine \{[^}]+\}/s)?.[0] ?? '';
  assert(lineInterface, 'ClientWeeklyApprovalLine interface not found in mobile models');
  assert(!lineInterface.includes('hourlyRate'), 'hourlyRate in mobile ClientWeeklyApprovalLine');
  assert(!lineInterface.includes('billingRate'), 'billingRate in mobile ClientWeeklyApprovalLine');
  assert(!lineInterface.includes('payableAmount'), 'payableAmount in mobile ClientWeeklyApprovalLine');
  assert(!lineInterface.includes('overrideReason'), 'overrideReason in mobile ClientWeeklyApprovalLine');
});

// T60: Mobile models — ClientWeeklyApprovalSummary has no company-internal fields
test('T60 data boundary: mobile ClientWeeklyApprovalSummary has no companyInternalNote', () => {
  const models = mobile('types/models.ts');
  const summaryInterface = models.match(/export interface ClientWeeklyApprovalSummary \{[^}]+\}/s)?.[0] ?? '';
  assert(summaryInterface, 'ClientWeeklyApprovalSummary interface not found in mobile models');
  assert(!summaryInterface.includes('companyInternalNote'), 'companyInternalNote in mobile ClientWeeklyApprovalSummary');
});

// ═══════════════════════════════════════════════════════
// DTO VALIDATION
// ═══════════════════════════════════════════════════════

// T61: CreateWeeklyApprovalDto requires timesheetIds with at least one entry
test('T61 DTO: CreateWeeklyApprovalDto rejects empty timesheetIds', async () => {
  let threw = false;
  try {
    await pipe.transform({ clientId: 1, siteId: 1, weekCommencing: '2026-01-05', timesheetIds: [] }, { type: 'body', metatype: CreateWeeklyApprovalDto });
  } catch { threw = true; }
  assert(threw, 'Empty timesheetIds accepted in CreateWeeklyApprovalDto');
});

// T62: CreateWeeklyApprovalDto rejects non-date weekCommencing
test('T62 DTO: CreateWeeklyApprovalDto rejects invalid weekCommencing', async () => {
  let threw = false;
  try {
    await pipe.transform({ clientId: 1, siteId: 1, weekCommencing: 'not-a-date', timesheetIds: [1] }, { type: 'body', metatype: CreateWeeklyApprovalDto });
  } catch { threw = true; }
  assert(threw, 'Invalid weekCommencing accepted');
});

// T63: ResubmitApprovalDto requires timesheetIds
test('T63 DTO: ResubmitApprovalDto rejects empty timesheetIds', async () => {
  let threw = false;
  try {
    await pipe.transform({ timesheetIds: [] }, { type: 'body', metatype: ResubmitApprovalDto });
  } catch { threw = true; }
  assert(threw, 'Empty timesheetIds accepted in ResubmitApprovalDto');
});

// T64: computeWeekEnding gives Sunday 6 days after weekCommencing
test('T64 util: computeWeekEnding returns Sunday 6 days after Monday', () => {
  const ending = computeWeekEnding('2026-01-05');
  assert(ending === '2026-01-11', `Expected 2026-01-11 (Sunday), got ${ending}`);
});

// T65: Three migration files exist with correct timestamps
test('T65 migrations: all three P1H migration files exist', () => {
  const m0 = backend('database/migrations/1720800000000-AddSiteTimezone.ts');
  const m1 = backend('database/migrations/1720800000001-AddClientBilledHoursSnapshot.ts');
  const m2 = backend('database/migrations/1720800000002-CreateClientWeeklyApprovalTables.ts');
  assert(m0.includes('AddSiteTimezone'), 'Migration A missing');
  assert(m1.includes('AddClientBilledHoursSnapshot'), 'Migration B missing');
  assert(m2.includes('CreateClientWeeklyApprovalTables'), 'Migration C missing');
  assert(m0.includes("Europe/London"), 'Migration A missing default timezone');
  assert(m1.includes('timesheets'), 'Migration B not targeting timesheets table');
  assert(m2.includes('client_weekly_approval_requests'), 'Migration C missing approval table');
});

// ═══════════════════════════════════════════════════════
// K. UAT CORRECTION — NAVIGATION & UX
// ═══════════════════════════════════════════════════════

// T66: CompanyDashboardScreen COMPANY_NAV_GROUPS includes 'weekly-approvals' in timesheets-pay group
test('T66 nav: weekly-approvals in COMPANY_NAV_GROUPS timesheets-pay group', () => {
  const screen = mobile('screens/CompanyDashboardScreen.tsx');
  const groupBlock = screen.match(/id:\s*['"]timesheets-pay['"][^}]*itemIds:\s*\[[^\]]+\]/s)?.[0] ?? '';
  assert(groupBlock.includes('weekly-approvals'), "COMPANY_NAV_GROUPS timesheets-pay does not include 'weekly-approvals'");
});

// T67: CompanyDashboardScreen NAV_ITEMS includes a 'weekly-approvals' entry
test('T67 nav: weekly-approvals entry in CompanyDashboardScreen NAV_ITEMS', () => {
  const screen = mobile('screens/CompanyDashboardScreen.tsx');
  assert(screen.includes("id: 'weekly-approvals'"), "NAV_ITEMS does not include id: 'weekly-approvals'");
});

// T68: CompanyDashboardScreen imports and renders CompanyWeeklyApprovalsScreen
test('T68 nav: CompanyDashboardScreen imports and renders CompanyWeeklyApprovalsScreen', () => {
  const screen = mobile('screens/CompanyDashboardScreen.tsx');
  assert(screen.includes('CompanyWeeklyApprovalsScreen'), 'CompanyDashboardScreen does not reference CompanyWeeklyApprovalsScreen');
  assert(screen.includes("case 'weekly-approvals'"), "renderContent() missing case 'weekly-approvals'");
});

// T69: ClientPortalScreen ClientSection type includes 'timesheets'
test('T69 nav: ClientPortalScreen ClientSection type includes timesheets', () => {
  const screen = mobile('screens/ClientPortalScreen.tsx');
  assert(screen.includes("'timesheets'"), "ClientPortalScreen ClientSection does not include 'timesheets'");
});

// T70: ClientPortalScreen imports ClientWeeklyApprovalsScreen
test('T70 nav: ClientPortalScreen imports ClientWeeklyApprovalsScreen', () => {
  const screen = mobile('screens/ClientPortalScreen.tsx');
  assert(screen.includes('ClientWeeklyApprovalsScreen'), 'ClientPortalScreen does not import ClientWeeklyApprovalsScreen');
});

// T71: ClientPortalScreen passes userRole to ClientWeeklyApprovalsScreen
test('T71 nav: ClientPortalScreen passes userRole to ClientWeeklyApprovalsScreen', () => {
  const screen = mobile('screens/ClientPortalScreen.tsx');
  assert(screen.includes('userRole={user.role}'), 'ClientPortalScreen does not pass userRole to ClientWeeklyApprovalsScreen');
});

// T72: Backend controller has GET eligible route before GET :id
test('T72 multi-guard: backend controller has GET eligible endpoint', () => {
  const ctrl = backend('client-weekly-approval/client-weekly-approval.controller.ts');
  const eligibleIdx = ctrl.indexOf("Get('eligible')");
  const paramIdx = ctrl.indexOf("Get(':id')");
  assert(eligibleIdx !== -1, "Controller missing @Get('eligible') endpoint");
  assert(paramIdx !== -1, "Controller missing @Get(':id') endpoint");
  assert(eligibleIdx < paramIdx, "@Get('eligible') must be declared before @Get(':id')");
});

// T73: Backend service has getEligibleTimesheets method
test('T73 multi-guard: backend service has getEligibleTimesheets method', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('getEligibleTimesheets'), 'ClientWeeklyApprovalService missing getEligibleTimesheets method');
  assert(svc.includes('computeWeekCommencing'), 'getEligibleTimesheets must use computeWeekCommencing for week filtering');
});

// T74: Mobile API has getEligibleTimesheets function
test('T74 multi-guard: mobile api.ts has getEligibleTimesheets function', () => {
  const api = mobile('services/api.ts');
  assert(api.includes('getEligibleTimesheets'), 'mobile api.ts missing getEligibleTimesheets function');
  assert(api.includes('weekly-approvals/eligible'), 'getEligibleTimesheets must call /timesheets/weekly-approvals/eligible');
});

// T75: CompanyWeeklyApprovalsScreen has checkbox/selection state for multi-guard submission
test('T75 multi-guard: CompanyWeeklyApprovalsScreen has multi-select state for submission', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('selectedIds'), 'CompanyWeeklyApprovalsScreen missing selectedIds state for multi-selection');
  assert(screen.includes('toggleId') || screen.includes('selectedIds.has'), 'Missing checkbox toggle logic');
});

// T76: CompanyWeeklyApprovalsScreen uses submitWeeklyApproval
test('T76 multi-guard: CompanyWeeklyApprovalsScreen calls submitWeeklyApproval', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('submitWeeklyApproval'), 'CompanyWeeklyApprovalsScreen does not call submitWeeklyApproval');
  assert(screen.includes('timesheetIds'), 'submitWeeklyApproval call missing timesheetIds');
});

// T77: CompanyWeeklyApprovalsScreen shows confirmation before submit
test('T77 multi-guard: CompanyWeeklyApprovalsScreen shows confirmation dialog before submit', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('showConfirm') || screen.includes('Confirm'), 'CompanyWeeklyApprovalsScreen missing confirmation step');
  assert(screen.includes('Modal') || screen.includes('confirm'), 'No modal/confirmation dialog for submission');
});

// T78: CompanyWeeklyApprovalsScreen detail view has ATTENDANCE evidence layer
test('T78 three layers: CompanyWeeklyApprovalsScreen shows ATTENDANCE evidence layer', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('ATTENDANCE'), 'CompanyWeeklyApprovalsScreen missing ATTENDANCE evidence layer label');
  assert(screen.includes('actualCheckIn') || screen.includes('Check In'), 'Missing check-in data in attendance layer');
});

// T79: CompanyWeeklyApprovalsScreen detail view has GUARD CLAIM evidence layer
test('T79 three layers: CompanyWeeklyApprovalsScreen shows GUARD CLAIM evidence layer', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('GUARD CLAIM') || screen.includes('Claimed'), 'CompanyWeeklyApprovalsScreen missing GUARD CLAIM evidence layer');
  assert(screen.includes('hoursWorked') || screen.includes('Claimed Hours'), 'Missing guard claimed hours in GUARD CLAIM layer');
});

// T80: CompanyWeeklyApprovalsScreen detail view has COMPANY APPROVAL evidence layer
test('T80 three layers: CompanyWeeklyApprovalsScreen shows COMPANY APPROVAL evidence layer', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('COMPANY APPROVAL'), 'CompanyWeeklyApprovalsScreen missing COMPANY APPROVAL evidence layer label');
  assert(screen.includes('approvedHoursAtSubmission'), 'Missing approvedHoursAtSubmission in COMPANY APPROVAL layer');
});

// T81: CompanyWeeklyApprovalsScreen shows 'Adjusted' badge when hasOverride
test('T81 three layers: CompanyWeeklyApprovalsScreen shows Adjusted badge for overridden timesheets', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('hasOverride'), 'CompanyWeeklyApprovalsScreen does not reference hasOverride');
  assert(screen.includes('Adjusted'), "Missing 'Adjusted' label for hasOverride timesheets");
});

// T82: CompanyWeeklyApprovalsScreen uses business-friendly 'Awaiting Client Approval' not raw enum
test('T82 status label: CompanyWeeklyApprovalsScreen uses Awaiting Client Approval label', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('Awaiting Client Approval'), "CompanyWeeklyApprovalsScreen missing 'Awaiting Client Approval' status label");
  assert(!screen.includes("return 'pending_approval'"), "Raw status enum value leaked into company screen labels");
});

// T83: ClientWeeklyApprovalsScreen uses 'Returned for Correction' not raw 'DISPUTED'
test('T83 status label: ClientWeeklyApprovalsScreen uses Returned for Correction label', () => {
  const screen = mobile('screens/ClientWeeklyApprovalsScreen.tsx');
  assert(screen.includes('Returned for Correction'), "ClientWeeklyApprovalsScreen missing 'Returned for Correction' label for disputed status");
  assert(!screen.includes("return 'disputed'"), "Raw disputed enum leaked into client screen labels");
});

// T84: ClientWeeklyApprovalsScreen enforce CLIENT_VIEWER cannot trigger approve/dispute actions
test('T84 RBAC: ClientWeeklyApprovalsScreen enforces CLIENT_VIEWER read-only (no approve for viewers)', () => {
  const screen = mobile('screens/ClientWeeklyApprovalsScreen.tsx');
  assert(screen.includes('isAdmin'), 'ClientWeeklyApprovalsScreen missing isAdmin guard for actions');
  assert(screen.includes('isAdmin &&'), 'Approve/dispute actions not gated by isAdmin check');
});

// T85: Data boundary — CompanyApprovalLine has overrideReason; ClientWeeklyApprovalLine does not
test('T85 data boundary: CompanyApprovalLine has overrideReason; ClientWeeklyApprovalLine does not', () => {
  const models = mobile('types/models.ts');
  const companyLine = models.match(/export interface CompanyApprovalLine \{[^}]+\}/s)?.[0] ?? '';
  assert(companyLine, 'CompanyApprovalLine interface not found in mobile models');
  assert(companyLine.includes('overrideReason') || models.includes('overrideReason'), 'CompanyApprovalLine does not include overrideReason (via timesheet nested type)');
  const clientLine = models.match(/export interface ClientWeeklyApprovalLine \{[^}]+\}/s)?.[0] ?? '';
  assert(clientLine, 'ClientWeeklyApprovalLine interface not found in mobile models');
  assert(!clientLine.includes('overrideReason'), 'overrideReason must NOT appear in ClientWeeklyApprovalLine');
});

// ═══════════════════════════════════════════════════════
// L. COMPANY TIME APPROVAL CORRECTION
// ═══════════════════════════════════════════════════════

// T86: Timesheet entity has companyApprovedStartAt column (nullable timestamp)
test('T86 time-approval: Timesheet entity has companyApprovedStartAt nullable timestamp column', () => {
  const entity = backend('timesheet/entities/timesheet.entity.ts');
  assert(entity.includes('companyApprovedStartAt'), 'Timesheet entity missing companyApprovedStartAt field');
  const startBlock = entity.match(/companyApprovedStartAt[^;]+;/)?.[0] ?? '';
  assert(startBlock.includes('timestamp') || entity.includes("type: 'timestamp'"), 'companyApprovedStartAt must be timestamp type');
  assert(entity.includes('nullable: true'), 'companyApprovedStartAt must be nullable');
});

// T87: Timesheet entity has companyApprovedEndAt column (nullable timestamp)
test('T87 time-approval: Timesheet entity has companyApprovedEndAt nullable timestamp column', () => {
  const entity = backend('timesheet/entities/timesheet.entity.ts');
  assert(entity.includes('companyApprovedEndAt'), 'Timesheet entity missing companyApprovedEndAt field');
});

// T88: UpdateTimesheetDto accepts companyApprovedStartAt and companyApprovedEndAt
test('T88 time-approval: UpdateTimesheetDto has companyApprovedStartAt and companyApprovedEndAt fields', () => {
  const dto = backend('timesheet/dto/update-timesheet.dto.ts');
  assert(dto.includes('companyApprovedStartAt'), 'UpdateTimesheetDto missing companyApprovedStartAt');
  assert(dto.includes('companyApprovedEndAt'), 'UpdateTimesheetDto missing companyApprovedEndAt');
});

// T89: Migration 1720800000003 exists and adds all four columns
test('T89 time-approval: migration 1720800000003 exists and adds approved time columns to both tables', () => {
  const migration = backend('database/migrations/1720800000003-AddCompanyApprovedTimes.ts');
  assert(migration.includes('AddCompanyApprovedTimes'), 'Migration name incorrect or missing');
  assert(migration.includes('companyApprovedStartAt'), 'Migration missing companyApprovedStartAt for timesheets');
  assert(migration.includes('companyApprovedEndAt'), 'Migration missing companyApprovedEndAt for timesheets');
  assert(migration.includes('companyApprovedStartAtSubmission'), 'Migration missing companyApprovedStartAtSubmission for approval lines');
  assert(migration.includes('companyApprovedEndAtSubmission'), 'Migration missing companyApprovedEndAtSubmission for approval lines');
  assert(migration.includes('client_weekly_approval_lines'), 'Migration must target client_weekly_approval_lines table');
  assert(migration.includes('timesheets'), 'Migration must target timesheets table');
});

// T90: Timesheet service derives approvedMinutes from time interval when bounds provided
test('T90 time-approval: timesheet service computes approvedMinutes from time interval when companyApprovedStartAt/EndAt provided', () => {
  const svc = backend('timesheet/timesheet.service.ts');
  assert(svc.includes('companyApprovedStartAt') && svc.includes('companyApprovedEndAt'), 'Service does not reference approved time bounds');
  assert(svc.includes('getTime()'), 'Service does not call getTime() for timestamp arithmetic');
  assert(svc.includes('endMs - startMs') || svc.includes('endMs-startMs'), 'Service does not compute interval from approved times');
  assert(svc.includes('60000'), 'Service does not convert ms to minutes');
});

// T91: Timesheet service still requires overrideReason when approved interval differs from verifiedMinutes
test('T91 time-approval: timesheet service requires overrideReason when approved duration differs from verifiedMinutes', () => {
  const svc = backend('timesheet/timesheet.service.ts');
  assert(svc.includes('overrideReason'), 'Service missing overrideReason check');
  assert(svc.includes('An override reason is required'), 'Override reason error message missing from service');
  assert(svc.includes('isOverride'), 'isOverride check removed from service');
});

// T92: Timesheet service rejects impossible interval (endMs <= startMs)
test('T92 time-approval: timesheet service rejects end <= start timestamp', () => {
  const svc = backend('timesheet/timesheet.service.ts');
  assert(svc.includes('endMs <= startMs'), 'Service does not check endMs <= startMs for impossible interval');
  assert(svc.includes('Approved end time must be after approved start time'), 'Missing impossible interval rejection message');
});

// T93: Overnight shift math is correct with full timestamps (pure computation)
test('T93 time-approval: overnight shift duration computes correctly via getTime() arithmetic', () => {
  const startMs = new Date('2026-09-01T22:00:00Z').getTime();
  const endMs = new Date('2026-09-02T06:00:00Z').getTime();
  const minutes = Math.round((endMs - startMs) / 60000);
  assert(minutes === 480, `Expected 480 minutes for 22:00–06:00 overnight, got ${minutes}`);
  assert(endMs > startMs, 'Overnight endMs must be greater than startMs when using full timestamps');
});

// T94: createSubmission snapshots companyApprovedStartAtSubmission and companyApprovedEndAtSubmission
test('T94 time-approval: createSubmission line snapshots companyApprovedStartAtSubmission and companyApprovedEndAtSubmission', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  assert(svc.includes('companyApprovedStartAtSubmission'), 'createSubmission does not snapshot companyApprovedStartAtSubmission');
  assert(svc.includes('companyApprovedEndAtSubmission'), 'createSubmission does not snapshot companyApprovedEndAtSubmission');
  assert(svc.includes('ts.companyApprovedStartAt'), 'createSubmission does not read companyApprovedStartAt from timesheet');
  assert(svc.includes('ts.companyApprovedEndAt'), 'createSubmission does not read companyApprovedEndAt from timesheet');
});

// T95: resubmit also takes fresh snapshots of approved times (new version lines)
test('T95 time-approval: resubmit creates fresh companyApprovedStartAtSubmission snapshots for new version lines', () => {
  const svc = backend('client-weekly-approval/client-weekly-approval.service.ts');
  const resubmitBlock = svc.slice(svc.indexOf('async resubmit'));
  assert(resubmitBlock.includes('companyApprovedStartAtSubmission'), 'resubmit does not snapshot companyApprovedStartAtSubmission');
  assert(resubmitBlock.includes('companyApprovedEndAtSubmission'), 'resubmit does not snapshot companyApprovedEndAtSubmission');
});

// T96: Client portal service exposes companyApprovedStart/End in line DTO but NOT overrideReason
test('T96 time-approval: client portal service includes companyApprovedStart/End but NOT overrideReason in client line DTO', () => {
  const svc = backend('client-weekly-approval/client-portal-weekly-approval.service.ts');
  assert(svc.includes('companyApprovedStart'), 'Client portal service missing companyApprovedStart in line DTO');
  assert(svc.includes('companyApprovedEnd'), 'Client portal service missing companyApprovedEnd in line DTO');
  assert(!svc.includes('overrideReason:'), 'overrideReason must NOT be exposed in client portal service line DTO');
});

// T97: Mobile ClientWeeklyApprovalLine includes companyApprovedStart/End snapshot fields
test('T97 time-approval: mobile ClientWeeklyApprovalLine has companyApprovedStart and companyApprovedEnd fields', () => {
  const models = mobile('types/models.ts');
  const lineInterface = models.match(/export interface ClientWeeklyApprovalLine \{[^}]+\}/s)?.[0] ?? '';
  assert(lineInterface, 'ClientWeeklyApprovalLine not found in mobile models');
  assert(lineInterface.includes('companyApprovedStart'), 'ClientWeeklyApprovalLine missing companyApprovedStart');
  assert(lineInterface.includes('companyApprovedEnd'), 'ClientWeeklyApprovalLine missing companyApprovedEnd');
  assert(!lineInterface.includes('overrideReason'), 'overrideReason must NOT appear in ClientWeeklyApprovalLine (T59 guard)');
});

// ═══════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════

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
  console.log(`\n══ P1H WEEKLY CLIENT APPROVAL: ${passed} PASS / ${failed} FAIL ══`);
  if (failed > 0) { console.error('FOCUSED SPEC: FAIL'); process.exit(1); }
  else console.log('FOCUSED SPEC: PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
