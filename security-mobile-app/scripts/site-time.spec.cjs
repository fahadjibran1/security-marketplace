#!/usr/bin/env node
/**
 * Scheduled times are TRUE INSTANTS — TZ-01 … TZ-18 plus the UAT Round 1 regressions. (Phase 1.)
 *
 * WHAT WENT WRONG
 * The Rota Planner sent "2026-09-29T11:30:00" with no offset. The server resolved it with `new Date(...)`,
 * which treats an offset-less date-time as LOCAL; running in UTC it became 11:30Z and was stored as 11:30.
 * The Company screen read it back forcing timeZone:'UTC', so the digits round-tripped and looked right —
 * but every consumer that treats a shift start as a real moment was an hour out during BST:
 *   - a guard booking on at 11:29 site time was told "1 hr 1 min early";
 *   - the welfare engine believed a live shift had not started, so no check calls existed;
 *   - timesheet variance gained a phantom hour.
 *
 * These tests execute the real conversion module, so they fail if the offset handling regresses. There is
 * no UK-specific arithmetic anywhere in it: "subtract one hour" is wrong in winter, wrong for every
 * non-UK site, and wrong on the two transition days.
 */
const assert = require('node:assert/strict');
const { loadTs } = require('./load-ts.cjs');

const siteTime = loadTs('src/services/siteTime.ts');
const {
  DEFAULT_SITE_TIME_ZONE,
  AMBIGUOUS_POLICY,
  zoneOffsetMs,
  offsetSuffix,
  siteLocalToInstant,
  siteLocalEndToInstant,
  formatSiteTime,
  formatSiteDateInput,
  formatSiteDateLong,
  formatInstantTime,
  formatInstantDate,
  formatInstantDateTime,
  resolveDisplayZone,
  deviceTimeZone,
  siteMidnight,
} = siteTime;

const LONDON = 'Europe/London';
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

/** The instant a resolution refers to, as a UTC ISO string — what actually reaches the database. */
function utcOf(resolution) {
  assert.equal(resolution.ok, true, `expected a resolvable time, got: ${resolution.message || ''}`);
  return new Date(resolution.instant).toISOString();
}

console.log('\nTZ-01 … TZ-18  scheduled times are true instants\n');

// ── Core conversion, summer and winter ───────────────────────────────────────────────────────────

test('TZ-01  BST: 11:30 on 29 Sep 2026 at a London site is 10:30Z, tagged +01:00', () => {
  const resolved = siteLocalToInstant('2026-09-29', '11:30', LONDON);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.iso, '2026-09-29T11:30:00+01:00');
  assert.equal(utcOf(resolved), '2026-09-29T10:30:00.000Z');
  assert.equal(resolved.offsetMs, 3600000);
  assert.equal(resolved.ambiguous, false);
});

test('TZ-02  GMT: 11:30 on 15 Dec 2026 at a London site is 11:30Z, tagged Z', () => {
  const resolved = siteLocalToInstant('2026-12-15', '11:30', LONDON);
  assert.equal(resolved.iso, '2026-12-15T11:30:00Z');
  assert.equal(utcOf(resolved), '2026-12-15T11:30:00.000Z');
  assert.equal(resolved.offsetMs, 0);
});

test('TZ-03  the same wall clock in the two seasons is NOT the same instant', () => {
  const summer = utcOf(siteLocalToInstant('2026-07-01', '09:00', LONDON));
  const winter = utcOf(siteLocalToInstant('2026-01-01', '09:00', LONDON));
  assert.equal(summer, '2026-07-01T08:00:00.000Z');
  assert.equal(winter, '2026-01-01T09:00:00.000Z');
  assert.notEqual(summer.slice(11, 16), winter.slice(11, 16));
});

test('TZ-04  no fixed offset is assumed anywhere: the zone decides', () => {
  // A literal "+01:00" everywhere, or a "subtract an hour" rule, would break one of these two.
  assert.equal(offsetSuffix(zoneOffsetMs(new Date('2026-07-01T12:00:00Z'), LONDON)), '+01:00');
  assert.equal(offsetSuffix(zoneOffsetMs(new Date('2026-01-01T12:00:00Z'), LONDON)), 'Z');
});

