#!/usr/bin/env node
/**
 * Refresh control (Performance P2).
 *
 * The S4 P1 incident (14 Oct 2026) was one open Company dashboard whose 15-second refresh kept starting
 * new cycles while earlier ones were still waiting on a slow backend, until the backend's database pool
 * was exhausted. These tests execute the shipped coordinator and prove the screen routes every reload
 * through it. No network is reachable from here.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

const { createRefreshCoordinator } = loadTs('src/services/refreshCoordinator.ts');
const SCREEN = fs.readFileSync(path.join(ROOT, 'src/screens/CompanyDashboardScreen.tsx'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** A cycle whose completion the test controls, recording what it saw. */
function deferredCycle(log, name) {
  let finish;
  let fail;
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const cycle = (isCurrent) => {
    log.push({ name, event: 'start' });
    return done.then(() => { log.push({ name, event: 'end', current: isCurrent() }); });
  };
  return { cycle, finish: () => finish(), fail: (error) => fail(error) };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('RC-01 an idle workspace starts a requested cycle immediately', async () => {
  const c = createRefreshCoordinator();
  const log = [];
  const a = deferredCycle(log, 'a');
  const p = c.request('request', a.cycle);
  assert.deepEqual(log, [{ name: 'a', event: 'start' }]);
  assert.equal(c.isBusy(), true);
  a.finish();
  await p;
  assert.equal(c.isBusy(), false);
  assert.deepEqual(log[1], { name: 'a', event: 'end', current: true });
});

test('RC-02 timer ticks while a cycle runs are skipped, and leave no backlog behind', async () => {
  const c = createRefreshCoordinator();
  const log = [];
  const a = deferredCycle(log, 'a');
  c.request('timer', a.cycle);
  const extra = [];
  for (let i = 0; i < 20; i += 1) {
    const t = deferredCycle(log, `tick${i}`);
    extra.push(t);
    c.request('timer', t.cycle);
  }
  assert.equal(log.filter((e) => e.event === 'start').length, 1, 'only the first cycle started');
  a.finish();
  await flush();
  await flush();
  assert.equal(c.isBusy(), false, 'nothing queued behind the slow cycle');
  assert.equal(log.filter((e) => e.event === 'start').length, 1);
  assert.equal(c.stats().skippedTicks, 20);
  assert.equal(c.stats().started, 1);
});

test('RC-03 explicit requests while busy coalesce into ONE trailing cycle running the newest loader', async () => {
  const c = createRefreshCoordinator();
  const log = [];
  const a = deferredCycle(log, 'a');
  const b = deferredCycle(log, 'b');
  const d = deferredCycle(log, 'd');
  const pa = c.request('request', a.cycle);
  const pb = c.request('request', b.cycle);
  const pd = c.request('request', d.cycle);
  assert.equal(pb, pd, 'later requests join the pending cycle');
  a.finish();
  await flush();
  assert.deepEqual(log.map((e) => `${e.name}:${e.event}`), ['a:start', 'a:end', 'd:start'], 'b never runs; d (newest) does');
  let resolved = false;
  pb.then(() => { resolved = true; });
  await flush();
  assert.equal(resolved, false, 'callers wait for the cycle that reflects their request');
  d.finish();
  await Promise.all([pa, pb, pd]);
  assert.equal(c.stats().started, 2);
  assert.equal(c.stats().coalesced, 1);
});

test('RC-04 a superseded cycle cannot apply its results; its replacement can', async () => {
  const c = createRefreshCoordinator();
  const log = [];
  const a = deferredCycle(log, 'a');
  const b = deferredCycle(log, 'b');
  c.request('timer', a.cycle);
  const pb = c.request('request', b.cycle);
  a.finish();
  await flush();
  b.finish();
  await pb;
  assert.deepEqual(log.filter((e) => e.event === 'end'), [
    { name: 'a', event: 'end', current: false },
    { name: 'b', event: 'end', current: true },
  ]);
  assert.equal(c.stats().superseded, 1);
});

test('RC-05 never more than one cycle in flight across a storm of 500 mixed triggers', async () => {
  const c = createRefreshCoordinator();
  let inFlight = 0;
  let maxInFlight = 0;
  let cycles = 0;
  const cycle = async () => {
    inFlight += 1;
    cycles += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
    inFlight -= 1;
  };
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const waits = [];
  for (let i = 0; i < 500; i += 1) {
    waits.push(c.request(rnd() < 0.8 ? 'timer' : 'request', cycle));
    if (rnd() < 0.3) await new Promise((resolve) => setTimeout(resolve, rnd() * 2));
  }
  await Promise.all(waits);
  assert.equal(maxInFlight, 1);
  assert.equal(inFlight, 0);
  assert.ok(cycles < 500, `cycles started (${cycles}) must be far fewer than triggers`);
  const s = c.stats();
  assert.equal(s.started, cycles);
  assert.equal(s.started + s.skippedTicks + s.coalesced, 500);
});

test('RC-06 a failing cycle: an explicit caller sees the error, a timer never rejects, the next cycle runs', async () => {
  const c = createRefreshCoordinator();
  const boom = new Error('backend unavailable');
  await assert.rejects(c.request('request', async () => { throw boom; }), /backend unavailable/);
  await c.request('timer', async () => { throw boom; }); // must not reject
  // Synchronous throw inside the cycle is contained too.
  await assert.rejects(c.request('request', () => { throw boom; }), /backend unavailable/);
  assert.equal(c.isBusy(), false);
  let ran = false;
  await c.request('request', async () => { ran = true; });
  assert.equal(ran, true, 'the coordinator is not wedged by a failure');
});

test('RC-07 a trailing cycle runs even when the superseded cycle failed', async () => {
  const c = createRefreshCoordinator();
  const log = [];
  const a = deferredCycle(log, 'a');
  const b = deferredCycle(log, 'b');
  const pa = c.request('request', a.cycle);
  const pb = c.request('request', b.cycle);
  a.fail(new Error('timeout'));
  await assert.rejects(pa, /timeout/);
  await flush();
  assert.ok(log.some((e) => e.name === 'b' && e.event === 'start'));
  b.finish();
  await pb;
});

test('RC-08 dispose (sign-out / leaving the workspace) drops everything in flight and pending', async () => {
  const c = createRefreshCoordinator();
  const log = [];
  const a = deferredCycle(log, 'a');
  const b = deferredCycle(log, 'b');
  c.request('request', a.cycle);
  const pb = c.request('request', b.cycle);
  c.dispose();
  await pb; // resolves, never runs
  a.finish();
  await flush();
  assert.deepEqual(log.find((e) => e.name === 'a' && e.event === 'end'), { name: 'a', event: 'end', current: false });
  assert.equal(log.some((e) => e.name === 'b'), false);
  let ran = false;
  await c.request('request', async () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(c.isDisposed(), true);
});

test('RC-09 manual refresh still works after skipped ticks, and shows post-action state', async () => {
  // A fake backend: an SOS raised while a slow cycle is in flight must reach the screen.
  const backend = { alerts: [] };
  const screen = { alerts: null };
  const c = createRefreshCoordinator();
  let releaseFirst;
  const slowRead = new Promise((resolve) => { releaseFirst = resolve; });
  const cycleFor = (gate) => async (isCurrent) => {
    const snapshot = [...backend.alerts];
    await gate;
    if (isCurrent()) screen.alerts = snapshot;
  };
  c.request('timer', cycleFor(slowRead)); // reads an empty list, slowly
  backend.alerts.push({ id: 1, type: 'panic' });
  c.request('timer', cycleFor(Promise.resolve())); // skipped
  const manual = c.request('request', cycleFor(Promise.resolve())); // operator presses Refresh
  releaseFirst();
  await manual;
  assert.deepEqual(screen.alerts, [{ id: 1, type: 'panic' }], 'the SOS is shown, not the obsolete empty list');
});

test('RC-10 a skipped tick never loses an alert: the next tick after the slow cycle shows it', async () => {
  const backend = { alerts: [] };
  const screen = { alerts: null };
  const c = createRefreshCoordinator();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cycle = (g) => async (isCurrent) => { await g; const snap = [...backend.alerts]; if (isCurrent()) screen.alerts = snap; };
  c.request('timer', cycle(gate));
  backend.alerts.push({ id: 2, type: 'missed_check_call' });
  c.request('timer', cycle(Promise.resolve()));
  release();
  await flush();
  await c.request('timer', cycle(Promise.resolve()));
  assert.deepEqual(screen.alerts, [{ id: 2, type: 'missed_check_call' }]);
});

// ─── the screen is wired to it ───────────────────────────────────────────────

test('RC-11 the Company dashboard routes every reload through the coordinator', () => {
  assert.match(SCREEN, /import \{ createRefreshCoordinator, type RefreshCoordinator, type RefreshTrigger \} from '\.\.\/services\/refreshCoordinator';/);
  assert.match(SCREEN, /refreshCoordinator\(\)\.request\(trigger, \(isCurrent\) => runLoadCycle\(isRefresh, isCurrent\)\)/);
  // The timer is the only 'timer' caller, and it is one.
  const timerCalls = SCREEN.match(/loadData\(true, 'timer'\)/g) || [];
  assert.equal(timerCalls.length, 1);
  const tick = SCREEN.slice(SCREEN.indexOf('const intervalId = setInterval(() => {'), SCREEN.indexOf('}, OPERATIONAL_REFRESH_TICK_MS);'));
  assert.match(tick, /loadData\(true, 'timer'\);/);
  // Nothing calls the cycle directly, bypassing the coordinator.
  assert.equal((SCREEN.match(/runLoadCycle\(/g) || []).length, 1);
});

test('RC-12 an obsolete cycle touches no state: loaders, failures, freshness and spinners are all gated', () => {
  const runner = SCREEN.slice(SCREEN.indexOf('const runSettledLoaders = React.useMemo('), SCREEN.indexOf('// At most one refresh cycle'));
  assert.ok(runner.indexOf('if (!isCurrent()) return failures;') < runner.indexOf('loaders[index].apply(result.value);'));
  const cycle = SCREEN.slice(SCREEN.indexOf('const runLoadCycle = React.useMemo('), SCREEN.indexOf('const loadData = React.useCallback('));
  assert.match(cycle, /\], isCurrent\);\n\s+if \(!isCurrent\(\)\) return;/);
  assert.match(cycle, /isCurrent,\n\s+\);\n\s+if \(!isCurrent\(\)\) return;\n\s+const failures = /);
  assert.match(cycle, /finally \{[\s\S]*?if \(isCurrent\(\)\) \{\s*setLoading\(false\);\s*setRefreshing\(false\);/);
  assert.ok(cycle.indexOf('if (!isCurrent()) return;\n        const failures') < cycle.indexOf('setFailedSources('));
});

test('RC-13 the coordinator is disposed when the workspace unmounts', () => {
  assert.match(SCREEN, /React\.useEffect\(\(\) => \(\) => refreshCoordinatorRef\.current\?\.dispose\(\), \[\]\);/);
  assert.match(SCREEN, /refreshCoordinatorRef\.current\.isDisposed\(\)\) \{\s*refreshCoordinatorRef\.current = createRefreshCoordinator\(\);/);
});

test('RC-14 refresh cadence is unchanged by P2', () => {
  assert.match(SCREEN, /const OPERATIONAL_REFRESH_TICK_MS = 15000;/);
  assert.match(SCREEN, /'live-operations': 1,\n\s+'shift-offers': 2,\n\s+coverage: 2,\n\s+'rota-planner': 4,\n\s+dashboard: 4,/);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log('PASS ', name);
    } catch (error) {
      console.error('FAIL ', name);
      console.error('      ' + (error && error.stack || error));
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} refresh-coordinator tests passed`);
})();
