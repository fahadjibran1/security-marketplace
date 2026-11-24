/**
 * S4-EM-01 — the two-tap Emergency, executed.
 *
 *   EM-M01  one press sends exactly one request: type panic, critical, the Guard's live shift, the standard body
 *   EM-M02  no live shift: nothing is sent, and the Guard is told why
 *   EM-M03  the receipt: received / duplicate / an older backend without a receipt; a 2xx without an id is NOT received
 *   EM-M04  failures: offline, session ended, refused (S4's own words), server error — each says NOT sent and 999
 *   EM-M05  nothing ever claims the Control Room received or acknowledged it; acknowledgement only from the alert itself
 *   EM-M06  layout: SEND is a large target on small and large phones; nothing needs scrolling
 *   EM-M07  rendered: full screen, no ScrollView, no text input, SEND + separate Cancel, 999 notice, accessible labels
 *   EM-M08  rendered: a fast double tap sends once; the received screen; Cancel sends nothing
 *   EM-M09  rendered: offline → NOT sent → TRY AGAIN sends again; the follow-up read shows a real acknowledgement
 *   EM-M10  the action-form model: Emergency needs no words and no confirmation word anywhere
 *   EM-M11  Live Operations: active Emergencies first (unacknowledged, then acknowledged), the rest newest first
 *   EM-M12  the dashboard opens the full-screen confirmation; the typed SOS form is gone
 */
const Module = require('node:module');
const originalLoad = Module._load;
const RNW = require('react-native-web');
const React = require('react');

function TestModal({ visible, children, presentationStyle }) {
  return visible ? React.createElement('test-modal', { presentationStyle }, children) : null;
}
const TestTextInput = (props) => React.createElement('test-text-input', props);
const RN_SHIM = { ...RNW, Modal: TestModal, TextInput: TestTextInput };
Module._load = function (request, ...rest) {
  if (request === 'react-native') return RN_SHIM;
  if (request === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) };
  return originalLoad.call(this, request, ...rest);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const TestRenderer = require('react-test-renderer');
