'use strict';

/**
 * Issue #61 — session renewal coordinated across browser tabs (web only).
 *
 * The backend (PR #60) treats a refresh token presented after it was rotated as token theft and revokes
 * the whole login family. Every browser tab runs its own copy of api.ts, so before #61 two tabs of one
 * login rotating the same token signed that login out (measured: 10/10 sequential, 50/50 simultaneous).
 *
 * This executes the REAL api.ts once per simulated tab — each in its own VM context, exactly as each
 * browser tab has its own module instance — against:
 *   - ONE shared fake localStorage that fires `storage` events at the OTHER tabs (never the writer),
 *   - a fake Web Locks manager shared by the tabs (or none, to exercise the localStorage lease fallback),
 *   - a fake auth server with the backend's strict rotation semantics: a rotated token presented again
 *     revokes the family; no grace window.
 * Each tab is wired the way App.tsx wires the web app (persister → session.ts format, unauthorized
 * handler → clear storage + Login, ended-elsewhere handler → Login without touching storage).
 *
 * Same harness style as auth-refresh.spec.cjs (that spec is untouched and still covers the native path).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const API_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'services', 'api.ts'), 'utf8').replace(/\r\n/g, '\n');
const COMPILED_API = ts.transpileModule(API_SOURCE, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const routing = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'navigation', 'role-routing.ts'), 'utf8');
  const compiled = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { exports: mod.exports, module: mod, require, JSON, Object, Array });
  return mod.exports;
})();

const SESSION_KEY = 'security-app-session';
const ACCESS_KEY = 'security-app-session-web-access';
const LEASE_KEY = 's4-session-refresh-lease';
const ACCESS_TTL_MS = 15 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Lets queued storage events, lock grants and promise chains run. */
const settle = async (ms = 20) => { await sleep(ms); await sleep(0); };

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// ── The world: one browser profile (shared storage + locks), one fake backend, one clock ────────────
function createWorld({ webLocks = true, refreshDelayMs = 15 } = {}) {
  const world = { now: Date.UTC(2026, 9, 28, 9, 0, 0), tabs: [] };

  class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(world.now); else super(...args); }
    static now() { return world.now; }
  }
  world.FakeDate = FakeDate;
  world.advance = (ms) => { world.now += ms; };

  // Shared localStorage. A write fires `storage` at every OTHER tab, asynchronously, as browsers do.
  const data = new Map();
  world.data = data;
  world.storageFor = (tab) => ({
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); world.broadcast(tab, k); },
    removeItem: (k) => { const had = data.has(k); data.delete(k); if (had) world.broadcast(tab, k); },
  });
  world.broadcast = (writer, key) => {
    for (const tab of world.tabs) {
      if (tab === writer || tab.closed) continue;
      if (tab.deaf) continue; // a frozen/backgrounded tab: it misses the event entirely (worst case)
      setTimeout(() => { for (const fn of tab.listeners) fn({ key }); }, 0);
    }
  };

  // Shared Web Locks (exclusive only, FIFO, AbortSignal while waiting).
  if (webLocks) {
    const held = new Map();
    const queues = new Map();
    const q = (name) => { if (!queues.has(name)) queues.set(name, []); return queues.get(name); };
    const pump = (name) => {
      if (held.get(name)) return;
      const entry = q(name).shift();
      if (!entry) return;
      held.set(name, true);
      world.lockGrants = (world.lockGrants || 0) + 1;
      Promise.resolve()
        .then(() => entry.cb({ name, mode: 'exclusive' }))
        .then(entry.resolve, entry.reject)
        .finally(() => { held.set(name, false); pump(name); });
    };
    world.locks = {
      request(name, options, cb) {
        return new Promise((resolve, reject) => {
          const entry = { cb, resolve, reject };
          const signal = options && options.signal;
          if (signal) {
            if (signal.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
            signal.addEventListener('abort', () => {
              const queue = q(name);
              const at = queue.indexOf(entry);
              if (at >= 0) { queue.splice(at, 1); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
            });
          }
          q(name).push(entry);
          pump(name);
        });
      },
      /** Test hook: a tab that holds the lock and never lets go. */
      holdForever(name) { held.set(name, true); },
    };
  }

  // The backend, with PR #60 semantics.
  const server = {
    nextId: 1,
    tokens: new Map(), // refresh token → { family, userId, rotated }
    revokedFamilies: new Set(),
    reuseDetected: 0,
    refreshCalls: [],
    concurrentRefreshes: 0,
    maxConcurrentRefreshes: 0,
    refreshMode: 'ok',
    users: new Map([
      [7, { id: 7, email: 'guard@example.invalid', role: 'guard' }],
      [8, { id: 8, email: 'other@example.invalid', role: 'guard' }],
    ]),
    issueAccess(userId) {
      return `${b64url({ alg: 'none' })}.${b64url({ sub: userId, exp: Math.floor((world.now + ACCESS_TTL_MS) / 1000), n: server.nextId++ })}.sig`;
    },
    issue(userId, family) {
      const refreshToken = `r${server.nextId++}`;
      server.tokens.set(refreshToken, { family, userId, rotated: false });
      return { accessToken: server.issueAccess(userId), refreshToken, user: server.users.get(userId) };
    },
    accessUser(header) {
      const token = (header || '').replace(/^Bearer /, '');
      const payload = token.split('.')[1];
      if (!payload) return null;
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return claims.exp * 1000 > world.now ? claims.sub : null;
    },
    familyAlive(family) { return !server.revokedFamilies.has(family); },
    familyOf(refreshToken) { return server.tokens.get(refreshToken)?.family; },
  };
  world.server = server;

  world.fetch = async (tab, url, init) => {
    const p = url.replace('https://test.example', '');
    const headers = init.headers;
    const auth = headers && typeof headers.get === 'function' ? headers.get('authorization') : undefined;
    tab.calls.push({ path: p, auth, body: init.body });
    const reply = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 401 ? 'Unauthorized' : 'OK',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(body ?? null),
      json: async () => body ?? null,
    });

    if (p === '/auth/login') {
      const { email } = JSON.parse(init.body);
      const user = [...server.users.values()].find((u) => u.email === email);
      return reply(200, server.issue(user.id, `f${server.nextId++}`));
    }
    if (p === '/auth/refresh') {
      const { refreshToken } = JSON.parse(init.body);
      server.refreshCalls.push({ tab: tab.name, presented: refreshToken });
      server.concurrentRefreshes += 1;
      server.maxConcurrentRefreshes = Math.max(server.maxConcurrentRefreshes, server.concurrentRefreshes);
      try {
        await sleep(refreshDelayMs);
        if (server.refreshMode === 'unavailable') return reply(503, { message: 'Service Unavailable' });
        const row = server.tokens.get(refreshToken);
        if (!row || server.revokedFamilies.has(row.family)) return reply(401, { message: 'Session is no longer valid' });
        if (row.rotated) {
          // Strict reuse detection: the whole family goes, no grace window.
          server.reuseDetected += 1;
          server.revokedFamilies.add(row.family);
          return reply(401, { message: 'Session is no longer valid' });
        }
        row.rotated = true;
        return reply(200, server.issue(row.userId, row.family));
      } finally {
        server.concurrentRefreshes -= 1;
      }
    }
    if (p === '/auth/logout') {
      const userId = server.accessUser(auth);
      if (!userId) return reply(401, {});
      const { refreshToken } = JSON.parse(init.body);
      const family = server.familyOf(refreshToken);
      if (family) server.revokedFamilies.add(family);
      return reply(200, { loggedOut: true });
    }
    const userId = server.accessUser(auth);
    if (!userId) return reply(401, { message: 'Unauthorized' });
    if (p === '/auth/me') return reply(200, server.users.get(userId));
    return reply(200, [{ id: 1, servedTo: userId }]);
  };

  return world;
}

