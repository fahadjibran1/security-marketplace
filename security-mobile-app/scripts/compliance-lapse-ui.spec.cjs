// Compliance phase 1C: the compliance_lapse alert in the company Attention / Live Operations workflow.
// Pure logic runs through the shared TypeScript loader; screen wiring is asserted against the source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTs } = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const resolution = loadTs('src/components/company/alertResolution.ts');
const policy = loadTs('src/components/company/liveOperationsPolicy.ts');
const overview = loadTs('src/components/company/dashboardOverview.ts');
const dashboard = read('src/screens/CompanyDashboardScreen.tsx');
const liveOps = read('src/components/company/CompanyLiveOperationsWorkspace.tsx');
const overviewCard = read('src/components/company/CompanyDashboardOverview.tsx');
const backendReasons = fs.readFileSync(path.join(root, '..', 'security-backend-nest', 'src', 'safety-alert', 'resolution-reasons.ts'), 'utf8');

let count = 0;
function test(name, work) {
  work();
  count += 1;
  console.log(`PASS ${name}`);
}

test('Resolution: its own family, the backend set exactly, a note always required', () => {
  assert.equal(resolution.resolutionFamilyForAlert('compliance_lapse'), 'compliance_lapse');
  const ui = resolution.resolutionOptions('compliance_lapse').map((o) => o.value);
  const backend = [...backendReasons.split('export const COMPLIANCE_LAPSE_RESOLUTION_REASONS = [')[1].split('] as const;')[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ui, backend, 'the dialog can never offer a reason the API refuses');
  for (const value of ui) assert.equal(resolution.requiresResolutionNote('compliance_lapse', value), true, value);
  assert.equal(resolution.alertTypeLabel('compliance_lapse'), 'Compliance lapse');
  assert.notEqual(resolution.resolutionFamilyForAlert('compliance_lapse'), 'emergency');
});

test('Attention: persisted (never aged out), ranked straight after an SOS', () => {
  assert.ok(policy.PERSISTED_ATTENTION_CATEGORIES.includes('compliance_lapse'));
  assert.equal(policy.isDerivedAttentionCategory('compliance_lapse'), false);
  assert.equal(overview.ATTENTION_PRIORITY_RANK.compliance_lapse, 1);
  assert.ok(overview.ATTENTION_PRIORITY_RANK.compliance_lapse > overview.ATTENTION_PRIORITY_RANK.panic);
});

test('Never an SOS: panic surfaces key on type "panic" only, and compliance_lapse has its own category', () => {
  assert.match(dashboard, /const activePanicAlerts = React\.useMemo\(\s*\(\) => outstandingAlerts\.filter\(\(alert\) => \(alert\.type \|\| ''\)\.toLowerCase\(\) === 'panic'\)/);
  const block = dashboard.split("=== 'compliance_lapse')")[1].split(/\}\);\r?\n/)[0];
  assert.match(block, /category: 'compliance_lapse'/);
  assert.doesNotMatch(block, /category: 'panic'|category: 'safety'/);
  assert.match(block, /issueType: 'Urgent compliance review'/);
  // Not swept into the generic safety bucket either.
  assert.match(dashboard, /\['welfare', 'late_checkin', 'other'\]\.includes\(\(alert\.type \|\| ''\)\.toLowerCase\(\)\)/);
});

test('Shown red and labelled "Compliance" on the dashboard, the overview card and Live Operations', () => {
  assert.match(dashboard, /case 'missed_shift':\s*case 'compliance_lapse':\s*return 'red';/);
  assert.match(dashboard, /case 'compliance_lapse':\s*return 'Compliance';/);
  assert.match(overviewCard, /case 'missed_shift':\s*case 'compliance_lapse':\s*return 'red';/);
  assert.match(overviewCard, /case 'compliance_lapse':\s*return 'Compliance';/);
  assert.match(liveOps, /\['panic', 'incident', 'missed_shift', 'compliance_lapse'\]\.includes\(category\)\) return 'red'/);
  assert.match(liveOps, /case 'compliance_lapse': return 'Compliance';/);
  assert.match(dashboard, /\|\| item\.category === 'compliance_lapse'\s*\) \{\s*setActiveSection\('alerts'\)/);
});

test('Live Operations: Acknowledge first, then Resolve through the existing alert path; nothing ends the shift', () => {
  const branch = liveOps.split("if (item.category === 'compliance_lapse') {")[1].split(/\r?\n  \}\r?\n/)[0];
  assert.match(branch, /onUrgentAlertFollowUp\(item, 'acknowledge'\)/);
  assert.match(branch, /onUrgentAlertFollowUp\(item, 'close'\)/);
  assert.doesNotMatch(branch, /check-?out|bookOff|cancel|unassign|updateShift/i);
});

test('Types: the alert carries its category and reason, never evidence', () => {
  const types = read('src/types/models.ts');
  const alertType = types.split('export interface SafetyAlert {')[1].split(/\r?\n\}\r?\n/)[0];
  assert.match(alertType, /\| 'compliance_lapse';/);
  assert.match(alertType, /complianceCategory\?: 'sia' \| 'right_to_work' \| null;/);
  assert.match(alertType, /complianceReason\?: 'expired' \| 'not_confirmed' \| 'missing' \| null;/);
  assert.doesNotMatch(alertType, /evidenceReference|licenceNumber|rightToWorkExcuse/);
});

console.log(`compliance-lapse-ui: ${count} passed`);
