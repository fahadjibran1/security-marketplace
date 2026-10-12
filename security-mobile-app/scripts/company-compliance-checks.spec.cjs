// Company Compliance — company-recorded SIA and Right to Work checks (compliance remediation phase 1).
// Pure logic is executed through the shared TypeScript loader; wiring is asserted against the source,
// the same pattern as company-compliance-safety.spec.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTs } = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const checks = loadTs('src/components/company/compliance-checks.ts');
const model = loadTs('src/components/company/compliance-model.ts');
const drawer = read('src/components/company/ComplianceGuardDrawerBody.tsx');
const section = read('src/components/company/CompanyCheckSection.tsx');
const workspace = read('src/components/company/CompanyComplianceWorkspace.tsx');
const dataSource = read('src/components/company/complianceDataSource.ts');
const api = read('src/services/api.ts');
const types = read('src/types/models.ts');

let count = 0;
function test(name, work) {
  work();
  count += 1;
  console.log(`PASS ${name}`);
}

const TODAY = '2026-10-12';
const uk = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const form = (kind, over = {}) => ({
  ...checks.initialCheckForm(kind, null, TODAY),
  checkedByName: 'Pat Checker',
  evidenceReference: 'HR file 12',
  ...(kind === 'sia' ? { licenceNumber: '1234 5678 9012 3456', expiryDate: uk('2027-12-31') } : { excuse: 'continuous' }),
  ...over,
});
const validate = (kind, over = {}, current = null) => checks.validateCheckForm(kind, 7, form(kind, over), current, TODAY);
const error = (kind, over, current = null) => {
  const result = validate(kind, over, current);
  assert.equal(result.ok, false, `expected an error for ${JSON.stringify(over)}`);
  return result.error;
};
const current = (over = {}) => ({
  id: 41, outcome: 'confirmed', method: 'manual_document', rightToWorkExcuse: 'time_limited', licenceNumber: null,
  checkDate: '2026-01-10', expiryDate: '2027-01-10', workRestrictions: null, checkedByName: 'Sam Old', recordedByUserId: 3,
  createdAt: '2026-01-10T10:00:00Z', ...over,
});
const summary = (over = {}) => ({
  guardId: 7, fullName: 'Guard 7', siaLicenceNumber: '1111222233334444', siaExpiryDate: '2030-01-01', rightToWorkStatus: 'british',
  rightToWorkExpiryDate: null, complianceStatus: 'invalid', assignable: false, blockingReasons: [], expiringReasons: [],
  missingDocuments: [], documents: [], ...over,
});

// ── form validation (mirrors the server) ─────────────────────────────────────
test('SIA check: a valid form produces the payload the server expects, licence number normalised', () => {
  const result = validate('sia');
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {
    guardId: 7, kind: 'sia', outcome: 'confirmed', method: 'sia_public_register', checkDate: TODAY, checkedByName: 'Pat Checker',
    evidenceReference: 'HR file 12', evidenceDocumentId: null, replacesCheckId: null, changeType: 'new_check', changeReason: null,
    licenceNumber: '1234567890123456', expiryDate: '2027-12-31', rightToWorkExcuse: null, workRestrictions: null,
  });
  assert.ok(!('companyId' in result.payload), 'the company is never sent');
});

test('SIA check: licence number, expiry, method and dates are validated', () => {
  assert.match(error('sia', { licenceNumber: '12345' }), /16-digit/);
  assert.match(error('sia', { expiryDate: '' }), /SIA licence expiry date/);
  assert.match(error('sia', { method: 'manual_document' }), /how the SIA licence was checked/);
  assert.match(error('sia', { checkDate: uk('2026-10-13') }), /cannot be in the future/);
  assert.match(error('sia', { checkDate: '30/02/2026' }), /DD\/MM\/YYYY/);
  assert.match(error('sia', { checkDate: uk('2026-10-01'), expiryDate: uk('2026-09-30') }), /not confirmed/);
  assert.equal(validate('sia', { outcome: 'not_confirmed', expiryDate: '' }).ok, true, 'a negative check needs no expiry');
});

