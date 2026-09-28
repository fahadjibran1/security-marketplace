/**
 * UAT-DEPLOY-01: guiding the company through a guard's compliance blockers.
 *
 * Real production UAT hit a dead end. The Rota Planner candidate said "Ineligible", listed a genuine
 * blocker and a harmless note in one undifferentiated red string, left Assign clickable, and the backend
 * then returned a raw 403. Nothing pointed at the Compliance workspace that can actually fix it.
 *
 * These checks EXECUTE the real presentation model rather than grepping for strings, because the thing
 * that went wrong was a classification decision, not a missing label. The compliance blockers are
 * composed through the EXISTING compliance-model.ts remediation mapping, exactly as the drawer does, so
 * a change to that mapping shows up here.
 *
 * What is deliberately NOT tested here: whether the underlying rule is right. `isEligible` and every
 * reason come from the server, and the rule itself is certified backend-side in
 * scripts/availability-semantics.spec.ts (availability semantics + the empty-file -> deployable journey).
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadModule(rel) {
  const js = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = new Module(rel, null);
  m.filename = path.join(ROOT, rel);
  m.paths = Module._nodeModulePaths(path.dirname(m.filename));
  m._compile(js, m.filename);
  return m.exports;
}

const model = loadModule('src/components/company/assignEligibility.ts');
const compliance = loadModule('src/components/company/compliance-model.ts');

const planner = read('src/components/company/CompanyRotaPlannerWorkspace.tsx');
const dashboard = read('src/screens/CompanyDashboardScreen.tsx');
const complianceWorkspace = read('src/components/company/CompanyComplianceWorkspace.tsx');

// ── the server's own shapes ───────────────────────────────────────────────────

/** An eligibility row exactly as AvailabilityService.evaluateGuardForShift returns it. */
const row = (over = {}) => ({
  guardId: 11,
  fullName: 'Candidate One',
  relationshipStatus: 'ACTIVE',
  isEligible: true,
  availabilityStatus: 'no_rule',
  hasShiftClash: false,
  hasApprovedLeave: false,
  complianceValid: true,
  reasons: ['No availability rule found for this time.'],
  ...over,
});

/** The compliance reason as it reaches eligibility: assertGuardCanTakeShift re-wraps assertGuardAssignable. */
const NESTED = (detail) => `Compliance invalid: Guard compliance invalid: ${detail}`;

/** A GuardComplianceSummary as GET /compliance/statuses returns it. */
const summary = (blockingReasons, missingDocuments = []) => ({
  guardId: 11,
  fullName: 'Candidate One',
  complianceStatus: 'invalid',
  assignable: false,
  blockingReasons,
  expiringReasons: [],
  missingDocuments,
  documents: [],
});

/** Composed the same way the drawer composes it, through the existing remediation mapping. */
const viaComplianceModel = (blockingReasons, canManage = true) =>
  compliance
    .buildBlockers(summary(blockingReasons), canManage)
    .filter((blocker) => blocker.severity === 'blocking')
    .map((blocker) => ({ text: blocker.text, nextStep: blocker.nextStep }));

const assessWith = (rowOver, blockingReasons, opts = {}) =>
  model.assessCandidate(row(rowOver), {
    complianceBlockers: blockingReasons ? viaComplianceModel(blockingReasons, opts.canManage !== false) : null,
    canFixCompliance: opts.canFixCompliance !== false,
  });

// ═══════════════════ 1-3 compliance blockers are shown, in full ═══════════════════

test('DEPLOY-01-MISSING-SIA-DOCUMENT-MAKES-THE-CANDIDATE-INELIGIBLE', () => {
  const assessment = assessWith(
    { isEligible: false, complianceValid: false, reasons: [NESTED('Missing SIA licence document'), 'No availability rule found for this time.'] },
    ['Missing SIA licence document'],
  );
  assert.equal(assessment.isEligible, false);
  assert.equal(assessment.complianceBlocked, true);
  assert.equal(assessment.blockers.length, 1, 'exactly the one blocker the server reported');
  assert.match(assessment.blockers[0].text, /Missing SIA licence document/);
  // The nested server prefixes never reach the manager.
  assert.doesNotMatch(assessment.blockers[0].text, /compliance invalid/i);
  // And the next step comes from the existing mapping, not a new one invented here.
  assert.equal(assessment.blockers[0].nextStep, 'Add the SIA licence document.');
});

