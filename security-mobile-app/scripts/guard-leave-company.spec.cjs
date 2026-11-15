/**
 * Guard leave company selection (SEC-001B 2B).
 *
 * The backend now sends a guard's leave request only to an ACTIVE employer: one employer is chosen automatically,
 * several need an explicit companyId (400 LEAVE_COMPANY_REQUIRED otherwise), none is refused
 * (400 LEAVE_NO_ACTIVE_EMPLOYER). This spec proves the guard app's half:
 *
 *   LOGIC     guardLeaveCompany.ts, executed: states, payloads, stale selections, error codes
 *   SCREEN    the real GuardAvailabilityScreen rendered (react-native-web + react-test-renderer) against a stubbed
 *             API: single, multiple, none, legacy-backend, load-error/retry and refusal-reload journeys, checking
 *             exactly what is sent to POST /leave/mine
 *   CONTRACT  the app's endpoint, codes and payload field match the backend source in this repository
 *
 * Not provable here: physical-device rendering at large font scales. The selector is plain wrapping chips with
 * no fixed heights or truncation; that remains a manual device check.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const TestRenderer = require('react-test-renderer');
const { loadTs, ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let passed = 0;
const tests = [];
const test = (name, run) => tests.push({ name, run });

// ═══════════════════ LOGIC ═══════════════════
const L = loadTs('src/components/guard/guardLeaveCompany.ts');
const form = { leaveType: 'annual_leave', startAt: '2031-08-04', endAt: '2031-08-05', reason: 'Holiday' };
const A = { companyId: 11, name: 'Alpha Security Ltd' };
const B = { companyId: 22, name: 'Beta Guarding' };

test('list → state: 0 none, 1 single, 2+ multiple; malformed and duplicate entries dropped', () => {
  assert.deepEqual(L.leaveCompanyStateFromList([]), { kind: 'none' });
  assert.deepEqual(L.leaveCompanyStateFromList(null), { kind: 'none' });
  assert.deepEqual(L.leaveCompanyStateFromList([A]), { kind: 'single', company: A });
  assert.deepEqual(L.leaveCompanyStateFromList([A, B]), { kind: 'multiple', companies: [A, B] });
  assert.deepEqual(L.leaveCompanyStateFromList([A, { companyId: 'x' }, { name: 'n' }, { companyId: 0 }, A]), { kind: 'single', company: A });
  assert.equal(L.leaveCompanyStateFromList([{ companyId: 5, name: ' ' }]).company.name, 'Company 5');
});

test('request failure → state: only the route-not-found 404 is an older backend; anything else is a load error', () => {
  const routeMissing = { statusCode: 404, message: 'Cannot GET /leave/mine/companies', error: 'Not Found' };
  assert.deepEqual(L.leaveCompanyStateFromError(404, routeMissing), { kind: 'legacy' });
  assert.deepEqual(L.leaveCompanyStateFromError(404, 'Cannot GET /leave/mine/companies'), { kind: 'legacy' });
  assert.deepEqual(L.leaveCompanyStateFromError(404, { statusCode: 404, message: 'Guard profile not found' }), { kind: 'error' });
  assert.deepEqual(L.leaveCompanyStateFromError(404), { kind: 'error' });
  assert.deepEqual(L.leaveCompanyStateFromError(404, { message: 'Cannot GET /something/else' }), { kind: 'error' });
  assert.deepEqual(L.leaveCompanyStateFromError(500), { kind: 'error' });
  assert.deepEqual(L.leaveCompanyStateFromError(401), { kind: 'error' });
  assert.deepEqual(L.leaveCompanyStateFromError(undefined), { kind: 'error' });
});

test('single employer: no selector, payload exactly the pre-2B shape (no companyId, no id)', () => {
  const state = L.leaveCompanyStateFromList([A]);
  assert.equal(L.showsCompanySelector(state), false);
  assert.equal(L.canSubmitLeave(state, null), true);
  const built = L.buildNewLeavePayload(form, state, null);
  assert.equal(built.ok, true);
  assert.deepEqual(Object.keys(built.payload).sort(), ['endAt', 'leaveType', 'reason', 'startAt']);
  assert.deepEqual(L.buildNewLeavePayload({ ...form, reason: '' }, state, null).payload.reason, null);
  // A selection left over from an earlier multi-company state is ignored, never sent.
  assert.equal('companyId' in L.buildNewLeavePayload(form, state, B.companyId).payload, false);
});

test('multiple employers: selector shown; a choice is required; only a listed company id is ever sent', () => {
  const state = L.leaveCompanyStateFromList([A, B]);
  assert.equal(L.showsCompanySelector(state), true);
  assert.equal(L.canSubmitLeave(state, null), false);
  assert.deepEqual(L.buildNewLeavePayload(form, state, null), { ok: false, message: L.LEAVE_COPY.chooseCompany });
  assert.equal(L.canSubmitLeave(state, 999), false, 'a stale / foreign id does not enable submission');
  assert.equal(L.buildNewLeavePayload(form, state, 999).ok, false);
  assert.equal(L.validSelection(state, 999), null);
  const built = L.buildNewLeavePayload(form, state, B.companyId);
  assert.equal(built.ok, true);
  assert.equal(built.payload.companyId, B.companyId);
  assert.equal('id' in built.payload, false, 'the app only creates requests; it never edits one or moves it');
});

test('no ACTIVE employer: no submission, a clear explanation', () => {
  const state = L.leaveCompanyStateFromList([]);
  assert.equal(L.canSubmitLeave(state, null), false);
  const built = L.buildNewLeavePayload(form, state, null);
  assert.equal(built.ok, false);
  assert.match(built.message, /do not currently have an active company relationship/);
});

test('loading and load-error block submission (clear Retry state); an older backend gets the pre-2B payload', () => {
  assert.equal(L.canSubmitLeave({ kind: 'loading' }, null), false);
  assert.equal(L.buildNewLeavePayload(form, { kind: 'loading' }, null).ok, false);
  assert.equal(L.canSubmitLeave({ kind: 'error' }, null), false);
  assert.deepEqual(L.buildNewLeavePayload(form, { kind: 'error' }, 22), { ok: false, message: L.LEAVE_COPY.loadError });
  assert.equal(L.showsCompanySelector({ kind: 'error' }), false);
  const legacy = L.buildNewLeavePayload(form, { kind: 'legacy' }, 22);
  assert.equal(legacy.ok, true);
  assert.equal(L.showsCompanySelector({ kind: 'legacy' }), false);
  assert.equal('companyId' in legacy.payload, false, 'companyId never reaches an older backend (it rejects unknown fields)');
});

test('routing refusal codes are recognised and trigger a company reload', () => {
  assert.equal(L.leaveErrorCode({ statusCode: 400, code: 'LEAVE_COMPANY_REQUIRED', message: 'x' }), 'LEAVE_COMPANY_REQUIRED');
  assert.equal(L.leaveErrorCode('text'), null);
  assert.equal(L.leaveErrorCode({ message: 'x' }), null);
  assert.equal(L.refusalNeedsCompanyReload('LEAVE_COMPANY_REQUIRED'), true);
  assert.equal(L.refusalNeedsCompanyReload('LEAVE_NO_ACTIVE_EMPLOYER'), true);
  assert.equal(L.refusalNeedsCompanyReload(null), false);
  assert.equal(L.refusalNeedsCompanyReload('SOMETHING_ELSE'), false);
});

// ═══════════════════ SCREEN ═══════════════════
class FakeApiError extends Error {
  constructor(status, body) { super(`${status}`); this.status = status; this.body = body; }
}

const RNW = require('react-native-web');
/**
 * The TextInput primitive only: react-native-web's needs a DOM, which the test renderer does not have. It keeps the
 * props the screen relies on (value, placeholder, onChangeText). Everything else is react-native-web.
 */