// ── Clock changes ────────────────────────────────────────────────────────────────────────────────

test('TZ-05  spring forward: 01:30 on 29 Mar 2026 does not exist and is REJECTED', () => {
  const resolved = siteLocalToInstant('2026-03-29', '01:30', LONDON);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'nonexistent');
  assert.match(resolved.message, /clocks go forward/i);
});

test('TZ-06  spring forward: the hour either side still resolves normally', () => {
  assert.equal(utcOf(siteLocalToInstant('2026-03-29', '00:30', LONDON)), '2026-03-29T00:30:00.000Z');
  assert.equal(utcOf(siteLocalToInstant('2026-03-29', '02:30', LONDON)), '2026-03-29T01:30:00.000Z');
});

test('TZ-07  fall back: 01:30 on 25 Oct 2026 happens twice; the EARLIER one is chosen', () => {
  const resolved = siteLocalToInstant('2026-10-25', '01:30', LONDON);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ambiguous, true);
  assert.equal(resolved.offsetMs, 3600000, 'earliest occurrence is still on summer time');
  assert.equal(utcOf(resolved), '2026-10-25T00:30:00.000Z');
  assert.equal(AMBIGUOUS_POLICY, 'earliest-occurrence');
});

test('TZ-08  the ambiguous choice is deterministic — same input, same instant', () => {
  const a = siteLocalToInstant('2026-10-25', '01:30', LONDON);
  const b = siteLocalToInstant('2026-10-25', '01:30', LONDON);
  assert.equal(a.instant, b.instant);
});

test('TZ-09  an unambiguous time is not flagged ambiguous', () => {
  assert.equal(siteLocalToInstant('2026-09-29', '11:30', LONDON).ambiguous, false);
});

// ── Overnight shifts and transition nights ───────────────────────────────────────────────────────

test('TZ-10  overnight in BST: 22:00–06:00 is 8 hours', () => {
  const start = siteLocalToInstant('2026-09-29', '22:00', LONDON);
  const end = siteLocalEndToInstant('2026-09-29', '22:00', '06:00', LONDON);
  assert.equal(utcOf(start), '2026-09-29T21:00:00.000Z');
  assert.equal(utcOf(end), '2026-09-30T05:00:00.000Z');
  assert.equal((end.instant - start.instant) / 3600000, 8);
});

test('TZ-11  overnight in GMT: 22:00–06:00 is 8 hours', () => {
  const start = siteLocalToInstant('2026-12-15', '22:00', LONDON);
  const end = siteLocalEndToInstant('2026-12-15', '22:00', '06:00', LONDON);
  assert.equal(utcOf(start), '2026-12-15T22:00:00.000Z');
  assert.equal(utcOf(end), '2026-12-16T06:00:00.000Z');
  assert.equal((end.instant - start.instant) / 3600000, 8);
});

test('TZ-12  the night the clocks go back, 22:00–06:00 is really 9 hours', () => {
  // 24→25 Oct 2026. A guard on this shift works nine hours and must be paid for nine. Adding 24 hours to
  // an instant, or trusting the wall-clock difference, would report eight.
  const start = siteLocalToInstant('2026-10-24', '22:00', LONDON);
  const end = siteLocalEndToInstant('2026-10-24', '22:00', '06:00', LONDON);
  assert.equal(utcOf(start), '2026-10-24T21:00:00.000Z');
  assert.equal(utcOf(end), '2026-10-25T06:00:00.000Z');
  assert.equal((end.instant - start.instant) / 3600000, 9);
});

test('TZ-13  the night the clocks go forward, 22:00–06:00 is really 7 hours', () => {
  // 28→29 Mar 2026. The end day is advanced on the CALENDAR, so the skipped hour is genuinely skipped.
  const start = siteLocalToInstant('2026-03-28', '22:00', LONDON);
  const end = siteLocalEndToInstant('2026-03-28', '22:00', '06:00', LONDON);
  assert.equal(utcOf(start), '2026-03-28T22:00:00.000Z');
  assert.equal(utcOf(end), '2026-03-29T05:00:00.000Z');
  assert.equal((end.instant - start.instant) / 3600000, 7);
});

