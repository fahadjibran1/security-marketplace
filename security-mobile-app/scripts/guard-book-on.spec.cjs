/**
 * UAT-ATT-01 + pilot build provenance.
 *
 * Real Guard UAT could not Book On. The backend had never had a time gate — the release gate's own E2E
 * books on about 48 hours early and asserts 201 — but the Guard screen refused before the scheduled
 * start in three independent places: the button was disabled, the press handler returned early, and the
 * copy said "check-in unlocks at that time". The locked product rule is that an assigned READY Guard
 * may Book On early, on time or late, with a confirmation (never a block) when substantially early.
 *
 * The decision rule is EXECUTED here, not grepped, because the defect was a decision, not a label. The
 * confirm/cancel paths are driven through a simulated press so "confirm runs the real check-in exactly
 * once" is proven rather than assumed.
 *
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Shared loader (scripts/load-ts.cjs): resolves relative imports between pure source modules.
const { loadTs: loadModule } = require('./load-ts.cjs');

const bookOn = loadModule('src/components/guard/bookOnPresentation.ts');
const buildInfo = loadModule('src/services/appBuildInfo.ts');

const guard = read('src/screens/GuardDashboardScreen.tsx');

const MIN = 60_000;
const START = Date.UTC(2026, 8, 28, 18, 0);
const fmt = () => '18:00';
const decide = (minutesEarly) =>
  bookOn.bookOnDecision({ startMs: START, nowMs: START - minutesEarly * MIN, formatStart: fmt });

/**
 * The screen's real sequence: press -> decide -> either check in now, or ask and check in on confirm.
 * Mirrors handlePrimaryHomeAction + confirmEarlyBookOn/cancelEarlyBookOn, including clearing the
 * pending state BEFORE calling check-in so one press cannot produce two calls.
 */
function makeScreen(nowMs, startMs = START) {
  const checkIns = [];
  let pending = null;
  return {
    checkIns,
    get dialogVisible() { return pending !== null; },
    get dialogText() { return pending ? `${pending.title}\n${pending.message}` : null; },
    press() {
      const decision = bookOn.bookOnDecision({ startMs, nowMs, formatStart: fmt });
      if (decision.kind === 'confirm') { pending = decision; return; }
      checkIns.push(1);
    },
    confirm() {
      if (!pending) return;
      pending = null;              // cleared first — a second tap cannot re-fire
      checkIns.push(1);
    },
    cancel() { pending = null; },
  };
}

// ═══════════════════ 1-9 the whole early/on-time/late range ═══════════════════

test('BOOKON-01-TWO-HOURS-EARLY-IS-PERMITTED', () => {
  const screen = makeScreen(START - 120 * MIN);
  screen.press();
  assert.equal(screen.dialogVisible, true, 'it asks, because 2 h is substantially early');
  screen.confirm();
  assert.equal(screen.checkIns.length, 1, 'and then books on — early is never refused');
});

test('BOOKON-02-THIRTY-ONE-MINUTES-EARLY-ASKS-FIRST', () => {
  const decision = decide(31);
  assert.equal(decision.kind, 'confirm');
  assert.equal(decision.minutesEarly, 31);
  assert.match(decision.title, /Book on early\?/);
  assert.match(decision.message, /scheduled start is 18:00/);
  assert.match(decision.message, /31 min early/);
  // It must not imply the schedule moves.
  assert.match(decision.message, /scheduled shift times do not change/i);
  assert.equal(decision.confirmLabel, 'Book On');
  assert.equal(decision.cancelLabel, 'Cancel');
});

test('BOOKON-03-CONFIRM-RUNS-THE-REAL-CHECK-IN-EXACTLY-ONCE', () => {
  const screen = makeScreen(START - 90 * MIN);
  screen.press();
  screen.confirm();
  assert.equal(screen.checkIns.length, 1);
  screen.confirm();                                  // a second tap on a closed dialog
  assert.equal(screen.checkIns.length, 1, 'confirming twice must not book on twice');
  // And the screen wires confirm to the SAME handler an ordinary Book On uses.
  const confirmFn = /const confirmEarlyBookOn = useCallback\(\(\) => \{([\s\S]*?)\}, \[earlyBookOn\]\)/.exec(guard);
  assert.ok(confirmFn, 'the confirm callback exists');
  assert.match(confirmFn[1], /setEarlyBookOn\(null\);\s*handleCheckIn\(shiftId\);/, 'state cleared, then the normal path');
});

test('BOOKON-04-CANCEL-DOES-NOTHING', () => {
  const screen = makeScreen(START - 120 * MIN);
  screen.press();
  screen.cancel();
  assert.deepEqual(screen.checkIns, [], 'cancelling must not book on');
  assert.equal(screen.dialogVisible, false);
  const cancelFn = /const cancelEarlyBookOn = useCallback\(\(\) => setEarlyBookOn\(null\), \[\]\)/.exec(guard);
  assert.ok(cancelFn, 'cancel only closes the question');
});

test('BOOKON-05-EXACTLY-THIRTY-MINUTES-EARLY-PROCEEDS-WITHOUT-ASKING', () => {
  assert.equal(bookOn.EARLY_CONFIRM_THRESHOLD_MINUTES, 30);
  const screen = makeScreen(START - 30 * MIN);
  screen.press();
  assert.equal(screen.dialogVisible, false, 'at the threshold there is no interruption');
  assert.equal(screen.checkIns.length, 1);
});