test('Right to work: continuous has no expiry; time-limited needs one; follow-up is the server\'s expiry', () => {
  const continuous = validate('right_to_work');
  assert.equal(continuous.ok, true);
  assert.equal(continuous.payload.expiryDate, null);
  assert.equal(continuous.payload.rightToWorkExcuse, 'continuous');
  assert.match(error('right_to_work', { expiryDate: uk('2027-01-01') }), /continuous right to work has no expiry/);
  assert.match(error('right_to_work', { excuse: 'time_limited' }), /permission to work ends/);
  const limited = validate('right_to_work', { excuse: 'time_limited', expiryDate: uk('2027-03-31'), workRestrictions: '20 hours in term time' });
  assert.equal(limited.ok, true);
  assert.equal(limited.payload.expiryDate, '2027-03-31');
  assert.equal(limited.payload.workRestrictions, '20 hours in term time');
  assert.match(error('right_to_work', { excuse: '' }), /continuous or time-limited/);
});

test('Right to work: a PVN comes only from the ECS and lasts at most six months', () => {
  assert.deepEqual(checks.excusesForMethod('employer_checking_service').map((o) => o.value), ['time_limited_pvn']);
  assert.deepEqual(checks.excusesForMethod('home_office_online').map((o) => o.value), ['continuous', 'time_limited']);
  assert.match(error('right_to_work', { method: 'manual_document', excuse: 'time_limited_pvn', expiryDate: uk('2027-01-01') }), /continuous or time-limited/);
  assert.match(error('right_to_work', { method: 'employer_checking_service', excuse: 'time_limited_pvn', checkDate: uk('2026-10-01'), expiryDate: uk('2027-04-02') }), /six months/);
  assert.equal(validate('right_to_work', { method: 'employer_checking_service', excuse: 'time_limited_pvn', checkDate: uk('2026-10-01'), expiryDate: uk('2027-04-01') }).ok, true);
  assert.equal(checks.addMonthsIso('2026-08-31', 6), '2027-02-28');
});

test('Right to work: not confirmed carries no excuse or expiry', () => {
  const result = validate('right_to_work', { outcome: 'not_confirmed', expiryDate: uk('2027-01-01') });
  assert.equal(result.ok, true);
  assert.equal(result.payload.rightToWorkExcuse, null);
  assert.equal(result.payload.expiryDate, null);
});

test('Evidence: a reference or a linked document is required; linking alone is enough', () => {
  assert.match(error('sia', { evidenceReference: ' ' }), /evidence of this check is kept, or link/);
  const linked = validate('sia', { evidenceReference: '', evidenceDocumentId: 55 });
  assert.equal(linked.ok, true);
  assert.equal(linked.payload.evidenceDocumentId, 55);
  assert.equal(linked.payload.evidenceReference, null);
  assert.match(error('sia', { checkedByName: '' }), /who carried out the check/);
});

test('Updating names the current check; a correction needs a reason', () => {
  const update = validate('right_to_work', {}, current());
  assert.equal(update.payload.replacesCheckId, 41);
  assert.equal(update.payload.changeType, 'new_check');
  const correction = checks.correctionForm('right_to_work', current());
  assert.equal(correction.checkDate, '10/01/2026', 'a correction shows the record as it stands');
  assert.equal(correction.checkedByName, 'Sam Old');
  assert.match(checks.validateCheckForm('right_to_work', 7, { ...correction, evidenceReference: 'x' }, current(), TODAY).error, /reason for correcting/);
  const fixed = checks.validateCheckForm('right_to_work', 7, { ...correction, evidenceReference: 'x', changeReason: 'Wrong expiry' }, current(), TODAY);
  assert.equal(fixed.payload.changeType, 'correction');
  assert.equal(fixed.payload.changeReason, 'Wrong expiry');
});

test('A new form never copies the Guard\'s declarations and is dated today', () => {
  const fresh = checks.initialCheckForm('sia', null, TODAY);
  assert.equal(fresh.licenceNumber, '');
  assert.equal(fresh.expiryDate, '');
  assert.equal(fresh.checkDate, '12/10/2026');
  assert.equal(fresh.checkedByName, '', 'the checker is always entered, never assumed');
  const followUp = checks.initialCheckForm('right_to_work', current(), TODAY);
  assert.equal(followUp.checkDate, '12/10/2026', 'an update is a new check dated today, not a re-save of the old one');
  assert.equal(followUp.expiryDate, '', 'a follow-up check never carries the old expiry over');
  assert.equal(followUp.method, 'manual_document', 'but keeps the method');
  assert.equal(checks.correctionForm('right_to_work', current()).expiryDate, '10/01/2027', 'a correction shows the stored expiry');
  assert.doesNotMatch(section, /initialCheckForm\([^)]*summary/, 'the form is never initialised from the Guard summary');
  assert.doesNotMatch(section.split('function CompanyCheckSection')[1].split('const declared')[0], /siaExpiryDate|rightToWorkStatus|siaLicenceNumber/);
});

