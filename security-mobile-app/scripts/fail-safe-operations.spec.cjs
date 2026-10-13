#!/usr/bin/env node
/**
 * Fail-safe operational data (Performance P1).
 *
 * Renders the shipped Company dashboard and Live Operations components with failed data sources, using
 * the same harness as company-dashboard-v2.spec: react-native resolves to react-native-web and native
 * packages are inert. No API function is reachable, so nothing here can touch a network.
 */
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;

Module._resolveFilename = function (request, ...rest) {
  if (request === 'react-native') return originalResolve.call(this, 'react-native-web', ...rest);
  return originalResolve.call(this, request, ...rest);
};

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
      if (!cache.has(prop)) cache.set(prop, /^[A-Z]/.test(prop) ? passthrough(prop) : () => undefined);
      return cache.get(prop);
    },
    apply: () => undefined,
  });
}

Module._load = function (request, ...rest) {
  if (STUB_PREFIXES.some((prefix) => request === prefix || request.startsWith(prefix))) return inertModule();
  return originalLoad.call(this, request, ...rest);
};

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

const model = loadTs('src/components/company/dashboardOverview.ts');
const complianceModel = loadTs('src/components/company/compliance-model.ts');
const policy = loadTs('src/components/company/liveOperationsPolicy.ts');
const overview = loadTs('src/components/company/CompanyDashboardOverview.tsx');

const SCREEN = fs.readFileSync(path.join(ROOT, 'src/screens/CompanyDashboardScreen.tsx'), 'utf8');
const COMPONENT_SRC = fs.readFileSync(path.join(ROOT, 'src/components/company/CompanyDashboardOverview.tsx'), 'utf8');
const MODEL_SRC = fs.readFileSync(path.join(ROOT, 'src/components/company/dashboardOverview.ts'), 'utf8');

// ─── fixtures ────────────────────────────────────────────────────────────────

// 18:55 BST on Monday 5 October 2026.
const NOW = new Date('2026-10-05T17:55:00.000Z');
const minutes = (n) => new Date(NOW.getTime() + n * 60_000).toISOString();
const LONDON = () => 'Europe/London';

function item(id, category, occurredMinutes, extra = {}) {
  return {
    id, category, shiftId: extra.shiftId ?? null, status: 'open',
    siteName: extra.siteName ?? 'TEST SITE', guardName: extra.guardName ?? 'Fahad Test',
    issueType: extra.issueType ?? category, message: extra.message ?? '', occurredAt: minutes(occurredMinutes),
  };
}

const SEVEN_ITEMS = [
  item('site-request-1', 'site_request', -5, { issueType: 'Site Request' }),
  item('uncovered-2', 'uncovered_shift', 60, { issueType: 'Uncovered shift' }),
  item('checkcall-3', 'missed_check_call', -42, { issueType: 'Missed Welfare Check', shiftId: 19 }),
  item('panic-4', 'panic', -2, { issueType: 'Active panic alert', shiftId: 19 }),
  item('checkcall-5', 'missed_check_call', -10, { issueType: 'Missed Welfare Check', shiftId: 25 }),
  item('attention-6', 'missing_book_off', -30, { issueType: 'Missing Book Off', message: 'Scheduled end 18:00 · 55 min overdue' }),
  item('incident-7', 'incident', -90, { issueType: 'Incident unresolved' }),
];

