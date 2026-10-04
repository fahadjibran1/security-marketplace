#!/usr/bin/env node
/**
 * S4 Pilot Gate 2 — the client side of password reset, email verification and account deletion.
 *
 * Executes the real modules: the emailed-link parser and its token stripping, the password rule, the
 * REAL api.ts against a scripted fetch (so the shape of every request is proven, including that tokens
 * travel in bodies and never in URLs), and renders the deletion journey and the link screen with the real
 * reconciler.
 *
 *   ACCOUNT-UI-01  /reset-password and /verify-email are recognised; anything else is not
 *   ACCOUNT-UI-02  the token is taken once and stripped from the address bar in the same step
 *   ACCOUNT-UI-03  the new-password rule matches registration and catches a mismatch
 *   ACCOUNT-UI-04  recovery calls carry tokens in the body, never the URL; deletion calls hit the account API
 *   ACCOUNT-UI-05  registration that needs verification yields no session; old backends still work
 *   ACCOUNT-UI-06  "verify your email" is recognised from the server's stable code, not its wording
 *   ACCOUNT-UI-07  deletion copy is factual: no promise of total erasure, retention is explained, S4 named
 *   ACCOUNT-UI-08  the deletion journey: entry → explanation → confirmation → deleted → onDeleted
 *   ACCOUNT-UI-09  a company owner is told why and nothing is deleted
 *   ACCOUNT-UI-10  the reset-password screen refuses a missing token and never shows the token
 */
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const TestRenderer = require('react-test-renderer');
const { loadTs, ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
const h = React.createElement;
const links = loadTs('src/components/account/accountLinks.ts');
const { ACCOUNT_DELETION_COPY } = loadTs('src/components/account/accountDeletionCopy.ts');

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

const TOKEN = 'Qm9vbXRva2VuLXRoYXQtaXMtbG9uZy1lbm91Z2gtMTIzNDU2';

// ── the real api.ts against a scripted fetch (same harness as auth-refresh.spec.cjs) ───────────────────
function loadApi(router) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(ROOT, 'src', 'services', 'api.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    const spec = await router(url, init);
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      statusText: 'X',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(spec.body ?? null),
      json: async () => spec.body ?? null,
    };
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: mod.exports, module: mod,
    require: (id) => {
      if (id === 'expo-constants') return { default: { expoConfig: { extra: { apiBaseUrl: 'https://api.test' } } } };
      if (id.endsWith('api-base-url')) return { resolveApiBaseUrl: () => 'https://api.test' };
      if (id.endsWith('models')) return {};
      return require(id);
    },
    process, console, Error, TypeError, Promise, JSON, Array, Object, fetch: fetchStub, AbortController, setTimeout, clearTimeout,
    Headers: class Headers {
      constructor(init) { this._h = {}; if (init) for (const k of Object.keys(init)) this._h[k.toLowerCase()] = init[k]; }
      has(k) { return k.toLowerCase() in this._h; }
      set(k, v) { this._h[k.toLowerCase()] = v; }
      get(k) { return this._h[k.toLowerCase()]; }
    },
  });
  return { api: mod.exports, calls };
}

test('ACCOUNT-UI-01-EMAILED-LINK-PATHS', () => {
  assert.deepEqual(links.parseAccountLink('/reset-password', `?token=${TOKEN}`), { kind: 'reset-password', token: TOKEN });
  assert.deepEqual(links.parseAccountLink('/verify-email/', `?token=${TOKEN}`), { kind: 'verify-email', token: TOKEN });
  assert.deepEqual(links.parseAccountLink('/reset-password', ''), { kind: 'reset-password', token: null });
  assert.equal(links.parseAccountLink('/', `?token=${TOKEN}`), null);
  assert.equal(links.parseAccountLink('/dashboard', ''), null);
});