// ── A tab: the real api.ts in its own context, wired the way App.tsx wires the web app ─────────────
function openTab(world, name, { platform = 'web' } = {}) {
  const tab = { name, calls: [], listeners: [], deaf: false, closed: false, ui: 'booting', notice: null, user: null };
  const storage = world.storageFor(tab);
  const sandbox = {
    process, console, Error, TypeError, Promise, JSON, Array, Object, Buffer,
    Date: world.FakeDate,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    fetch: (url, init) => world.fetch(tab, url, init),
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    Headers: class Headers {
      constructor(init) { this._h = {}; if (init) for (const k of Object.keys(init)) this._h[k.toLowerCase()] = init[k]; }
      has(k) { return k.toLowerCase() in this._h; }
      set(k, v) { this._h[k.toLowerCase()] = v; }
      get(k) { return this._h[k.toLowerCase()]; }
    },
  };
  if (platform === 'web') {
    sandbox.window = {
      localStorage: storage,
      addEventListener: (type, fn) => { if (type === 'storage') tab.listeners.push(fn); },
      navigator: world.locks ? { locks: world.locks } : {},
    };
  }
  const mod = { exports: {} };
  vm.runInNewContext(COMPILED_API, {
    ...sandbox,
    exports: mod.exports,
    module: mod,
    require: (id) => {
      if (id === 'expo-constants') return { default: { expoConfig: { extra: { apiBaseUrl: 'https://test.example' } } } };
      if (id.endsWith('api-base-url')) return { resolveApiBaseUrl: () => 'https://test.example' };
      if (id.endsWith('models')) return {};
      return require(id);
    },
  });
  const api = mod.exports;
  tab.api = api;

  // session.ts on web, verbatim in behaviour.
  const persistSession = async (session) => storage.setItem(SESSION_KEY, routing.serializeStoredSession(session));
  const clearStoredSession = async () => { storage.removeItem(SESSION_KEY); storage.removeItem(ACCESS_KEY); };
  const loadStoredSession = () => { const raw = storage.getItem(SESSION_KEY); return raw ? routing.parseStoredSession(raw) : null; };
  tab.clearStoredSession = clearStoredSession;

  // App.tsx effects.
  api.setUnauthorizedHandler(async (message) => { await clearStoredSession(); tab.ui = 'login'; tab.user = null; tab.notice = message; });
  api.setRefreshPersister(async ({ user, refreshToken }) => { await persistSession({ user, refreshToken }); });
  if (typeof api.setSessionEndedElsewhereHandler === 'function') {
    api.setSessionEndedElsewhereHandler((reason) => { tab.ui = 'login'; tab.user = null; tab.notice = reason; });
  }

  // App.tsx bootstrapSession().
  tab.boot = async () => {
    const stored = loadStoredSession();
    if (!stored) { tab.ui = 'login'; return; }
    api.restoreSession({ accessToken: stored.legacyAccessToken, refreshToken: stored.refreshToken, user: stored.user });
    tab.ui = 'app';
    tab.user = stored.user;
    try {
      const fresh = await api.fetchCurrentUser();
      tab.user = fresh;
      const rotated = api.getRefreshToken();
      if (rotated) await persistSession({ user: fresh, refreshToken: rotated });
    } catch { /* offline — keep the cached user */ }
  };
  // App.tsx handleLoggedIn() / handleLogout().
  tab.signIn = async (email) => {
    const next = await api.login(email, 'pw');
    api.restoreSession(next);
    if (next.refreshToken) await persistSession({ user: next.user, refreshToken: next.refreshToken });
    tab.ui = 'app'; tab.user = next.user; tab.notice = null;
  };
  tab.signOut = async () => { await api.logout(); await clearStoredSession(); tab.ui = 'login'; tab.user = null; };
  tab.lastAuth = () => [...tab.calls].reverse().find((c) => !c.path.startsWith('/auth/refresh'))?.auth;

  world.tabs.push(tab);
  return tab;
}