const SHIFTS = [
  // Live: in progress, booked on.
  { id: 19, start: minutes(-20), end: minutes(40), status: 'in_progress', site: { id: 7, name: 'TEST SITE' }, guard: { id: 3, fullName: 'Fahad Test' } },
  // Live by attendance: accepted, started, Book On recorded.
  { id: 20, start: minutes(-60), end: minutes(120), status: 'ready', site: { id: 8, name: 'NORTH GATE' }, guard: { id: 4, fullName: 'Alex Long-Surname-Example' } },
  // NOT live: accepted, starts next week. The old dashboard counted this as a Live Shift.
  { id: 21, start: minutes(7 * 24 * 60), end: minutes(7 * 24 * 60 + 480), status: 'ready', site: { id: 7, name: 'TEST SITE' }, guard: { id: 3, fullName: 'Fahad Test' } },
  // Upcoming today, assigned.
  { id: 22, start: minutes(65), end: minutes(185), status: 'offered', site: { id: 7, name: 'TEST SITE' }, guard: { id: 5, fullName: 'Sam Guard' } },
  // Upcoming tomorrow, unassigned.
  { id: 23, start: minutes(20 * 60), end: minutes(28 * 60), status: 'unfilled', site: { id: 8, name: 'NORTH GATE' }, guard: null },
  // Completed earlier — never upcoming, never live.
  { id: 24, start: minutes(-600), end: minutes(-120), status: 'completed', site: { id: 7, name: 'TEST SITE' }, guard: { id: 3, fullName: 'Fahad Test' } },
];

const ATTENDANCE = new Map([
  [19, { checkInAt: minutes(-21), checkOutAt: null }],
  [20, { checkInAt: minutes(-58), checkOutAt: null }],
]);

const OPERATIONS = new Map([
  [19, {
    bookOnAt: minutes(-21), bookOffAt: null, timezone: 'Europe/London', welfareEvidenceCount: 1, missingBookOff: false, welfareSummary: null,
    welfare: {
      enabled: true, intervalMinutes: 30, status: 'missed', currentWindow: null, windows: [],
      lastWelfareAt: null, nextDueAt: minutes(5), overdueByMinutes: null,
      requiredCount: 1, completedCount: 0, missedCount: 1, consecutiveMissed: 1,
    },
    logBook: { required: false, intervalMinutes: null, currentWindow: null, currentWindowSubmitted: false, windows: [], requiredCount: 0, submittedCount: 0, missingCount: 0, lastEntryAt: minutes(-9) },
  }],
]);

function liveRows(shifts = SHIFTS, attention = SEVEN_ITEMS) {
  return model.buildLiveShiftRows(shifts, {
    attendanceByShiftId: ATTENDANCE, operationsByShiftId: OPERATIONS, attentionItems: attention, resolveZone: LONDON, now: NOW,
  });
}

function baseProps(overrides = {}) {
  const rows = liveRows();
  return {
    loading: false,
    now: NOW,
    freshness: {
      clock: model.formatDashboardClock(NOW, 'Europe/London'),
      zoneNote: null,
      updated: model.formatUpdatedLabel(NOW, 'Europe/London'),
      refreshing: false,
      lastLoadFailed: false,
      autoRefreshSeconds: 60,
    },
    kpis: { activeSites: 2, liveShifts: rows.length, coverageGaps: 1, openIncidents: 1, alerts: 4 },
    attention: model.summariseAttention(SEVEN_ITEMS),
    liveRows: rows,
    coverage: model.summariseCoverage(rows.length, [{ siteId: 8 }]),
    upcoming: model.buildUpcomingShifts(SHIFTS, { resolveZone: LONDON, now: NOW }),
    compliance: {
      canView: true,
      metrics: complianceModel.computeMetrics(complianceModel.buildComplianceRows([
        { guardId: 3, fullName: 'Fahad Test', complianceStatus: 'valid' },
        { guardId: 4, fullName: 'Alex', complianceStatus: 'expiring' },
        { guardId: 5, fullName: 'Sam', complianceStatus: 'expired' },
      ], [{ status: 'ACTIVE', guard: { id: 9, fullName: 'No Summary Yet' } }])),
    },
    sources: { attention: 'ready', live: 'ready', coverage: 'ready', upcoming: 'ready', compliance: 'ready' },
    onNavigate: () => {},
    onOpenCoverageGaps: () => {},
    onOpenAttentionItem: () => {},
    onViewAllAttention: () => {},
    onOpenLiveShift: () => {},
    ...overrides,
  };
}

let renderCount = 0;
function render(props) {
  const RNW = appRequire('react-native-web');
  const element = React.createElement(overview.CompanyDashboardOverview, props);
  const name = `DashboardV2_${renderCount += 1}`;
  RNW.AppRegistry.registerComponent(name, () => () => element);
  const app = RNW.AppRegistry.getApplication(name, {});
  return renderToStaticMarkup(app.element);
}

