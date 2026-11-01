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
 *   - Photo previews (issue #79): ONE preview grant per page view (12 photos a page, server bound 24), only with
 *     patrols.evidence, drawn as lazy <img loading="lazy" referrerPolicy="no-referrer">, only for viewable photos,
 *     discarded at expiry and asked for again only on request; malformed, http or expired answers draw nothing.
 *   - Live Operations: only actionable patrol alerts appear, every one links to its patrol record, acting needs
 *     alerts.manage, and the patrol resolution reasons (with "completed — late sync" only after late evidence) match
 *     the backend exactly.
 *   - Responsive breakpoints, loading / empty / error / pending-sync states, polling limits and cleanup, and that no
 *     figure is fabricated.
 *   - The release-gate wiring and the pinned QR dependency.
 *   - S4 1.2.1: patrol exceptions are acknowledged / resolved on the page through the existing endpoints, by alerts.manage or
 *     patrols.manage only, with the Live Operations reasons and note rules; the drawers poll and re-read after every action
 *     (a 409 shows the latest decision); Live Operations is linked only with an alert; statuses never mislabel (PM-32–36).
 *   - S4 1.2.1: photos required are Yes/No toggles writing 1/0 (PM-28); the server's "Configuration required" warnings
 *     on Settings and Schedules, and a timing edit answered with a new schedule version (PM-29); neutral duplicate-photo
 *     and QR-rule labels (PM-30); NFC offered nowhere (PM-31).
 *   - S4 1.3.0 B2 (PM-37–42): the primary navigation Setup / Today / Evidence with every earlier tab reachable under
 *     Advanced; the guided site setup (evidence method without a photo count, frequency, scheduled start / Book On,
 *     checkpoints, printable labels, the authorised test scan) whose Activate stays disabled until the checklist passes
 *     and whose 422 PATROL_SETUP_INCOMPLETE reads in plain English; the evidence browser (Client → Site → Date → Patrol
 *     time → Guard, QR-only patrols included, Photos only, original vs stamped, no link or image data in text or logs);
 *     the Rota Planner's Patrol Requirement (create and edit round trip, the default preserved, nothing with Patrols off).
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
// The Overview's day (#77): the site-local day — Europe/London across all sites.
const LONDON_TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(NOW));
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
    getPatrolOverview: { date: LONDON_TODAY, dateBasis: 'site_local', timeZone: null, siteId: null, runsStarted: 4, runsByStatus: { in_progress: 1, completed: 2, incomplete: 1, closed_by_system: 0 },
      inProgressNow: 1, flaggedScans: 1, openExceptions: 2, activeCheckpoints: 4, activeSchedules: 1, activeRoutes: 1 },
    listPatrolExceptions: [],
    getPatrolWindowsDay: { date: LONDON_TODAY, dateBasis: 'site_local', siteId: null, generatedAt: iso(NOW), windowsDue: 8, windowsCompleted: 3, windowsOutstanding: 5,
      completionBasis: 'window_with_a_completed_run', sites: [{ siteId: 10, timeZone: 'Europe/London', date: LONDON_TODAY, dayStart: iso(NOW - 3_600_000), dayEnd: iso(NOW + 3_600_000), windowsDue: 8, windowsCompleted: 3, windowsOutstanding: 5 }] },
    listPatrolRuns: { items: [run()], total: 1, page: 1, pageSize: 25 },
    listPatrolSchedules: [],
    listPatrolCheckpoints: [],
    listPatrolExports: [],
    getPatrolRun: { run: run(), visits: [], exceptions: [], evidenceCount: 1, evidenceRestricted: false, evidence: [evidence()] },
    ...over,
  };
}

/** The page as it opens (S4 1.3.0 B2: the primary navigation, Setup / Today / Evidence / Advanced, on Today). */
async function mountPrimary(props) {
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(CompanyPatrolsWorkspace, { companyKey: 'co-1', layoutWidth: 1440, ...props })); });
  await settle();
  return renderer;
}
/**
 * The page with its Advanced area open. S4 1.3.0 B2 moved the P1-D tab row (Overview … Storage usage, unchanged) under
 * Advanced, so the checks written against that row open Advanced first — one press, exactly as a person now does.
 */
