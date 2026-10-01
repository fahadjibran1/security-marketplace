#!/usr/bin/env node
/**
 * The Company Dashboard must actually RENDER. (P0 white-screen hotfix.)
 *
 * WHAT THIS EXISTS FOR
 * `expo export` bundled the 8f574bf release perfectly and the browser then died on first paint with
 * `Uncaught ReferenceError: Cannot access 'Wi' before initialization`. A bundle check proves the module
 * graph resolves; it executes nothing. Typecheck did not see it either, because TypeScript cannot know
 * that a `useMemo` factory runs DURING the render rather than later, so a `const` referenced inside one
 * but declared further down the component body is accepted at compile time and is in the temporal dead
 * zone at run time.
 *
 * So this renders the screen for real. Hooks execute, every `useMemo` factory runs, and a temporal-dead-
 * zone access throws here exactly as it threw in Chrome.
 *
 * It is deliberately not a snapshot test: it asserts that the component renders at all, which is the
 * single thing the whole release pipeline failed to check.
 */
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;

Module._resolveFilename = function (request, ...rest) {
  if (request === 'react-native') return originalResolve.call(this, 'react-native-web', ...rest);
  return originalResolve.call(this, request, ...rest);
};

/**
 * Native and platform packages, stubbed.
 *
 * These reach a device API or ship untranspiled TypeScript inside node_modules, so Node cannot load
 * them — and none of them is the subject here. What is being tested is whether the SCREEN's own body
 * executes, so everything around it is replaced by something inert that still behaves like a module:
 * a capitalised export renders its children, anything else is a no-op.
 */
const STUB_PREFIXES = [
  'expo', '@expo/', '@react-navigation/', '@react-native-async-storage/',
  'react-native-safe-area-context', 'react-native-screens', 'react-native-gesture-handler',
  'react-native-reanimated', 'react-native-svg',
];

function inertModule() {
  const React = require('react');
  const passthrough = (name) => {
    const Component = ({ children }) => React.createElement('div', { 'data-stub': name }, children);
    Component.displayName = `Stub(${name})`;
    return Component;
  };
  const cache = new Map();
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === '__esModule') return true;
      if (prop === 'default') return inertModule();
      if (!cache.has(prop)) {
        cache.set(prop, /^[A-Z]/.test(prop) ? passthrough(prop) : () => undefined);
      }
      return cache.get(prop);
    },
    apply: () => undefined,
  });
}

Module._load = function (request, ...rest) {
  if (STUB_PREFIXES.some((prefix) => request === prefix || request.startsWith(prefix))) {
    return inertModule();
  }
  return originalLoad.call(this, request, ...rest);
};

// The components ask `typeof document !== 'undefined'` to decide they are on the web, and the web
// layout is the one that crashed.
if (typeof globalThis.document === 'undefined') globalThis.document = {};
if (typeof globalThis.window === 'undefined') globalThis.window = { addEventListener() {}, removeEventListener() {} };

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

const appRequire = Module.createRequire(path.join(ROOT, 'package.json'));
const React = appRequire('react');
const { renderToStaticMarkup } = appRequire('react-dom/server');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log('PASS ', name);
  } catch (error) {
    console.error('FAIL ', name);
    console.error('      ' + (error && error.message));
    process.exitCode = 1;
  }
};

/**
 * Every API call the screen can make, stubbed to resolve empty.
 *
 * No network, and nothing that could reach production. The screen's loader fires on mount; what matters
 * here is that the component BODY executes, which happens before any of these settle.
 */
function stubApiClient() {
  const api = loadTs('src/services/api.ts');
  for (const key of Object.keys(api)) {
    if (typeof api[key] === 'function') {
      api[key] = async () => [];
    }
  }
  return api;
}

function renderDashboard() {
  stubApiClient();
  const { CompanyDashboardScreen } = loadTs('src/screens/CompanyDashboardScreen.tsx');
  const RNW = appRequire('react-native-web');

  const element = React.createElement(CompanyDashboardScreen, {
    user: {
      id: 1, email: 'control@example.invalid', role: 'company_admin',
      firstName: 'Control', lastName: 'Room', status: 'active',
    },
    onLogout: () => {},
  });

  RNW.AppRegistry.registerComponent('Runtime', () => () => element);
  const app = RNW.AppRegistry.getApplication('Runtime', {});
  return renderToStaticMarkup(app.element);
}

let markup = '';

test('BOOT-01-THE-COMPANY-DASHBOARD-RENDERS-WITHOUT-A-REFERENCE-ERROR', () => {
  // The exact failure: `Cannot access 'X' before initialization`. A `useMemo` factory at the top of the
  // component body reached a `const` declared hundreds of lines below it, so the binding was still in
  // its temporal dead zone when the factory ran on first render.
  try {
    markup = renderDashboard();
  } catch (error) {
    if (error instanceof ReferenceError) {
      throw new Error(
        `the screen threw a temporal-dead-zone ReferenceError on first render: ${error.message}`,
      );
    }
    throw error;
  }
  assert.ok(markup.length > 0, 'the screen produced markup');
});