function TestTextInput(props) { return React.createElement('test-input', props); }
const RN_SHIM = { ...RNW, TextInput: TestTextInput };

/** The real screen, with react-native → react-native-web (TextInput substituted) and services/api → a scripted stub. */
function loadScreen(api) {
  const ts = require('typescript');
  const cache = new Map();
  const load = (abs) => {
    if (cache.has(abs)) return cache.get(abs).exports;
    const out = ts.transpileModule(fs.readFileSync(abs, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const mod = { exports: {} };
    cache.set(abs, mod);
    const localRequire = (request) => {
      if (request === 'react-native') return RN_SHIM;
      if (request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(abs), request);
        if (resolved === path.join(ROOT, 'src/services/api')) return api;
        for (const c of [resolved, `${resolved}.ts`, `${resolved}.tsx`, path.join(resolved, 'index.ts'), path.join(resolved, 'index.tsx')]) {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) return load(c);
        }
      }
      return require(request);
    };
    new Function('module', 'exports', 'require', out)(mod, mod.exports, localRequire);
    return mod.exports;
  };
  return load(path.join(ROOT, 'src/screens/GuardAvailabilityScreen.tsx')).GuardAvailabilityScreen;
}

/** A stub API whose leave-company responses are scripted in order; records every leave submission. */
function stubApi(companyResponses, saveBehaviour = () => ({ id: 1, status: 'pending' })) {
  const calls = { companies: 0, saved: [] };
  const responses = [...companyResponses];
  const api = {
    ApiError: FakeApiError,
    formatApiErrorMessage: (error, fallback) => (error && error.body && error.body.message) || fallback,
    listMyAvailabilityRules: async () => [],
    listMyAvailabilityOverrides: async () => [],
    listMyGuardLeave: async () => [],
    saveAvailabilityRule: async () => ({}),
    saveAvailabilityOverride: async () => ({}),
    listMyLeaveCompanies: async () => {
      calls.companies += 1;
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) throw next;
      return next;
    },
    saveMyGuardLeave: async (payload) => { calls.saved.push(payload); return saveBehaviour(payload); },
  };
  return { api, calls };
}

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); });
const texts = (root) => root.findAll((n) => n.type === RNW.Text).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string').join(''));
const radios = (root) => root.findAll((n) => n.type === RNW.Pressable && n.props.accessibilityRole === 'radio');
const button = (root, label) => root.findAll((n) => n.type === RNW.Pressable && n.props.accessibilityLabel === label)[0];
const press = async (node) => { await act(async () => { node.props.onPress(); }); await flush(); };

