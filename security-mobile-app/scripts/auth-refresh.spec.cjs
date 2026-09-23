'use strict';

/**
 * Phase 1 — renewable session on the client.
 *
 * Executes the REAL request()/refreshAccessToken()/logout() from api.ts against a scripted fetch,
 * so the single-flight guarantee, the one-retry rule and the offline-logout behaviour are proven
 * rather than asserted from source text.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadApi() {
  const apiSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'api.ts'), 'utf8');
  const compiled = ts.transpileModule(apiSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const calls = [];
  /** Queue of responders keyed by a predicate on the path. */
  let router = () => ({ status: 500, body: { message: 'no route' } });
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    const spec = await router(url, init);
    const status = spec.status;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 401 ? 'Unauthorized' : 'OK',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(spec.body ?? null),
      json: async () => spec.body ?? null,
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
    AbortController, setTimeout, clearTimeout,
    Headers: class Headers {
      constructor(init) { this._h = {}; if (init) for (const k of Object.keys(init)) this._h[k.toLowerCase()] = init[k]; }
      has(k) { return k.toLowerCase() in this._h; }
      set(k, v) { this._h[k.toLowerCase()] = v; }
      get(k) { return this._h[k.toLowerCase()]; }
    },
  });

  return { api: mod.exports, calls, setRouter: (r) => { router = r; } };
}

let passed = 0;
async function test(id, fn) { await fn(); passed += 1; console.log(`PASS  ${id}`); }

