#!/usr/bin/env node
/**
 * Patrol Management — the company dashboard (Patrols P1-D).
 *
 * WHAT IS CERTIFIED
 *   - Navigation: the Patrol Management entry sits directly after Live Operations, only with patrols.view.
 *   - The permission matrix (Owner / Admin / Operations / Control Room / Viewer / Guard) for the page, the manage
 *     controls, photo evidence and holds — executed against the pure rules AND the REAL page (react-test-renderer on
 *     react-native-web) with the API stubbed.
 *   - The feature switch: a session without patrols.* (the server omits them while patrolsEnabled is off) shows no
 *     entry, no card and makes NO patrol request; a 404 PATROLS_NOT_ENABLED stops polling.
 *   - Company isolation: a company change drops every patrol state and re-reads for the new company; nothing of the
 *     old company is shown meanwhile. Site filters reach the API.
 *   - QR labels: drawn from the SERVER payload only (s4cp:1:…); the client never signs, a bad payload is refused, the
 *     printable sheet escapes text and carries only server labels.
 *   - Photo evidence: no link is requested without patrols.evidence (a Viewer sees no photo); a link is requested on
 *     demand, is never logged or persisted, and is dropped when it expires.
 *   - Live Operations: only actionable patrol alerts appear, every one links to its patrol record, acting needs
 *     alerts.manage, and the patrol resolution reasons (with "completed — late sync" only after late evidence) match
 *     the backend exactly.
 *   - Responsive breakpoints, loading / empty / error / pending-sync states, polling limits and cleanup, and that no
 *     figure is fabricated.
 *   - The release-gate wiring and the pinned QR dependency.
 */
const Module = require('node:module');
const originalLoad = Module._load;
const RNW = require('react-native-web');
const React = require('react');

function TestModal({ visible, children }) {
  return visible ? React.createElement('test-modal', null, children) : null;
}
const RN_SHIM = { ...RNW, Modal: TestModal, useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }) };
const STUB_PREFIXES = [
  'expo', '@expo/', '@react-navigation/', '@react-native-async-storage/', 'react-native-screens',
  'react-native-gesture-handler', 'react-native-reanimated', 'react-native-svg',
];
function inertModule() {
  const passthrough = (name) => {
    const Component = ({ children }) => React.createElement(React.Fragment, null, children);
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
  if (request === 'react-native') return RN_SHIM;
  if (request === 'react-native-safe-area-context') {
    return {
      useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
      SafeAreaView: ({ children }) => React.createElement(React.Fragment, null, children),
      SafeAreaProvider: ({ children }) => React.createElement(React.Fragment, null, children),
    };
  }
  if (STUB_PREFIXES.some((prefix) => request === prefix || request.startsWith(prefix))) return inertModule();
  return originalLoad.call(this, request, ...rest);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Browser storage that records every write: no patrol link may ever be written to it.
const storageWrites = [];
const fakeStorage = { getItem: () => null, setItem: (k, v) => storageWrites.push([k, v]), removeItem() {}, clear() {} };
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { activeElement: null, getElementById: () => null, querySelector: () => null, body: null };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener() {}, removeEventListener() {}, scrollTo() {}, location: { href: '', search: '', hash: '' } };
}
// react-native-web's Image asks the browser to load the source; here it never loads (no network in this spec).
globalThis.window.Image = class { set src(_v) {} };
globalThis.window.localStorage = fakeStorage;
globalThis.window.sessionStorage = fakeStorage;
globalThis.localStorage = fakeStorage;
globalThis.sessionStorage = fakeStorage;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TestRenderer = require('react-test-renderer');
const ts = require('typescript');
const { ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
const h = React.createElement;

const cache = new Map();
function loadSource(rel) {
  const load = (abs) => {
    if (cache.has(abs)) return cache.get(abs).exports;
    const out = ts.transpileModule(fs.readFileSync(abs, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const mod = { exports: {} };
    cache.set(abs, mod);
    const req = (request) => {
      if (request.startsWith('.')) {
        const base = path.resolve(path.dirname(abs), request);
        for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) {
            if (c.endsWith('.json')) return require(c);
            return load(c);
          }
        }
      }
      return require(request);
    };
    new Function('module', 'exports', 'require', out)(mod, mod.exports, req);
    return mod.exports;
  };
  return load(path.join(ROOT, rel));
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^[ \t]*\/\/.*$/gm, '');

// ─── console capture: nothing patrol may log a link ──────────────────────────────────────────────────────────────

const logged = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' '));
    if (level === 'log' && typeof args[0] === 'string' && /^(PASS|FAIL) |checks passed/.test(args[0])) original(...args);
    if (level === 'error' && typeof args[0] === 'string' && /^FAIL|^ {6}/.test(args[0])) original(...args);
  };
}

// ─── the stubbed API: every patrol call is recorded; answers come from `answers` ─────────────────────────────────

const api = loadSource('src/services/api.ts');
const calls = [];
let answers = {};
for (const key of Object.keys(api)) {
  if (typeof api[key] !== 'function' || /^[A-Z]/.test(key)) continue;
  api[key] = async (...args) => {
    calls.push([key, args]);
    const answer = answers[key];
    if (typeof answer === 'function') return answer(...args);
    if (answer !== undefined) return answer;
    return [];
  };
}
globalThis.fetch = async () => { throw new Error('no network in this spec'); };
const patrolCalls = () => calls.filter(([k]) => /Patrol/.test(k));

const settle = async (n = 6) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const textOf = (node) => {
  const words = [];
  const walk = (n) => { if (typeof n === 'string') { words.push(n); return; } if (n && n.children) n.children.forEach(walk); };
  walk(node);
  return words.join('');
};
const pressables = (root, text) => root.findAll((n) => n.props && typeof n.props.onPress === 'function' && (textOf(n).trim() === text || n.props.accessibilityLabel === text));
const pressByText = async (root, text) => {
  const nodes = pressables(root, text);
  assert.ok(nodes.length > 0, `a "${text}" control`);
  await act(async () => { await nodes[0].props.onPress({ stopPropagation() {} }); });
  await settle();
};
const has = (root, text) => pressables(root, text).length > 0;