const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');
const count = (haystack, needle) => haystack.split(needle).length - 1;

/** Every element in the (unrendered) tree the component returns, so press handlers can be invoked directly. */
function elements(node, out = []) {
  if (Array.isArray(node)) { node.forEach((child) => elements(child, out)); return out; }
  if (!node || typeof node !== 'object' || !node.props) return out;
  out.push(node);
  elements(node.props.children, out);
  return out;
}
function tree(props) {
  return elements(overview.CompanyDashboardOverview(props));
}
const byLabel = (nodes, label) => nodes.find((node) => node.props && (node.props.label === label || node.props.accessibilityLabel === label));

// ═══════════════════ Fail-safe operational data ═══════════════════
//
// Production, October 2026: the backend's connection pool was exhausted and dashboard requests failed.
// Every list then stayed empty and every count read zero — a green "0 Alerts", "All Clear", "Coverage
// looks good" — exactly when S4 knew nothing. These checks render the shipped components with failed
// sources and require them to say "unavailable" instead, while keeping what IS known (an SOS stays an SOS).

const availability = loadTs('src/components/company/sourceAvailability.ts');
const workspace = loadTs('src/components/company/CompanyLiveOperationsWorkspace.tsx');
const timeline = loadTs('src/components/company/CompanyOperationsTimeline.tsx');
const WORKSPACE_SRC = fs.readFileSync(path.join(ROOT, 'src/components/company/CompanyLiveOperationsWorkspace.tsx'), 'utf8');

function renderElement(component, props) {
  const RNW = appRequire('react-native-web');
  const element = React.createElement(component, props);
  const name = `FailSafe_${renderCount += 1}`;
  RNW.AppRegistry.registerComponent(name, () => () => element);
  return renderToStaticMarkup(RNW.AppRegistry.getApplication(name, {}).element);
}

const ALL_FAILED = { activeSites: 'error', liveShifts: 'error', coverageGaps: 'error', openIncidents: 'error', alerts: 'error' };
const ALL_SOURCES_FAILED = { attention: 'error', live: 'error', coverage: 'error', upcoming: 'error', compliance: 'error' };
const NOTHING_LOADED = {
  kpis: { activeSites: 0, liveShifts: 0, coverageGaps: 0, openIncidents: 0, alerts: 0 },
  attention: model.summariseAttention([]),
  liveRows: [],
  coverage: model.summariseCoverage(0, []),
  upcoming: [],
  compliance: { canView: true, metrics: null },
};

test('FS-01-THE-MODEL-NEVER-TURNS-A-FAILED-SOURCE-INTO-ZERO', () => {
  const { safeCount, countText, countStatusWord, isKnownZero, sourceState } = availability;
  assert.deepEqual(safeCount(0, 'ready'), { kind: 'value', value: 0, stale: false });
  assert.equal(isKnownZero(safeCount(0, 'ready')), true, 'a loaded zero is a genuine zero');
  assert.deepEqual(safeCount(0, 'error'), { kind: 'unavailable' }, 'a failed zero is unavailable');
  assert.deepEqual(safeCount(3, 'error'), { kind: 'value', value: 3, stale: true }, 'a failed non-zero keeps its last value, marked stale');
  assert.deepEqual(safeCount(0, 'ready', true), { kind: 'loading' }, 'an empty first load is loading, not zero');
  assert.deepEqual(safeCount(2, 'ready', true), { kind: 'value', value: 2, stale: false });
  assert.equal(countText(safeCount(0, 'error')), '—');
  assert.equal(countStatusWord(safeCount(0, 'error')), 'Unavailable');
  assert.equal(countStatusWord(safeCount(3, 'error')), 'Not refreshed');
  assert.equal(countStatusWord(safeCount(3, 'ready')), null);
  assert.equal(sourceState(['alerts'], 'incidents'), 'ready');
  assert.equal(sourceState(['alerts'], 'incidents', 'alerts'), 'error');
});