async function mount(api) {
  const Screen = loadScreen(api);
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Screen)); });
  await flush();
  return renderer;
}

async function fillLeave(root) {
  const inputs = root.findAll((n) => n.type === TestTextInput);
  const byPlaceholder = (p) => inputs.find((i) => i.props.placeholder === p);
  const leaveInputs = inputs.filter((i) => i.props.placeholder === 'Date / ISO');
  await act(async () => {
    leaveInputs[0].props.onChangeText('2031-08-04T09:00:00Z');
    leaveInputs[1].props.onChangeText('2031-08-05T09:00:00Z');
    byPlaceholder('Add a short reason').props.onChangeText('Holiday');
  });
}

test('SCREEN single employer: no selector, submission unchanged (no companyId)', async () => {
  const { api, calls } = stubApi([[A]]);
  const r = await mount(api);
  assert.equal(radios(r.root).length, 0, 'no company selector');
  const submit = button(r.root, 'Request leave');
  assert.equal(submit.props.disabled, false);
  await fillLeave(r.root);
  await press(submit);
  assert.equal(calls.saved.length, 1);
  assert.deepEqual(calls.saved[0], { leaveType: 'annual_leave', startAt: '2031-08-04T09:00:00Z', endAt: '2031-08-05T09:00:00Z', reason: 'Holiday' });
  assert.ok(texts(r.root).some((t) => t.includes('Leave request saved')));
  r.unmount();
});

