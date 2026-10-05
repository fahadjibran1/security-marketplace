#!/usr/bin/env node
/**
 * Company Dashboard — Operations V2.
 *
 * The dashboard answers "what needs the operator's attention right now", then who is working, whether
 * shifts are covered, what is next and whether compliance needs action. These checks EXECUTE the pure
 * dashboard model and RENDER the shipped dashboard component with fixtures, exactly as the runtime spec
 * renders the screen: react-native resolves to react-native-web and native packages are inert. No API
 * function is reachable from either module, so nothing here can touch a network.
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

// ═══════════════════ KPI row ═══════════════════

test('KPI-01-THE-FIVE-OPERATIONAL-KPIS-RENDER-WITH-THEIR-FIXTURE-VALUES', () => {
  const markup = render(baseProps());
  const t = text(markup);
  for (const label of ['Active Sites', 'Live Shifts', 'Coverage Gaps', 'Open Incidents', 'Alerts']) {
    assert.ok(t.includes(label), `${label} is on the page`);
  }
  // A non-zero problem card is announced with its status word, so severity is never colour alone.
  for (const name of ['Active Sites: 2', 'Live Shifts: 2', 'Coverage Gaps: 1, Needs cover', 'Open Incidents: 1, Open', 'Alerts: 4, Outstanding']) {
    assert.ok(markup.includes(`aria-label="${name}"`), `the card is announced as "${name}"`);
  }
  assert.ok(!/Active Clients|Linked Guards|Pending Timesheets/.test(t), 'only the five operational KPIs are shown');
});

test('KPI-02-LIVE-SHIFTS-IS-THE-LIVE-OPERATIONS-POLICY-NOT-THE-STATUS-COLUMN', () => {
  const live = model.selectLiveShifts(SHIFTS, ATTENDANCE, NOW).map((shift) => shift.id).sort();
  assert.deepEqual(live, [19, 20], 'in progress, and accepted + started + booked on');
  assert.ok(!live.includes(21), 'an accepted shift next week is NOT live (the old dashboard counted it)');
  // Agreement with Live Operations: its own count is the in_progress inclusion reason.
  const viaPolicy = SHIFTS.filter((shift) => {
    const decision = policy.classifyLiveOperation(
      { id: shift.id, start: shift.start, end: shift.end, status: shift.status },
      { now: NOW, bookedOn: Boolean(ATTENDANCE.get(shift.id)?.checkInAt) },
    );
    return decision.include && decision.reason === 'in_progress';
  }).map((shift) => shift.id).sort();
  assert.deepEqual(live, viaPolicy);
  assert.ok(/liveShifts: dashboardLiveRows\.length/.test(SCREEN), 'the KPI and the Live Operations card read one set');
});

test('KPI-03-ALERTS-COUNTS-OUTSTANDING-ACTIONABLE-ALERTS-ONLY', () => {
  const alerts = [
    { id: 1, type: 'missed_checkcall', status: 'open', welfareWindowIndex: null },  // the shift-level summary
    { id: 2, type: 'missed_checkcall', status: 'open', welfareWindowIndex: 0 },     // per-window evidence
    { id: 3, type: 'missed_checkcall', status: 'open', welfareWindowIndex: 1 },     // per-window evidence
    { id: 4, type: 'panic', status: 'acknowledged' },
    { id: 5, type: 'site_request', status: 'closed' },
  ];
  const outstanding = alerts.filter((alert) => (alert.status || '').toLowerCase() !== 'closed');
  const actionable = outstanding.filter(policy.isActionableWelfareAlert);
  assert.deepEqual(actionable.map((alert) => alert.id), [1, 4], 'evidence rows and closed alerts are not alerts to act on');
  assert.ok(/outstandingAlerts\.filter\(isActionableWelfareAlert\)/.test(SCREEN), 'the screen applies the same rule');
  assert.ok(/alerts: actionableOutstandingAlerts\.length/.test(SCREEN), 'and the KPI reads it');
});

test('KPI-04-EVERY-KPI-IS-DEFINED-IN-ONE-PLACE', () => {
  for (const name of ['Active Sites', 'Live Shifts', 'Coverage Gaps', 'Open Incidents', 'Alerts']) {
    assert.ok(new RegExp(`- ${name}\\s+—`).test(MODEL_SRC), `${name} has a written definition`);
  }
});

// ═══════════════════ Attention Required ═══════════════════

test('ATT-01-AT-MOST-FIVE-ITEMS-ARE-SHOWN', () => {
  const summary = model.summariseAttention(SEVEN_ITEMS);
  assert.equal(summary.total, 7);
  assert.equal(summary.shown.length, 5);
  assert.equal(summary.hasMore, true);
  const rows = tree(baseProps()).filter((node) => node.key && SEVEN_ITEMS.some((entry) => entry.id === node.key));
  assert.equal(rows.length, 5, 'five attention rows');
});

test('ATT-02-VIEW-ALL-APPEARS-ONLY-WHEN-THERE-ARE-MORE-THAN-FIVE', () => {
  const t = text(render(baseProps()));
  assert.ok(t.includes('View all 7 items in Live Operations'), 'View all, with the true total');
  assert.ok(t.includes('7 items requiring action'), 'the header states the real count');

  const five = model.summariseAttention(SEVEN_ITEMS.slice(0, 5));
  const t5 = text(render(baseProps({ attention: five })));
  assert.ok(!t5.includes('View all'), 'no View all when everything is already shown');
  assert.equal(five.hasMore, false);
});

test('ATT-03-ORDER-PUTS-PANIC-FIRST-THEN-INCIDENTS-WELFARE-BOOK-ON-BOOK-OFF-COVERAGE-WARNINGS', () => {
  const order = model.prioritiseAttention(SEVEN_ITEMS).map((entry) => entry.id);
  assert.deepEqual(order, [
    'panic-4',         // active panic outranks an incident, however recent
    'incident-7',      // unresolved incident
    'checkcall-3',     // missed Welfare, longest outstanding first
    'checkcall-5',
    'attention-6',     // missing Book Off
    'uncovered-2',     // coverage gap
    'site-request-1',  // lower-priority warning
  ]);
  // The ordering is stable: shuffling the input does not change it.
  const shuffled = [...SEVEN_ITEMS].reverse();
  assert.deepEqual(model.prioritiseAttention(shuffled).map((entry) => entry.id), order);
});

test('PRI-01-THE-FULL-PRIORITY-LADDER-USES-RECORDED-INCIDENT-SEVERITY', () => {
  // One of each, all raised at the same moment so only the priority rule can order them. The ids sort
  // alphabetically in the OPPOSITE order to the expected result, so the id tie-break cannot produce it.
  const ladder = [
    { ...item('a-upcoming', 'upcoming_risk', -5) },
    { ...item('b-cover', 'uncovered_shift', -5) },
    { ...item('c-bookoff', 'missing_book_off', -5) },
    { ...item('d-late', 'late_start', -5) },
    { ...item('e-welfare', 'missed_check_call', -5) },
    { ...item('f-incident', 'incident', -5), severity: 'high' },
    { ...item('g-critical-incident', 'incident', -5), severity: 'critical' },
    { ...item('h-safety', 'safety', -5) },
    { ...item('i-panic', 'panic', -5) },
  ];
  assert.deepEqual(model.prioritiseAttention(ladder).map((entry) => entry.id), [
    'i-panic', 'h-safety', 'g-critical-incident', 'f-incident', 'e-welfare', 'd-late', 'c-bookoff', 'b-cover', 'a-upcoming',
  ]);
  assert.equal(model.isCriticalIncident({ category: 'incident', severity: 'CRITICAL' }), true);
  assert.equal(model.isCriticalIncident({ category: 'incident', severity: 'high' }), false);
  assert.equal(model.isCriticalIncident({ category: 'panic', severity: 'critical' }), false, 'severity only ranks incidents');
  assert.ok(/severity: incident\.severity,/.test(SCREEN), 'the screen carries the recorded severity onto the item');
});

test('SEV-01-KPI-SEVERITY-IS-NOT-UNIFORMLY-RED', () => {
  const quiet = render(baseProps({ kpis: { activeSites: 2, liveShifts: 2, coverageGaps: 3, openIncidents: 1, alerts: 4 } }));
  assert.ok(quiet.includes('aria-label="Coverage Gaps: 3, Needs cover"'), 'coverage is a warning, named as such');
  assert.ok(quiet.includes('aria-label="Open Incidents: 1, Open"'), 'a non-critical incident is not called critical');
  assert.ok(quiet.includes('aria-label="Alerts: 4, Outstanding"'), 'alerts without an SOS are outstanding, not critical');
  const loud = render(baseProps({ kpis: { activeSites: 2, liveShifts: 2, coverageGaps: 0, openIncidents: 1, alerts: 4, incidentsCritical: true, alertsCritical: true } }));
  assert.ok(loud.includes('aria-label="Open Incidents: 1, Critical"'));
  assert.ok(loud.includes('aria-label="Alerts: 4, SOS active"'));
  assert.ok(loud.includes('aria-label="Coverage Gaps: 0"'), 'a zero card carries no status word');
  assert.ok(/tone=\{kpis\.coverageGaps > 0 \? 'warning' : 'good'\}/.test(COMPONENT_SRC), 'coverage never uses the critical tone');
  assert.ok(/alertsCritical: activePanicAlerts\.length > 0/.test(SCREEN), 'SOS comes from the outstanding panic alerts');
  assert.ok(/incidentsCritical: openIncidents\.some\(\(incident\) => \(incident\.severity \|\| ''\)\.toLowerCase\(\) === 'critical'\)/.test(SCREEN));
});

test('DEN-01-COMPACT-DENSITY-IS-DESKTOP-ONLY', () => {
  assert.ok(/density=\{layoutWidth >= 1024 \? 'compact' : 'comfortable'\}/.test(SCREEN), 'compact from the laptop breakpoint only');
  const compact = render(baseProps({ density: 'compact' }));
  const comfortable = render(baseProps({ density: 'comfortable' }));
  assert.notEqual(compact, comfortable, 'the two densities really differ');
  assert.equal(text(compact), text(comfortable), 'and differ in layout only: the same information is shown');
  // Comfortable keeps a 44px touch target on every action link; compact never shrinks text below 11px.
  assert.ok(/minHeight: 44,/.test(COMPONENT_SRC));
  const compactBlock = COMPONENT_SRC.slice(COMPONENT_SRC.indexOf('const cs: Record<string, any> = StyleSheet.create({'));
  const sizes = [...compactBlock.matchAll(/fontSize: (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 0 && sizes.every((size) => size >= 11), `compact text sizes ${sizes}`);
});

test('ATT-04-A-ROW-SHOWS-ISSUE-SITE-GUARD-TIMING-AND-A-STATUS-WORD', () => {
  const t = text(render(baseProps()));
  assert.ok(t.includes('Missed Welfare Check'), 'the issue');
  assert.ok(t.includes('TEST SITE · Fahad Test'), 'site and Guard');
  assert.ok(t.includes('Raised 42 min ago'), 'how long it has been outstanding');
  assert.ok(t.includes('Scheduled end 18:00 · 55 min overdue'), 'a missing Book Off uses the backend overdue summary');
  assert.ok(t.includes('Critical'), 'severity is a word, not only a colour');
  assert.equal(model.attentionTiming(item('x', 'late_start', -12), NOW), '12 min late');
  assert.equal(model.attentionTiming(item('y', 'uncovered_shift', 75), NOW), 'Starts in 1h 15m');
});

test('ATT-05-AN-EMPTY-QUEUE-SAYS-ALL-CLEAR', () => {
  const t = text(render(baseProps({ attention: model.summariseAttention([]) })));
  assert.ok(t.includes('All Clear'));
  assert.ok(t.includes('Operational position is clear.'));
});

// ═══════════════════ More than ten items are never lost ═══════════════════

/** Fourteen distinct outstanding items, each on its own named site so every one can be found. */
const FOURTEEN = Array.from({ length: 14 }, (_, index) => item(
  `many-${index + 1}`, index % 2 ? 'missed_check_call' : 'safety', -(index + 1) * 3,
  { issueType: index % 2 ? 'Missed Welfare Check' : 'Safety / welfare needs attention', siteName: `CAPSITE ${String(index + 1).padStart(2, '0')}` },
));

