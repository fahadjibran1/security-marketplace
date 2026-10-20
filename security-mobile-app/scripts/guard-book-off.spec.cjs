/**
 * Guard Book Off is confirmed, an early one says how early, and the Guard app says Book On / Book Off.
 * (Guard release audit remediation, 20 Oct 2026.)
 *
 * THE DEFECTS THIS EXISTS TO PREVENT
 *   M1  End Shift booked the Guard off on one tap, however early. On the Android emulator one tap ended a
 *       shift five hours before its scheduled end, and a Guard cannot undo a Book Off.
 *   L1  The Guard interface mixed "Check in now", "Checked in", "checked out", "Start Shift" and "End Shift"
 *       with Book On / Book Off. Owner decision: Book On and Book Off throughout. API names and stored
 *       values (check-in / check-out) are unchanged.
 *
 * WHAT IS EXECUTED HERE
 * The pure decision (bookOffPresentation.ts) is run across the 15-minute boundary, before and after the
 * scheduled end. The screen's wiring and its user-facing copy are read from source with comments stripped.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const codeOf = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const { bookOffDecision, EARLY_BOOK_OFF_WARNING_MINUTES } = loadTs('src/components/guard/bookOffPresentation.ts');

const MIN = 60_000;
const END = Date.UTC(2026, 9, 20, 18, 20, 0);
const decide = (minutesBeforeEnd) => bookOffDecision({ endMs: END, nowMs: END - minutesBeforeEnd * MIN, formatEnd: () => '19:20' });

// ═══════════════════ the decision ═══════════════════

test('BOFF-01-EVERY-BOOK-OFF-IS-A-QUESTION', () => {
  for (const before of [300, 16, 15, 1, 0, -30]) {
    const d = decide(before);
    assert.ok(d.title && d.message && d.confirmLabel, `${before} min before the end still asks`);
    assert.equal(d.cancelLabel, 'Stay on shift');
    assert.match(d.message, /You cannot undo a Book Off\./);
  }
});

test('BOFF-02-MORE-THAN-15-MINUTES-EARLY-SHOWS-THE-END-HOW-EARLY-AND-A-WARNING', () => {
  assert.equal(EARLY_BOOK_OFF_WARNING_MINUTES, 15);
  const d = decide(300);
  assert.equal(d.early, true);
  assert.equal(d.minutesEarly, 300);
  assert.equal(d.title, 'Book Off early?');
  assert.match(d.message, /Your scheduled end is 19:20\./, 'the scheduled end, in site time');
  assert.match(d.message, /You are booking off 5 hr early\./, 'how early');
  assert.match(d.message, /Control will see an early Book Off\./, 'a clear warning');
  assert.equal(d.confirmLabel, 'Book Off early');
  assert.match(decide(16).message, /16 min early/);
  assert.match(decide(102).message, /1 hr 42 min early/);
});

test('BOFF-03-THE-BOUNDARY-IS-EXACT', () => {
  assert.equal(decide(15).early, false, 'exactly 15 minutes early is a normal Book Off');
  assert.equal(bookOffDecision({ endMs: END, nowMs: END - 15 * MIN - 1000, formatEnd: () => '19:20' }).early, true, 'a second more is early');
  assert.equal(decide(0).early, false);
});

test('BOFF-04-ON-TIME-AND-LATE-BOOK-OFF-ARE-PLAIN', () => {
  const onTime = decide(5);
  assert.equal(onTime.title, 'Book Off now?');
  assert.match(onTime.message, /Your scheduled end is 19:20\./);
  assert.doesNotMatch(onTime.message, /early/i);
  const late = decide(-30);
  assert.match(late.message, /Your scheduled end was 19:20\./, 'after the end it reads in the past');
  assert.equal(late.minutesEarly, 0);
  assert.equal(late.confirmLabel, 'Book Off');
});

// ═══════════════════ the screen ═══════════════════

const SCREEN = 'src/screens/GuardDashboardScreen.tsx';

test('BOFF-05-THE-PRIMARY-ACTION-ASKS-INSTEAD-OF-BOOKING-OFF', () => {
  const code = codeOf(SCREEN);
  const press = code.slice(code.indexOf('function handleCurrentShiftPrimaryPress'), code.indexOf('const historySummaryShift'));
  const from = press.indexOf("status === 'in_progress'");
  const inProgress = press.slice(from, press.indexOf("status === 'completed'", from));
  assert.ok(inProgress.length > 0, 'the in-progress branch is findable');
  assert.match(inProgress, /setPendingBookOff\(/, 'it opens the confirmation');
  assert.ok(!inProgress.includes('handleCheckOut('), 'and never books off directly');
  assert.match(inProgress, /bookOffDecision\(\{[\s\S]*endMs: new Date\(currentHomeShift\.end\)\.getTime\(\)/, 'from the scheduled end');
  assert.match(inProgress, /currentHomeShift\.site\?\.timezone/, 'formatted in site time');
});

test('BOFF-06-CONFIRMING-IS-THE-ONLY-WAY-TO-BOOK-OFF-AND-IT-CANNOT-FIRE-TWICE', () => {
  const code = codeOf(SCREEN);
  const callers = code.match(/handleCheckOut\(/g) || [];
  assert.equal(callers.length, 2, 'the definition and the one confirmed call');
  const confirm = code.slice(code.indexOf('const confirmBookOff'), code.indexOf('const cancelBookOff'));
  assert.ok(confirm.indexOf('setPendingBookOff(null)') < confirm.indexOf('handleCheckOut(shiftId)'), 'the question is cleared before the Book Off is sent');
  const cancel = code.slice(code.indexOf('const cancelBookOff'), code.indexOf('const cancelBookOff') + 120);
  assert.ok(!cancel.includes('handleCheckOut'), 'Stay on shift sends nothing');
  assert.match(code, /<ConfirmationDialog\s+visible=\{pendingBookOff !== null\}\s+onClose=\{cancelBookOff\}\s+onConfirm=\{confirmBookOff\}/);
});

// ═══════════════════ Book On / Book Off wording ═══════════════════

test('BOFF-07-THE-GUARD-INTERFACE-SAYS-BOOK-ON-AND-BOOK-OFF', () => {
  const files = ['src/screens/GuardDashboardScreen.tsx', 'src/screens/GuardTimesheetsScreen.tsx']
    .concat(fs.readdirSync(path.join(ROOT, 'src/components/guard')).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `src/components/guard/${f}`));
  // User-facing string literals and JSX text only; API paths and stored values ('check-in') are not wording.
  const banned = /\b(check(ed)?[ -]?(in|out)|clock(ing)?[ -](in|out)|start shift|end shift|shift (started|ended))\b/i;
  for (const rel of files) {
    const code = codeOf(rel);
    const literals = [
      ...[...code.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]),
      ...[...code.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1]),
      ...[...code.matchAll(/`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1]),
      ...[...code.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]),
    ].filter((s) => /[a-z] [a-z]/i.test(s) || /^(Start|End) Shift$/.test(s));
    for (const s of literals) {
      if (/^\/|check-(in|out)$/.test(s)) continue;
      assert.ok(!banned.test(s), `${rel}: "${s}" should say Book On / Book Off`);
    }
  }
  const screen = codeOf(SCREEN);
  for (const label of ["'Book On'", "'Book Off'", "'Book On now'", "'Book On early'", "'Booked On'", "'Booked Off'", "'Book On failed'", "'Book Off failed'"]) {
    assert.ok(screen.includes(label), `${label} is used`);
  }
});

test('BOFF-08-API-NAMES-AND-STORED-VALUES-ARE-UNCHANGED', () => {
  const api = read('src/services/api.ts');
  assert.match(api, /\/attendance\/check-in/);
  assert.match(api, /\/attendance\/check-out/);
  const screen = codeOf(SCREEN);
  assert.match(screen, /checkInShift\(/, 'the same check-in call');
  assert.match(screen, /checkOutShift\(/, 'the same check-out call');
});

console.log(`\n${passed} guard Book Off checks passed`);