const { loadTs, ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(rounds = 20) { for (let i = 0; i < rounds; i += 1) await tick(); }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const codeOf = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

/** Loads a .ts/.tsx with React JSX and esModuleInterop, resolving relative imports (as guard-home-ux01.spec.cjs). */
function loadComponent(rel) {
  const cache = new Map();
  const resolveRelative = (fromFile, request) => {
    const b = path.resolve(path.dirname(fromFile), request);
    for (const c of [b, `${b}.ts`, `${b}.tsx`, path.join(b, 'index.ts'), path.join(b, 'index.tsx')]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
  };
  const load = (abs) => {
    if (cache.has(abs)) return cache.get(abs).exports;
    const out = ts.transpileModule(fs.readFileSync(abs, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const mod = { exports: {} };
    cache.set(abs, mod);
    const req = (request) => {
      if (request.startsWith('.')) {
        const resolved = resolveRelative(abs, request);
        if (resolved) return load(resolved);
      }
      return require(request);
    };
    new Function('module', 'exports', 'require', out)(mod, mod.exports, req);
    return mod.exports;
  };
  return load(path.join(ROOT, rel));
}

const em = loadTs('src/components/guard/emergency/guardEmergency.ts');
const forms = loadTs('src/components/guard/guardActionForms.ts');
const priority = loadTs('src/components/company/attentionPriority.ts');
const { GuardEmergencyScreen } = loadComponent('src/components/guard/emergency/GuardEmergencyScreen.tsx');

const LIVE = { id: 42, status: 'in_progress' };
const OVERCLAIM = /control room (has )?(received|seen|acknowledged)|sent to (the )?control room|help is on (its|the) way|emergency services (have been|were) (called|contacted)|police (have been|were)/i;
class NetworkError extends Error { constructor(m) { super(m); this.name = 'NetworkError'; } }
class ApiError extends Error { constructor(status, body) { super(`${status} x - ${JSON.stringify(body)}`); this.name = 'ApiError'; this.status = status; this.body = body; } }
const recorder = (impl) => {
  const calls = [];
  return { calls, api: { createSafetyAlert: async (payload) => { calls.push(payload); return impl(payload, calls.length); } } };
};
const receiptBody = (over = {}) => ({ id: 7, createdAt: '2026-11-24T14:02:00.000Z', type: 'panic', status: 'open',
  emergencyReceipt: { duplicate: false, receivedAt: '2026-11-24T14:02:00.000Z', responsiblePeopleNotified: 3, pushDevicesTargeted: 2, acknowledged: false, ...over } });
const hhmm = (iso) => iso.slice(11, 16);

// ═══════════════════ the model ═══════════════════

test('EM-M01-ONE-PRESS-SENDS-EXACTLY-ONE-REQUEST', async () => {
  const r = recorder(() => receiptBody());
  const out = await em.sendGuardEmergency(LIVE, r.api);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0], { shiftId: 42, type: 'panic', priority: 'critical', message: em.EMERGENCY_APP_MESSAGE });
  assert.equal(out.kind, 'received');
  assert.equal(out.receipt.alertId, 7);
});

test('EM-M02-NO-LIVE-SHIFT-SENDS-NOTHING', async () => {
  for (const shift of [null, undefined, { id: 1, status: 'accepted' }, { id: 1, status: 'completed' }]) {
    const r = recorder(() => receiptBody());
    const out = await em.sendGuardEmergency(shift, r.api);
    assert.equal(r.calls.length, 0, JSON.stringify(shift));
    assert.equal(out.kind, 'not_available');
    assert.match(em.emergencyFailureView(out).message, /999/);
  }
});

test('EM-M03-THE-RECEIPT', async () => {
  const dup = await em.sendGuardEmergency(LIVE, recorder(() => receiptBody({ duplicate: true })).api);
  assert.equal(dup.receipt.duplicate, true);
  const older = await em.sendGuardEmergency(LIVE, recorder(() => ({ id: 9, createdAt: '2026-11-24T14:05:00.000Z' })).api);
  assert.equal(older.kind, 'received', 'an older backend without a receipt still recorded it');
  assert.equal(older.receipt.responsiblePeopleNotified, null);
  assert.equal(older.receipt.receivedAt, '2026-11-24T14:05:00.000Z');
  const noId = await em.sendGuardEmergency(LIVE, recorder(() => ({})).api);
  assert.equal(noId.kind, 'failed', 'a 2xx without an alert id is not proof S4 recorded it');
});

test('EM-M04-FAILURES-SAY-NOT-SENT-AND-999', async () => {
  const cases = [
    [new NetworkError('Request timed out. Check your connection and try again.'), 'offline', true],
    [new TypeError('Network request failed'), 'offline', true],
    [new ApiError(401, { message: 'Unauthorized' }), 'session_ended', false],
    [new ApiError(400, { message: 'This shift is not assigned to the current guard' }), 'refused', false],
    [new ApiError(500, { message: 'Internal' }), 'failed', true],
    [new ApiError(503, {}), 'failed', true],
  ];
  for (const [error, kind, canRetry] of cases) {
    const out = await em.sendGuardEmergency(LIVE, { createSafetyAlert: async () => { throw error; } });
    assert.equal(out.kind, kind, error.message);
    const view = em.emergencyFailureView(out);
    assert.equal(view.title, 'Emergency NOT sent');
    assert.match(view.message, /call 999/i, kind);
    assert.equal(view.canRetry, canRetry, kind);
    assert.doesNotMatch(view.message, /\{|\}|400 |Bad Request/, 'no raw client error text');
  }
  const refused = em.classifyEmergencyError(new ApiError(400, { message: 'This shift is not assigned to the current guard' }));
  assert.match(em.emergencyFailureView(refused).message, /^This shift is not assigned to the current guard\./, 'S4’s own words');
});

test('EM-M05-NOTHING-OVERCLAIMS-AND-ACKNOWLEDGEMENT-COMES-ONLY-FROM-THE-ALERT', () => {
  const receipt = em.readEmergencyReceipt(receiptBody());
  const waiting = em.emergencyReceivedView(receipt, em.emergencyFollowUp({ status: 'open' }), hhmm);
  assert.equal(waiting.title, 'S4 received your Emergency');
  assert.deepEqual(waiting.lines, ['Received by S4 at 14:02.', 'S4 is alerting 3 responsible people at your company.', 'Nobody has confirmed they have seen it yet.']);
  assert.equal(waiting.acknowledged, false);
  assert.equal(em.emergencyFollowUp({ status: 'acknowledged' }).state, 'waiting', 'no acknowledgedAt, no claim');
  const ack = em.emergencyReceivedView(receipt, em.emergencyFollowUp({ status: 'acknowledged', acknowledgedAt: '2026-11-24T14:04:00.000Z' }), hhmm);
  assert.ok(ack.lines.includes('Your company acknowledged your Emergency at 14:04.'));
  assert.ok(!ack.lines.some((l) => /Nobody has confirmed/.test(l)));
  const resolved = em.emergencyReceivedView(receipt, em.emergencyFollowUp({ status: 'closed', closedAt: '2026-11-24T14:30:00.000Z' }), hhmm);
  assert.ok(resolved.lines.includes('Your company has resolved this Emergency at 14:30.'));
  const dup = em.emergencyReceivedView({ ...receipt, duplicate: true }, { state: 'waiting' }, hhmm);
  assert.equal(dup.title, 'S4 already has your Emergency');
  assert.ok(dup.lines.includes('S4 received it at 14:02. It has not been sent twice.'));
  const all = [
    ...Object.values(em.EMERGENCY_COPY), em.EMERGENCY_999_NOTICE,
    ...waiting.lines, ...ack.lines, ...resolved.lines, ...dup.lines, waiting.notice,
    ...['offline', 'session_ended', 'failed'].map((kind) => em.emergencyFailureView({ kind }).message),
  ];
  for (const text of all) assert.doesNotMatch(text, OVERCLAIM, text);
  assert.match(em.EMERGENCY_999_NOTICE, /does not contact the emergency services/);
  assert.match(em.EMERGENCY_999_NOTICE, /call 999/);
});

test('EM-M06-LAYOUT-FITS-SMALL-AND-LARGE-PHONES', () => {
  for (const [w, hgt] of [[320, 568], [360, 640], [375, 667], [412, 915], [430, 932]]) {
    const l = em.emergencyScreenLayout({ width: w, height: hgt });
    assert.ok(l.sendMinHeight >= 96, `${w}x${hgt}: SEND at least 96pt`);
    assert.ok(l.cancelHeight >= 48, 'Cancel above the 44/48pt minimum');
    // Title + lead + 999 notice + Cancel + gaps + the SEND minimum must fit in the window without scrolling.
    const fixed = 48 + 24 /* insets */ + 2 * l.gutter + (l.titleSize + 6) + 2 * 24 + 3 * 21 + l.cancelHeight + 4 * 16;
    assert.ok(fixed + l.sendMinHeight <= hgt, `${w}x${hgt}: fits (${fixed + l.sendMinHeight} <= ${hgt})`);
  }
  assert.equal(em.emergencyScreenLayout({ width: 320, height: 568 }).compact, true);
  assert.equal(em.emergencyScreenLayout({ width: 412, height: 915 }).compact, false);
});

// ═══════════════════ rendered ═══════════════════

const byTestId = (root, id) => root.findAll((n) => n.props && n.props.testID === id && typeof n.type !== 'string');
const textBlob = (root) => JSON.stringify(root.findAll(() => true).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean));

async function mount(api, { shift = LIVE } = {}) {
  const events = { closed: 0, received: [] };
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(h(GuardEmergencyScreen, {
      visible: true, shift, timeZone: 'Europe/London', api,
      onClose: () => { events.closed += 1; }, onReceived: (r) => events.received.push(r),
    }));
  });
  return { renderer, events, root: renderer.root };
}
const press = async (node) => { await act(async () => { node.props.onPress(); }); await act(async () => { await settle(); }); };

