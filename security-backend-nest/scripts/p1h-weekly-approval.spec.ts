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

// T66: CompanyDashboardScreen COMPANY_NAV_GROUPS exposes 'weekly-approvals' in some navigation group.
// The IA redesign moved it from the retired 'timesheets-pay' group into 'workforce'; what matters is that the entry
// is reachable from the sidebar groups, so assert membership of any group rather than one group's name.
test('T66 nav: weekly-approvals is reachable from a COMPANY_NAV_GROUPS group', () => {
  const screen = mobile('screens/CompanyDashboardScreen.tsx');
  const groups = screen.match(/COMPANY_NAV_GROUPS[^=]*=\s*\[[\s\S]*?\n\];/)?.[0] ?? '';
  assert(groups.length > 0, 'COMPANY_NAV_GROUPS declaration not found');
  assert(/itemIds:\s*\[[^\]]*'weekly-approvals'[^\]]*\]/.test(groups), "no COMPANY_NAV_GROUPS group lists 'weekly-approvals'");
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

// T75: Submission multi-select state lives in CompanyTimesheetsWorkspace send-to-client flow
test('T75 multi-guard: send-to-client flow has multi-select state for submission', () => {
  const workspace = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(workspace.includes('sendSelectedIds'), 'CompanyTimesheetsWorkspace missing sendSelectedIds state for multi-selection');
  assert(workspace.includes('toggleSendId') || workspace.includes('sendSelectedIds.has'), 'Missing toggle logic for send-to-client selection');
});

// T76: CompanyWeeklyApprovalsScreen uses submitWeeklyApproval
test('T76 multi-guard: CompanyWeeklyApprovalsScreen calls submitWeeklyApproval', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('submitWeeklyApproval'), 'CompanyWeeklyApprovalsScreen does not call submitWeeklyApproval');
  assert(screen.includes('timesheetIds'), 'submitWeeklyApproval call missing timesheetIds');
});

// T77: Send-to-client flow shows confirmation text before submit
test('T77 multi-guard: send-to-client flow shows confirmation step before submit', () => {
  const workspace = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(workspace.includes('Confirm — Send to Client') || workspace.includes('for approval?'), 'Send-to-client flow missing confirmation step');
  assert(workspace.includes('Modal'), 'Send-to-client flow missing Modal component for confirmation');
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

// T80: CompanyWeeklyApprovalsScreen detail view has COMPANY GUARD-PAY APPROVAL evidence layer
// (P1H-C renamed this label from "COMPANY APPROVAL" to "COMPANY GUARD-PAY APPROVAL" to
//  clearly distinguish Layer 4 payroll approval from Layer 5 client billing correction)
test('T80 three layers: CompanyWeeklyApprovalsScreen shows COMPANY APPROVAL evidence layer', () => {
  const screen = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(screen.includes('COMPANY GUARD-PAY APPROVAL'), 'CompanyWeeklyApprovalsScreen missing COMPANY GUARD-PAY APPROVAL evidence layer label');
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
// M. SITE/WEEK WORKFLOW — COMPANY TIMESHEETS SUBMISSION
// ═══════════════════════════════════════════════════════

// T98: CompanyTimesheetsWorkspace contains the "Send Weekly Timesheet to Client" action
test('T98 site-week: CompanyTimesheetsWorkspace has Send Weekly Timesheet to Client action', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('Send Weekly Timesheet to Client'), 'CompanyTimesheetsWorkspace missing "Send Weekly Timesheet to Client" action text');
});

// T99: No manual weekCommencing TextInput in the send-to-client flow
test('T99 site-week: send-to-client flow requires no manual week-commencing entry', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  // The send modal must NOT contain a TextInput for weekCommencing (it is derived from group.periodKey)
  assert(!src.includes("placeholder=\"e.g. 2026"), 'CompanyTimesheetsWorkspace still has a manual week-commencing text input');
  assert(src.includes('weekCommencing: group.periodKey'), 'weekCommencing must be derived from group.periodKey, not typed manually');
});

// T100: GroupedTimesheets type carries numeric siteId for derivation
test('T100 site-week: GroupedTimesheets type includes numericSiteId for site+week grouping', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('numericSiteId: number | null'), 'GroupedTimesheets missing numericSiteId field');
  assert(src.includes('clientId: number | null'), 'GroupedTimesheets missing clientId field');
  assert(src.includes('clientName: string | null'), 'GroupedTimesheets missing clientName field');
});