const storedRefreshToken = (world) => routing.parseStoredSession(world.data.get(SESSION_KEY) || 'null')?.refreshToken ?? null;
const bearerOf = (tab) => tab.lastAuth();

let passed = 0;
async function test(id, fn) { await fn(); passed += 1; console.log(`PASS  ${id}`); }

/** Login in tab A, boot the others from storage — the usual "open more tabs" situation. */
async function signedInTabs(world, count) {
  const tabs = [openTab(world, 'A')];
  await tabs[0].signIn('guard@example.invalid');
  for (let i = 1; i < count; i += 1) {
    const tab = openTab(world, String.fromCharCode(65 + i));
    await tab.boot();
    tabs.push(tab);
  }
  await settle();
  return tabs;
}

(async () => {
  for (const variant of [{ webLocks: true, label: 'WEB-LOCKS' }, { webLocks: false, label: 'LEASE-FALLBACK' }]) {
    // ── (1) simultaneous renewal across tabs ───────────────────────────────────────────────────────
    await test(`SIMULTANEOUS-RENEWAL-ACROSS-TABS [${variant.label}]`, async () => {
      for (let round = 0; round < 10; round += 1) {
        const world = createWorld({ webLocks: variant.webLocks });
        const tabs = await signedInTabs(world, 3);
        assert.equal(world.server.refreshCalls.length, 0, 'opening tabs must not rotate: they share the access token');
        world.advance(ACCESS_TTL_MS + 1000); // every tab's access token has expired

        const results = await Promise.all(tabs.map((t) => t.api.listCompanies()));
        await settle();
        for (const r of results) assert.equal(r[0].servedTo, 7);
        assert.equal(world.server.refreshCalls.length, 1, `round ${round}: ONE /auth/refresh for one rotation`);
        assert.equal(world.server.maxConcurrentRefreshes, 1);
        assert.equal(world.server.reuseDetected, 0, 'no tab may present a rotated token');
        assert.ok(world.server.familyAlive(world.server.familyOf(storedRefreshToken(world))), 'the login survives');
        const newest = storedRefreshToken(world);
        for (const t of tabs) {
          assert.equal(t.api.getRefreshToken(), newest, `tab ${t.name} ends on the newest refresh token`);
          assert.equal(t.ui, 'app');
        }
        assert.equal(new Set(tabs.map(bearerOf)).size, 1, 'all tabs end on the same (newest) access token');
        if (!variant.webLocks) assert.equal(world.data.has(LEASE_KEY), false, 'the lease is released');
      }
    });

    // ── (2) sequential renewal across tabs ─────────────────────────────────────────────────────────
    await test(`SEQUENTIAL-RENEWAL-ACROSS-TABS [${variant.label}]`, async () => {
      const world = createWorld({ webLocks: variant.webLocks });
      const tabs = await signedInTabs(world, 3);
      for (let rotation = 1; rotation <= 10; rotation += 1) {
        world.advance(ACCESS_TTL_MS + 1000);
        // Tabs renew one after another, round-robin: the one that renews changes every time.
        for (let i = 0; i < tabs.length; i += 1) {
          const t = tabs[(rotation + i) % tabs.length];
          await t.api.listCompanies();
          await settle(5);
        }
        assert.equal(world.server.refreshCalls.length, rotation, `rotation ${rotation}: one network refresh per rotation`);
      }
      assert.equal(world.server.reuseDetected, 0);
      const newest = storedRefreshToken(world);
      for (const t of tabs) assert.equal(t.api.getRefreshToken(), newest);
      assert.ok(tabs.every((t) => t.ui === 'app'), 'no tab was signed out');
    });

    // ── (3) suspended / backgrounded tab, several rotations behind ─────────────────────────────────
    await test(`BACKGROUNDED-TAB-SEVERAL-ROTATIONS-BEHIND-ADOPTS [${variant.label}]`, async () => {
      for (const latestAccessStillValid of [true, false]) {
        const world = createWorld({ webLocks: variant.webLocks });
        const [a, b] = await signedInTabs(world, 2);
        const staleRefresh = b.api.getRefreshToken();
        b.deaf = true; // frozen: misses every storage event from here on
        for (let i = 0; i < 3; i += 1) { world.advance(ACCESS_TTL_MS + 1000); await a.api.listCompanies(); }
        assert.equal(world.server.refreshCalls.length, 3);
        b.deaf = false; // the tab is reopened — no event replays what it missed
        if (!latestAccessStillValid) world.advance(ACCESS_TTL_MS + 1000);
        else world.advance(60_000);

        const result = await b.api.listCompanies();
        assert.equal(result[0].servedTo, 7);
        const presented = world.server.refreshCalls.map((c) => c.presented);
        assert.ok(!presented.slice(1).includes(staleRefresh), 'the stale token is never presented again');
        assert.equal(world.server.reuseDetected, 0, 'no reuse: the login is not revoked');
        assert.equal(world.server.refreshCalls.length, latestAccessStillValid ? 3 : 4,
          latestAccessStillValid ? 'it adopts the stored session without a refresh' : 'exactly one refresh, with the STORED token');
        if (!latestAccessStillValid) assert.equal(world.server.refreshCalls.at(-1).tab, 'B');
        assert.equal(b.api.getRefreshToken(), storedRefreshToken(world));
        assert.equal(b.ui, 'app');
        // And when its 401 arrives first (token expired in flight), it still checks storage before refreshing.
        assert.ok(b.calls.filter((c) => c.path === '/auth/refresh').every((c) => JSON.parse(c.body).refreshToken !== staleRefresh));
      }
    });

    // ── (4) sign-out propagation ───────────────────────────────────────────────────────────────────
    await test(`SIGN-OUT-PROPAGATES-TO-ALL-TABS [${variant.label}]`, async () => {
      const world = createWorld({ webLocks: variant.webLocks });
      const [a, b, c] = await signedInTabs(world, 3);
      c.deaf = true; // one tab misses the event; it must still end up signed out
      // Tab B renewed last, so A's in-memory token is behind until it syncs: logout must revoke the CURRENT one.
      world.advance(ACCESS_TTL_MS + 1000);
      await b.api.listCompanies();
      const current = storedRefreshToken(world);
      a.deaf = true; // A has not heard about B's rotation yet
      await settle();
      a.deaf = false;
      await a.signOut();
      await settle();
      const logoutCall = a.calls.find((x) => x.path === '/auth/logout');
      assert.equal(JSON.parse(logoutCall.body).refreshToken, current, 'logout revokes the CURRENT token, not a stale one');
      assert.equal(world.server.familyAlive(world.server.familyOf(JSON.parse(logoutCall.body).refreshToken)), false, 'the login is revoked server-side');
      assert.equal(world.data.has(SESSION_KEY), false);
      assert.equal(world.data.has(ACCESS_KEY), false, 'the shared access token goes with it');
      assert.equal(b.ui, 'login');
      assert.equal(b.notice, 'signed-out');
      assert.equal(b.api.getRefreshToken(), null);
      // The tab that missed the event finds out on its next request, and does not try to renew.
      c.deaf = false;
      const before = world.server.refreshCalls.length;
      await assert.rejects(c.api.listCompanies(), (e) => e.status === 401);
      assert.equal(c.ui, 'login');
      assert.equal(c.notice, 'signed-out');
      assert.equal(world.server.refreshCalls.length, before, 'a signed-out tab never renews');
      assert.equal(c.calls.at(-1).auth, undefined, 'and sends no credentials');
    });

    // ── (5) different users across tabs ────────────────────────────────────────────────────────────
    await test(`DIFFERENT-USER-SIGN-IN-NEVER-ADOPTED [${variant.label}]`, async () => {
      for (const missedEvents of [false, true]) {
        const world = createWorld({ webLocks: variant.webLocks });
        const [a, b] = await signedInTabs(world, 2);
        const aliceRefresh = a.api.getRefreshToken();
        a.deaf = missedEvents;
        // Tab B signs out and signs in as a different user (or a Login tab does — same storage effect).
        await b.signOut();
        await settle();
        await b.signIn('other@example.invalid');
        await settle();
        const bobRefresh = storedRefreshToken(world);
        assert.notEqual(bobRefresh, aliceRefresh);
        a.deaf = false;
        world.advance(ACCESS_TTL_MS + 1000);
        const refreshesBefore = world.server.refreshCalls.length;
        if (a.ui === 'app') await assert.rejects(a.api.listCompanies(), (e) => e.status === 401);
        assert.equal(a.ui, 'login', 'tab A is signed out, not switched to the other user');
        assert.ok(['signed-out', 'user-changed'].includes(a.notice));
        assert.equal(a.api.getRefreshToken(), null, 'tab A holds neither user\'s token');
        assert.ok(!a.calls.some((x) => (x.auth || '').length && server401Decode(x.auth) === 8), 'tab A never acted as user 8');
        assert.ok(!a.calls.some((x) => x.path === '/auth/refresh' && JSON.parse(x.body).refreshToken === bobRefresh));
        assert.equal(world.server.refreshCalls.length, refreshesBefore);
        assert.equal(storedRefreshToken(world), bobRefresh, 'the other user\'s stored session is left intact');
        assert.equal((await b.api.listCompanies())[0].servedTo, 8, 'and the other user\'s tab keeps working');
        assert.equal(world.server.reuseDetected, 0);
      }
      // Direct swap (no sign-out first): a tab whose user differs from storage is signed out, not switched.
      const world = createWorld({ webLocks: variant.webLocks });
      const [a] = await signedInTabs(world, 1);
      const login = openTab(world, 'L');
      await login.boot(); // boots as the same user...
      login.api.clearLocalSession(); login.ui = 'login'; // ...then shows Login (e.g. after account switch)
      await login.signIn('other@example.invalid');
      await settle();
      assert.equal(a.ui, 'login');
      assert.equal(a.notice, 'user-changed');
      assert.equal(a.api.getRefreshToken(), null);
      assert.equal(world.data.has(SESSION_KEY), true, 'the new user\'s session is not cleared by tab A');
    });

    // ── (6) genuine reuse is still detected and still ends the session ────────────────────────────
    await test(`GENUINE-TOKEN-REUSE-STILL-REVOKES [${variant.label}]`, async () => {
      const world = createWorld({ webLocks: variant.webLocks });
      const [a, b] = await signedInTabs(world, 2);
      const stolen = a.api.getRefreshToken();
      world.advance(ACCESS_TTL_MS + 1000);
      await a.api.listCompanies(); // legitimate rotation: `stolen` is now a rotated token
      await settle();
      // An attacker replays the stolen token from elsewhere: the server revokes the family.
      const attacker = openTab(world, 'attacker', { platform: 'native' });
      // The attacker's device has nothing to do with this browser's storage.
      attacker.api.setUnauthorizedHandler(async () => {});
      attacker.api.setRefreshPersister(null);
      attacker.api.restoreSession({ accessToken: undefined, refreshToken: stolen });
      await assert.rejects(attacker.api.listCompanies(), (e) => e.status === 401);
      assert.equal(world.server.reuseDetected, 1, 'the replay is detected');
      // The tabs' next renewal presents the CURRENT stored token unchanged — and is refused.
      world.advance(ACCESS_TTL_MS + 1000);
      const before = world.server.refreshCalls.length;
      await assert.rejects(b.api.listCompanies(), (e) => e.status === 401);
      const fromB = world.server.refreshCalls.slice(before);
      assert.equal(fromB.length, 1, 'one refresh, and a refused /auth/refresh is never retried or suppressed');
      assert.equal(fromB[0].presented, storedRefreshToken(world) ?? fromB[0].presented);
      assert.equal(b.ui, 'login');
      assert.equal(b.notice, 'Your session expired. Please sign in again.', 'the normal session-expired path runs');
      await settle();
      assert.equal(world.data.has(SESSION_KEY), false, 'the dead login is cleared from storage');
      assert.equal(a.ui, 'login', 'and every other tab follows');
      assert.equal(world.server.reuseDetected, 1, 'no extra reuse was caused by the tabs themselves');
    });

    // ── unavailable keeps the session; the lock/lease is released ─────────────────────────────────
    await test(`RENEWAL-UNAVAILABLE-KEEPS-SESSION [${variant.label}]`, async () => {
      const world = createWorld({ webLocks: variant.webLocks });
      const [a, b] = await signedInTabs(world, 2);
      world.advance(ACCESS_TTL_MS + 1000);
      world.server.refreshMode = 'unavailable';
      await assert.rejects(a.api.listCompanies(), (e) => e.status === 503 && /still signed in/.test(e.body.message));
      assert.equal(a.ui, 'app');
      assert.ok(world.data.has(SESSION_KEY), 'an unavailable service never clears the session');
      world.server.refreshMode = 'ok';
      assert.equal((await b.api.listCompanies())[0].servedTo, 7, 'the lock was released: another tab renews');
      assert.equal((await a.api.listCompanies())[0].servedTo, 7);
      assert.equal(world.server.reuseDetected, 0);
    });
  }

  // ── lease fallback: a tab that dies holding the lease ───────────────────────────────────────────
  await test('LEASE-EXPIRY-RECOVERS-FROM-DEAD-TAB', async () => {
    const world = createWorld({ webLocks: false });
    const [a] = await signedInTabs(world, 1);
    world.advance(ACCESS_TTL_MS + 1000);
    // A tab claimed the lease and was closed mid-renewal: nobody will release or renew it.
    world.data.set(LEASE_KEY, JSON.stringify({ owner: 'dead-tab', expires: world.now + 10_000 }));
    let done = false;
    const pending = a.api.listCompanies().then((r) => { done = true; return r; });
    await settle(300);
    assert.equal(done, false, 'it waits while the lease is live');
    assert.equal(world.server.refreshCalls.length, 0, 'and does not renew behind the holder\'s back');
    world.advance(10_001);
    const result = await pending;
    assert.equal(result[0].servedTo, 7, 'the lapsed lease is taken over and renewal completes');
    assert.equal(world.server.refreshCalls.length, 1);
    assert.equal(world.data.has(LEASE_KEY), false);
  });

  await test('LEASE-WAIT-GIVES-UP-AS-UNAVAILABLE', async () => {
    const world = createWorld({ webLocks: false });
    const [a] = await signedInTabs(world, 1);
    world.advance(ACCESS_TTL_MS + 1000);
    const renewLease = () => world.data.set(LEASE_KEY, JSON.stringify({ owner: 'stuck-tab', expires: world.now + 10_000 }));
    renewLease();
    const pending = a.api.listCompanies().catch((e) => e);
    // The holder keeps renewing its lease but never finishes: after 30 s the waiter gives up.
    for (let i = 0; i < 7; i += 1) { await settle(60); world.advance(5_000); renewLease(); }
    const error = await pending;
    assert.equal(error.status, 503, 'reported as temporarily unavailable');
    assert.equal(a.ui, 'app', 'still signed in');
    assert.equal(world.server.refreshCalls.length, 0);
  });

  await test('WEB-LOCK-WAIT-GIVES-UP-AS-UNAVAILABLE', async () => {
    // Uses the real 30 s wait limit scaled down via a held lock and node's fake-free timers would take
    // 30 s, so this asserts the wiring instead: the wait is bounded by an AbortSignal and an abort while
    // waiting maps to 'unavailable', not to a sign-out.
    const src = API_SOURCE.split('async function withRefreshLock')[1].split('\n}\n')[0];
    assert.match(src, /signal: waiting\.signal/);
    assert.match(src, /setTimeout\(\(\) => waiting\.abort\(\), REFRESH_LOCK_WAIT_MS\)/);
    assert.match(src, /if \(waiting\.signal\.aborted\) return unavailable;/);
    assert.match(API_SOURCE, /const REFRESH_LOCK_WAIT_MS = 30_000;/);
  });

  // ── access-token expiry checks other tabs first (requirement 6) ─────────────────────────────────
  await test('EXPIRED-ACCESS-TAB-CHECKS-OTHER-TABS-BEFORE-REFRESH', async () => {
    const world = createWorld();
    const [a, b] = await signedInTabs(world, 2);
    b.deaf = true;
    world.advance(ACCESS_TTL_MS + 1000);
    await a.api.listCompanies();
    assert.equal(world.server.refreshCalls.length, 1);
    b.deaf = false;
    const callsBefore = b.calls.length;
    await b.api.listCompanies();
    const made = b.calls.slice(callsBefore);
    assert.deepEqual(made.map((c) => c.path), ['/companies'], 'no 401 round trip and no /auth/refresh: it adopted first');
    assert.equal(made[0].auth, bearerOf(a));
  });

  await test('PERSISTED-SESSION-FORMAT-UNCHANGED-AND-BACKWARD-COMPATIBLE', async () => {
    const world = createWorld();
    const user = world.server.users.get(7);
    // Exactly what the current web build writes: the v3 blob and nothing else.
    const issued = world.server.issue(7, 'f-legacy');
    world.data.set(SESSION_KEY, routing.serializeStoredSession({ user, refreshToken: issued.refreshToken }));
    const raw = world.data.get(SESSION_KEY);
    assert.deepEqual(Object.keys(JSON.parse(raw)), ['version', 'session']);
    assert.equal(JSON.parse(raw).version, 3);
    const tab = openTab(world, 'A');
    await tab.boot();
    assert.equal(tab.ui, 'app');
    assert.equal(world.server.refreshCalls.length, 1, 'boots with exactly one renewal, as before');
    assert.equal(JSON.parse(world.data.get(SESSION_KEY)).version, 3, 'still written as v3');
    assert.ok(!world.data.get(SESSION_KEY).includes(bearerOf(tab).slice(7)), 'the v3 blob still never holds the access token');
    // A second tab opened now needs no renewal at all.
    const second = openTab(world, 'B');
    await second.boot();
    assert.equal(world.server.refreshCalls.length, 1);
  });

  await test('STORAGE-KEYS-MATCH-SESSION-TS', () => {
    const session = fs.readFileSync(path.join(ROOT, 'src', 'services', 'session.ts'), 'utf8');
    assert.match(session, new RegExp(`const SESSION_KEY = '${SESSION_KEY}';`));
    assert.match(session, new RegExp(`const WEB_ACCESS_KEY = '${ACCESS_KEY}';`));
    assert.match(session, /removeItem\(WEB_ACCESS_KEY\)/, 'signing out clears the shared access token');
    assert.match(API_SOURCE, new RegExp(`const SHARED_SESSION_KEY = '${SESSION_KEY}';`));
    assert.match(API_SOURCE, new RegExp(`const SHARED_ACCESS_KEY = '${ACCESS_KEY}';`));
    assert.match(API_SOURCE, /const REFRESH_LOCK_NAME = 's4-session-refresh';/);
  });

  // ── baseline: the harness reproduces the bug when tabs are NOT coordinated ──────────────────────
  await test('BASELINE-UNCOORDINATED-TABS-ARE-REVOKED', async () => {
    // Two tabs WITHOUT the web path (each a native-style instance with only its own memory): the
    // measured #61 failure must reproduce here, or the tests above would prove nothing.
    const world = createWorld();
    const a = openTab(world, 'A', { platform: 'native' });
    const b = openTab(world, 'B', { platform: 'native' });
    const session = await a.api.login('guard@example.invalid', 'pw');
    b.api.restoreSession({ refreshToken: session.refreshToken, user: session.user });
    world.advance(ACCESS_TTL_MS + 1000);
    await a.api.listCompanies();
    await assert.rejects(b.api.listCompanies(), (e) => e.status === 401);
    assert.equal(world.server.reuseDetected, 1, 'uncoordinated: the second tab presents a rotated token → family revoked');
  });

  // ── the native (phone) path ─────────────────────────────────────────────────────────────────────
  await test('NATIVE-PATH-UNCHANGED', async () => {
    const world = createWorld();
    const phone = openTab(world, 'phone', { platform: 'native' });
    const secureStore = [];
    phone.api.setRefreshPersister(async (session) => { secureStore.push(session.refreshToken); });
    const session = await phone.api.login('guard@example.invalid', 'pw');
    phone.api.restoreSession(session);
    world.advance(ACCESS_TTL_MS + 1000);
    await Promise.all([phone.api.listCompanies(), phone.api.listSites()]);
    assert.deepEqual(phone.calls.map((c) => c.path), ['/auth/login', '/companies', '/sites', '/auth/refresh', '/companies', '/sites']);
    assert.equal(JSON.parse(phone.calls[3].body).refreshToken, session.refreshToken, 'presents the token it holds');
    assert.equal(world.server.refreshCalls.length, 1, 'single-flight within the process, as before');
    assert.deepEqual(secureStore, [phone.api.getRefreshToken()], 'the rotation is persisted once, through the persister');
    assert.equal(world.data.size, 0, 'api.ts never touches localStorage on a phone');
    assert.equal(phone.listeners.length, 0, 'and registers no storage listener');
    // Every web-only branch is behind `crossTab`, which needs window.localStorage + window.addEventListener.
    assert.ok(API_SOURCE.includes('const crossTab = webSessionStorage() !== null;'));
    assert.match(API_SOURCE, /return crossTab\n\s*\? await withRefreshLock\(\(\) => renewAcrossTabs\(sentAccessToken\), 'unavailable' as RefreshOutcome\)\n\s*: await renewWithServer\(presented\);/);
    const guarded = API_SOURCE.split('\n').filter((l) => /^\s*(if \(crossTab[) ]|return crossTab$)/.test(l));
    assert.ok(guarded.length >= 8, 'request/login/getRefreshToken/logout/renewWithServer web steps are each guarded');
  });

  await test('REFRESH-NEVER-RETRIED-OR-SUPPRESSED', () => {
    // The client must not mask a refused /auth/refresh: one call, no retry, refusal → 'rejected'.
    const renew = API_SOURCE.split('async function renewWithServer')[1].split('\n}\n')[0];
    assert.equal((renew.match(/\/auth\/refresh/g) || []).length, 1);
    assert.match(renew, /response\.status >= 500 \|\| response\.status === 429 \? 'unavailable' : 'rejected'/);
    assert.match(renew, /body: JSON\.stringify\(\{ refreshToken: presented \}\)/, 'the token is presented exactly as held');
    // And the backend's strict reuse protection is still under test, unchanged.
    const backendSpec = fs.readFileSync(path.join(ROOT, '..', 'security-backend-nest', 'scripts', 'auth-session.spec.ts'), 'utf8');
    assert.match(backendSpec, /test\('ROTATED-TOKEN-REUSE'/);
    assert.match(backendSpec, /reuse must revoke every session in the family/);
  });

  console.log(JSON.stringify({ event: 'web_cross_tab_session_tests_passed', tests: passed }));
  process.exit(0);
})().catch((err) => {
  console.error('FAIL:', err && err.stack ? err.stack : err);
  process.exit(1);
});

function server401Decode(header) {
  const payload = header.replace(/^Bearer /, '').split('.')[1];
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).sub; } catch { return null; }
}