test('ACCOUNT-UI-02-TOKEN-TAKEN-ONCE-AND-STRIPPED-FROM-THE-URL', () => {
  const replaced = [];
  const link = links.takeAccountLink(
    { pathname: '/reset-password', search: `?token=${TOKEN}` },
    { replaceState: (_s, _t, url) => replaced.push(url) },
  );
  assert.equal(link.token, TOKEN);
  assert.deepEqual(replaced, ['/reset-password'], 'the address bar keeps the page but loses the token');
  assert.equal(links.takeAccountLink(undefined, undefined), null, 'native: no location, no link');
  const untouched = [];
  assert.equal(links.takeAccountLink({ pathname: '/', search: '?x=1' }, { replaceState: () => untouched.push(1) }), null);
  assert.equal(untouched.length, 0, 'other pages are left alone');
});

test('ACCOUNT-UI-03-NEW-PASSWORD-RULE', () => {
  assert.equal(links.PASSWORD_MIN_LENGTH, 6, 'the same minimum registration enforces');
  assert.match(links.validateNewPassword('12345', '12345'), /at least 6/);
  assert.match(links.validateNewPassword('Secret-1', 'Secret-2'), /do not match/);
  assert.equal(links.validateNewPassword('Secret-1', 'Secret-1'), null);
});