test('FS-02-SUCCESSFUL-LOAD-SHOWS-GENUINE-FIGURES-AND-A-GENUINE-ALL-CLEAR', () => {
  const t = render(baseProps({
    ...NOTHING_LOADED,
    kpis: { activeSites: 2, liveShifts: 0, coverageGaps: 0, openIncidents: 0, alerts: 0 },
  }));
  assert.ok(t.includes('aria-label="Alerts: 0"'), 'a loaded zero is shown as zero, with no status word');
  assert.ok(t.includes('aria-label="Coverage Gaps: 0"'));
  assert.ok(text(t).includes('All Clear'), 'a genuine empty queue is All Clear');
  assert.ok(text(t).includes('Coverage looks good'), 'genuinely complete coverage is good');
});

test('FS-03-INITIAL-LOAD-FAILURE-SHOWS-UNAVAILABLE-NEVER-ZERO-OR-ALL-CLEAR', () => {
  const markup = render(baseProps({
    ...NOTHING_LOADED,
    freshness: { ...baseProps().freshness, updated: null, lastLoadFailed: true },
    sources: ALL_SOURCES_FAILED,
    kpiSources: ALL_FAILED,
  }));
  const t = text(markup);
  for (const label of ['Active Sites', 'Live Shifts', 'Coverage Gaps', 'Open Incidents', 'Alerts']) {
    assert.ok(markup.includes(`aria-label="${label}: —, Unavailable"`), `${label} is unavailable, not 0`);
    assert.ok(!markup.includes(`aria-label="${label}: 0`), `${label} never shows a zero`);
  }
  assert.ok(!t.includes('All Clear'), 'never All Clear without attention data');
  assert.ok(t.includes('Status unavailable') && t.includes('S4 cannot confirm that nothing needs action'));
  assert.ok(!t.includes('Coverage looks good'), 'never claims coverage is good without data');
  assert.ok(t.includes('Coverage unavailable') && t.includes('cannot confirm that every shift is covered'));
  assert.ok(t.includes('Last refresh failed') && t.includes('no data loaded yet'));
});

test('FS-04-PARTIAL-FAILURE-FLAGS-ONLY-THE-FAILED-FIGURE', () => {
  const markup = render(baseProps({
    kpis: { activeSites: 2, liveShifts: 2, coverageGaps: 1, openIncidents: 1, alerts: 0 },
    kpiSources: { alerts: 'error' },
  }));
  assert.ok(markup.includes('aria-label="Alerts: —, Unavailable"'), 'the failed source is unavailable');
  assert.ok(markup.includes('aria-label="Open Incidents: 1, Open"'), 'a loaded source is unaffected');
  assert.ok(markup.includes('aria-label="Coverage Gaps: 1, Needs cover"'));
  assert.ok(text(markup).includes('Attention Required'), 'the rest of the dashboard still works');
});

test('FS-05-REFRESH-FAILURE-AFTER-SUCCESS-KEEPS-AN-SOS-VISIBLE-AND-SAYS-IT-IS-NOT-REFRESHED', () => {
  const markup = render(baseProps({
    freshness: { ...baseProps().freshness, lastLoadFailed: true },
    kpis: { activeSites: 2, liveShifts: 2, coverageGaps: 1, openIncidents: 1, alerts: 2, incidentsCritical: true, alertsCritical: true },
    kpiSources: { alerts: 'error', openIncidents: 'error' },
    sources: { attention: 'error', live: 'ready', coverage: 'ready', upcoming: 'ready', compliance: 'ready' },
  }));
  const t = text(markup);
  assert.ok(markup.includes('aria-label="Alerts: 2, SOS active · not refreshed"'), 'the SOS is still shown, as critical, and as not current');
  assert.ok(markup.includes('aria-label="Open Incidents: 1, Critical · not refreshed"'));
  assert.ok(t.includes('Attention Required') && t.includes('Active panic alert'), 'the panic item stays in the queue');
  assert.ok(t.includes('Attention items could not be refreshed. Showing the last loaded data.'), 'and the queue says it is stale');
  assert.ok(t.includes('Last refresh failed'));
});

