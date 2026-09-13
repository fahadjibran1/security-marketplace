/**
 * P1H-C WORKFLOW CLARITY UX — 14 focused assertions + 8 request-match regression assertions
 *
 * Verifies that the Company Timesheets workspace and Client Timesheet screen
 * contain the correct per-state messaging, terminology, and navigation controls
 * required by the P1H-C UX Clarity spec. No network calls, no DB access.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

const WORKSPACE = path.resolve(
  __dirname,
  '../../security-mobile-app/src/components/company/CompanyTimesheetsWorkspace.tsx',
);
const WEEKLY_SCREEN = path.resolve(
  __dirname,
  '../../security-mobile-app/src/screens/CompanyWeeklyApprovalsScreen.tsx',
);
const CLIENT_WEEKLY_SCREEN = path.resolve(
  __dirname,
  '../../security-mobile-app/src/screens/ClientWeeklyApprovalsScreen.tsx',
);
const DASHBOARD = path.resolve(
  __dirname,
  '../../security-mobile-app/src/screens/CompanyDashboardScreen.tsx',
);
const MODELS = path.resolve(
  __dirname,
  '../../security-mobile-app/src/types/models.ts',
);
const COMPANY_APPROVALS = path.resolve(
  __dirname,
  '../../security-mobile-app/src/screens/CompanyWeeklyApprovalsScreen.tsx',
);

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

let passCount = 0;
let failCount = 0;

function gate(label: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS  ${label}`);
    passCount++;
  } catch (err: any) {
    console.error(`FAIL  ${label} — ${err.message}`);
    failCount++;
  }
}

const workspace = readFileSync(WORKSPACE, 'utf-8');
const weeklyScreen = readFileSync(WEEKLY_SCREEN, 'utf-8');
const clientWeeklyScreen = readFileSync(CLIENT_WEEKLY_SCREEN, 'utf-8');
const dashboard = readFileSync(DASHBOARD, 'utf-8');
const models = readFileSync(MODELS, 'utf-8');
const companyApprovals = readFileSync(COMPANY_APPROVALS, 'utf-8');

// ── SHIFT REVIEW PANEL: DRAFT state ────────────────────────────────────────
gate('UX-1  Draft panel: "Awaiting Guard Submission" heading present', () => {
  assert(workspace.includes('Awaiting Guard Submission'), 'heading not found');
});

gate('UX-2  Draft panel: body explains guard must submit first', () => {
  assert(
    workspace.includes('The Guard must submit this timesheet before Company review.'),
    'body text not found',
  );
});

// ── SHIFT REVIEW PANEL: RETURNED state ─────────────────────────────────────
gate('UX-3  Returned panel: "Awaiting Guard Resubmission" heading present', () => {
  assert(workspace.includes('Awaiting Guard Resubmission'), 'heading not found');
});

gate('UX-4  Returned panel: body explains guard must correct and resubmit', () => {
  assert(
    workspace.includes('returned to the Guard for correction. Awaiting their resubmission.'),
    'body text not found',
  );
});

// ── SHIFT REVIEW PANEL: APPROVED state ────────────────────────────────────
gate('UX-5  Approved panel: "Guard Pay Approved:" label with hours', () => {
  assert(workspace.includes('Guard Pay Approved:'), '"Guard Pay Approved:" not found in approved panel');
});

gate('UX-6  Approved panel: client inclusion status text present', () => {
  assert(
    workspace.includes('Not yet included in a Client Timesheet') &&
      workspace.includes('Included in Client Timesheet'),
    'inclusion/exclusion status text not found',
  );
});

// ── SHIFT REVIEW PANEL: REJECTED state ────────────────────────────────────
gate('UX-7  Rejected panel: "Company Review Complete — Rejected" heading', () => {
  assert(workspace.includes('Company Review Complete — Rejected'), 'heading not found');
});

gate('UX-8  Rejected panel: exclusion explanation present', () => {
  assert(
    workspace.includes('will not be included in the Client weekly timesheet'),
    'exclusion text not found',
  );
});

// ── TERMINOLOGY ────────────────────────────────────────────────────────────
gate('UX-9  Column header updated: "Guard Pay Approved" (not "Co. Approved")', () => {
  assert(workspace.includes('Guard Pay Approved'), '"Guard Pay Approved" header not found');
  assert(!workspace.includes('>Co. Approved<'), '"Co. Approved" header still present');
});

gate('UX-10 Section title: "COMPANY GUARD-PAY APPROVAL" (not "COMPANY APPROVAL")', () => {
  assert(workspace.includes('COMPANY GUARD-PAY APPROVAL'), 'section title not updated');
  assert(!workspace.includes('>COMPANY APPROVAL<'), 'old section title still present');
});

gate('UX-11 Input section: "Guard Pay Hours" (not "Approved hours")', () => {
  assert(workspace.includes('Guard Pay Hours'), '"Guard Pay Hours" label not found');
});

gate('UX-12 Meta text: "Guard Pay approved h" in site card and detail header', () => {
  const count = (workspace.match(/Guard Pay approved h/g) || []).length;
  assert(count >= 2, `Expected "Guard Pay approved h" at least twice, found ${count}`);
});

// ── SITE/WEEK PRIMARY ACTION ────────────────────────────────────────────────
gate('UX-13 "Open Client Timesheet" button text present for existing-request case', () => {
  assert(workspace.includes('Open Client Timesheet'), '"Open Client Timesheet" text not found');
});

gate('UX-14 Dashboard passes onNavigateToClientTimesheets to workspace', () => {
  assert(
    dashboard.includes('onNavigateToClientTimesheets') &&
      dashboard.includes("setActiveSection('weekly-approvals')"),
    'navigation callback not wired in dashboard',
  );
});

// ── P1H-C CLIENT TIMESHEET SCREEN: billing summary hierarchy ───────────────
gate('UX-BONUS  Disputed line: billing summary card with Guard Claim / Guard Pay / Client Submitted rows', () => {
  assert(weeklyScreen.includes('Billing Summary'), '"Billing Summary" card title not found');
  assert(weeklyScreen.includes('Guard Pay Approved:'), '"Guard Pay Approved:" row not found in summary');
  assert(weeklyScreen.includes('Client Submitted (V'), '"Client Submitted" row not found in summary');
  assert(weeklyScreen.includes('Pending Client Billing Correction:'), '"Pending Client Billing Correction" row not found');
});

// ── REQUEST MATCH REGRESSION: type contract ─────────────────────────────────
// Extract just the ClientWeeklyApprovalSummary interface block for precise assertions
const summaryMatch = models.match(/export interface ClientWeeklyApprovalSummary \{[\s\S]*?\n\}/);
const summaryBlock = summaryMatch ? summaryMatch[0] : '';

gate('UX-MATCH-1  ClientWeeklyApprovalSummary type uses nested site.id (not flat siteId)', () => {
  assert(summaryBlock !== '', 'ClientWeeklyApprovalSummary interface not found in models.ts');
  assert(
    summaryBlock.includes('site: { id: number;'),
    'interface still declares flat siteId instead of nested site object',
  );
  assert(
    !summaryBlock.includes('siteId: number'),
    'interface still has stale flat siteId field — produces undefined at runtime',
  );
});

gate('UX-MATCH-2  ClientWeeklyApprovalSummary type uses nested site.name (not flat siteName)', () => {
  assert(summaryBlock !== '', 'ClientWeeklyApprovalSummary interface not found in models.ts');
  assert(
    !summaryBlock.includes('siteName: string'),
    'interface still has stale flat siteName field — produces undefined at runtime',
  );
});

// ── REQUEST MATCH REGRESSION: workspace lookup key ──────────────────────────
gate('UX-MATCH-3  weeklyApprovalLookup key uses wa.site.id (not wa.siteId)', () => {
  assert(
    workspace.includes('wa.site.id'),
    'lookup key still uses wa.siteId — produces undefined__weekCommencing and never matches',
  );
  assert(
    !workspace.includes('wa.siteId'),
    'wa.siteId still referenced in lookup — would be undefined at runtime',
  );
});

// ── REQUEST MATCH REGRESSION: clientSubmissionStatusLabel mappings ───────────
gate('UX-MATCH-4  DISPUTED status → "Returned for Correction" label', () => {
  assert(
    workspace.includes("case 'disputed': return 'Returned for Correction'"),
    'disputed status not mapped to "Returned for Correction"',
  );
});

gate('UX-MATCH-5  PENDING_APPROVAL / RESOLVED status → "Awaiting Client Approval" label', () => {
  assert(
    workspace.includes("case 'pending_approval': return 'Awaiting Client Approval'") &&
      workspace.includes("case 'resolved': return 'Awaiting Client Approval'"),
    'pending_approval or resolved not mapped to "Awaiting Client Approval"',
  );
});

gate('UX-MATCH-6  CLIENT_APPROVED status → "Client Approved" label', () => {
  assert(
    workspace.includes("case 'client_approved': return 'Client Approved'"),
    'client_approved not mapped to "Client Approved"',
  );
});

gate('UX-MATCH-7  LOCKED status → "Finalised" label', () => {
  assert(
    workspace.includes("case 'locked': return 'Finalised'"),
    'locked not mapped to "Finalised"',
  );
});

// ── REQUEST MATCH REGRESSION: site name display ──────────────────────────────
gate('UX-MATCH-8  CompanyWeeklyApprovalsScreen displays site?.name (not siteName)', () => {
  assert(
    weeklyScreen.includes('item.site?.name') && weeklyScreen.includes('detail.site?.name'),
    'CompanyWeeklyApprovalsScreen still uses stale siteName property',
  );
  assert(
    !weeklyScreen.includes('item.siteName') && !weeklyScreen.includes('detail.siteName'),
    'stale .siteName reference still present in CompanyWeeklyApprovalsScreen',
  );
});

gate('UX-MATCH-9  ClientWeeklyApprovalsScreen displays site?.name (not siteName)', () => {
  assert(
    clientWeeklyScreen.includes('item.site?.name') && clientWeeklyScreen.includes('detail.site?.name'),
    'ClientWeeklyApprovalsScreen still uses stale siteName property',
  );
  assert(
    !clientWeeklyScreen.includes('item.siteName') && !clientWeeklyScreen.includes('detail.siteName'),
    'stale .siteName reference still present in ClientWeeklyApprovalsScreen',
  );
});

// ── ADJUST BILLING REGRESSION: type contract ────────────────────────────────
const companyApprovalLineMatch = models.match(/export interface CompanyApprovalLine \{[\s\S]*?\n\}/);
const companyApprovalLineBlock = companyApprovalLineMatch ? companyApprovalLineMatch[0] : '';
const disputeSummaryMatch = models.match(/export interface ClientShiftDisputeSummary \{[\s\S]*?\n\}/);
const disputeSummaryBlock = disputeSummaryMatch ? disputeSummaryMatch[0] : '';

gate('UX-ADJUST-1  CompanyApprovalLine.timesheet includes id field (needed for revise-approved-time)', () => {
  assert(companyApprovalLineBlock !== '', 'CompanyApprovalLine interface not found in models.ts');
  assert(
    companyApprovalLineBlock.includes('id?: number'),
    'CompanyApprovalLine.timesheet.id not declared — timesheetId for API call cannot be resolved',
  );
});

gate('UX-ADJUST-2  ClientShiftDisputeSummary includes optional line field (company endpoint returns nested line.id)', () => {
  assert(disputeSummaryBlock !== '', 'ClientShiftDisputeSummary interface not found in models.ts');
  assert(
    disputeSummaryBlock.includes('line?: { id: number }'),
    'ClientShiftDisputeSummary missing line?.id — dispute-to-line matching cannot work',
  );
});

// ── ADJUST BILLING REGRESSION: button visibility gates ──────────────────────
gate('UX-ADJUST-3  Adjust Billing button: timesheetId from line.timesheet.id (not line.timesheetId)', () => {
  assert(
    companyApprovals.includes('const timesheetId = line.timesheet?.id ?? null'),
    'timesheetId still reads from non-existent line.timesheetId — button will always be hidden',
  );
  assert(
    !companyApprovals.includes('(line as any).timesheetId ?? null'),
    'stale (line as any).timesheetId access still present — produces null at runtime',
  );
});

gate('UX-ADJUST-4  Adjust Billing button: dispute matched by d.line.id === line.id (not d.timesheetId)', () => {
  assert(
    companyApprovals.includes("d.line?.id === line.id && d.status === 'open'"),
    'dispute matching still uses d.timesheetId — timesheetId is undefined in company endpoint response',
  );
  assert(
    !companyApprovals.includes("d.timesheetId === timesheetId && d.status === 'open'"),
    'stale d.timesheetId matching still present — will never find an open dispute',
  );
});

gate('UX-ADJUST-5  Adjust Billing button: shown only when DISPUTED + open dispute + timesheetId not null', () => {
  assert(
    companyApprovals.includes("detail.status === 'disputed'") &&
      companyApprovals.includes('hasOpenDispute && timesheetId != null'),
    'gate condition for Adjust Billing button not found',
  );
});

gate('UX-ADJUST-6  Adjust Billing button: hidden when request not disputed (PENDING/RESOLVED/LOCKED)', () => {
  // Outer IIFE is wrapped in {detail.status === 'disputed' && (() => {...})()}
  // so the entire Layer E (including the button) is absent for non-disputed states
  assert(
    companyApprovals.includes("detail.status === 'disputed' && (() =>"),
    "Layer E not gated on detail.status === 'disputed' — button would appear for non-disputed states",
  );
});

// ── ADJUST BILLING REGRESSION: form pre-fill from V1 snapshot ───────────────
gate('UX-ADJUST-7  Form pre-fill: uses isoToHhmm helper (not raw ISO strings)', () => {
  assert(
    companyApprovals.includes('function isoToHhmm('),
    'isoToHhmm helper function not found — form pre-fill cannot display HH:MM local times',
  );
  assert(
    companyApprovals.includes('setBillingStartInput(isoToHhmm('),
    'billingStartInput not set via isoToHhmm — will show raw ISO instead of HH:MM',
  );
});

gate('UX-ADJUST-8  Form pre-fill: uses V1 snapshot (companyApprovedStartAtSubmission) not Layer D fields', () => {
  assert(
    companyApprovals.includes('line.companyApprovedStartAtSubmission') &&
      companyApprovals.includes('line.companyApprovedEndAtSubmission'),
    'V1 snapshot fields (companyApproved*AtSubmission) not used in pre-fill — would show Layer D times',
  );
});

gate('UX-ADJUST-9  Form submit: uses hhmmToIso to convert HH:MM back to ISO for API', () => {
  assert(
    companyApprovals.includes('function hhmmToIso('),
    'hhmmToIso helper function not found — form cannot convert local time to UTC ISO for API call',
  );
  assert(
    companyApprovals.includes('hhmmToIso(billingShiftDate, billingStartInput.trim()'),
    'handleBillingCorrection does not call hhmmToIso for startIso',
  );
});

gate('UX-ADJUST-10 Form submit: uses correct timesheetId (from line.timesheet.id) for revise-approved-time', () => {
  assert(
    companyApprovals.includes('timesheetId: billingCorrectTimesheetId'),
    'reviseApprovedTime not called with billingCorrectTimesheetId',
  );
  // billingCorrectTimesheetId is set from line.timesheet?.id (proven by UX-ADJUST-3)
  assert(
    companyApprovals.includes('setBillingCorrectTimesheetId(timesheetId)'),
    'billingCorrectTimesheetId not set from the corrected timesheetId',
  );
});

// ── ADJUST BILLING REGRESSION: payroll and snapshot independence ──────────────
gate('UX-ADJUST-11 Guard pay (approvedMinutes) is rendered separately from billing correction — immutability', () => {
  assert(
    companyApprovals.includes('approvedMinutes / 60') &&
      companyApprovals.includes('Guard pay (') &&
      companyApprovals.includes('is unchanged'),
    'Guard pay independence message not found in billing correction section',
  );
});

gate('UX-ADJUST-12 V1 snapshot (approvedHoursAtSubmission) displayed independently of billing correction', () => {
  assert(
    companyApprovals.includes('approvedHoursAtSubmission'),
    'approvedHoursAtSubmission not referenced — V1 snapshot row missing from billing summary',
  );
});

// ── RESUBMIT REGRESSION: correct timesheetId extraction ─────────────────────
gate('UX-RESUB-1  handleResubmit extracts timesheet ID from line.timesheet.id (not line.timesheetId)', () => {
  assert(
    companyApprovals.includes('detail.lines.map((l) => l.timesheet?.id).filter(Boolean)'),
    'handleResubmit still reads (l as any).timesheetId — produces empty array, no API call made',
  );
  assert(
    !companyApprovals.includes('(l as any).timesheetId'),
    'stale (l as any).timesheetId access still present in handleResubmit',
  );
});

gate('UX-RESUB-2  handleResubmit shows visible error when no timesheet IDs found (no silent no-op)', () => {
  assert(
    companyApprovals.includes("setActionError('No timesheets found for resubmission."),
    'empty-ids guard silently returns without setting actionError — button appears to do nothing',
  );
});

gate('UX-RESUB-3  Resubmit button gated on detail.status === resolved only', () => {
  assert(
    companyApprovals.includes("detail.status === 'resolved' && ("),
    "resubmit button not gated on detail.status === 'resolved'",
  );
});

gate('UX-RESUB-4  Resubmit button disabled during in-flight request (double-submit protection)', () => {
  assert(
    companyApprovals.includes('disabled={actionLoading}') &&
      companyApprovals.includes("actionLoading ? 'Resubmitting...' : 'Resubmit to Client'"),
    'resubmit button not disabled during actionLoading — double-submit possible',
  );
});

gate('UX-RESUB-5  Resubmit action calls resubmitWeeklyApproval with timesheetIds payload', () => {
  assert(
    companyApprovals.includes('await resubmitWeeklyApproval(selectedId, { timesheetIds: ids })'),
    'resubmitWeeklyApproval not called with timesheetIds — V2 would never be created',
  );
});

gate('UX-RESUB-6  Resubmit success reloads detail and list (V2 visible after save)', () => {
  assert(
    companyApprovals.includes('await openDetail(selectedId)') &&
      companyApprovals.includes('await loadList()'),
    'detail/list not reloaded after successful resubmit — UI would not reflect V2',
  );
});

gate('UX-RESUB-7  Resubmit failure sets visible actionError (no silent failure)', () => {
  assert(
    companyApprovals.includes("formatApiErrorMessage(err, 'Failed to resubmit.')"),
    'resubmit catch block does not set actionError — failure is silent',
  );
  assert(
    companyApprovals.includes("actionError && <Text"),
    'actionError not rendered in JSX — error message would be invisible even if set',
  );
});

// ── FINAL REPORT ────────────────────────────────────────────────────────────
console.log('');
console.log(`══ P1H-C WORKFLOW CLARITY UX: ${passCount} PASS / ${failCount} FAIL ══`);
if (failCount === 0) {
  console.log('FOCUSED SPEC: PASS');
  console.log(JSON.stringify({ event: 'p1hc_ux_clarity_spec_passed', tests: passCount, scope: 'shift-review-panel-terminology-actions-navigation-request-match-adjust-billing-resubmit' }));
} else {
  console.error('FOCUSED SPEC: FAIL');
  process.exit(1);
}