// T101: GroupedTimesheets tracks distinct guardCount for multi-guard display
test('T101 site-week: GroupedTimesheets tracks guardCount for multi-guard group display', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('guardCount'), 'GroupedTimesheets missing guardCount field');
  assert(src.includes('new Set(group.rows.map((r) => r.guardId)).size'), 'guardCount not computed from distinct guardIds');
});

// T102: Eligible rows auto-selected when modal opens
test('T102 site-week: eligible approved rows are auto-selected when send modal opens', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('new Set(rows.map((r) => r.id))'), 'Send modal does not auto-select all eligible rows by default');
  assert(src.includes('setSendSelectedIds(new Set(rows.map'), 'setSendSelectedIds not called with all rows on eligible load');
});

// T103: Unreviewed rows warning is displayed on group card
test('T103 site-week: unreviewed shifts warning shown on group header', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('unreviewedWarning'), 'Group header missing unreviewedWarning style');
  assert(src.includes('still require'), 'Group header missing "still require a decision" warning text');
  assert(src.includes('reviewedCount'), 'reviewedCount not used in warning computation');
});

// T104: Excluded row requires reason before final submit
test('T104 site-week: excluded rows require a reason before submission', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('All excluded shifts require a reason'), 'Missing exclusion-reason validation message');
  assert(src.includes('sendExclusionReasons'), 'sendExclusionReasons state missing');
  assert(src.includes('Reason for exclusion (required)'), 'Missing exclusion reason TextInput placeholder');
});

// T105: Final request derives clientId and siteId from group, not from user input
test('T105 site-week: final submitWeeklyApproval call derives clientId/siteId from group, not user input', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('clientId: sendGroup.clientId'), 'submitWeeklyApproval does not use sendGroup.clientId');
  assert(src.includes('siteId: sendGroup.siteId'), 'submitWeeklyApproval does not use sendGroup.siteId');
  assert(src.includes('weekCommencing: sendGroup.weekCommencing'), 'submitWeeklyApproval does not use sendGroup.weekCommencing');
  assert(src.includes('timesheetIds: Array.from(sendSelectedIds)'), 'submitWeeklyApproval does not use sendSelectedIds');
});

// T106: CompanyWeeklyApprovalsScreen no longer has "+ New Submission" creation path
test('T106 site-week: CompanyWeeklyApprovalsScreen has no "+ New Submission" button', () => {
  const src = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(!src.includes('+ New Submission'), 'CompanyWeeklyApprovalsScreen still has "+ New Submission" button');
  assert(!src.includes("'new-submission'"), 'CompanyWeeklyApprovalsScreen still has new-submission mode');
});

// T107: CompanyWeeklyApprovalsScreen still displays all tracking statuses
test('T107 site-week: CompanyWeeklyApprovalsScreen tracks Awaiting/Returned/Approved/Finalised statuses', () => {
  const src = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(src.includes('Awaiting Client Approval'), 'CompanyWeeklyApprovalsScreen missing Awaiting Client Approval status');
  assert(src.includes('Returned for Correction'), 'CompanyWeeklyApprovalsScreen missing Returned for Correction status');
  assert(src.includes('Client Approved'), 'CompanyWeeklyApprovalsScreen missing Client Approved status');
  assert(src.includes('Finalised'), 'CompanyWeeklyApprovalsScreen missing Finalised status');
  assert(src.includes('Resubmit to Client'), 'CompanyWeeklyApprovalsScreen missing resubmit action');
});

