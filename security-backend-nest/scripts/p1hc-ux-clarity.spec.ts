/**
 * P1H-C WORKFLOW CLARITY UX — 14 focused assertions
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
const DASHBOARD = path.resolve(
  __dirname,
  '../../security-mobile-app/src/screens/CompanyDashboardScreen.tsx',
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
const dashboard = readFileSync(DASHBOARD, 'utf-8');

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

// ── FINAL REPORT ────────────────────────────────────────────────────────────
console.log('');
console.log(`══ P1H-C WORKFLOW CLARITY UX: ${passCount} PASS / ${failCount} FAIL ══`);
if (failCount === 0) {
  console.log('FOCUSED SPEC: PASS');
  console.log(JSON.stringify({ event: 'p1hc_ux_clarity_spec_passed', tests: passCount, scope: 'shift-review-panel-terminology-actions-navigation' }));
} else {
  console.error('FOCUSED SPEC: FAIL');
  process.exit(1);
}