test('DEPLOY-02-MISSING-RTW-DOCUMENT-MAKES-THE-CANDIDATE-INELIGIBLE', () => {
  const assessment = assessWith(
    { isEligible: false, complianceValid: false, reasons: [NESTED('Missing Right-to-work document')] },
    ['Missing Right-to-work document'],
  );
  assert.equal(assessment.isEligible, false);
  assert.equal(assessment.blockers.length, 1);
  assert.match(assessment.blockers[0].text, /Missing Right-to-work document/);
  // §5: the equivalent RTW remediation exists and is the same add_document action.
  assert.equal(assessment.blockers[0].nextStep, 'Add the right-to-work document.');
  const actions = compliance.buildBlockers(summary(['Missing Right-to-work document']), true).map((b) => b.action);
  assert.deepEqual(actions, [{ kind: 'add_document', documentType: 'right_to_work' }]);
});

test('DEPLOY-03-BOTH-DOCUMENT-BLOCKERS-ARE-DISPLAYED-TOGETHER', () => {
  // The real UAT state. The eligibility projection carries only blockers[0], so the drawer reads the
  // authoritative Company Compliance projection for detail — this is what that buys.
  const assessment = assessWith(
    { isEligible: false, complianceValid: false, reasons: [NESTED('Missing SIA licence document')] },
    ['Missing SIA licence document', 'Missing Right-to-work document'],
  );
  assert.equal(assessment.blockers.length, 2, 'both, not just the one eligibility happened to name');
  assert.deepEqual(
    assessment.blockers.map((blocker) => blocker.text).sort(),
    ['Missing Right-to-work document', 'Missing SIA licence document'],
  );
});

test('DEPLOY-04-WITHOUT-THE-SUMMARY-IT-DEGRADES-TO-THE-SERVER-REASON', () => {
  // /compliance/statuses may not have loaded (or the user cannot see it). The drawer must still be
  // useful and must still show the blocker, just not the complete list.
  const assessment = model.assessCandidate(
    row({ isEligible: false, complianceValid: false, reasons: [NESTED('Missing SIA licence document'), 'No availability rule found for this time.'] }),
    { complianceBlockers: null, canFixCompliance: true },
  );
  assert.equal(assessment.blockers.length, 1);
  assert.equal(assessment.blockers[0].text, 'Missing SIA licence document', 'prefixes stripped');
  assert.equal(assessment.blockers[0].nextStep, null, 'and no next step is invented for it');
});

// ═══════════════════ 4-5 no_rule is neutral and never blocking ═══════════════════

test('DEPLOY-05-NO-RULE-RENDERS-AS-A-NEUTRAL-AVAILABILITY-NOT-SET', () => {
  const assessment = model.assessCandidate(row(), { canFixCompliance: true });
  assert.deepEqual(assessment.availability, { label: 'Not set', tone: 'neutral' });
});

test('DEPLOY-06-NO-RULE-ALONE-DOES-NOT-MAKE-A-CANDIDATE-INELIGIBLE', () => {
  const assessment = model.assessCandidate(row(), { canFixCompliance: true });
  assert.equal(assessment.isEligible, true, 'the server says eligible, so the UI must agree');
  assert.deepEqual(assessment.blockers, [], 'and the informational line is NOT a blocker');
  assert.equal(assessment.action, 'none', 'nothing to fix');
});