test('SCREEN multiple employers: ACTIVE companies listed as radios, choice required, chosen companyId sent', async () => {
  const { api, calls } = stubApi([[A, B]]);
  const r = await mount(api);
  const options = radios(r.root);
  assert.deepEqual(options.map((o) => o.props.accessibilityLabel), [A.name, B.name]);
  assert.ok(options.every((o) => o.props.accessibilityState.checked === false), 'nothing is pre-selected');
  assert.ok(texts(r.root).some((t) => t.includes('more than one company')));
  assert.equal(button(r.root, 'Request leave').props.disabled, true, 'cannot submit before choosing');
  await fillLeave(r.root);
  await press(options[1]);
  assert.equal(radios(r.root)[1].props.accessibilityState.checked, true);
  assert.equal(button(r.root, 'Request leave').props.disabled, false);
  await press(button(r.root, 'Request leave'));
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.saved[0].companyId, B.companyId);
  assert.equal('id' in calls.saved[0], false);
  assert.ok(radios(r.root).every((o) => o.props.accessibilityState.checked === false), 'the choice is cleared for the next request');
  r.unmount();
});

test('SCREEN no ACTIVE employer: explanation shown, no form and no submit button', async () => {
  const { api, calls } = stubApi([[]]);
  const r = await mount(api);
  assert.ok(texts(r.root).some((t) => t.includes('do not currently have an active company relationship')));
  assert.equal(button(r.root, 'Request leave'), undefined);
  assert.equal(radios(r.root).length, 0);
  assert.equal(calls.saved.length, 0);
  r.unmount();
});

test('SCREEN backend without the endpoint (route-not-found 404): behaves exactly as before 2B', async () => {
  const { api, calls } = stubApi([new FakeApiError(404, { statusCode: 404, message: 'Cannot GET /leave/mine/companies', error: 'Not Found' })]);
  const r = await mount(api);
  assert.equal(radios(r.root).length, 0);
  assert.ok(!texts(r.root).some((t) => t.includes('could not be loaded')), 'no error shown for an older backend');
  await fillLeave(r.root);
  await press(button(r.root, 'Request leave'));
  assert.equal(calls.saved.length, 1);
  assert.equal('companyId' in calls.saved[0], false);
  r.unmount();
});

for (const [label, failure] of [
  ['server error', new FakeApiError(503, { message: 'down' })],
  ['other 404 (endpoint exists)', new FakeApiError(404, { statusCode: 404, message: 'Guard profile not found' })],
  ['network failure', new Error('Network request failed')],
]) test(`SCREEN load error (${label}): clear Retry state, nothing submitted, typed form kept`, async () => {
  const { api, calls } = stubApi([failure, [A]]);
  const r = await mount(api);
  assert.ok(texts(r.root).some((t) => t.includes('could not be loaded')));
  assert.equal(radios(r.root).length, 0);
  const submit = button(r.root, 'Request leave');
  assert.equal(submit.props.disabled, true, 'submission disabled until the list loads');
  await fillLeave(r.root);
  await press(button(r.root, 'Retry loading your companies'));
  assert.equal(calls.companies, 2);
  assert.ok(!texts(r.root).some((t) => t.includes('could not be loaded')), 'error cleared after a successful retry');
  assert.equal(button(r.root, 'Request leave').props.disabled, false);
  await press(button(r.root, 'Request leave'));
  assert.equal(calls.saved.length, 1, 'only one submission, after the retry');
  assert.equal(calls.saved[0].startAt, '2031-08-04T09:00:00Z', 'what the guard typed before the retry was kept');
  r.unmount();
});

test('SCREEN load error then retry to several employers: selector appears', async () => {
  const { api, calls } = stubApi([new FakeApiError(503, { message: 'down' }), [A, B]]);
  const r = await mount(api);
  const retry = button(r.root, 'Retry loading your companies');
  assert.ok(retry, 'retry button');
  await press(retry);
  assert.equal(calls.companies, 2);
  assert.equal(radios(r.root).length, 2);
  r.unmount();
});