const access = loadSource('src/components/patrols/patrolAccess.ts');
const P = loadSource('src/components/patrols/patrolPresentation.ts');
const QR = loadSource('src/components/patrols/patrolQr.ts');
const R = loadSource('src/components/company/alertResolution.ts');
const { CompanyPatrolsWorkspace } = loadSource('src/components/patrols/CompanyPatrolsWorkspace.tsx');
const { PatrolsSummaryCard } = loadSource('src/components/patrols/PatrolsSummaryCard.tsx');
const { LiveOpsAttentionRail } = loadSource('src/components/company/CompanyLiveOperationsWorkspace.tsx');

// ─── fixtures (fictional) ─────────────────────────────────────────────────────────────────────────────────────

const ALL_PATROL = ['patrols.view', 'patrols.manage', 'patrols.evidence', 'patrols.holds'];
/** The session lists the server hands each role while the switch is ON (company-membership-types.ts). */
const ROLE_SESSIONS = {
  owner: [...ALL_PATROL, 'alerts.manage', 'company.manage'],
  admin: [...ALL_PATROL, 'alerts.manage', 'staff.manage'],
  operations: ['patrols.view', 'patrols.manage', 'patrols.evidence', 'alerts.manage', 'shifts.manage'],
  control_room: ['patrols.view', 'patrols.evidence', 'alerts.manage', 'shifts.reconcile'],
  viewer: ['patrols.view', 'shifts.view'],
  guard: [],
};
const perms = (role) => access.resolvePatrolPermissions(ROLE_SESSIONS[role], role === 'guard' ? 'guard' : 'company_staff');

const MIN = 60_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const LABEL_PAYLOAD = `s4cp:1:k1:${'0123456789abcdef'.repeat(2)}:3:${'Ab_-'.repeat(10)}xyz`;
const SIGNED_URL = 'https://evidence.example.invalid/patrol/obj-1?X-Amz-Signature=deadbeefcafe';

function policies(siteName = 'Alpha Site', siteId = 10) {
  const policy = {
    methods: ['qr'], photosPerRun: 0, photosPerCheckpoint: 0, orderMode: 'any', startGraceMinutes: 15, maxPatrolDurationMinutes: 45,
    completionGraceMinutes: 30, syncGraceMinutes: 60, requirementScope: 'site', retentionDays: 30, incompleteNeedsAction: true,
    postShiftSyncHours: 24, clockDriftThresholdMinutes: 5, allowUnscheduledPatrols: true, escalateUnverified: false,
    qrRequireProximity: false, proximityMeters: null,
  };
  return {
    defaults: policy, companyDefault: { ...policy, source: 'default' },
    sites: [{ siteId, siteName, timezone: 'Europe/London', policy: { ...policy, source: 'default' } }],
    locationVerificationAvailable: false, extendedRetentionAllowed: true,
  };
}
function run(over = {}) {
  return {
    id: 5, clientRunId: 'run-abcdefgh', siteId: 10, shiftId: 71, guardId: 11, scheduleId: 1, routeId: 3, windowKey: 'w1',
    windowStart: iso(NOW - 20 * MIN), windowEnd: iso(NOW + 40 * MIN), status: 'in_progress', verificationStatus: 'pending',
    startedAtDevice: iso(NOW - 10 * MIN), startedAtServer: iso(NOW - 10 * MIN + 2000), completedAtDevice: null, completedAtServer: null,
    clockOffsetMs: null, exceptionReason: null, syncedLate: false, lateStart: true, provisional: false, needsReview: false,
    syncFlags: [], clockDriftMs: 125_000, verifiedAt: null, verificationFinalAt: null, siteName: 'Alpha Site', guardName: 'Ava Guard',
    visitCount: 3, flaggedVisitCount: 1, checkpointsVisited: 2, checkpointsTotal: 4, ...over,
  };
}
const ROUTE = { id: 3, siteId: 10, name: 'Perimeter', orderMode: 'any', active: true, archivedAt: null, createdAt: null, updatedAt: null,
  checkpoints: [1, 2, 3, 4].map((n) => ({ position: n, required: true, checkpointId: n, publicId: 'x'.repeat(32), label: `Gate ${n}`, active: true, revoked: false })) };
function evidence(over = {}) {
  return {
    id: 900, clientEvidenceId: 'ev-abcdefgh', runId: 5, visitId: null, kind: 'run_photo', source: 'camera', mimeType: 'image/jpeg', sizeBytes: 204800,
    widthPx: 1200, heightPx: 900, sha256Client: 'a'.repeat(64), sha256Stored: 'a'.repeat(64), capturedAtDevice: iso(NOW - 5 * MIN),
    receivedAt: iso(NOW - 4 * MIN), verifiedAt: iso(NOW - 4 * MIN), uploadStatus: 'verified', retentionDays: 30, expiresAt: iso(NOW + 30 * 86_400_000),
    retentionStatus: 'active', declaredSizeBytes: 204800, detectedMimeType: 'image/jpeg', rejectionReason: null, syncFlags: [], needsReview: false,
    deletionReason: null, quarantinedAt: null, purgeAfter: null, purgedAt: null, restoredAt: null, objectDeletedAt: null, ...over,
  };
}
function baseAnswers(over = {}) {
  return {
    getPatrolPolicies: policies(),
    listPatrolRoutes: [ROUTE],
    listPatrolHolds: [],
    getPatrolOverview: { date: TODAY, dateBasis: 'utc', siteId: null, runsStarted: 4, runsByStatus: { in_progress: 1, completed: 2, incomplete: 1, closed_by_system: 0 },
      inProgressNow: 1, flaggedScans: 1, openExceptions: 2, activeCheckpoints: 4, activeSchedules: 1, activeRoutes: 1 },
    listPatrolExceptions: [],
    listPatrolRuns: { items: [run()], total: 1, page: 1, pageSize: 25 },
    listPatrolSchedules: [],
    listPatrolCheckpoints: [],
    listPatrolExports: [],
    getPatrolRun: { run: run(), visits: [], exceptions: [], evidenceCount: 1, evidenceRestricted: false, evidence: [evidence()] },
    ...over,
  };
}

async function mount(props) {
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(CompanyPatrolsWorkspace, { companyKey: 'co-1', layoutWidth: 1440, ...props })); });
  await settle();
  return renderer;
}

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

// ═══ navigation and permissions ═══

