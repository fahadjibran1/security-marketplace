#!/usr/bin/env node
/**
 * Welfare Check push notifications on the phone. Executes the real pure modules and checks the wiring in source.
 *
 *   WPUSH-01  only a well-formed S4 Welfare Check notification is acted on; its ids are hints, coerced and checked
 *   WPUSH-02  I'm Safe with a live session submits at once; signed out it waits for an on-screen tap; Need Help always
 *             has one review step; tapping the body opens the confirmation screen
 *   WPUSH-03  every answer is worded truthfully: recorded / already recorded; nothing recorded on any failure; an
 *             expired reminder offers the current check; Need Help never claims the emergency services were called
 *   WPUSH-04  the buttons need an unlocked phone and open S4; the notification module is the only one using
 *             expo-notifications and logs nothing
 *   WPUSH-05  App: registration only for Guards, the phone is unregistered before sign-out, a tap held across a sign-in
 *             is never auto-submitted, the prompt is shown only on the Guard surface
 *   WPUSH-06  Live Operations words reminders as the push provider's answer, never delivery, reading or safety
 *   WPUSH-07  the API sends only the shift and reminder ids, to the Guard-only endpoints
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const wp = loadTs('src/components/guard/welfarePush.ts');
const wm = loadTs('src/components/company/welfareMonitoring.ts');

const data = { kind: 'welfare_check', reminderId: 41, shiftId: 12, windowIndex: 3, windowEnd: '2026-10-23T22:00:00.000Z' };

test('WPUSH-01-ONLY-WELL-FORMED-WELFARE-NOTIFICATIONS', () => {
  assert.deepEqual(wp.parseWelfareResponse({ actionIdentifier: 'im_safe', data, requestId: 'n1' }), { kind: 'safe', shiftId: 12, reminderId: 41, key: 'n1:im_safe' });
  assert.equal(wp.parseWelfareResponse({ actionIdentifier: 'need_help', data, requestId: 'n1' }).kind, 'help');
  assert.equal(wp.parseWelfareResponse({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', data, requestId: 'n1' }).kind, 'open');
  assert.notEqual(wp.parseWelfareResponse({ actionIdentifier: 'im_safe', data, requestId: 'n1' }).key,
    wp.parseWelfareResponse({ actionIdentifier: 'need_help', data, requestId: 'n1' }).key, 'each action on a notification is its own tap');
  assert.equal(wp.parseWelfareResponse({ actionIdentifier: 'im_safe', data: { ...data, shiftId: '12', reminderId: '41' } }).shiftId, 12, 'numeric strings are accepted');
  for (const bad of [null, {}, { ...data, kind: 'offer' }, { ...data, shiftId: 0 }, { ...data, shiftId: -3 }, { ...data, shiftId: '12abc' }, { ...data, shiftId: 1.5 }]) {
    assert.equal(wp.parseWelfareResponse({ actionIdentifier: 'im_safe', data: bad }), null, JSON.stringify(bad));
  }
  assert.equal(wp.parseWelfareResponse({ actionIdentifier: 'im_safe', data: { ...data, reminderId: 'x' } }).reminderId, null, 'a bad reminder id is dropped, not trusted');
});

test('WPUSH-02-WHERE-A-TAP-LANDS', () => {
  const safe = wp.parseWelfareResponse({ actionIdentifier: 'im_safe', data });
  const help = wp.parseWelfareResponse({ actionIdentifier: 'need_help', data });
  const open = wp.parseWelfareResponse({ actionIdentifier: '', data });
  assert.deepEqual(wp.firstStep(safe, true), { step: 'submitting', what: 'safe' });
  const signedOut = wp.firstStep(safe, false);
  assert.equal(signedOut.step, 'confirm_safe', 'no silent confirmation after the session ended');
  assert.match(signedOut.notice, /Nothing has been recorded yet/);
  assert.deepEqual(wp.firstStep(help, true), { step: 'confirm_help' }, 'Need Help is reviewed once before it is raised');
  assert.deepEqual(wp.firstStep(help, false), { step: 'confirm_help' });
  assert.deepEqual(wp.firstStep(open, true), { step: 'confirm_safe', notice: null });
});

test('WPUSH-03-ANSWERS-ARE-WORDED-TRUTHFULLY', () => {
  const recorded = wp.safeOutcome({ result: 'recorded', shiftId: 12, windowIndex: 3, windowStart: 'x', windowEnd: 'y', recordedAt: '2026-10-23T21:05:00.000Z' });
  assert.equal(recorded.title, 'Welfare Check recorded');
  assert.equal(recorded.tone, 'success');
  assert.equal(wp.safeOutcome({ result: 'already_recorded', recordedAt: null }).title, 'Already recorded');
  const failures = [
    { name: 'NetworkError' },
    { status: 503, body: { message: 'unavailable' } },
    { status: 401 },
    { status: 400, body: { message: 'Shift must be in progress before a guard can confirm a Welfare Check' } },
    { status: 404, body: { message: 'Welfare Check reminder not found' } },
    { status: 409, body: { code: 'no_check_due', message: 'There is no Welfare Check due on this shift right now.' } },
    { status: 500 },
  ];
  for (const error of failures) {
    const out = wp.safeErrorOutcome(error);
    assert.equal(out.step, 'done');
    assert.match(out.message, /(NOT been recorded|Nothing has been recorded)/, `${JSON.stringify(error)} says nothing was recorded`);
    assert.doesNotMatch(out.title, /^(Welfare Check recorded|Already recorded)$/, 'never a success title');
  }
  assert.equal(wp.safeErrorOutcome({ name: 'NetworkError' }).retry, 'safe', 'a connection failure can be retried');
  assert.equal(wp.safeErrorOutcome({ status: 401 }).title, 'Sign in to confirm');
  const expired = wp.safeErrorOutcome({ status: 409, body: { code: 'reminder_expired', message: 'x' } });
  assert.equal(expired.offerCurrentCheck, true, 'an expired reminder offers the current check');
  assert.match(expired.message, /closed/);
  for (const result of ['raised', 'already_raised']) {
    const out = wp.helpOutcome({ result, alertId: 1, shiftId: 12, raisedAt: 'x' });
    assert.match(out.message, /Control Room/);
    assert.match(out.message, /S4 has not contacted the emergency services/);
    assert.doesNotMatch(out.message, /(have|has) (been )?(called|contacted) (the )?(police|ambulance|emergency)/i);
  }
  for (const error of [{ name: 'NetworkError' }, { status: 401 }, { status: 400, body: { message: 'Shift must be in progress' } }]) {
    const out = wp.helpErrorOutcome(error);
    assert.equal(out.title, 'Help request NOT sent');
    assert.match(out.message, /call 999/);
  }
});

test('WPUSH-04-BUTTONS-NEED-AN-UNLOCKED-PHONE-AND-OPEN-S4', () => {
  const src = codeOf('src/services/pushNotifications.ts');
  const actions = [...src.matchAll(/\{ identifier: (ACTION_[A-Z_]+), buttonTitle: ("I'm Safe"|'Need Help'), options: \{([^}]*)\} \}/g)];
  assert.equal(actions.length, 2, 'I\'m Safe and Need Help');
  for (const [, , , options] of actions) {
    assert.match(options, /opensAppToForeground: true/);
    assert.match(options, /isAuthenticationRequired: true/);
  }
  assert.match(src, /importance: Notifications\.AndroidImportance\.MAX/);
  assert.doesNotMatch(src, /console\.(log|warn|error)/, 'no token or payload is logged');
  // Only this module uses expo-notifications.
  const users = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && /from 'expo-notifications'/.test(fs.readFileSync(full, 'utf8'))) users.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  };
  walk(path.join(ROOT, 'src'));
  if (/from 'expo-notifications'/.test(codeOf('App.tsx'))) users.push('App.tsx');
  assert.deepEqual(users, ['src/services/pushNotifications.ts']);
});

test('WPUSH-05-APP-WIRING', () => {
  const app = codeOf('App.tsx');
  // (#61: logout() reports false on web when another account owns the stored session; it still runs right after.)
  assert.match(app, /async function handleLogout\(\) \{ await unregisterWelfarePush\(\); (?:await logout\(\);|if \(\(await logout\(\)\) === false\) return;)/, 'unregistered while the session still works');
  assert.match(app, /const guardUserId = surface === 'guard' \? session\?\.user\.id \?\? null : null;/, 'only Guards register');
  assert.match(app, /if \(!booting && !session\) setWelfareTap\(\(tap\) => \(tap && tap\.sessionLive \? \{ \.\.\.tap, sessionLive: false \} : tap\)\);/,
    'a tap held while signed out is never submitted automatically after sign-in');
  assert.match(app, /\{surface === 'guard' && welfareTap \? <View key=\{welfareTap\.intent\.key\}/, 'the prompt shows only for a Guard');
  assert.match(app, /pushState === 'denied'/, 'the Guard is told when notifications are off');
  const prompt = codeOf('src/components/guard/WelfareCheckPrompt.tsx');
  assert.match(prompt, /confirmWelfareCheck\(\{ shiftId: intent\.shiftId, \.\.\.\(reminderId \? \{ reminderId \} : \{\}\) \}\)/);
  assert.doesNotMatch(prompt, /createDailyLog|createSafetyAlert/, 'the dedicated endpoints decide; nothing is written another way');
});

test('WPUSH-06-LIVE-OPERATIONS-WORDS-THE-PROVIDER-ANSWER-ONLY', () => {
  const r = (over) => ({ id: 1, windowIndex: 0, kind: 'window_open', status: 'provider_accepted', receiptStatus: null, deviceCount: 1, attempts: 1, sentAt: '2026-10-23T20:00:00.000Z', ...over });
  const tz = 'Europe/London';
  assert.equal(wm.welfareReminderWords([], tz), null);
  assert.equal(wm.welfareReminderWords([r(), r({ id: 2, kind: 'follow_up', sentAt: '2026-10-23T20:50:00.000Z' })], tz),
    'Reminder sent to push service 21:00 · Follow-up sent to push service 21:50');
  assert.equal(wm.welfareReminderWords([r({ status: 'no_device', sentAt: null })], tz), 'Reminder not sent: no phone registered for notifications');
  assert.equal(wm.welfareReminderWords([r({ status: 'failed' })], tz), 'Reminder could not reach push service');
  assert.match(wm.welfareReminderWords([r({ receiptStatus: 'provider_delivery_error' })], tz), /reported a delivery error/);
  const every = ['provider_accepted', 'provider_rejected', 'no_device', 'failed', 'sending']
    .flatMap((status) => [null, 'provider_delivery_ok', 'provider_delivery_error'].map((receiptStatus) => wm.welfareReminderWords([r({ status, receiptStatus })], tz)))
    .join(' | ');
  assert.doesNotMatch(every, /\b(delivered|received|read|seen|opened|safe|confirmed)\b/i, 'never a claim about the phone or the Guard');
  const rows = wm.welfareWindowRows({ welfare: { windows: [{ index: 0, start: '2026-10-23T20:00:00.000Z', end: '2026-10-23T21:00:00.000Z', state: 'due', applicable: true, completedAt: null, completionCount: 0 }] }, welfareReminders: [r()], bookOnAt: '2026-10-23T19:55:00.000Z' },
    { nowMs: Date.parse('2026-10-23T20:10:00.000Z'), timeZone: tz, shiftStatus: 'in_progress' });
  assert.equal(rows[0].reminder, 'Reminder sent to push service 21:00');
  assert.equal(rows[0].checkedAt, null, 'a reminder never fills the check');
  assert.match(codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx'), /\{row\.reminder \? <Text style=\{styles\.welfareReminder\}>\{row\.reminder\}<\/Text> : null\}/);
});

test('WPUSH-07-THE-API-SENDS-IDS-ONLY-TO-GUARD-ENDPOINTS', () => {
  const api = codeOf('src/services/api.ts');
  assert.match(api, /export function confirmWelfareCheck\(payload: \{ shiftId: number; reminderId\?: number \}\) \{\s*return request<WelfareConfirmResult>\('\/welfare-checks\/confirm', \{ method: 'POST', body: JSON\.stringify\(payload\) \}\);/);
  assert.match(api, /export function requestWelfareHelp\(payload: \{ shiftId: number; reminderId\?: number \}\) \{\s*return request<WelfareHelpResult>\('\/welfare-checks\/need-help'/);
  assert.match(api, /export function registerPushDevice\(payload: \{ token: string; platform: 'ios' \| 'android'; appVersion\?: string \}\)/);
  assert.match(api, /'\/push-devices\/unregister'/);
});

console.log(`\n${passed} Welfare push checks passed`);