// T108: CompanyTimesheetsWorkspace calls getEligibleTimesheets with derived siteId + weekCommencing
test('T108 site-week: getEligibleTimesheets called with group-derived siteId and weekCommencing', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('getEligibleTimesheets(sendGroup.siteId, sendGroup.weekCommencing)'), 'getEligibleTimesheets not called with sendGroup.siteId and sendGroup.weekCommencing');
});

// T109: CompanyTimesheetsWorkspace calls submitWeeklyApproval (existing endpoint)
test('T109 site-week: submitWeeklyApproval (existing P1H endpoint) called from send flow', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('submitWeeklyApproval'), 'submitWeeklyApproval missing from CompanyTimesheetsWorkspace send flow');
});

// T110: Multiple guards can appear in the same site+week group
test('T110 site-week: multiple guards appear in same site+week group via distinct guardId tracking', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  // guardCount derived from Set of guardIds proves multi-guard grouping
  assert(src.includes('new Set(group.rows.map((r) => r.guardId)).size'), 'guardCount does not derive from distinct guard IDs within group');
  // guardCount displayed on group card
  assert(src.includes('guard{group.totals.guardCount !== 1'), 'guardCount not displayed on group card header');
});

// ═══════════════════════════════════════════════════════
// N. UX CONSOLIDATION — 4-LEVEL HIERARCHY
// ═══════════════════════════════════════════════════════

// T111: Overview renders Site+Week cards with "Review Site" — not individual shifts expanded
test('T111 ux-consolidation: overview renders Site+Week cards with Review Site button, not expanded shifts', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes("'overview'"), 'WorkspaceLevel overview missing');
  assert(src.includes('Review Site'), 'Overview missing "Review Site" button on site+week card');
  assert(src.includes("level === 'detail'"), 'Shift rendering must be gated on detail level');
});

// T112: Multiple sites remain separate groups (keyed by siteName + periodKey)
test('T112 ux-consolidation: multiple sites remain separate groups', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(
    src.includes('`${entry.siteName}__${periodKey}`') || src.includes("entry.siteName + '__' + periodKey") || src.includes('siteName}__${periodKey}'),
    'Groups not keyed by siteName + periodKey',
  );
});

// T113: Guards grouped inside site/week detail via GuardGroup type
test('T113 ux-consolidation: guards grouped inside site/week detail', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('GuardGroup'), 'GuardGroup type missing');
  assert(src.includes('guardGroups'), 'guardGroups computed value missing');
});

// T114: Individual shifts only rendered in detail view; collapsedGuardKeys controls guard expand
test('T114 ux-consolidation: individual shifts gated on detail level; guard groups collapsible', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes("level === 'detail'"), 'Shift rendering not gated on detail level');
  assert(src.includes('collapsedGuardKeys'), 'collapsedGuardKeys missing — guard groups must be collapsible');
});

// T115: reviewedCount incremented only for approved and rejected (not draft/submitted/returned)
test('T115 ux-consolidation: reviewedCount tracks approved and rejected shifts only', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  const approvedBlock = src.match(/rowStatus === 'approved'[\s\S]{0,300}reviewedCount/)?.[0] ?? '';
  const rejectedBlock = src.match(/rowStatus === 'rejected'[\s\S]{0,300}reviewedCount/)?.[0] ?? '';
  assert(approvedBlock, 'reviewedCount not incremented for approved status');
  assert(rejectedBlock, 'reviewedCount not incremented for rejected status');
  // draft and returned must NOT increment reviewedCount
  const draftBlock = src.match(/rowStatus === 'draft'[\s\S]{0,100}reviewedCount/)?.[0];
  assert(!draftBlock, 'draft must NOT increment reviewedCount');
});

// T116: getGroupWorkflowStatus returns needs-review for unreviewed groups
test('T116 ux-consolidation: getGroupWorkflowStatus returns needs-review for unreviewed groups', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('getGroupWorkflowStatus'), 'getGroupWorkflowStatus function missing');
  assert(src.includes("'needs-review'"), 'needs-review status value missing');
});

// T117: getGroupWorkflowStatus returns ready-for-client; label visible in UI
test('T117 ux-consolidation: getGroupWorkflowStatus returns ready-for-client; label in UI', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes("'ready-for-client'"), 'ready-for-client status value missing');
  assert(src.includes('Ready for Client'), 'Ready for Client label missing from UI');
});