test('EM-M07-FULL-SCREEN-NO-SCROLL-NO-TYPING', async () => {
  const api = { createSafetyAlert: async () => receiptBody(), listMySafetyAlerts: async () => [] };
  const { renderer, root } = await mount(api);
  const modal = root.findAll((n) => n.type === 'test-modal');
  assert.equal(modal.length, 1);
  assert.equal(modal[0].props.presentationStyle, 'fullScreen');
  assert.equal(root.findAll((n) => n.type === RNW.ScrollView).length, 0, 'no ScrollView');
  assert.equal(root.findAll((n) => n.type === 'test-text-input').length, 0, 'nothing to type');
  const [send] = byTestId(root, 'guard-emergency-send');
  const [cancel] = byTestId(root, 'guard-emergency-cancel');
  assert.ok(send && cancel, 'SEND and a separate Cancel');
  assert.notEqual(send, cancel);
  assert.equal(send.props.accessibilityRole, 'button');
  assert.equal(send.props.accessibilityLabel, 'Send Emergency alert now');
  assert.equal(cancel.props.accessibilityLabel, 'Cancel. Do not send an Emergency');
  const blob = textBlob(root);
  for (const t of ['Emergency', 'Send an Emergency alert to your company?', 'SEND EMERGENCY', 'Cancel', em.EMERGENCY_999_NOTICE]) assert.ok(blob.includes(t), t);
  assert.doesNotMatch(blob, /SOS|Type /, 'no typed confirmation');
  await act(async () => renderer.unmount());
});

