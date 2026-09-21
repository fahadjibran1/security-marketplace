// Selected-Guard workspace navigation (2D3.3): Guards → View Compliance / View Availability.
// Same approach as company-compliance-safety.spec.cjs: pure logic is executed through the TypeScript compiler that is
// already a dev dependency (no new framework); the component wiring is asserted against the source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function loadTs(file) {
  const out = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out)(mod, mod.exports, require);
  return mod.exports;
}

const nav = loadTs('src/components/company/guard-navigation.ts');
const model = loadTs('src/components/company/compliance-model.ts');
const guards = read('src/components/company/CompanyGuardsWorkspace.tsx');
const compliance = read('src/components/company/CompanyComplianceWorkspace.tsx');
const availability = read('src/components/company/CompanyAvailabilityWorkspace.tsx');
const dashboard = read('src/screens/CompanyDashboardScreen.tsx');

let count = 0;
async function test(name, work) {
  await work();
  count += 1;
  console.log(`PASS ${name}`);
}

// A tiny stand-in for the dashboard's parent state, built ONLY from the exported pure functions the dashboard calls.
function makeParent() {
  let target = null;
  let seq = 0;
  let section = 'guards';
  const perms = { canViewCompliance: true, canViewAvailability: true };
  const api = {
    get target() { return target; },
    get section() { return section; },
    setPerms(next) { Object.assign(perms, next); },
    // openGuardWorkspace
    open(sec, guardId) {
      if (!nav.canOpenGuardWorkspace(sec, perms)) return false;
      seq += 1;
      target = nav.openGuardTarget(sec, guardId, seq);
      section = sec;
      api.reconcile();
      return true;
    },
    consume(requestId) { target = nav.consumeGuardTarget(target, requestId); },
    // handleNavigate (sidebar)
    sidebar(sec) { target = nav.clearGuardTarget(); section = sec; api.reconcile(); },
    // any other route (e.g. a dashboard tile) that just switches the section
    goto(sec) { section = sec; api.reconcile(); },
    reconcile() { target = nav.reconcileGuardTarget(target, section); },
    handedTo(sec) { return nav.targetForSection(target, sec); },
  };
  return api;
}

const summary = (id, status, over = {}) => ({
  guardId: id, fullName: `Guard ${id}`, siaLicenceNumber: `20000000000${String(id).padStart(5, '0')}`, siaExpiryDate: '2030-01-01',
  rightToWorkStatus: 'permanent', rightToWorkExpiryDate: null, complianceStatus: status, assignable: status === 'valid',
  blockingReasons: status === 'expired' ? ['SIA licence expired'] : [], expiringReasons: [], missingDocuments: [], documents: [], ...over,
});
const ROWS = model.buildComplianceRows([summary(1, 'valid'), summary(2, 'expired'), summary(3, 'invalid'), summary(4, 'expiring')]);

