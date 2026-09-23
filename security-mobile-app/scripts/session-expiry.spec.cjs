'use strict';

/**
 * P0-2 — expired / invalid session handling on the client.
 *
 * The backend answers a missing / malformed / expired / forged JWT with 401 (a permission failure stays 403).
 * The mobile client must react to 401 — and only 401 — by running the unauthorized handler, which App.tsx wires to
 * "clear the stored session → login screen", with no manual logout. This executes the REAL request() from api.ts.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

(async () => {
  const apiSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'api.ts'), 'utf8');
  const compiled = ts.transpileModule(apiSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  let nextResponse = null;
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    return nextResponse;
  };
  const respond = (status, body) => {
    nextResponse = {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'OK',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(body),
    };
  };

  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: mod.exports,
    module: mod,
    require: (id) => {
      if (id === 'expo-constants') return { default: { expoConfig: { extra: { apiBaseUrl: 'https://test.example' } } } };
      if (id.endsWith('api-base-url')) return { resolveApiBaseUrl: () => 'https://test.example' };
      if (id.endsWith('models')) return {};
      return require(id);
    },
    process, console, Error, TypeError, Promise, JSON, Array, Object,
    fetch: fetchStub,
    AbortController,
    setTimeout,
    clearTimeout,
    Headers: class Headers {
      constructor(init) { this._h = {}; if (init) for (const k of Object.keys(init)) this._h[k.toLowerCase()] = init[k]; }
      has(k) { return k.toLowerCase() in this._h; }
      set(k, v) { this._h[k.toLowerCase()] = v; }
      get(k) { return this._h[k.toLowerCase()]; }
    },
  });
  const api = mod.exports;

  const notices = [];
  api.setUnauthorizedHandler(async (message) => { notices.push(message); });
  const session = { accessToken: 'stored-but-expired-token', user: { id: 1, role: 'guard' } };
  let passed = 0;

  // EXPIRED-TOKEN: signed-in client gets 401 → handler runs once with the session-expired notice.
  api.restoreSession(session);
  respond(401, { statusCode: 401, message: 'Authentication required' });
  await assert.rejects(api.fetchCurrentUser(), (e) => e.name === 'ApiError' && e.status === 401);
  assert.deepEqual(notices, ['Your session expired. Please sign in again.']);
  assert.match(calls.at(-1).init.headers.get('authorization'), /^Bearer stored-but-expired-token$/);
  passed++;

  // Any protected call behaves the same (not just /auth/me).
  notices.length = 0;
  api.restoreSession(session); // a failed renewal clears memory, so sign back in for this case
  respond(401, { statusCode: 401, message: 'Authentication required' });
  await assert.rejects(api.listCompanies(), (e) => e.status === 401);
  assert.equal(notices.length, 1);
  passed++;

  // VALID-WRONG-PERMISSION: 403 must NOT sign the user out.
  notices.length = 0;
  respond(403, { statusCode: 403, message: 'Forbidden resource' });
  await assert.rejects(api.listCompanies(), (e) => e.status === 403);
  assert.equal(notices.length, 0, '403 is a permission failure, not an expired session');
  passed++;

  // A wrong password at sign-in is a 401 too, but there is no session to expire.
  notices.length = 0;
  respond(401, { statusCode: 401, message: 'Invalid credentials' });
  await assert.rejects(api.login('a@b.test', 'wrong'), (e) => e.status === 401);
  assert.equal(notices.length, 0, 'failed login must not run the session-expired handler');
  passed++;

  // No stored token → nothing to clear.
  api.logout();
  notices.length = 0;
  respond(401, { statusCode: 401, message: 'Authentication required' });
  await assert.rejects(api.listCompanies(), (e) => e.status === 401);
  assert.equal(notices.length, 0);
  passed++;

  // App.tsx: the handler drops the in-memory token, the persisted session and the React session → login screen.
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8');
  const handler = app.match(/setUnauthorizedHandler\(async \(message: string\) => \{([^}]*)\}\);/);
  assert.ok(handler, 'App.tsx registers the unauthorized handler');
  for (const step of ['await clearStoredSession()', 'setSession(null)', 'setAuthNotice(message)']) {
    assert.ok(handler[1].includes(step), `unauthorized handler must run ${step}`);
  }
  assert.match(app, /setUnauthorizedHandler\(null\); setRefreshPersister\(null\)/, 'both auth hooks must be torn down together');
  // Boot: the stored token is restored BEFORE /auth/me is refreshed, so an expired stored token is also handled.
  assert.ok(app.indexOf('restoreSession({') < app.indexOf('fetchCurrentUser()'));
  passed++;

  console.log(JSON.stringify({ event: 'session_expiry_tests_passed', tests: passed }));
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
