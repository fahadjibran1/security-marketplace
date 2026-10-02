#!/usr/bin/env node
/**
 * UAT FIX 03 — the control room's incident workflow, certified on the rendered surface.
 *
 * TWO PRODUCTION DEFECTS ARE FENCED IN HERE, both on Incident #4 in the live control room:
 *
 *   1. "Acknowledge" on an incident failed with "No safety alert is linked to this urgent item".
 *      The button rendered because `canAcknowledge` accepted `item.incidentId`, but it was wired
 *      unconditionally to the SAFETY ALERT handler, whose first statement rejects anything without
 *      an `alertId`. An incident never has one.
 *
 *   2. "View & Resolve" navigated to Management → Incidents and stopped. The branch ran
 *      `setActiveSection('incidents')` and nothing else, so the one button that promised to resolve
 *      an incident could not resolve anything.
 *
 * An incident is not a safety alert. Most of what follows therefore presses real buttons on the real
 * component and watches WHICH callback fires — the only kind of assertion that could have caught
 * either defect, since both were correctly-rendered buttons wired to the wrong handler.
 */
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};
// Without a `document`, IS_WEB is false and the components render their phone layout instead.
if (typeof globalThis.document === 'undefined') globalThis.document = {};

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadTs, ROOT } = require('./load-ts.cjs');

const lifecycle = loadTs('src/components/company/incidentLifecycle.ts');
const { LiveOpsAttentionRail } = loadTs('src/components/company/CompanyLiveOperationsWorkspace.tsx');
const { CompanyIncidentDetailDrawer } = loadTs('src/components/company/CompanyIncidentDetailDrawer.tsx');

/** Source with comments stripped, so an assertion is about code and never about my own prose. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const codeOf = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const screenCode = codeOf('src/screens/CompanyDashboardScreen.tsx');
const workspaceCode = codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx');

const LONDON = 'Europe/London';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log('PASS ', name);
  } catch (error) {
    console.error('FAIL ', name);
    console.error(error.message);
    process.exitCode = 1;
  }
};

// ─── a renderer that keeps the handlers ───────────────────────────────────────

/**
 * A plain function component, which may simply be called.
 *
 * react-native-web ships class components too (KeyboardAvoidingView among them), and calling one
 * without `new` throws — so those are collected like any other host element instead.
 */
const isPlainFunctionComponent = (type) =>
  typeof type === 'function' && !(type.prototype && type.prototype.isReactComponent);

/**
 * Walk a React element tree, invoking the plain function components inside it.
 *
 * `renderToStaticMarkup` throws the handlers away, and these defects were EXACTLY about which
 * handler a button is wired to — so the tree is walked directly instead. `LiveOpsAttentionRail` and
 * `AttentionItem` are hookless function components, which is what makes this safe; react-native-web's
 * own View/Text/Pressable are forwardRef objects, not functions, so they are collected rather than
 * called.
 */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, out));
    return out;
  }
  if (typeof node !== 'object' || !node.type) return out;
  if (isPlainFunctionComponent(node.type)) return collect(node.type(node.props), out);
  out.push(node);
  if (node.props && node.props.children !== undefined) collect(node.props.children, out);
  return out;
}

/** Every pressable button in the tree, as { label, press }. */
function buttonsOf(element) {
  return collect(element)
    .filter((node) => node.props
      && node.props.accessibilityRole === 'button'
      && typeof node.props.onPress === 'function')
    .map((node) => ({
      label: node.props.accessibilityLabel,
      disabled: Boolean(node.props.disabled),
      press: node.props.onPress,
    }));
}