test('DEPLOY-07-NO-RULE-IS-NEVER-LISTED-AS-A-BLOCKER-EVEN-ALONGSIDE-A-REAL-ONE', () => {
  const assessment = assessWith(
    { isEligible: false, complianceValid: false, reasons: [NESTED('Missing SIA licence document'), 'No availability rule found for this time.'] },
    ['Missing SIA licence document'],
  );
  assert.ok(
    assessment.blockers.every((blocker) => !/availability rule/i.test(blocker.text)),
    `the informational line must not appear in the blocker list, got ${JSON.stringify(assessment.blockers)}`,
  );
  assert.deepEqual(assessment.availability, { label: 'Not set', tone: 'neutral' });
});

test('DEPLOY-08-UNAVAILABLE-IS-DIFFERENT-FROM-NOT-SET-AND-IS-BLOCKING', () => {
  const assessment = model.assessCandidate(
    row({
      isEligible: false, availabilityStatus: 'unavailable',
      reasons: ['Guard is marked unavailable for this time.'],
    }),
    { canFixCompliance: true },
  );
  assert.deepEqual(assessment.availability, { label: 'Unavailable', tone: 'warning' });
  assert.equal(assessment.blockers.length, 1, 'an explicit unavailability IS a blocker');
  assert.match(assessment.blockers[0].text, /marked unavailable/i);
});

test('DEPLOY-09-NO-RAW-ENUM-EVER-REACHES-THE-SCREEN', () => {
  // The previous UI rendered `{g.availabilityStatus}` directly, so a manager saw the literal "no_rule".
  for (const status of ['no_rule', 'unavailable', 'available', '', null, undefined, 'something_new']) {
    const presented = model.availabilityPresentation(status);
    assert.doesNotMatch(presented.label, /_/, `"${status}" must not render with an underscore, got "${presented.label}"`);
    assert.ok(presented.label.trim(), 'and never renders empty');
  }
  assert.equal(model.availabilityPresentation('no_rule').label, 'Not set');
  // The board must not print the raw field either.
  assert.doesNotMatch(planner, /\{g\.availabilityStatus\}/, 'the raw status is no longer rendered');
});

// ═══════════════════ 6-7 the Assign button ═══════════════════