test('EM-M08-A-DOUBLE-TAP-SENDS-ONCE-AND-CANCEL-SENDS-NOTHING', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const api = { createSafetyAlert: async (p) => { calls.push(p); await gate; return receiptBody(); }, listMySafetyAlerts: async () => [{ id: 7, status: 'open' }] };
  const { renderer, root, events } = await mount(api);
  const [send] = byTestId(root, 'guard-emergency-send');
  await act(async () => { send.props.onPress(); send.props.onPress(); send.props.onPress(); });
  assert.equal(calls.length, 1, 'one request however fast the taps');
  assert.ok(textBlob(root).includes(em.EMERGENCY_COPY.sending), 'sending is shown');
  const [busySend] = byTestId(root, 'guard-emergency-send');
  assert.equal(busySend.props.disabled, true, 'inert while sending');
  await act(async () => { release(); await settle(); });
  assert.equal(byTestId(root, 'guard-emergency-received').length, 1, 'the received screen');
  const blob = textBlob(root);
  assert.ok(blob.includes('S4 received your Emergency'));
  assert.ok(blob.includes('Nobody has confirmed they have seen it yet.'));
  assert.ok(blob.includes(em.EMERGENCY_999_NOTICE));
  assert.equal(events.received.length, 1);
  await press(byTestId(root, 'guard-emergency-close')[0]);
  assert.equal(events.closed, 1);
  await act(async () => renderer.unmount());

  const r2 = []; const m2 = await mount({ createSafetyAlert: async (p) => { r2.push(p); return receiptBody(); }, listMySafetyAlerts: async () => [] });
  await press(byTestId(m2.root, 'guard-emergency-cancel')[0]);
  assert.equal(r2.length, 0, 'Cancel sends nothing');
  assert.equal(m2.events.closed, 1);
  await act(async () => m2.renderer.unmount());
});

test('EM-M09-OFFLINE-THEN-RETRY-AND-A-REAL-ACKNOWLEDGEMENT', async () => {
  let attempt = 0;
  let mine = [{ id: 7, status: 'open' }];
  const api = {
    createSafetyAlert: async () => { attempt += 1; if (attempt === 1) throw new NetworkError('Network request failed'); return receiptBody(); },
    listMySafetyAlerts: async () => mine,
  };
  const { renderer, root } = await mount(api);
  await press(byTestId(root, 'guard-emergency-send')[0]);
  assert.equal(byTestId(root, 'guard-emergency-not-sent').length, 1);
  let blob = textBlob(root);
  assert.ok(blob.includes('Emergency NOT sent'));
  assert.match(blob, /could not reach S4/);
  assert.match(blob, /call 999/);
  // Meanwhile a Control Room operator acknowledges it: the received screen reads the alert back and shows exactly that.
  mine = [{ id: 7, status: 'acknowledged', acknowledgedAt: '2026-11-24T14:04:00.000Z' }];
  await press(byTestId(root, 'guard-emergency-retry')[0]);
  assert.equal(attempt, 2);
  assert.equal(byTestId(root, 'guard-emergency-received').length, 1);
  blob = textBlob(root);
  assert.ok(blob.includes('ACKNOWLEDGED'), 'the badge changes only because the alert says so');
  assert.ok(blob.includes('Your company acknowledged your Emergency at 14:04.'));
  assert.ok(!blob.includes('Nobody has confirmed they have seen it yet.'));
  // Closing and pressing Emergency again starts at the confirmation, so a genuinely new Emergency can be raised.
  await act(async () => renderer.update(h(GuardEmergencyScreen, { visible: false, shift: LIVE, api, onClose: () => undefined })));
  await act(async () => renderer.update(h(GuardEmergencyScreen, { visible: true, shift: LIVE, api, onClose: () => undefined })));
  await act(async () => { await settle(); });
  assert.ok(textBlob(root).includes('SEND EMERGENCY'));
  await act(async () => renderer.unmount());
});