test('UK today is the London calendar date', () => {
  assert.equal(checks.ukTodayIso(new Date('2026-06-30T23:30:00Z')), '2026-07-01');
  assert.equal(checks.ukTodayIso(new Date('2026-12-31T23:30:00Z')), '2026-12-31');
});

// ── indicators and blockers with company checks ──────────────────────────────
const NOW = new Date(2026, 9, 12, 12, 0);
test('Table indicators follow the company check, not the declaration', () => {
  const none = summary({ companyChecks: { sia: null, rightToWork: null } });
  assert.equal(model.siaIndicator(none, NOW).label, 'Not checked', 'a valid declaration does not show as checked');
  assert.equal(model.rightToWorkIndicator(none, NOW).label, 'Not checked');
  const done = summary({ companyChecks: {
    sia: current({ method: 'sia_public_register', rightToWorkExcuse: null, licenceNumber: '1234567890123456', expiryDate: '2026-11-01' }),
    rightToWork: current({ rightToWorkExcuse: 'continuous', expiryDate: null }),
  } });
  assert.equal(model.siaIndicator(done, NOW).label, 'Expires in 20 days');
  assert.equal(model.rightToWorkIndicator(done, NOW).label, 'Continuous');
  const bad = summary({ companyChecks: { sia: current({ outcome: 'not_confirmed' }), rightToWork: current({ expiryDate: '2026-10-11' }) } });
  assert.equal(model.siaIndicator(bad, NOW).label, 'Not confirmed');
  assert.equal(model.rightToWorkIndicator(bad, NOW).label, 'Expired');
  // Older API responses (no companyChecks) keep the previous reading.
  assert.equal(model.rightToWorkIndicator(summary({ rightToWorkStatus: 'permanent' }), NOW).label, 'Indefinite');
});

test('Blockers point managers at Record check, and others at a compliance manager', () => {
  const s = summary({
    companyChecks: { sia: null, rightToWork: null },
    blockingReasons: ['SIA licence check not recorded', 'Right to work permission expired', 'Right to work check did not confirm permission to work'],
    expiringReasons: ['SIA licence expires within 30 days'],
  });
  const asManager = model.buildBlockers(s, true);
  assert.deepEqual(asManager.map((b) => b.action), [
    { kind: 'record_check', checkKind: 'sia' },
    { kind: 'record_check', checkKind: 'right_to_work' },
    { kind: 'record_check', checkKind: 'right_to_work' },
    { kind: 'record_check', checkKind: 'sia' },
  ]);
  assert.match(asManager[1].nextStep, /follow-up right to work check/);
  assert.match(asManager[2].nextStep, /Do not deploy/);
  assert.ok(asManager.every((b) => !/Ask the Guard/.test(b.nextStep)), 'the company does the check; the Guard is not asked to edit their profile');
  const asViewer = model.buildBlockers(s, false);
  assert.ok(asViewer.every((b) => b.action === null && /compliance manager/.test(b.nextStep)));
  // Without company checks on the summary, the earlier guidance is unchanged.
  const legacy = model.buildBlockers(summary({ blockingReasons: ['SIA licence expired'] }), true);
  assert.match(legacy[0].nextStep, /Ask the Guard to update their SIA details/);
});

test('Still-needed checklist shows only what is outstanding', () => {
  const requirements = [
    { key: 'sia_check', label: 'SIA licence check', state: 'met', detail: '' },
    { key: 'right_to_work_check', label: 'Right to work check', state: 'missing', detail: 'Record your right to work check.' },
    { key: 'sia_document', label: 'SIA licence document', state: 'unverified', detail: '' },
  ];
  assert.deepEqual(checks.outstandingRequirements(requirements).map((r) => r.key), ['right_to_work_check', 'sia_document']);
  assert.deepEqual(checks.requirementPresentation({ state: 'missing' }), { label: 'Needed', tone: 'danger' });
  assert.deepEqual(checks.requirementPresentation({ state: 'expiring' }), { label: 'Expiring soon', tone: 'warning' });
  assert.equal(checks.requirementPresentation({ state: 'something-new' }).label, 'Unknown');
});