test('PM-01-THE-ENTRY-SITS-DIRECTLY-AFTER-LIVE-OPERATIONS', () => {
  const primary = ['dashboard', 'live-operations'];
  assert.deepEqual(access.withPatrolNavEntry(primary, 'patrols', 'live-operations', perms('viewer')), ['dashboard', 'live-operations', 'patrols']);
  assert.deepEqual(access.withPatrolNavEntry(['dashboard', 'live-operations', 'sites'], 'patrols', 'live-operations', perms('owner')), ['dashboard', 'live-operations', 'patrols', 'sites']);
  assert.deepEqual(access.withPatrolNavEntry(primary, 'patrols', 'live-operations', perms('guard')), primary, 'no entry without patrols.view');
  assert.deepEqual(access.withPatrolNavEntry([...primary, 'patrols'], 'patrols', 'live-operations', access.NO_PATROL_PERMISSIONS), primary);
  const screen = stripComments(read('src/screens/CompanyDashboardScreen.tsx'));
  const items = screen.slice(screen.indexOf('const NAV_ITEMS: NavItem[] = ['));
  const ids = [...items.slice(0, items.indexOf('];')).matchAll(/\{ id: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.equal(ids[ids.indexOf('live-operations') + 1], 'patrols', 'NAV_ITEMS: Patrol Management after Live Operations');
  assert.ok(/withPatrolNavEntry<CompanySection>\([\s\S]*?'patrols',\s*'live-operations',\s*group\.id === 'primary' \? patrolPermissions/.test(screen), 'in the primary group only');
  assert.ok(screen.includes("label: 'Patrol Management'"));
});

test('PM-02-THE-PERMISSION-MATRIX', () => {
  const expect = {
    owner: { canView: true, canManage: true, canViewEvidence: true, canManageHolds: true, canActOnAlerts: true },
    admin: { canView: true, canManage: true, canViewEvidence: true, canManageHolds: true, canActOnAlerts: true },
    operations: { canView: true, canManage: true, canViewEvidence: true, canManageHolds: false, canActOnAlerts: true },
    control_room: { canView: true, canManage: false, canViewEvidence: true, canManageHolds: false, canActOnAlerts: true },
    viewer: { canView: true, canManage: false, canViewEvidence: false, canManageHolds: false, canActOnAlerts: false },
    guard: { canView: false, canManage: false, canViewEvidence: false, canManageHolds: false, canActOnAlerts: false },
  };
  for (const [role, want] of Object.entries(expect)) assert.deepEqual({ ...perms(role) }, want, role);
  assert.deepEqual(access.visiblePatrolTabs(perms('viewer')), ['overview', 'live', 'schedules', 'checkpoints', 'history', 'retention', 'settings'], 'a Viewer: no evidence, no storage');
  assert.ok(!access.visiblePatrolTabs(perms('operations')).includes('storage'));
  assert.ok(access.visiblePatrolTabs(perms('control_room')).includes('evidence'));
  assert.equal(access.visiblePatrolTabs(perms('owner')).length, 9);
  assert.deepEqual(access.visiblePatrolTabs(perms('guard')), []);
  assert.equal(access.resolvePatrolTab('evidence', perms('viewer')), 'overview', 'a disallowed tab falls back');
  // The backend matrix this mirrors.
  const backend = read('../security-backend-nest/src/company-membership/company-membership-types.ts');
  assert.ok(backend.includes('patrols.manage    Owner, Admin, Operations'));
  assert.ok(backend.includes('patrols.evidence  Owner, Admin, Operations, Control Room'));
  assert.ok(backend.includes('patrols.holds     Owner, Admin'));
});

test('PM-03-THE-REAL-PAGE-FOLLOWS-THE-MATRIX', async () => {
  for (const role of ['owner', 'operations', 'control_room', 'viewer']) {
    answers = baseAnswers();
    calls.length = 0;
    const p = perms(role);
    const renderer = await mount({ permissions: p });
    const root = renderer.root;
    assert.equal(has(root, 'Photographic Evidence'), p.canViewEvidence, `${role}: evidence tab`);
    assert.equal(has(root, 'Storage usage'), p.canManageHolds, `${role}: storage tab`);
    assert.equal(calls.some(([k]) => k === 'listPatrolHolds'), p.canManageHolds, `${role}: holds read only with patrols.holds`);
    await pressByText(root, 'Schedules');
    assert.equal(has(root, 'New schedule'), p.canManage, `${role}: schedule editing`);
    await pressByText(root, 'Checkpoints & Routes');
    assert.equal(has(root, 'New checkpoint'), p.canManage, `${role}: checkpoint editing and labels`);
    await pressByText(root, 'Downloads, retention & holds');
    assert.equal(has(root, 'Place hold'), p.canManageHolds, `${role}: holds`);
    assert.equal(has(root, 'Request export'), p.canManageHolds, `${role}: exports`);
    assert.ok(textOf(root).includes('Company default'), `${role}: everyone reads the retention period`);
    await pressByText(root, 'Site settings');
    assert.equal(has(root, 'Save settings'), p.canManage, `${role}: site settings editing`);
    assert.equal(calls.some(([k]) => k === 'getPatrolEvidenceLink'), false, 'no photo link without a press');
    act(() => renderer.unmount());
  }
});

test('PM-04-FEATURE-SWITCH-OFF-NO-ENTRY-NO-CARD-NO-REQUEST', async () => {
  // The server omits patrols.* from the session while patrolsEnabled is off — and a legacy session has no list at all.
  for (const session of [['shifts.view', 'alerts.manage'], undefined]) {
    const p = access.resolvePatrolPermissions(session, 'company');
    assert.equal(p.canView, false, 'no legacy-role fallback for patrols');
    calls.length = 0;
    let card;
    await act(async () => { card = TestRenderer.create(h(PatrolsSummaryCard, { companyKey: 'co-1', permissions: p, onOpen() {} })); });
    await settle();
    assert.equal(card.toJSON(), null, 'no card');
    const page = await mount({ permissions: p });
    assert.ok(textOf(page.root).includes('Patrol Management is not available'));
    assert.deepEqual(patrolCalls(), [], 'not a single patrol request');
    act(() => { card.unmount(); page.unmount(); });
  }
  // The server says the switch is off (session older than the change): the page says so and stops asking.
  answers = baseAnswers({ getPatrolPolicies: () => { const e = new api.ApiError(404, 'Not Found', { code: 'PATROLS_NOT_ENABLED', message: 'x' }); throw e; } });
  const page = await mount({ permissions: perms('owner') });
  assert.ok(textOf(page.root).includes('Patrol Management is not enabled'));
  assert.equal(access.classifyPatrolFailure(new api.ApiError(404, 'Not Found', { code: 'PATROLS_NOT_ENABLED' })), 'not_enabled');
  assert.equal(P.shouldPollPatrols({ enabled: true, hidden: false, failure: 'not_enabled' }), false);
  assert.equal(P.shouldPollPatrols({ enabled: true, hidden: false, failure: 'forbidden' }), false);
  act(() => page.unmount());
  // The dashboard leaves the page and hides the card when the permission goes.
  const screen = stripComments(read('src/screens/CompanyDashboardScreen.tsx'));
  assert.ok(screen.includes("setActiveSection((current) => (current === 'patrols' ? 'dashboard' : current));"));
  assert.ok(/patrolPermissions\.canView \? \(\s*<PatrolsSummaryCard/.test(screen));
  assert.ok(/case 'patrols':[\s\S]{0,200}patrolPermissions\.canView \? \(\s*<CompanyPatrolsWorkspace\s+key=\{patrolCompanyKey\}/.test(screen), 'keyed on the company');
});

test('PM-05-A-COMPANY-CHANGE-DROPS-EVERYTHING', async () => {
  answers = baseAnswers();
  calls.length = 0;
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(CompanyPatrolsWorkspace, { companyKey: 'co-A', layoutWidth: 1440, permissions: perms('owner') })); });
  await settle();
  await pressByText(renderer.root, 'Live Patrols');
  await pressByText(renderer.root, 'Open patrol 5');
  assert.ok(textOf(renderer.root).includes('Patrol #5'), 'run detail open for company A');
  assert.ok(textOf(renderer.root).includes('Alpha Site'));
  let releaseB;
  answers = baseAnswers({
    getPatrolPolicies: () => new Promise((resolve) => { releaseB = () => resolve(policies('Bravo Site', 20)); }),
    listPatrolRuns: { items: [], total: 0, page: 1, pageSize: 25 },
    getPatrolOverview: () => new Promise(() => {}),
  });
  const before = calls.length;
  await act(async () => { renderer.update(h(CompanyPatrolsWorkspace, { companyKey: 'co-B', layoutWidth: 1440, permissions: perms('owner') })); });
  await settle();
  const text = textOf(renderer.root);
  assert.ok(!text.includes('Alpha Site'), 'nothing of company A is shown while B loads');
  assert.ok(!text.includes('Patrol #5'), 'the open run detail is closed');
  assert.ok(calls.slice(before).some(([k]) => k === 'getPatrolPolicies'), 'B is read afresh');
  await act(async () => { releaseB(); });
  await settle();
  assert.ok(textOf(renderer.root).includes('Bravo Site'));
  act(() => renderer.unmount());
});

test('PM-06-SITE-FILTERS-REACH-THE-API-AND-SITES-COME-FROM-THE-COMPANY', async () => {
  answers = baseAnswers();
  calls.length = 0;
  const renderer = await mount({ permissions: perms('operations') });
  await pressByText(renderer.root, 'Site: Alpha Site');
  await pressByText(renderer.root, 'History');
  const runsCall = calls.filter(([k]) => k === 'listPatrolRuns').pop();
  assert.equal(runsCall[1][0].siteId, 10, 'History is filtered by the chosen site');
  assert.equal(runsCall[1][0].pageSize, 25, 'paginated');
  assert.ok(textOf(renderer.root).includes('Site time: Europe/London'));
  act(() => renderer.unmount());
  // The page's only site list is the server's company-scoped one (GET /patrols/policies).
  const shell = stripComments(read('src/components/patrols/CompanyPatrolsWorkspace.tsx'));
  assert.ok(shell.includes('const sites = policies.data?.sites ?? [];'));
});

// ═══ QR labels ═══

test('PM-07-QR-FROM-THE-SERVER-PAYLOAD-ONLY', () => {
  assert.equal(QR.isServerLabelPayload(LABEL_PAYLOAD), true);
  for (const bad of ['', 'hello', 's4cp:2:k1:x:1:y', `s4cp:1:k1:${'G'.repeat(32)}:1:${'A'.repeat(43)}`, `javascript:alert(1)`, null, 42]) {
    assert.equal(QR.isServerLabelPayload(bad), false, String(bad));
    assert.equal(typeof bad === 'string' ? QR.qrMatrix(bad) : null, null);
  }
  const m = QR.qrMatrix(LABEL_PAYLOAD);
  assert.ok(m && m.length >= 21 && m.every((row) => row.length === m.length), 'a square QR matrix');
  assert.equal((m.length - 17) % 4, 0, 'a valid QR version size');
  // The three finder patterns: a dark 7×7 ring at three corners.
  for (const [r, c] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]]) {
    for (let i = 0; i < 7; i += 1) {
      assert.ok(m[r][c + i] && m[r + 6][c + i] && m[r + i][c] && m[r + i][c + 6], `finder at ${r},${c}`);
    }
    assert.ok(!m[r + 1][c + 1] && m[r + 3][c + 3], 'with its light ring and dark centre');
  }
  const html = QR.renderLabelSheetHtml([
    { label: 'Gate <1>', siteName: 'Alpha & Co', payload: LABEL_PAYLOAD, tokenVersion: 3, checkpointId: 1 },
    { label: 'Forged', siteName: 'X', payload: 's4cp:1:made-up', tokenVersion: 1, checkpointId: 2 },
  ], { companyName: 'Acme Security', generatedAt: '29/10/2026 10:00' });
  assert.ok(html.includes('Gate &lt;1&gt;') && html.includes('Alpha &amp; Co'), 'text is escaped');
  assert.equal((html.match(/<svg /g) || []).length, 1, 'only the server label is printed');
  assert.ok(!html.includes('Forged'), 'a label without a server payload is left out, never "fixed"');
  assert.ok(!html.includes(LABEL_PAYLOAD), 'the payload is in the QR, not printed as text');
  assert.ok(html.includes('@page') && html.includes('print-color-adjust: exact'), 'print CSS');
  // The client never signs: no HMAC, no key, no crypto, and the label comes from the server endpoint.
  const dir = path.join(ROOT, 'src/components/patrols');
  for (const file of fs.readdirSync(dir)) {
    const src = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.doesNotMatch(src, /createHmac|crypto\.|subtle\.|SIGNING_KEY|signCheckpointLabel/, `${file} never signs`);
  }
  assert.ok(read('src/services/api.ts').includes('`/patrols/checkpoints/${id}/label`'));
  const tab = stripComments(read('src/components/patrols/PatrolCheckpointsTab.tsx'));
  assert.ok(tab.includes('const label = await getPatrolCheckpointLabel(cp.id);'));
  assert.ok(tab.includes('printIncidentReport(html)'), 'printed through the existing same-origin print window');
});

test('PM-08-THE-REAL-PAGE-RENDERS-THE-SERVER-LABEL', async () => {
  answers = baseAnswers({
    listPatrolCheckpoints: [{ id: 1, siteId: 10, publicId: '0123456789abcdef'.repeat(2), label: 'Gate 1', description: null, tokenVersion: 3, photoRequired: false, active: true, rotatedAt: null, revokedAt: null, createdAt: null, updatedAt: null }],
    getPatrolCheckpointLabel: { checkpointId: 1, siteId: 10, publicId: '0123456789abcdef'.repeat(2), label: 'Gate 1', tokenVersion: 3, keyId: 'k1', payload: LABEL_PAYLOAD },
  });
  calls.length = 0;
  const renderer = await mount({ permissions: perms('operations') });
  await pressByText(renderer.root, 'Checkpoints & Routes');
  assert.equal(renderer.root.findAll((n) => n.props && n.props.testID === 'patrol-qr').length, 0, 'no QR before the server issues one');
  await pressByText(renderer.root, 'Generate label');
  assert.deepEqual(calls.filter(([k]) => k === 'getPatrolCheckpointLabel').map(([, a]) => a), [[1]]);
  assert.ok(renderer.root.findAll((n) => n.props && n.props.testID === 'patrol-qr').length >= 1, 'the QR is drawn from the payload');
  assert.ok(has(renderer.root, 'Print labels (1)'));
  act(() => renderer.unmount());
});

// ═══ evidence ═══

test('PM-09-NO-PHOTO-LINK-WITHOUT-PATROLS-EVIDENCE', async () => {
  answers = baseAnswers({ getPatrolRun: { run: run(), visits: [], exceptions: [], evidenceCount: 2, evidenceRestricted: true, evidence: null } });
  calls.length = 0;
  const renderer = await mount({ permissions: perms('viewer') });
  await pressByText(renderer.root, 'Live Patrols');
  await pressByText(renderer.root, 'Open patrol 5');
  const text = textOf(renderer.root);
  assert.ok(text.includes('Photos are only shown to roles with patrol evidence access'));
  assert.ok(!has(renderer.root, 'View photo'), 'a Viewer has no photo control');
  assert.ok(!calls.some(([k]) => k === 'getPatrolEvidenceLink' || k === 'listPatrolRunEvidence'), 'and no photo request at all');
  act(() => renderer.unmount());
});

test('PM-10-A-PHOTO-LINK-IS-FETCHED-ON-DEMAND-NEVER-LOGGED-OR-KEPT', async () => {
  answers = baseAnswers({ getPatrolEvidenceLink: () => ({ evidenceId: 900, method: 'GET', url: SIGNED_URL, expiresAt: iso(Date.now() + 6_200) }) });
  calls.length = 0;
  logged.length = 0;
  storageWrites.length = 0;
  const renderer = await mount({ permissions: perms('control_room') });
  await pressByText(renderer.root, 'Live Patrols');
  await pressByText(renderer.root, 'Open patrol 5');
  assert.ok(!calls.some(([k]) => k === 'getPatrolEvidenceLink'), 'no link until asked');
  assert.ok(textOf(renderer.root).includes('Verified'), 'verification status shown');
  assert.ok(textOf(renderer.root).includes('Retention: until'), 'retention expiry shown');
  await pressByText(renderer.root, 'Why are you viewing these photos?: Investigation');
  await pressByText(renderer.root, 'View photo');
  assert.deepEqual(calls.filter(([k]) => k === 'getPatrolEvidenceLink').map(([, a]) => a), [[900, 'investigation']], 'one audited request, with its purpose');
  const image = renderer.root.findAll((n) => n.props && n.props.accessibilityLabel === 'Patrol photo 900' && n.props.source);
  assert.ok(image.length >= 1 && image[0].props.source.uri === SIGNED_URL, 'shown from the link');
  assert.ok(!logged.some((line) => line.includes('X-Amz-Signature') || line.includes('evidence.example.invalid')), 'never logged');
  assert.ok(!storageWrites.some(([, v]) => String(v).includes('evidence.example.invalid')), 'never persisted');
  // It expires: the viewer drops the link by itself (lifetime = expiry − 5 s safety margin).
  await act(async () => { await new Promise((r) => setTimeout(r, 1_500)); });
  await settle();
  assert.equal(renderer.root.findAll((n) => n.props && n.props.accessibilityLabel === 'Patrol photo 900' && n.props.source).length, 0, 'dropped at expiry');
  assert.ok(textOf(renderer.root).includes('The photo link expired and was discarded'));
  act(() => renderer.unmount());
  // Pure rules.
  assert.equal(P.signedLinkUsable({ expiresAt: iso(NOW + 4_000) }, NOW), false, 'inside the safety margin is expired');
  assert.equal(P.signedLinkUsable({ expiresAt: iso(NOW + 60_000) }, NOW), true);
  assert.equal(P.signedLinkLifetimeMs({ expiresAt: iso(NOW + 60 * 60_000) }, NOW), 15 * 60_000, 'never held more than 15 minutes');
  assert.equal(P.canOpenEvidence({ uploadStatus: 'verified', retentionStatus: 'quarantined' }), false);
  for (const [u, r, want] of [['pending', 'active', 'pending'], ['uploaded', 'active', 'uploaded'], ['verified', 'active', 'verified'], ['rejected', 'active', 'rejected'], ['verified', 'quarantined', 'quarantined'], ['verified', 'tombstone', 'deleted']]) {
    assert.equal(P.evidenceStatus({ uploadStatus: u, retentionStatus: r }), want);
  }
  // Hold status, the server's predicate; unknown (null) without the holds list — never "not held".
  const holds = [{ id: 1, scope: 'site_date_range', siteId: 10, fromDate: TODAY, toDate: TODAY, releasedAt: null }];
  assert.equal(P.evidenceHeld(evidence({ capturedAtDevice: iso(NOW) }), { shiftId: 71, siteId: 10 }, holds, 'UTC'), true);
  assert.equal(P.evidenceHeld(evidence(), { shiftId: 71, siteId: 10 }, [{ ...holds[0], releasedAt: iso(NOW) }], 'UTC'), false);
  assert.equal(P.evidenceHeld(evidence(), { shiftId: 71, siteId: 10 }, null, 'UTC'), null);
  // Source: nothing in Patrol Management logs or stores anything.
  const dir = path.join(ROOT, 'src/components/patrols');
  for (const file of fs.readdirSync(dir)) {
    const src = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.doesNotMatch(src, /console\.|localStorage|sessionStorage|AsyncStorage|SecureStore|indexedDB/, `${file}: no logging, no storage`);
  }
});

// ═══ Live Operations ═══

test('PM-11-LIVE-OPERATIONS-ONLY-ACTIONABLE-PATROL-ALERTS-EACH-LINKED', async () => {
  const alerts = [
    { id: 1, type: 'patrol_missed', status: 'open', patrolExceptionId: 40, patrolRunId: null, patrolWindowKey: 'w9' },
    { id: 2, type: 'patrol_abandoned', status: 'acknowledged', patrolExceptionId: 41, patrolRunId: 5 },
    { id: 3, type: 'patrol_incomplete', status: 'closed', patrolExceptionId: 42, patrolRunId: 6 },
    { id: 4, type: 'panic', status: 'open' },
    { id: 5, type: 'checkpoint_missed', status: 'open', patrolExceptionId: 43, patrolRunId: 7 },
  ];
  assert.deepEqual(P.actionablePatrolAlerts(alerts).map((a) => a.id), [1, 2, 5], 'patrol types, not closed');
  assert.deepEqual(P.patrolRecordTarget(alerts[0]), { kind: 'exception', exceptionId: 40, windowKey: 'w9' });
  assert.deepEqual(P.patrolRecordTarget(alerts[1]), { kind: 'run', runId: 5, exceptionId: 41 });
  for (const a of P.actionablePatrolAlerts(alerts)) assert.ok(P.patrolRecordTarget(a), `alert ${a.id} links to its record`);
  const screen = stripComments(read('src/screens/CompanyDashboardScreen.tsx'));
  assert.ok(screen.includes('actionablePatrolAlerts(outstandingAlerts).forEach((alert) => {'));
  assert.ok(screen.includes('patrolTarget: patrolRecordTarget(alert),') && screen.includes('canAct: patrolPermissions.canActOnAlerts,'));
  assert.ok(/if \(item\.category === 'patrol'\) \{[\s\S]{0,300}openPatrolRecord\(item\.patrolTarget \?\? 'overview'\);/.test(screen), 'opening a patrol item opens its record');
  // No run, scan or photo is ever turned into a Live Operations item: the only patrol source is the alert list.
  assert.doesNotMatch(screen, /listPatrolRuns|listPatrolRunEvidence|getPatrolOverview/, 'the dashboard reads no routine patrol data itself');

  // The real rail: a Viewer sees the item and its link, no action; alerts.manage acknowledges and resolves.
  const item = (canAct) => ({ id: 'patrol-2', alertId: 2, shiftId: null, status: 'open', siteName: 'Alpha Site', guardName: 'Ava Guard', category: 'patrol',
    issueType: 'Patrol abandoned', message: 'Started, not completed.', occurredAt: iso(NOW), patrolTarget: { kind: 'run', runId: 5, exceptionId: 41 }, canAct });
  for (const canAct of [false, true]) {
    const opened = [];
    const followUps = [];
    let rail;
    await act(async () => {
      rail = TestRenderer.create(h(LiveOpsAttentionRail, {
        items: [item(canAct)], metricFocus: 'all', urgentActionItemId: null, resolveShiftZone: () => 'Europe/London',
        onOpenUrgentDetail: (i) => opened.push(i), onOpenUrgentShift() {}, onUrgentIncidentFollowUp: async () => {},
        onUrgentAlertFollowUp: async (i, a) => { followUps.push(a); }, onOpenIncidentResolution() {}, nextUp: [],
      }));
    });
    assert.ok(textOf(rail.root).includes('Patrol abandoned') && textOf(rail.root).includes('Patrol'));
    await pressByText(rail.root, 'Open patrol record');
    assert.deepEqual(opened.map((i) => i.patrolTarget), [{ kind: 'run', runId: 5, exceptionId: 41 }], 'links to its run');
    assert.equal(has(rail.root, 'Acknowledge'), canAct, `acknowledge only with alerts.manage (${canAct})`);
    assert.equal(has(rail.root, 'Resolve'), canAct, `resolve only with alerts.manage (${canAct})`);
    if (canAct) {
      await pressByText(rail.root, 'Resolve');
      assert.deepEqual(followUps, ['close'], 'through the existing alert dialog');
    }
    act(() => rail.unmount());
  }
});

test('PM-12-PATROL-RESOLUTION-REASONS-MATCH-THE-BACKEND', () => {
  const backend = read('../security-backend-nest/src/safety-alert/resolution-reasons.ts');
  const block = backend.split('export const PATROL_RESOLUTION_REASONS = [')[1].split('] as const')[0];
  const set = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(R.resolutionOptions('patrol_late_sync').map((o) => o.value), set, 'exactly the backend set, in order');
  assert.deepEqual(R.resolutionOptions('patrol').map((o) => o.value), set.filter((v) => v !== 'patrol_completed_late_sync'), 'late sync only after late evidence');
  for (const type of ['patrol_missed', 'patrol_abandoned', 'patrol_incomplete', 'checkpoint_missed', 'patrol_unverified']) {
    assert.equal(R.resolutionFamilyForAlert(type), 'patrol', type);
    assert.equal(R.resolutionFamilyForAlertRecord({ type }), 'patrol');
    assert.equal(R.resolutionFamilyForAlertRecord({ type, patrolLateSyncAt: iso(NOW) }), 'patrol_late_sync');
    assert.notEqual(R.alertTypeLabel(type), 'Safety alert', `${type} is named`);
  }
  assert.equal(R.resolutionFamilyForAlertRecord({ type: 'panic', patrolLateSyncAt: iso(NOW) }), 'emergency', 'only patrol alerts');
  assert.equal(R.requiresResolutionNote('patrol_late_sync', 'patrol_completed_late_sync'), false, 'the late-sync reason needs no note');
  assert.equal(R.requiresResolutionNote('patrol', 'guard_contacted'), true, 'every other patrol reason does');
  assert.equal(R.validateResolution('patrol', { reason: 'patrol_completed_late_sync', note: '' }).ok, false, 'not offered without late evidence');
  assert.ok(stripComments(read('src/screens/CompanyDashboardScreen.tsx')).includes('family: resolutionFamilyForAlertRecord(alert),'));
});

// ═══ layout, states, polling, data ═══

test('PM-13-RESPONSIVE-BREAKPOINTS', () => {
  assert.deepEqual(P.patrolLayout(375), { mode: 'mobile', kpiColumns: 2, tabsScroll: true, detailFullScreen: true, tableRows: false });
  assert.equal(P.patrolLayout(767).mode, 'mobile');
  assert.equal(P.patrolLayout(768).mode, 'tablet');
  assert.equal(P.patrolLayout(1023).kpiColumns, 3);
  assert.deepEqual(P.patrolLayout(1024), { mode: 'desktop', kpiColumns: 4, tabsScroll: false, detailFullScreen: false, tableRows: true });
  const brand = read('src/theme/brand.ts');
  assert.ok(brand.includes('mobile:  768,') && brand.includes('tablet:  1024,'), 'the dashboard breakpoints');
});

test('PM-14-LOADING-EMPTY-ERROR-AND-PENDING-SYNC-STATES', async () => {
  // Loading.
  answers = baseAnswers({ listPatrolRuns: () => new Promise(() => {}) });
  let renderer = await mount({ permissions: perms('viewer') });
  await pressByText(renderer.root, 'Live Patrols');
  assert.ok(textOf(renderer.root).includes('Loading live patrols…'));
  act(() => renderer.unmount());
  // Empty.
  answers = baseAnswers({ listPatrolRuns: { items: [], total: 0, page: 1, pageSize: 100 } });
  renderer = await mount({ permissions: perms('viewer') });
  await pressByText(renderer.root, 'Live Patrols');
  assert.ok(textOf(renderer.root).includes('No patrol is in progress right now.'));
  act(() => renderer.unmount());
  // Error, with retry.
  answers = baseAnswers({ listPatrolRuns: () => { throw new api.ApiError(500, 'Server Error', { message: 'Database unavailable' }); } });
  renderer = await mount({ permissions: perms('viewer') });
  await pressByText(renderer.root, 'Live Patrols');
  assert.ok(textOf(renderer.root).includes('Could not load live patrols') && textOf(renderer.root).includes('Database unavailable'));
  assert.ok(has(renderer.root, 'Retry'));
  act(() => renderer.unmount());
  // 403: shown as a permission state, never a crash.
  answers = baseAnswers({ listPatrolRuns: () => { throw new api.ApiError(403, 'Forbidden', { code: 'PATROL_FORBIDDEN', message: 'Insufficient permissions.' }); } });
  renderer = await mount({ permissions: perms('viewer') });
  await pressByText(renderer.root, 'Live Patrols');
  assert.ok(textOf(renderer.root).includes('Not available to your role'));
  act(() => renderer.unmount());
  // Pending sync, progress and flags on a live run.
  answers = baseAnswers();
  renderer = await mount({ permissions: perms('viewer') });
  await pressByText(renderer.root, 'Live Patrols');
  const text = textOf(renderer.root);
  assert.ok(text.includes('2 of 4 checkpoints'), 'x of y: scans without the flagged one, of the route');
  assert.ok(text.includes('1 flagged scan'));
  assert.ok(text.includes('Patrol in progress — data still arriving from the device'), 'pending sync');
  assert.ok(text.includes('Late start'));
  assert.ok(text.includes('Device clock behind by 2m 05s'), 'clock drift');
  act(() => renderer.unmount());
  assert.equal(P.pendingSyncLabel({ status: 'completed', verificationStatus: 'pending' }), 'Waiting for the device to finish syncing');
  assert.equal(P.pendingSyncLabel({ status: 'completed', verificationStatus: 'verified' }), null);
  assert.equal(P.formatClockDrift(-61_000), 'Device clock ahead by 1m 01s');
  assert.equal(P.formatClockDrift(null), 'Not measured');
});

test('PM-15-NO-FIGURE-IS-FABRICATED', async () => {
  const none = P.buildPatrolKpis({ overview: null, exceptions: null, todaysRuns: null });
  assert.ok(none.every((k) => k.value === '—' && k.available === false), 'nothing without a response');
  const kpis = P.buildPatrolKpis({
    overview: baseAnswers().getPatrolOverview,
    exceptions: [
      { id: 1, type: 'patrol_missed', createdAt: iso(NOW), status: 'open' },
      { id: 2, type: 'patrol_missed', createdAt: '2020-01-01T00:00:00.000Z', status: 'open' },
      { id: 3, type: 'patrol_abandoned', createdAt: iso(NOW), status: 'resolved' },
    ],
    todaysRuns: { items: [run(), run({ id: 6, verificationStatus: 'verified' })], total: 2, page: 1, pageSize: 100 },
  });
  const by = Object.fromEntries(kpis.map((k) => [k.id, k]));
  assert.equal(by['windows-due'].available, false, 'the API does not report due windows: never estimated');
  assert.equal(by.completed.value, '2');
  assert.equal(by.live.value, '1');
  assert.equal(by.missed.value, '1', "only today's");
  assert.equal(by.abandoned.value, '1');
  assert.equal(by['awaiting-verification'].value, '1');
  const full = P.buildPatrolKpis({ overview: baseAnswers().getPatrolOverview, exceptions: Array.from({ length: 200 }, (_, i) => ({ id: i, type: 'patrol_missed', createdAt: iso(NOW) })), todaysRuns: null });
  assert.equal(full.find((k) => k.id === 'missed').value, '200+', 'a full page is a lower bound, said so');
  // The real Overview shows the server's numbers and "Not available" for the rest.
  answers = baseAnswers();
  const renderer = await mount({ permissions: perms('viewer') });
  const shown = textOf(renderer.root);
  // (The KPI icon glyph sits between a label and its value.)
  assert.match(shown, /Windows due today◎—Not reported by the patrol API/, 'not available, said so');
  assert.match(shown, /Completed today◎2/, "the server's own count");
  assert.match(shown, /Open patrol exceptions◎2/);
  act(() => renderer.unmount());
  const dir = path.join(ROOT, 'src/components/patrols');
  for (const file of fs.readdirSync(dir)) {
    const src = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.doesNotMatch(src, /Math\.random|faker|mockData|demoData|sampleData|DEMO_|SAMPLE_/, `${file}: no fabricated data`);
  }
});

test('PM-16-POLLING-IS-MODEST-PAUSED-AND-CLEANED-UP', async () => {
  assert.equal(P.PATROL_POLL_MS, 30_000);
  assert.equal(P.shouldPollPatrols({ enabled: true, hidden: true, failure: null }), false, 'paused while hidden');
  assert.equal(P.shouldPollPatrols({ enabled: false, hidden: false, failure: null }), false);
  assert.equal(P.shouldPollPatrols({ enabled: true, hidden: false, failure: 'error' }), true, 'a transient error is retried');
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const live = new Set();
  const delays = [];
  globalThis.setInterval = (fn, ms) => { const id = realSet(fn, ms); live.add(id); delays.push(ms); return id; };
  globalThis.clearInterval = (id) => { live.delete(id); return realClear(id); };
  try {
    answers = baseAnswers();
    const renderer = await mount({ permissions: perms('owner') });
    assert.ok(live.size > 0, 'the overview polls');
    assert.ok(delays.every((ms) => ms === 30_000), 'every 30 seconds');
    act(() => renderer.unmount());
    assert.equal(live.size, 0, 'no interval survives unmount');
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

test('PM-17-RETENTION-WORDING-NEVER-IMPLIES-LIFECYCLE-STOPS', () => {
  const dir = path.join(ROOT, 'src/components/patrols');
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(src, /retention (is )?(paused|suspended|stops)|holds? (are|is) suspended|deletion (is )?(paused|suspended)/i, file);
  }
});

// ═══ wiring ═══

test('PM-18-WIRING-DEPENDENCY-AND-THE-RELEASE-GATE', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies['qrcode-generator'], '1.4.4', 'pinned exactly');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages['node_modules/qrcode-generator'].version, '1.4.4');
  assert.equal(pkg.scripts['test:patrol-management-ui'], 'node scripts/patrol-management-ui.spec.cjs');
  const workflow = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 's4-mobile-release-gate.yml'), 'utf8');
  assert.ok(workflow.includes('run: npm run test:patrol-management-ui'));
  // Patrol calls go to the P1-A/B/C routes only.
  const apiSrc = read('src/services/api.ts');
  for (const route of ['/patrols/overview', '/patrols/runs', '/patrols/exceptions', '/patrols/policies', '/patrols/schedules', '/patrols/checkpoints', '/patrols/routes', '/patrols/holds', '/patrols/storage-usage', '/patrols/exports', '/download']) {
    assert.ok(apiSrc.includes(route), route);
  }
});