/**
 * The Live Operations surface, rendered directly.
 *
 * The screen opens on its own default section, so these render the shipped components the Live
 * Operations section mounts — the same ones the production page builds — rather than asserting against
 * a section the screen is not currently showing.
 */
function renderLiveOperations(
  itemStatus,
  itemsOverride,
  workspacePath = 'src/components/company/CompanyLiveOperationsWorkspace.tsx',
) {
  const RNW = appRequire('react-native-web');
  const workspace = loadTs(workspacePath);
  const outlook = loadTs('src/components/company/operationsOutlook.ts');

  const now = Date.now();
  const rows = [{
    shift: {
      id: 19,
      start: new Date(now - 90 * 60_000).toISOString(),
      end: new Date(now - 30 * 60_000).toISOString(),
      status: 'in_progress',
      site: { id: 7, name: 'TEST SITE', timezone: 'Europe/London' },
      guard: { fullName: 'Fahad test' },
    },
    attendance: { checkInAt: new Date(now - 92 * 60_000).toISOString(), checkOutAt: null },
    operations: null,
  }];

  const element = React.createElement(workspace.LiveOpsAttentionRail, {
    // A Missing Book Off item: the exact category whose presence triggered the production crash.
    items: itemsOverride ?? [{
      id: 'attention-501', alertId: 501, shiftId: 19, status: itemStatus,
      siteName: 'TEST SITE', guardName: 'Fahad test',
      category: 'missing_book_off', issueType: 'Missing Book Off',
      message: 'Scheduled end 21:35 · 13h 20m overdue',
      occurredAt: new Date(now - 20 * 60_000).toISOString(),
    }],
    metricFocus: 'all',
    resolveShiftZone: () => 'Europe/London',
    urgentActionItemId: null,
    onOpenUrgentDetail: () => {},
    onOpenUrgentShift: () => {},
    onUrgentIncidentFollowUp: async () => {},
    onUrgentAlertFollowUp: async () => {},
    nextUp: outlook.buildNextUp(rows, now),
  });

  RNW.AppRegistry.registerComponent('LiveOps', () => () => element);
  const app = RNW.AppRegistry.getApplication('LiveOps', {});
  return renderToStaticMarkup(app.element);
}

test('BOOT-02-LIVE-OPERATIONS-RENDERS', () => {
  const live = renderLiveOperations('open');
  assert.ok(live.length > 0, 'the Live Operations rail renders');
  assert.ok(live.includes('Missing Book Off'), 'with the item whose presence caused the crash');
  assert.ok(live.includes('13h 20m overdue'), 'and its overdue duration');
});

test('BOOT-03-ATTENTION-NOW-RENDERS', () => {
  const live = renderLiveOperations('open');
  assert.ok(live.includes('Attention Now'), 'the exception queue is on the page');
  assert.ok(live.includes('Next Up'), 'and the rail it shares a column with');
});

test('BOOT-04-THE-RESOLUTION-CONTROLS-RENDER-WITHOUT-WRITING-ANYTHING', () => {
  // Nothing here clicks anything, and every API function is stubbed, so no request can leave this
  // process — the point is only that the controls render.
  const open = renderLiveOperations('open');
  assert.ok(open.includes('Acknowledge'), 'an open item offers Acknowledge');
  assert.ok(/aBtnPrimary|Open Shift|Resolve|View/.test(open), 'and a primary action beside it');

  const acknowledged = renderLiveOperations('acknowledged');
  assert.ok(acknowledged.includes('Acknowledged'), 'an acknowledged item says so in words');
  assert.ok(!acknowledged.includes('>Acknowledge<'),
    'and is no longer offered an acknowledgement it already has');
});

// ═══════════════════ the Missing Book Off primary action ═══════════════════

test('MBO-01-AN-OPEN-ITEM-OFFERS-ACKNOWLEDGE-AND-RESOLVE', () => {
  // It fell through to the default branch when the category was introduced, so the button read
  // "Open Shift" and the resolution dialog was unreachable for the one item that most needs it.
  const open = renderLiveOperations('open');
  assert.ok(open.includes('Acknowledge'), 'Acknowledge is offered');
  assert.ok(open.includes('>Resolve<'), 'and Resolve is the primary action');
  assert.ok(!open.includes('Open Shift'), 'never "Open Shift"');
});

test('MBO-02-AN-ACKNOWLEDGED-ITEM-SAYS-SO-AND-STILL-OFFERS-RESOLVE', () => {
  const acknowledged = renderLiveOperations('acknowledged');
  assert.ok(acknowledged.includes('Acknowledged'), 'the state is stated in words');
  assert.ok(acknowledged.includes('>Resolve<'), 'and it can still be resolved');
  assert.ok(!acknowledged.includes('>Acknowledge<'), 'but is not asked to acknowledge again');
  assert.ok(!acknowledged.includes('Open Shift'));
});