// ── wiring ───────────────────────────────────────────────────────────────────
test('API: list and record company checks; the company is never in the payload', () => {
  assert.match(api, /export function listComplianceChecks\(guardId: number\)[\s\S]*?`\/compliance\/checks\?guardId=/);
  assert.match(api, /export function recordComplianceCheck\(payload: RecordComplianceCheckPayload\)[\s\S]*?'\/compliance\/checks', \{\s*method: 'POST'/);
  const payloadType = types.split('export interface RecordComplianceCheckPayload')[1].split('}')[0];
  assert.doesNotMatch(payloadType, /companyId/);
  assert.match(dataSource, /listChecks: \(guardId\) => listComplianceChecks\(guardId\)/);
  assert.match(dataSource, /recordCheck: \(payload\) => recordComplianceCheck\(payload\)/);
});

test('Workspace: saving a check reloads so compliance is recalculated; the Guard id is pinned', () => {
  const save = workspace.split('const recordCheck = React.useCallback')[1].split('const verificationDialog')[0];
  assert.match(save, /payload\.guardId !== guardId/);
  assert.match(save, /await ds\.recordCheck\(payload\)/);
  assert.match(save, /await load\('refresh'\)/);
  assert.match(workspace, /onRecordCheck=\{\(payload\) => recordCheck\(activeRow\.guardId, payload\)\}/);
  assert.match(workspace, /onLoadCheckHistory=\{\(\) => ds\.listChecks\(activeRow\.guardId\)\}/);
});

test('Drawer: check sections, a still-needed list, and no manual override', () => {
  assert.match(drawer, /summary && companyView \?/);
  assert.match(drawer, /<CompanyCheckSection/);
  assert.match(drawer, /Still needed/);
  assert.match(drawer, /S4 screening is optional and is not needed for the rota/);
  assert.match(drawer, /action\.kind === 'record_check'\) setCheckForm\(\{ kind: action\.checkKind, mode: 'new' \}\)/);
  for (const source of [drawer, section, workspace]) {
    assert.doesNotMatch(source, /[Mm]ark (as )?compliant|markCompliant|override/);
  }
  // Only managers get Record / Update / Correct; everyone with view access gets the history.
  assert.match(section, /\{canManage && !formMode \? \(/);
  assert.match(section, /\{canManage && formMode \? \(/);
  assert.match(section, /Correct this record/);
  assert.match(section, /The original stays in the history/);
  assert.match(section, /Linking does not verify the document/);
  assert.match(section, /Do not enter share codes, passport or visa numbers/);
  assert.match(section, /does not count as your check/);
});

test('Drawer: layouts wrap at narrow widths (chips, actions, requirement rows)', () => {
  for (const style of ['chips:', 'actions:', 'historyHead:']) {
    const line = section.split('\n').find((l) => l.trim().startsWith(style));
    assert.ok(line && /flexWrap: 'wrap'/.test(line), `${style} wraps`);
  }
  assert.match(drawer, /requirementText: \{ flex: 1, minWidth: 0/);
  assert.match(section, /historyText: \{ flex: 1, minWidth: 160/);
});

// ── Phase 1B: work restrictions ──────────────────────────────────────────────
const eligibility = loadTs('src/components/company/assignEligibility.ts');
const rota = read('src/components/company/CompanyRotaPlannerWorkspace.tsx');

test('Work restrictions: one notice, only for a confirmed check that records one, never read as approval', () => {
  const restricted = { companyChecks: { rightToWork: current({ workRestrictions: '  Student: 20 hours a week in term time ' }) } };
  const notice = checks.workRestrictionNotice(restricted);
  assert.match(notice, /^Right to work restriction recorded: "Student: 20 hours a week in term time"\./);
  assert.match(notice, /S4 does not check shifts against it/);
  assert.doesNotMatch(notice, /approved|verified|allowed to work/i, 'no wording that reads as approval');
  assert.equal(checks.workRestrictionNotice({ companyChecks: { rightToWork: current({ workRestrictions: null }) } }), null);
  assert.equal(checks.workRestrictionNotice({ companyChecks: { rightToWork: current({ outcome: 'not_confirmed', workRestrictions: 'x' }) } }), null);
  assert.equal(checks.workRestrictionNotice({ companyChecks: null }), null, 'older API: nothing to show');
  assert.equal(checks.workRestrictionNotice(null), null);
});

test('Work restrictions: shown in the drawer, the still-needed list, the table and the rota assign panel', () => {
  assert.match(section, /workRestrictionNotice\(summary\)/);
  assert.match(section, /accessibilityRole="alert"/);
  assert.match(section, /Recording it does not approve any shift: S4 does not check rotas against it\./);
  assert.match(drawer, /label="Check each shift" tone="warning"/);
  const restricted = summary({ companyChecks: { sia: null, rightToWork: current({ rightToWorkExcuse: 'continuous', expiryDate: null, workRestrictions: 'x' }) } });
  const indicator = model.rightToWorkIndicator(restricted, NOW);
  assert.equal(indicator.label, 'Continuous', 'the label and tone do not change');
  assert.equal(indicator.tone, 'success');
  assert.match(indicator.detail, /restrictions recorded$/);
  // Rota: the warning reaches the candidate, and never changes eligibility.
  const row = { guardId: 7, fullName: 'G', isEligible: true, availabilityStatus: 'available', reasons: [] };
  const assessed = eligibility.assessCandidate(row, { workRestrictionNotice: 'notice text' });
  assert.equal(assessed.isEligible, true);
  assert.equal(assessed.workRestrictionNotice, 'notice text');
  assert.equal(eligibility.assessCandidate({ ...row, isEligible: false, reasons: ['x'] }, { workRestrictionNotice: 'n' }).isEligible, false);
  assert.equal(eligibility.assessCandidate(row, {}).workRestrictionNotice, null);
  assert.match(rota, /workRestrictionNotice: workRestrictionNotice\(summary\)/);
  assert.match(rota, /assessment\.workRestrictionNotice \?/);
});

test('A follow-up check never carries an old restriction over; a correction shows it', () => {
  const withRestriction = current({ workRestrictions: '20 hours' });
  assert.equal(checks.initialCheckForm('right_to_work', withRestriction, TODAY).workRestrictions, '');
  assert.equal(checks.correctionForm('right_to_work', withRestriction).workRestrictions, '20 hours');
});

// ── Phase 1B: new web against the previous backend (web may deploy before Render) ──
test('Previous backend (no companyChecks/requirements/warnings): the drawer falls back to the earlier read-only view', () => {
  const legacy = summary({ siaExpiryDate: '2030-01-01', rightToWorkStatus: 'permanent', blockingReasons: ['SIA licence document is not verified'] });
  assert.equal(model.siaIndicator(legacy, NOW).tone, 'neutral', 'declaration-based reading, as before');
  assert.equal(model.rightToWorkIndicator(legacy, NOW).label, 'Indefinite');
  assert.deepEqual(checks.outstandingRequirements(legacy.requirements), []);
  assert.equal(checks.workRestrictionNotice(legacy), null);
  assert.ok(model.buildBlockers(legacy, true).every((b) => b.action === null || b.action.kind !== 'record_check'), 'no Record check action against an API that lacks it');
  // The drawer only renders check sections (and their Record buttons) when the API supplied companyChecks.
  assert.match(drawer, /const companyView = Boolean\(summary\?\.companyChecks\);/);
  assert.match(drawer, /\{summary && companyView \? \(\s*<Section title="Still needed">/);
});

test('Guard app: a refused Book On (403) shows the server message verbatim, as shipped builds do', () => {
  const formatter = api.split('export function formatApiErrorMessage')[1].split('\n}\n')[0];
  const forbidden = formatter.split('if (error.status === 403) {')[1].split("return 'You are not allowed to perform this action.';")[0];
  assert.match(forbidden, /typeof body\.message === 'string' && body\.message\.trim\(\)\) \{\s*return body\.message;/);
  const dashboard = read('src/screens/GuardDashboardScreen.tsx');
  assert.match(dashboard, /formatApiErrorMessage\(error, 'Unable to start this shift\.'\)/);
});

console.log(`company-compliance-checks: ${count} passed`);