test('BOOKON-06-FIVE-MINUTES-EARLY-PROCEEDS', () => {
  const screen = makeScreen(START - 5 * MIN);
  screen.press();
  assert.equal(screen.dialogVisible, false);
  assert.equal(screen.checkIns.length, 1);
});

test('BOOKON-07-EXACT-SCHEDULED-START-PROCEEDS', () => {
  const screen = makeScreen(START);
  screen.press();
  assert.equal(screen.dialogVisible, false);
  assert.equal(screen.checkIns.length, 1);
});

test('BOOKON-08-FIVE-MINUTES-LATE-PROCEEDS', () => {
  const screen = makeScreen(START + 5 * MIN);
  screen.press();
  assert.equal(screen.dialogVisible, false, 'lateness is never questioned');
  assert.equal(screen.checkIns.length, 1);
});

test('BOOKON-09-TWO-HOURS-LATE-AND-PAST-THE-END-STILL-PROCEED', () => {
  for (const offset of [120 * MIN, 13 * 60 * MIN]) {
    const screen = makeScreen(START + offset);
    screen.press();
    assert.equal(screen.dialogVisible, false);
    assert.equal(screen.checkIns.length, 1, `late by ${offset / MIN} min must still book on`);
  }
  // No client-side late cutoff exists at all: every non-early case is `proceed`.
  for (const m of [0, -1, -60, -600, -100000]) {
    assert.equal(decide(m).kind, 'proceed', `${m} min early must proceed`);
  }
});

// ═══════════════════ 10-13 the lock is genuinely gone ═══════════════════

test('BOOKON-10-BEFORE-SHIFT-NO-LONGER-DISABLES-THE-BUTTON', () => {
  const line = /const primaryDisabled =\s*([^;]+);/.exec(guard);
  assert.ok(line, 'primaryDisabled is computed');
  assert.doesNotMatch(line[1], /before_shift/, 'being early must not disable Book On');
  assert.match(line[1], /attendanceBusyShiftId === currentHomeShift\.id/, 'only an in-flight request does');
});

test('BOOKON-11-THE-PRESS-HANDLER-NO-LONGER-RETURNS-EARLY', () => {
  const handler = /function handleCurrentShiftPrimaryPress\(\) \{([\s\S]*?)\n  \}/.exec(guard);
  assert.ok(handler, 'the press handler exists');
  assert.doesNotMatch(handler[1], /guardShiftPhase === 'before_shift'\) return/, 'no silent early return');
  assert.match(handler[1], /if \(!currentHomeShift\) return;/, 'only a missing shift stops it');
});

test('BOOKON-12-RESTRICTIVE-COPY-IS-GONE', () => {
  for (const banned of [
    /check-in unlocks/i,
    /You are early — check-in unlocks/i,
    /Check in at start/,
    /You cannot clock in yet/i,
    /reporting stays off until you check in/i,
  ]) {
    assert.doesNotMatch(guard, banned, `restrictive copy must be gone: ${banned}`);
  }
  // Replaced with wording that offers the action.
  assert.ok(guard.includes('Book on early'), 'the action label invites early attendance');
  assert.match(bookOn.beforeShiftStatusLine('18:00', 'Mon 28 Sep'), /Book On is available now/);
  assert.match(bookOn.BEFORE_SHIFT_GUIDANCE, /You can Book On before your scheduled start/);
});

test('BOOKON-13-EARLY-COPY-DOES-NOT-PROMISE-A-SCHEDULE-CHANGE', () => {
  assert.match(bookOn.BEFORE_SHIFT_GUIDANCE, /scheduled shift times stay the same/i);
  assert.match(bookOn.BEFORE_SHIFT_GUIDANCE, /welfare checks still follow the scheduled start/i);
  assert.match(decide(120).message, /scheduled shift times do not change/i);
});

// ═══════════════════ 14-15 one press, and nothing else disturbed ═══════════════════

test('BOOKON-14-ONE-PRESS-CANNOT-PRODUCE-TWO-CONFIRMATIONS', () => {
  const screen = makeScreen(START - 100 * MIN);
  screen.press();
  screen.press();                                     // pressing again while the question is open
  assert.equal(screen.dialogVisible, true);
  screen.confirm();
  assert.equal(screen.checkIns.length, 1, 'still exactly one check-in');
  // The dialog is driven by a single nullable state object, so two can never be stacked.
  assert.match(guard, /const \[earlyBookOn, setEarlyBookOn\] = useState<\{ shiftId: number; decision: BookOnDecision \} \| null>\(null\)/);
});

test('BOOKON-15-GPS-NFC-AND-LIFECYCLE-PRESENTATION-ARE-UNTOUCHED', () => {
  // Still only ever calls check-in for a READY shift, check-out for in_progress.
  assert.match(guard, /if \(status === 'ready'\) \{/, 'ready still means Book On');
  assert.match(guard, /if \(status === 'in_progress'\) \{\s*handleCheckOut/, 'in_progress still means Book Off');
  assert.match(guard, /if \(status === 'offered'\) \{/, 'an offer still routes to Offers');
  // The caution for booking on after the window ended is preserved, not replaced by a block.
  assert.ok(guard.includes('This shift window has ended.'), 'the after-end caution remains');
  // The check-in request body is unchanged, so GPS/NFC handling is not altered by this work.
  assert.match(guard, /await checkInShift\(\{ shiftId \}\)/, 'the request payload is unchanged');
});

console.log(`
${passed} guard book on checks passed`);