test('DEPLOY-10-ASSIGN-IS-DISABLED-WHEN-THE-SERVER-SAYS-INELIGIBLE', () => {
  const disabled = /disabled=\{!selectedGuardId \|\| assigning \|\| \(!!selectedAssessment && !selectedAssessment\.isEligible\)\}/;
  assert.match(planner, disabled, 'Assign is gated on the server verdict for the SELECTED candidate');
  // The verdict comes from the assessment of the selected row, not from a locally recomputed rule.
  assert.match(
    planner,
    /const selectedAssessment = React\.useMemo\(\(\) => \{[\s\S]{0,400}?assessCandidateRow\(row\)/,
    'and that verdict is the assessed server row',
  );
});

test('DEPLOY-11-ASSIGN-STAYS-ENABLED-FOR-AN-ELIGIBLE-CANDIDATE', () => {
  // isEligible=true with an informational availability note must NOT disable the button: that would
  // reintroduce the dead end from the other direction, since production has no availability rules.
  const assessment = model.assessCandidate(row(), { canFixCompliance: true });
  assert.equal(assessment.isEligible, true);
  const wouldDisable = Boolean(assessment) && !assessment.isEligible;
  assert.equal(wouldDisable, false, 'an eligible guard with no availability rule is assignable');
});

// ═══════════════════ 8-10, 13 Fix Compliance ═══════════════════

test('DEPLOY-12-FIX-COMPLIANCE-IS-OFFERED-FOR-A-COMPLIANCE-BLOCKER', () => {
  const assessment = assessWith(
    { isEligible: false, complianceValid: false, reasons: [NESTED('Missing SIA licence document')] },
    ['Missing SIA licence document'],
  );
  assert.equal(assessment.action, 'fix_compliance');
  assert.ok(planner.includes('Fix Compliance'), 'and the control exists');
  assert.ok(planner.includes('accessibilityLabel="Fix Compliance"'), 'reachable by assistive technology');
  assert.match(planner, /assessment\.action === 'fix_compliance' && onFixCompliance/, 'rendered only when offered');
});

test('DEPLOY-13-A-NON-COMPLIANCE-BLOCKER-DOES-NOT-OFFER-FIX-COMPLIANCE', () => {
  // A clash or approved leave is not fixed in the Compliance workspace, so pointing there would be a lie.
  const clash = model.assessCandidate(
    row({ isEligible: false, hasShiftClash: true, reasons: ['Guard already has an overlapping shift.'] }),
    { canFixCompliance: true },
  );
  assert.equal(clash.action, 'none');
  assert.equal(clash.complianceBlocked, false);
  assert.equal(clash.blockers.length, 1);
  assert.match(clash.blockers[0].text, /overlapping shift/);

  const leave = model.assessCandidate(
    row({ isEligible: false, hasApprovedLeave: true, reasons: ['Approved leave overlaps this shift.'] }),
    { canFixCompliance: true },
  );
  assert.equal(leave.action, 'none');

  const unavailable = model.assessCandidate(
    row({ isEligible: false, availabilityStatus: 'unavailable', reasons: ['Guard is marked unavailable for this time.'] }),
    { canFixCompliance: true },
  );
  assert.equal(unavailable.action, 'none');
});

test('DEPLOY-14-FIX-COMPLIANCE-IS-WITHHELD-WITHOUT-COMPLIANCE-VIEW', () => {
  const assessment = assessWith(
    { isEligible: false, complianceValid: false, reasons: [NESTED('Missing SIA licence document')] },
    ['Missing SIA licence document'],
    { canFixCompliance: false },
  );
  assert.equal(assessment.action, 'none', 'no route is offered to someone who cannot open Compliance');
  assert.equal(assessment.blockers.length, 1, 'but the blocker is still explained');
  assert.ok(dashboard.includes('canFixCompliance={guardNavPermissions.canViewCompliance}'), 'gated on compliance.view');
});

test('DEPLOY-15-WITHOUT-COMPLIANCE-MANAGE-THE-STEP-ASKS-A-MANAGER', () => {
  const assessment = assessWith(
    { isEligible: false, complianceValid: false, reasons: [NESTED('Missing SIA licence document')] },
    ['Missing SIA licence document'],
    { canManage: false },
  );
  assert.match(assessment.blockers[0].nextStep, /compliance manager needs to add/i);
  assert.ok(dashboard.includes('canManageCompliance={compliancePermissions.canManage}'));
});

test('DEPLOY-16-FIX-COMPLIANCE-NAVIGATES-TO-THE-EXISTING-COMPLIANCE-WORKFLOW', () => {
  const handler = /handleFixGuardCompliance = React\.useCallback\(\(guardId: number\) => \{([\s\S]*?)\}, \[openGuardWorkspace\]\)/.exec(dashboard);
  assert.ok(handler, 'the dashboard has the handler');
  assert.match(handler[1], /openGuardWorkspace\('compliance', guardId\)/, 'it reuses the existing guard-target navigation');
  assert.ok(dashboard.includes('onFixCompliance={handleFixGuardCompliance}'), 'wired to the planner');
  // openGuardWorkspace switches section and issues the one-shot target.
  assert.match(
    dashboard,
    /const openGuardWorkspace = React\.useCallback\(\(section: GuardNavSection, guardId: number\) => \{[\s\S]*?setGuardTarget\(openGuardTarget\(section, guardId, guardTargetSeq\.current\)\);\s*setActiveSection\(section\);/,
    'which both targets the guard and switches to Compliance',
  );
});

test('DEPLOY-17-THE-TARGET-OPENS-THAT-GUARDS-DRAWER-AND-NOTHING-IS-DUPLICATED', () => {
  assert.match(complianceWorkspace, /setSelectedGuardId\(plan\.selectedGuardId\)/, 'the destination opens the guard drawer');
  assert.match(complianceWorkspace, /planGuardTarget\(rows, target\.guardId\)/, 'strictly the targeted guard');
  // §4: no second upload drawer, verification flow or compliance model in the planner.
  for (const forbidden of ['ComplianceGuardDrawerBody', 'uploadGuardDocument', 'verifyGuardDocument', 'liveComplianceDataSource']) {
    assert.ok(!planner.includes(forbidden), `the planner must not reimplement compliance (${forbidden})`);
  }
});

// ═══════════════════ 11-12 the one-shot intent, executed ═══════════════════

test('DEPLOY-18-THE-INTENT-FIRES-ONCE-AND-DOES-NOT-REOPEN', () => {
  // Executed, not asserted from source: the Add Shift counter's first version treated its initial 0 as a
  // request and reopened the drawer on every mount. This mechanism cannot have that bug because its
  // initial value is null, but that must be proven rather than assumed.
  const nav = loadModule('src/components/company/guard-navigation.ts');

  let target = null;              // initial state: NOT a request
  let seq = 0;
  const open = (guardId) => { seq += 1; target = nav.openGuardTarget('compliance', guardId, seq); };

  assert.equal(nav.targetForSection(target, 'compliance'), null, 'nothing is requested before any click');

  open(11);
  const handled = new Set();
  const applyOnce = () => {
    const mine = nav.targetForSection(target, 'compliance');
    if (!mine || handled.has(mine.requestId)) return null;
    handled.add(mine.requestId);
    target = nav.consumeGuardTarget(target, mine.requestId);
    return mine.guardId;
  };

  assert.equal(applyOnce(), 11, 'the click opens guard 11');
  assert.equal(applyOnce(), null, 're-render must not reopen it');
  assert.equal(applyOnce(), null, 'nor a third render');
  assert.equal(target, null, 'the request is consumed');

  // Closing the drawer is local state; with no target there is nothing to reopen.
  assert.equal(nav.targetForSection(target, 'compliance'), null, 'closing does not resurrect the request');

  // A NEW click works, and a late consume of the old request cannot clear it.
  open(22);
  const stale = nav.consumeGuardTarget(target, 1);
  assert.ok(stale && stale.guardId === 22, 'a late consume of an older request is ignored');
  assert.equal(applyOnce(), 22, 'and the new request opens the new guard');
});

test('DEPLOY-19-LEAVING-THE-SECTION-DROPS-THE-TARGET', () => {
  const nav = loadModule('src/components/company/guard-navigation.ts');
  const target = nav.openGuardTarget('compliance', 11, 1);
  assert.equal(nav.reconcileGuardTarget(target, 'rota-planner'), null, 'a target never survives its section');
  assert.deepEqual(nav.reconcileGuardTarget(target, 'compliance'), target);
  assert.match(dashboard, /setGuardTarget\(\(current\) => reconcileGuardTarget\(current, activeSection\)\)/);
});

// ═══════════════════ 14-15 the 403 never reaches the manager raw ═══════════════════

test('DEPLOY-20-A-RACE-403-IS-A-SENTENCE-NOT-JSON', () => {
  // The shape UAT actually saw in the browser.
  const raw = model.assignFailureMessage(new Error('403 - {"message":"Compliance invalid: Guard compliance invalid: Missing SIA licence document","statusCode":403}'));
  assert.doesNotMatch(raw, /[{}]/, `no JSON may reach the manager, got ${raw}`);
  assert.doesNotMatch(raw, /statusCode|^\s*403/, 'no status codes either');
  assert.match(raw, /Missing SIA licence document/, 'but the actual cause survives');
  assert.match(raw, /Add and verify/, 'and it says what to do');

  // An ApiError-shaped rejection.
  const structured = model.assignFailureMessage({ status: 403, body: { message: 'Compliance invalid: Guard compliance invalid: Missing Right-to-work document' } });
  assert.doesNotMatch(structured, /[{}]/);
  assert.match(structured, /Missing Right-to-work document/);

  // A plain nested message.
  const plain = model.assignFailureMessage(new Error('Compliance invalid: Guard compliance invalid: SIA licence document is not verified'));
  assert.doesNotMatch(plain, /compliance invalid/i, 'the nested prefixes are stripped');
  assert.match(plain, /not verified/);
});

test('DEPLOY-21-OTHER-FAILURES-KEEP-THEIR-OWN-WORDING-AND-NEVER-GO-BLANK', () => {
  assert.match(
    model.assignFailureMessage(new Error('This position has already been filled or is no longer available')),
    /already been filled/,
  );
  // Unusable input must still produce a sentence, never an empty banner or "[object Object]".
  for (const input of [null, undefined, {}, new Error(''), '   ', { body: '{"message":"x"}' }]) {
    const message = model.assignFailureMessage(input);
    assert.ok(message.trim().length > 10, `a usable sentence is required, got "${message}"`);
    assert.doesNotMatch(message, /\[object|undefined|[{}]/);
  }
});

test('DEPLOY-22-A-FAILED-ASSIGN-REREADS-THE-SERVER-VERDICT', () => {
  // If eligibility changed underneath us, the panel must stop offering what was just refused.
  const handler = /const handleAssign = React\.useCallback\(async \(\) => \{([\s\S]*?)\}, \[slotDetail/.exec(planner);
  assert.ok(handler, 'the assign handler exists');
  assert.match(handler[1], /setAssignError\(assignFailureMessage\(err\)\)/, 'the banner is formatted');
  assert.match(handler[1], /onGetEligibleGuards\(assignShiftId\)/, 'and eligibility is re-read after a failure');
});

// ═══════════════════ the rule itself is still the server's ═══════════════════

test('DEPLOY-23-THE-FRONTEND-ADDS-NO-COMPLIANCE-RULE-OF-ITS-OWN', () => {
  const source = read('src/components/company/assignEligibility.ts');
  // It must never decide compliance: no document requirements, no expiry arithmetic, no screening.
  for (const forbidden of [/screening/i, /siaExpiry/, /rightToWorkStatus/, /Date\.now\(\)/, /REQUIRED_DOCUMENT/i, /\bDate\(/]) {
    assert.doesNotMatch(source, forbidden, `the model must not reimplement compliance (${forbidden})`);
  }
  // isEligible is taken, never computed.
  assert.match(source, /isEligible: row\.isEligible === true/, 'eligibility is the server\'s answer verbatim');
  // The split is flag-driven.
  assert.match(source, /row\.availabilityStatus === 'no_rule'/, 'informational is identified by the server flag');
  assert.match(source, /row\.complianceValid === false/, 'compliance is identified by the server flag');
});

test('DEPLOY-24-THE-BULK-PANEL-CANNOT-CLICK-INTO-THE-SAME-403', () => {
  assert.match(planner, /const blocked = usedElsewhere \|\| g\.isEligible === false;/, 'bulk honours the same verdict');
  assert.match(planner, /disabled=\{blocked\}/, 'and refuses selection');
});

test('DEPLOY-25-COMPLIANCE-DETAIL-IS-FETCHED-ONCE-AND-NEVER-POLLED', () => {
  // W3 pinned the dashboard to a single refresh loop; the blocker detail must not add another.
  assert.match(planner, /onGetComplianceSummaries\?\: \(\) => Promise<GuardComplianceSummary\[\]>/, 'an explicit injected loader');
  assert.ok(!/setInterval/.test(planner), 'the planner starts no timer of its own');
  const opener = /const openAssign = React\.useCallback\(async \(shiftId: number\) => \{([\s\S]*?)\}, \[onGetEligibleGuards, onGetComplianceSummaries\]\)/.exec(planner);
  assert.ok(opener, 'the summaries load from openAssign');
  assert.match(opener[1], /onGetComplianceSummaries\(\)/, 'exactly there');
  // And it must not block the candidate list: eligibility is awaited and set first.
  assert.ok(
    opener[1].indexOf('setEligibleGuards(guards)') < opener[1].indexOf('onGetComplianceSummaries()'),
    'eligibility is shown before the detail request is made',
  );
});

console.log(`\n${passed} assign compliance guidance checks passed`);
