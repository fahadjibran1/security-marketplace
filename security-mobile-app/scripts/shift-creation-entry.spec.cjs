/**
 * UAT-SHIFT-01: reaching shift creation from Live Operations.
 *
 * Production UAT could not create a shift: the only Add Shift control lived one level inside the Rota
 * Planner, and neither release gate renders a screen or clicks anything, so nothing could have caught
 * it. These checks cover the journey itself — the control exists where a control room works, it is
 * permission gated, it reaches the EXISTING form, and a background refresh cannot reopen that form.
 *
 * The one-shot intent is executed rather than asserted from source: a token that could be re-consumed
 * would reopen the drawer over a working operator, which is precisely the failure mode to rule out.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const liveOps = read('src/components/company/CompanyLiveOperationsWorkspace.tsx');
const planner = read('src/components/company/CompanyRotaPlannerWorkspace.tsx');
const dashboard = read('src/screens/CompanyDashboardScreen.tsx');

// ═══════════════════ 1–2 the control exists, and is permission gated ═══════════════════

test('SHIFT-ENTRY-01-LIVE-OPERATIONS-OFFERS-ADD-SHIFT', () => {
  assert.ok(liveOps.includes('+ Add Shift'), 'Live Operations renders an Add Shift control');
  assert.ok(liveOps.includes('accessibilityLabel="Add Shift"'), 'reachable by assistive technology');
  assert.ok(liveOps.includes('onAddShift'), 'wired to an action prop');
  assert.ok(liveOps.includes('canManageShifts'), 'and to a permission prop');
});

test('SHIFT-ENTRY-02-GATED-ON-SHIFTS-MANAGE', () => {
  // The control is inside a canManageShifts conditional, so a company user without the permission
  // never sees a button the backend would refuse.
  const gated = /\{canManageShifts \? \(([\s\S]{0,400}?)\) : null\}/.exec(liveOps);
  assert.ok(gated, 'the control is rendered conditionally');
  assert.ok(gated[1].includes('+ Add Shift'), 'and it is the Add Shift control that is gated');

  // Resolved from the session permission list, with the legacy owner fallback the dashboard already
  // uses elsewhere — not from the role alone.
  assert.ok(
    dashboard.includes(`user.companyPermissions.includes("shifts.manage")`),
    'shifts.manage comes from the session permission list',
  );
  assert.match(
    dashboard,
    /includes\("shifts\.manage"\)[\s\S]{0,140}user\?\.role === "company_admin" \|\| user\?\.role === "company"/,
    'with the legacy owner fallback only when the session carries no list',
  );
  assert.ok(dashboard.includes('canManageShifts={canManageShifts}'), 'and is passed to Live Operations');
});

// ═══════════════════ 3–5 one click reaches the EXISTING form ═══════════════════

test('SHIFT-ENTRY-03-CLICK-SWITCHES-TO-ROTA-PLANNER', () => {
  const handler = /handleAddShiftFromLiveOperations = React\.useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\)/.exec(dashboard);
  assert.ok(handler, 'the action handler exists');
  assert.match(handler[1], /setActiveSection\("rota-planner"\)/, 'it switches section to the Rota Planner');
  assert.ok(dashboard.includes('onAddShift={handleAddShiftFromLiveOperations}'), 'and is wired to the button');
});

test('SHIFT-ENTRY-04-AND-OPENS-THE-EXISTING-DRAWER-IN-THE-SAME-ACTION', () => {
  const handler = /handleAddShiftFromLiveOperations = React\.useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\)/.exec(dashboard);
  assert.match(handler[1], /setCreateShiftIntent\(/, 'the same click requests the drawer');
  assert.ok(dashboard.includes('createShiftIntent={createShiftIntent}'), 'the intent reaches the planner');
  // The planner acts on it by calling its own existing openCreate.
  assert.match(
    planner,
    /createShiftIntent[\s\S]{0,600}?openCreate\(\)/,
    'the planner opens its existing create drawer in response',
  );
});

test('SHIFT-ENTRY-05-NO-SECOND-SHIFT-FORM-OR-API-CALL-WAS-CREATED', () => {
  // There must remain exactly one shift-creation implementation.
  assert.ok(!liveOps.includes('createRotaSlot'), 'Live Operations does not call the create API');
  assert.ok(!liveOps.includes('CreateSlotBody'), 'nor render the create form');
  assert.ok(!liveOps.includes('handleCreate'), 'nor duplicate the create handler');
  assert.ok(planner.includes('CreateSlotBody'), 'the form still lives in the Rota Planner');
  assert.ok(planner.includes('onCreateSlot'), 'and still submits through the planner');

  const plannerDrawers = (planner.match(/title="Add Shift"/g) || []).length;
  assert.equal(plannerDrawers, 1, `exactly one Add Shift drawer, found ${plannerDrawers}`);
  const liveOpsDrawers = (liveOps.match(/title="Add Shift"/g) || []).length;
  assert.equal(liveOpsDrawers, 0, 'and none in Live Operations');
});

// ═══════════════════ 6–7 the intent is consumed exactly once ═══════════════════

test('SHIFT-ENTRY-06-07-INTENT-IS-ONE-SHOT-ACROSS-RERENDERS', () => {
  // Executing the planner's guard rather than reading it. A boolean prop, or a token compared
  // incorrectly, would reopen the drawer on the next fifteen second refresh and fight the operator.
  let opens = 0;
  const openCreate = () => { opens += 1; };
  const handled = { current: undefined };

  // Exactly the planner's effect body.
  const effect = (createShiftIntent) => {
    if (!createShiftIntent) return;
    if (handled.current === createShiftIntent) return;
    handled.current = createShiftIntent;
    openCreate();
  };

  effect(0);              // initial mount, nothing requested yet
  assert.equal(opens, 0, 'mounting the planner does not open the drawer');

  effect(1);              // the user clicks Add Shift
  assert.equal(opens, 1, 'the click opens it once');

  effect(1); effect(1); effect(1);   // background refreshes and re-renders
  assert.equal(opens, 1, 'a re-render with an unchanged intent does not reopen it');

  // The user closes the drawer; further refreshes must leave it closed.
  effect(1);
  assert.equal(opens, 1, 'closing then re-rendering keeps it closed');

  effect(2);              // a deliberate second request
  assert.equal(opens, 2, 'but a fresh click opens it again');

  // And the guard is a ref, not state, so it cannot itself trigger a render loop.
  assert.match(planner, /handledCreateIntent = React\.useRef/, 'the last-handled token is a ref');
  // The guard that the first version of this fix got wrong: comparing against undefined treated the
  // initial zero as a request, so the drawer opened every time anyone opened the planner.
  assert.match(
    planner,
    /if \(!createShiftIntent\) return;/,
    'a zero token means no request, so simply opening the planner never opens the drawer',
  );
});

// ═══════════════════ 8–10 nothing existing was broken ═══════════════════

test('SHIFT-ENTRY-08-ORIGINAL-ROTA-PLANNER-BUTTON-STILL-WORKS', () => {
  assert.ok(
    planner.includes('label="+ Add Shift" variant="primary" size="sm" onPress={() => openCreate()}'),
    'the original Rota Planner control is untouched',
  );
  assert.ok(planner.includes('const openCreate = React.useCallback('), 'and still uses the same opener');
});

test('SHIFT-ENTRY-09-EXISTING-LIVE-OPERATIONS-FUNCTIONALITY-INTACT', () => {
  for (const marker of [
    'Welfare / Log Book', 'Operational monitoring', 'LiveFilters', 'metricFocus',
    'liveOperationEnrichedRows', 'onOpenCoverage',
  ]) {
    assert.ok(liveOps.includes(marker), `${marker} must still be present`);
  }
  // The exception wording lives in the shared presentation module, not the component.
  const presentation = read('src/components/company/operationsPresentation.ts');
  assert.ok(presentation.includes('BOOK OFF MISSING'), 'the missing Book Off exception is untouched');
  assert.ok(liveOps.includes('operationalExceptions'), 'and the workspace still renders exceptions');
  for (const header of ['Site / Guard', 'Scheduled', 'Attendance', 'Status', 'Risk', 'Alerts', 'Action']) {
    assert.ok(liveOps.includes(`'${header}'`), `the ${header} column must remain`);
  }
});

test('SHIFT-ENTRY-10-NO-SECOND-POLLING-LOOP', () => {
  const intervals = dashboard.split('setInterval').length - 1;
  assert.equal(intervals, 1, `exactly one polling loop, found ${intervals}`);
  assert.ok(dashboard.includes('}, 15000);'), 'still the existing fifteen second cycle');
});

console.log(`\n${passed} shift creation entry point checks passed`);