function memoBody(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} exists`);
  return source.slice(start, source.indexOf('}, [', start));
}

test('CAP-01-ATTENTION-NOW-HAS-NO-TEN-ITEM-CAP', () => {
  const queue = memoBody(SCREEN, 'const urgentOperationalItems = React.useMemo');
  assert.ok(queue.includes('selectCurrentAttention('), 'still filtered by the shared expiry policy');
  assert.ok(!/\.slice\(/.test(queue), 'and never truncated');
  assert.ok(/const allAttentionItems = urgentOperationalItems;/.test(SCREEN),
    'the Dashboard and Attention Now read one queue, so their N cannot differ');
  const counts = memoBody(SCREEN, 'const liveOperationsCounts = React.useMemo');
  assert.ok(counts.includes('urgentOperationalItems.filter'), 'the Live Operations status bar counts that whole queue');
});

test('CAP-02-THE-ATTENTION-NOW-RAIL-RENDERS-ALL-FOURTEEN-ITEMS', () => {
  const RNW = appRequire('react-native-web');
  const workspace = loadTs('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  const outlook = loadTs('src/components/company/operationsOutlook.ts');
  const element = React.createElement(workspace.LiveOpsAttentionRail, {
    items: FOURTEEN,
    metricFocus: 'all',
    resolveShiftZone: () => 'Europe/London',
    urgentActionItemId: null,
    onOpenUrgentDetail: () => {},
    onOpenUrgentShift: () => {},
    onUrgentIncidentFollowUp: async () => {},
    onUrgentAlertFollowUp: async () => {},
    onOpenIncidentResolution: () => {},
    nextUp: outlook.buildNextUp([], NOW.getTime()),
  });
  RNW.AppRegistry.registerComponent('CapRail', () => () => element);
  const markup = renderToStaticMarkup(RNW.AppRegistry.getApplication('CapRail', {}).element);
  const t = text(markup);
  for (let index = 1; index <= 14; index += 1) {
    const site = `CAPSITE ${String(index).padStart(2, '0')}`;
    assert.ok(t.includes(site), `${site} is in Attention Now (items 11-14 were silently dropped before)`);
  }
  assert.ok(/Attention Now\s+14\b/.test(t), 'and the rail count reads 14');
});

test('CAP-03-DASHBOARD-TOTAL-AND-VIEW-ALL-MATCH-THE-FULL-QUEUE', () => {
  const summary = model.summariseAttention(FOURTEEN);
  assert.equal(summary.total, 14);
  assert.equal(summary.shown.length, 5);
  const t = text(render(baseProps({ attention: summary })));
  assert.ok(t.includes('14 items requiring action'));
  assert.ok(t.includes('View all 14 items in Live Operations'), 'the link promises exactly what the rail now shows');
});

// ═══════════════════ Live Operations ═══════════════════

test('LIVE-01-A-LIVE-ROW-CARRIES-THE-OPERATIONAL-FACTS-THE-DATA-SUPPORTS', () => {
  const rows = liveRows();
  const first = rows[0];
  assert.equal(first.shiftId, 19, 'the shift with open attention items comes first');
  assert.equal(first.siteName, 'TEST SITE');
  assert.equal(first.guardName, 'Fahad Test');
  assert.equal(first.timeRange, '18:35–19:35', 'site-local times');
  assert.equal(first.bookedOn, '18:34');
  assert.equal(first.welfare.label, 'MISSED', 'the Live Operations Welfare cell, unchanged');
  assert.equal(first.lastActivity, '18:46', 'the latest Book On / Welfare / Log Book time');
  assert.equal(first.attentionCount, 2);

  const t = text(render(baseProps()));
  for (const fragment of ['TEST SITE', 'Fahad Test · 18:35–19:35', 'Booked on', '18:34', 'MISSED', 'Last activity', 'Open Live Operations']) {
    assert.ok(t.includes(fragment), `the row shows "${fragment}"`);
  }
  const second = rows[1];
  assert.equal(second.welfare, null, 'no Welfare field is invented for a shift without a Welfare projection');
  assert.equal(second.bookedOn, '17:57', 'Book On falls back to the attendance record');
});

test('LIVE-02-NO-LIVE-SHIFTS-HAS-A-PURPOSEFUL-EMPTY-STATE', () => {
  const t = text(render(baseProps({ liveRows: [] })));
  assert.ok(t.includes('No live shifts right now'));
  assert.ok(t.includes('Open Live Operations'), 'the way into Live Operations stays');
});

test('LIVE-03-MANY-LIVE-SHIFTS-ARE-CAPPED-AND-COUNTED', () => {
  const many = Array.from({ length: 9 }, (_, index) => ({ ...liveRows()[0], shiftId: 100 + index }));
  const t = text(render(baseProps({ liveRows: many })));
  assert.ok(t.includes('3 more live shifts in Live Operations.'), 'rows beyond the cap are counted, not hidden');
  assert.equal(model.DASHBOARD_LIVE_ROWS_LIMIT, 6);
});

// ═══════════════════ Today's Coverage ═══════════════════

test('COV-01-COVERAGE-AGREES-WITH-THE-LIVE-SET-AND-THE-COVERAGE-ENDPOINT', () => {
  const coverage = model.summariseCoverage(2, [{ siteId: 8 }, { siteId: 8 }, { siteId: 7 }, { siteId: null }]);
  assert.deepEqual(coverage, { liveNow: 2, uncovered: 4, gapSites: 2 });
  assert.ok(/coverage=\{summariseCoverage\(dashboardLiveRows\.length, uncoveredShifts\)\}/.test(SCREEN),
    'Live now is the same set as the Live Shifts KPI; Uncovered is the coverage endpoint');
});

test('COV-02-GOOD-AND-GAP-STATES', () => {
  const good = text(render(baseProps({ coverage: { liveNow: 2, uncovered: 0, gapSites: 0 } })));
  assert.ok(good.includes('Coverage looks good'));
  assert.ok(!good.includes('Review coverage gaps'));
  const gap = text(render(baseProps()));
  assert.ok(gap.includes('1 uncovered shift needs cover'), 'the gap is stated, in plain English');
  assert.ok(gap.includes('Across 1 site.'));
  assert.ok(gap.includes('Review coverage gaps'), 'and it is actionable');
});

// ═══════════════════ Upcoming Shifts ═══════════════════

test('UP-01-UPCOMING-SHIFTS-ARE-GROUPED-TODAY-AND-TOMORROW-ON-THE-SITE-CLOCK', () => {
  const groups = model.buildUpcomingShifts(SHIFTS, { resolveZone: LONDON, now: NOW });
  assert.deepEqual(groups.map((group) => group.label), ['Today', 'Tomorrow', 'Monday, 12 October'],
    'Today, Tomorrow, then the site-local date');
  assert.equal(groups[0].rows[0].shiftId, 22);
  assert.equal(groups[0].rows[0].timeRange, '20:00–22:00');
  const ids = groups.flatMap((group) => group.rows.map((row) => row.shiftId));
  assert.ok(!ids.includes(24) && !ids.includes(19), 'nothing completed or already started');
  const t = text(render(baseProps()));
  assert.ok(t.includes('Today') && t.includes('Tomorrow'));
  assert.ok(t.includes('View shift schedule'));
});

test('UP-02-UNASSIGNED-SHIFTS-ARE-MARKED-AND-PRIORITISED', () => {
  const groups = model.buildUpcomingShifts(SHIFTS, { resolveZone: LONDON, now: NOW });
  const unassigned = groups.flatMap((group) => group.rows).find((row) => row.shiftId === 23);
  assert.equal(unassigned.unassigned, true);
  assert.equal(unassigned.guardName, null);
  assert.ok(text(render(baseProps())).includes('Unassigned'), 'UNASSIGNED is stated in words');

  // With room for one row, the unassigned shift inside 24 hours wins over an earlier assigned one.
  const one = model.buildUpcomingShifts(SHIFTS, { resolveZone: LONDON, now: NOW, limit: 1 });
  assert.equal(one[0].rows[0].shiftId, 23);
});

test('UP-03-NO-UPCOMING-SHIFTS-HAS-AN-EMPTY-STATE', () => {
  const t = text(render(baseProps({ upcoming: [] })));
  assert.ok(t.includes('No upcoming shifts'));
  assert.ok(t.includes('View shift schedule'));
});

// ═══════════════════ Compliance ═══════════════════

test('COMP-01-COMPLIANCE-SHOWS-THE-COMPLIANCE-SCREENS-OWN-METRICS', () => {
  const t = text(render(baseProps()));
  for (const label of ['Valid', 'Expiring', 'Needs attention', 'Unknown', 'View compliance']) {
    assert.ok(t.includes(label), `${label} is shown`);
  }
  const markup = render(baseProps());
  assert.ok(markup.includes('aria-label="Valid: 1 Guard"'));
  assert.ok(markup.includes('aria-label="Needs attention: 1 Guard"'), 'expired + invalid, as the Compliance screen counts it');
  assert.ok(markup.includes('aria-label="Unknown: 1 Guard"'), 'a linked Guard with no summary is never silently valid');
  assert.ok(/computeMetrics\(buildComplianceRows\(complianceSummaries, companyGuards\)\)/.test(SCREEN));
});

test('COMP-02-EMPTY-AND-NO-PERMISSION-STATES', () => {
  const empty = complianceModel.computeMetrics([]);
  assert.ok(text(render(baseProps({ compliance: { canView: true, metrics: empty } }))).includes('No compliance records'));
  const denied = text(render(baseProps({ compliance: { canView: false, metrics: null } })));
  assert.ok(denied.includes('Compliance not available'));
  assert.ok(!denied.includes('View compliance'), 'no link into a screen the role cannot open');
});

// ═══════════════════ Recent Activity ═══════════════════

test('RA-01-RECENT-ACTIVITY-IS-NOT-ON-THE-DASHBOARD-BUT-STILL-FEEDS-LIVE-OPERATIONS', () => {
  assert.ok(!text(render(baseProps())).includes('Recent Activity'));
  assert.ok(!/Recent Activity/.test(COMPONENT_SRC));
  const dashboardBlock = SCREEN.slice(SCREEN.indexOf('const renderDashboardSection'), SCREEN.indexOf('const renderClientsSection'));
  assert.ok(dashboardBlock.length > 0 && !/recentOperationalActivity|Recent Activity/.test(dashboardBlock));
  assert.ok(/recentOperationalActivity=\{recentOperationalActivity\}/.test(SCREEN), 'the data and its Live Operations use are untouched');
});

// ═══════════════════ Freshness ═══════════════════

test('FRESH-01-A-SUCCESSFUL-REFRESH-MOVES-THE-UPDATED-TIME', () => {
  const earlier = { section: 'dashboard', at: new Date('2026-10-05T17:50:00.000Z') };
  const next = model.nextSuccessfulLoad(earlier, 'dashboard', 0, NOW);
  assert.equal(next.at, NOW);
  assert.equal(model.formatUpdatedLabel(next.at, 'Europe/London'), 'Updated 18:55');
  const t = text(render(baseProps()));
  assert.ok(t.includes('Monday, 5 October · 18:55'), 'the clock, on the dashboard zone');
  assert.ok(t.includes('Updated 18:55 · refreshes every minute'), 'freshness reflects the real 60-second poll');
});

test('FRESH-02-A-FAILED-REFRESH-DOES-NOT-CLAIM-AN-UPDATE', () => {
  const earlier = { section: 'dashboard', at: new Date('2026-10-05T17:50:00.000Z') };
  assert.equal(model.nextSuccessfulLoad(earlier, 'dashboard', 1, NOW), earlier, 'a partial failure keeps the last good time');
  assert.equal(model.nextSuccessfulLoad(null, 'dashboard', 3, NOW), null);
  const t = text(render(baseProps({
    freshness: { ...baseProps().freshness, updated: 'Updated 18:50', lastLoadFailed: true },
  })));
  assert.ok(t.includes('Last refresh failed'), 'the failure is stated');
  assert.ok(t.includes('data from 18:50'), 'with the age of what is shown');
  assert.ok(!t.includes('Updated 18:55'), 'and no new time is claimed');
  assert.ok(/nextSuccessfulLoad\(previous, activeSection, failures\.length, new Date\(\)\)/.test(SCREEN), 'the screen uses this rule');
});

test('FRESH-03-NO-HARDCODED-DATES-AND-A-NAMED-ZONE-FOR-MULTI-ZONE-COMPANIES', () => {
  const code = (COMPONENT_SRC + MODEL_SRC).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/2026|October|Monday/.test(code), 'no literal date in the shipped code (comments excluded)');
  assert.deepEqual(model.dashboardDisplayZone([{ timezone: 'Europe/London' }, { timezone: null }]), { zone: 'Europe/London', mixed: false });
  assert.deepEqual(model.dashboardDisplayZone([{ timezone: 'Europe/London' }, { timezone: 'Europe/Dublin' }]), { zone: 'Europe/London', mixed: true });
  assert.ok(text(render(baseProps({ freshness: { ...baseProps().freshness, zoneNote: 'Europe/London' } }))).includes('(Europe/London)'));
});

// ═══════════════════ Partial failure ═══════════════════

test('ERR-01-ONE-FAILED-SOURCE-DOES-NOT-BLANK-THE-DASHBOARD', () => {
  const t = text(render(baseProps({
    liveRows: [],
    sources: { attention: 'ready', live: 'error', coverage: 'ready', upcoming: 'ready', compliance: 'ready' },
  })));
  assert.ok(t.includes('Live shifts could not be loaded'), 'the failed section says so');
  assert.ok(!t.includes('No live shifts right now'), 'and never presents a failure as an empty state');
  assert.ok(t.includes('Attention Required') && t.includes('Upcoming Shifts') && t.includes('Compliance Overview'),
    'every other section still renders');
  const stale = text(render(baseProps({ sources: { attention: 'error', live: 'ready', coverage: 'ready', upcoming: 'ready', compliance: 'ready' } })));
  assert.ok(stale.includes('Attention items could not be refreshed. Showing the last loaded data.'), 'stale data is labelled');
});

test('ERR-02-LOADING-STATES-EXIST-FOR-EVERY-LIST', () => {
  const t = text(render(baseProps({ loading: true })));
  for (const fragment of ['Loading attention items', 'Loading live shifts', 'Loading shifts', 'Loading compliance']) {
    assert.ok(t.includes(fragment), fragment);
  }
});

// ═══════════════════ Navigation ═══════════════════

test('NAV-01-EVERY-KPI-AND-ACTION-LEADS-INTO-ITS-EXISTING-SECTION', () => {
  const calls = [];
  const props = baseProps({
    onNavigate: (target) => calls.push(`nav:${target}`),
    onOpenCoverageGaps: () => calls.push('coverage-gaps'),
    onOpenAttentionItem: (entry) => calls.push(`attention:${entry.id}`),
    onViewAllAttention: () => calls.push('view-all'),
    onOpenLiveShift: (shiftId) => calls.push(`live:${shiftId}`),
  });
  const nodes = tree(props);
  const press = (label) => {
    const node = byLabel(nodes, label);
    assert.ok(node, `found "${label}"`);
    node.props.onPress();
  };
  press('Active Sites');
  press('Live Shifts');
  press('Coverage Gaps');
  press('Open Incidents');
  press('Alerts');
  press('View all 7 items in Live Operations');
  press('Open Live Operations');
  press('Review coverage gaps');
  press('View shift schedule');
  press('View compliance');
  nodes.find((node) => node.key === 'incident-7').props.onPress();
  nodes.find((node) => node.key === '19' && typeof node.props.onPress === 'function').props.onPress();
  assert.deepEqual(calls, [
    'nav:sites', 'nav:live-operations', 'coverage-gaps', 'nav:incidents', 'nav:alerts',
    'view-all', 'nav:live-operations', 'coverage-gaps', 'nav:rota-planner', 'nav:compliance',
    'attention:incident-7', 'live:19',
  ]);
  assert.ok(/onOpenAttentionItem=\{handleOpenUrgentDetail\}/.test(SCREEN), 'attention rows use the existing routing');
  assert.ok(/onViewAllAttention=\{\(\) => setActiveSection\('live-operations'\)\}/.test(SCREEN));
});

// ═══════════════════ Responsive / accessibility ═══════════════════

test('RESP-01-THE-LAYOUT-CANNOT-FORCE-A-HORIZONTAL-SCROLL-AT-390PX', () => {
  // 390px less the content padding leaves roughly 350px. No fixed width or minimum may exceed it, every row
  // wraps, and the two-column rows shrink to full width.
  const widths = [...COMPONENT_SRC.matchAll(/\b(?:width|minWidth|flexBasis)\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  const forcing = [...COMPONENT_SRC.matchAll(/\b(?:width|minWidth)\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(forcing.every((value) => value <= 175), `no fixed or minimum width forces overflow: ${forcing}`);
  assert.ok(widths.length > 0);
  for (const style of ['kpiStrip', 'row', 'facts', 'freshness']) {
    assert.ok(new RegExp(`${style}: \\{[^}]*flexWrap: 'wrap'`).test(COMPONENT_SRC), `${style} wraps`);
  }
  for (const style of ['rowMain', 'rowSide', 'rowHalf']) {
    assert.ok(new RegExp(`${style}: \\{[^}]*minWidth: 0, maxWidth: '100%'`).test(COMPONENT_SRC), `${style} can shrink to the viewport`);
  }
  // Long names are truncated on one line rather than widening the row.
  assert.ok(/numberOfLines=\{1\}>\{row\.siteName\}/.test(COMPONENT_SRC));
});

test('A11Y-01-HEADINGS-NAMES-AND-STATUS-WORDS', () => {
  const markup = render(baseProps());
  assert.ok((markup.match(/role="heading"/g) || []).length >= 5, 'every section title is a heading');
  assert.ok(markup.includes('aria-level="2"'));
  assert.ok(!/aria-label="[^"]*(📍|🟢|⚠️|🚨|🔔)/u.test(markup), 'no emoji in any accessible name');
  assert.ok(markup.includes('aria-hidden="true"'), 'decorative icons and arrows are hidden from assistive technology');
  assert.ok(/aria-label="Critical: Active panic alert/.test(markup), 'rows are announced with their status word');
  assert.ok(/aria-live="polite"/.test(markup), 'freshness changes are announced politely');
  assert.ok(/role="button"/.test(markup), 'interactive rows are buttons');
});

// ═══════════════════ Isolation / scope ═══════════════════

test('ISO-01-THE-DASHBOARD-READS-ONLY-EXISTING-COMPANY-SCOPED-SOURCES', () => {
  assert.ok(!/services\/api/.test(COMPONENT_SRC) && !/services\/api/.test(MODEL_SRC), 'neither new module can call an API');
  const start = SCREEN.indexOf('          dashboard: [');
  const block = SCREEN.slice(start, SCREEN.indexOf("          'live-operations': [", start));
  const runs = [...block.matchAll(/run: (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(runs, [
    'listCompanyAttendance', 'listCompanyTimesheets', 'listCompanyIncidents', 'listCompanySafetyAlerts',
    'listCompanyDailyLogs', 'listCompanyNotifications', 'listCompanyGuardComplianceStatuses',
  ], 'only existing company-scoped endpoints');
  assert.ok(/\.filter\(\(loader\) => loader\.label !== 'compliance' \|\| canViewCompliance\)/.test(SCREEN),
    'compliance is still requested only for a role that may view it');
  assert.ok(/label: 'compliance',\s*run: listCompanyGuardComplianceStatuses/.test(block),
    "and the dashboard's compliance loader carries the label that gate reads");
});

test('BRAND-01-NO-DEPRECATED-PRODUCT-NAMES-IN-THE-NEW-COPY', () => {
  assert.ok(!/S4 Security|S4 Guard\b|Security Marketplace|S4 Platform/.test(COMPONENT_SRC + MODEL_SRC));
});

console.log(`\n${passed} company dashboard V2 checks passed`);