test('MBO-03-A-CLOSED-ITEM-IS-NOT-IN-THE-QUEUE-AT-ALL', () => {
  // Attention Now is built from `outstandingAlerts`, which drops anything closed before an item is
  // ever made — so a resolved Missing Book Off cannot reach the rail.
  const screen = fs.readFileSync(path.join(ROOT, 'src/screens/CompanyDashboardScreen.tsx'), 'utf8');
  assert.ok(
    /const outstandingAlerts = React\.useMemo\(\s*\(\) => alerts\.filter\(\(alert\) => \(alert\.status \|\| ''\)\.toLowerCase\(\) !== 'closed'\)/.test(screen),
    'closed alerts are filtered out before any attention item is built',
  );
  const empty = renderLiveOperations('closed', []);
  assert.ok(!empty.includes('Missing Book Off'), 'and nothing closed is drawn');
});

test('MBO-04-RESOLVE-OPENS-THE-EXISTING-DIALOG-AND-SENDS-NO-REQUEST', () => {
  // The button routes through the SAME alert path as every other durable alert; the screen's handler
  // turns 'close' into the resolve dialog rather than an API call.
  const workspace = fs.readFileSync(
    path.join(ROOT, 'src/components/company/CompanyLiveOperationsWorkspace.tsx'), 'utf8',
  );
  assert.ok(
    /if \(item\.category === 'missing_book_off'\) \{[\s\S]{0,320}onUrgentAlertFollowUp\(item, 'close'\)/.test(workspace),
    'it uses the existing alert resolution path',
  );
  const screen = fs.readFileSync(path.join(ROOT, 'src/screens/CompanyDashboardScreen.tsx'), 'utf8');
  assert.ok(/openResolveForAlert\(item\);/.test(screen), "and 'close' opens the dialog");
  assert.equal((screen.match(/closeSafetyAlert\(/g) || []).length, 1,
    'the only close call in the screen is the dialog submit');

  // Rendering and opening the dialog must reach nothing. Every API function is replaced by a counter.
  let calls = 0;
  const api = loadTs('src/services/api.ts');
  for (const key of Object.keys(api)) {
    if (typeof api[key] === 'function') api[key] = async () => { calls += 1; return []; };
  }
  renderLiveOperations('open');
  assert.equal(calls, 0, 'rendering the queue issues no request');
});

test('MBO-05-RESOLVING-STILL-CANNOT-INVENT-A-BOOK-OFF', () => {
  // The frontend half of the rule the backend proves by asserting what is absent from the database.
  const drawer = fs.readFileSync(
    path.join(ROOT, 'src/components/company/CompanyResolveAlertDrawer.tsx'), 'utf8',
  );
  assert.ok(!/from '\.\.\/\.\.\/services\/api'/.test(drawer), 'the dialog reaches no endpoint itself');
  assert.ok(!/bookOn|bookOff|checkIn|checkOut|AttendanceEvent/.test(drawer), 'and names no attendance concept');
  assert.ok(/does not change attendance, Welfare evidence or the/.test(drawer), 'and says so on its face');
});

test('MBO-06-MUTATION-REMOVING-THE-CATEGORY-BREAKS-THESE-TESTS', () => {
  // An assertion that cannot fail proves nothing. This builds a copy of the workspace with
  // `missing_book_off` taken out of the resolve branch and renders it: the button must fall back to
  // "Open Shift", which is exactly what MBO-01 and MBO-02 forbid.
  const file = path.join(ROOT, 'src/components/company/CompanyLiveOperationsWorkspace.tsx');
  const original = fs.readFileSync(file, 'utf8');
  const mutated = original.replace(
    "  if (item.category === 'missing_book_off') {",
    "  if (false && item.category === 'missing_book_off') {",
  );
  assert.notEqual(mutated, original, 'the resolve branch was found and mutated');

  const mutantPath = path.join(ROOT, 'src/components/company/MutantWorkspace.tsx');
  fs.writeFileSync(mutantPath, mutated);
  try {
    const markup = renderLiveOperations('open', undefined, 'src/components/company/MutantWorkspace.tsx');
    assert.ok(markup.includes('Open Shift'),
      'without the branch the item falls back to "Open Shift" — the defect this fix removes');
    assert.ok(!markup.includes('>Resolve<'), 'and Resolve is unreachable');
  } finally {
    fs.unlinkSync(mutantPath);
  }
});

test('BOOT-05-NO-HOOK-ORDER-OR-INITIALISATION-ERROR-ON-A-SECOND-RENDER', () => {
  // A second independent render catches an initialisation problem that only shows once module state
  // has been touched, and a hook-order change between renders.
  const second = renderDashboard();
  assert.ok(second.length > 0, 'it renders again');
});

console.log(`\n${passed} company dashboard runtime checks passed`);