test('ACCOUNT-UI-04-REQUEST-SHAPES', async () => {
  const { api, calls } = loadApi(() => ({ status: 200, body: { message: 'ok' } }));
  await api.requestPasswordReset('  guard@example.invalid ');
  await api.resetPassword(TOKEN, 'New-pass-1');
  await api.verifyEmailAddress(TOKEN);
  await api.resendVerificationEmail('guard@example.invalid');
  await api.getAccountDeletionStatus();
  await api.requestAccountDeletion();
  await api.confirmAccountDeletion('Current-pass-1');
  const shape = calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url.replace('https://api.test', '')}`);
  assert.deepEqual(shape, [
    'POST /auth/forgot-password',
    'POST /auth/reset-password',
    'POST /auth/verify-email',
    'POST /auth/resend-verification',
    'GET /account/deletion',
    'POST /account/deletion/request',
    'POST /account/deletion/confirm',
  ]);
  assert.ok(calls.every((c) => !c.url.includes(TOKEN)), 'no token in any URL');
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'guard@example.invalid' }, 'email trimmed');
  assert.deepEqual(JSON.parse(calls[1].init.body), { token: TOKEN, newPassword: 'New-pass-1' });
  assert.deepEqual(JSON.parse(calls[6].init.body), { password: 'Current-pass-1' });
});

test('ACCOUNT-UI-05-REGISTRATION-PENDING-VERIFICATION-HOLDS-NO-SESSION', async () => {
  const pendingReply = { verificationRequired: true, email: 'new@example.invalid', message: 'Check your email' };
  const { api, calls } = loadApi((url) => (url.endsWith('/auth/register') ? { status: 201, body: pendingReply } : { status: 401, body: {} }));
  const result = await api.register({ email: 'new@example.invalid', password: 'x', role: 'guard' });
  assert.equal(api.isRegistrationPending(result), true);
  await api.fetchCurrentUser().catch(() => undefined);
  assert.equal(calls[1].init.headers.get('authorization'), undefined, 'no access token was kept from registration');

  const legacy = loadApi(() => ({ status: 201, body: { accessToken: 'legacy-access', user: { id: 1, email: 'a', role: 'guard' } } }));
  const session = await legacy.api.register({ email: 'a', password: 'x', role: 'guard' });
  assert.equal(legacy.api.isRegistrationPending(session), false, 'an older backend still yields a session');
  assert.equal(session.accessToken, 'legacy-access');
});

test('ACCOUNT-UI-06-VERIFICATION-REQUIRED-IS-RECOGNISED-BY-CODE', async () => {
  const { api } = loadApi(() => ({ status: 403, body: { code: 'EMAIL_VERIFICATION_REQUIRED', message: 'Verify your email' } }));
  const error = await api.login('a@example.invalid', 'pw').catch((e) => e);
  assert.equal(api.isEmailVerificationRequired(error), true);
  const other = loadApi(() => ({ status: 403, body: { message: 'Account status suspended is not allowed to log in' } }));
  assert.equal(other.api.isEmailVerificationRequired(await other.api.login('a', 'b').catch((e) => e)), false);
});

test('ACCOUNT-UI-07-DELETION-COPY-IS-FACTUAL', () => {
  const all = JSON.stringify(ACCOUNT_DELETION_COPY);
  assert.doesNotMatch(all, /all (of )?your data will be (permanently )?(erased|deleted)|permanently erase|everything will be deleted/i,
    'never promises total erasure');
  assert.match(all, /access to S4 will be removed/i);
  assert.match(all, /deleted or anonymised/i);
  assert.match(all, /may be retained/i);
  assert.match(all, /legal, contractual, regulatory, safety or evidential/i);
  assert.doesNotMatch(all, /S4 Security|S4 Guard|Security Marketplace/);
});

// ── rendering the deletion journey ────────────────────────────────────────────────────────────────────
function loadPanel(apiOverrides) {
  const cache = new Map();
  const load = (absolutePath) => {
    const key = path.relative(ROOT, absolutePath).replace(/\\/g, '/').replace(/\.tsx?$/, '');
    if (key === 'src/services/api') return apiOverrides;
    if (cache.has(absolutePath)) return cache.get(absolutePath).exports;
    const out = ts.transpileModule(fs.readFileSync(absolutePath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const mod = { exports: {} };
    cache.set(absolutePath, mod);
    const req = (request) => {
      if (request.startsWith('.')) {
        const base = path.resolve(path.dirname(absolutePath), request);
        for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) if (fs.existsSync(c)) return load(c);
      }
      // react-native-web's TextInput measures itself through the DOM in a layout effect; Node has no DOM,
      // so the input is a plain host element carrying the same props.
      if (request === 'react-native') return { ...require('react-native-web'), TextInput: (props) => h('input', props) };
      return require(request);
    };
    new Function('module', 'exports', 'require', out)(mod, mod.exports, req);
    return mod.exports;
  };
  return load;
}
const text = (renderer) => {
  const out = [];
  const walk = (n) => { if (n == null) return; if (typeof n === 'string') return out.push(n); if (Array.isArray(n)) return n.forEach(walk); (n.children || []).forEach(walk); };
  walk(renderer.toJSON());
  return out.join(' ');
};
const press = async (renderer, label) => {
  const target = renderer.root.findAll((n) => typeof n.props.onPress === 'function' &&
    n.findAll((c) => c.children && c.children.filter((x) => typeof x === 'string').join('').includes(label)).length > 0)[0];
  assert.ok(target, `control "${label}"`);
  await act(async () => { await target.props.onPress(); });
};
const formatApiErrorMessage = (_e, fallback) => fallback;

test('ACCOUNT-UI-08-DELETION-JOURNEY', async () => {
  const calls = [];
  const status = { deletionRequestedAt: null, deletionCompletedAt: null, selfServiceAvailable: true, blocker: null, blockerMessage: null };
  const load = loadPanel({
    formatApiErrorMessage,
    getAccountDeletionStatus: async () => { calls.push('status'); return status; },
    requestAccountDeletion: async () => { calls.push('request'); return { ...status, deletionRequestedAt: '2026-10-04T10:00:00.000Z' }; },
    confirmAccountDeletion: async (password) => { calls.push(`confirm:${password}`); return { deleted: true, message: 'Your S4 account has been deleted and you have been signed out.' }; },
  });
  const { AccountSettingsPanel } = load(path.join(ROOT, 'src/components/account/AccountSettingsPanel.tsx'));
  const deleted = [];
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(AccountSettingsPanel, { email: 'guard@example.invalid', onDeleted: (m) => deleted.push(m) })); });
  assert.match(text(renderer), /Delete account/);
  assert.deepEqual(calls, [], 'nothing happens until the user asks');

  await press(renderer, 'Delete account');
  assert.match(text(renderer), /Delete your S4 account/);
  assert.match(text(renderer), /may be retained/);
  assert.deepEqual(calls, ['status'], 'opening the explanation records nothing');

  await press(renderer, 'Continue');
  assert.deepEqual(calls, ['status', 'request'], 'Continue records the request');
  assert.match(text(renderer), /Confirm account deletion/);

  await press(renderer, 'Delete my account');
  assert.match(text(renderer), /Enter your password/, 'an empty password is refused locally');
  assert.equal(calls.length, 2);

  const input = renderer.root.findAll((n) => n.type === 'input' && n.props.secureTextEntry === true)[0];
  await act(async () => { input.props.onChangeText('Current-pass-1'); });
  await press(renderer, 'Delete my account');
  assert.deepEqual(calls, ['status', 'request', 'confirm:Current-pass-1']);
  assert.deepEqual(deleted, ['Your S4 account has been deleted and you have been signed out.'], 'the app is told to sign out');
});

test('ACCOUNT-UI-09-COMPANY-OWNER-IS-TOLD-WHY', async () => {
  const calls = [];
  const blockerMessage = 'This account owns a company workspace on S4, so deleting it would leave the company without an owner. Contact S4 support so the workspace can be transferred or closed first.';
  const load = loadPanel({
    formatApiErrorMessage,
    getAccountDeletionStatus: async () => ({ selfServiceAvailable: false, blocker: 'company_owner', blockerMessage, deletionRequestedAt: null }),
    requestAccountDeletion: async () => { calls.push('request'); return { selfServiceAvailable: false, blocker: 'company_owner', blockerMessage, deletionRequestedAt: '2026-10-04T10:00:00.000Z' }; },
    confirmAccountDeletion: async () => { calls.push('confirm'); throw new Error('must not be called'); },
  });
  const { AccountSettingsPanel } = load(path.join(ROOT, 'src/components/account/AccountSettingsPanel.tsx'));
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(AccountSettingsPanel, { email: 'owner@example.invalid', onDeleted: () => { throw new Error('no'); } })); });
  await press(renderer, 'Delete account');
  await press(renderer, 'Continue');
  assert.match(text(renderer), /We have recorded your request/);
  assert.match(text(renderer), /transferred or closed/);
  assert.deepEqual(calls, ['request'], 'never confirmed');
  assert.equal(renderer.root.findAll((n) => n.props.secureTextEntry === true).length, 0, 'no password prompt');
});

test('ACCOUNT-UI-10-RESET-SCREEN-HANDLES-A-BAD-LINK-AND-HIDES-THE-TOKEN', async () => {
  const resetCalls = [];
  const load = loadPanel({
    formatApiErrorMessage,
    ApiError: class ApiError extends Error {},
    resetPassword: async (token, pw) => { resetCalls.push([token, pw]); return { passwordReset: true, message: 'Your S4 password has been changed. Sign in with your new password.' }; },
    verifyEmailAddress: async () => ({ emailVerified: true, message: 'verified' }),
  });
  const { AccountLinkScreen } = load(path.join(ROOT, 'src/screens/AccountLinkScreen.tsx'));

  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(AccountLinkScreen, { link: { kind: 'reset-password', token: null }, onDone: () => undefined })); });
  assert.match(text(renderer), /invalid or has expired/, 'a link without a token is refused up front');

  let done = 0;
  await act(async () => { renderer = TestRenderer.create(h(AccountLinkScreen, { link: { kind: 'reset-password', token: TOKEN }, onDone: () => { done += 1; } })); });
  assert.ok(!JSON.stringify(renderer.toJSON()).includes(TOKEN), 'the token is never rendered');
  const [pw, confirm] = renderer.root.findAll((n) => n.type === 'input' && n.props.secureTextEntry === true);
  await act(async () => { pw.props.onChangeText('Fresh-pass-1'); confirm.props.onChangeText('Fresh-pass-2'); });
  await press(renderer, 'Save new password');
  assert.match(text(renderer), /do not match/);
  assert.equal(resetCalls.length, 0);
  await act(async () => { confirm.props.onChangeText('Fresh-pass-1'); });
  await press(renderer, 'Save new password');
  assert.deepEqual(resetCalls, [[TOKEN, 'Fresh-pass-1']]);
  assert.match(text(renderer), /password has been changed/);
  await press(renderer, 'Go to S4 sign in');
  assert.equal(done, 1, 'directs the user back to S4 sign-in');
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed += 1;
      console.log('PASS ', name);
    } catch (error) {
      console.error('FAIL ', name);
      console.error('      ' + (error && (error.stack || error.message)));
      process.exitCode = 1;
    }
  }
  console.log(`\nACCOUNT LIFECYCLE UI: ${passed}/${pending.length} PASS`);
})();