test('SCREEN routing refusal from the backend: message shown and companies reloaded', async () => {
  const refusal = new FakeApiError(400, { statusCode: 400, code: 'LEAVE_COMPANY_REQUIRED', message: 'You work for more than one company. Choose the company this leave request is for.' });
  // The list said one employer, but the guard has since joined a second: the backend refuses, the app reloads.
  const { api, calls } = stubApi([[A], [A, B]], () => { throw refusal; });
  const r = await mount(api);
  await fillLeave(r.root);
  await press(button(r.root, 'Request leave'));
  assert.ok(texts(r.root).some((t) => t.includes('more than one company')));
  assert.equal(calls.companies, 2, 'companies reloaded after the refusal');
  assert.equal(radios(r.root).length, 2, 'selector now shown');
  r.unmount();
});

test('SCREEN selector accessibility: radiogroup with label, radios with touch-target styling and wrapping names', async () => {
  const { api } = stubApi([[A, { companyId: 33, name: 'A Very Long Company Name Security Services (Northern Region) Limited' }]]);
  const r = await mount(api);
  const group = r.root.findAll((n) => n.props && n.props.accessibilityRole === 'radiogroup');
  assert.ok(group.length >= 1);
  for (const option of radios(r.root)) {
    const style = RNW.StyleSheet.flatten(option.props.style);
    assert.ok(style.minHeight >= 44, 'minimum touch target');
    assert.equal(style.height, undefined, 'no fixed height, so text scaling can grow it');
    const label = option.findAll((n) => n.type === RNW.Text)[0];
    assert.equal(label.props.numberOfLines, undefined, 'company names are never truncated');
  }
  r.unmount();
});

// ═══════════════════ CONTRACT ═══════════════════
test('CONTRACT app ↔ backend: endpoint, payload field and refusal codes match the backend source', () => {
  const api = fs.readFileSync(path.join(ROOT, 'src/services/api.ts'), 'utf8');
  assert.match(api, /export function listMyLeaveCompanies\(\) \{\s*return request<[^>]+>\('\/leave\/mine\/companies'\);/);
  assert.match(api, /export function saveMyGuardLeave\(payload: GuardLeavePayload\) \{\s*return request<GuardLeave>\('\/leave\/mine', \{\s*method: 'POST',\s*body: JSON\.stringify\(payload\)/);
  const models = fs.readFileSync(path.join(ROOT, 'src/types/models.ts'), 'utf8');
  assert.match(models, /interface GuardLeavePayload \{[^}]*companyId\?: number;/);

  const backend = path.join(ROOT, '..', 'security-backend-nest', 'src', 'leave');
  if (!fs.existsSync(backend)) { console.log('     (backend source not present; contract half skipped)'); return; }
  const controller = fs.readFileSync(path.join(backend, 'leave.controller.ts'), 'utf8');
  assert.match(controller, /@Get\('mine\/companies'\)\s*@Roles\(UserRole\.GUARD\)/);
  const service = fs.readFileSync(path.join(backend, 'leave.service.ts'), 'utf8');
  assert.match(service, new RegExp(`LEAVE_COMPANY_REQUIRED = '${L.LEAVE_COMPANY_REQUIRED}'`));
  assert.match(service, new RegExp(`LEAVE_NO_ACTIVE_EMPLOYER = '${L.LEAVE_NO_ACTIVE_EMPLOYER}'`));
  assert.match(service, /companyId: link\.company\.id, name: link\.company\.name/);
  const dto = fs.readFileSync(path.join(backend, 'dto', 'upsert-guard-leave.dto.ts'), 'utf8');
  assert.match(dto, /@IsOptional\(\)\s*@IsInt\(\)\s*@Min\(1\)\s*companyId\?: number;/);
});

(async () => {
  for (const { name, run } of tests) {
    try {
      await run();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      // React reports render failures as an AggregateError; show the first underlying error.
      const shown = error && Array.isArray(error.errors) && error.errors.length ? error.errors[0] : error;
      console.log(`FAIL ${name}\n     ${shown && shown.stack ? shown.stack.split('\n').slice(0, 4).join('\n     ') : shown}`);
      process.exitCode = 1;
    }
  }
  console.log(`\nGuard leave company selection: ${passed}/${tests.length} passed`);
  if (!process.exitCode) console.log(JSON.stringify({ event: 'guard_leave_company_tests_passed', tests: passed }));
})();