// ═══ P1-D corrections (#76, #77, #78) ═══

test('PM-19-ONE-CHECKPOINT-COUNT-IN-HISTORY-AND-DETAIL-76', async () => {
  // The #76 shape: a duplicate (flagged) scan in the run. Raw scan counts would say 4 − 1 = 3 and the visits 3 distinct
  // checkpoints; the server's one definition (distinct checkpoints with an unflagged scan) says 2. Both views show 2.
  const visit = (id, checkpointId, result, flags = []) => ({ id, clientVisitId: `v-${id}-abcdefgh`, runId: 5, checkpointId, checkpointPublicId: 'x'.repeat(32),
    checkpointLabel: `Gate ${checkpointId}`, method: 'qr', result, flags, provisional: false, scannedAtDevice: iso(NOW - id * MIN), receivedAtServer: iso(NOW - id * MIN),
    syncedLate: false, syncFlags: [], clockDriftMs: null });
  const r = run({ status: 'completed', visitCount: 4, flaggedVisitCount: 1, checkpointsVisited: 2, checkpointsTotal: 4 });
  answers = baseAnswers({
    listPatrolRuns: { items: [r], total: 1, page: 1, pageSize: 25 },
    // Visits whose naive client recount would differ from the server's figure: the page must not recount.
    getPatrolRun: { run: r, visits: [visit(1, 1, 'verified'), visit(2, 1, 'flagged', ['duplicate_in_run']), visit(3, 2, 'verified'), visit(4, 3, 'unverified')],
      exceptions: [], evidenceCount: 0, evidenceRestricted: false, evidence: [] },
  });
  const renderer = await mount({ permissions: perms('viewer') });
  await pressByText(renderer.root, 'History');
  const list = textOf(renderer.root);
  assert.ok(list.includes('2 of 4 checkpoints'), 'History shows the server figure');
  await pressByText(renderer.root, 'Open patrol 5');
  const detail = textOf(renderer.root);
  assert.ok(detail.includes('Checkpoints2 of 4 checkpoints') || /Checkpoints\s*2 of 4 checkpoints/.test(detail), 'the detail shows the SAME figure');
  assert.ok(!detail.includes('3 of 4 checkpoints'), 'never a second, client-side count');
  act(() => renderer.unmount());
  // Pure: the figure is the server's; absent means not reported, never derived.
  assert.deepEqual(P.runCheckpointProgress({ checkpointsVisited: 2, checkpointsTotal: 4 }), { label: '2 of 4 checkpoints', ratio: 0.5 });
  assert.deepEqual(P.runCheckpointProgress({ checkpointsVisited: 1, checkpointsTotal: null }), { label: '1 checkpoint visited', ratio: null });
  assert.equal(P.runCheckpointProgress({ visitCount: 3, flaggedVisitCount: 1 }), null);
  // No patrol view recounts progress from scans or the route list.
  for (const file of ['PatrolHistoryTab.tsx', 'PatrolLiveTab.tsx', 'PatrolRunDetail.tsx', 'patrolPresentation.ts']) {
    const src = stripComments(read(`src/components/patrols/${file}`));
    assert.doesNotMatch(src, /visitCount \?\? 0\) - |distinctScannedCheckpoints|routeCheckpointTotal|new Set\(visits/, `${file}: no client-side recount`);
  }
  // The backend computes it once, with the rule checkpoint_missed is judged by.
  const query = read('../security-backend-nest/src/patrol/patrol-query.service.ts');
  assert.ok(query.includes('...progress.get(Number(r.id))!') && query.includes('...progress.get(Number(run.id))!'), 'list and detail use the same server computation');
  const state = read('../security-backend-nest/src/patrol/patrol-state.ts');
  assert.ok(state.includes('const visited = visitedCheckpointIds(input.visits);'), 'the same definition as the checkpoint_missed rule');
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed += 1;
      console.log('PASS ', name);
    } catch (error) {
      console.error('FAIL ', name);
      console.error('      ' + (error && error.stack ? error.stack.split('\n').slice(0, 8).join('\n      ') : error));
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${pending.length} patrol management checks passed`);
  process.exit(process.exitCode || 0);
})();
