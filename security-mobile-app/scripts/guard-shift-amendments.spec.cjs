#!/usr/bin/env node
/**
 * S4 Live Shift Amendments Phase 3: the Guard app.
 *
 * Executes the real Guard module (which request to show, words for every state, warnings from the backend's figures,
 * failure guidance, dispute validation, history), checks the client's three requests against the API's own source,
 * and checks the screen wiring by reading the source: one answer at a time, nothing changed on the device before the
 * server confirms, refreshes ride the existing tick and foregrounding, no claim of instant delivery, an older backend
 * hides the feature, and existing shift/attendance code paths are untouched.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const backendOf = (rel) => fs.readFileSync(path.join(ROOT, '..', 'security-backend-nest', rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const g = loadTs('src/components/guard/guardShiftAmendments.ts');
const LONDON = 'Europe/London';
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-23T19:00:00.000Z'); // 20:00 BST
const iso = (ms) => new Date(ms).toISOString();
const req = (over = {}) => ({
  id: 9, shiftId: 50, guardId: 3, sequence: 1, status: 'pending', effectiveStatus: 'pending',
  originalEnd: iso(NOW + HOUR), previousEnd: iso(NOW + HOUR), proposedEnd: iso(NOW + 2 * HOUR), agreedEnd: null,
  additionalMinutes: 60, reason: 'Relief Guard delayed', proposedByUserId: 7, proposedAt: iso(NOW - 5 * MIN), expiresAt: iso(NOW + HOUR),
  fatigue: { basis: 'scheduled_hours', totalScheduledHours: 9, warnings: [], restHoursBeforeNextShift: null, sevenDayScheduledHours: 30 },
  approvalRequired: false, approvedByUserId: null, approvedAt: null, selfApproved: false,
  responseMethod: null, staffReported: false, respondedByUserId: null, respondedAt: null,
  verbalContactMethod: null, verbalContactAt: null, verbalConfirmation: null, confirmationEmailStatus: null,
  withdrawnAt: null, voidedReason: null, voidedAt: null, expiredAt: null, disputedAt: null, disputeReason: null,
  disputeResolution: null, disputeResolutionNote: null, disputeResolvedAt: null, timesheetSync: null,
  payrollReviewRequired: false, billingReviewRequired: false, complianceReviewRequired: false, ...over,
});
const screen = stripComments(codeOf('src/screens/GuardDashboardScreen.tsx'));
const card = stripComments(codeOf('src/components/guard/GuardShiftExtensionCard.tsx'));

test('G-01-THE-THREE-REQUESTS-MATCH-THE-API-ROUTES-AND-DTOS', () => {
  const client = stripComments(codeOf('src/services/api.ts'));
  const controller = backendOf('src/shift-amendment/shift-amendment.controller.ts');
  assert.ok(controller.includes("@Get('shift-amendments/mine')\n  @Roles(UserRole.GUARD)"));
  assert.ok(controller.includes("@Patch('shift-amendments/:id/respond')\n  @Roles(UserRole.GUARD)"));
  assert.ok(/@Post\('shift-amendments\/:id\/dispute'\)\s*@HttpCode\(200\)\s*@Roles\(UserRole\.GUARD\)/.test(controller));
  assert.ok(client.includes("request<ShiftAmendment[]>('/shift-amendments/mine')"));
  assert.ok(/respondToShiftAmendment\(id: number, payload: \{ response: 'accepted' \| 'declined' \}\)[\s\S]{0,160}method: 'PATCH'/.test(client));
  assert.ok(/disputeShiftAmendment\(id: number, payload: \{ reason: string \}\)[\s\S]{0,160}method: 'POST'/.test(client));
  const dto = backendOf('src/shift-amendment/dto/shift-amendment.dto.ts');
  assert.ok(dto.includes("@IsIn(['accepted', 'declined'])"));
  const disputeDto = dto.slice(dto.indexOf('export class DisputeAmendmentDto'), dto.indexOf('export class ResolveDisputeDto'));
  assert.ok(disputeDto.includes(`@MinLength(${g.GUARD_DISPUTE_MIN})`) && disputeDto.includes(`@MaxLength(${g.GUARD_DISPUTE_MAX})`));
});

test('G-02-WHICH-REQUEST-THE-HOME-CARD-SHOWS', () => {
  const open = req({ id: 2, sequence: 2 });
  const answered = req({ id: 1, sequence: 1, status: 'accepted', effectiveStatus: 'accepted', responseMethod: 'guard_app', respondedAt: iso(NOW - HOUR) });
  assert.equal(g.openRequestForShift([answered, open], 50).id, 2);
  assert.equal(g.openRequestForShift([answered, open], 51), null, 'another shift');
  assert.equal(g.openRequestForShift([answered, open], null), null);
  const waiting = req({ status: 'awaiting_approval', effectiveStatus: 'awaiting_approval', approvalRequired: true });
  assert.equal(g.openRequestForShift([waiting], 50).id, 9, 'waiting for management is shown too');
  const lapsed = req({ effectiveStatus: 'expired' });
  assert.equal(g.openRequestForShift([lapsed], 50), null, 'a lapsed request is not open, even before the sweep');
  assert.equal(g.cardRequestForShift([lapsed], 50).id, 9, 'but it is still shown, as expired');
  assert.equal(g.cardRequestForShift([answered, req({ id: 3, sequence: 3, status: 'withdrawn', effectiveStatus: 'withdrawn' })], 50).id, 3, 'latest');
  const verbalOld = req({ id: 7, shiftId: 40, status: 'accepted', effectiveStatus: 'accepted', responseMethod: 'staff_recorded_verbal', staffReported: true });
  assert.deepEqual(g.disputableRequests([answered, verbalOld]).map((a) => a.id), [7], 'a recorded agreement on a finished shift can still be disputed');
});

test('G-03-ACCEPT-AND-DECLINE-ONLY-WHILE-OPEN-AND-BEFORE-THE-DEADLINE', () => {
  assert.equal(g.canAnswer(req(), NOW), true);
  assert.equal(g.canAnswer(req(), NOW + HOUR), false, 'deadline passed on the device clock');
  assert.equal(g.canAnswer(req({ effectiveStatus: 'expired' }), NOW), false);
  assert.equal(g.canAnswer(req({ status: 'awaiting_approval', effectiveStatus: 'awaiting_approval' }), NOW), false, 'not before management approval');
  assert.equal(g.canAnswer(null, NOW), false);
  assert.equal(g.guardRequestTitle(req()), 'Your company is asking you to stay later');
  assert.match(g.guardRequestExplanation(req(), LONDON), /^Nothing changes unless you accept\. If you do not answer by 21:00, the request expires and your shift still ends at 21:00\.$/);
  const accepted = req({ status: 'accepted', effectiveStatus: 'accepted', responseMethod: 'guard_app', agreedEnd: iso(NOW + 2 * HOUR) });
  assert.equal(g.guardRequestTitle(accepted), 'You accepted the extension');
  assert.equal(g.guardRequestExplanation(accepted, LONDON), 'Your shift now ends at 22:00.');
  const declined = req({ status: 'declined', effectiveStatus: 'declined' });
  assert.equal(g.guardRequestTitle(declined), 'You declined the extension');
  assert.match(g.guardRequestExplanation(declined, LONDON), /did not change \(21:00\)/);
  // the card: two steps, and the confirm buttons are disabled while sending
  assert.ok(card.includes("onPress={() => setConfirming('accepted')} disabled={submitting}"));
  assert.ok(card.includes("onPress={() => setConfirming('declined')} disabled={submitting}"));
  assert.ok(/loading=\{submitting\}\s*disabled=\{submitting\}\s*onPress=\{\(\) => onAnswer\(confirming\)\}/.test(card));
  assert.ok(card.includes("'Your shift end changes only once S4 confirms your answer.'"));
});

test('G-04-EXPIRED-WITHDRAWN-AND-CANCELLED-SAY-NOTHING-CHANGED', () => {
  const cases = [
    [req({ effectiveStatus: 'expired' }), 'The extension request expired', /not answered in time\. Your shift end did not change \(21:00\)/],
    [req({ status: 'expired', effectiveStatus: 'expired', expiredAt: iso(NOW) }), 'The extension request expired', /did not change/],
    [req({ status: 'withdrawn', effectiveStatus: 'withdrawn', withdrawnAt: iso(NOW) }), 'Your company withdrew the extension request', /did not change \(21:00\)\. You do not need to do anything\./],
    [req({ status: 'voided', effectiveStatus: 'voided', voidedAt: iso(NOW), voidedReason: 'booked_off' }), 'Extension request cancelled — you booked off', /did not change/],
    [req({ status: 'awaiting_approval', effectiveStatus: 'awaiting_approval', approvalRequired: true }), 'Extension request — waiting for management approval', /Management must approve this request before you can answer it\. Your shift end has not changed\./],
  ];
  for (const [a, title, explain] of cases) {
    assert.equal(g.guardRequestTitle(a), title);
    assert.match(g.guardRequestExplanation(a, LONDON), explain);
  }
  assert.equal(g.guardApprovalText(req({ approvalRequired: true, status: 'awaiting_approval' })), 'Waiting for management approval');
  assert.equal(g.guardApprovalText(req({ approvalRequired: true, approvedAt: iso(NOW) })), 'Approved by management');
  assert.equal(g.guardApprovalText(req()), null, 'not shown when not required');
});

test('G-05-A-STAFF-RECORDED-AGREEMENT-IS-NEVER-SHOWN-AS-THE-GUARDS-OWN-ACCEPTANCE', () => {
  const verbal = req({ status: 'accepted', effectiveStatus: 'accepted', responseMethod: 'staff_recorded_verbal', staffReported: true,
    verbalContactMethod: 'telephone', verbalContactAt: iso(NOW - 3 * MIN), verbalConfirmation: 'Guard agreed by phone', agreedEnd: iso(NOW + 2 * HOUR), respondedAt: iso(NOW) });
  assert.equal(g.guardRequestTitle(verbal), 'Extension recorded by your company');
  assert.equal(g.guardRequestExplanation(verbal, LONDON),
    'Your company recorded that you agreed verbally (by telephone at 19:57). You did not accept this in the app. Your shift now ends at 22:00. If you did not agree, you can dispute it.');
  assert.ok(!/You accepted/.test(g.guardRequestTitle(verbal) + g.guardRequestExplanation(verbal, LONDON)));
  const h = g.buildGuardHistory([verbal], LONDON);
  assert.equal(h[1].title, 'Recorded by your company as agreed verbally');
  assert.match(h[1].detail, /^Not accepted in the app\. Their record: "Guard agreed by phone"$/);
  assert.ok(card.includes("const disputable = request.status === 'accepted' && request.responseMethod === 'staff_recorded_verbal';"));
  assert.ok(card.includes('label="I did not agree — dispute"'));
  assert.ok(card.includes("case 'accepted': return request.responseMethod === 'staff_recorded_verbal' ? 'Recorded by company' : 'Accepted';"), 'the badge says who recorded it');
});

test('G-06-DISPUTE-SUBMISSION-AND-STATUS', () => {
  assert.match(g.validateGuardDispute('').message, /what you did agree to/);
  assert.match(g.validateGuardDispute('x'.repeat(501)).message, /500/);
  assert.deepEqual(g.validateGuardDispute('I agreed to 30 minutes'), { ok: true });
  const disputed = req({ status: 'disputed', effectiveStatus: 'disputed', responseMethod: 'staff_recorded_verbal', disputedAt: iso(NOW), disputeReason: 'Only 30 minutes' });
  assert.equal(g.guardRequestTitle(disputed), 'You disputed this extension — waiting for review');
  assert.equal(g.guardRequestExplanation(disputed, LONDON), 'The extension stays in place until your company reviews it. Your reason: Only 30 minutes');
  assert.equal(g.guardStatusTone(disputed), 'danger');
  assert.equal(g.disputableRequests([disputed]).length, 0, 'cannot dispute twice');
  const corrected = { ...disputed, status: 'dispute_corrected', effectiveStatus: 'dispute_corrected', disputeResolution: 'corrected', disputeResolutionNote: 'Paid to 21:30', disputeResolvedAt: iso(NOW + MIN) };
  assert.equal(g.guardRequestExplanation(corrected, LONDON), 'Your company will correct your hours through the timesheet. Their note: Paid to 21:30');
  assert.ok(/onPress=\{\(\) => \{ setAttempted\(true\); if \(verdict\.ok\) onDispute\(reason\.trim\(\)\); \}\}/.test(card), 'only a valid reason is sent');
});

test('G-07-WARNINGS-ARE-THE-BACKENDS-FIGURES-NEVER-THRESHOLDS-GUESSED-BY-THE-APP', () => {
  const f = { basis: 'scheduled_hours', totalScheduledHours: 15, warnings: [], restHoursBeforeNextShift: 9.5, sevenDayScheduledHours: 52 };
  assert.equal(g.guardWarningText('LONG_SHIFT', f), "Long shift: this would make your shift longer than your company's usual limit (15 h).");
  assert.equal(g.guardWarningText('SHORT_REST', f), 'Short rest: you would have less rest than recommended before your next shift (9.5 h).');
  assert.equal(g.guardWarningText('WEEKLY_HOURS', f), '7-day hours: your scheduled hours in the last 7 days are high (52 h).');
  assert.match(g.guardWarningText('LAST_MINUTE', f), /^Last-minute request/);
  const src = stripComments(codeOf('src/components/guard/guardShiftAmendments.ts'));
  assert.ok(!/\b(12|14|16|11|48)\s*(h\b|hours)/.test(src), 'no threshold written into the Guard app');
  for (const rel of ['src/components/guard/guardShiftAmendments.ts', 'src/components/guard/GuardShiftExtensionCard.tsx', 'src/screens/GuardDashboardScreen.tsx']) {
    assert.ok(!/getShiftAmendmentPolicy/.test(stripComments(codeOf(rel))), `${rel} never reads the company policy (company-only)`);
  }
  assert.ok(card.includes('request.fatigue.warnings.map((w) =>'), 'the card shows exactly the warnings the backend stored');
});

test('G-08-FAILURES-HAVE-A-PLAIN-NEXT-STEP-AND-RETRIES-ARE-SAFE', () => {
  const net = g.guardAmendmentGuidance(Object.assign(new Error('Network request failed'), { name: 'NetworkError' }));
  assert.equal(net.message, 'No connection to S4. Your answer was not sent — check your signal and try again.');
  assert.equal(net.retryable, true);
  const code = (c, status = 409, message = 'API words.') => g.guardAmendmentGuidance({ status, body: { code: c, message } });
  assert.deepEqual([code('SHIFT_AMENDMENT_EXPIRED').reload, code('SHIFT_AMENDMENT_EXPIRED').message], [true, 'This request has expired. Your shift end has not changed.']);
  assert.match(code('SHIFT_AMENDMENT_NOT_OPEN', 409, 'This extension is withdrawn and can no longer be answered.').message, /withdrawn.*Your shift end has not changed\./);
  assert.equal(code('SHIFT_AMENDMENT_ALREADY_ANSWERED').reload, true);
  assert.equal(code('SHIFT_AMENDMENT_APPROVAL_REQUIRED').reload, true);
  assert.equal(code('SHIFT_AMENDMENT_BUSY').retryable, true);
  assert.equal(code('SHIFT_AMENDMENT_BUSY').reload, false);
  assert.match(code('SHIFT_AMENDMENT_CLASH', 409, 'Guard has an overlapping shift assignment.').message, /overlapping.*not changed/);
  assert.equal(code('SHIFT_AMENDMENTS_DISABLED', 403).reload, true);
  assert.equal(g.guardAmendmentGuidance({ status: 503, body: {} }).retryable, true);
  assert.match(g.guardAmendmentGuidance({ status: 401, body: {} }).message, /Sign in again/);
  assert.match(g.guardAmendmentGuidance({ status: 404, body: { message: 'Cannot GET' } }).message, /not available to you/);
  // the server answers a repeated answer with the stored result, so a retry after a lost response cannot double-apply
  const service = backendOf('src/shift-amendment/shift-amendment.service.ts');
  assert.ok(service.includes("if (settled === 'same') return this.view(id, 'guard');"), "the stored answer, with the Guard's own figures");
});

test('G-09-DOUBLE-TAPS-SEND-ONE-ANSWER', () => {
  for (const fn of ['handleAmendmentAnswer', 'handleAmendmentDispute']) {
    const body = screen.slice(screen.indexOf(`async function ${fn}(`), screen.indexOf('\n  }\n', screen.indexOf(`async function ${fn}(`)));
    assert.ok(/if \(amendmentInFlightRef\.current\) return;\s*amendmentInFlightRef\.current = true;/.test(body), `${fn}: guarded`);
    assert.ok(/finally \{\s*amendmentInFlightRef\.current = false;\s*setAmendmentSubmitting\(false\);/.test(body), `${fn}: always released`);
  }
  assert.ok(screen.includes('submitting={amendmentSubmitting}'), 'the card disables its buttons while one is in flight');
});

test('G-10-NOTHING-CHANGES-ON-THE-DEVICE-BEFORE-THE-SERVER-CONFIRMS', () => {
  const body = screen.slice(screen.indexOf('async function handleAmendmentAnswer('), screen.indexOf('async function handleAmendmentDispute('));
  assert.ok(!/setShifts|setAttendance|setTimesheets/.test(body), 'no local edit of shifts, attendance or timesheets');
  assert.ok(/const saved = await respondToShiftAmendment\(amendment\.id, \{ response \}\);[\s\S]*await loadData\(true\);/.test(body), 're-read from the server after it confirms');
  assert.ok(body.indexOf('await respondToShiftAmendment') < body.indexOf("pushFeedback('success'"), 'success is said only after the server answers');
  assert.ok(screen.includes('currentEnd={shift?.end ?? request.agreedEnd ?? request.previousEnd ?? \'\'}'), 'the current end is the server\'s shift');
});

test('G-11-REFRESH-RIDES-THE-EXISTING-TICK-AND-FOREGROUNDING', () => {
  // 4 = the screen's timers before Phase 3 (three reveal countdowns and the minute tick)
  assert.equal((codeOf('src/screens/GuardDashboardScreen.tsx').match(/setInterval\(/g) || []).length, 4, 'no new timer');
  assert.ok(/clearBankReveal\(\);\s*if \(Date\.now\(\) - lastLoadTimeRef\.current > 30_000\) \{\s*loadData\(\);\s*\} else \{\s*void loadShiftAmendments\(GUARD_AMENDMENT_FOREGROUND_MIN_MS\);\s*\}/.test(screen), 'foregrounding');
  assert.ok(/normalizeShiftLifecycleStatus\(currentHomeShift\.status\) !== 'in_progress'\) return;\s*void loadShiftAmendments\(GUARD_AMENDMENT_REFRESH_MS - 5_000\);[\s\S]{0,80}\}, \[liveNow\]\);/.test(screen), 'the minute tick while a shift is live');
  assert.ok(/setTimesheets\(timesheetRows\);\s*void loadShiftAmendments\(\);/.test(screen), 'every full load');
  assert.equal(g.GUARD_AMENDMENT_REFRESH_MS, 60_000);
  assert.equal(g.GUARD_AMENDMENT_FOREGROUND_MIN_MS, 15_000);
  // a failed background refresh keeps the last answer and says how old it is
  const load = screen.slice(screen.indexOf('async function loadShiftAmendments('), screen.indexOf('async function handleAmendmentAnswer('));
  assert.ok(/catch \(error\) \{\s*if \(isFeatureUnavailable\(error\)\) amendmentsUnavailableRef\.current = true;\s*\}/.test(load));
  assert.ok(card.includes("refreshedAt ? `Checked ${formatInstantTime("));
});

test('G-12-NO-CLAIM-OF-INSTANT-DELIVERY', () => {
  assert.match(g.GUARD_DELIVERY_NOTE, /S4 does not send instant alerts for them\.$/);
  for (const src of [card, stripComments(codeOf('src/components/guard/guardShiftAmendments.ts'))]) {
    assert.ok(!/\binstantly\b|push notification|you will be notified|we('| wi)ll notify/i.test(src.replace(g.GUARD_DELIVERY_NOTE, '')));
  }
  assert.ok(card.includes('{GUARD_DELIVERY_NOTE}'));
});

test('G-13-PERMISSION-AND-TENANT-ISOLATION-ARE-THE-SERVERS', () => {
  const client = stripComments(codeOf('src/services/api.ts'));
  const block = client.slice(client.indexOf('export function listMyShiftAmendments'), client.indexOf('export function respondToShift('));
  assert.ok(!/guardId|companyId|userId/.test(block), 'the Guard is identified by the session, never by the client');
  const service = backendOf('src/shift-amendment/shift-amendment.service.ts');
  assert.ok(service.includes(".where('a.guardId = :guardId', { guardId: guard.guardId })"), 'mine = only this Guard');
  assert.ok(service.includes("if (!pre || pre.guardId !== guard.guardId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');"), "another Guard's request reads as not found");
  assert.equal(g.guardAmendmentGuidance({ status: 404, body: { code: 'SHIFT_AMENDMENT_NOT_FOUND', message: 'x' } }).message, 'This request is no longer available.');
});

test('G-14-AN-OLDER-BACKEND-HIDES-THE-FEATURE-QUIETLY', () => {
  assert.equal(g.isFeatureUnavailable({ status: 404, body: { statusCode: 404, message: 'Cannot GET /shift-amendments/mine', error: 'Not Found' } }), true);
  assert.equal(g.isFeatureUnavailable({ status: 404, body: { code: 'SHIFT_AMENDMENT_NOT_FOUND' } }), false, 'a real "not found" is not "no feature"');
  assert.equal(g.isFeatureUnavailable({ status: 500, body: {} }), false);
  assert.equal(g.isFeatureUnavailable(Object.assign(new Error('offline'), { name: 'NetworkError' })), false, 'offline is not "no feature"');
  assert.ok(/if \(amendmentsUnavailableRef\.current\) return;/.test(screen));
});

test('G-15-EXISTING-SHIFT-AND-ATTENDANCE-PATHS-ARE-UNTOUCHED', () => {
  // Fingerprints of the Book On, Book Off and shift-offer handlers exactly as shipped: Book On / Book Off as in the
  // Android 1.1.0 (15) / iOS 1.1.0 (14) build source 6b8e41b, and the offer answer as in the preserved archive
  // (tag archive/welfare-alert-remediation → 8825c11, which adds the ended-offer rule of 5f9795d). Any edit to them
  // fails here. The amendment work adds to this screen and removes nothing.
  const raw = codeOf('src/screens/GuardDashboardScreen.tsx');
  const fp = (name) => {
    const i = raw.indexOf(`  async function ${name}(`);
    assert.ok(i >= 0, `${name} exists`);
    return crypto.createHash('sha256').update(raw.slice(i, raw.indexOf('\n  }\n', i))).digest('hex').slice(0, 16);
  };
  assert.equal(fp('handleCheckIn'), 'de3fdd408ead604d', 'Book On as shipped in 1.1.0');
  assert.equal(fp('handleCheckOut'), '3c8e7358c7d02070', 'Book Off as shipped in 1.1.0 (confirmation)');
  assert.equal(fp('handleRespondToShift'), '34e8142fd85867d3', 'shift-offer answers as in the preserved archive');
  for (const fn of ['respondToShift(', 'checkIn', 'checkOut', 'createIncident', 'createDailyLog']) {
    assert.ok(codeOf('src/services/api.ts').includes(fn), `${fn} still in the client`);
  }
});

test('G-16-ANDROID-AND-IOS-LAYOUT-WRAPS-ON-A-PHONE', () => {
  const raw = codeOf('src/components/guard/GuardShiftExtensionCard.tsx');
  const style = (name) => {
    const m = new RegExp(`\\n  ${name}: \\{([^}]*)\\}`).exec(raw);
    assert.ok(m, `style ${name}`);
    return m[1];
  };
  for (const name of ['header', 'factRow', 'actions']) assert.match(style(name), /flexWrap: 'wrap'/, `${name} wraps`);
  assert.match(style('factValue'), /flex: 1, minWidth: 140/);
  assert.match(style('title'), /flexShrink: 1/);
  const widths = [...raw.matchAll(/\bwidth: (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(widths.every((w) => w <= 140), `no fixed width wider than half a 320 pt phone: ${widths}`);
  assert.ok(!/position: 'absolute'/.test(raw), 'nothing overlaps on small screens');
  assert.ok(/<TextInput[\s\S]{0,80}multiline/.test(raw) && raw.includes("textAlignVertical: 'top'"), 'Android multiline input aligns to the top');
});

test('G-17-HISTORY-IS-CHRONOLOGICAL', () => {
  const first = req({ id: 1, sequence: 1, status: 'accepted', effectiveStatus: 'accepted', responseMethod: 'guard_app', proposedAt: iso(NOW - 2 * HOUR), respondedAt: iso(NOW - 110 * MIN), agreedEnd: iso(NOW + HOUR), approvalRequired: true, approvedAt: iso(NOW - 115 * MIN) });
  const second = req({ id: 2, sequence: 2, status: 'withdrawn', effectiveStatus: 'withdrawn', proposedAt: iso(NOW - HOUR), withdrawnAt: iso(NOW - 50 * MIN) });
  const h = g.buildGuardHistory([second, first], LONDON);
  assert.deepEqual(h.map((e) => e.title.replace(/:.*/, '')), ['Request 1', 'Approved by management', 'You accepted in the app', 'Request 2', 'Withdrawn by your company']);
  for (let i = 1; i < h.length; i += 1) assert.ok(Date.parse(h[i - 1].at) <= Date.parse(h[i].at));
  assert.match(h[0].detail, /^Reason: Relief Guard delayed\. Originally due to end 23-10-2026 · 21:00\.$/);
  assert.equal(g.formatExtraTime(90), '1 h 30 min');
});

console.log(`\n${passed} passed`);