test('TZ-14  an end time equal to the start rolls to the next day, not to zero length', () => {
  const start = siteLocalToInstant('2026-09-29', '08:00', LONDON);
  const end = siteLocalEndToInstant('2026-09-29', '08:00', '08:00', LONDON);
  assert.equal((end.instant - start.instant) / 3600000, 24);
});

// ── Other zones: the site decides, never the operator's device ────────────────────────────────────

test('TZ-15  a Dubai site: 11:30 is +04:00, i.e. 07:30Z', () => {
  const resolved = siteLocalToInstant('2026-09-29', '11:30', 'Asia/Dubai');
  assert.equal(resolved.iso, '2026-09-29T11:30:00+04:00');
  assert.equal(utcOf(resolved), '2026-09-29T07:30:00.000Z');
});

test('TZ-16  a New York site: 11:30 is -04:00, i.e. 15:30Z', () => {
  const resolved = siteLocalToInstant('2026-09-29', '11:30', 'America/New_York');
  assert.equal(resolved.iso, '2026-09-29T11:30:00-04:00');
  assert.equal(utcOf(resolved), '2026-09-29T15:30:00.000Z');
});

test('TZ-17  the same wall clock at three sites is three different instants', () => {
  const london = utcOf(siteLocalToInstant('2026-09-29', '11:30', LONDON));
  const dubai = utcOf(siteLocalToInstant('2026-09-29', '11:30', 'Asia/Dubai'));
  const newYork = utcOf(siteLocalToInstant('2026-09-29', '11:30', 'America/New_York'));
  assert.equal(new Set([london, dubai, newYork]).size, 3);
});

test('TZ-18  display returns the site clock, from either an offset ISO or the equivalent Z', () => {
  // The whole point: 10:30Z at a BST London site reads "11:30", and so does the +01:00 form of it.
  assert.equal(formatSiteTime('2026-09-29T10:30:00.000Z', LONDON), '11:30');
  assert.equal(formatSiteTime('2026-09-29T11:30:00+01:00', LONDON), '11:30');
  assert.equal(formatSiteTime('2026-12-15T11:30:00.000Z', LONDON), '11:30');
  // The same instant at a Dubai site is a different clock reading, which is the honest answer.
  assert.equal(formatSiteTime('2026-09-29T10:30:00.000Z', 'Asia/Dubai'), '14:30');
});

// ── The reported UAT defects ─────────────────────────────────────────────────────────────────────

console.log('\nUAT Round 1 regressions\n');

test('REG-1  one minute early is reported as one minute, not 1 hr 1 min', () => {
  // The exact reported case: 29 Sep 2026, London site, shift scheduled 11:30, guard taps Book On at 11:29.
  const scheduled = siteLocalToInstant('2026-09-29', '11:30', LONDON);
  const deviceTaps = siteLocalToInstant('2026-09-29', '11:29', LONDON);
  const minutesEarly = (scheduled.instant - deviceTaps.instant) / 60000;
  assert.equal(minutesEarly, 1, 'a phantom hour here is the whole defect');
});

test('REG-2  under the old naive convention the same case WAS an hour out', () => {
  // Negative control: this reproduces the defect, so a regression cannot pass unnoticed.
  const naiveStored = new Date('2026-09-29T11:30:00Z'); // what the server used to store
  const deviceTaps = new Date(siteLocalToInstant('2026-09-29', '11:29', LONDON).instant);
  const minutesEarly = (naiveStored.getTime() - deviceTaps.getTime()) / 60000;
  assert.equal(minutesEarly, 61, 'the old behaviour must still be demonstrably wrong');
});