// T118: Send button blocked when count > reviewedCount (any unreviewed shift)
test('T118 ux-consolidation: unreviewed shifts block Send button', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(
    src.includes('group.totals.count === group.totals.reviewedCount') ||
    src.includes('activeGroup.totals.count === activeGroup.totals.reviewedCount') ||
    src.includes('allReviewed') ||
    src.includes('detailAllReviewed'),
    'Send button not gated on all-reviewed condition',
  );
});

// T119: Draft shifts not in reviewedCount → send blocked
test('T119 ux-consolidation: draft shifts block Send (not counted as reviewed)', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  // draft must not appear as incrementing reviewedCount
  const draftInReviewed = src.match(/rowStatus === 'draft'[\s\S]{0,120}reviewedCount \+= 1/)?.[0];
  assert(!draftInReviewed, 'draft must NOT increment reviewedCount — it blocks send');
  // The send gate uses count === reviewedCount
  assert(src.includes('reviewedCount') && src.includes('totals.count'), 'Send gate missing count/reviewedCount comparison');
});

// T120: Submitted shifts (pendingCount) not in reviewedCount → send blocked
test('T120 ux-consolidation: submitted shifts block Send (pendingCount tracked separately)', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('pendingCount'), 'pendingCount tracking missing');
  const submittedInReviewed = src.match(/rowStatus === 'submitted'[\s\S]{0,120}reviewedCount \+= 1/)?.[0];
  assert(!submittedInReviewed, 'submitted must NOT increment reviewedCount — it blocks send');
});

// T121: Returned shifts (returnedCount) not in reviewedCount → send blocked
test('T121 ux-consolidation: returned shifts block Send (returnedCount tracked separately)', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('returnedCount'), 'returnedCount missing from GroupedTimesheets totals');
  const returnedInReviewed = src.match(/rowStatus === 'returned'[\s\S]{0,120}reviewedCount \+= 1/)?.[0];
  assert(!returnedInReviewed, 'returned must NOT increment reviewedCount — it blocks send');
});

// T122: All-reviewed group with approved rows enables Send
test('T122 ux-consolidation: all-reviewed group with approved rows enables Send', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('approvedCount > 0') || src.includes('approvedCount'), 'approvedCount not checked in Send enable condition');
  // allReviewed or detailAllReviewed must be in send condition
  assert(
    src.includes('detailAllReviewed') || src.includes('allReviewed') || src.includes('totals.count === '),
    'All-reviewed gate missing from Send enable logic',
  );
});

// T123: Financial amounts (£, Rate) absent from Timesheets operational UI output
test('T123 ux-consolidation: financial amounts absent from Timesheets operational UI', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  // formatRate must not be called in UI render (only in CSV export)
  // The detailSection titled "Rate & amounts" must be gone
  assert(!src.includes('Rate & amounts'), '"Rate & amounts" section must be removed from Timesheets UI');
  assert(!src.includes('Hourly rate:'), 'Hourly rate must not appear in Timesheets UI detail panel');
  assert(!src.includes('Claimed amount:'), 'Claimed amount must not appear in Timesheets UI detail panel');
  // formatRate still exists as function (needed for CSV)
  assert(src.includes('function formatRate'), 'formatRate function must be preserved (used by CSV export)');
});

// T124: Financial calculation functions preserved (not removed — used by CSV export + payroll)
test('T124 ux-consolidation: financial calc functions (getTimesheetRate, getAmountForHours) still present', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('getTimesheetRate'), 'getTimesheetRate must be preserved (financial logic)');
  assert(src.includes('getAmountForHours'), 'getAmountForHours must be preserved (financial logic)');
  assert(src.includes('formatCurrency'), 'formatCurrency must be preserved (CSV export)');
});

// T125: weekLabel present in group cards (e.g. "7–13 Sep 2026" format)
test('T125 ux-consolidation: weekLabel shown on site/week cards', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('weekLabel'), 'weekLabel missing from group/card display');
  assert(src.includes('getWeekRangeLabel'), 'getWeekRangeLabel helper missing');
});

