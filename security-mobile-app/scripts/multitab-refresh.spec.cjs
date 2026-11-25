'use strict';

/**
 * S4-REL multi-tab session renewal (web portal).
 *
 * Production, 24 Nov 2026: two portal tabs of one signed-in person renewed at the same moment, both presented the same
 * refresh token, and the server — correctly — treated the second use as token theft (`auth.session_reuse_detected`) and
 * revoked the whole session, signing the person out of every tab.
 *
 * This executes the REAL api.ts (request / refreshAccessToken / logout) twice — two tabs, two module instances, as a
 * browser has — wired through the REAL services/crossTabAuth, sharing one fake localStorage (with storage events to the
 * other tab), one fake Web Locks manager and one fake BroadcastChannel bus. The backend below rotates refresh tokens and
 * revokes the family on any reuse exactly like AuthSessionService.rotate(), so "no reuse" is proven, not assumed.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { loadTs } = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const crossTab = loadTs('src/services/crossTabAuth.ts');
const { serializeStoredSession } = loadTs('src/navigation/role-routing.ts');
const SESSION_KEY = 'security-app-session';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const apiCompiled = ts.transpileModule(fs.readFileSync(path.join(ROOT, 'src', 'services', 'api.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

// ── Fake backend: rotation and reuse detection as AuthSessionService implements them ────────────────────────────────
function createBackend(user) {
  let n = 1;
  const live = new Set(['r1']); // live refresh tokens (one family)
  const rotated = new Set(); // presented once already: any further use is reuse
  const validAccess = new Set();
  const log = { refreshPresented: [], reuseDetected: 0, logoutPresented: [] };

  function revokeFamily() { for (const t of live) rotated.add(t); live.clear(); validAccess.clear(); }

  async function handle(url, init) {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (url.endsWith('/auth/refresh')) {
      log.refreshPresented.push(body.refreshToken);
      await tick(10); // a real round trip: wide enough for the other tab to race it
      if (live.has(body.refreshToken)) {
        live.delete(body.refreshToken);
        rotated.add(body.refreshToken);
        n += 1;
        const next = { accessToken: `a${n}`, refreshToken: `r${n}` };
        live.add(next.refreshToken);
        validAccess.add(next.accessToken);
        return { status: 200, body: { ...next, user } };
      }
      if (rotated.has(body.refreshToken)) { log.reuseDetected += 1; revokeFamily(); }
      return { status: 401, body: { message: 'Session is no longer valid' } };
    }
    const auth = (init.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!validAccess.has(auth)) return { status: 401, body: { message: 'Unauthorized' } };
    if (url.endsWith('/auth/logout')) {
      log.logoutPresented.push(body.refreshToken);
      if (live.has(body.refreshToken)) revokeFamily(); // a rotated token is a silent no-op, as on the server
      return { status: 200, body: { loggedOut: true } };
    }
    return { status: 200, body: [{ id: 1 }] };
  }

  return { handle, log, live, validAccess };
}

// ── One browser: shared localStorage, Web Locks and BroadcastChannel across its tabs ─────────────────────────────────
function createBrowser({ locks = true, broadcast = true } = {}) {
  const data = new Map();
  const tabs = [];
  // Web Locks semantics: FIFO exclusive queue; `ifAvailable` gets a null lock at once when it is held or queued.
  let lockTail = Promise.resolve();
  let lockBusy = 0;
  const lockLog = { requests: 0, contended: 0 };
  const sharedLocks = {
    request(name, options, callback) {
      lockLog.requests += 1;
      if (options.ifAvailable && lockBusy > 0) { lockLog.contended += 1; return Promise.resolve().then(() => callback(null)); }
      lockBusy += 1;
      const run = lockTail.then(() => callback({ name }));
      const settled = run.finally(() => { lockBusy -= 1; });
      lockTail = settled.catch(() => undefined);
      return settled;
    },
  };
  const channels = new Set();

  function storageFor(tab) {
    const change = (key, oldValue, newValue) => {
      // Storage events reach every OTHER tab, asynchronously; never the tab that wrote.
      for (const other of tabs) {
        if (other === tab) continue;
        const deliver = () => other.storageListeners.forEach((l) => l({ key, oldValue, newValue }));
        if (other.holdEvents) other.heldEvents.push(deliver); else setTimeout(deliver, 0);
      }
    };
    return {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => { const old = data.has(key) ? data.get(key) : null; data.set(key, String(value)); change(key, old, String(value)); },
      removeItem: (key) => { if (!data.has(key)) return; const old = data.get(key); data.delete(key); change(key, old, null); },
    };
  }

  function channelFor(tab) {
    return () => {
      const channel = {
        tab,
        onmessage: null,
        postMessage(message) {
          const copy = JSON.parse(JSON.stringify(message)); // structured clone
          for (const other of channels) {
            if (other === channel) continue;
            const deliver = () => other.onmessage && other.onmessage({ data: copy });
            if (other.tab.holdEvents) other.tab.heldEvents.push(deliver); else setTimeout(deliver, 0);
          }
        },
        close() { channels.delete(channel); },
      };
      channels.add(channel);
      return channel;
    };
  }

  function envFor(tab) {
    return {
      storage: storageFor(tab),
      locks: locks ? sharedLocks : null,
      createChannel: broadcast ? channelFor(tab) : null,
      addStorageListener(listener) { tab.storageListeners.push(listener); return () => { tab.storageListeners = tab.storageListeners.filter((l) => l !== listener); }; },
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h),
      randomId: () => Math.random().toString(36).slice(2),
    };
  }

  return { data, tabs, lockLog, envFor };
}

function loadApi(backend) {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    const spec = await backend.handle(url, init);
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      statusText: spec.status === 401 ? 'Unauthorized' : 'OK',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(spec.body ?? null),
      json: async () => spec.body ?? null,
    };
  };
  const mod = { exports: {} };
  vm.runInNewContext(apiCompiled, {
    exports: mod.exports,
    module: mod,
    require: (id) => {
      if (id === 'expo-constants') return { default: { expoConfig: { extra: { apiBaseUrl: 'https://test.example' } } } };
      if (id.endsWith('api-base-url')) return { resolveApiBaseUrl: () => 'https://test.example', isUatBuild: () => false, resolveUatApiBaseUrl: () => ({ ok: false, reason: 'spec' }) };
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
  return { api: mod.exports, calls };
}

/** A portal tab as App.tsx wires it on web: restored from storage, persister, unauthorized handler, cross-tab install. */
function openTab(browser, backend, user, { accessToken = 'expired' } = {}) {
  const tab = { storageListeners: [], holdEvents: false, heldEvents: [], notices: [], signedOutElsewhere: [] };
  browser.tabs.push(tab);
  const env = browser.envFor(tab);
  const { api, calls } = loadApi(backend);
  tab.api = api;
  tab.calls = calls;
  tab.env = env;
  tab.uninstall = crossTab.installCrossTabAuth({
    api: { setRefreshCoordination: api.setRefreshCoordination, adoptSharedSession: api.adoptSharedSession, clearLocalSession: api.clearLocalSession, getRefreshToken: api.getRefreshToken },
    env,
    sessionKey: SESSION_KEY,
    onSignedOutElsewhere: (message) => tab.signedOutElsewhere.push(message),
  });
  api.setRefreshPersister(async (session) => { env.storage.setItem(SESSION_KEY, serializeStoredSession(session)); });
  api.setUnauthorizedHandler(async (message) => { tab.notices.push(message); env.storage.removeItem(SESSION_KEY); });
  const stored = JSON.parse(env.storage.getItem(SESSION_KEY)).session;
  api.restoreSession({ accessToken, refreshToken: stored.refreshToken });
  tab.release = async () => { tab.holdEvents = false; const held = tab.heldEvents.splice(0); for (const d of held) d(); await tick(5); };
  return tab;
}

