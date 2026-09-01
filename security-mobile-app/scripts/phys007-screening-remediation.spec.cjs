// PHYS-007 regression spec — "Fix this" remediation navigation scroll fix
// Static analysis tests: reads source files, no Jest required.
const assert = require('assert'), fs = require('fs'), path = require('path');
let passed = 0;
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const panel = read('src/components/guard/GuardScreeningPanel.tsx');
const guard = read('src/screens/GuardDashboardScreen.tsx');
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

// ── Entry points ──────────────────────────────────────────────────────────────

test('Fix-this in actionSummary invokes navigateToRemediation', () =>
  assert.match(panel, /navigateToRemediation\(item\.step as Step\)/));

test('Fix-this in Review component invokes onFix which forwards to navigateToRemediation', () => {
  assert.match(panel, /onFix=\{.*navigateToRemediation.*\}/);
  assert.match(panel, /onPress=\{\(\)=>onFix\(item\.step\)\}/);
});

// ── navigateToRemediation behaviour ──────────────────────────────────────────

test('navigateToRemediation calls navigateToStep to update the active step', () =>
  assert.match(panel, /navigateToRemediation[\s\S]{0,300}navigateToStep\(next\)/));

test('navigateToRemediation addresses special behaviour opens address form', () =>
  assert.match(panel, /next==="addresses"[\s\S]{0,100}setShowAddressForm\(true\)/));

test('navigateToRemediation history special behaviour opens history form', () =>
  assert.match(panel, /next==="history"[\s\S]{0,100}setShowHistoryForm\(true\)/));

test('navigateToRemediation requests scroll via measureLayout on the stage ref', () =>
  assert.match(panel, /stageRef\.current[\s\S]{0,300}measureLayout/));

test('measureLayout scroll result calls scrollTo with animated flag', () =>
  assert.match(panel, /measureLayout[\s\S]{0,300}scrollTo\(\{ y, animated: true \}\)/));

test('scroll is deferred via setTimeout to let layout settle before measuring', () =>
  assert.match(panel, /setTimeout\([\s\S]{0,200}measureLayout/));

test('scrollViewRef is guarded before use so missing ref is safe', () =>
  assert.match(panel, /scrollViewRef\?\.current && stageRef\.current/));

// ── Prop plumbing ────────────────────────────────────────────────────────────

test('GuardScreeningJourney accepts scrollViewRef prop with scrollTo structural type', () =>
  assert.match(panel, /scrollViewRef\?.*scrollTo.*y:.*number.*animated:.*boolean/));

test('stageRef is created as any-typed ref inside GuardScreeningJourney', () =>
  assert.match(panel, /stageRef\s*=\s*React\.useRef<any>\(null\)/));

test('stageRef is attached to the stage View element', () =>
  assert.match(panel, /ref=\{stageRef\}[\s\S]{0,60}style=\{s\.stage\}|style=\{s\.stage\}[\s\S]{0,60}ref=\{stageRef\}/));

test('GuardDashboardScreen creates screeningScrollRef as an any-typed useRef', () =>
  assert.match(guard, /screeningScrollRef\s*=\s*useRef<any>\(null\)/));

test('GuardDashboardScreen attaches screeningScrollRef to the outer ScrollView', () =>
  assert.match(guard, /ref=\{screeningScrollRef\}/));

test('GuardDashboardScreen passes scrollViewRef prop to GuardScreeningJourney', () =>
  assert.match(guard, /scrollViewRef=\{screeningScrollRef\}/));

test('useRef is imported from react in GuardDashboardScreen', () =>
  assert.match(guard, /import [^'"]*useRef[^'"]*from 'react'/));

// ── No API contamination ──────────────────────────────────────────────────────

test('navigateToRemediation does not call any API function', () => {
  // Extract the navigateToRemediation body
  const body = panel.split('const navigateToRemediation')[1].split('};')[0];
  assert.doesNotMatch(body, /await |fetch\(|axios\.|getMyScreening|updateMy|addMy|startMy/);
});

test('navigateToStep does not call any API function', () => {
  const body = panel.split('const navigateToStep')[1].split('};')[0];
  assert.doesNotMatch(body, /await |fetch\(|getMyScreening|updateMy|addMy/);
});

// ── Manual navigation still works separately ─────────────────────────────────

test('manual step-tab onPress uses navigateToStep not navigateToRemediation', () =>
  assert.match(panel, /onPress=\{\(\)\s*=>\s*navigateToStep\(x\.key\)\}/));

test('Previous and Next stageNav buttons use navigateToStep', () =>
  assert.match(panel, /navigateToStep\(STEPS\[activeIndex - 1\]\.key\)/));

// ── All valid remediation step keys are reachable ────────────────────────────

test('all valid step keys are present in the STEPS array', () => {
  for (const key of ['personal', 'identity', 'addresses', 'history', 'references', 'checks', 'evidence', 'consent', 'review']) {
    assert.match(panel, new RegExp(`key:\\s*["']${key}["']`));
  }
});

test('navigateToRemediation accepts any Step type — no hardcoded key restrictions', () =>
  assert.match(panel, /navigateToRemediation\s*=\s*\(next:\s*Step\)/));

// ── Existing state/form integrity ────────────────────────────────────────────

test('form state setters are not reset on navigateToStep (only on navigateToRemediation for addresses/history)', () => {
  const navStepBody = panel.split('const navigateToStep')[1].split('};')[0];
  assert.doesNotMatch(navStepBody, /setAddress|setHistory|setShowAddressForm|setShowHistoryForm/);
});

test('addresses form reset happens inside navigateToRemediation not navigateToStep', () =>
  assert.match(panel, /navigateToRemediation[\s\S]{0,200}setShowAddressForm\(true\)/));

// ── No backend behaviour change ───────────────────────────────────────────────

test('no screening eligibility or status logic is modified', () => {
  assert.doesNotMatch(panel, /ScreeningStatus\.VETTED\s*=/);
  assert.doesNotMatch(panel, /isGuardVetted\s*=/);
  assert.doesNotMatch(panel, /assertGuardAssignable/);
});

test('no SIA or RTW validation rules are changed', () => {
  assert.match(panel, /SIA licence expiry date/);
  assert.match(panel, /Right to Work status/);
});

console.log(JSON.stringify({ event: 'phys007_remediation_tests_passed', tests: passed }));
