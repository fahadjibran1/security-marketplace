#!/usr/bin/env node
/**
 * The Guard notifications inbox and Guard notification pushes. Executes the real pure module and checks the wiring in
 * source.
 *
 *   GINBOX-01  only a well-formed 'guard_notification' push is acted on; its ids are hints, coerced and checked
 *   GINBOX-02  Welfare Check pushes never reach the inbox handling, and inbox pushes never reach the Welfare handling
 *   GINBOX-03  every type, including ones this version has never heard of, shows the server's own title and message
 *   GINBOX-04  the list is the server's rows reduced to what is shown, newest first, with a correct unread count
 *   GINBOX-05  a read shows at once, is put back exactly on failure, and survives a list that arrives mid-flight
 *   GINBOX-06  where a tap leads: offers, the extension request on Home, History, otherwise the inbox
 *   GINBOX-07  times read on the UK clock: relative when recent, then Today / Yesterday / DD-MM-YYYY
 *   GINBOX-08  a server without the inbox is calm (no badge, no retry storm); a connection failure keeps the list
 *   GINBOX-09  start-up creates both Android channels: welfare-checks (MAX, unchanged) and shift-updates (default)
 *   GINBOX-10  the Welfare push handling is untouched; foreground pushes still all show as banners
 *   GINBOX-11  Guard dashboard wiring: a tap is marked read and routed; foreground refresh; no invented endpoint; labelled
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
// Line endings normalised, so the source checks read the same on a Windows checkout and in CI.
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const gi = loadTs('src/components/guard/guardInbox.ts');
const wp = loadTs('src/components/guard/welfarePush.ts');

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';
const data = { kind: 'guard_notification', notificationId: 77, type: 'shift_offered', shiftId: 12 };

test('GINBOX-01-ONLY-WELL-FORMED-GUARD-NOTIFICATIONS', () => {
  assert.deepEqual(gi.parseGuardNotificationResponse({ actionIdentifier: DEFAULT_ACTION, data, requestId: 'n1' }),
    { notificationId: 77, type: 'shift_offered', shiftId: 12, amendmentId: null, key: `n1:${DEFAULT_ACTION}` });
  const ext = gi.parseGuardNotificationResponse({ data: { kind: 'guard_notification', notificationId: '5', type: 'shift_amendment_requested', shiftId: '9', amendmentId: '31' } });
  assert.equal(ext.notificationId, 5, 'numeric strings are accepted');
  assert.equal(ext.shiftId, 9);
  assert.equal(ext.amendmentId, 31);
  assert.equal(ext.key, 'guard-notification-5:', 'a stable key without a request id');
  // Missing / bad optional fields are dropped, not trusted.
  const bare = gi.parseGuardNotificationResponse({ data: { kind: 'guard_notification', notificationId: 8 } });
  assert.deepEqual([bare.type, bare.shiftId, bare.amendmentId], [null, null, null], 'type and ids are optional');
  const junk = gi.parseGuardNotificationResponse({ data: { ...data, shiftId: 'x', amendmentId: -1, type: 'DROP TABLE; --' } });
  assert.deepEqual([junk.shiftId, junk.amendmentId, junk.type], [null, null, null]);
  assert.equal(gi.parseGuardNotificationResponse({ data: { ...data, type: 'shift_some_future_type' } }).type, 'shift_some_future_type', 'an unknown type is kept as given');
  // Not a Guard notification at all.
  for (const bad of [null, undefined, 'x', {}, { ...data, kind: 'offer' }, { ...data, kind: undefined }, { ...data, notificationId: 0 },
    { ...data, notificationId: -3 }, { ...data, notificationId: '7abc' }, { ...data, notificationId: 1.5 }, { ...data, notificationId: undefined }]) {
    assert.equal(gi.parseGuardNotificationResponse({ actionIdentifier: DEFAULT_ACTION, data: bad }), null, JSON.stringify(bad));
  }
  assert.equal(gi.isGuardNotificationData(data), true);
  assert.equal(gi.isGuardNotificationData({ kind: 'welfare_check' }), false);
  assert.equal(gi.isGuardNotificationData(null), false);
});

test('GINBOX-02-WELFARE-AND-INBOX-PUSHES-NEVER-CROSS', () => {
  const welfare = { kind: 'welfare_check', reminderId: 41, shiftId: 12, windowIndex: 3, windowEnd: '2026-10-23T22:00:00.000Z' };
  for (const action of ['im_safe', 'need_help', DEFAULT_ACTION, '']) {
    assert.equal(gi.parseGuardNotificationResponse({ actionIdentifier: action, data: welfare, requestId: 'w1' }), null, `Welfare ${action} ignored by the inbox`);
    assert.equal(wp.parseWelfareResponse({ actionIdentifier: action, data, requestId: 'g1' }), null, `inbox push ${action} ignored by Welfare`);
  }
  assert.equal(wp.parseWelfareResponse({ actionIdentifier: 'im_safe', data: welfare }).kind, 'safe', 'Welfare parsing still works');
  assert.equal(gi.isGuardNotificationData(welfare), false);
});

test('GINBOX-03-UNKNOWN-TYPES-SHOW-SERVER-TEXT', () => {
  assert.deepEqual(gi.notificationText({ type: 'something_new_2027', title: 'Site briefing updated', message: 'Read before your next shift.' }),
    { title: 'Site briefing updated', message: 'Read before your next shift.' });
  assert.deepEqual(gi.notificationText({ type: 'shift_offered', title: 'Custom server title', message: '  Spaces trimmed  ' }),
    { title: 'Custom server title', message: 'Spaces trimmed' }, 'the server title wins over the built-in label');
  assert.equal(gi.notificationText({ type: 'shift_offered', title: '', message: '' }).title, 'New shift offer', 'a label only when the server sent none');
  assert.equal(gi.notificationText({ type: 'never_heard_of', title: '   ', message: 'x' }).title, 'S4 notification');
});

test('GINBOX-04-NEWEST-FIRST-AND-UNREAD-COUNT', () => {
  const rows = [
    { id: 1, type: 'shift_amendment_requested', title: 'Old', message: 'm', status: 'read', createdAt: '2026-10-20T09:00:00.000Z', readAt: '2026-10-20T10:00:00.000Z', user: { id: 3, email: 'guard@example.com' }, company: { id: 2, name: 'Co' } },
    { id: 3, type: 'shift_offered', title: 'Newest', message: 'm', status: 'unread', createdAt: '2026-10-24T09:00:00.000Z', readAt: null },
    { id: 2, type: 'future_type', title: 'Middle', message: 'm', status: 'unread', createdAt: '2026-10-22T09:00:00.000Z' },
    { id: 4, type: 'shift_offered', title: 'Same time, higher id', message: 'm', status: 'unread', createdAt: '2026-10-24T09:00:00.000Z' },
    null, 'junk', { id: 0, title: 'no id' }, { title: 'missing id' },
  ];
  const items = gi.normaliseInbox(rows);
  assert.deepEqual(items.map((i) => i.id), [4, 3, 2, 1], 'newest first, ties by id; malformed rows dropped');
  assert.deepEqual(Object.keys(items[3]).sort(), ['createdAt', 'id', 'message', 'readAt', 'status', 'title', 'type'], 'user and company are not kept');
  assert.equal(gi.unreadCount(items), 3);
  assert.equal(gi.unreadCount([]), 0);
  assert.deepEqual(gi.normaliseInbox(undefined), []);
  assert.deepEqual(gi.normaliseInbox({ message: 'Not Found' }), [], 'an error body is not a list');
  assert.equal(gi.unreadBadge(0), null);
  assert.equal(gi.unreadBadge(3), '3');
  assert.equal(gi.unreadBadge(250), '99+');
});

test('GINBOX-05-OPTIMISTIC-READ-WITH-ROLLBACK', () => {
  const at = '2026-10-25T10:00:00.000Z';
  const items = gi.normaliseInbox([
    { id: 1, type: 'shift_offered', title: 'A', message: 'a', status: 'unread', createdAt: '2026-10-25T09:00:00.000Z', readAt: null },
    { id: 2, type: 'shift_offered', title: 'B', message: 'b', status: 'read', createdAt: '2026-10-25T08:00:00.000Z', readAt: '2026-10-25T08:30:00.000Z' },
  ]);
  let s = gi.inboxReducer(gi.EMPTY_INBOX, { type: 'loaded', items });
  assert.equal(gi.unreadCount(s.items), 1);
  assert.equal(gi.shouldMarkRead(s, 1), true);
  assert.equal(gi.shouldMarkRead(s, 2), false, 'an already-read row sends nothing');
  assert.equal(gi.shouldMarkRead(s, 999), true, 'a push-named id not loaded yet is still marked');

  // Started: shown read at once.
  const started = gi.inboxReducer(s, { type: 'mark_read_started', id: 1, at });
  assert.equal(started.items.find((i) => i.id === 1).status, 'read');
  assert.equal(gi.unreadCount(started.items), 0);
  assert.equal(gi.shouldMarkRead(started, 1), false, 'no second read while one is in flight');
  assert.equal(gi.inboxReducer(started, { type: 'mark_read_started', id: 1, at }), started, 'a double tap is a no-op');

  // Failed: put back exactly.
  const failed = gi.inboxReducer(started, { type: 'mark_read_failed', id: 1 });
  assert.deepEqual(failed.items, s.items, 'rolled back to the row as it was');
  assert.deepEqual(failed.pending, {});
  assert.equal(gi.unreadCount(failed.items), 1);

  // Succeeded: stays read with the server's time.
  const ok = gi.inboxReducer(started, { type: 'mark_read_succeeded', id: 1, readAt: '2026-10-25T10:00:01.000Z' });
  assert.equal(ok.items.find((i) => i.id === 1).readAt, '2026-10-25T10:00:01.000Z');
  assert.deepEqual(ok.pending, {});

  // A list that arrives while the read is in flight (still unread on the server) keeps it read...
  const midFlight = gi.inboxReducer(started, { type: 'loaded', items });
  assert.equal(midFlight.items.find((i) => i.id === 1).status, 'read');
  // ...and a failure afterwards still restores it.
  assert.equal(gi.inboxReducer(midFlight, { type: 'mark_read_failed', id: 1 }).items.find((i) => i.id === 1).status, 'unread');

  // A push-named id that is not in the list yet: pending, then shown read once the list arrives.
  const early = gi.inboxReducer(gi.EMPTY_INBOX, { type: 'mark_read_started', id: 1, at });
  assert.equal(gi.inboxReducer(early, { type: 'loaded', items }).items.find((i) => i.id === 1).status, 'read');
  assert.equal(gi.inboxReducer(gi.EMPTY_INBOX, { type: 'mark_read_failed', id: 5 }), gi.EMPTY_INBOX, 'an unknown failure is ignored');
  assert.deepEqual(gi.inboxReducer(ok, { type: 'reset' }), gi.EMPTY_INBOX);
});

test('GINBOX-06-WHERE-A-TAP-LEADS', () => {
  assert.deepEqual(gi.resolveNotificationTarget('shift_offered', { shiftId: 12 }), { tab: 'offers', shiftId: 12 });
  assert.deepEqual(gi.resolveNotificationTarget('shift_offered'), { tab: 'offers', shiftId: null }, 'an inbox row has no shift id: the Offers list');
  assert.deepEqual(gi.resolveNotificationTarget('shift_reacceptance_required', { shiftId: 4 }), { tab: 'offers', shiftId: 4 });
  assert.deepEqual(gi.resolveNotificationTarget('shift_amendment_requested', { amendmentId: 31 }), { tab: 'home', focus: 'extension', amendmentId: 31 });
  assert.deepEqual(gi.resolveNotificationTarget('timesheet_rejected'), { tab: 'history' });
  assert.deepEqual(gi.resolveNotificationTarget('timesheet_approved'), { tab: 'history' });
  for (const type of ['shift_offer_withdrawn', 'shift_replaced', 'shift_amendment_responded', 'shift_amendment_expired', 'compliance_alert', 'brand_new_type', '', null]) {
    assert.equal(gi.resolveNotificationTarget(type, { shiftId: 3, amendmentId: 4 }), null, `${type} stays in the inbox`);
  }
});

test('GINBOX-07-UK-TIMES', () => {
  const now = Date.parse('2026-10-25T14:30:00.000Z'); // 14:30 GMT (clocks went back at 01:00 UTC today)
  assert.equal(gi.notificationTime('2026-10-25T14:29:30.000Z', now), 'Just now');
  assert.equal(gi.notificationTime('2026-10-25T14:18:00.000Z', now), '12 min ago · 14:18');
  assert.equal(gi.notificationTime('2026-10-25T09:10:00.000Z', now), 'Today · 09:10');
  assert.equal(gi.notificationTime('2026-10-24T20:40:00.000Z', now), 'Yesterday · 21:40', 'BST on the previous day');
  assert.equal(gi.notificationTime('2026-09-30T19:34:00.000Z', now), '30-09-2026 · 20:34');
  assert.equal(gi.notificationTime('', now), '');
  assert.equal(gi.notificationTime('not a date', now), '');
});

test('GINBOX-08-OLD-SERVERS-AND-OFFLINE-ARE-CALM', () => {
  for (const status of [404, 403]) {
    const p = gi.inboxLoadProblem({ status, body: { message: 'Cannot GET /notifications/mine' } });
    assert.equal(p.availability, 'unavailable');
    assert.match(p.message, /not available/);
    assert.match(p.message, /still work/);
  }
  assert.equal(gi.inboxLoadProblem({ name: 'NetworkError' }).availability, 'error');
  assert.match(gi.inboxLoadProblem({ name: 'NetworkError' }).message, /connection/);
  assert.equal(gi.inboxLoadProblem({ status: 500 }).availability, 'error');
  assert.equal(gi.inboxLoadProblem(null).availability, 'error');
  assert.match(gi.MARK_READ_FAILED_MESSAGE, /stay unread/);
  const screen = codeOf('src/screens/GuardDashboardScreen.tsx');
  assert.match(screen, /if \(problem\.availability === 'unavailable'\) \{\s*inboxUnavailableRef\.current = true;/, 'a server without the inbox is not polled again');
  assert.match(screen, /const badge = inboxAvailability === 'unavailable' \? null : unreadBadge\(unreadCount\(inbox\.items\)\);/, 'no badge on an old server');
  assert.match(screen, /\/\/ Independent of the dashboard read[^\n]*\n\s*void loadInbox\(\);\n\s*const \[myGuard/, 'an inbox failure never blocks the dashboard');
});

test('GINBOX-09-BOTH-ANDROID-CHANNELS', () => {
  assert.equal(gi.SHIFT_UPDATES_CHANNEL_ID, 'shift-updates');
  assert.equal(gi.SHIFT_UPDATES_CHANNEL_NAME, 'Shift updates');
  assert.equal(wp.WELFARE_CHANNEL_ID, 'welfare-checks');
  const src = codeOf('src/services/pushNotifications.ts');
  const configure = src.slice(src.indexOf('export async function configureWelfareNotifications'), src.indexOf('export async function registerWelfarePush'));
  const channels = [...configure.matchAll(/setNotificationChannelAsync\((\w+), \{[\s\S]*?importance: Notifications\.AndroidImportance\.(\w+)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(channels, [['WELFARE_CHANNEL_ID', 'MAX'], ['SHIFT_UPDATES_CHANNEL_ID', 'DEFAULT']]);
  assert.ok(configure.indexOf('SHIFT_UPDATES_CHANNEL_ID') > configure.indexOf('setNotificationCategoryAsync(WELFARE_CATEGORY_ID'),
    'the shift channel is created after the Welfare setup, in its own try, so it can never stop it');
  assert.match(configure, /\} catch \{\n?\s*\/\/ A device without notification support keeps working; Welfare Checks remain available in S4\.\s*\}\s*\/\/ Separate from the Welfare setup/);
  assert.doesNotMatch(src, /SHIFT_UPDATES_CHANNEL_ID[\s\S]{0,300}buttonTitle/, 'no action buttons on shift updates');
});

test('GINBOX-10-WELFARE-HANDLING-UNTOUCHED', () => {
  const src = codeOf('src/services/pushNotifications.ts').replace(/\r\n/g, '\n');
  // The foreground handler still shows every S4 push (Welfare and Guard notifications) as a banner.
  assert.match(src, /Notifications\.setNotificationHandler\(\{\n\s*handleNotification: async \(\) => \(\{ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false \}\),\n\s*\}\);/);
  // The Welfare tap subscription parses Welfare only, exactly as before.
  const welfareStart = src.indexOf('export function subscribeWelfareResponses');
  const welfare = src.slice(welfareStart, src.indexOf('\n}\n', welfareStart) + 2);
  assert.match(welfare, /const intent = parseWelfareResponse\(\{ actionIdentifier: response\.actionIdentifier, data: request\.content\.data, requestId: request\.identifier \}\);/);
  assert.doesNotMatch(welfare, /guard_notification|parseGuardNotificationResponse/);
  // The Guard subscription parses Guard notifications only.
  const guard = src.slice(src.indexOf('export function subscribeGuardNotificationResponses'));
  assert.match(guard, /parseGuardNotificationResponse\(/);
  assert.doesNotMatch(guard, /parseWelfareResponse|welfare_check/);
  // The Welfare channel and buttons are unchanged.
  assert.match(src, /name: 'Welfare Checks',\n\s*description: 'Reminders to confirm that you are safe and on duty\.',\n\s*importance: Notifications\.AndroidImportance\.MAX,/);
  assert.match(src, /\{ identifier: ACTION_IM_SAFE, buttonTitle: "I'm Safe", options: \{ opensAppToForeground: true, isAuthenticationRequired: true \} \}/);
  // App still wires the Welfare tap exactly as before.
  const app = codeOf('App.tsx');
  assert.match(app, /void configureWelfareNotifications\(\);\s*return subscribeWelfareResponses\(\(intent\) => setWelfareTap\(\{ intent, sessionLive: true \}\)\);/);
  // Nothing new logs.
  for (const rel of ['src/components/guard/guardInbox.ts', 'src/components/guard/GuardNotificationsInbox.tsx', 'src/services/pushNotifications.ts']) {
    assert.doesNotMatch(codeOf(rel), /console\.(log|warn|error|info|debug)/, `${rel} logs nothing`);
  }
});

test('GINBOX-11-APP-AND-DASHBOARD-WIRING', () => {
  // Taps are subscribed by the Guard dashboard, which only exists for a signed-in Guard; App is left as it was.
  const app = codeOf('App.tsx');
  assert.doesNotMatch(app, /guard_notification|subscribeGuardNotification|GuardNotificationIntent/);
  const screen = codeOf('src/screens/GuardDashboardScreen.tsx');
  assert.match(screen, /useEffect\(\(\) => subscribeGuardNotificationResponses\(\(intent\) => setNotificationTap\(intent\)\), \[\]\);/);
  assert.match(screen, /const target = resolveNotificationTarget\(tap\.type, \{ shiftId: tap\.shiftId, amendmentId: tap\.amendmentId \}\);\s*void markInboxRead\(tap\.notificationId, true\);/,
    'a push tap marks its notification read');
  assert.match(screen, /if \(!target\) \{\s*openInboxTarget\(null\);/, 'with nowhere better, the inbox opens');
  assert.match(screen, /if \(target\.shiftId\) setPendingOfferIdForDetail\(target\.shiftId\);/, 'a named offer opens in detail');
  assert.match(screen, /dispatchInbox\(\{ type: 'mark_read_failed', id \}\);\s*if \(!quiet\) setInboxNotice\(MARK_READ_FAILED_MESSAGE\);/, 'a failed read is rolled back with a non-blocking note');
  assert.match(screen, /useEffect\(\(\) => subscribeGuardNotificationsReceived\(\(\) => \{ void loadInbox\(\); \}\), \[\]\);/, 'a foreground push refreshes the badge');
  assert.match(screen, /void loadInbox\(INBOX_FOREGROUND_MIN_MS\);/, 'returning to the foreground refreshes the inbox');
  assert.match(screen, /accessibilityLabel=\{open \? 'Close notifications' : badge \? `Notifications, \$\{badge\} unread` : 'Notifications'\}/);
  assert.match(screen, /activeTab === 'inbox' \? 'home' : activeTab/, 'Home stays lit in the tab bar while the inbox is open');
  const inbox = codeOf('src/components/guard/GuardNotificationsInbox.tsx');
  assert.match(inbox, /<RefreshControl refreshing=\{refreshing\} onRefresh=\{onRefresh\}/, 'pull to refresh');
  assert.match(inbox, /title="No notifications"/, 'an empty state');
  assert.match(inbox, /accessibilityLabel=\{`\$\{unread \? 'Unread\. ' : ''\}/, 'rows say whether they are unread');
  // Only the endpoints the server has: list and single read. No invented "mark all read".
  const api = codeOf('src/services/api.ts');
  assert.match(api, /export function listMyNotifications\(\) \{\s*return request<Notification\[\]>\('\/notifications\/mine'\);/);
  assert.match(api, /export function markNotificationRead\(id: number\) \{\s*return request<Notification>\(`\/notifications\/\$\{id\}\/read`, \{\s*method: 'PATCH',/);
  assert.doesNotMatch(api + screen + inbox, /read-all|readAll|markAllRead|mark-all/i);
  const controller = path.join(ROOT, '..', 'security-backend-nest', 'src', 'notification', 'notification.controller.ts');
  if (fs.existsSync(controller)) {
    const c = fs.readFileSync(controller, 'utf8');
    assert.match(c, /@Get\('mine'\)/);
    assert.match(c, /@Patch\(':id\/read'\)/);
    assert.match(c, /UserRole\.GUARD/);
  }
});

console.log(`\n${passed} Guard inbox checks passed`);