/** All rendered text in the tree, flattened. */
function textOf(element) {
  const words = [];
  const walk = (node) => {
    if (typeof node === 'string' || typeof node === 'number') { words.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object' || !node.type) return;
    if (isPlainFunctionComponent(node.type)) { walk(node.type(node.props)); return; }
    if (node.props && node.props.children !== undefined) walk(node.props.children);
  };
  walk(element);
  return words.join(' | ');
}

const incidentItem = (over = {}) => ({
  id: `incident-4`,
  incidentId: 4,
  shiftId: 77,
  status: 'open',
  siteName: 'Northgate Retail Park',
  guardName: 'A. Guard',
  category: 'incident',
  issueType: 'Incident unresolved',
  message: 'Broken window to the rear fire exit',
  occurredAt: '2026-10-01T21:10:00.000Z',
  ...over,
});

const alertItem = (over = {}) => ({
  id: 'welfare-9',
  alertId: 9,
  shiftId: 77,
  status: 'open',
  siteName: 'Northgate Retail Park',
  guardName: 'A. Guard',
  category: 'missed_check_call',
  issueType: 'Welfare Check missed',
  message: 'No response to the 21:00 Welfare Check',
  occurredAt: '2026-10-01T21:05:00.000Z',
  ...over,
});

/** The rail, with a spy on every callback a button could possibly reach. */
function renderRail(items) {
  const calls = [];
  const spy = (name) => (...args) => { calls.push({ name, args }); return Promise.resolve(); };
  const element = React.createElement(LiveOpsAttentionRail, {
    items,
    metricFocus: 'all',
    urgentActionItemId: null,
    resolveShiftZone: () => LONDON,
    onOpenUrgentDetail: spy('onOpenUrgentDetail'),
    onOpenUrgentShift: spy('onOpenUrgentShift'),
    onUrgentIncidentFollowUp: spy('onUrgentIncidentFollowUp'),
    onUrgentAlertFollowUp: spy('onUrgentAlertFollowUp'),
    onOpenIncidentResolution: spy('onOpenIncidentResolution'),
    nextUp: [],
  });
  return { element, calls, buttons: buttonsOf(element), text: textOf(element) };
}

// ─── INC-01 … INC-04: the lifecycle, stated once and owned in one place ───────

test('INC-01-AN-INCIDENT-IS-NEVER-ACKNOWLEDGED', () => {
  assert.equal(lifecycle.incidentLifecycle('open'), 'open');
  assert.equal(lifecycle.incidentLifecycle('in_review'), 'in_review');
  assert.equal(lifecycle.incidentLifecycle('IN_REVIEW'), 'in_review', 'case is not a different state');
  assert.equal(lifecycle.incidentLifecycle('resolved'), 'resolved');
  assert.equal(lifecycle.incidentLifecycle('closed'), 'closed');
  // The safety-alert vocabulary is not an incident state and must not be silently accepted as one.
  assert.equal(lifecycle.incidentLifecycle('acknowledged'), 'unknown');
  for (const status of ['open', 'in_review', 'resolved', 'closed', 'acknowledged', '', null]) {
    assert.notEqual(
      lifecycle.incidentLifecycleLabel(status), 'Acknowledged',
      `"${status}" must never read as Acknowledged on an incident`,
    );
  }
  assert.equal(lifecycle.incidentLifecycleLabel('in_review'), 'In Review');
});

test('INC-02-OPEN-OFFERS-MARK-IN-REVIEW-AND-VIEW-AND-RESOLVE', () => {
  const actions = lifecycle.incidentAttentionActions('open');
  assert.equal(actions.canMarkInReview, true);
  assert.equal(actions.resolveLabel, 'View & Resolve');
  assert.equal(actions.stateLabel, null, 'an open item does not need its state spelled out');
});

test('INC-03-IN-REVIEW-SHOWS-ITS-STATE-AND-OFFERS-RESOLVE-ONLY', () => {
  const actions = lifecycle.incidentAttentionActions('in_review');
  assert.equal(actions.canMarkInReview, false, 'it is already in review; a second write is pointless');
  assert.equal(actions.resolveLabel, 'Resolve');
  assert.equal(actions.stateLabel, 'In Review');
});

test('INC-04-A-SETTLED-INCIDENT-OFFERS-NOTHING-TO-DO', () => {
  for (const status of ['resolved', 'closed']) {
    const actions = lifecycle.incidentAttentionActions(status);
    assert.equal(actions.canMarkInReview, false, `${status} cannot be marked in review`);
    assert.equal(actions.resolveLabel, null, `${status} has nothing left to resolve`);
  }
  assert.equal(lifecycle.incidentIsSettled('resolved'), true);
  assert.equal(lifecycle.incidentIsSettled('closed'), true);
  assert.equal(lifecycle.incidentIsSettled('open'), false);
  assert.equal(lifecycle.incidentIsSettled('in_review'), false);
});

// ─── INC-05 … INC-09: the rendered queue, pressed ─────────────────────────────

test('INC-05-AN-OPEN-INCIDENT-RENDERS-MARK-IN-REVIEW-AND-NO-ACKNOWLEDGE', () => {
  const { buttons } = renderRail([incidentItem()]);
  const labels = buttons.map((button) => button.label);
  assert.deepEqual(
    labels, ['Mark In Review', 'View & Resolve'],
    'exactly the two incident actions, in that order',
  );
  // DEFECT 1, fenced: the generic Acknowledge button could only ever fail on an incident.
  assert.ok(!labels.includes('Acknowledge'), 'an incident is never offered Acknowledge');
});

test('INC-06-MARK-IN-REVIEW-MOVES-THE-INCIDENT-NOT-AN-ALERT', () => {
  const { buttons, calls } = renderRail([incidentItem()]);
  buttons.find((button) => button.label === 'Mark In Review').press();

  assert.equal(calls.length, 1, 'one call, one transition');
  assert.equal(calls[0].name, 'onUrgentIncidentFollowUp', 'the INCIDENT handler');
  assert.equal(calls[0].args[1], 'in_review', 'the transition that actually exists');
  assert.equal(calls[0].args[0].incidentId, 4);
  assert.ok(
    !calls.some((call) => call.name === 'onUrgentAlertFollowUp'),
    'the safety-alert handler is never reached from an incident',
  );
});

test('INC-07-VIEW-AND-RESOLVE-OPENS-RESOLUTION-AND-DOES-NOT-NAVIGATE', () => {
  const { buttons, calls } = renderRail([incidentItem()]);
  buttons.find((button) => button.label === 'View & Resolve').press();

  assert.equal(calls.length, 1);
  // DEFECT 2, fenced: this used to be `onOpenUrgentDetail`, which only changed the active section.
  assert.equal(calls[0].name, 'onOpenIncidentResolution', 'the resolution dialog opens for the incident');
  assert.equal(calls[0].args[0].incidentId, 4);
  assert.ok(
    !calls.some((call) => call.name === 'onOpenUrgentDetail'),
    'View & Resolve no longer navigates to the register',
  );
});

test('INC-08-AN-IN-REVIEW-INCIDENT-RENDERS-RESOLVE-ONLY-AND-SAYS-SO', () => {
  const { buttons, calls, text } = renderRail([incidentItem({ status: 'in_review' })]);
  assert.deepEqual(buttons.map((button) => button.label), ['Resolve']);
  assert.match(text, /In Review/, 'the lifecycle word is shown, not implied by a colour');
  assert.ok(!/Acknowledged/.test(text), 'and it is not called Acknowledged');

  buttons[0].press();
  assert.equal(calls[0].name, 'onOpenIncidentResolution');
});

test('INC-09-THE-SAFETY-ALERT-PATH-IS-UNCHANGED', () => {
  // The Welfare resolution flow passed UAT. Nothing here may have touched it.
  const { buttons, calls } = renderRail([alertItem()]);
  const labels = buttons.map((button) => button.label);
  assert.ok(labels.includes('Acknowledge'), 'a safety alert still offers Acknowledge');

  buttons.find((button) => button.label === 'Acknowledge').press();
  assert.equal(calls[0].name, 'onUrgentAlertFollowUp', 'through the alert handler, as before');
  assert.equal(calls[0].args[1], 'acknowledge');
  assert.ok(
    !calls.some((call) => call.name === 'onOpenIncidentResolution'),
    'and never through the incident path',
  );

  const acknowledged = renderRail([alertItem({ status: 'acknowledged' })]);
  assert.ok(
    !acknowledged.buttons.map((button) => button.label).includes('Acknowledge'),
    'an acknowledged alert is not offered Acknowledge twice',
  );
  assert.match(acknowledged.text, /Acknowledged/, 'and still states that someone has it');
});

// ─── INC-10 … INC-11: what the screen does with the press ─────────────────────

test('INC-10-THE-DIALOG-IS-BUILT-AND-SUBMITTED-AS-AN-INCIDENT', () => {
  const opener = screenCode.slice(
    screenCode.indexOf('const openResolveForIncident'),
    screenCode.indexOf('const handleSubmitResolution'),
  );
  assert.ok(opener.length > 200, 'openResolveForIncident exists');
  assert.match(opener, /kind: 'incident'/, 'the dialog knows it is resolving an incident');
  assert.match(opener, /family: 'incident'/, 'and offers the incident reason set, not a safety set');
  assert.match(opener, /incidents\.find\(/, 'the record comes from the incident list');
  assert.ok(!/alerts\.find\(/.test(opener), 'never from the alert list');

  // The facts §4 requires, each actually supplied.
  for (const field of ['reference:', 'siteName:', 'guardName:', 'shiftLabel:', 'severityLabel:', 'reportText:', 'raisedLabel:', 'statusLabel:']) {
    assert.ok(opener.includes(field), `the dialog is given ${field}`);
  }
  // The guard's report is shown, never used as the place the resolution is written.
  assert.match(opener, /reportText: incident\?\.notes/, 'the original report is displayed verbatim');

  const submit = screenCode.slice(
    screenCode.indexOf('const handleSubmitResolution'),
    screenCode.indexOf('const plannerWeekDays'),
  );
  assert.match(
    submit, /updateIncidentStatus\(resolveTarget\.id, 'resolved', resolution\)/,
    'an incident resolves through the incident endpoint, with its evidence',
  );
});

test('INC-11-VIEWING-AN-INCIDENT-NO-LONGER-STANDS-IN-FOR-RESOLVING-IT', () => {
  const detail = screenCode.slice(
    screenCode.indexOf('const handleOpenUrgentDetail'),
    screenCode.indexOf('const handleLiveBoardPrimaryAction'),
  );
  const incidentBranch = detail.slice(detail.indexOf("item.category === 'incident'"));
  assert.ok(incidentBranch.includes('setIncidentDetailId(item.incidentId)'), 'viewing opens the incident itself');
  assert.ok(incidentBranch.includes("setActiveSection('incidents')"), 'alongside the register');

  // An incident can be read without a shift: the branch must sit above the linked-shift refusal.
  assert.ok(
    detail.indexOf("item.category === 'incident'") < detail.indexOf('if (!item.shiftId)'),
    'an incident is handled before the "no linked shift" refusal',
  );

  // And the queue's resolving action does not come through here any more.
  const primary = workspaceCode.slice(
    workspaceCode.indexOf('function getPrimaryAttentionAction'),
    workspaceCode.indexOf('function AttentionItem'),
  );
  const branch = primary.slice(primary.indexOf("item.category === 'incident'"), primary.indexOf("item.category === 'panic'"));
  assert.match(branch, /onOpenIncidentResolution\(item\)/, 'the resolving action opens the dialog');
  assert.match(branch, /incidentAttentionActions\(item\.status\)/, 'and the label follows the real lifecycle');

  // Terminology: the transition is in_review, so nothing tells the controller it was acknowledged.
  // Asserted against comment-stripped code, so my own prose about the old wording cannot pass for it.
  assert.ok(
    !/acknowledged and moved to in review|'Incident acknowledged'/.test(screenCode),
    'no surface describes an incident as acknowledged',
  );
  assert.match(screenCode, /'Incident marked in review'/, 'the audit line names the real transition');
});

// ─── INC-12: the register, in full and NULL-safe ──────────────────────────────

test('INC-12-THE-REGISTER-OPENS-AN-INCIDENT-AND-SURVIVES-NULL-EVIDENCE', () => {
  // A historical incident: raised before the resolution workflow, so every evidence field is null.
  const historical = {
    id: 4,
    title: 'Broken window to the rear fire exit',
    notes: 'Found the rear fire exit pane cracked at 21:10 during a patrol.',
    severity: 'high',
    category: 'damage',
    status: 'open',
    locationText: null,
    reportedAt: '2026-10-01T21:10:00.000Z',
    reviewedAt: null,
    reviewedByUserId: null,
    closedAt: null,
    closedByUserId: null,
    resolutionReason: null,
    resolutionNote: null,
    createdAt: '2026-10-01T21:10:00.000Z',
    shift: null,
    site: null,
    guard: null,
  };
  const bare = textOf(React.createElement(CompanyIncidentDetailDrawer, {
    incident: historical, timeZone: LONDON, onClose: () => {},
  }));
  assert.match(bare, /#4/, 'the incident is identified by number');
  assert.match(bare, /High/, 'severity reads as a word');
  assert.match(bare, /Open/, 'and so does the lifecycle');
  assert.match(bare, /rear fire exit pane cracked/, 'the original report is shown');
  assert.match(bare, /No resolution has been recorded/, 'and an absent resolution is stated, not faked');
  for (const leak of ['null', 'undefined', 'NaN', 'Invalid Date']) {
    assert.ok(!bare.includes(leak), `a missing fact never renders as "${leak}"`);
  }

  // A resolved one: the evidence the workflow wrote is readable, as display words not stored values.
  const resolved = textOf(React.createElement(CompanyIncidentDetailDrawer, {
    incident: {
      ...historical,
      status: 'resolved',
      reviewedAt: '2026-10-01T21:40:00.000Z',
      reviewedByUserId: 21,
      resolutionReason: 'maintenance_arranged',
      resolutionNote: 'Glazier booked for 08:00; exit boarded and signed off by the client.',
      site: { id: 3, name: 'Northgate Retail Park' },
      guard: { id: 20, fullName: 'A. Guard' },
      shift: { id: 77 },
    },
    timeZone: LONDON,
    onClose: () => {},
  }));
  assert.match(resolved, /Resolved/);
  assert.match(resolved, /Maintenance \/ repair arranged/, 'the reason reads as words, never as the stored value');
  assert.ok(!resolved.includes('maintenance_arranged'), 'and the stored value is not shown');
  assert.match(resolved, /Glazier booked/, 'the resolution note is readable');
  assert.match(resolved, /Reviewed/, 'with the handling evidence beside it');

  // Nothing is rendered at all when there is nothing to show.
  assert.equal(
    CompanyIncidentDetailDrawer({ incident: null, timeZone: LONDON, onClose: () => {} }), null,
  );

  // And the register row is the way in.
  assert.match(screenCode, /accessibilityLabel=\{`Open Incident #\$\{incident\.id\}`\}/, 'each row opens its incident');
  assert.match(screenCode, /onPress=\{\(\) => setIncidentDetailId\(incident\.id\)\}/);
  assert.match(screenCode, /<CompanyIncidentDetailDrawer/, 'and the drawer is mounted');
});

// ─── the mutation: prove the old routing really was the defect ────────────────

test('MUTATION-01-ROUTING-AN-INCIDENT-THROUGH-THE-SAFETY-ALERT-PATH-STILL-FAILS', () => {
  /**
   * The pre-fix wiring, executed.
   *
   * `handleUrgentAlertFollowUp` opens by refusing anything without an `alertId`. That guard is
   * CORRECT and stays — a safety-alert handler has no business acting on a record that is not one.
   * What was wrong was sending an incident to it. This reproduces the production failure to prove
   * the diagnosis, and then proves the current queue cannot reach it.
   */
  const guard = screenCode.slice(screenCode.indexOf('const handleUrgentAlertFollowUp'));
  assert.match(
    guard.slice(0, 400), /if \(!item\.alertId\) \{/,
    'the alert handler still refuses a record that is not a safety alert',
  );
  assert.ok(
    guard.includes('No safety alert is linked to this urgent item.'),
    'with the exact message seen in production',
  );

  // Execute the defective route: an incident, handed to the alert guard.
  const feedback = [];
  const alertFollowUpAsItWas = (item) => {
    if (!item.alertId) {
      feedback.push({ tone: 'error', message: 'No safety alert is linked to this urgent item.' });
      return;
    }
    feedback.push({ tone: 'success', message: 'acknowledged' });
  };
  alertFollowUpAsItWas(incidentItem());
  assert.deepEqual(
    feedback, [{ tone: 'error', message: 'No safety alert is linked to this urgent item.' }],
    'the old wiring fails on every incident, exactly as UAT reported',
  );

  // The mutation that matters: no button on an incident can dispatch to that handler.
  for (const status of ['open', 'in_review']) {
    const { buttons, calls } = renderRail([incidentItem({ status })]);
    assert.ok(buttons.length > 0, `an ${status} incident still offers an action`);
    buttons.forEach((button) => button.press());
    assert.ok(
      !calls.some((call) => call.name === 'onUrgentAlertFollowUp'),
      `no ${status} incident action reaches the safety-alert handler`,
    );
    assert.ok(
      calls.every((call) => ['onUrgentIncidentFollowUp', 'onOpenIncidentResolution'].includes(call.name)),
      `every ${status} incident action uses an incident path, got ${calls.map((c) => c.name).join(', ')}`,
    );
  }

  // Guard the condition itself: it must test for an alert, not merely for "some durable record".
  const flag = workspaceCode.slice(workspaceCode.indexOf('const canAcknowledge'));
  assert.match(flag.slice(0, 120), /const canAcknowledge = !isIncident && Boolean\(item\.alertId\)/);
  assert.ok(
    !/canAcknowledge = Boolean\(item\.alertId\) \|\| Boolean\(item\.incidentId\)/.test(workspaceCode),
    'the condition that produced the defect is gone',
  );
});

/** The rendered markup still has to be real markup, not only a tree I walked. */
test('RENDER-01-THE-QUEUE-STILL-RENDERS-THROUGH-REACT-NATIVE-WEB', () => {
  const { AppRegistry } = require('react-native-web');
  const { element } = renderRail([incidentItem(), incidentItem({ id: 'incident-5', incidentId: 5, status: 'in_review' }), alertItem()]);
  AppRegistry.registerComponent('IncidentSpec', () => () => element);
  const app = AppRegistry.getApplication('IncidentSpec', {});
  const html = renderToStaticMarkup(app.element);

  assert.match(html, /Mark In Review/);
  assert.match(html, /View &amp; Resolve/);
  assert.match(html, /In Review/);
  assert.match(html, /Acknowledge/, 'the safety alert in the same queue is untouched');
  assert.ok(!/No safety alert is linked/.test(html));
});

console.log(`\n${passed} incident workflow checks passed`);