// T126: Week selector navigation (weekOffset) present
test('T126 ux-consolidation: week selector navigation via weekOffset', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('weekOffset'), 'weekOffset state missing — week navigation not implemented');
  assert(src.includes('activeWeekStart'), 'activeWeekStart computed value missing');
  assert(src.includes('Prev') && src.includes('Next'), 'Prev/Next week navigation buttons missing');
});

// T127: WorkflowStatus filter with business-friendly labels
test('T127 ux-consolidation: WorkflowStatus filter with business-friendly labels', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('workflowStatusFilter'), 'workflowStatusFilter state missing');
  assert(src.includes('Needs Review'), 'Needs Review filter label missing');
  assert(src.includes('Returned for Correction'), 'Returned for Correction filter label missing');
});

// T128: Client Timesheets remains tracking-only (no new-submission path added back)
test('T128 ux-consolidation: Client Timesheets remains tracking-only', () => {
  const src = mobile('screens/CompanyWeeklyApprovalsScreen.tsx');
  assert(!src.includes('+ New Submission'), 'CompanyWeeklyApprovalsScreen must not have + New Submission');
  assert(!src.includes("'new-submission'"), 'CompanyWeeklyApprovalsScreen must not have new-submission mode');
  assert(src.includes('Awaiting Client Approval'), 'Client Timesheets must still show Awaiting Client Approval status');
  assert(src.includes('Finalised'), 'Client Timesheets must still show Finalised status');
});

// ═══════════════════════════════════════════════════════
// P1H WORKFLOW STATE UX FIX  T129–T143
// ═══════════════════════════════════════════════════════

// T129: Draft timesheets show no editable Company review controls
test('T129 workflow-state-ux: draft has no Company review controls', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('isSubmittedForReview'), 'isSubmittedForReview gate missing — Company review controls not gated by status');
  // Approve / Return for correction / Reject must only be inside the isSubmittedForReview block
  const submittedGateIdx = src.indexOf('isSubmittedForReview ?');
  const approveIdx = src.indexOf("'Approving...' : 'Approve'");
  assert(submittedGateIdx > 0 && approveIdx > submittedGateIdx, 'Approve button must be inside isSubmittedForReview block');
});

// T130: Draft detail panel shows "Awaiting Guard Submission" state message (P1H-C UX: separate title + body)
test('T130 workflow-state-ux: draft panel shows Awaiting Guard Submission message', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('Awaiting Guard Submission'), 'Workflow state heading for draft missing in detail panel');
  assert(src.includes('The Guard must submit this timesheet before Company review.'), 'Draft body text missing');
  assert(src.includes('getWorkflowStatePanel'), 'getWorkflowStatePanel helper missing');
});

// T131: Submitted timesheet shows Company review controls
test('T131 workflow-state-ux: submitted shows Company review controls', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('isSubmittedForReview'), 'isSubmittedForReview gate missing');
  assert(src.includes("normalizeStatus(activeSelected?.approvalStatus) === 'submitted'"), 'isSubmittedForReview must check submitted status');
});

// T132: Approved timesheet detail shows view-only "Guard Pay Approved" panel (P1H-C UX: shows hours + inclusion status)
test('T132 workflow-state-ux: approved panel shows Guard Pay Approved with hours', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('Guard Pay Approved:'), 'Missing Guard Pay Approved label in approved panel');
  assert(src.includes('Not yet included in a Client Timesheet'), 'Missing inclusion status in approved panel');
});

// T133: Rejected timesheet detail shows "Company Review Complete — Rejected" with exclusion explanation
test('T133 workflow-state-ux: rejected panel shows Company Review Complete — Rejected', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('Company Review Complete — Rejected'), 'Missing rejected view-only heading');
  assert(src.includes('will not be included in the Client weekly timesheet'), 'Missing exclusion explanation');
});