test('FS-06-A-STALE-ZERO-IS-NEVER-SHOWN-AS-A-GREEN-ZERO', () => {
  const markup = render(baseProps({
    ...NOTHING_LOADED,
    freshness: { ...baseProps().freshness, lastLoadFailed: true },
    kpiSources: { alerts: 'error', coverageGaps: 'error' },
    sources: { attention: 'error', live: 'ready', coverage: 'error', upcoming: 'ready', compliance: 'ready' },
  }));
  assert.ok(markup.includes('aria-label="Alerts: —, Unavailable"'));
  assert.ok(markup.includes('aria-label="Coverage Gaps: —, Unavailable"'));
  assert.ok(!text(markup).includes('All Clear') && !text(markup).includes('Coverage looks good'));
  // The tone helpers: a count that is good at zero is only good when S4 knows it is zero.
  assert.ok(/function zeroIsGoodTone\(count: SafeCount, positive: 'warning' \| 'attention'\)/.test(COMPONENT_SRC));
  assert.ok(/if \(isKnownZero\(count\)\) return 'good';/.test(COMPONENT_SRC));
});

test('FS-07-FIRST-LOAD-IN-PROGRESS-IS-LOADING-NOT-ZERO-OR-ALL-CLEAR', () => {
  const markup = render(baseProps({
    ...NOTHING_LOADED,
    loading: true,
    freshness: { ...baseProps().freshness, updated: null },
  }));
  const t = text(markup);
  assert.ok(markup.includes('aria-label="Alerts: …, Loading"'));
  assert.ok(!t.includes('All Clear') && t.includes('Checking'));
  assert.ok(!t.includes('Coverage looks good'));
});

test('FS-08-LIVE-OPS-QUEUE-IS-NEVER-CLEAR-WHEN-ITS-SOURCES-FAILED', () => {
  const railProps = (items, sourceStates) => ({
    items, metricFocus: 'all', urgentActionItemId: null, resolveShiftZone: LONDON,
    onOpenUrgentDetail() {}, onOpenUrgentShift() {}, onUrgentIncidentFollowUp: async () => {}, onUrgentAlertFollowUp: async () => {},
    onOpenIncidentResolution() {}, nextUp: [], sourceStates,
  });
  const clear = text(renderElement(workspace.LiveOpsAttentionRail, railProps([], {})));
  assert.ok(clear.includes('Queue clear'), 'loaded and empty: clear');
  const failed = text(renderElement(workspace.LiveOpsAttentionRail, railProps([], { alerts: 'error' })));
  assert.ok(!failed.includes('Queue clear') && failed.includes('Queue status unavailable'), 'failed and empty: unavailable');
  const stale = text(renderElement(workspace.LiveOpsAttentionRail, railProps([item('panic-1', 'panic', -2, { issueType: 'Active panic alert' })], { incidents: 'error' })));
  assert.ok(stale.includes('Active panic alert'), 'a known SOS is still shown');
  assert.ok(stale.includes('this queue may be incomplete'), 'and the queue says it may be incomplete');
});

test('FS-09-TODAY-SO-FAR-SHOWS-UNAVAILABLE-FIGURES-AS-UNAVAILABLE', () => {
  const todaySoFar = {
    shiftCount: 3,
    attendance: { bookedOn: 2, lateNotBookedOn: 0, bookedOff: 0 },
    welfare: { completed: 0, overdue: 0, missed: 0 },
    operations: { openIncidents: 0, siteRequests: 0, emergencyAlerts: 0 },
  };
  const props = (sourceStates) => ({
    todaySoFar, handovers: [], recentOperationalActivity: [], resolveShiftZone: LONDON,
    liveOperationEnrichedRows: [], onOpenCoverage() {}, sourceStates,
  });
  const loaded = text(renderElement(workspace.LiveOpsLowerPanels, props({})));
  assert.ok(!loaded.includes('unavailable') && !loaded.includes('—'), 'everything loaded: plain figures');
  const failed = text(renderElement(workspace.LiveOpsLowerPanels, props({ monitoring: 'error', alerts: 'error' })));
  assert.ok(/— Overdue · unavailable/.test(failed) && /— Missed · unavailable/.test(failed), 'welfare figures are unavailable, not 0');
  assert.ok(/— Emergency · unavailable/.test(failed), 'emergency alerts are unavailable, not 0');
  assert.ok(/2 Booked on/.test(failed), 'attendance, which loaded, is unaffected');
  assert.ok(/0 Open incidents/.test(failed), 'and a loaded zero is still a zero');
});