// ═══════════════════ the action-form model and the dashboard ═══════════════════

test('EM-M10-EMERGENCY-NEEDS-NO-WORDS', () => {
  const form = forms.guardActionForm('emergency');
  assert.equal(form.requiresText, false);
  assert.equal('confirmWord' in form, false, 'no confirmation word');
  assert.deepEqual(forms.resolveActionSubmitState(form, { value: '', busy: false }), { disabled: false, label: 'SEND EMERGENCY', blockedReason: null });
  assert.equal(forms.resolveActionSubmitState(form, { value: '', busy: true }).disabled, true, 'busy still wins');
  for (const other of forms.GUARD_ACTION_FORMS.filter((f) => f.key !== 'emergency')) {
    assert.equal(forms.resolveActionSubmitState(other, { value: '  ', busy: false }).blockedReason, 'empty', `${other.key} still needs words`);
  }
  for (const rel of ['src/components/guard/guardActionForms.ts', 'src/components/guard/guardActionDispatch.ts', 'src/components/guard/emergency/guardEmergency.ts', 'src/components/guard/emergency/GuardEmergencyScreen.tsx']) {
    assert.doesNotMatch(codeOf(rel), /Type SOS|confirmWord|'SOS'/, rel);
  }
});

test('EM-M11-LIVE-OPERATIONS-PUTS-ACTIVE-EMERGENCIES-FIRST', () => {
  const items = [
    { id: 'welfare-new', category: 'missed_check_call', status: 'open', occurredAt: '2026-11-24T14:30:00Z' },
    { id: 'panic-acked', category: 'panic', status: 'acknowledged', occurredAt: '2026-11-24T14:20:00Z' },
    { id: 'uncovered', category: 'uncovered_shift', status: 'uncovered', occurredAt: '2026-11-24T14:25:00Z' },
    { id: 'panic-open-old', category: 'panic', status: 'open', occurredAt: '2026-11-24T14:00:00Z' },
    { id: 'panic-open-new', category: 'panic', status: 'open', occurredAt: '2026-11-24T14:10:00Z' },
    { id: 'panic-closed', category: 'panic', status: 'closed', occurredAt: '2026-11-24T14:40:00Z' },
  ];
  const order = [...items].sort(priority.compareAttentionItems).map((i) => i.id);
  assert.deepEqual(order, ['panic-open-new', 'panic-open-old', 'panic-acked', 'panic-closed', 'welfare-new', 'uncovered']);
  const screen = codeOf('src/screens/CompanyDashboardScreen.tsx');
  assert.match(screen, /\.sort\(compareAttentionItems\)/, 'Attention Now uses it');
});

test('EM-M12-THE-DASHBOARD-OPENS-THE-FULL-SCREEN-CONFIRMATION', () => {
  const screen = codeOf('src/screens/GuardDashboardScreen.tsx');
  assert.match(screen, /const openEmergency = \(\) => setEmergencyOpen\(true\);/);
  assert.match(screen, /<GuardEmergencyScreen[\s\S]*?visible=\{emergencyOpen\}[\s\S]*?shift=\{currentShiftActionTarget\}/);
  assert.match(screen, /GUARD_ACTION_FORMS\.filter\(\(form\) => form\.key !== 'emergency'\)/, 'the old typed form is not rendered');
  const push = codeOf('src/services/pushNotifications.ts');
  assert.match(push, /EMERGENCY_CHANNEL_ID = 'emergency-alerts'/, 'the Android channel the backend targets');
  assert.match(codeOf('App.tsx'), /surface === 'guard' \|\| surface === 'company'/, 'company responders register their phone');
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed += 1;
      console.log(`PASS  ${name}`);
    } catch (error) {
      console.error(`FAIL  ${name}`);
      console.error(error);
      process.exit(1);
    }
  }
  console.log(`${passed} guard emergency checks passed`);
})();