// T134: Returned timesheet detail shows "Awaiting Guard Resubmission" heading + body (P1H-C UX: structured panel)
test('T134 workflow-state-ux: returned panel shows Awaiting Guard Resubmission heading', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('Awaiting Guard Resubmission'), 'Missing "Awaiting Guard Resubmission" heading');
  assert(src.includes('returned to the Guard for correction. Awaiting their resubmission.'), 'Missing returned body text');
});

// T135: awaitingGuardCount incremented for draft AND returned
test('T135 workflow-state-ux: awaitingGuardCount tracks draft + returned', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  const draftBlock = /rowStatus === 'draft'[\s\S]{0,300}awaitingGuardCount/.test(src);
  const returnedBlock = /rowStatus === 'returned'[\s\S]{0,300}awaitingGuardCount/.test(src);
  assert(draftBlock, 'awaitingGuardCount not incremented for draft status');
  assert(returnedBlock, 'awaitingGuardCount not incremented for returned status');
});

// T136: awaitingCompanyCount incremented for submitted only
test('T136 workflow-state-ux: awaitingCompanyCount tracks submitted only', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  const submittedBlock = /rowStatus === 'submitted'[\s\S]{0,300}awaitingCompanyCount/.test(src);
  assert(submittedBlock, 'awaitingCompanyCount not incremented for submitted status');
  assert(!src.includes("rowStatus === 'approved'\n") || !/rowStatus === 'approved'[\s\S]{0,150}awaitingCompanyCount/.test(src), 'awaitingCompanyCount must not be incremented for approved');
});

// T137: Draft blocks Send (awaitingGuardCount > 0 in gate)
test('T137 workflow-state-ux: draft blocks Send via awaitingGuardCount', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('awaitingGuardCount === 0'), 'awaitingGuardCount === 0 not present in send gate');
});

// T138: Submitted blocks Send (awaitingCompanyCount > 0 in gate)
test('T138 workflow-state-ux: submitted blocks Send via awaitingCompanyCount', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('awaitingCompanyCount === 0'), 'awaitingCompanyCount === 0 not present in send gate');
});

// T139: Returned blocks Send (counted in awaitingGuardCount)
test('T139 workflow-state-ux: returned blocks Send because it increments awaitingGuardCount', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  const returnedTrackedInGuard = /rowStatus === 'returned'[\s\S]{0,300}awaitingGuardCount/.test(src);
  assert(returnedTrackedInGuard, 'returned status must increment awaitingGuardCount (to block Send)');
  assert(src.includes('awaitingGuardCount === 0'), 'awaitingGuardCount === 0 send gate missing');
});

// T140: Rejected counts as reviewed but is excluded from client submission eligible rows
test('T140 workflow-state-ux: rejected counted as reviewed; client submission uses eligible rows only', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  const rejectedIncrementsReviewed = /rowStatus === 'rejected'[\s\S]{0,200}reviewedCount/.test(src);
  assert(rejectedIncrementsReviewed, 'rejected status must increment reviewedCount');
  assert(src.includes('timesheetIds: Array.from(sendSelectedIds)'), 'Client submission must use sendSelectedIds (eligible rows only)');
});

// T141: All reviewed + approvedCount > 0 enables Send (new gate semantics)
test('T141 workflow-state-ux: all reviewed + approvedCount > 0 enables Send', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('awaitingGuardCount === 0'), 'awaitingGuardCount === 0 missing from send gate');
  assert(src.includes('awaitingCompanyCount === 0'), 'awaitingCompanyCount === 0 missing from send gate');
  assert(src.includes('approvedCount > 0'), 'approvedCount > 0 check missing from send gate');
});

// T142: KPIs include Awaiting Guards and Awaiting Company Review
test('T142 workflow-state-ux: KPIs distinguish Guard action vs Company action', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes('Awaiting Guards'), 'KPI label "Awaiting Guards" missing');
  assert(src.includes('Awaiting Company Review'), 'KPI label "Awaiting Company Review" missing');
  assert(src.includes('awaitingGuards'), 'awaitingGuards KPI computed value missing');
  assert(src.includes('awaitingCompanyReview'), 'awaitingCompanyReview KPI computed value missing');
});