(async () => {
  // ── Guards → Compliance ─────────────────────────────────────────────────────
  await test('TARGET-COMPLIANCE: View Compliance from a Guard opens Compliance focused on THAT Guard', () => {
    const parent = makeParent();
    assert.equal(parent.open('compliance', 2, ), true);
    assert.equal(parent.section, 'compliance');
    assert.deepEqual(parent.handedTo('compliance'), { section: 'compliance', guardId: 2, requestId: 1 });
    assert.equal(parent.handedTo('availability'), null, 'a target is only handed to its own workspace');
    const plan = model.planGuardTarget(ROWS, 2);
    assert.deepEqual(plan, { found: true, selectedGuardId: 2, filter: 'all', search: '' });
    // Wiring: the Guards button passes THE Guard, closes its drawer, and the dashboard opens the target.
    assert.match(guards, /onPress=\{\(\) => \{ setQuickView\(null\); onNavigateToCompliance\(qvGuard\.id\); \}\}/);
    assert.match(guards, /onNavigateToCompliance: \(guardId: number\) => void;/);
    assert.match(dashboard, /onNavigateToCompliance=\{\(guardId\) => openGuardWorkspace\('compliance', guardId\)\}/);
    assert.doesNotMatch(dashboard, /onNavigateToCompliance=\{\(\) => setActiveSection/, 'no more context-free navigation');
    assert.match(dashboard, /target=\{targetForSection\(guardTarget, 'compliance'\)\}/);
    assert.match(compliance, /setSelectedGuardId\(plan\.selectedGuardId\)/, 'the drawer opens through the existing selection state');
  });

  await test('TARGET-COMPLIANCE-VALID-WITH-ATTENTION-FILTER: a Valid Guard is visible even if Needs Attention was selected', () => {
    const before = model.selectVisibleRows(ROWS, 'attention', '').map((r) => r.guardId);
    assert.ok(!before.includes(1), 'precondition: the old filter would hide the Valid Guard');
    const plan = model.planGuardTarget(ROWS, 1);
    assert.equal(plan.filter, 'all');
    assert.ok(model.selectVisibleRows(ROWS, plan.filter, plan.search).some((r) => r.guardId === 1));
    assert.match(compliance, /setFilter\(plan\.filter\)/);
  });

  await test('TARGET-COMPLIANCE-SEARCH-CLEAR: the search is cleared for the target, and normal search keeps working afterwards', () => {
    assert.equal(model.selectVisibleRows(ROWS, 'all', 'zzz').length, 0, 'precondition: a stale search would hide everyone');
    const plan = model.planGuardTarget(ROWS, 3);
    assert.equal(plan.search, '');
    assert.ok(model.selectVisibleRows(ROWS, plan.filter, plan.search).some((r) => r.guardId === 3));
    assert.match(compliance, /setSearch\(plan\.search\)/);
    // Not a permanent change: search/filter are ordinary state, only touched by the one-shot effect.
    assert.deepEqual(model.selectVisibleRows(ROWS, 'all', 'Guard 4').map((r) => r.guardId), [4]);
    assert.equal((compliance.match(/setSearch\(plan\.search\)/g) || []).length, 1);
  });

  await test('TARGET-COMPLIANCE-INVALID: an unavailable Guard opens nothing — never another Guard as a fallback', () => {
    for (const missing of [99, 0, -1]) {
      const plan = model.planGuardTarget(ROWS, missing);
      assert.equal(plan.found, false);
      assert.equal(plan.selectedGuardId, null, 'no Guard is selected');
      assert.ok(!ROWS.some((r) => r.guardId === plan.selectedGuardId));
    }
    assert.equal(model.planGuardTarget([], 1).selectedGuardId, null, 'no rows at all');
    // A Guard whose summary was not returned but who is still linked is an Unknown row: found, shown as Unknown.
    const withUnknown = model.buildComplianceRows([summary(1, 'valid')], [{ id: 9, status: 'ACTIVE', guard: { id: 7, fullName: 'No Summary' } }]);
    assert.deepEqual(model.planGuardTarget(withUnknown, 7).selectedGuardId, 7);
    // The workspace still renders normally, tells the manager, and consumes the target.
    assert.match(compliance, /if \(!plan\.found\) showNotice\(\{ tone: 'warning', message: 'That guard is not in the compliance list, so no guard was opened\.' \}\)/);
    assert.doesNotMatch(compliance, /rows\[0\]|visibleRows\[0\]|summaries\[0\]/);
  });

  await test('TARGET-CONSUMED: one-shot — consumed only after an authoritative decision, then normal use resumes', () => {
    const parent = makeParent();
    parent.open('compliance', 2);
    // Not consumed while loading / after a failed load: the workspace returns before consuming.
    const effect = compliance.slice(compliance.indexOf('const handledTargetRequest'), compliance.indexOf('// ── Document actions'));
    assert.ok(effect.length > 300, 'target effect located');
    assert.ok(effect.indexOf("if (phase !== 'ready') return;") > -1);
    assert.ok(effect.indexOf("if (phase !== 'ready') return;") < effect.indexOf('planGuardTarget(rows, target.guardId)'), 'waits for loaded rows before deciding');
    assert.ok(effect.indexOf("if (phase !== 'ready') return;") < effect.lastIndexOf('onTargetConsumed?.(target.requestId)'), 'consumed only after ready');
    assert.equal((effect.match(/onTargetConsumed\?\.\(target\.requestId\)/g) || []).length, 2, 'consumed after a decision, and when the user cannot view Compliance');
    assert.match(effect, /handledTargetRequest\.current === target\.requestId/, 'never applied twice for one request');
    // Consumption clears the parent target; nothing forces the drawer open again.
    parent.consume(1);
    assert.equal(parent.target, null);
    assert.equal(parent.handedTo('compliance'), null);
    // The user can now filter / search / select others freely: none of that touches the target.
    const usual = model.selectVisibleRows(ROWS, 'expiring', '').map((r) => r.guardId);
    assert.deepEqual(usual, [4]);
    assert.doesNotMatch(compliance.replace(effect, ''), /onTargetConsumed\?\.\(|handledTargetRequest/, 'target consumption lives only in the one-shot effect');
    // Consuming twice, or consuming something unknown, is harmless.
    parent.consume(1); parent.consume(999);
    assert.equal(parent.target, null);
  });

  await test('TARGET-REPEAT: Guards → Ahmed → Compliance, close, Guards → Sophie → Compliance opens Sophie, never Ahmed', () => {
    const AHMED = 1;
    const SOPHIE = 3;
    const parent = makeParent();
    parent.open('compliance', AHMED);
    assert.equal(model.planGuardTarget(ROWS, parent.handedTo('compliance').guardId).selectedGuardId, AHMED);
    parent.consume(parent.handedTo('compliance').requestId);
    // "Close the drawer" is local to Compliance: it does not touch navigation state.
    assert.match(compliance, /const closeDrawer = \(\) => setSelectedGuardId\(null\);/);
    parent.sidebar('guards'); // back to Guards
    parent.open('compliance', SOPHIE);
    const second = parent.handedTo('compliance');
    assert.deepEqual([second.guardId, second.requestId], [SOPHIE, 2]);
    assert.equal(model.planGuardTarget(ROWS, second.guardId).selectedGuardId, SOPHIE);
    // Even without leaving the section, a newer request replaces the older one.
    parent.open('compliance', AHMED);
    assert.deepEqual(parent.handedTo('compliance').guardId, AHMED);
  });

  await test('DIRECT-COMPLIANCE-NO-STALE-TARGET: sidebar / other routes never open a stale Guard', () => {
    // A target that was never consumed (e.g. the load failed) is dropped by a sidebar click …
    const a = makeParent();
    a.open('compliance', 2);
    a.sidebar('compliance');
    assert.equal(a.handedTo('compliance'), null);
    // … and by leaving the section by any route.
    const b = makeParent();
    b.open('compliance', 2);
    b.goto('dashboard');
    assert.equal(b.target, null);
    b.goto('compliance');
    assert.equal(b.handedTo('compliance'), null, 'a later tile click into Compliance opens it normally');
    // A compliance target is never handed to Availability and vice versa.
    const c = makeParent();
    c.open('availability', 2);
    assert.equal(c.handedTo('compliance'), null);
    c.goto('compliance');
    assert.equal(c.target, null);
    // Wiring
    assert.match(dashboard, /setGuardTarget\(clearGuardTarget\(\)\); \/\/ direct sidebar navigation never carries a Guard/);
    assert.match(dashboard, /setGuardTarget\(\(current\) => reconcileGuardTarget\(current, activeSection\)\)/);
    assert.match(dashboard, /const handleNavigate = \(section: CompanySection\) => \{[\s\S]*?setGuardTarget\(clearGuardTarget\(\)\)/);
    // The reconcile effect is declared above the component's early returns (Rules of Hooks).
    assert.ok(dashboard.indexOf('reconcileGuardTarget(current, activeSection)') < dashboard.indexOf('if (companyMobileLayoutDisabled) {'), 'hook order');
  });

  // ── Guards → Availability ───────────────────────────────────────────────────
  await test('TARGET-AVAILABILITY: preselects the target through the EXISTING Guard selector, after the Guard list loads', () => {
    const list = [{ id: 1, guard: { id: 1 } }, { id: 2, guard: { id: 5 } }, { id: 3, guard: { id: 8 } }];
    assert.deepEqual(nav.planAvailabilityTarget(list, 5), { found: true, guardFilter: '5' });
    const parent = makeParent();
    assert.equal(parent.open('availability', 5), true);
    assert.deepEqual(parent.handedTo('availability'), { section: 'availability', guardId: 5, requestId: 1 });
    // Wiring
    assert.match(guards, /onNavigateToAvailability\(qvGuard\.id\)/);
    assert.match(dashboard, /onNavigateToAvailability=\{\(guardId\) => openGuardWorkspace\('availability', guardId\)\}/);
    assert.match(dashboard, /target=\{targetForSection\(guardTarget, 'availability'\)\}/);
    const effect = availability.slice(availability.indexOf('const handledTargetRequest'), availability.indexOf('const guardOptions'));
    assert.match(effect, /!guardsLoaded/, 'waits for the loaded Guard list');
    assert.match(effect, /setGuardFilter\(planAvailabilityTarget\(guards, target\.guardId\)\.guardFilter\)/, 'reuses the existing selector state');
    assert.match(effect, /onTargetConsumed\?\.\(target\.requestId\)/);
    assert.equal((availability.match(/useState\(''\)/g) || []).length, 1, 'only the one existing guardFilter state — no duplicate selection state');
    assert.match(availability, /setGuardsLoaded\(true\)/);
    assert.match(availability, /<WebSelect value=\{guardFilter\} onChange=\{setGuardFilter\}/);
  });

  await test('TARGET-AVAILABILITY-INVALID: an unavailable Guard shows everyone — never an unrelated Guard', () => {
    const list = [{ id: 1, guard: { id: 1 } }, { id: 2, guard: { id: 5 } }];
    for (const missing of [99, 0]) assert.deepEqual(nav.planAvailabilityTarget(list, missing), { found: false, guardFilter: '' });
    assert.deepEqual(nav.planAvailabilityTarget([], 1), { found: false, guardFilter: '' });
    assert.deepEqual(nav.planAvailabilityTarget([{ id: 3, guard: null }, { id: 4 }], 1), { found: false, guardFilter: '' }, 'links without a Guard are ignored');
    const effect = availability.slice(availability.indexOf('const handledTargetRequest'), availability.indexOf('const guardOptions'));
    assert.doesNotMatch(effect, /guards\[0\]|guardOptions\[1\]/, 'no fallback to the first Guard');
  });

  await test('DIRECT-AVAILABILITY: sidebar Availability opens normally with no target', () => {
    const parent = makeParent();
    parent.open('availability', 5);
    parent.sidebar('availability');
    assert.equal(parent.handedTo('availability'), null);
    assert.equal(nav.reconcileGuardTarget(null, 'availability'), null);
    assert.match(availability, /target = null,/);
  });

  // ── Permissions ───────────────────────────────────────────────────────────
  const backend = fs.readFileSync(path.join(root, '..', 'security-backend-nest', 'src', 'company-membership', 'company-membership-types.ts'), 'utf8');
  const enumBody = /export enum CompanyPermission \{([\s\S]*?)\n\}/.exec(backend)[1];
  const perm = Object.fromEntries([...enumBody.matchAll(/(\w+) = '([^']+)'/g)].map((m) => [m[1], m[2]]));
  const sets = {};
  for (const m of backend.matchAll(/const (\w+)_PERMISSIONS: Set<CompanyPermission> = new Set\(\[([\s\S]*?)\]\);/g)) {
    sets[m[1]] = [...m[2].replace(/\/\/.*$/gm, '').matchAll(/CompanyPermission\.(\w+)/g)].map((x) => perm[x[1]]);
  }
  sets.OWNER = Object.values(perm);
  const ROLES = ['OWNER', 'ADMIN', 'HR_COMPLIANCE', 'OPERATIONS', 'CONTROL_ROOM', 'FINANCE', 'VIEWER'];

  await test('PERMISSION-COMPLIANCE: View Compliance follows compliance.view for all seven roles (and is refused, not just hidden)', () => {
    assert.deepEqual(Object.keys(sets).sort(), [...ROLES].sort());
    const expected = { OWNER: true, ADMIN: true, HR_COMPLIANCE: true, OPERATIONS: true, CONTROL_ROOM: true, FINANCE: false, VIEWER: true };
    for (const role of ROLES) {
      const perms = nav.resolveGuardNavPermissions(sets[role], 'company_staff');
      assert.equal(perms.canViewCompliance, expected[role], role);
      assert.equal(perms.canViewCompliance, sets[role].includes('compliance.view'), `${role} matches the backend matrix`);
      const parent = makeParent();
      parent.setPerms(perms);
      assert.equal(parent.open('compliance', 1), expected[role], `${role}: the navigation itself is gated`);
      assert.equal(parent.section, expected[role] ? 'compliance' : 'guards');
      if (!expected[role]) assert.equal(parent.target, null);
    }
    assert.match(guards, /\{canViewCompliance \? \(\s*<Button label="View Compliance"/);
    assert.match(dashboard, /if \(!canOpenGuardWorkspace\(section, guardNavPermissions\)\) return;/);
    assert.match(dashboard, /canViewCompliance=\{guardNavPermissions\.canViewCompliance\}/);
    // The hint that points at the button is hidden with it.
    assert.match(guards, /qvCompliance\.label === 'Unknown' && canViewCompliance/);
  });

  await test('PERMISSION-AVAILABILITY: View Availability follows shifts.view (the backend availability read permission)', () => {
    const service = fs.readFileSync(path.join(root, '..', 'security-backend-nest', 'src', 'availability', 'availability.service.ts'), 'utf8');
    assert.match(service, /CompanyPermission\.SHIFTS_VIEW/, 'availability reads are guarded by shifts.view');
    const expected = { OWNER: true, ADMIN: true, HR_COMPLIANCE: false, OPERATIONS: true, CONTROL_ROOM: true, FINANCE: false, VIEWER: true };
    for (const role of ROLES) {
      const perms = nav.resolveGuardNavPermissions(sets[role], 'company_staff');
      assert.equal(perms.canViewAvailability, expected[role], role);
      assert.equal(perms.canViewAvailability, sets[role].includes('shifts.view'), `${role} matches the backend matrix`);
      const parent = makeParent();
      parent.setPerms(perms);
      assert.equal(parent.open('availability', 1), expected[role], `${role}: the navigation itself is gated`);
    }
    assert.match(guards, /\{canViewAvailability \? \(\s*<Button label="View Availability"/);
    assert.match(guards, /\{canViewCompliance \|\| canViewAvailability \? \(/, 'no empty action row when neither is allowed');
    // Legacy fallback only when the session has no permission list.
    assert.deepEqual(nav.resolveGuardNavPermissions(undefined, 'company'), { canViewCompliance: true, canViewAvailability: true });
    assert.deepEqual(nav.resolveGuardNavPermissions(undefined, 'company_staff'), { canViewCompliance: false, canViewAvailability: false });
    assert.deepEqual(nav.resolveGuardNavPermissions([], 'company'), { canViewCompliance: false, canViewAvailability: false });
  });

  await test('FINANCE: no route into Compliance through the navigation path, and evidence actions stay with compliance.manage', () => {
    const finance = nav.resolveGuardNavPermissions(sets.FINANCE, 'company_staff');
    assert.equal(finance.canViewCompliance, false);
    const parent = makeParent();
    parent.setPerms(finance);
    assert.equal(parent.open('compliance', 1), false);
    assert.equal(parent.target, null);
    // If a target ever reached the workspace of a user who cannot view Compliance it is consumed without opening anything.
    assert.match(compliance, /if \(!canViewCompliance\) \{[\s\S]*?onTargetConsumed\?\.\(target\.requestId\);\s*return;/);
    // OPERATIONS / CONTROL_ROOM may navigate (compliance.view) but gain no manage rights.
    for (const role of ['OPERATIONS', 'CONTROL_ROOM', 'VIEWER']) {
      assert.equal(nav.resolveGuardNavPermissions(sets[role], 'company_staff').canViewCompliance, true, role);
      assert.equal(model.resolveCompliancePermissions(sets[role], 'company_staff').canManage, false, `${role} cannot manage`);
    }
    assert.match(dashboard, /canManageCompliance=\{compliancePermissions\.canManage\}/, 'manage still comes from compliance.manage only');
  });

  // ── Safety ────────────────────────────────────────────────────────────────
  await test('RACE: rapid target A then B — B wins, a late consume of A cannot clear B, and no document fetch exists to go stale', () => {
    const parent = makeParent();
    parent.open('compliance', 1); // A
    parent.open('compliance', 3); // B, before A was applied
    assert.equal(parent.handedTo('compliance').guardId, 3);
    parent.consume(1); // A's late consume
    assert.equal(parent.handedTo('compliance').guardId, 3, 'B is still pending');
    assert.equal(model.planGuardTarget(ROWS, parent.handedTo('compliance').guardId).selectedGuardId, 3);
    parent.consume(2);
    assert.equal(parent.target, null);
    assert.doesNotMatch(`${compliance}\n${availability}`, /listGuardDocuments/, '2D3.1: documents come from the loaded summary, so nothing async can show A\'s documents under B');
    assert.match(compliance, /findRowByGuardId\(rows, selectedGuardId\)/, 'the drawer still resolves its Guard strictly by id');
  });

  await test('NO EXTRA NETWORK CALLS: targeting reuses already-loaded destination data', () => {
    const complianceEffect = compliance.slice(compliance.indexOf('const handledTargetRequest'), compliance.indexOf('// ── Document actions'));
    const availabilityEffect = availability.slice(availability.indexOf('const handledTargetRequest'), availability.indexOf('const guardOptions'));
    for (const [name, effect] of [['compliance', complianceEffect], ['availability', availabilityEffect]]) {
      assert.doesNotMatch(effect, /\bds\.|fetch\(|await |list[A-Z]\w*\(|accessGuardDocument|getGuard/, `${name} target effect makes no request`);
    }
    // The pure navigation module cannot make requests at all.
    assert.doesNotMatch(read('src/components/company/guard-navigation.ts'), /^import /m);
    // The workspaces' own loaders are unchanged in shape (compliance still makes exactly one call each per load).
    for (const call of ['ds.listStatuses()', 'ds.listGuards()', 'ds.listRecords()', 'ds.listScreeningOutcomes()']) {
      assert.equal((compliance.match(new RegExp(call.replace(/[().]/g, '\\$&'), 'g')) || []).length, 1, call);
    }
    // The Guards workspace passes a number only — never a fetched record.
    assert.match(guards, /onNavigateToCompliance\(qvGuard\.id\)/);
  });

  await test('DRAWER CLOSE stays in the destination workspace; there is no back-navigation history', () => {
    assert.match(compliance, /onClose=\{closeDrawer\}/);
    assert.doesNotMatch(compliance, /onNavigateTo|setActiveSection|history|goBack/);
    assert.doesNotMatch(availability, /onNavigateTo|setActiveSection|history|goBack/);
    assert.doesNotMatch(read('src/components/company/guard-navigation.ts'), /history|goBack|stack/i);
    assert.doesNotMatch(dashboard, /react-navigation/);
  });

  await test('The Guards change is minimal: callbacks carry the Guard id; permissions gate the buttons; no layout change', () => {
    const diffless = guards.replace(/\s+/g, ' ');
    assert.match(diffless, /onNavigateToShiftOffers\(\); \}\}/, 'other Guards actions untouched');
    assert.match(guards, /styles\.actionButtons, styles\.actionButtonsSecondary/, 'same action row styling');
    assert.doesNotMatch(read('src/components/company/guard-navigation.ts'), /react-native/);
  });

  console.log(JSON.stringify({ event: 'guard_navigation_tests_passed', tests: count }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
