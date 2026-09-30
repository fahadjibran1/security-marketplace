#!/usr/bin/env node
/**
 * Guard live-shift actions reach the API. (Phase 3A-iii.)
 *
 * WHAT BUILD 11 EXPOSED
 * A Guard opened Add Log, typed "UAT test log" and pressed Submit once. Render's request log showed
 * POST /attendance/check-in, /attendance/check-out and /auth/refresh from the same device and session,
 * and NO POST /daily-logs. Nothing appeared on screen either. Production daily_logs, incidents and
 * safety_alerts have never held a single row.
 *
 * THE TEST GAP THAT ALLOWED IT
 * Phase 2's suite proved the press reached the ROUTER — it asserted `['submit']` — and then stopped.
 * Nothing executed the step after that, so a dispatch that refused to call the API, for any reason, was
 * invisible to CI. Worse, a refusal was reported only through the screen-level feedback strip, which the
 * open modal and the keyboard cover, so the Guard saw nothing at all.
 *
 * WHAT THIS SUITE EXECUTES
 * The REAL production dispatcher, against a fake API adapter that records calls, and — for the headline
 * proof — driven by an actual press on the REAL Button inside the REAL ModalFrame. Not a reimplementation
 * of the routing: `dispatchGuardAction` is the same function GuardDashboardScreen calls.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = async (id, fn) => { await fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const dispatch = loadTs('src/components/guard/guardActionDispatch.ts');
const forms = loadTs('src/components/guard/guardActionForms.ts');
const { dispatchGuardAction, guardActionBlockedReason, isLiveShift } = dispatch;
const { GUARD_ACTION_FORMS, guardActionForm, resolveActionSubmitState } = forms;

const LIVE_SHIFT = { id: 16, status: 'in_progress' };

/** Records every API call and every side effect, so a test can assert exactly what happened. */
function harness({ fail = null } = {}) {
  const calls = { createDailyLog: [], createIncident: [], createSafetyAlert: [] };
  const fx = { busy: [], cleared: [], closed: 0, reloaded: 0, timeline: [], feedback: [] };

  const record = (name) => async (payload) => {
    calls[name].push(payload);
    if (fail) throw fail;
    return { id: 999 };
  };

  return {
    calls,
    fx,
    api: {
      createDailyLog: record('createDailyLog'),
      createIncident: record('createIncident'),
      createSafetyAlert: record('createSafetyAlert'),
    },
    effects: {
      setBusy: (key, busy) => fx.busy.push([key, busy]),
      clearValue: (key) => fx.cleared.push(key),
      closeForm: () => { fx.closed += 1; },
      reload: async () => { fx.reloaded += 1; },
      timeline: (shiftId, title, detail) => fx.timeline.push([shiftId, title, detail]),
      feedback: (tone, title, message) => fx.feedback.push([tone, title, message]),
    },
    /** Total API calls across every endpoint — the number that was zero on the real device. */
    total: () => calls.createDailyLog.length + calls.createIncident.length + calls.createSafetyAlert.length,
  };
}