function signedInBrowser(options) {
  const user = { id: 7, email: 'controller@example.invalid', role: 'company_admin' };
  const browser = createBrowser(options);
  const backend = createBackend(user);
  browser.data.set(SESSION_KEY, serializeStoredSession({ user, refreshToken: 'r1' }));
  return { browser, backend, user };
}

const authOf = (call) => call.init.headers.get('authorization');
const refreshes = (tab) => tab.calls.filter((c) => c.url.endsWith('/auth/refresh'));
const storedToken = (browser) => JSON.parse(browser.data.get(SESSION_KEY)).session.refreshToken;

let passed = 0;
async function test(id, fn) { await fn(); passed += 1; console.log(`PASS  ${id}`); }

(async () => {
  await test('MT-01 concurrent 401s in two tabs produce exactly ONE refresh; the second tab adopts the rotated session', async () => {
    const { browser, backend } = signedInBrowser();
    const a = openTab(browser, backend);
    const b = openTab(browser, backend);
    const [ra, rb] = await Promise.all([a.api.listCompanies(), b.api.listCompanies()]);
    assert.deepEqual(ra, [{ id: 1 }]);
    assert.deepEqual(rb, [{ id: 1 }]);
    assert.equal(backend.log.refreshPresented.length, 1, 'one /auth/refresh across both tabs');
    assert.deepEqual(backend.log.refreshPresented, ['r1']);
    assert.equal(backend.log.reuseDetected, 0, 'the server never sees a reused token');
    assert.equal(a.api.getRefreshToken(), 'r2');
    assert.equal(b.api.getRefreshToken(), 'r2', 'the waiting tab holds the successor');
    assert.equal(storedToken(browser), 'r2');
    const winner = refreshes(a).length ? a : b;
    const waiter = winner === a ? b : a;
    assert.equal(refreshes(waiter).length, 0, 'the waiting tab sent no refresh of its own');
    assert.equal(authOf(waiter.calls.at(-1)), 'Bearer a2', 'the waiting tab retried with the handed-over access token');
    assert.deepEqual([...a.notices, ...b.notices, ...a.signedOutElsewhere, ...b.signedOutElsewhere], [], 'nobody is signed out');
    assert.ok(browser.lockLog.requests >= 2, 'both renewals went through the cross-tab lock');
    assert.ok(!browser.data.has('s4-auth-refresh-lease'), 'Web Locks path leaves no lease behind');
    assert.ok(![...browser.data.values()].some((v) => /\ba2\b/.test(v)), 'no access token is ever persisted');
  });

  await test('MT-02 a tab that has not heard of a rotation never sends the stale refresh token', async () => {
    const { browser, backend } = signedInBrowser();
    const a = openTab(browser, backend);
    const b = openTab(browser, backend);
    b.holdEvents = true; // B hears nothing (no storage event, no broadcast) until released
    await a.api.listCompanies();
    assert.equal(b.api.getRefreshToken(), 'r1', 'precondition: B still holds the rotated token in memory');
    await b.api.listCompanies(); // B's access token is expired → renewal under the lock re-reads the store first
    assert.ok(!backend.log.refreshPresented.slice(1).includes('r1'), 'r1 is never presented after A rotated it');
    assert.equal(backend.log.reuseDetected, 0);
    assert.deepEqual(backend.log.refreshPresented, ['r1', 'r2'], 'without the handoff, B renews with the CURRENT token');
    assert.equal(storedToken(browser), 'r3');
    await b.release();
    await tick(5);
    assert.equal(a.api.getRefreshToken(), 'r3', 'A adopted B\'s rotation from the storage event');
    await a.api.listCompanies();
    assert.equal(backend.log.reuseDetected, 0, 'and A never presents r2 afterwards either');
    assert.deepEqual([...a.notices, ...b.notices], []);
  });

  await test('MT-03 a rotation broadcast reaches the other tab, which then needs no refresh at all', async () => {
    const { browser, backend } = signedInBrowser();
    const a = openTab(browser, backend);
    const b = openTab(browser, backend);
    await a.api.listCompanies();
    await tick(5);
    assert.equal(b.api.getRefreshToken(), 'r2', 'storage event / broadcast delivered the successor');
    await b.api.listCompanies();
    assert.equal(backend.log.refreshPresented.length, 1, 'B used the access token A broadcast');
    assert.equal(authOf(b.calls.at(-1)), 'Bearer a2');
  });

  await test('MT-04 logout in one tab signs the other out cleanly, and revokes the current token server-side', async () => {
    const { browser, backend } = signedInBrowser();
    const a = openTab(browser, backend);
    const b = openTab(browser, backend);
    await Promise.all([a.api.listCompanies(), b.api.listCompanies()]);
    // App.tsx handleLogout: logout() then clearStoredSession().
    await a.api.logout();
    a.env.storage.removeItem(SESSION_KEY);
    await tick(5);
    assert.deepEqual(backend.log.logoutPresented, ['r2']);
    assert.equal(backend.live.size, 0, 'the session family is revoked');
    assert.equal(b.api.getRefreshToken(), null, 'the other tab dropped its copy');
    assert.deepEqual(b.signedOutElsewhere, [crossTab.SIGNED_OUT_ELSEWHERE_MESSAGE]);
    assert.equal(b.calls.filter((c) => c.url.endsWith('/auth/logout')).length, 0, 'the other tab sends nothing');
    const before = b.calls.length;
    await assert.rejects(b.api.listCompanies(), (e) => e.status === 401);
    assert.equal(refreshes(b).length, 0, 'a signed-out tab cannot try to renew');
    assert.equal(b.calls.length, before + 1);
  });

  await test('MT-05 logout from a tab with a stale in-memory token presents the stored current one', async () => {
    const { browser, backend } = signedInBrowser();
    const a = openTab(browser, backend, undefined, { accessToken: 'expired' });
    const b = openTab(browser, backend);
    b.holdEvents = true;
    await a.api.listCompanies(); // r1 → r2; B has not heard
    b.api.adoptSharedSession({ refreshToken: 'r1', accessToken: 'a2' }); // B has a working access token, stale refresh token
    await b.api.logout();
    assert.deepEqual(backend.log.logoutPresented, ['r2'], 'r1 would be a silent no-op and leave the session alive');
    assert.equal(backend.live.size, 0);
  });

  await test('MT-06 a renewal rejected in one tab signs the other out instead of letting it present the dead token', async () => {
    const { browser, backend } = signedInBrowser();
    const a = openTab(browser, backend);
    const b = openTab(browser, backend);
    backend.live.clear(); // the session was revoked server-side (e.g. password reset)
    const results = await Promise.allSettled([a.api.listCompanies(), b.api.listCompanies()]);
    assert.ok(results.every((r) => r.status === 'rejected' && r.reason.status === 401));
    assert.equal(backend.log.refreshPresented.length, 1, 'the second tab saw the session was gone and did not retry it');
    assert.equal(a.api.getRefreshToken(), null);
    assert.equal(b.api.getRefreshToken(), null);
    assert.ok(!browser.data.has(SESSION_KEY));
  });

  await test('MT-07 without Web Locks or BroadcastChannel the localStorage lease still serialises renewal', async () => {
    const { browser, backend } = signedInBrowser({ locks: false, broadcast: false });
    const a = openTab(browser, backend);
    const b = openTab(browser, backend);
    const [ra, rb] = await Promise.all([a.api.listCompanies(), b.api.listCompanies()]);
    assert.deepEqual(ra, [{ id: 1 }]);
    assert.deepEqual(rb, [{ id: 1 }]);
    assert.equal(backend.log.reuseDetected, 0, 'never a reused token');
    assert.equal(backend.log.refreshPresented[0], 'r1');
    assert.ok(!backend.log.refreshPresented.slice(1).includes('r1'), 'the waiting tab never re-sends r1');
    assert.equal(new Set(backend.log.refreshPresented).size, backend.log.refreshPresented.length, 'no token is presented twice');
    assert.equal(browser.lockLog.requests, 0);
    assert.ok(!browser.data.has('s4-auth-refresh-lease'), 'the lease is released');
    assert.deepEqual([...a.notices, ...b.notices], []);
  });

  await test('MT-08 a second tab opening mid-renewal (cold start, no access token) waits and adopts', async () => {
    const { browser, backend } = signedInBrowser();
    const a = openTab(browser, backend);
    const pending = a.api.listCompanies();
    await tick(1); // A holds the lock and its refresh is on the wire
    const b = openTab(browser, backend, undefined, { accessToken: undefined }); // restored from storage: r1, no access token
    const [ra, user] = await Promise.all([pending, b.api.fetchCurrentUser()]);
    assert.deepEqual(ra, [{ id: 1 }]);
    assert.ok(user);
    assert.equal(backend.log.refreshPresented.length, 1);
    assert.equal(backend.log.reuseDetected, 0);
    assert.equal(b.api.getRefreshToken(), 'r2');
  });

  await test('MT-09 another account signing in elsewhere signs this tab out', async () => {
    const { browser, backend } = signedInBrowser();
    const a = openTab(browser, backend);
    const b = openTab(browser, backend);
    a.env.storage.setItem(SESSION_KEY, serializeStoredSession({ user: { id: 99, email: 'other@example.invalid', role: 'guard' }, refreshToken: 'x1' }));
    await tick(5);
    assert.equal(b.api.getRefreshToken(), null);
    assert.deepEqual(b.signedOutElsewhere, [crossTab.OTHER_ACCOUNT_MESSAGE]);
  });

  await test('MT-10 a late, out-of-order rotation message never brings back a rotated token', async () => {
    const { browser, backend } = signedInBrowser();
    const a = openTab(browser, backend);
    const b = openTab(browser, backend);
    const c = openTab(browser, backend);
    c.holdEvents = true;
    b.holdEvents = true; // B gets no handoff from A, so its own renewal really rotates
    await a.api.listCompanies(); // r1 → r2 (A)
    await tick(5);
    b.api.restoreSession({ accessToken: 'expired', refreshToken: 'r2' });
    await b.api.listCompanies(); // r2 → r3 (B)
    assert.deepEqual(backend.log.refreshPresented, ['r1', 'r2']);
    // Deliver C's held events newest first.
    const held = c.heldEvents.splice(0).reverse();
    c.holdEvents = false;
    for (const deliver of held) deliver();
    await tick(5);
    assert.equal(c.api.getRefreshToken(), 'r3', 'the retired r2 was not re-adopted');
    await c.api.listCompanies();
    assert.equal(backend.log.reuseDetected, 0);
  });

  await test('MT-11 uninstall restores the plain single-tab behaviour', async () => {
    const { browser, backend } = signedInBrowser();
    const a = openTab(browser, backend);
    a.uninstall();
    await a.api.listCompanies();
    assert.equal(browser.lockLog.requests, 0, 'no lock without coordination');
    assert.deepEqual(backend.log.refreshPresented, ['r1']);
  });

  await test('MT-12 native path unchanged: no coordination installed, plain single-flight', async () => {
    const user = { id: 7, email: 'guard@example.invalid', role: 'guard' };
    const backend = createBackend(user);
    const { api, calls } = loadApi(backend);
    const persisted = [];
    api.setRefreshPersister(async (s) => { persisted.push(s.refreshToken); });
    api.restoreSession({ accessToken: 'expired', refreshToken: 'r1' });
    await Promise.all([api.listCompanies(), api.listCompanies(), api.fetchCurrentUser()]);
    assert.equal(calls.filter((c) => c.url.endsWith('/auth/refresh')).length, 1);
    assert.deepEqual(persisted, ['r2']);
    assert.equal(api.getRefreshToken(), 'r2');
    // App.tsx installs coordination on web only, and the browser environment needs a window.
    const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
    const install = app.slice(app.indexOf('installCrossTabAuth({') - 200, app.indexOf('installCrossTabAuth({'));
    assert.match(install, /if \(!IS_WEB\) return undefined;/, 'App installs cross-tab coordination on web only');
    assert.equal(typeof globalThis.window, 'undefined');
    assert.equal(crossTab.browserCrossTabEnv(), null, 'no browser environment outside a browser');
    let installed = 0;
    const off = crossTab.installCrossTabAuth({ api: { setRefreshCoordination: () => { installed += 1; } }, env: null, sessionKey: SESSION_KEY, onSignedOutElsewhere: () => undefined });
    off();
    assert.equal(installed, 0, 'a null environment installs nothing');
  });

  await test('MT-13 tokens never reach a URL or a log', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'crossTabAuth.ts'), 'utf8');
    assert.doesNotMatch(src, /console\./, 'crossTabAuth logs nothing');
    assert.doesNotMatch(src, /location|history|\?refresh|\?access/i, 'crossTabAuth builds no URL');
    const { browser, backend } = signedInBrowser();
    const a = openTab(browser, backend);
    const b = openTab(browser, backend);
    await Promise.all([a.api.listCompanies(), b.api.listCompanies()]);
    for (const call of [...a.calls, ...b.calls]) assert.doesNotMatch(call.url, /[ar]\d/, `no token in ${call.url}`);
  });

  console.log(JSON.stringify({ event: 'multitab_refresh_tests_passed', tests: passed }));
})().catch((err) => {
  console.error('FAIL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