test('REG-3  welfare windows anchored to the corrected start are live immediately (BST)', () => {
  // A 60-minute check-call interval on an 11:30 BST shift: the first two windows are 10:30–11:30Z and
  // 11:30–12:30Z. Before the fix the server thought the shift began at 11:30Z, so at 11:35 BST (10:35Z)
  // nothing was applicable and no check call existed — a live guard with no welfare monitoring.
  const start = siteLocalToInstant('2026-09-29', '11:30', LONDON).instant;
  const windows = [0, 1].map((index) => ({
    start: new Date(start + index * 3600000).toISOString(),
    end: new Date(start + (index + 1) * 3600000).toISOString(),
  }));
  assert.equal(windows[0].start, '2026-09-29T10:30:00.000Z');
  assert.equal(windows[0].end, '2026-09-29T11:30:00.000Z');
  assert.equal(windows[1].start, '2026-09-29T11:30:00.000Z');
  assert.equal(windows[1].end, '2026-09-29T12:30:00.000Z');

  // Book On at 11:35 site time falls inside the first window.
  const bookOn = siteLocalToInstant('2026-09-29', '11:35', LONDON).instant;
  const first = windows[0];
  assert.ok(
    new Date(first.end).getTime() > bookOn && new Date(first.start).getTime() <= bookOn,
    'the first welfare window must already be active when the guard books on',
  );
});

test('REG-4  the same welfare check holds in GMT, where the offset is zero', () => {
  const start = siteLocalToInstant('2026-12-15', '11:30', LONDON).instant;
  assert.equal(new Date(start).toISOString(), '2026-12-15T11:30:00.000Z');
  const bookOn = siteLocalToInstant('2026-12-15', '11:35', LONDON).instant;
  assert.ok(bookOn > start && bookOn - start === 5 * 60000);
});

test('REG-5  a 2-hour scheduled shift is 120 minutes, with no phantom hour (BST)', () => {
  const start = siteLocalToInstant('2026-09-29', '11:30', LONDON);
  const end = siteLocalEndToInstant('2026-09-29', '11:30', '13:30', LONDON);
  assert.equal((end.instant - start.instant) / 60000, 120);
  // And the operator still reads back exactly what they typed.
  assert.equal(formatSiteTime(new Date(start.instant).toISOString(), LONDON), '11:30');
  assert.equal(formatSiteTime(new Date(end.instant).toISOString(), LONDON), '13:30');
});

test('REG-6  the round trip preserves the operator input in both seasons', () => {
  for (const [date, time] of [['2026-09-29', '11:30'], ['2026-12-15', '11:30'], ['2026-06-01', '23:45']]) {
    const resolved = siteLocalToInstant(date, time, LONDON);
    const iso = new Date(resolved.instant).toISOString();
    assert.equal(formatSiteDateInput(iso, LONDON), date, `${date} ${time}`);
    assert.equal(formatSiteTime(iso, LONDON), time, `${date} ${time}`);
  }
});

// ── Guard rails on the helpers themselves ────────────────────────────────────────────────────────

console.log('\nhelper contracts\n');

test('bad input is rejected rather than coerced', () => {
  for (const [date, time] of [['', '11:30'], ['2026-13-01', '11:30'], ['2026-09-29', '25:00'], ['29/09/2026', '11:30'], ['2026-09-29', '1130']]) {
    const resolved = siteLocalToInstant(date, time, LONDON);
    assert.equal(resolved.ok, false, `${date} ${time} should not resolve`);
    assert.equal(resolved.reason, 'invalid');
  }
});

test('the form-field validators accept real inputs and reject the rest', () => {
  // These gate the conversion in the Rota Planner: if they always return false the operator cannot save a
  // shift at all, and if they always return true a malformed value reaches the API. Both matter, so both
  // directions are asserted here rather than the validators being trusted to look right.
  for (const good of ['2026-09-29', '2026-12-15', '2026-02-28']) {
    assert.equal(siteTime.isSiteDateInput(good), true, `${good} is a real date`);
  }
  for (const bad of ['', '29/09/2026', '2026-9-9', '2026-13-01', '2026-09-32', 'tomorrow', '2026-09-29T11:30']) {
    assert.equal(siteTime.isSiteDateInput(bad), false, `${bad} is not a date input`);
  }
  for (const good of ['00:00', '09:30', '11:30', '23:59']) {
    assert.equal(siteTime.isSiteTimeInput(good), true, `${good} is a real time`);
  }
  for (const bad of ['', '9:30', '24:00', '23:60', '1130', '11:3', '11:30:00']) {
    assert.equal(siteTime.isSiteTimeInput(bad), false, `${bad} is not a time input`);
  }
});