// T143: Business-friendly status labels for all five states
test('T143 workflow-state-ux: business-friendly status labels for all states', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes("case 'draft': return 'Awaiting Guard Submission'"), 'formatStatusLabel: draft label missing');
  assert(src.includes("case 'submitted': return 'Awaiting Company Review'"), 'formatStatusLabel: submitted label missing');
  assert(src.includes("case 'approved': return 'Reviewed — Approved'"), 'formatStatusLabel: approved label missing');
  assert(src.includes("case 'rejected': return 'Reviewed — Rejected'"), 'formatStatusLabel: rejected label missing');
  assert(src.includes("case 'returned': return 'Returned to Guard — Awaiting Resubmission'"), 'formatStatusLabel: returned label missing');
});

// ═══════════════════════════════════════════════════════
// P1H SITE WORKFLOW BADGE CORRECTION  T144–T149
// ═══════════════════════════════════════════════════════

// T144: DRAFT shifts → badge Awaiting Guard (NOT Returned for Correction)
test('T144 badge-fix: draft shifts derive Awaiting Guard badge not Returned for Correction', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes("if (totals.awaitingGuardCount > 0) return 'awaiting-guard'"), 'awaitingGuardCount > 0 must return awaiting-guard, not returned');
  assert(src.includes("Awaiting Guard"), 'WorkflowBadge must render Awaiting Guard label');
  assert(!src.includes("if (totals.awaitingGuardCount > 0) return 'returned'"), 'awaitingGuardCount must NOT return returned');
});

// T145: SUBMITTED shifts → badge Awaiting Company Review
test('T145 badge-fix: submitted shifts derive Awaiting Company Review badge', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes("if (totals.awaitingCompanyCount > 0) return 'needs-review'"), 'awaitingCompanyCount > 0 must return needs-review');
  assert(src.includes("Awaiting Company Review"), 'WorkflowBadge must render Awaiting Company Review for needs-review status');
});

// T146: all reviewed, no Client submission → Ready for Client
test('T146 badge-fix: all reviewed no client submission gives Ready for Client', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(src.includes("if (totals.approvedCount > 0) return 'ready-for-client'"), 'approvedCount > 0 must return ready-for-client when no client submission');
  assert(src.includes("Ready for Client"), 'Ready for Client badge label missing');
});

// T147: actual Client disputed submission → Returned for Correction (not guard states)
test('T147 badge-fix: Client disputed submission gives Returned for Correction; guard states do not', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(/cs === 'disputed'[\s\S]{0,50}return 'returned'/.test(src), "Returned for Correction must derive from cs === 'disputed' only");
  assert(!src.includes("if (totals.awaitingGuardCount > 0) return 'returned'"), 'Guard awaitingGuardCount must NOT trigger Returned for Correction');
  assert(src.includes('clientSubmissionStatus'), 'clientSubmissionStatus parameter must be present in getGroupWorkflowStatus');
});

// T148: Client pending_approval submission → Awaiting Client Approval
test('T148 badge-fix: pending_approval Client submission gives Awaiting Client Approval', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(/cs === 'pending_approval'[\s\S]{0,100}return 'awaiting-client'/.test(src), "pending_approval must return awaiting-client");
  assert(src.includes('Awaiting Client Approval'), 'Awaiting Client Approval badge label missing');
});

// T149: Client client_approved submission → Client Approved
test('T149 badge-fix: client_approved Client submission gives Client Approved badge', () => {
  const src = mobile('components/company/CompanyTimesheetsWorkspace.tsx');
  assert(/cs === 'client_approved'[\s\S]{0,50}return 'client-approved'/.test(src), "client_approved must return client-approved");
  assert(src.includes('Client Approved'), 'Client Approved badge label missing');
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
  console.log(`\n══ P1H UX CONSOLIDATION: ${passed} PASS / ${failed} FAIL ══`);
  if (failed > 0) { console.error('FOCUSED SPEC: FAIL'); process.exit(1); }
  else console.log('FOCUSED SPEC: PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