test('FS-10-AN-EMPTY-TIMELINE-WITH-FAILED-SHIFTS-IS-NOT-NOTHING-IN-PROGRESS', () => {
  const props = (unavailable) => ({
    inputs: [], nowMs: NOW.getTime(), headerTimeZone: 'Europe/London', anchorMs: NOW.getTime(),
    selectedShiftId: null, highlightedShiftId: null, onSelectShift() {}, onExportCsv() {}, onExportXlsx() {}, exporting: false, unavailable,
  });
  const empty = text(renderElement(timeline.CompanyOperationsTimeline, props(false)));
  assert.ok(empty.includes('No live or scheduled operations for this view.'));
  const failed = text(renderElement(timeline.CompanyOperationsTimeline, props(true)));
  assert.ok(failed.includes('Live operations could not be loaded.') && !failed.includes('No live or scheduled operations'));
  assert.ok(failed.includes('Book On, Book Off and alert actions still work'));
});

test('FS-11-THE-SCREEN-WIRES-EVERY-FIGURE-TO-ITS-OWN-SOURCE', () => {
  assert.ok(/activeSites: sourceState\('sites'\)/.test(SCREEN));
  assert.ok(/liveShifts: sourceState\('shifts', 'attendance'\)/.test(SCREEN));
  assert.ok(/coverageGaps: sourceState\('uncovered coverage'\)/.test(SCREEN));
  assert.ok(/openIncidents: sourceState\('incidents'\)/.test(SCREEN));
  assert.ok(/alerts: sourceState\('alerts'\)/.test(SCREEN));
  for (const [key, label] of [['shifts', 'shifts'], ['attendance', 'attendance'], ['monitoring', 'live operations monitoring'],
    ['coverage', 'uncovered coverage'], ['incidents', 'incidents'], ['alerts', 'alerts'], ['dailyLogs', 'daily logs']]) {
    assert.ok(SCREEN.includes(`${key}: sourceStateOf(failedSources, '${label}')`), `Live Operations ${key} source wired`);
  }
  // Live Operations: the status strip, the queue, Today So Far and the timeline all receive the states,
  // and a named banner lists what failed.
  assert.ok(/sources=\{sources\}/.test(WORKSPACE_SRC) && /sourceStates=\{sources\}/.test(WORKSPACE_SRC));
  assert.ok(/unavailable=\{shiftsUnavailable\}/.test(WORKSPACE_SRC));
  assert.ok(WORKSPACE_SRC.includes('Some live data could not be loaded'));
  // The status strip derives each figure from its own source.
  assert.ok(/const panic = safeCount\(activePanicAlertsCount, anyFailed\(sources, 'alerts'\)\)/.test(WORKSPACE_SRC));
  assert.ok(/const live = safeCount\(liveShiftsCount, anyFailed\(sources, 'shifts', 'attendance'\)\)/.test(WORKSPACE_SRC));
});

test('FS-12-ACTIONS-ARE-UNTOUCHED', () => {
  // The fail-safe change is presentation only: no API function is imported by either component.
  for (const src of [COMPONENT_SRC, WORKSPACE_SRC]) {
    assert.ok(!/from '\.\.\/\.\.\/services\/api'/.test(src), 'no API client in a presentation component');
  }
  assert.ok(/onLiveBoardPrimaryAction: \(shift: Shift\) => void;/.test(WORKSPACE_SRC), 'the Book On / Book Off action prop is unchanged');
  assert.ok(/onUrgentAlertFollowUp: \(item: UrgentOperationalItem, action: 'acknowledge' \| 'close'\) => Promise<void>;/.test(WORKSPACE_SRC));
});

if (process.exitCode) process.exit(process.exitCode);
console.log(JSON.stringify({ event: 'fail_safe_operations_certified', tests: passed }));