test('the Rota Planner uses those validators rather than its own copies', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT: root } = require('./load-ts.cjs');
  const planner = fs.readFileSync(
    path.join(root, 'src/components/company/CompanyRotaPlannerWorkspace.tsx'),
    'utf8',
  );
  assert.match(planner, /const isValidDate = isSiteDateInput;/);
  assert.match(planner, /const isValidTime = isSiteTimeInput;/);
});

test('offsetSuffix formats zero as Z and never as +00:00', () => {
  assert.equal(offsetSuffix(0), 'Z');
  assert.equal(offsetSuffix(3600000), '+01:00');
  assert.equal(offsetSuffix(-4 * 3600000), '-04:00');
  assert.equal(offsetSuffix(5.5 * 3600000), '+05:30');
});

test('the display helpers never fall back to reading digits out of the string', () => {
  // 10:30Z must NOT read "10:30" in London during BST. That literal convention is the defect.
  assert.notEqual(formatInstantTime('2026-09-29T10:30:00.000Z', LONDON), '10:30');
  assert.equal(formatInstantTime('2026-09-29T10:30:00.000Z', LONDON), '11:30');
  // Whatever en-GB spells the month as, the DAY and the TIME must be the site's.
  assert.match(formatInstantDate('2026-09-29T10:30:00.000Z', LONDON), /^Tue, 29 Sept? 2026$/);
  assert.match(
    formatInstantDateTime('2026-09-29T10:30:00.000Z', LONDON),
    /^Tue, 29 Sept? 2026 · 11:30$/,
  );
});

test('a late-evening instant is dated by the SITE day, not the UTC day', () => {
  // 23:30 BST on 29 Sep is 22:30Z the same day; 00:30 BST on 30 Sep is 23:30Z on the 29th. The second one
  // is where a UTC-day reading would print the wrong date.
  assert.match(formatInstantDate('2026-09-29T23:30:00.000Z', LONDON), /^Wed, 30 Sept? 2026$/);
  assert.equal(formatInstantTime('2026-09-29T23:30:00.000Z', LONDON), '00:30');
});

test('an explicit site zone beats the device zone', () => {
  assert.equal(resolveDisplayZone('Asia/Dubai'), 'Asia/Dubai');
  assert.equal(resolveDisplayZone(null), deviceTimeZone());
  assert.equal(resolveDisplayZone(undefined), deviceTimeZone());
  assert.equal(resolveDisplayZone(''), deviceTimeZone());
});

test('empty values render as a placeholder, not as "Invalid Date"', () => {
  assert.equal(formatInstantTime(null, LONDON), '—');
  assert.equal(formatInstantDate(undefined, LONDON), '—');
  assert.equal(formatInstantTime(null, LONDON, 'TBC'), 'TBC');
  assert.equal(formatSiteTime(null, LONDON), '—');
});

test('site midnight is a real instant on the site calendar day', () => {
  assert.equal(siteMidnight(2026, 9, 29, LONDON).toISOString(), '2026-09-28T23:00:00.000Z');
  assert.equal(siteMidnight(2026, 12, 15, LONDON).toISOString(), '2026-12-15T00:00:00.000Z');
});

test('the long date label is rendered in the site zone', () => {
  assert.match(formatSiteDateLong('2026-09-29T10:30:00.000Z', LONDON), /^Tuesday,? 29 September$/);
  // 23:30Z on 29 Sep is already the 30th in Dubai.
  assert.match(
    formatSiteDateLong('2026-09-29T23:30:00.000Z', 'Asia/Dubai'),
    /^Wednesday,? 30 September$/,
  );
});