(async () => {
  const user = { id: 7, email: 'guard@example.invalid', role: 'guard' };

  // ── LOGIN ────────────────────────────────────────────────────────────────────────────────────
  await test('LOGIN-REQUESTS-MOBILE-SESSION', async () => {
    const { api, calls, setRouter } = loadApi();
    setRouter(() => ({ status: 200, body: { accessToken: 'a1', refreshToken: 'r1', user } }));
    const session = await api.login('guard@example.invalid', 'pw');
    assert.equal(calls.at(-1).init.headers.get('x-s4-client'), 'mobile', 'mobile must identify itself to receive a session');
    assert.ok(!JSON.parse(calls.at(-1).init.body).deviceType, 'the marker must not be a body field an old backend would reject');
    assert.equal(session.refreshToken, 'r1');
    assert.equal(api.getRefreshToken(), 'r1');
  });

  // ── ACCESS-EXPIRY-SILENT-REFRESH ─────────────────────────────────────────────────────────────
  await test('ACCESS-EXPIRY-SILENT-REFRESH', async () => {
    const { api, calls, setRouter } = loadApi();
    api.restoreSession({ accessToken: 'expired', refreshToken: 'r1' });
    let notices = 0;
    api.setUnauthorizedHandler(async () => { notices += 1; });

    let first = true;
    setRouter((url) => {
      if (url.endsWith('/auth/refresh')) return { status: 200, body: { accessToken: 'a2', refreshToken: 'r2', user } };
      if (first) { first = false; return { status: 401, body: { message: 'expired' } }; }
      return { status: 200, body: [{ id: 1 }] };
    });

    const result = await api.listCompanies();
    assert.deepEqual(result, [{ id: 1 }], 'the original request must be replayed and succeed');
    assert.equal(notices, 0, 'a successful renewal must never show the login screen');
    assert.equal(api.getRefreshToken(), 'r2', 'the rotated token must be adopted');
    const refreshCalls = calls.filter((c) => c.url.endsWith('/auth/refresh'));
    assert.equal(refreshCalls.length, 1, 'exactly one refresh');
    assert.match(calls.at(-1).init.headers.get('authorization'), /^Bearer a2$/, 'retry uses the new token');
  });

  // ── REFRESH-RACE ─────────────────────────────────────────────────────────────────────────────
  await test('REFRESH-RACE-SINGLE-FLIGHT', async () => {
    const { api, calls, setRouter } = loadApi();
    api.restoreSession({ accessToken: 'expired', refreshToken: 'r1' });
    api.setUnauthorizedHandler(async () => {});

    const expiredOnce = new Set();
    setRouter(async (url) => {
      if (url.endsWith('/auth/refresh')) {
        await new Promise((r) => setTimeout(r, 15)); // widen the window for a race
        return { status: 200, body: { accessToken: 'a2', refreshToken: 'r2', user } };
      }
      if (!expiredOnce.has(url)) { expiredOnce.add(url); return { status: 401, body: {} }; }
      return { status: 200, body: { ok: true } };
    });

    await Promise.all([api.listCompanies(), api.listSites(), api.fetchCurrentUser()]);
    const refreshCalls = calls.filter((c) => c.url.endsWith('/auth/refresh'));
    assert.equal(refreshCalls.length, 1, 'three concurrent 401s must share ONE refresh');
    assert.equal(api.getRefreshToken(), 'r2');
  });

  // ── INVALID / EXPIRED / REVOKED REFRESH ──────────────────────────────────────────────────────
  await test('INVALID-REFRESH-SHOWS-LOGIN', async () => {
    const { api, calls, setRouter } = loadApi();
    api.restoreSession({ accessToken: 'expired', refreshToken: 'dead' });
    const notices = [];
    api.setUnauthorizedHandler(async (m) => notices.push(m));

    setRouter((url) => (url.endsWith('/auth/refresh')
      ? { status: 401, body: { message: 'Session is no longer valid' } }
      : { status: 401, body: {} }));

    await assert.rejects(api.listCompanies(), (e) => e.status === 401);
    assert.deepEqual(notices, ['Your session expired. Please sign in again.']);
    assert.equal(api.getRefreshToken(), null, 'a dead session must be dropped from memory');
    const refreshCalls = calls.filter((c) => c.url.endsWith('/auth/refresh'));
    assert.equal(refreshCalls.length, 1, 'a failed refresh must not be retried in a loop');
  });

  await test('NO-REFRESH-LOOP', async () => {
    const { api, calls, setRouter } = loadApi();
    api.restoreSession({ accessToken: 'expired', refreshToken: 'r1' });
    api.setUnauthorizedHandler(async () => {});
    // Refresh keeps succeeding but the resource keeps 401ing — the retry must happen once only.
    setRouter((url) => (url.endsWith('/auth/refresh')
      ? { status: 200, body: { accessToken: 'a2', refreshToken: 'r2', user } }
      : { status: 401, body: {} }));

    await assert.rejects(api.listCompanies(), (e) => e.status === 401);
    assert.equal(calls.filter((c) => c.url.endsWith('/auth/refresh')).length, 1);
    assert.equal(calls.filter((c) => c.url.endsWith('/companies')).length, 2, 'original + exactly one retry');
  });

  // ── LOGOUT ───────────────────────────────────────────────────────────────────────────────────
  await test('LOGOUT-REVOKES-SERVER-SIDE', async () => {
    const { api, calls, setRouter } = loadApi();
    api.restoreSession({ accessToken: 'a1', refreshToken: 'r1' });
    setRouter(() => ({ status: 200, body: { loggedOut: true } }));
    await api.logout();
    const logoutCall = calls.find((c) => c.url.endsWith('/auth/logout'));
    assert.ok(logoutCall, 'logout must reach the server');
    assert.equal(JSON.parse(logoutCall.init.body).refreshToken, 'r1', 'the session to revoke must be named');
    assert.equal(api.getRefreshToken(), null);
  });

  await test('NETWORK-FAILURE-LOGOUT-CLEARS-LOCAL', async () => {
    const { api, setRouter } = loadApi();
    api.restoreSession({ accessToken: 'a1', refreshToken: 'r1' });
    setRouter(() => { throw new TypeError('Network request failed'); });
    await api.logout(); // must not reject
    assert.equal(api.getRefreshToken(), null, 'offline logout must still clear this device');
  });

  await test('LOGOUT-STAYS-LOGGED-OUT', async () => {
    const { api, calls, setRouter } = loadApi();
    api.restoreSession({ accessToken: 'a1', refreshToken: 'r1' });
    setRouter(() => ({ status: 200, body: {} }));
    await api.logout();
    const before = calls.length;
    setRouter(() => ({ status: 401, body: {} }));
    await assert.rejects(api.listCompanies(), (e) => e.status === 401);
    const refreshAfter = calls.slice(before).filter((c) => c.url.endsWith('/auth/refresh'));
    assert.equal(refreshAfter.length, 0, 'no token remains, so nothing may be renewed');
  });

  // ── STORAGE / UPGRADE ────────────────────────────────────────────────────────────────────────
  const routing = (() => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'navigation', 'role-routing.ts'), 'utf8');
    const compiled = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const mod = { exports: {} };
    vm.runInNewContext(compiled, { exports: mod.exports, module: mod, require, JSON, Object, Array });
    return mod.exports;
  })();

  await test('APP-RESTART-STAYS-SIGNED-IN', async () => {
    // What SecureStore holds after a login, replayed as a cold start.
    const stored = routing.parseStoredSession(
      routing.serializeStoredSession({ user, refreshToken: 'r1' }),
    );
    assert.equal(stored.refreshToken, 'r1', 'the renewable token must survive a restart');

    const { api, calls, setRouter } = loadApi();
    api.restoreSession({ accessToken: undefined, refreshToken: stored.refreshToken });
    api.setUnauthorizedHandler(async () => { throw new Error('must not reach login'); });
    let first = true;
    setRouter((url) => {
      if (url.endsWith('/auth/refresh')) return { status: 200, body: { accessToken: 'a2', refreshToken: 'r2', user } };
      if (first) { first = false; return { status: 401, body: {} }; }
      return { status: 200, body: user };
    });
    // A cold start has no access token; the first call 401s and is renewed silently.
    assert.deepEqual(await api.fetchCurrentUser(), user);
    assert.equal(calls.filter((c) => c.url.endsWith('/auth/refresh')).length, 1);
  });

  await test('ACCESS-TOKEN-NEVER-PERSISTED', () => {
    const raw = routing.serializeStoredSession({ user, refreshToken: 'r1', accessToken: 'must-not-persist' });
    assert.ok(!raw.includes('must-not-persist'), 'the access token must never reach storage');
    assert.ok(raw.includes('r1'));
  });

  await test('OLD-APK-SESSION-UPGRADE', () => {
    // Exactly what v1.0.0–v1.0.3 wrote: version 2 with a bare access token.
    const legacyRaw = JSON.stringify({ version: 2, session: { accessToken: 'old-token', user } });
    const parsed = routing.parseStoredSession(legacyRaw);
    assert.ok(parsed, 'an upgrade must not discard the existing session outright');
    assert.equal(parsed.legacyAccessToken, 'old-token', 'the old token is carried for its remaining life');
    assert.equal(parsed.refreshToken, undefined, 'there is no renewable session to inherit');
    assert.equal(parsed.user.id, user.id);
    // A v3 blob missing the renewable token is unusable rather than half-restored.
    assert.equal(routing.parseStoredSession(JSON.stringify({ version: 3, session: { user } })), null);
  });

  await test('OLD-APK-SESSION-FALLS-BACK-TO-LOGIN-ONCE', async () => {
    const { api, calls, setRouter } = loadApi();
    // Upgraded install: an old access token, no refresh token.
    api.restoreSession({ accessToken: 'old-token', refreshToken: undefined });
    const notices = [];
    api.setUnauthorizedHandler(async (m) => notices.push(m));
    setRouter(() => ({ status: 401, body: {} }));
    await assert.rejects(api.listCompanies(), (e) => e.status === 401);
    assert.equal(calls.filter((c) => c.url.endsWith('/auth/refresh')).length, 0, 'nothing to refresh with');
    assert.equal(notices.length, 1, 'one clean login establishes the new session');
  });

  // ── WEB COMPATIBILITY ────────────────────────────────────────────────────────────────────────
  await test('WEB-LOGIN-COMPATIBILITY', () => {
    const backend = fs.readFileSync(
      path.join(__dirname, '..', '..', 'security-backend-nest', 'src', 'auth', 'auth.service.ts'),
      'utf8',
    );
    const login = backend.split('async login(')[1].split('async refresh(')[0];
    assert.match(login, /if \(!isMobileClient\) return signed;/, 'a non-mobile login must return early');
    assert.ok(
      login.indexOf('!isMobileClient') < login.indexOf('authSessionService.create'),
      'no session may be minted before the mobile check',
    );
    const dto = fs.readFileSync(
      path.join(__dirname, '..', '..', 'security-backend-nest', 'src', 'auth', 'dto', 'login.dto.ts'),
      'utf8',
    );
    // The login body must stay byte-identical to what older deployments validate: the backend
    // runs forbidNonWhitelisted, so any new body property would make them reject the login.
    assert.ok(!dto.includes('deviceType'), 'the mobile marker must not be a login body property');
    const main = fs.readFileSync(
      path.join(__dirname, '..', '..', 'security-backend-nest', 'src', 'main.ts'),
      'utf8',
    );
    assert.match(main, /forbidNonWhitelisted: true/, 'the constraint this design works around must still hold');
  });

  await test('REFRESH-ENDPOINT-EXCLUDED-FROM-INTERCEPTOR', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'api.ts'), 'utf8');
    const guard = src.split('const isAuthEndpoint =')[1].split(';')[0];
    for (const p of ['/auth/login', '/auth/register', '/auth/refresh']) {
      assert.ok(guard.includes(p), `${p} must never trigger a nested refresh`);
    }
  });

  console.log(JSON.stringify({ event: 'auth_refresh_tests_passed', tests: passed }));
})().catch((err) => {
  console.error('FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});