async function main() {
  // ═══════════════════ success: press reaches the API, exactly once ═══════════════════

  // Phase 3C locked one canonical record per tap. Each of these asserts the request that IS made, the
  // request that is NOT made, and that the total across every endpoint is exactly one — so a dual write
  // to a legacy type cannot hide behind a passing test.

  await test('DISPATCH-01-WELFARE-CHECK-WRITES-ONE-daily_logs.welfare_check', async () => {
    const h = harness();
    const outcome = await dispatchGuardAction(
      'welfareCheck', { shift: LIVE_SHIFT, value: 'All well at the gate', busy: false }, h.api, h.effects,
    );
    assert.deepEqual(outcome, { kind: 'success' });
    assert.equal(h.calls.createDailyLog.length, 1, 'exactly one request');
    assert.deepEqual(h.calls.createDailyLog[0], {
      shiftId: 16, message: 'All well at the gate', logType: 'welfare_check',
    });
    // The two things Phase 3C forbids for this tap.
    assert.notEqual(h.calls.createDailyLog[0].logType, 'check_call', 'no legacy check_call');
    assert.equal(h.calls.createSafetyAlert.length, 0, 'and no companion safety_alerts.welfare');
    assert.equal(h.total(), 1, 'one tap, one record');
  });

  await test('DISPATCH-02-LOG-BOOK-WRITES-ONE-daily_logs.log_book', async () => {
    const h = harness();
    const outcome = await dispatchGuardAction(
      'logBook', { shift: LIVE_SHIFT, value: 'Perimeter walked, all clear', busy: false }, h.api, h.effects,
    );
    assert.deepEqual(outcome, { kind: 'success' });
    assert.equal(h.calls.createDailyLog.length, 1);
    assert.deepEqual(h.calls.createDailyLog[0], {
      shiftId: 16, message: 'Perimeter walked, all clear', logType: 'log_book',
    });
    // A written Log Book entry is not a voluntary observation: pointing it at `observation` would let a
    // casual note discharge a periodic obligation, which is the distinction the type exists to make.
    assert.notEqual(h.calls.createDailyLog[0].logType, 'observation', 'no generic observation');
    assert.equal(h.total(), 1);
  });

  await test('DISPATCH-03-SITE-REQUEST-WRITES-ONE-site_request-ALERT', async () => {
    const h = harness();
    const outcome = await dispatchGuardAction(
      'siteRequest', { shift: LIVE_SHIFT, value: 'Generator low on fuel', busy: false }, h.api, h.effects,
    );
    assert.deepEqual(outcome, { kind: 'success' });
    assert.equal(h.calls.createSafetyAlert.length, 1);
    assert.deepEqual(h.calls.createSafetyAlert[0], {
      shiftId: 16, type: 'site_request', priority: 'medium', message: 'Generator low on fuel',
    });
    // Medium, not critical: the site needs something, nobody is in danger.
    assert.notEqual(h.calls.createSafetyAlert[0].priority, 'critical');
    assert.equal(h.calls.createDailyLog.length, 0, 'a request is not a log entry');
    assert.equal(h.total(), 1);
  });

  await test('DISPATCH-04-INCIDENT-WRITES-ONE-INCIDENT', async () => {
    const h = harness();
    const outcome = await dispatchGuardAction(
      'incident', { shift: LIVE_SHIFT, value: 'Broken window, north side', busy: false }, h.api, h.effects,
    );
    assert.deepEqual(outcome, { kind: 'success' });
    assert.equal(h.calls.createIncident.length, 1);
    assert.deepEqual(h.calls.createIncident[0], {
      title: 'Guard incident', notes: 'Broken window, north side', severity: 'medium', shiftId: 16,
    });
    assert.equal(h.calls.createDailyLog.length, 0, 'an incident is not a daily log');
    assert.equal(h.total(), 1);
  });

  await test('DISPATCH-05-EMERGENCY-IS-panic-critical-AND-NEVER-SENDS-THE-TYPED-WORD', async () => {
    // Renamed for the Guard; unchanged on the wire, so a company surface and the alert history keep
    // reading it exactly as before.
    const h = harness();
    const outcome = await dispatchGuardAction(
      'emergency', { shift: LIVE_SHIFT, value: 'SOS', busy: false }, h.api, h.effects,
    );
    assert.deepEqual(outcome, { kind: 'success' });
    assert.equal(h.calls.createSafetyAlert.length, 1);
    assert.equal(h.calls.createSafetyAlert[0].type, 'panic');
    assert.equal(h.calls.createSafetyAlert[0].priority, 'critical');
    assert.ok(
      !h.calls.createSafetyAlert[0].message.includes('SOS'),
      'the confirmation word is not the alert body',
    );
    assert.equal(h.total(), 1);
  });

  await test('DISPATCH-05B-EVERY-CANONICAL-ACTION-MAKES-EXACTLY-ONE-REQUEST', async () => {
    // The same guarantee stated once over the whole set, so a sixth action cannot be added later
    // without one.
    const cases = [
      ['welfareCheck', 'note'],
      ['logBook', 'note'],
      ['siteRequest', 'note'],
      ['incident', 'note'],
      ['emergency', 'SOS'],
    ];
    assert.equal(cases.length, GUARD_ACTION_FORMS.length, 'every declared form is covered here');
    for (const [key, value] of cases) {
      const h = harness();
      const outcome = await dispatchGuardAction(key, { shift: LIVE_SHIFT, value, busy: false }, h.api, h.effects);
      assert.deepEqual(outcome, { kind: 'success' }, key);
      assert.equal(h.total(), 1, `${key} must make exactly one request`);
      assert.equal(h.fx.timeline.length, 1, `${key} records one timeline entry`);
    }
  });

  await test('DISPATCH-05C-NO-LEGACY-TYPE-IS-EMITTED-BY-ANY-NEW-ACTION', async () => {
    // Swept across the whole canonical set rather than asserted per action: nothing may write
    // check_call, observation, or a welfare safety alert any more.
    const emittedLogTypes = [];
    const emittedAlertTypes = [];
    for (const [key, value] of [
      ['welfareCheck', 'note'], ['logBook', 'note'], ['siteRequest', 'note'],
      ['incident', 'note'], ['emergency', 'SOS'],
    ]) {
      const h = harness();
      await dispatchGuardAction(key, { shift: LIVE_SHIFT, value, busy: false }, h.api, h.effects);
      h.calls.createDailyLog.forEach((c) => emittedLogTypes.push(c.logType));
      h.calls.createSafetyAlert.forEach((c) => emittedAlertTypes.push(c.type));
    }
    assert.deepEqual(emittedLogTypes.sort(), ['log_book', 'welfare_check']);
    assert.deepEqual(emittedAlertTypes.sort(), ['panic', 'site_request']);
    for (const legacy of ['check_call', 'observation']) {
      assert.ok(!emittedLogTypes.includes(legacy), `no new action writes ${legacy}`);
    }
    assert.ok(!emittedAlertTypes.includes('welfare'), 'no new action writes safety_alerts.welfare');
  });

  // ═══════════════════ preconditions: blocked, and ZERO API calls ═══════════════════

  await test('DISPATCH-06-A-LIVE-SHIFT-PROCEEDS', async () => {
    assert.equal(isLiveShift(LIVE_SHIFT), true);
    assert.equal(guardActionBlockedReason('logBook', { shift: LIVE_SHIFT, value: 'note', busy: false }), null);
  });

  await test('DISPATCH-07-NO-SHIFT-IS-BLOCKED-WITH-ZERO-CALLS', async () => {
    for (const shift of [null, undefined]) {
      const h = harness();
      const outcome = await dispatchGuardAction('logBook', { shift, value: 'note', busy: false }, h.api, h.effects);
      assert.equal(outcome.kind, 'blocked');
      assert.equal(outcome.reason, 'no_active_shift');
      assert.equal(h.total(), 0, 'nothing may be sent without a shift');
      assert.equal(h.fx.closed, 0, 'and the form stays open to say why');
    }
  });

  await test('DISPATCH-08-A-NON-LIVE-SHIFT-IS-BLOCKED-WITH-ZERO-CALLS', async () => {
    // These are the states a shift actually passes through. None of them may submit.
    for (const status of ['ready', 'completed', 'offered', 'unfilled', 'cancelled', 'missed']) {
      const h = harness();
      const outcome = await dispatchGuardAction(
        'logBook', { shift: { id: 16, status }, value: 'note', busy: false }, h.api, h.effects,
      );
      assert.equal(outcome.kind, 'blocked', status);
      assert.equal(outcome.reason, 'no_active_shift', status);
      assert.equal(h.total(), 0, `${status} must not submit`);
      assert.match(outcome.message, /active shift/i, 'and the reason must say so in plain words');
    }
  });

  await test('DISPATCH-09-AN-EMPTY-NOTE-IS-BLOCKED-WITH-ZERO-CALLS', async () => {
    for (const value of ['', '   ', '\n\t']) {
      const h = harness();
      const outcome = await dispatchGuardAction('logBook', { shift: LIVE_SHIFT, value, busy: false }, h.api, h.effects);
      assert.equal(outcome.kind, 'blocked');
      assert.equal(outcome.reason, 'note_required');
      assert.equal(h.total(), 0);
    }
  });

  await test('DISPATCH-10-EMERGENCY-WITHOUT-THE-WORD-IS-BLOCKED-WITH-ZERO-CALLS', async () => {
    for (const value of ['', 'help', 'pani']) {
      const h = harness();
      const outcome = await dispatchGuardAction('emergency', { shift: LIVE_SHIFT, value, busy: false }, h.api, h.effects);
      assert.equal(outcome.kind, 'blocked');
      assert.equal(outcome.reason, 'emergency_confirmation_required');
      assert.equal(h.total(), 0, 'an emergency alert must never fire unconfirmed');
    }
  });

  await test('DISPATCH-11-A-SUBMISSION-IN-FLIGHT-CANNOT-START-A-SECOND', async () => {
    for (const form of GUARD_ACTION_FORMS) {
      const h = harness();
      const value = form.confirmWord ? form.confirmWord : 'note';
      const outcome = await dispatchGuardAction(form.key, { shift: LIVE_SHIFT, value, busy: true }, h.api, h.effects);
      assert.equal(outcome.kind, 'blocked', form.key);
      assert.equal(outcome.reason, 'busy', form.key);
      assert.equal(h.total(), 0, `${form.key} must not double-submit`);
    }
  });

  // ═══════════════════ failure and retry ═══════════════════

  await test('DISPATCH-12-AN-API-FAILURE-IS-REPORTED-AND-THE-FORM-STAYS-USABLE', async () => {
    const h = harness({ fail: new Error('Unable to reach the live API.') });
    const outcome = await dispatchGuardAction(
      'logBook', { shift: LIVE_SHIFT, value: 'UAT test log', busy: false }, h.api, h.effects,
    );
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.reason, 'api_error');
    assert.equal(outcome.message, 'Unable to reach the live API.', 'the safe API message is surfaced');

    assert.equal(h.calls.createDailyLog.length, 1, 'it was attempted exactly once');
    assert.equal(h.fx.closed, 0, 'the form must NOT close on failure');
    assert.deepEqual(h.fx.cleared, [], 'and the typed note must survive for the retry');
    assert.equal(h.fx.reloaded, 0, 'nothing was written, so nothing to reload');
    assert.deepEqual(h.fx.busy, [['logBook', true], ['logBook', false]], 'busy is always released');
    assert.ok(h.fx.feedback.some(([tone]) => tone === 'error'), 'and it is reported');
  });

  await test('DISPATCH-13-A-RETRY-AFTER-FAILURE-SENDS-EXACTLY-ONE-MORE', async () => {
    const h = harness();
    let attempts = 0;
    h.api.createDailyLog = async (payload) => {
      attempts += 1;
      h.calls.createDailyLog.push(payload);
      if (attempts === 1) throw new Error('Network request failed');
      return { id: 1 };
    };

    const first = await dispatchGuardAction(
      'logBook', { shift: LIVE_SHIFT, value: 'UAT test log', busy: false }, h.api, h.effects,
    );
    assert.equal(first.kind, 'failed');
    assert.equal(h.fx.closed, 0);

    const second = await dispatchGuardAction(
      'logBook', { shift: LIVE_SHIFT, value: 'UAT test log', busy: false }, h.api, h.effects,
    );
    assert.deepEqual(second, { kind: 'success' });
    assert.equal(h.calls.createDailyLog.length, 2, 'one per press, never a duplicate');
    assert.equal(h.fx.closed, 1, 'and the form closes once, on the success');
    assert.deepEqual(h.fx.cleared, ['logBook'], 'clearing the note only on success');
    assert.equal(h.fx.reloaded, 1);
  });

  await test('DISPATCH-14-A-NON-ERROR-REJECTION-STILL-PRODUCES-A-SAFE-MESSAGE', async () => {
    const h = harness({ fail: { weird: true } });
    const outcome = await dispatchGuardAction('logBook', { shift: LIVE_SHIFT, value: 'x', busy: false }, h.api, h.effects);
    assert.equal(outcome.kind, 'failed');
    assert.ok(outcome.message.length > 0, 'a message is always produced');
    assert.ok(!outcome.message.includes('weird'), 'and never leaks internals');
    assert.ok(!/\bat \w+ \(/.test(outcome.message), 'no stack frames');
  });

  await test('DISPATCH-15-SUCCESS-CLOSES-RESETS-AND-RELOADS-ONCE', async () => {
    const h = harness();
    await dispatchGuardAction('logBook', { shift: LIVE_SHIFT, value: '  spaced  ', busy: false }, h.api, h.effects);
    assert.equal(h.calls.createDailyLog[0].message, 'spaced', 'the note is trimmed');
    assert.equal(h.fx.closed, 1);
    assert.deepEqual(h.fx.cleared, ['logBook']);
    assert.equal(h.fx.reloaded, 1);
    assert.equal(h.fx.timeline.length, 1, 'and one timeline entry');
    assert.ok(h.fx.feedback.some(([tone]) => tone === 'success'));
  });

  // ═══════════════════ the headline proof: a real press reaches the API ═══════════════════

  function loadTsx(rel) {
    const ts = require('typescript');
    const abs = path.join(ROOT, rel);
    const out = ts.transpileModule(fs.readFileSync(abs, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
    }).outputText;
    const mod = { exports: {} };
    const localRequire = (request) => {
      if (request === 'react-native') return require('react-native-web');
      if (request === 'react-native-safe-area-context') {
        return { useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) };
      }
      if (request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(abs), request);
        for (const c of [resolved, `${resolved}.ts`, `${resolved}.tsx`, path.join(resolved, 'index.ts')]) {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) {
            return c.endsWith('.tsx') ? loadTsx(path.relative(ROOT, c)) : loadTs(path.relative(ROOT, c));
          }
        }
      }
      return require(request);
    };
    new Function('module', 'exports', 'require', out)(mod, mod.exports, localRequire);
    return mod.exports;
  }

  function* walk(node) {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const c of node) yield* walk(c); return; }
    if (!node.props) return;
    yield node;
    yield* walk(node.props.children);
  }

  await test('DISPATCH-16-A-REAL-PRESS-ON-THE-REAL-BUTTON-REACHES-THE-API', async () => {
    // THE GAP BUILD 11 EXPOSED, CLOSED. Phase 2 asserted the press reached the router and stopped there.
    // This drives the real Button inside the real ModalFrame straight through the production dispatcher
    // into a fake API adapter, so "visible button, no HTTP request" cannot recur silently.
    const RNW = require('react-native-web');
    const Modal = loadTsx('src/components/ui/Modal.tsx');
    const ButtonMod = loadTsx('src/components/ui/Button.tsx');

    const form = guardActionForm('logBook');
    const value = 'UAT test log';
    const h = harness();
    const submit = resolveActionSubmitState(form, { value, busy: false });

    // Exactly the production footer, wired to the production dispatcher.
    const pressed = [];
    const footer = React.createElement(
      React.Fragment,
      null,
      React.createElement(ButtonMod.Button, {
        label: 'Cancel', variant: 'secondary', size: 'md', onPress: () => pressed.push('cancel'),
      }),
      React.createElement(ButtonMod.Button, {
        label: submit.label,
        variant: 'primary',
        size: 'md',
        disabled: submit.disabled,
        loading: false,
        onPress: () => pressed.push(
          dispatchGuardAction('logBook', { shift: LIVE_SHIFT, value, busy: false }, h.api, h.effects),
        ),
      }),
    );

    const tree = Modal.ModalFrame({
      visible: true,
      onClose: () => {},
      title: form.title,
      viewport: { height: 640, width: 360 },
      insets: { top: 24, bottom: 48 },
      platform: 'android',
      children: React.createElement(RNW.TextInput, { value, accessibilityLabel: form.title }),
      footer,
    });

    // Find the primary Button, render it, and invoke its Pressable exactly as a tap does.
    const button = [...walk(tree)].find(
      (el) => el.type === ButtonMod.Button && el.props.label === submit.label,
    );
    assert.ok(button, 'the primary button must be in the modal');
    assert.equal(button.props.disabled, false, 'and enabled with a note entered');

    const rendered = ButtonMod.Button(button.props);
    const pressable = [...walk(rendered)].find((el) => el.type === RNW.Pressable);
    assert.ok(pressable, 'the Button must render a Pressable');
    assert.equal(pressable.props.disabled, false);
    assert.equal(typeof pressable.props.onPress, 'function');

    pressable.props.onPress();
    await Promise.all(pressed);

    assert.equal(h.calls.createDailyLog.length, 1, 'ONE press, ONE request — the Build 11 gap');
    assert.deepEqual(h.calls.createDailyLog[0], {
      shiftId: 16, message: 'UAT test log', logType: 'log_book',
    });
  });

  // ═══════════════════ production really uses this dispatcher ═══════════════════

  await test('DISPATCH-17-THE-SCREEN-CALLS-THE-SHARED-DISPATCHER-AND-KEEPS-NO-COPY', async () => {
    const screen = codeOf('src/screens/GuardDashboardScreen.tsx');
    assert.match(screen, /await dispatchGuardAction\(/, 'the screen must call the shared dispatcher');
    assert.match(screen, /from '\.\.\/components\/guard\/guardActionDispatch'/);

    // The old per-action handlers are gone, so there is exactly one dispatch path.
    for (const stale of ['handleCreateLog', 'handleCreateIncident', 'handleCreateWelfareAlert', 'handleCreatePanicAlert']) {
      assert.ok(!screen.includes(stale), `${stale} must no longer exist — it was a second dispatch path`);
    }
    // And the screen must not reimplement the writes.
    const router = /const submitQuickAction[\s\S]*?\n  \};/.exec(screen);
    assert.ok(router, 'the router must exist');
    assert.ok(
      !/createDailyLog\(\{|createIncident\(\{|createSafetyAlert\(\{/.test(router[0]),
      'no API payload may be built in the screen',
    );
  });

  await test('DISPATCH-18-THE-REFUSAL-IS-SHOWN-INSIDE-THE-FORM', async () => {
    // The Build 11 architectural gap: a refusal reported only through the screen-level strip, which the
    // modal and the keyboard cover. It must now render in the form itself.
    const screen = codeOf('src/screens/GuardDashboardScreen.tsx');
    assert.match(screen, /actionOutcome\[form\.key\]/, 'the form reads the dispatcher outcome');
    assert.match(screen, /guardActionBlockedReason\(form\.key/, 'and can pre-empt the reason');
    assert.match(screen, /styles\.actionInlineError/, 'with an inline style inside the modal');
    assert.match(screen, /accessibilityLiveRegion/, 'announced to assistive technology');

    // It must be inside the AppModal children, not only in the screen-level banner.
    const modalBlock = /<AppModal[\s\S]*?<\/AppModal>/.exec(screen);
    assert.ok(modalBlock, 'the action modal must exist');
    assert.ok(
      modalBlock[0].includes('actionInlineError') || modalBlock[0].includes('actionInlineInfo'),
      'the inline message must live within the modal',
    );
  });

  console.log(`\n${passed} guard action dispatch checks passed`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