async function mount(props) {
  const renderer = await mountPrimary(props);
  if (has(renderer.root, 'Advanced')) await pressByText(renderer.root, 'Advanced');
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
    owner: { canView: true, canManage: true, canViewEvidence: true, canManageHolds: true, canActOnAlerts: true, canActOnExceptions: true },
    admin: { canView: true, canManage: true, canViewEvidence: true, canManageHolds: true, canActOnAlerts: true, canActOnExceptions: true },
    operations: { canView: true, canManage: true, canViewEvidence: true, canManageHolds: false, canActOnAlerts: true, canActOnExceptions: true },
    control_room: { canView: true, canManage: false, canViewEvidence: true, canManageHolds: false, canActOnAlerts: true, canActOnExceptions: true },
    viewer: { canView: true, canManage: false, canViewEvidence: false, canManageHolds: false, canActOnAlerts: false, canActOnExceptions: false },
    guard: { canView: false, canManage: false, canViewEvidence: false, canManageHolds: false, canActOnAlerts: false, canActOnExceptions: false },
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
  await pressByText(renderer.root, 'Advanced');
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

// ═══ evidence previews (issue #79) ═══

const thumbUrl = (id) => `https://evidence.example.invalid/patrol/thumb-${id}?X-Amz-Signature=feedface${id}`;
/** The server's answer for one page: a link for each verified, active photo of the page; url null otherwise. */
const thumbGrant = (list, ttlMs = 120_000) => (runId, { page, pageSize }) => {
  const items = list.slice((page - 1) * pageSize, page * pageSize).map((e) => ({
    evidenceId: e.id, url: P.canOpenEvidence(e) ? thumbUrl(e.id) : null, expiresAt: P.canOpenEvidence(e) ? iso(Date.now() + ttlMs) : null,
  }));
  return { runId, page, pageSize, total: list.length, totalPages: Math.max(1, Math.ceil(list.length / pageSize)), expiresAt: iso(Date.now() + ttlMs), items };
};
const previews = (root) => root.findAll((n) => n.type === 'img' && n.props.loading === 'lazy');
const thumbCalls = () => calls.filter(([k]) => k === 'getPatrolEvidenceThumbnails').map(([, a]) => [a[0], a[1].page, a[1].pageSize]);
async function openRun(role, list, extra = {}) {
  answers = baseAnswers({
    getPatrolRun: { run: run(), visits: [], exceptions: [], evidenceCount: list.length, evidenceRestricted: false, evidence: list },
    getPatrolEvidenceThumbnails: thumbGrant(list),
    ...extra,
  });
  calls.length = 0;
  const renderer = await mount({ permissions: perms(role) });
  await pressByText(renderer.root, 'Live Patrols');
  await pressByText(renderer.root, 'Open patrol 5');
  return renderer;
}

test('PM-24-PREVIEWS-NEED-PATROLS-EVIDENCE-A-VIEWER-REQUESTS-NOTHING', async () => {
  answers = baseAnswers({ getPatrolRun: { run: run(), visits: [], exceptions: [], evidenceCount: 3, evidenceRestricted: true, evidence: null } });
  calls.length = 0;
  const renderer = await mount({ permissions: perms('viewer') });
  await pressByText(renderer.root, 'Live Patrols');
  await pressByText(renderer.root, 'Open patrol 5');
  assert.equal(thumbCalls().length, 0, 'a Viewer never asks for previews');
  assert.equal(previews(renderer.root).length, 0, 'and sees no photo');
  act(() => renderer.unmount());
  // Even if a stale response carried metadata, a session without patrols.evidence mounts no list and asks for nothing.
  const list = [evidence({ id: 901 })];
  const r2 = await openRun('viewer', list);
  assert.equal(thumbCalls().length, 0);
  assert.equal(previews(r2.root).length, 0);
  act(() => r2.unmount());
});

test('PM-25-ONE-PREVIEW-GRANT-PER-PAGE-LAZY-NO-REFERRER-NEVER-LOGGED-OR-KEPT', async () => {
  logged.length = 0;
  storageWrites.length = 0;
  const list = [
    evidence({ id: 901 }), evidence({ id: 902, uploadStatus: 'pending', verifiedAt: null, expiresAt: null }),
    evidence({ id: 903, retentionStatus: 'quarantined' }), evidence({ id: 904, retentionStatus: 'claimed' }), evidence({ id: 905, uploadStatus: 'rejected', rejectionReason: 'trailing_data' }),
  ];
  const renderer = await openRun('control_room', list);
  assert.deepEqual(thumbCalls(), [[5, 1, 12]], 'ONE request for the page on screen (the server audits it once, purpose browse)');
  assert.equal(calls.filter(([k]) => k === 'getPatrolEvidenceLink').length, 0, 'previews never mint per-photo links');
  const imgs = previews(renderer.root);
  assert.deepEqual(imgs.map((n) => n.props.src), [thumbUrl(901), thumbUrl(904)], 'only verified, active or claimed photos are drawn');
  for (const n of imgs) {
    assert.equal(n.props.referrerPolicy, 'no-referrer');
    assert.equal(n.props.decoding, 'async');
    assert.ok(/^Preview of patrol photo \d+$/.test(n.props.alt));
  }
  assert.equal(renderer.root.findAll((n) => n.props && n.props.accessibilityLabel === 'Photo placeholder').length >= 3, true, 'the rest keep the placeholder');
  assert.ok(textOf(renderer.root).includes('Previews of this page are recorded once in the audit log'));
  assert.ok(!logged.some((line) => line.includes('X-Amz-Signature') || line.includes('evidence.example.invalid')), 'never logged');
  assert.ok(!storageWrites.some(([, v]) => String(v).includes('evidence.example.invalid')), 'never persisted');
  // A preview the browser cannot draw (e.g. HEIC outside Safari) falls back without breaking the row.
  await act(async () => { imgs[0].props.onError(); });
  await settle();
  assert.deepEqual(previews(renderer.root).map((n) => n.props.src), [thumbUrl(904)]);
  assert.ok(renderer.root.findAll((n) => n.props && n.props.accessibilityLabel === 'Preview unavailable').length >= 1);
  assert.ok(has(renderer.root, 'View photo'), 'the full photo can still be opened');
  // Closing the patrol drops the links with the list.
  act(() => renderer.unmount());
});

test('PM-26-PAGINATION-ONE-GRANT-PER-PAGE-VIEW', async () => {
  const list = Array.from({ length: 30 }, (_, i) => evidence({ id: 1000 + i, capturedAtDevice: iso(NOW - (60 - i) * MIN) }));
  list[25] = evidence({ id: 1025, uploadStatus: 'pending', verifiedAt: null });
  const renderer = await openRun('operations', list);
  assert.deepEqual(thumbCalls(), [[5, 1, 12]]);
  assert.equal(previews(renderer.root).length, 12, 'page 1: 12 photos');
  assert.ok(textOf(renderer.root).includes('Photos 1–12 of 30'));
  assert.ok(!textOf(renderer.root).includes('#1012'), 'page 2 is not rendered');
  await pressByText(renderer.root, 'Next photos');
  assert.deepEqual(thumbCalls(), [[5, 1, 12], [5, 2, 12]], 'one request per page view');
  assert.deepEqual(previews(renderer.root).map((n) => n.props.src), list.slice(12, 24).map((e) => thumbUrl(e.id)));
  await pressByText(renderer.root, 'Next photos');
  assert.ok(textOf(renderer.root).includes('Photos 25–30 of 30'));
  assert.equal(previews(renderer.root).length, 5, 'page 3: 6 photos, one still pending');
  assert.deepEqual(thumbCalls().length, 3);
  await pressByText(renderer.root, 'Previous photos');
  assert.deepEqual(thumbCalls()[3], [5, 2, 12], 'going back is a new page view');
  act(() => renderer.unmount());
  // A page with nothing that can be shown makes no request at all.
  const nothing = [evidence({ id: 1100, uploadStatus: 'pending', verifiedAt: null }), evidence({ id: 1101, retentionStatus: 'tombstone' })];
  const r2 = await openRun('owner', nothing);
  assert.deepEqual(thumbCalls(), []);
  act(() => r2.unmount());
  // Pure page rules.
  assert.deepEqual(P.evidencePage([1, 2, 3], 9, 2).page, 2, 'clamped to the last page');
  assert.equal(P.evidencePage([], 1).label, 'No photos');
  assert.equal(P.PATROL_THUMBNAIL_PAGE_SIZE <= 24, true, 'within the server bound');
});

test('PM-27-PREVIEW-LINKS-EXPIRE-AND-BAD-ANSWERS-SHOW-NOTHING', async () => {
  const list = [evidence({ id: 901 })];
  const renderer = await openRun('owner', list, { getPatrolEvidenceThumbnails: thumbGrant(list, 6_200) });
  assert.equal(previews(renderer.root).length, 1);
  // Lifetime = expiry − 5 s safety margin.
  await act(async () => { await new Promise((r) => setTimeout(r, 1_500)); });
  await settle();
  assert.equal(previews(renderer.root).length, 0, 'discarded at expiry');
  assert.ok(textOf(renderer.root).includes('Photo previews expired and were discarded.'));
  answers.getPatrolEvidenceThumbnails = thumbGrant(list);
  await pressByText(renderer.root, 'Show previews again');
  assert.equal(thumbCalls().length, 2, 'asked again only on request');
  assert.equal(previews(renderer.root).length, 1);
  act(() => renderer.unmount());
  // Malformed or unsafe answers draw nothing.
  for (const bad of [[], null, { expiresAt: iso(Date.now() + 60_000), items: [{ evidenceId: 901, url: 'http://evidence.example.invalid/x' }] },
    { expiresAt: iso(Date.now() + 1_000), items: [{ evidenceId: 901, url: thumbUrl(901) }] }]) {
    const r = await openRun('owner', list, { getPatrolEvidenceThumbnails: () => bad });
    assert.equal(previews(r.root).length, 0, JSON.stringify(bad));
    assert.ok(has(r.root, 'Try previews again'));
    act(() => r.unmount());
  }
  const failing = await openRun('owner', list, { getPatrolEvidenceThumbnails: () => { throw Object.assign(new Error('404'), { status: 404, code: 'PATROLS_NOT_ENABLED' }); } });
  assert.equal(previews(failing.root).length, 0);
  act(() => failing.unmount());
  assert.equal(P.thumbnailLinks({ expiresAt: iso(NOW + 60_000), items: [{ evidenceId: 7, url: thumbUrl(7) }] }, [8], NOW).size, 0, 'only photos on the page');
  // The route and its server bound.
  assert.ok(read('src/services/api.ts').includes('/patrols/runs/${runId}/evidence/thumbnails'));
  const backend = read('../security-backend-nest/src/patrol/evidence/patrol-evidence-shared.ts');
  assert.ok(backend.includes('PATROL_EVIDENCE_THUMBNAIL_PAGE_MAX = 24'));
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
  for (const id of ['windows-due', 'windows-completed', 'windows-outstanding']) assert.equal(by[id].available, false, `${id}: no windows response, never estimated`);
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
  assert.match(shown, /Windows due today◎8/, "the server's own count of today's windows (#78)");
  assert.ok(!shown.includes('Not reported by the patrol API'), 'the placeholder is gone');
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

// ═══ exceptional offline recovery grants (issue #68) ═══

const typeInto = async (root, label, value) => {
  const nodes = root.findAll((n) => n.props && n.props.label === label && typeof n.props.onChangeText === 'function');
  assert.ok(nodes.length > 0, `a "${label}" field`);
  await act(async () => { nodes[0].props.onChangeText(value); });
  await settle();
};
function grant(over = {}) {
  return {
    id: 41, shiftId: 71, guardId: 11, guardName: 'Ava Guard', siteId: 10, siteName: 'Alpha Site', shiftStart: iso(NOW - 40 * 60 * MIN),
    shiftEnd: iso(NOW - 32 * 60 * MIN), reason: 'Phone recovered after the outage', status: 'active', createdAt: iso(NOW - 10 * MIN), createdByUserId: 1,
    expiresAt: iso(NOW + 24 * 60 * MIN - 10 * MIN), revokedAt: null, revokedByUserId: null, revokeReason: null, uses: 2, lastUsedAt: iso(NOW - 5 * MIN), ...over,
  };
}

test('PM-19-RECOVERY-GRANTS-OWNER-AND-ADMIN-ONLY-ON-THE-EXISTING-PAGE', async () => {
  for (const role of ['owner', 'admin', 'operations', 'control_room', 'viewer']) {
    answers = baseAnswers({ listPatrolRecoveryGrants: [grant()] });
    calls.length = 0;
    const p = perms(role);
    const renderer = await mount({ permissions: p });
    await pressByText(renderer.root, 'Downloads, retention & holds');
    const text = textOf(renderer.root);
    assert.equal(text.includes('Late-sync recovery grants'), p.canManageHolds, `${role}: the recovery grants panel`);
    assert.equal(has(renderer.root, 'Issue grant'), p.canManageHolds, `${role}: issue`);
    assert.equal(has(renderer.root, 'Revoke'), p.canManageHolds, `${role}: revoke`);
    assert.equal(calls.some(([k]) => k === 'listPatrolRecoveryGrants'), p.canManageHolds, `${role}: grants are read only with patrols.holds`);
    assert.equal(calls.some(([k]) => k === 'issuePatrolRecoveryGrant' || k === 'revokePatrolRecoveryGrant'), false, `${role}: nothing written without a press`);
    act(() => renderer.unmount());
  }
  assert.ok(!perms('operations').canManageHolds && !perms('control_room').canManageHolds && !perms('viewer').canManageHolds && !perms('guard').canView,
    'Operations, Control Room, Viewer and Guards never get the controls');
});

test('PM-20-RECOVERY-GRANTS-ISSUE-LIST-AND-REVOKE-THROUGH-THE-API', async () => {
  answers = baseAnswers({
    listPatrolRecoveryGrants: (status) => (status === 'all' ? [grant(), grant({ id: 40, status: 'revoked', revokedAt: iso(NOW - 60 * MIN), revokeReason: 'Issued in error', uses: 0, lastUsedAt: null })] : [grant()]),
    issuePatrolRecoveryGrant: (input) => grant({ id: 42, shiftId: input.shiftId, uses: 0, lastUsedAt: null }),
    revokePatrolRecoveryGrant: (id, reason) => grant({ id, status: 'revoked', revokedAt: iso(NOW), revokeReason: reason }),
  });
  calls.length = 0;
  const renderer = await mount({ permissions: perms('owner') });
  const root = renderer.root;
  await pressByText(root, 'Downloads, retention & holds');
  // The list: shift, Guard, site, status, expiry, reason and uses — from the server only.
  let text = textOf(root);
  assert.ok(text.includes('Shift 71 · Ava Guard · Alpha Site'), text);
  assert.ok(text.includes('Phone recovered after the outage'));
  assert.ok(text.includes('Used 2 times'));
  assert.ok(text.includes('Active'));
  // Validation before any request: shift number, 1–72 hours, a reason.
  const issued = () => calls.filter(([k]) => k === 'issuePatrolRecoveryGrant');
  await pressByText(root, 'Issue grant');
  assert.equal(issued().length, 0, 'no shift number');
  assert.ok(textOf(root).includes('Enter the shift number.'));
  await typeInto(root, 'Shift number', '71');
  await typeInto(root, 'Hours (1–72)', '73');
  await typeInto(root, 'Reason for the grant', 'Phone recovered after the outage');
  await pressByText(root, 'Issue grant');
  assert.equal(issued().length, 0, 'more than 72 hours is refused on the page too');
  assert.ok(textOf(root).includes('A recovery grant lasts 1 to 72 hours.'));
  await typeInto(root, 'Hours (1–72)', '24');
  await typeInto(root, 'Reason for the grant', 'ab');
  await pressByText(root, 'Issue grant');
  assert.equal(issued().length, 0, 'a reason is mandatory');
  await typeInto(root, 'Reason for the grant', 'Phone recovered after the outage');
  await pressByText(root, 'Issue grant');
  assert.deepEqual(issued().map(([, a]) => a[0]), [{ shiftId: 71, durationHours: 24, reason: 'Phone recovered after the outage' }]);
  text = textOf(root);
  assert.ok(text.includes('Recovery grant issued for shift 71'), text);
  assert.ok(text.includes('Send again'), 'the Owner is told how the Guard re-sends');
  // Revoke: a reason is required, then the server is asked.
  const revoked = () => calls.filter(([k]) => k === 'revokePatrolRecoveryGrant');
  await pressByText(root, 'Revoke');
  await pressByText(root, 'Revoke grant');
  assert.equal(revoked().length, 0, 'no reason, no request');
  await typeInto(root, 'Reason for revoking', 'Evidence received');
  await pressByText(root, 'Revoke grant');
  assert.deepEqual(revoked().map(([, a]) => a), [[41, 'Evidence received']]);
  assert.ok(textOf(root).includes('Recovery grant #41 revoked'));
  // Ended grants on request.
  await pressByText(root, 'Include ended');
  assert.ok(calls.some(([k, a]) => k === 'listPatrolRecoveryGrants' && a[0] === 'all'));
  assert.ok(textOf(root).includes('Revoked'));
  assert.ok(textOf(root).includes('Issued in error'));
  // A server refusal is shown as the server's message (e.g. an active grant already exists).
  answers.issuePatrolRecoveryGrant = async () => { const e = new Error('x'); e.status = 409; e.body = { code: 'PATROL_RECOVERY_GRANT_ALREADY_ACTIVE', message: 'This Guard already has an active recovery grant for this shift.' }; throw e; };
  await typeInto(root, 'Shift number', '71');
  await typeInto(root, 'Reason for the grant', 'Second attempt');
  await pressByText(root, 'Issue grant');
  assert.ok(textOf(root).includes('This Guard already has an active recovery grant for this shift.'));
  act(() => renderer.unmount());
  // Data accepted under a grant is labelled for reviewers wherever sync flags are shown.
  assert.equal(P.syncFlagLabel('recovered_via_grant'), 'Recovered late under a recovery grant');
  assert.equal(P.recoveryGrantDraftProblem({ shiftId: '71', hours: '', reason: 'Valid reason' }), null, 'blank hours means the 24 h default');
  assert.equal(P.PATROL_RECOVERY_GRANT_MAX_HOURS, 72);
  const backend = read('../security-backend-nest/src/patrol/patrol-constants.ts');
  assert.ok(backend.includes('export const PATROL_RECOVERY_GRANT_MAX_HOURS = 72;') && backend.includes('export const PATROL_RECOVERY_GRANT_DEFAULT_HOURS = 24;'), 'the same bounds as the server');
  assert.ok(backend.includes("'recovered_via_grant'"), 'the server\'s flag name');
});

// ═══ S4 1.2.1 (patrol correctness) ═══

const QR_WARNING = { code: 'QR_ROUTE_REQUIRED', message: 'Choose a route with required checkpoints, or switch this site to photos.', scheduleId: 1, siteId: 10 };
const SCHEDULE = {
  id: 1, siteId: 10, routeId: null, name: 'Night rounds', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], activeFrom: '22:00', activeTo: '06:00', timeBasis: 'site_local',
  frequencyMinutes: 60, windowMinutes: 60, startsOn: null, endsOn: null, active: true, archivedAt: null, createdAt: null, updatedAt: null, configurationWarnings: [QR_WARNING],
};

test('PM-28-PHOTOS-REQUIRED-ARE-YES-NO-TOGGLES-WRITING-1-OR-0', async () => {
  const Settings = loadSource('src/components/patrols/PatrolSettingsTab.tsx');
  assert.deepEqual(Settings.PHOTO_TOGGLES.map((t) => [t.key, t.label]), [['photosPerRun', 'Photos required for each patrol'], ['photosPerCheckpoint', 'Photo at each checkpoint']]);
  const before = { ...policies().companyDefault, photosPerRun: 3, photosPerCheckpoint: 0 };
  // An older numeric value (3) reads as "Yes"; keeping it changes nothing; switching off writes 0, on writes 1.
  const draftOf = (over) => ({ ...before, startGraceMinutes: '15', maxPatrolDurationMinutes: '45', completionGraceMinutes: '30', syncGraceMinutes: '60', postShiftSyncHours: '24', clockDriftThresholdMinutes: '5', ...over });
  assert.deepEqual(Settings.policyChanges(before, draftOf({})).update, {});
  assert.deepEqual(Settings.policyChanges(before, draftOf({ photosPerRun: 0, photosPerCheckpoint: 1 })).update, { photosPerRun: 0, photosPerCheckpoint: 1 });
  answers = baseAnswers({ savePatrolSitePolicy: (siteId, update) => ({ siteId, policy: { ...policies().companyDefault, ...update, source: 'company' }, configurationWarnings: [] }) });
  calls.length = 0;
  const renderer = await mount({ permissions: perms('owner') });
  const root = renderer.root;
  await pressByText(root, 'Site settings');
  const text = textOf(root);
  assert.ok(!text.includes('Photos required per patrol') && !text.includes('Photos required per checkpoint'), 'no number fields for photos');
  assert.equal(root.findAll((n) => n.props && /^Photos? required|^Photo at each/.test(String(n.props.label ?? '')) && typeof n.props.onChangeText === 'function').length, 0, 'no text input for photos');
  const toggle = (label) => root.findAll((n) => n.props && n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === label)[0];
  assert.equal(toggle('Photos required for each patrol').props.accessibilityState.checked, false);
  assert.ok(toggle('Photo at each checkpoint'), 'a Yes/No toggle');
  assert.ok(toggle('QR checkpoint scans') && toggle('Photos'), 'the method toggles are kept');
  await pressByText(root, 'Photos required for each patrol');
  await pressByText(root, 'Save settings');
  const saved = calls.filter(([k]) => k === 'savePatrolSitePolicy');
  assert.deepEqual(saved.map(([, a]) => a), [[null, { photosPerRun: 1 }]], 'Yes writes 1');
  act(() => renderer.unmount());
});

test('PM-29-CONFIGURATION-REQUIRED-ON-SETTINGS-AND-SCHEDULES-AND-THE-NEW-VERSION-NOTE', async () => {
  const pol = policies();
  pol.sites[0].configurationWarnings = [QR_WARNING];
  let updated = null;
  answers = baseAnswers({
    getPatrolPolicies: pol,
    listPatrolSchedules: () => [updated ?? SCHEDULE],
    updatePatrolSchedule: (id, input) => { updated = { ...SCHEDULE, ...input, id: 2, predecessorId: id, timingChanged: true }; return updated; },
    savePatrolSitePolicy: (siteId, update) => ({ siteId, policy: { ...pol.companyDefault, ...update, source: 'company' }, configurationWarnings: [QR_WARNING] }),
  });
  calls.length = 0;
  const renderer = await mount({ permissions: perms('owner') });
  const root = renderer.root;
  await pressByText(root, 'Site settings');
  let text = textOf(root);
  assert.ok(text.includes('Configuration required'), 'Settings shows the warning prominently');
  assert.ok(text.includes('Choose a route with required checkpoints, or switch this site to photos.'));
  await pressByText(root, 'Schedules');
  text = textOf(root);
  assert.ok(text.includes('Night rounds') && text.includes('Configuration required'), 'the Schedules tab shows it on the schedule');
  assert.ok(text.includes('no route'));
  // Editing the timing: the note, then a NEW id comes back and the list is re-read.
  await pressByText(root, 'Edit');
  assert.ok(textOf(root).includes('Timing changes apply from now as a new version.'));
  await typeInto(root, 'Frequency (minutes)', '30');
  await typeInto(root, 'Window (minutes)', '30');
  const listsBefore = calls.filter(([k]) => k === 'listPatrolSchedules').length;
  await pressByText(root, 'Save schedule');
  assert.deepEqual(calls.filter(([k]) => k === 'updatePatrolSchedule').map(([, a]) => [a[0], a[1].frequencyMinutes]), [[1, 30]]);
  assert.ok(calls.filter(([k]) => k === 'listPatrolSchedules').length > listsBefore, 'the list is re-read (the successor has a new id)');
  text = textOf(root);
  assert.ok(text.includes('Schedule saved. Timing changes apply from now as a new version.'), text);
  assert.ok(text.includes('Every 30 min'), 'the successor is listed');
  // No warning: nothing shown.
  act(() => renderer.unmount());
  answers = baseAnswers({ listPatrolSchedules: [{ ...SCHEDULE, routeId: 3, configurationWarnings: [] }] });
  const clean = await mount({ permissions: perms('owner') });
  await pressByText(clean.root, 'Schedules');
  assert.ok(!textOf(clean.root).includes('Configuration required'));
  act(() => clean.unmount());
});

test('PM-30-DUPLICATE-PHOTO-AND-QR-RULE-LABELS-ARE-NEUTRAL', async () => {
  assert.equal(P.syncFlagLabel('duplicate_sha256'), 'Duplicate photo (same image already submitted) — review');
  assert.equal(P.syncFlagLabel('qr_rule_missing'), 'No QR checkpoint rule — choose a route with required checkpoints, or switch this site to photos');
  assert.doesNotMatch(P.syncFlagLabel('duplicate_sha256'), /fraud|suspicious|tamper|misconduct|fake|cheat/i, 'it alleges nothing');
  // Shown on the photo in the run detail.
  answers = baseAnswers({ getPatrolRun: { run: run({ status: 'completed', needsReview: true, syncFlags: ['duplicate_sha256'] }), visits: [], exceptions: [], evidenceCount: 2, evidenceRestricted: false,
    evidence: [evidence(), evidence({ id: 901, clientEvidenceId: 'ev-bcdefghi', syncFlags: ['duplicate_sha256'], needsReview: true })] } });
  const Detail = loadSource('src/components/patrols/PatrolRunDetail.tsx');
  assert.match(read('src/components/patrols/PatrolEvidenceList.tsx'), /item\.syncFlags\?\.length \? <Text style=\{ui\.rowMeta\}>\{item\.syncFlags\.map\(syncFlagLabel\)/, 'evidence flags are labelled');
  assert.match(read('src/components/patrols/PatrolRunDetail.tsx'), /run\.syncFlags\.map\(syncFlagLabel\)/, 'run flags are labelled');
  assert.ok(Detail, 'the run detail loads');
});

test('PM-31-NFC-IS-OFFERED-NOWHERE-ON-THE-DASHBOARD', async () => {
  const dir = path.join(ROOT, 'src/components/patrols');
  for (const name of fs.readdirSync(dir)) {
    assert.doesNotMatch(stripComments(fs.readFileSync(path.join(dir, name), 'utf8')), /\bnfc\b/i, `${name} offers no NFC`);
  }
  assert.match(read('src/components/patrols/PatrolSettingsTab.tsx'), /\(\['qr', 'photo'\] as const\)\.map/, 'the only methods offered are QR and photos');
  const backend = read('../security-backend-nest/src/patrol/patrol-constants.ts');
  assert.ok(backend.includes("export const PATROL_METHODS = ['qr', 'photo'] as const;"), 'the server accepts no other method');
  answers = baseAnswers();
  const renderer = await mount({ permissions: perms('owner') });
  await pressByText(renderer.root, 'Site settings');
  assert.doesNotMatch(textOf(renderer.root), /nfc/i);
  act(() => renderer.unmount());
});

// ═══ wiring ═══

// ═══ S4 1.2.1: acknowledge / resolve patrol exceptions on the page ═══

function exc(over = {}) {
  return {
    id: 40, siteId: 10, runId: null, scheduleId: 1, shiftId: 71, windowKey: 'w9', scopeKey: 'site', type: 'patrol_missed', status: 'open',
    safetyAlertId: 501, note: null, resolution: null, resolvedAt: null, createdAt: iso(NOW - 30 * MIN), guardId: 11,
    windowStart: iso(NOW - 90 * MIN), windowEnd: iso(NOW - 60 * MIN), acknowledgedAt: null, lateEvidenceAt: null, annotations: [],
    alertStatus: 'open', alertPriority: 'high', acknowledgedByName: null, resolvedByName: null, ...over,
  };
}
const EXC_TARGET = { requestId: 1, kind: 'exception', exceptionId: 40 };
const noteLabel = (root) => (root.findAll((n) => n.props && typeof n.props.onChangeText === 'function' && /^Resolution note/.test(n.props.accessibilityLabel || ''))[0] || {}).props?.accessibilityLabel;

test('PM-32-EXCEPTION-ACTIONS-ARE-GATED-BY-PERMISSION', async () => {
  const resolve = (list, role = 'company_staff') => access.resolvePatrolPermissions(list, role).canActOnExceptions;
  assert.equal(resolve(['patrols.view', 'patrols.manage']), true, 'patrols.manage (Operations without alerts.manage)');
  assert.equal(resolve(['patrols.view', 'alerts.manage']), true, 'alerts.manage (Control Room)');
  assert.equal(resolve(['patrols.view']), false, 'a Viewer');
  assert.equal(resolve(['alerts.manage']), false, 'never without the page (patrols.view)');
  assert.equal(resolve(null, 'company_admin'), false, 'a session without a list never reaches the page');
  const backend = read('../security-backend-nest/src/company-membership/company-membership-types.ts');
  assert.match(backend, /PATROL_ALERT_ACT_PERMISSIONS[\s\S]{0,200}ALERTS_MANAGE[\s\S]{0,80}PATROLS_MANAGE|PATROL_ALERT_ACT_PERMISSIONS[\s\S]{0,200}PATROLS_MANAGE[\s\S]{0,80}ALERTS_MANAGE/,
    'mirrors the backend: alerts.manage OR patrols.manage');
  for (const role of ['owner', 'operations', 'control_room', 'viewer']) {
    answers = baseAnswers({ listPatrolExceptions: [exc()] });
    const p = perms(role);
    const renderer = await mount({ permissions: p, target: EXC_TARGET });
    const root = renderer.root;
    assert.equal(has(root, 'Acknowledge'), p.canActOnExceptions, `${role}: acknowledge`);
    assert.equal(has(root, 'Resolve'), p.canActOnExceptions, `${role}: resolve`);
    if (!p.canActOnExceptions) assert.ok(textOf(root).includes('needs the alerts or patrol management permission'), `${role}: told why`);
    act(() => renderer.unmount());
  }
  // A resolved exception offers no action to anyone.
  answers = baseAnswers({ listPatrolExceptions: [exc({ status: 'resolved', resolution: 'guard_contacted', resolvedAt: iso(NOW - MIN), resolvedByName: 'Rae Resolver' })] });
  const done = await mount({ permissions: perms('owner'), target: EXC_TARGET });
  assert.equal(has(done.root, 'Acknowledge') || has(done.root, 'Resolve'), false);
  act(() => done.unmount());
  // 403 is shown as a permission message, the page stays.
  answers = baseAnswers({ listPatrolExceptions: [exc()], acknowledgePatrolException: async () => { const e = new Error('forbidden'); e.status = 403; e.body = { code: 'PATROL_FORBIDDEN' }; throw e; } });
  const refused = await mount({ permissions: perms('owner'), target: EXC_TARGET });
  await pressByText(refused.root, 'Acknowledge');
  assert.ok(textOf(refused.root).includes('You do not have permission for this part of Patrol Management.'));
  act(() => refused.unmount());
});

test('PM-33-RESOLUTION-REASONS-NOTE-RULES-AND-LATE-SYNC-ONLY-WITH-LATE-EVIDENCE', async () => {
  let list = [exc()];
  answers = baseAnswers({ listPatrolExceptions: () => list, resolvePatrolException: async (id, body) => { list = [exc({ status: 'resolved', resolution: body.resolutionReason, resolvedAt: iso(NOW), resolvedByName: 'Ola Owner' })]; return list[0]; } });
  calls.length = 0;
  let renderer = await mount({ permissions: perms('owner'), target: EXC_TARGET });
  await pressByText(renderer.root, 'Resolve');
  const patrolValues = R.resolutionOptions('patrol').map((o) => o.label);
  for (const label of patrolValues) assert.ok(has(renderer.root, label), `offers ${label}`);
  assert.equal(has(renderer.root, 'Patrol completed — late sync'), false, 'no late sync without late evidence');
  await pressByText(renderer.root, 'Guard contacted');
  assert.equal(noteLabel(renderer.root), 'Resolution note (required)');
  await pressByText(renderer.root, 'Confirm resolution');
  assert.ok(textOf(renderer.root).includes('A resolution note is required.'));
  await typeInto(renderer.root, 'Resolution note (required)', 'x'.repeat(2001));
  await pressByText(renderer.root, 'Confirm resolution');
  assert.ok(textOf(renderer.root).includes('Keep the note under 2000 characters.'));
  assert.equal(calls.filter(([k]) => k === 'resolvePatrolException').length, 0, 'nothing sent until the rules are met');
  await typeInto(renderer.root, 'Resolution note (required)', '  Rang the Guard: gate locked.  ');
  await pressByText(renderer.root, 'Confirm resolution');
  assert.deepEqual(calls.filter(([k]) => k === 'resolvePatrolException').map(([, a]) => a), [[40, { resolutionReason: 'guard_contacted', resolutionNote: 'Rang the Guard: gate locked.' }]]);
  assert.ok(textOf(renderer.root).includes('Resolved'), 'the server\'s new state is shown');
  assert.ok(textOf(renderer.root).includes('by Ola Owner'));
  act(() => renderer.unmount());
  // With late evidence: "Patrol completed — late sync" is offered and needs no note.
  list = [exc({ lateEvidenceAt: iso(NOW - 5 * MIN) })];
  calls.length = 0;
  renderer = await mount({ permissions: perms('control_room'), target: EXC_TARGET });
  await pressByText(renderer.root, 'Resolve');
  await pressByText(renderer.root, 'Patrol completed — late sync');
  assert.equal(noteLabel(renderer.root), 'Resolution note (optional)');
  await pressByText(renderer.root, 'Confirm resolution');
  assert.deepEqual(calls.filter(([k]) => k === 'resolvePatrolException').map(([, a]) => a), [[40, { resolutionReason: 'patrol_completed_late_sync' }]]);
  act(() => renderer.unmount());
  assert.equal(R.RESOLUTION_NOTE_MAX_LENGTH, 2000);
  const backendDto = read('../security-backend-nest/src/patrol/dto/patrol.dto.ts');
  assert.match(backendDto, /class ResolvePatrolExceptionDto[\s\S]{0,300}@MaxLength\(2000\)\s*resolutionNote/, 'the same limit as the API');
});

test('PM-34-THE-SERVER-STATE-WINS-POLLING-REFRESH-AFTER-ACTIONS-AND-409', async () => {
  let list = [exc()];
  answers = baseAnswers({
    listPatrolExceptions: () => list,
    acknowledgePatrolException: async () => { list = [exc({ status: 'acknowledged', acknowledgedAt: iso(NOW), acknowledgedByName: 'Cara Control' })]; return list[0]; },
    resolvePatrolException: async () => {
      list = [exc({ status: 'resolved', resolution: 'site_inaccessible', resolvedAt: iso(NOW), resolvedByName: 'Rae Resolver', acknowledgedAt: iso(NOW - MIN), acknowledgedByName: 'Cara Control' })];
      const e = new Error('conflict'); e.status = 409; e.body = { code: 'PATROL_EXCEPTION_ALREADY_RESOLVED' }; throw e;
    },
  });
  calls.length = 0;
  const renderer = await mount({ permissions: perms('control_room'), target: EXC_TARGET });
  const reads = () => calls.filter(([k]) => k === 'listPatrolExceptions').length;
  const before = reads();
  await pressByText(renderer.root, 'Acknowledge');
  assert.ok(reads() > before, 're-read after acknowledging');
  assert.ok(textOf(renderer.root).includes('Acknowledged'));
  assert.ok(textOf(renderer.root).includes('by Cara Control'));
  assert.equal(has(renderer.root, 'Acknowledge'), false, 'no second acknowledge');
  await pressByText(renderer.root, 'Resolve');
  await pressByText(renderer.root, 'Site inaccessible');
  await typeInto(renderer.root, 'Resolution note (required)', 'Barrier down');
  const beforeConflict = reads();
  await pressByText(renderer.root, 'Confirm resolution');
  assert.ok(reads() > beforeConflict, 're-read after the 409');
  const text = textOf(renderer.root);
  assert.ok(text.includes('already resolved') && text.includes('Resolved') && text.includes('by Rae Resolver') && text.includes('Site inaccessible'),
    'someone else resolved it: the latest decision, never a cached "Open"');
  assert.equal(has(renderer.root, 'Resolve'), false);
  act(() => renderer.unmount());
  // Both drawers poll while open, as the overview does.
  const detail = stripComments(read('src/components/patrols/PatrolRunDetail.tsx'));
  assert.match(detail, /getPatrolRun\(runId as number\), \{ enabled: runId != null, poll: true \}/);
  assert.match(detail, /listPatrolExceptions\(\{\}\), \{ enabled: exceptionId != null, poll: true \}/);
  assert.equal((detail.match(/onChanged=\{\(\) => \{ void (detail|list)\.reload\(true\); \}\}/g) || []).length, 2, 'every action re-reads its drawer');
});

test('PM-35-OPEN-IN-LIVE-OPERATIONS-ONLY-WITH-AN-ALERT', async () => {
  const opened = [];
  answers = baseAnswers({ listPatrolExceptions: [exc()] });
  let renderer = await mount({ permissions: perms('viewer'), target: EXC_TARGET, onOpenLiveOperationsAlert: (t) => opened.push(t) });
  await pressByText(renderer.root, 'Open in Live Operations');
  assert.deepEqual(opened, [{ alertId: 501, shiftId: 71 }], 'its alert and shift');
  act(() => renderer.unmount());
  answers = baseAnswers({ listPatrolExceptions: [exc({ safetyAlertId: null, alertStatus: null })] });
  renderer = await mount({ permissions: perms('owner'), target: EXC_TARGET, onOpenLiveOperationsAlert: (t) => opened.push(t) });
  assert.equal(has(renderer.root, 'Open in Live Operations'), false, 'no alert, no link');
  act(() => renderer.unmount());
  const screen = stripComments(read('src/screens/CompanyDashboardScreen.tsx'));
  assert.match(screen, /onOpenLiveOperationsAlert=\{\(\{ alertId, shiftId \}\) => \{[\s\S]{0,200}if \(shiftId != null\) focusShiftDetail\(shiftId\);\s*else setActiveSection\('live-operations'\);/,
    'the dashboard\'s existing Live Operations focus');
});

test('PM-36-STATUS-LABELS-NEVER-MISLABEL-AND-RESOLVED-SHOWS-WHO-AND-WHEN', async () => {
  assert.deepEqual(['open', 'acknowledged', 'resolved', 'escalated', null].map(P.exceptionStatusLabel), ['Open', 'Acknowledged', 'Resolved', 'escalated', 'Unknown']);
  answers = baseAnswers({ listPatrolExceptions: [exc({ id: 41, status: 'acknowledged' }), exc({ id: 42, status: 'open' }), exc({ id: 43, status: 'resolved' })] });
  let renderer = await mount({ permissions: perms('viewer') });
  const rows = renderer.root.findAll((n) => n.props && /^Open exception 4[123]$/.test(n.props.accessibilityLabel || '') && typeof n.props.onPress === 'function');
  const labels = Object.fromEntries(rows.map((r) => [r.props.accessibilityLabel, textOf(r)]));
  assert.ok(labels['Open exception 41'].includes('Acknowledged') && labels['Open exception 42'].includes('Open'), 'each row says the server\'s status');
  assert.equal(labels['Open exception 43'], undefined, 'resolved exceptions are not listed as open');
  assert.ok(!textOf(renderer.root).includes('where they are acknowledged and resolved'), 'exceptions are no longer actioned only in Live Operations');
  act(() => renderer.unmount());
  answers = baseAnswers({ listPatrolExceptions: [exc({ status: 'resolved', resolution: 'patrol_completed_late_sync', resolvedAt: '2026-06-02T09:30:00.000Z', resolvedByName: 'Rae Resolver',
    acknowledgedAt: '2026-06-02T09:10:00.000Z', acknowledgedByName: 'Cara Control', lateEvidenceAt: '2026-06-02T09:00:00.000Z' })] });
  renderer = await mount({ permissions: perms('viewer'), target: EXC_TARGET });
  const text = textOf(renderer.root);
  for (const want of ['Resolved', 'Patrol completed — late sync', 'by Rae Resolver', 'by Cara Control', '10:30', '10:10']) assert.ok(text.includes(want), `shows ${want}`);
  assert.ok(!/@/.test(text.replace(/s4cp:[^\s]*/g, '')), 'never an email');
  act(() => renderer.unmount());
});

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
  for (const route of ['/patrols/overview', '/patrols/windows/day', '/patrols/runs', '/patrols/exceptions', '/patrols/policies', '/patrols/schedules', '/patrols/checkpoints', '/patrols/routes', '/patrols/holds', '/patrols/storage-usage', '/patrols/exports', '/download', '/patrols/recovery-grants']) {
    assert.ok(apiSrc.includes(route), route);
  }
});

// ═══ P1-D corrections (#76, #77, #78) ═══

test('PM-21-ONE-CHECKPOINT-COUNT-IN-HISTORY-AND-DETAIL-76', async () => {
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

test('PM-22-SITE-LOCAL-DATES-FOR-HISTORY-AND-THE-OVERVIEW-77', async () => {
  // Pure: today at the site across the UK clock changes (BST ↔ GMT).
  const today = (instant) => P.siteTodayKey('Europe/London', new Date(instant));
  assert.equal(today('2025-10-25T22:59:59Z'), '2025-10-25', '23:59:59 BST');
  assert.equal(today('2025-10-25T23:00:00Z'), '2025-10-26', '00:00 BST: already the 26th (a UTC day would say the 25th)');
  assert.equal(today('2025-10-26T23:59:59Z'), '2025-10-26', '23:59:59 GMT: the 25-hour day');
  assert.equal(today('2025-03-29T23:59:00Z'), '2025-03-29', 'GMT');
  assert.equal(today('2025-03-30T22:59:00Z'), '2025-03-30', '23:59 BST: the 23-hour day');
  assert.equal(today('2025-03-30T23:00:00Z'), '2025-03-31', '00:00 BST on the 31st');
  assert.equal(P.siteTodayKey('America/New_York', new Date('2025-10-26T03:30:00Z')), '2025-10-25', "another site's own day");
  // The History filter: site dates, sent with the site-local basis; nothing half-typed is sent.
  assert.deepEqual(P.historyDateFilter('2025-10-26', '2025-10-26'), { from: '2025-10-26', to: '2025-10-26', dateBasis: 'site_local', problem: null });
  assert.deepEqual(P.historyDateFilter('', ''), { from: null, to: null, dateBasis: null, problem: null });
  assert.deepEqual(P.historyDateFilter('26-10-20', ''), { from: null, to: null, dateBasis: null, problem: null }, 'a half-typed date is not sent');
  assert.ok(P.historyDateFilter('2025-03-31', '2025-03-30').problem, 'a reversed range is said so');
  // Missed / abandoned today: an exception's day is its SITE's day when the overview is site-local.
  const exc = (id, createdAt) => ({ id, type: 'patrol_missed', createdAt, status: 'open', siteId: 10 });
  const excs = [exc(1, '2025-10-25T23:30:00Z'), exc(2, '2025-10-26T23:30:00Z'), exc(3, '2025-10-25T22:30:00Z')];
  const ov = (dateBasis) => ({ ...baseAnswers().getPatrolOverview, date: '2025-10-26', dateBasis });
  const missed = (dateBasis) => P.buildPatrolKpis({ overview: ov(dateBasis), exceptions: excs, todaysRuns: null, siteZone: () => 'Europe/London' }).find((k) => k.id === 'missed').value;
  assert.equal(missed('site_local'), '2', '00:30 BST and 23:30 GMT on the 26th; not 23:30 BST on the 25th');
  assert.equal(missed('utc'), '1', 'an older API answering on the UTC day is read on the UTC day');
  assert.equal(P.overviewDayBasisLabel({ dateBasis: 'site_local', timeZone: 'Europe/London' }, 'Europe/London', true), 'site-local day, Europe/London');
  assert.equal(P.overviewDayBasisLabel({ dateBasis: 'utc' }, 'Europe/London', false), 'UTC day');

  // The real page: the Overview asks for today's SITE day; History uses the dashboard's date picker.
  answers = baseAnswers();
  calls.length = 0;
  const renderer = await mount({ permissions: perms('viewer') });
  const londonToday = P.siteTodayKey('Europe/London');
  assert.deepEqual(calls.filter(([k]) => k === 'getPatrolOverview').map(([, a]) => a[0]).pop(), { siteId: null, date: londonToday, dateBasis: 'site_local' });
  const todays = calls.filter(([k]) => k === 'listPatrolRuns').map(([, a]) => a[0]).find((a) => a.from);
  assert.deepEqual([todays.from, todays.to, todays.dateBasis], [londonToday, londonToday, 'site_local'], "today's runs on the site day");
  assert.ok(textOf(renderer.root).includes("each site's local day"), 'the Overview names its day basis');
  assert.ok(!textOf(renderer.root).includes('UTC day'));
  await pressByText(renderer.root, 'History');
  const text = textOf(renderer.root);
  assert.ok(text.includes('From (site date)') && text.includes('To (site date)'), 'site dates');
  assert.ok(!/YYYY-MM-DD|UTC\)/.test(text), 'no UTC text box any more');
  const input = (label) => renderer.root.findAll((n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onChangeText === 'function')[0];
  assert.ok(input('From date') && input('To date'), 'the shared NativeDateInput picker');
  await act(async () => { input('From date').props.onChangeText('26-10-2025'); });
  await settle();
  await act(async () => { input('To date').props.onChangeText('26-10-2025'); });
  await settle();
  const last = calls.filter(([k]) => k === 'listPatrolRuns').map(([, a]) => a[0]).pop();
  assert.deepEqual([last.from, last.to, last.dateBasis, last.page], ['2025-10-26', '2025-10-26', 'site_local', 1], 'DD-MM-YYYY in, the site date and basis out');
  await act(async () => { input('From date').props.onChangeText('27-10-2025'); });
  await settle();
  assert.ok(textOf(renderer.root).includes('The "From" date is after the "To" date'));
  act(() => renderer.unmount());
  // Nothing in Patrol Management reads a day off a UTC string any more.
  const dir = path.join(ROOT, 'src/components/patrols');
  for (const file of fs.readdirSync(dir)) {
    const src = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.doesNotMatch(src, /utcDateKey|\(YYYY-MM-DD, UTC\)/, file);
  }
});

test('PM-23-WINDOWS-DUE-TODAY-FROM-THE-BACKEND-78', async () => {
  const windows = baseAnswers().getPatrolWindowsDay;
  const kpis = Object.fromEntries(P.buildPatrolKpis({ overview: null, exceptions: null, todaysRuns: null, windows }).map((k) => [k.id, k]));
  assert.deepEqual(['windows-due', 'windows-completed', 'windows-outstanding'].map((id) => [kpis[id].value, kpis[id].available]), [['8', true], ['3', true], ['5', true]], 'exactly the server figures');
  assert.equal(kpis['windows-outstanding'].tone, 'warning');
  // A malformed or absent answer is not available — never a guess, never a zero.
  for (const bad of [null, undefined, [], { windowsDue: 8 }, { windowsDue: 'x', windowsCompleted: 0, windowsOutstanding: 0 }]) {
    const k = P.buildPatrolKpis({ overview: null, exceptions: null, todaysRuns: null, windows: bad }).find((x) => x.id === 'windows-due');
    assert.deepEqual([k.value, k.available], ['—', false], JSON.stringify(bad));
  }
  // The real Overview asks for today's SITE day, for the chosen site, and shows the three figures.
  answers = baseAnswers();
  calls.length = 0;
  let renderer = await mount({ permissions: perms('viewer') });
  assert.deepEqual(calls.filter(([k]) => k === 'getPatrolWindowsDay').map(([, a]) => a[0]).pop(), { siteId: null, date: P.siteTodayKey('Europe/London') });
  const shown = textOf(renderer.root);
  assert.match(shown, /Windows due today◎8/);
  assert.match(shown, /Windows completed today◎3/);
  assert.match(shown, /Windows outstanding today◎5/);
  await pressByText(renderer.root, 'Site: Alpha Site');
  assert.equal(calls.filter(([k]) => k === 'getPatrolWindowsDay').map(([, a]) => a[0]).pop().siteId, 10, 'site-scoped');
  act(() => renderer.unmount());
  // The endpoint failing (e.g. not permitted) leaves the figures "Not available", the rest of the Overview intact.
  answers = baseAnswers({ getPatrolWindowsDay: () => { throw new api.ApiError(403, 'Forbidden', { code: 'PATROL_FORBIDDEN', message: 'Insufficient permissions.' }); } });
  renderer = await mount({ permissions: perms('viewer') });
  assert.match(textOf(renderer.root), /Windows due today◎—Not available/);
  assert.match(textOf(renderer.root), /Completed today◎2/);
  act(() => renderer.unmount());
  // The client calls the backend read; it never derives windows from schedules itself.
  assert.ok(read('src/services/api.ts').includes('`/patrols/windows/day${patrolQuery(params)}`'));
  const overviewSrc = stripComments(read('src/components/patrols/PatrolOverviewTab.tsx'));
  assert.doesNotMatch(overviewSrc, /listPatrolSchedules|frequencyMinutes|activeFrom/, 'no client-side window arithmetic');
  const controller = read('../security-backend-nest/src/patrol/patrol-config.controller.ts');
  assert.ok(controller.includes("@Get('windows/day')"));
  const service = read('../security-backend-nest/src/patrol/patrol-windows-day.service.ts');
  assert.ok(service.includes('this.access.companyActor(user, CompanyPermission.PATROLS_VIEW)') && service.includes('this.windows.windowsBetween('), 'patrols.view; the P1-B engine');
});

// ═══ S4 1.3.0 B2: dashboard usability ═══

function setupCheckpoint(id, label, confirmed) {
  return { id, siteId: 10, publicId: 'x'.repeat(32), label, description: null, tokenVersion: 1, photoRequired: false, active: true, rotatedAt: null, revokedAt: null,
    createdAt: null, updatedAt: null, confirmed, confirmedAt: confirmed ? iso(NOW - 3_600_000) : null, confirmedByUserId: confirmed ? 1 : null,
    confirmedTokenVersion: confirmed ? 1 : null, onCurrentRoute: confirmed };
}
function setupView(over = {}) {
  return {
    siteId: 10, siteName: 'Alpha Site', timezone: 'Europe/London', setupMode: 'every_shift', evidenceMode: 'qr', frequencyMinutes: 60, windowAnchor: 'scheduled_start',
    active: false, confirmedAt: null, confirmedByUserId: null, policy: {}, schedule: { id: 7 },
    route: { mode: 'auto', scheduleRouteId: 40, versions: 1, currentVersion: { id: 40, kind: 'auto', name: 'Every confirmed checkpoint', createdAt: iso(NOW), checkpoints: [] } },
    checkpoints: [setupCheckpoint(1, 'Gate 1', false), setupCheckpoint(2, 'Gate 2', false)],
    checklist: [
      { code: 'setup_mode', ok: true, text: 'Choose which shifts patrol: every shift, or only shifts marked as requiring patrols.' },
      { code: 'frequency', ok: true, text: 'Set how often a patrol is due during a shift.' },
      { code: 'confirmed_checkpoints', ok: false, text: 'Site setup incomplete: no confirmed checkpoints. Test-scan at least one printed checkpoint label.' },
    ],
    ready: false,
    warnings: [
      { code: 'CHECKPOINTS_NOT_CONFIRMED', message: '2 checkpoints have not been test-scanned and are not part of the automatic route: Gate 1, Gate 2.' },
      { code: 'SETUP_NOT_ACTIVE', message: 'Saved but not active: confirm the setup to start shift patrols.' },
    ],
    ...over,
  };
}
function readyView(over = {}) {
  return setupView({
    checkpoints: [setupCheckpoint(1, 'Gate 1', true), setupCheckpoint(2, 'Gate 2', false)],
    route: { mode: 'auto', scheduleRouteId: 41, versions: 2, currentVersion: { id: 41, kind: 'auto', name: 'Every confirmed checkpoint', createdAt: iso(NOW), checkpoints: [{ checkpointId: 1, label: 'Gate 1', required: true, position: 1 }] } },
    checklist: setupView().checklist.map((c) => ({ ...c, ok: true })),
    ready: true,
    warnings: [{ code: 'CHECKPOINTS_NOT_CONFIRMED', message: '1 checkpoint has not been test-scanned and is not part of the automatic route: Gate 2.' }],
    ...over,
  });
}
const disabled = (root, label) => {
  const nodes = pressables(root, label);
  assert.ok(nodes.length > 0, `a "${label}" control`);
  return nodes.some((n) => n.props.disabled === true || n.props.accessibilityState?.disabled === true);
};

test('PM-37-PRIMARY-NAVIGATION-SETUP-TODAY-EVIDENCE-AND-ADVANCED-KEEPS-EVERY-TAB', async () => {
  assert.deepEqual(access.PATROL_SECTIONS.map((s) => s.label), ['Setup', 'Today', 'Evidence', 'Advanced']);
  assert.deepEqual(access.visiblePatrolSections(perms('viewer')), ['setup', 'today', 'evidence', 'advanced']);
  assert.deepEqual(access.visiblePatrolSections(perms('guard')), []);
  for (const role of ['owner', 'viewer']) {
    answers = baseAnswers();
    calls.length = 0;
    const p = perms(role);
    const renderer = await mountPrimary({ permissions: p });
    const root = renderer.root;
    for (const label of ['Setup', 'Today', 'Evidence', 'Advanced']) assert.ok(has(root, label), `${role}: ${label}`);
    // Today: the day's figures and live patrols, without the Advanced tab row.
    assert.match(textOf(root), /Windows due today◎8/, 'Today opens with the overview');
    assert.ok(textOf(root).includes('Live patrols') && textOf(root).includes('2 of 4 checkpoints'), 'and live patrols');
    assert.equal(has(root, 'Schedules'), false, 'the earlier tabs are not on the primary row');
    // Advanced: every earlier tab, by the same permission rules.
    await pressByText(root, 'Advanced');
    for (const tab of access.PATROL_TABS) {
      assert.equal(has(root, tab.label), access.visiblePatrolTabs(p).includes(tab.id), `${role}: Advanced → ${tab.label}`);
    }
    await pressByText(root, 'Downloads, retention & holds');
    assert.equal(has(root, 'Request export'), p.canManageHolds, `${role}: exports still reachable`);
    await pressByText(root, 'Today');
    assert.equal(has(root, 'Schedules'), false);
    act(() => renderer.unmount());
  }
  // A record opened from Live Operations still lands on its tab (History) under Advanced.
  answers = baseAnswers();
  const target = await mountPrimary({ permissions: perms('owner'), target: { requestId: 9, kind: 'run', runId: 5 } });
  assert.ok(has(target.root, 'History') && textOf(target.root).includes('Patrol #5'));
  act(() => target.unmount());
  // Mobile width: the same three sections and Advanced.
  answers = baseAnswers();
  const narrow = await mountPrimary({ permissions: perms('owner'), layoutWidth: 390 });
  for (const label of ['Setup', 'Today', 'Evidence', 'Advanced']) assert.ok(has(narrow.root, label));
  act(() => narrow.unmount());
});

test('PM-38-SETUP-CHECKLIST-GATES-ACTIVATE-AND-422-READS-IN-PLAIN-ENGLISH', async () => {
  answers = baseAnswers({ getPatrolSiteSetup: setupView() });
  calls.length = 0;
  let renderer = await mountPrimary({ permissions: perms('owner') });
  await pressByText(renderer.root, 'Setup');
  const root = renderer.root;
  assert.deepEqual(calls.filter(([k]) => k === 'getPatrolSiteSetup').map(([, a]) => a[0]), [10], 'the first site, by default');
  let text = textOf(root);
  for (const label of ['QR only', 'Photos only', 'QR + Photos', 'Every hour', 'From the scheduled start', 'From Book On', 'Every shift', 'Only shifts marked Required']) {
    assert.ok(has(root, label), label);
  }
  assert.doesNotMatch(text, /photos per|number of photos|photo count/i, 'no photo-count setting');
  assert.ok(text.includes('Site setup incomplete: no confirmed checkpoints. Test-scan at least one printed checkpoint label.'), 'the failed item, as the server words it');
  assert.ok(text.includes('2 checkpoints have not been test-scanned'), 'the warning');
  assert.ok(text.includes('Not test-scanned'));
  assert.equal(disabled(root, 'Activate patrols'), true, 'Activate disabled while the checklist fails');
  assert.ok(text.includes('Activate is available once every checklist item is ticked.'));
  // An edit: "save first", and Activate stays disabled; Save sends exactly the setup (no photo count, no route id for auto).
  answers.savePatrolSiteSetup = (siteId, body) => readyView({ windowAnchor: body.windowAnchor });
  await pressByText(root, 'From Book On');
  assert.ok(textOf(root).includes('Save your changes before activating.'));
  await pressByText(root, 'Every 2 hours');
  await pressByText(root, 'Save setup');
  const save = calls.filter(([k]) => k === 'savePatrolSiteSetup').pop();
  assert.deepEqual(save[1], [10, { setupMode: 'every_shift', evidenceMode: 'qr', frequencyMinutes: 120, windowAnchor: 'book_on' }]);
  // Frequency validation in plain English (Other → a bad value).
  await pressByText(root, 'Other');
  await typeInto(root, 'Minutes between patrols', '5');
  assert.ok(textOf(root).includes('A patrol can be due at most every 15 minutes.'));
  assert.equal(disabled(root, 'Save setup'), true);
  act(() => renderer.unmount());

  // Ready: the summary, and Activate enabled; the server's 422 is shown in plain English.
  answers = baseAnswers({
    getPatrolSiteSetup: readyView(),
    activatePatrolSiteSetup: () => { throw new api.ApiError(422, 'Unprocessable Entity', { code: 'PATROL_SETUP_INCOMPLETE', message: 'x', details: { checklist: [{ code: 'confirmed_checkpoints', ok: false, text: 'Site setup incomplete: no confirmed checkpoints. Test-scan at least one printed checkpoint label.' }] } }); },
  });
  calls.length = 0;
  renderer = await mountPrimary({ permissions: perms('operations') });
  await pressByText(renderer.root, 'Setup');
  text = textOf(renderer.root);
  assert.ok(text.includes('Ready to activate'));
  assert.ok(text.includes('Every shift at Alpha Site will patrol, unless a shift is marked "Not Required" in the Rota Planner.'));
  assert.ok(text.includes('A patrol is due every hour, counted from the shift\'s scheduled start.'));
  assert.ok(text.includes('Evidence: QR scans of 1 test-scanned checkpoint (Gate 1).'));
  assert.equal(disabled(renderer.root, 'Activate patrols'), false, 'enabled once every item passes');
  await pressByText(renderer.root, 'Activate patrols');
  assert.ok(calls.some(([k, a]) => k === 'activatePatrolSiteSetup' && a[0] === 10));
  assert.ok(textOf(renderer.root).includes('Not activated yet. Still to do: Site setup incomplete: no confirmed checkpoints.'), 'the 422, in plain English');
  assert.doesNotMatch(textOf(renderer.root), /PATROL_SETUP_INCOMPLETE|422/);
  act(() => renderer.unmount());

  // A Viewer reads the setup; no Save, no Activate, no test scan.
  answers = baseAnswers({ getPatrolSiteSetup: readyView() });
  renderer = await mountPrimary({ permissions: perms('viewer') });
  await pressByText(renderer.root, 'Setup');
  for (const label of ['Save setup', 'Activate patrols', 'Test scan Gate 2', 'Prepare labels', 'Add checkpoint']) assert.equal(has(renderer.root, label), false, `viewer: no ${label}`);
  act(() => renderer.unmount());
  // The setup wording mirrors the server's.
  const svc = read('../security-backend-nest/src/patrol/patrol-shift-requirement.ts');
  const S = loadSource('src/components/patrols/patrolSetupText.ts');
  assert.ok(svc.includes("'Site default: no patrols (patrols are not set up for this site).'"));
  assert.equal(S.siteDefaultSummary('every_shift', true, 60, 'scheduled_start'), 'Site default: every shift patrols, every hour, from the scheduled start.');
  assert.equal(S.siteDefaultSummary('per_shift', true, 90, 'book_on'), 'Site default: only shifts marked "Required" patrol, every 90 minutes, from Book On.');
});

test('PM-39-TEST-SCAN-CONFIRMS-AND-LABELS-PRINT-FROM-SERVER-PAYLOADS', async () => {
  answers = baseAnswers({
    getPatrolSiteSetup: setupView(),
    getPatrolCheckpointLabel: (id) => ({ checkpointId: id, siteId: 10, publicId: 'x'.repeat(32), label: `Gate ${id}`, tokenVersion: 1, keyId: 'k1', payload: LABEL_PAYLOAD }),
    confirmPatrolCheckpoint: () => { throw new api.ApiError(422, 'Unprocessable Entity', { code: 'PATROL_CHECKPOINT_TEST_SCAN_INVALID', message: 'This label belongs to another checkpoint.', details: { reason: 'wrong_checkpoint' } }); },
  });
  calls.length = 0;
  const renderer = await mountPrimary({ permissions: perms('owner') });
  const root = renderer.root;
  await pressByText(root, 'Setup');
  await pressByText(root, 'Prepare labels');
  assert.deepEqual(calls.filter(([k]) => k === 'getPatrolCheckpointLabel').map(([, a]) => a[0]), [1, 2]);
  assert.equal(root.findAll((n) => n.props && n.props.testID === 'patrol-qr').length >= 2, true, 'the QR of each server label');
  assert.equal(disabled(root, 'Print labels (2)'), false);
  // A refused test scan: plain English, nothing confirmed.
  await pressByText(root, 'Test scan Gate 1');
  await pressByText(root, 'Confirm scan');
  assert.ok(textOf(root).includes('Scan the printed label (or paste what the scanner read) first.'));
  await typeInto(root, 'Test scan of "Gate 1"', LABEL_PAYLOAD);
  await pressByText(root, 'Confirm scan');
  const confirm = calls.filter(([k]) => k === 'confirmPatrolCheckpoint').pop();
  assert.deepEqual(confirm[1], [1, { scanPayload: LABEL_PAYLOAD, siteId: 10 }]);
  assert.ok(textOf(root).includes('That scan was not accepted: This label belongs to another checkpoint.'));
  // Accepted: confirmed and re-read.
  answers.confirmPatrolCheckpoint = (id) => ({ ...setupCheckpoint(id, 'Gate 1', true) });
  answers.getPatrolSiteSetup = readyView();
  await pressByText(root, 'Confirm scan');
  assert.ok(textOf(root).includes('"Gate 1" confirmed: the label scans correctly and it is part of the patrol route.'));
  assert.ok(textOf(root).includes('Ready to activate'));
  assert.ok(!logged.some((l) => l.includes(LABEL_PAYLOAD)), 'a label payload is never logged');
  act(() => renderer.unmount());
});

function evidenceCard(over = {}) {
  return {
    reference: 'P-5', run: run({ status: 'completed', verificationStatus: 'verified' }),
    window: { scheduleId: 7, scheduleName: 'Shift patrol', anchor: 'shift', windowKey: 'sh1', start: iso(NOW - 60 * MIN), end: iso(NOW), label: '09:00–10:00' },
    guard: { id: 11, displayName: 'Ava Guard' }, photoCount: 0, photosRestricted: false, photos: [], thumbnailsPath: null,
    qrScans: [{ id: 1, checkpointId: 1, label: 'Gate 1', result: 'verified', flags: [], scannedAtDevice: iso(NOW - 50 * MIN), receivedAtServer: iso(NOW - 50 * MIN) }],
    verification: { status: 'verified', code: 'verified', text: 'Verified: every required checkpoint was scanned in the patrol window.', deadline: null },
    ...over,
  };
}
const PHOTO_CARD = evidenceCard({
  reference: 'P-6', run: run({ id: 6, guardId: 12, status: 'completed', verificationStatus: 'pending' }), guard: { id: 12, displayName: 'Ben Guard' }, photoCount: 1, qrScans: [],
  photos: [{ id: 900, kind: 'run_photo', uploadStatus: 'verified', retentionStatus: 'active', capturedAtDevice: iso(NOW - 40 * MIN), receivedAt: iso(NOW - 39 * MIN), verifiedAt: iso(NOW - 39 * MIN), viewable: true, stampedPath: '/patrols/evidence/900/stamped' }],
  verification: { status: 'pending', code: 'awaiting_photo', text: 'Waiting for the photo to finish uploading from the phone.', deadline: null },
});
const STAMPED_URI = 'data:image/jpeg;base64,U1RBTVBFRC1CWVRFUw==';
function evidenceAnswers(over = {}) {
  const day = LONDON_TODAY;
  return baseAnswers({
    getPatrolEvidenceTree: { from: day, to: day, dateBasis: 'site_local', clients: [{ clientId: 3, clientName: 'Harbour Estates', sites: [
      { siteId: 10, siteName: 'Alpha Site', timezone: 'Europe/London', patrols: 2, withPhotos: 1, days: [{ date: day, patrols: 2, withPhotos: 1, withoutPhotos: 1 }] }] }] },
    getPatrolEvidencePatrols: (q) => ({ siteId: 10, siteName: 'Alpha Site', clientName: 'Harbour Estates', timezone: 'Europe/London', date: q.date, dayStart: iso(NOW), dayEnd: iso(NOW),
      photos: q.photos === 'only' ? 'only' : 'all', evidenceRestricted: false, patrols: q.photos === 'only' ? [PHOTO_CARD] : [evidenceCard(), PHOTO_CARD] }),
    getPatrolEvidenceStampedImage: (id) => ({ evidenceId: id, dataUri: STAMPED_URI }),
    getPatrolEvidenceLink: (id) => ({ evidenceId: id, url: SIGNED_URL, expiresAt: iso(Date.now() + 120_000) }),
    ...over,
  });
}

test('PM-40-EVIDENCE-CLIENT-SITE-DATE-TIME-GUARD-QR-ONLY-INCLUDED-AND-PHOTOS-ONLY', async () => {
  answers = evidenceAnswers();
  calls.length = 0;
  const renderer = await mountPrimary({ permissions: perms('control_room') });
  const root = renderer.root;
  await pressByText(root, 'Evidence');
  assert.ok(calls.some(([k]) => k === 'getPatrolEvidenceTree'));
  let text = textOf(root);
  assert.ok(text.includes('Harbour Estates'), 'client');
  await pressByText(root, 'Site Alpha Site');
  await pressByText(root, `Alpha Site ${LONDON_TODAY}`);
  const first = calls.filter(([k]) => k === 'getPatrolEvidencePatrols').pop();
  assert.deepEqual(first[1][0], { siteId: 10, date: LONDON_TODAY, photos: 'all' });
  text = textOf(root);
  assert.ok(text.includes('09:00–10:00 · Shift patrol'), 'patrol time');
  assert.ok(text.includes('Ava Guard') && text.includes('Ben Guard'), 'guards under it');
  assert.ok(text.includes('P-5 · 1 QR scan · 0 photos'), 'the QR-only patrol is listed by default');
  await pressByText(root, 'Open P-5 Ava Guard');
  text = textOf(root);
  assert.ok(text.includes('Verified: every required checkpoint was scanned in the patrol window.'), 'explainVerification');
  assert.ok(text.includes('Gate 1') && text.includes('No photos in this patrol.'));
  await pressByText(root, 'Photos only');
  const only = calls.filter(([k]) => k === 'getPatrolEvidencePatrols').pop();
  assert.equal(only[1][0].photos, 'only');
  text = textOf(root);
  assert.ok(!text.includes('P-5 ·') && text.includes('P-6 · 0 QR scans · 1 photo'), 'Photos only keeps patrols with a photo');
  assert.ok(P.verificationLabel('pending') && text.includes('Awaiting verification'));
  act(() => renderer.unmount());
  const E = loadSource('src/components/patrols/PatrolEvidenceBrowser.tsx');
  assert.equal(E.minusDays('2026-03-01', 1), '2026-02-28');
  const groups = E.patrolTimeGroups([evidenceCard(), PHOTO_CARD, evidenceCard({ reference: 'P-7', window: null, run: run({ id: 7, startedAtServer: '2026-11-01T12:34:00Z' }) })], 'Europe/London');
  assert.deepEqual(groups.map((g) => g.label).sort(), ['09:00–10:00 · Shift patrol', 'Unscheduled · started 12:34'], 'one group per patrol time');
  assert.deepEqual(groups.find((g) => g.label.startsWith('09:00')).cards.map((c) => c.guard.displayName), ['Ava Guard', 'Ben Guard'], 'the Guards under one time');
});

test('PM-41-EVIDENCE-ORIGINAL-VS-STAMPED-NO-LINK-IN-TEXT-LOGS-OR-STORAGE', async () => {
  answers = evidenceAnswers();
  calls.length = 0;
  storageWrites.length = 0;
  const before = logged.length;
  const renderer = await mountPrimary({ permissions: perms('owner') });
  const root = renderer.root;
  await pressByText(root, 'Evidence');
  await pressByText(root, 'Site Alpha Site');
  await pressByText(root, `Alpha Site ${LONDON_TODAY}`);
  await pressByText(root, 'Open P-6 Ben Guard');
  assert.ok(has(root, 'Original') && has(root, 'Stamped'));
  assert.equal(calls.some(([k]) => k === 'getPatrolEvidenceLink' || k === 'getPatrolEvidenceStampedImage'), false, 'nothing fetched before a press');
  // Original: the existing audited link, with the reason.
  await pressByText(root, 'Investigation');
  await pressByText(root, 'View original');
  assert.deepEqual(calls.filter(([k]) => k === 'getPatrolEvidenceLink').map(([, a]) => a), [[900, 'investigation']]);
  const original = root.findAll((n) => n.props && n.props.accessibilityLabel === 'Patrol photo 900 (original)' && n.props.source)[0];
  assert.equal(original.props.source.uri, SIGNED_URL);
  // Stamped: derived by the server, no link of any kind.
  await pressByText(root, 'Stamped');
  assert.equal(root.findAll((n) => n.props && n.props.accessibilityLabel === 'Patrol photo 900 (original)').length, 0, 'switching drops the original');
  assert.ok(textOf(root).includes('www.sfour.co.uk printed on it'));
  await pressByText(root, 'View stamped');
  assert.deepEqual(calls.filter(([k]) => k === 'getPatrolEvidenceStampedImage').map(([, a]) => a), [[900]]);
  assert.equal(calls.filter(([k]) => k === 'getPatrolEvidenceLink').length, 1, 'the stamped view asks for no link');
  const stamped = root.findAll((n) => n.props && n.props.accessibilityLabel === 'Patrol photo 900 (stamped)' && n.props.source)[0];
  assert.equal(stamped.props.source.uri, STAMPED_URI);
  const shown = textOf(root);
  assert.ok(!shown.includes(SIGNED_URL) && !shown.includes('data:image') && !shown.includes('X-Amz'), 'no link or image data as text');
  assert.ok(!logged.slice(before).some((l) => l.includes(SIGNED_URL) || l.includes('data:image')), 'nothing logged');
  assert.ok(!storageWrites.some(([, v]) => String(v).includes(SIGNED_URL) || String(v).includes('data:image')), 'nothing stored');
  act(() => renderer.unmount());
  // A Viewer: patrols listed, photos restricted, no photo request of any kind.
  answers = evidenceAnswers({ getPatrolEvidencePatrols: (q) => ({ ...evidenceAnswers().getPatrolEvidencePatrols(q), evidenceRestricted: true,
    patrols: [{ ...PHOTO_CARD, photos: null, photosRestricted: true }] }) });
  calls.length = 0;
  const viewer = await mountPrimary({ permissions: perms('viewer') });
  await pressByText(viewer.root, 'Evidence');
  await pressByText(viewer.root, 'Site Alpha Site');
  await pressByText(viewer.root, `Alpha Site ${LONDON_TODAY}`);
  await pressByText(viewer.root, 'Open P-6 Ben Guard');
  assert.ok(textOf(viewer.root).includes('Photos are visible to Owner, Admin, Operations and Control Room.'));
  assert.equal(has(viewer.root, 'View original') || has(viewer.root, 'View stamped'), false);
  assert.equal(calls.some(([k]) => /EvidenceLink|Stamped|Thumbnails/.test(k)), false);
  act(() => viewer.unmount());
  // The client fetches the stamped photo with the session and never builds a link to it.
  const apiSrc = stripComments(read('src/services/api.ts'));
  assert.ok(apiSrc.includes('const path = `/patrols/evidence/${evidenceId}/stamped`;') && apiSrc.includes('reader.readAsDataURL(blob)'));
  const browser = stripComments(read('src/components/patrols/PatrolEvidenceBrowser.tsx'));
  assert.doesNotMatch(browser, /console\.|localStorage|sessionStorage|AsyncStorage|stampedPath/, 'no logging, storage, or client-built links');
});

test('PM-42-ROTA-PLANNER-PATROL-REQUIREMENT-ROUND-TRIP-DEFAULT-PRESERVED', async () => {
  const { CompanyRotaPlannerWorkspace } = loadSource('src/components/company/CompanyRotaPlannerWorkspace.tsx');
  const HOUR = 60 * MIN;
  const view = (value, summary) => ({ value, effectiveRequired: value === 'required' ? true : value === 'not_required' ? false : true, source: value === 'site_default' ? 'site' : 'shift', summary,
    site: { setupMode: 'every_shift', active: true, frequencyMinutes: 60, windowAnchor: 'scheduled_start', summary: 'Site default: every shift patrols, every hour, from the scheduled start.' } });
  const detail = (patrolRequirement) => ({
    id: 500, siteId: 10, siteName: 'Northgate', clientId: null, clientName: null, jobId: null, title: null,
    startAt: iso(NOW + 26 * HOUR), endAt: iso(NOW + 34 * HOUR), requiredGuardCount: 1, checkCallIntervalMinutes: 60, instructions: null, status: 'active',
    coveragePhase: 'future', coverageState: 'open', counts: { required: 1, assigned: 0, confirmed: 0, offered: 0, open: 1, problem: 0, onShift: 0, completed: 0 },
    createdAt: iso(NOW), updatedAt: iso(NOW), positions: [{ shiftId: 111, guardId: null, guardName: null, status: 'unfilled' }],
    ...(patrolRequirement ? { patrolRequirement } : {}),
  });
  const emptyDay = { slots: [] };
  const SITES = [{ siteId: 10, siteName: 'Northgate', clientId: null, clientName: null, days: {
    monday: { slots: [{ slotId: 500, title: null, startAt: iso(NOW + 26 * HOUR), endAt: iso(NOW + 34 * HOUR), isNightShift: false, coveragePhase: 'future', coverageState: 'open',
      counts: { required: 1, assigned: 0, confirmed: 0, offered: 0, open: 1, problem: 0, onShift: 0, completed: 0 }, positions: [] }] },
    tuesday: emptyDay, wednesday: emptyDay, thursday: emptyDay, friday: emptyDay, saturday: emptyDay, sunday: emptyDay } }];
  const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((label, i) => ({ date: `2026-11-${String(2 + i).padStart(2, '0')}`, label, shortLabel: label.slice(0, 3) }));
  const mountRota = async (props) => {
    const seen = { saved: [], created: [] };
    const noop = () => undefined;
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(h(CompanyRotaPlannerWorkspace, {
        plannerClientId: '', plannerSiteId: '10', setPlannerClientId: noop, setPlannerSiteId: noop, siteClientOptions: [], plannerSiteOptions: [{ label: 'Northgate', value: '10' }],
        weekCommencing: '2026-11-02', weekEnding: '2026-11-08', plannerWeekDays: WEEK, onPrevWeek: noop, onNextWeek: noop, onTodayWeek: noop,
        sites: SITES, slotsByDayName: new Map(), weekSnapshot: null, loadingRota: false, rotaError: null, onRetryLoadRota: noop, onRefreshWeek: noop, legacyShiftsByDate: new Map(),
        onLoadSlot: async () => props.detail,
        onCreateSlot: async (payload) => { seen.created.push(payload); return props.detail; },
        onSaveSlotEdits: async (id, changes) => { seen.saved.push([id, changes]); return detail(view(changes.patrolRequirement ?? 'site_default', 'Patrols required (set on this shift).')); },
        onAssignPosition: async () => props.detail, onAssignMultiple: async () => ({ result: { assigned: [], failed: [] }, detail: props.detail }),
        onCancelPosition: async () => props.detail, onCancelSlot: async () => undefined, onGetEligibleGuards: async () => [], resolveSiteZone: () => 'Europe/London',
        ...props,
      }));
    });
    await settle();
    return { renderer, seen };
  };
  const openSlot = async (renderer) => {
    const card = renderer.root.findAll((n) => typeof n.type === 'function' && n.type.name === 'SlotMiniCard')[0];
    assert.ok(card, 'the week shows the slot');
    await act(async () => { await card.props.onPress(); });
    await settle();
  };

  // The drawer shows the value, its effect and the site default with its frequency.
  let { renderer, seen } = await mountRota({ patrolsEnabled: true, detail: detail(view('site_default', 'Patrols required (site default: every shift).')) });
  await openSlot(renderer);
  let text = textOf(renderer.root);
  assert.ok(text.includes('Patrol Requirement') && text.includes('Use Site Default'));
  assert.ok(text.includes('Patrols required (site default: every shift).'));
  assert.ok(text.includes('Site default: every shift patrols, every hour, from the scheduled start.'), 'site policy and frequency');
  // Edit without touching it: nothing patrol-related is sent (the default is preserved).
  await pressByText(renderer.root, 'Edit');
  for (const label of ['Use Site Default', 'Required', 'Not Required']) assert.ok(has(renderer.root, `Patrol Requirement: ${label}`), label);
  await pressByText(renderer.root, 'Save Changes');
  assert.deepEqual(seen.saved, [], 'no change, no request');
  // Choose Required: exactly that change is sent, and the answer is shown.
  await pressByText(renderer.root, 'Edit');
  await pressByText(renderer.root, 'Patrol Requirement: Required');
  await pressByText(renderer.root, 'Save Changes');
  assert.deepEqual(seen.saved, [[500, { patrolRequirement: 'required' }]]);
  assert.ok(textOf(renderer.root).includes('Patrols required (set on this shift).'));
  act(() => renderer.unmount());

  // Create: the field defaults to Use Site Default (nothing sent); an explicit choice is sent.
  for (const [choice, expected] of [[null, undefined], ['Not Required', 'not_required']]) {
    ({ renderer, seen } = await mountRota({ patrolsEnabled: true, createShiftIntent: 1, detail: detail(view('site_default', 'x')),
      onLoadSitePatrolDefault: async (siteId) => (siteId === 10 ? 'Site default: every shift patrols, every hour, from the scheduled start.' : null) }));
    await settle();
    assert.ok(textOf(renderer.root).includes('Site default: every shift patrols, every hour, from the scheduled start.'), 'the create form shows the site default');
    const byName = (name) => renderer.root.findAll((n) => typeof n.type === 'function' && n.type.name === name);
    await act(async () => { byName('NativeDateInput')[0].props.onChange('2026-12-02'); });
    const times = byName('NativeTimeInput');
    await act(async () => { times[0].props.onChange('08:00'); times[1].props.onChange('16:00'); });
    await settle();
    if (choice) await pressByText(renderer.root, `Patrol Requirement: ${choice}`);
    await pressByText(renderer.root, 'Create Shift');
    assert.equal(seen.created.length, 1, 'created');
    assert.equal(seen.created[0].patrolRequirement, expected, `create sends ${expected ?? 'nothing'}`);
    if (!choice) assert.equal('patrolRequirement' in seen.created[0], false, 'Use Site Default: the payload is exactly as before');
    act(() => renderer.unmount());
  }

  // Patrols off: no field, no value, no site-default read.
  let reads = 0;
  ({ renderer, seen } = await mountRota({ patrolsEnabled: false, detail: detail(null), onLoadSitePatrolDefault: async () => { reads += 1; return 'x'; } }));
  await openSlot(renderer);
  assert.equal(textOf(renderer.root).includes('Patrol Requirement'), false);
  await pressByText(renderer.root, 'Edit');
  assert.equal(has(renderer.root, 'Patrol Requirement: Required'), false);
  act(() => renderer.unmount());
  assert.equal(reads, 0);
  // The dashboard sends it with the metadata edit, only when present.
  const screen = stripComments(read('src/screens/CompanyDashboardScreen.tsx'));
  assert.ok(screen.includes('...(patrolRequirement !== undefined ? { patrolRequirement } : {}),'));
  assert.ok(screen.includes('patrolsEnabled={patrolPermissions.canView}'));
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
