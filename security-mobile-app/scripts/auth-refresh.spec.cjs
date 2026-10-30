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

/** `timers` replaces setTimeout/clearTimeout inside api.ts only (to run its 30 s limits without waiting 30 s). */
function loadApi({ timers } = {}) {
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
      if (id.endsWith('api-base-url')) return { resolveApiBaseUrl: () => 'https://test.example', isUatBuild: () => false, resolveUatApiBaseUrl: () => ({ ok: false, reason: 'store-app spec' }) };
      if (id.endsWith('models')) return {};
      return require(id);
    },
    process, console, Error, TypeError, Promise, JSON, Array, Object,
    fetch: fetchStub,
    AbortController,
    setTimeout: timers ? timers.setTimeout : setTimeout,
    clearTimeout: timers ? timers.clearTimeout : clearTimeout,
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

  // ── SERVICE UNAVAILABLE DURING REFRESH ───────────────────────────────────────────────────────
  // Production incident: an overloaded backend answered /auth/refresh with 500, and the client
  // treated that as a dead session and signed people out, sending everyone to Login at once.
  for (const [id, refreshResponse] of [
    ['REFRESH-SERVER-ERROR-KEEPS-SESSION', { status: 500, body: { message: 'Internal server error' } }],
    ['REFRESH-BAD-GATEWAY-KEEPS-SESSION', { status: 502, body: null }],
    ['REFRESH-RATE-LIMITED-KEEPS-SESSION', { status: 429, body: { message: 'Too many requests' } }],
    ['REFRESH-UNREACHABLE-KEEPS-SESSION', 'throw'],
  ]) {
    await test(id, async () => {
      const { api, calls, setRouter } = loadApi();
      api.restoreSession({ accessToken: 'expired', refreshToken: 'r1' });
      const notices = [];
      api.setUnauthorizedHandler(async (m) => notices.push(m));

      let serviceBack = false;
      setRouter((url) => {
        if (url.endsWith('/auth/refresh')) {
          if (serviceBack) return { status: 200, body: { accessToken: 'a2', refreshToken: 'r2', user } };
          if (refreshResponse === 'throw') throw new TypeError('Network request failed');
          return refreshResponse;
        }
        const auth = calls.at(-1).init.headers.get('authorization');
        return auth === 'Bearer a2' ? { status: 200, body: [{ id: 1 }] } : { status: 401, body: {} };
      });

      await assert.rejects(api.listCompanies(), (e) => e.status === 503 && /still signed in/.test(e.body.message));
      assert.deepEqual(notices, [], 'an unavailable service must never show the login screen');
      assert.equal(api.getRefreshToken(), 'r1', 'the session must be kept for the next attempt');
      assert.equal(calls.filter((c) => c.url.endsWith('/auth/refresh')).length, 1, 'still exactly one refresh per burst');

      // When the service recovers, the kept session renews and the request succeeds.
      serviceBack = true;
      assert.deepEqual(await api.listCompanies(), [{ id: 1 }]);
      assert.equal(api.getRefreshToken(), 'r2');
      assert.deepEqual(notices, []);
    });
  }

  // Production, 25 Oct 2026: a renewal that never answered had no time limit, and every request waiting on it (the 401
  // retries all share it) hung with it, which left a Guard on "Accepting…". It now has the same 30 s limit as every
  // other request, and running out of time is the service being unavailable: the session is kept.
  await test('REFRESH-TIMEOUT-KEEPS-SESSION', async () => {
    const delays = [];
    // Each 30 s limit fires after 5 ms instead; nothing else in api.ts uses a timer.
    const timers = {
      setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, ms >= 30_000 ? 5 : ms); },
      clearTimeout: (id) => clearTimeout(id),
    };
    const { api, calls, setRouter } = loadApi({ timers });
    api.restoreSession({ accessToken: 'expired', refreshToken: 'r1' });
    const notices = [];
    api.setUnauthorizedHandler(async (m) => notices.push(m));
    let stalled = true;
    setRouter((url, init) => {
      if (url.endsWith('/auth/refresh')) {
        if (!stalled) return { status: 200, body: { accessToken: 'a2', refreshToken: 'r2', user } };
        // The renewal never answers; only its abort signal ends it, as fetch does.
        return new Promise((_, reject) => {
          // (Without a signal it simply never settles: the defect.)
          if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
        });
      }
      const auth = calls.at(-1).init.headers.get('authorization');
      return auth === 'Bearer a2' ? { status: 200, body: [{ id: 1 }] } : { status: 401, body: {} };
    });
    const outcome = await Promise.race([
      api.listCompanies().then(() => 'resolved', (e) => e),
      new Promise((resolve) => setTimeout(() => resolve('still hanging'), 2_000)),
    ]);
    assert.notEqual(outcome, 'still hanging', 'a stalled renewal must end');
    assert.ok(outcome.status === 503 && /still signed in/.test(outcome.body.message), 'reported as unavailable, not as signed out');
    assert.ok(delays.includes(30_000), 'the renewal has the same 30 s limit as other requests');
    assert.deepEqual(notices, [], 'no login screen');
    assert.equal(api.getRefreshToken(), 'r1', 'the session is kept for the next attempt');
    stalled = false;
    assert.deepEqual(await api.listCompanies(), [{ id: 1 }], 'and renews once the service answers');
    assert.equal(api.getRefreshToken(), 'r2');
  });

  await test('REFRESH-REFUSED-STILL-ENDS-SESSION', async () => {
    // 400/401/403 from refresh are refusals: the session is over, exactly as before.
    for (const status of [400, 401, 403]) {
      const { api, setRouter } = loadApi();
      api.restoreSession({ accessToken: 'expired', refreshToken: 'dead' });
      const notices = [];
      api.setUnauthorizedHandler(async (m) => notices.push(m));
      setRouter((url) => (url.endsWith('/auth/refresh') ? { status, body: {} } : { status: 401, body: {} }));
      await assert.rejects(api.listCompanies(), (e) => e.status === 401);
      assert.deepEqual(notices, ['Your session expired. Please sign in again.'], `refresh ${status}`);
      assert.equal(api.getRefreshToken(), null, `refresh ${status} drops the session`);
    }
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

  // This exact gap shipped a live bug: the service took an isMobileClient flag but the controller
  // never passed it, so mobile login silently returned no session. tsc could not catch it because
  // the parameter has a default, and every other test asserted the service in isolation.
  await test('CONTROLLER-WIRES-MOBILE-HEADER', () => {
    const dir = path.join(__dirname, '..', '..', 'security-backend-nest', 'src', 'auth');
    const controller = fs.readFileSync(path.join(dir, 'auth.controller.ts'), 'utf8');
    // Start at the handler signature, not at @Post: the @Throttle decorator above it contains
    // braces that would truncate the slice before the signature is reached.
    const handler = controller.split("@Post('login')")[1].split('  login(')[1].split('\n  }')[0];
    assert.match(handler, /@Headers\(MOBILE_CLIENT_HEADER\)/, 'the login handler must read the client header');
    assert.match(
      handler,
      /this\.authService\.login\(dto, client === 'mobile'\)/,
      'the header must be passed to the service, not dropped',
    );
    const constants = fs.readFileSync(path.join(dir, 'auth.constants.ts'), 'utf8');
    assert.match(constants, /MOBILE_CLIENT_HEADER = 'x-s4-client'/);
    const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'api.ts'), 'utf8');
    assert.match(api, /'x-s4-client': 'mobile'/, 'the client must send exactly the header the controller reads');
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