test('the platform default site zone is Europe/London', () => {
  assert.equal(DEFAULT_SITE_TIME_ZONE, 'Europe/London');
});

// ── No naive scheduled-time write path may remain ────────────────────────────────────────────────

console.log('\nno naive scheduled-time write path remains\n');

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./load-ts.cjs');

/** Every .ts/.tsx under src, excluding the local-only dev scratch directory. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'dev') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}

/** Source with comments and JSX text stripped, so assertions are about code and not about prose. */
function codeOf(file) {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

test('nothing builds an offset-less ISO date-time for a scheduled time', () => {
  // Matches a template literal that ends a date-time with seconds and no offset, e.g. `${date}T${time}:00`.
  const naive = /`\$\{[^`]*\}T\$\{[^`]*\}:00`/;
  const offenders = sourceFiles().filter((file) => naive.test(codeOf(file)));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
});

test('the fake-UTC display convention is gone', () => {
  const offenders = sourceFiles().filter((file) => /timeZone:\s*['"]UTC['"]/.test(codeOf(file)));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
});

test('no screen reads the hour and minute literally out of an ISO string', () => {
  const offenders = sourceFiles().filter((file) => /getLiteralDateTimeParts/.test(codeOf(file)));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
});

test('the Rota Planner sends the converted instants, not the raw form fields', () => {
  const planner = codeOf(path.join(ROOT, 'src/components/company/CompanyRotaPlannerWorkspace.tsx'));
  // Create and Edit both go through the conversion…
  assert.match(planner, /createStartAt = siteLocalToInstant\(/);
  assert.match(planner, /createEndAt = siteLocalEndToInstant\(/);
  assert.match(planner, /startAt = siteLocalToInstant\(/);
  assert.match(planner, /endAt = siteLocalEndToInstant\(/);
  // …and what is written is the resolution's iso, never the input strings.
  assert.match(planner, /startAt: createStartAt\.iso/);
  assert.match(planner, /endAt: createEndAt\.iso/);
  assert.match(planner, /changes\.startAt\s*=\s*startAt\.iso/);
  assert.match(planner, /changes\.endAt\s*=\s*endAt\.iso/);
});

test('the Rota Planner resolves the zone from the site, never from the device', () => {
  const planner = codeOf(path.join(ROOT, 'src/components/company/CompanyRotaPlannerWorkspace.tsx'));

  // Every zone local in this file must be derived from the site — either the resolver prop or the already
  // resolved zone of the open slot. A device zone or a hard-coded string would break a manager abroad.
  const zoneLocals = new Map(
    [...planner.matchAll(/const (\w*[Zz]one\w*) = ([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
  assert.ok(zoneLocals.size >= 3, `expected the zone locals, found ${[...zoneLocals.keys()]}`);
  for (const [name, source] of zoneLocals) {
    assert.match(
      source,
      /resolveSiteZone\(|slotDetailZone/,
      `${name} must come from the site, not from ${source}`,
    );
  }

  // …and every conversion call must be handed one of those locals as its zone.
  const calls = planner.match(/siteLocal(?:End)?ToInstant\([^)]*\)/g) || [];
  assert.ok(calls.length >= 4, `expected the create and edit conversions, found ${calls.length}`);
  for (const call of calls) {
    const zoneArgument = call.replace(/\)$/, '').split(',').pop().trim();
    assert.ok(
      zoneLocals.has(zoneArgument),
      `conversion must take a site-derived zone, got "${zoneArgument}" in ${call}`,
    );
  }

  const dashboard = codeOf(path.join(ROOT, 'src/screens/CompanyDashboardScreen.tsx'));
  assert.match(dashboard, /site\.timezone \|\| DEFAULT_SITE_TIME_ZONE/);
  assert.match(dashboard, /resolveSiteZone=\{resolveSiteZone\}/);
});

// ── Result ──────────────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAILED: ${failure.name}`);
    console.error(failure.error.stack || failure.error.message);
  }
  process.exit(1);
}
