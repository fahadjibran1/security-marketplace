#!/usr/bin/env node
/**
 * UAT FIX 02 — the control room's side of the resolution workflow.
 *
 * The backend owns the rules; this certifies that the screen offers exactly what the API will accept,
 * that the stored machine value and the displayed words stay separate, that a Missing Book Off is
 * named and timed rather than lumped into generic safety, and that the Welfare terminology cleanup
 * did not touch a single stored enum.
 */
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};
if (typeof globalThis.document === 'undefined') globalThis.document = {};

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

const R = loadTs('src/components/company/alertResolution.ts');

const LONDON = 'Europe/London';
const screenSource = fs.readFileSync(path.join(ROOT, 'src/screens/CompanyDashboardScreen.tsx'), 'utf8');
const workspaceSource = fs.readFileSync(
  path.join(ROOT, 'src/components/company/CompanyLiveOperationsWorkspace.tsx'), 'utf8',
);
const apiSource = fs.readFileSync(path.join(ROOT, 'src/services/api.ts'), 'utf8');

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

/** The backend's own sets, read from source so the two can be compared rather than assumed equal. */
const backendReasons = fs.readFileSync(
  path.join(ROOT, '../security-backend-nest/src/safety-alert/resolution-reasons.ts'), 'utf8',
);
const backendSet = (constName) => {
  const block = backendReasons.split(`export const ${constName} = [`)[1];
  assert.ok(block, `${constName} must exist in the backend`);
  return [...block.split('] as const')[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

// ═══════════════════ the reason vocabulary ═══════════════════

test('REASON-01-EVERY-FAMILY-MATCHES-THE-BACKEND-EXACTLY', () => {
  // If these drift, the dialog offers a value the API refuses — after the controller has typed the
  // note. Comparing the actual lists is the only way to know they have not.
  const pairs = [
    ['welfare', 'WELFARE_RESOLUTION_REASONS'],
    ['missing_book_off', 'MISSING_BOOK_OFF_RESOLUTION_REASONS'],
    ['site_request', 'SITE_REQUEST_RESOLUTION_REASONS'],
    ['emergency', 'EMERGENCY_RESOLUTION_REASONS'],
    ['general', 'GENERAL_ALERT_RESOLUTION_REASONS'],
    ['incident', 'INCIDENT_RESOLUTION_REASONS'],
  ];
  for (const [family, constName] of pairs) {
    assert.deepEqual(
      R.resolutionOptions(family).map((o) => o.value),
      backendSet(constName),
      `${family} must offer exactly the backend's set, in order`,
    );
  }
});

test('REASON-02-THE-STORED-VALUE-IS-NEVER-THE-DISPLAYED-WORDS', () => {
  // The whole point: this phase rewrote "Check Call" to "Welfare Check" on every surface without
  // touching one stored resolution.
  for (const family of ['welfare', 'missing_book_off', 'site_request', 'emergency', 'incident']) {
    for (const option of R.resolutionOptions(family)) {
      assert.match(option.value, /^[a-z][a-z_]*$/, `${option.value} is a machine value`);
      assert.notEqual(option.label, option.value, 'and is not what is shown');
      assert.ok(option.label.length > 0, 'which has words of its own');
    }
  }
  assert.equal(R.resolutionLabel('welfare', 'guard_confirmed_safe'), 'Guard confirmed safe');
  assert.equal(R.resolutionLabel('missing_book_off', 'guard_forgot_book_off'), 'Guard forgot to Book Off');
});

test('REASON-03-AN-ALERT-TYPE-MAPS-TO-ITS-OWN-FAMILY', () => {
  assert.equal(R.resolutionFamilyForAlert('missed_checkcall'), 'welfare');
  assert.equal(R.resolutionFamilyForAlert('check_call'), 'welfare', 'the legacy type resolves too');
  assert.equal(R.resolutionFamilyForAlert('missing_book_off'), 'missing_book_off');
  assert.equal(R.resolutionFamilyForAlert('site_request'), 'site_request');
  assert.equal(R.resolutionFamilyForAlert('welfare'), 'site_request', 'the historical Site Request label');
  assert.equal(R.resolutionFamilyForAlert('panic'), 'emergency');
  assert.equal(R.resolutionFamilyForAlert('late_checkin'), 'general');
  assert.equal(R.resolutionFamilyForAlert(null), 'general');
});

test('REASON-04-NO-WRONG-FAMILY-REASON-IS-OFFERED', () => {
  const values = (family) => R.resolutionOptions(family).map((o) => o.value);
  assert.ok(!values('incident').includes('shift_extended'));
  assert.ok(!values('incident').includes('network_signal_issue'));
  assert.ok(!values('missing_book_off').includes('guard_confirmed_safe'));
  assert.ok(!values('welfare').includes('shift_extended'));
  assert.ok(!values('emergency').includes('other'), 'emergency has no catch-all to click through');
});

// ═══════════════════ note policy ═══════════════════

test('NOTE-01-OTHER-ALWAYS-REQUIRES-A-NOTE', () => {
  for (const family of ['welfare', 'missing_book_off', 'site_request', 'general', 'incident']) {
    assert.equal(R.requiresResolutionNote(family, 'other'), true, family);
    const verdict = R.validateResolution(family, { reason: 'other', note: '' });
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /note is required/i);
  }
});

test('NOTE-02-WHITESPACE-IS-NOT-A-NOTE', () => {
  const verdict = R.validateResolution('welfare', {
    reason: 'guard_confirmed_safe', note: '   \n\t ',
  });
  assert.equal(verdict.ok, false, 'a note of spaces is not an explanation');
});

test('NOTE-03-SITE-REQUEST-IS-THE-ONLY-FAMILY-THAT-MAY-CLOSE-WITHOUT-WORDS', () => {
  assert.equal(R.requiresResolutionNote('site_request', 'request_completed'), false);
  assert.equal(R.validateResolution('site_request', { reason: 'request_completed', note: '' }).ok, true);

  for (const [family, reason] of [
    ['welfare', 'guard_confirmed_safe'],
    ['missing_book_off', 'shift_extended'],
    ['emergency', 'guard_confirmed_safe'],
    ['incident', 'false_alarm'],
  ]) {
    assert.equal(R.requiresResolutionNote(family, reason), true, `${family}/${reason}`);
    assert.equal(R.validateResolution(family, { reason, note: '' }).ok, false);
  }
});

test('NOTE-04-A-REASON-MUST-BE-CHOSEN-AND-MUST-BELONG', () => {
  assert.equal(R.validateResolution('welfare', { reason: null, note: 'x' }).ok, false);
  const wrong = R.validateResolution('welfare', { reason: 'shift_extended', note: 'x' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /does not apply/);
});

test('NOTE-05-THE-LENGTH-LIMIT-MATCHES-THE-API', () => {
  const backendLimit = Number(
    backendReasons.match(/RESOLUTION_NOTE_MAX_LENGTH = (\d+)/)[1],
  );
  assert.equal(R.RESOLUTION_NOTE_MAX_LENGTH, backendLimit, 'client and API agree on the limit');
  assert.equal(
    R.validateResolution('welfare', {
      reason: 'guard_confirmed_safe', note: 'x'.repeat(backendLimit + 1),
    }).ok,
    false,
  );
});

// ═══════════════════ missing Book Off ═══════════════════

test('BOOKOFF-01-THE-OVERDUE-DURATION-IS-CORRECT', () => {
  // The production case: scheduled end 30 Sep 21:35, read at 10:55 the next morning.
  const end = '2026-09-30T20:35:00.000Z';   // 21:35 London
  const now = Date.parse('2026-10-01T09:55:00.000Z'); // 10:55 London
  assert.equal(R.overdueDuration(end, now), '13h 20m overdue');

  assert.equal(R.overdueDuration(end, Date.parse('2026-09-30T20:50:00.000Z')), '15m overdue');
  assert.equal(R.overdueDuration(end, Date.parse('2026-09-30T21:35:00.000Z')), '1h 00m overdue');
  assert.equal(R.overdueDuration(end, Date.parse('2026-09-30T20:30:00.000Z')), '', 'not yet due');
  assert.equal(R.overdueDuration(null, now), '');
});

test('BOOKOFF-02-THE-SUMMARY-READS-ON-THE-SITE-CLOCK', () => {
  const end = '2026-09-30T20:35:00.000Z';
  const now = Date.parse('2026-10-01T09:55:00.000Z');

  assert.equal(R.missingBookOffSummary(end, LONDON, now), 'Scheduled end 21:35 · 13h 20m overdue');
  // The same instant at a site in another zone reads on THAT site's clock.
  assert.equal(
    R.missingBookOffSummary(end, 'America/New_York', now),
    'Scheduled end 16:35 · 13h 20m overdue',
  );
});

test('BOOKOFF-03-IT-IS-ITS-OWN-ATTENTION-CATEGORY', () => {
  // It reached the queue before, inside the generic "Safety / welfare needs attention" bucket — a
  // controller could not tell it from a site request without opening it.
  assert.ok(screenSource.includes("category: 'missing_book_off',"), 'built as its own category');
  assert.ok(screenSource.includes("issueType: 'Missing Book Off',"), 'and named');
  assert.ok(
    screenSource.includes('missingBookOffSummary(alert.shift.end, zone, operationalNow.getTime())'),
    'with the overdue duration from the scheduled end on the site clock',
  );
  assert.ok(
    !/\['welfare', 'late_checkin', 'missing_book_off', 'other'\]/.test(screenSource),
    'and no longer swept into the generic safety bucket',
  );
  assert.ok(workspaceSource.includes("case 'missing_book_off': return 'Missing Book Off';"));
});

test('BOOKOFF-04-RESOLVING-TOUCHES-ONLY-THE-ALERT', () => {
  // The client must not be able to write attendance from the resolve path, so the dialog says so and
  // the only call it makes is the alert close.
  const drawer = fs.readFileSync(
    path.join(ROOT, 'src/components/company/CompanyResolveAlertDrawer.tsx'), 'utf8',
  );
  assert.ok(
    /does not change attendance, Welfare evidence or the/.test(drawer),
    'the dialog states what it does not do',
  );
  // And cannot do it: the dialog imports no API client at all — it hands the resolution back to the
  // caller, whose only call is the alert close.
  assert.ok(
    !/from '\.\.\/\.\.\/services\/api'/.test(drawer),
    'the dialog reaches no endpoint of its own',
  );
  assert.ok(
    !/bookOn|bookOff|checkIn|checkOut|AttendanceEvent/.test(drawer),
    'and names no attendance concept',
  );
  assert.ok(
    !/attendance|timesheet/i.test(screenSource.slice(
      screenSource.indexOf('const handleSubmitResolution'),
      screenSource.indexOf('const plannerWeekDays'),
    )),
    'the submit handler touches nothing but the alert and the reload',
  );
});

// ═══════════════════ terminology ═══════════════════

test('TERM-01-CANONICAL-WELFARE-WORDING-ON-THE-SURFACE', () => {
  assert.equal(R.alertTypeLabel('missed_checkcall'), 'Missed Welfare Check');
  assert.equal(R.alertTypeLabel('check_call'), 'Welfare Check');
  assert.equal(R.alertTypeLabel('missing_book_off'), 'Missing Book Off');
  assert.equal(R.alertTypeLabel('panic'), 'Emergency');
  assert.equal(R.alertTypeLabel('site_request'), 'Site Request');
  assert.equal(R.alertTypeLabel('welfare'), 'Site Request', 'the historical label reads correctly');

  for (const [file, source] of [['screen', screenSource], ['workspace', workspaceSource]]) {
    const userFacing = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/'Missed or overdue check call'|'Missed check call'|'Last Check Call'|label: 'Missed Check Calls'/.test(userFacing),
      `${file} has no legacy check-call wording left on screen`,
    );
  }
});

test('TERM-02-NO-STORED-VALUE-WAS-RENAMED', () => {
  // The cleanup is presentation only. These stored labels must survive untouched, or every
  // historical row stops matching.
  for (const stored of ['check_call', 'missed_checkcall', 'missing_book_off', 'panic', 'site_request']) {
    assert.ok(
      screenSource.includes(stored) || workspaceSource.includes(stored),
      `${stored} is still the value the client reads`,
    );
  }
  const entity = fs.readFileSync(
    path.join(ROOT, '../security-backend-nest/src/safety-alert/entities/safety-alert.entity.ts'), 'utf8',
  );
  assert.ok(entity.includes("CHECK_CALL = 'check_call'"), 'the backend enum is unchanged');
  assert.ok(entity.includes("MISSED_CHECKCALL = 'missed_checkcall'"));
});

test('TERM-03-LEGACY-TYPES-STILL-RESOLVE-AND-RENDER', () => {
  // A historical `check_call` row must offer a reason set and a label, not fall through to nothing.
  assert.equal(R.resolutionFamilyForAlert('check_call'), 'welfare');
  assert.ok(R.resolutionOptions(R.resolutionFamilyForAlert('check_call')).length > 0);
  assert.equal(R.alertTypeLabel('check_call'), 'Welfare Check');
  assert.equal(R.alertTypeLabel('unknown_future_type'), 'Safety alert', 'and nothing renders blank');
});

// ═══════════════════ the workflow on screen ═══════════════════

test('FLOW-01-OPEN-OFFERS-ACKNOWLEDGE-AND-RESOLVE', () => {
  assert.ok(
    /canAcknowledge && !acknowledged \? \(/.test(workspaceSource),
    'Acknowledge is offered only while there is something to acknowledge',
  );
  assert.ok(/accessibilityLabel="Acknowledge"/.test(workspaceSource), 'and is a real control');
  /**
   * CORRECTED BY UAT FIX 03, not relaxed.
   *
   * This used to pin `Boolean(item.alertId) || Boolean(item.incidentId)` — which is the defect
   * itself: the button rendered for incidents and was wired to the safety-alert handler, so it
   * failed on every press with "No safety alert is linked to this urgent item". The intent being
   * asserted is unchanged and now stricter: Acknowledge is offered only where there is a SAFETY
   * ALERT to write the acknowledgement onto. An incident has its own transition, certified in
   * `incident-workflow.spec.cjs`.
   */
  assert.ok(
    /const canAcknowledge = !isIncident && Boolean\(item\.alertId\);/.test(workspaceSource),
    'only a safety alert can be acknowledged; a derived item and an incident cannot',
  );
  assert.ok(
    !/canAcknowledge = Boolean\(item\.alertId\) \|\| Boolean\(item\.incidentId\)/.test(workspaceSource),
    'and the condition that offered it on incidents is gone',
  );
});

test('FLOW-02-ACKNOWLEDGED-SAYS-SO-IN-WORDS', () => {
  assert.ok(/>Acknowledged</.test(workspaceSource), 'the word is on the item');
  assert.ok(
    /attentionStateMark[\s\S]{0,200}fontWeight: '800'/.test(workspaceSource),
    'with a glyph beside it, so it is not colour alone',
  );
});

test('FLOW-03-RESOLVE-IS-NEVER-ONE-CLICK', () => {
  assert.ok(
    /openResolveForAlert\(item\);/.test(screenSource),
    'the close action opens the dialog instead of calling the API',
  );
  // Exactly one close call in the whole screen, and it is the dialog's — carrying the evidence.
  const closeCalls = screenSource.match(/closeSafetyAlert\(/g) || [];
  assert.equal(closeCalls.length, 1, 'an alert is closed from exactly one place');
  assert.ok(
    /closeSafetyAlert\(resolveTarget\.id, resolution\)/.test(screenSource),
    'and that place is the dialog submit, which sends the reason and note',
  );

  // The Attention follow-up handler must no longer close anything directly.
  const start = screenSource.indexOf('const handleUrgentAlertFollowUp');
  assert.ok(start > 0, 'the follow-up handler is findable');
  const followUp = screenSource.slice(start, start + 3000);
  assert.ok(!/closeSafetyAlert\(/.test(followUp), 'it opens the dialog instead of closing the alert');
});

test('FLOW-04-THE-EVIDENCE-REACHES-THE-API', () => {
  assert.ok(
    /export function closeSafetyAlert\(\s*id: number,\s*resolution\?: \{ resolutionReason\?: string; resolutionNote\?: string \},\s*\)/.test(apiSource),
    'the alert close carries the resolution',
  );
  assert.ok(
    /body: JSON\.stringify\(resolution \?\? \{\}\)/.test(apiSource),
    'in the body',
  );
  assert.ok(
    /export function updateIncidentStatus\(\s*id: number,\s*status: string,\s*resolution\?:/.test(apiSource),
    'and so does the incident status change',
  );
  assert.ok(
    !/body: JSON\.stringify\(\{ status, notes/.test(apiSource),
    'the client does not use the deprecated notes alias',
  );
});

test('FLOW-05-A-FRESH-DIALOG-PER-ITEM', () => {
  const drawer = fs.readFileSync(
    path.join(ROOT, 'src/components/company/CompanyResolveAlertDrawer.tsx'), 'utf8',
  );
  assert.ok(
    /setReason\(null\);[\s\S]{0,80}setNote\(''\);/.test(drawer),
    'the draft is cleared between items',
  );
  assert.ok(/\[target\?\.kind, target\?\.id\]/.test(drawer), 'whenever the target changes');
});

test('FLOW-06-NO-SECOND-POLLING-LOOP', () => {
  let intervals = 0;
  for (const file of [
    'src/screens/CompanyDashboardScreen.tsx',
    'src/components/company/CompanyLiveOperationsWorkspace.tsx',
    'src/components/company/CompanyResolveAlertDrawer.tsx',
    'src/components/company/alertResolution.ts',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    intervals += (source.match(/setInterval\(/g) || []).length;
    assert.ok(!/new WebSocket|io\(/.test(source), `${file} opens no socket`);
  }
  assert.equal(intervals, 1, 'one operational refresh cycle, as before');
});

test('FLOW-07-NO-DUPLICATE-ATTENTION-ITEM-FOR-ONE-ALERT', () => {
  // Missing Book Off is now built in its own pass; it must not also fall into the generic bucket.
  assert.ok(
    /\['welfare', 'late_checkin', 'other'\]/.test(screenSource),
    'the generic bucket no longer includes missing_book_off',
  );
  assert.ok(
    /const deduped = items\.filter\(/.test(screenSource),
    'and the queue still dedupes by id',
  );
});

console.log(`\n${passed} alert resolution checks passed`);
