#!/usr/bin/env node
/**
 * Shift Offers show the site's clock. (Phase 3B, closing TECH-DEBT-TIME-03.)
 *
 * WHAT WAS WRONG
 * Phase 3A-i corrected Live Operations and, while sweeping for the same defect, found it again in both
 * Shift Offers surfaces. Each had its own copy of the formatters and each read the clock digits straight
 * out of the stored string:
 *
 *   Guard   — a regex captured `hour` and `minute` and printed them; overnight compared `slice(0, 10)`.
 *   Company — `fmtTime` matched /[T\s](\d{2}):(\d{2})/ and printed the capture; `fmtDate` used the
 *             DEVICE's zone; `weekCommencingFor` used `getDay`/`setDate` (device) then `toISOString`
 *             (UTC) for the result.
 *
 * All of that was correct while the backend stored a local wall clock, and wrong from the moment Phase 1
 * corrected those columns to true instants. The digits are now UTC, so a 00:30 BST shift stored as 23:30Z
 * was offered as "23:30" on the previous day — a Guard reading the offer would turn up a day early.
 *
 * WHAT THIS SUITE EXECUTES
 * The one shared module both surfaces now call, with real instants across a real DST boundary. The
 * assertions are values, not source text, because the logic was extracted specifically so it could be run.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const offerTime = loadTs('src/components/shifts/shiftOfferTime.ts');
const {
  shiftZone,
  formatOfferDate,
  formatOfferTime,
  formatOfferWindow,
  isOvernightOffer,
  weekCommencingForOffer,
} = offerTime;

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';

// ─── The reported defect ──────────────────────────────────────────────────────

test('OFFER-01-A-MIDNIGHT-BST-SHIFT-IS-NOT-OFFERED-AS-THE-PREVIOUS-EVENING', () => {
  // The exact case. 00:30 on 1 July at a London site is stored as 23:30Z on 30 June. Printing the stored
  // digits gave "23:30" and the 30th; the site's clock says 00:30 on the 1st.
  const start = '2026-06-30T23:30:00.000Z';
  assert.equal(formatOfferTime(start, LONDON), '00:30');
  assert.match(formatOfferDate(start, LONDON), /1 Jul|01 Jul/);
  // And what the old code would have printed is NOT what we print now.
  assert.notEqual(formatOfferTime(start, LONDON), start.slice(11, 16));
});

test('OFFER-02-BST-AND-GMT-BOTH-READ-CORRECTLY', () => {
  // Summer: one hour ahead of UTC.
  assert.equal(formatOfferTime('2026-07-15T18:00:00.000Z', LONDON), '19:00');
  // Winter: the same as UTC. A fix that just added an hour everywhere would fail here.
  assert.equal(formatOfferTime('2026-01-15T18:00:00.000Z', LONDON), '18:00');
});

test('OFFER-03-A-SITE-IN-ANOTHER-ZONE-READS-ITS-OWN-CLOCK', () => {
  const instant = '2026-07-15T18:00:00.000Z';
  assert.equal(formatOfferTime(instant, LONDON), '19:00');
  assert.equal(formatOfferTime(instant, NEW_YORK), '14:00');
});

// ─── Overnight marker ─────────────────────────────────────────────────────────

test('OFFER-04-OVERNIGHT-IS-DECIDED-ON-THE-SITES-CALENDAR-DAYS', () => {
  // 20:00 to 04:00 London on 15 July: stored 19:00Z to 03:00Z. Overnight on both clocks.
  assert.equal(isOvernightOffer('2026-07-15T19:00:00.000Z', '2026-07-16T03:00:00.000Z', LONDON), true);
  // 08:00 to 16:00 London: one site day.
  assert.equal(isOvernightOffer('2026-07-15T07:00:00.000Z', '2026-07-15T15:00:00.000Z', LONDON), false);
});

test('OFFER-05-THE-UTC-MIDNIGHT-TRAP', () => {
  // 21:00 to 23:30 BST on 15 July is stored as 20:00Z–22:30Z: one day either way, nothing interesting.
  // But 23:30 to 01:00 BST is stored 22:30Z–00:00Z, and a UTC comparison sees a day change while the
  // site sees... a day change too. The trap is the other direction: 00:15–07:00 BST on the 16th is
  // stored 23:15Z on the 15th to 06:00Z on the 16th. UTC says overnight; the SITE says one day.
  const start = '2026-07-15T23:15:00.000Z';
  const end = '2026-07-16T06:00:00.000Z';
  assert.equal(start.slice(0, 10) !== end.slice(0, 10), true, 'the stored digits do change day');
  assert.equal(isOvernightOffer(start, end, LONDON), false, 'but the site works one continuous day');
  assert.equal(formatOfferWindow(start, end, LONDON), '00:15–07:00', 'so no (+1) marker');
});

test('OFFER-06-THE-WINDOW-CARRIES-THE-MARKER-WHEN-IT-SHOULD', () => {
  assert.equal(
    formatOfferWindow('2026-07-15T19:00:00.000Z', '2026-07-16T03:00:00.000Z', LONDON),
    '20:00–04:00 (+1)',
  );
  // The Guard surface uses its own separator and placeholder; both come through the same function.
  assert.equal(
    formatOfferWindow('2026-07-15T19:00:00.000Z', '2026-07-16T03:00:00.000Z', LONDON, { separator: ' – ' }),
    '20:00 – 04:00 (+1)',
  );
  assert.equal(formatOfferWindow(null, null, LONDON, { empty: 'TBC' }), 'TBC–TBC');
});

// ─── The Rota week an offer opens ─────────────────────────────────────────────

test('OFFER-07-A-LATE-SUNDAY-SHIFT-OPENS-THE-RIGHT-ROTA-WEEK', () => {
  // Sunday 5 July 2026, 23:30 London = 22:30Z the same day. Its week commences Monday 29 June.
  assert.equal(weekCommencingForOffer('2026-07-05T22:30:00.000Z', LONDON), '2026-06-29');
  // Monday 6 July 00:30 London = 23:30Z on Sunday the 5th. A UTC date would call this Sunday and open
  // the PREVIOUS week; the site says Monday, so the week commences that same Monday.
  assert.equal(weekCommencingForOffer('2026-07-05T23:30:00.000Z', LONDON), '2026-07-06');
});

test('OFFER-08-MID-WEEK-AND-MONDAY-ITSELF', () => {
  assert.equal(weekCommencingForOffer('2026-07-08T10:00:00.000Z', LONDON), '2026-07-06', 'Wednesday');
  assert.equal(weekCommencingForOffer('2026-07-06T10:00:00.000Z', LONDON), '2026-07-06', 'Monday maps to itself');
  assert.equal(weekCommencingForOffer('2026-07-12T10:00:00.000Z', LONDON), '2026-07-06', 'Sunday closes the week');
});

test('OFFER-09-THE-WEEK-IS-THE-SITES-WEEK-NOT-THE-DEVICES', () => {
  // One instant, two sites. 03:00Z on Monday 6 July is Monday in London and Sunday evening in New York.
  const instant = '2026-07-06T03:00:00.000Z';
  assert.equal(weekCommencingForOffer(instant, LONDON), '2026-07-06');
  assert.equal(weekCommencingForOffer(instant, NEW_YORK), '2026-06-29');
});

// ─── Zone resolution and degenerate input ─────────────────────────────────────

test('OFFER-10-THE-SITES-ZONE-WINS-AND-THERE-IS-ALWAYS-A-FALLBACK', () => {
  assert.equal(shiftZone({ site: { timezone: NEW_YORK } }), NEW_YORK);
  assert.equal(shiftZone({ site: { timezone: null } }), LONDON, 'a site with no zone falls back');
  assert.equal(shiftZone({ site: null }), LONDON);
  assert.equal(shiftZone(null), LONDON);
  assert.equal(shiftZone(undefined), LONDON);
  assert.equal(shiftZone({ site: { timezone: '' } }), LONDON, 'an empty string is not a zone');
});

test('OFFER-11-MISSING-AND-MALFORMED-VALUES-DEGRADE-QUIETLY', () => {
  assert.equal(formatOfferTime(null, LONDON), '—');
  assert.equal(formatOfferDate(undefined, LONDON), '—');
  assert.equal(formatOfferTime(null, LONDON, 'TBC'), 'TBC');
  assert.equal(isOvernightOffer(null, '2026-07-16T03:00:00.000Z', LONDON), false);
  assert.equal(isOvernightOffer('2026-07-15T19:00:00.000Z', undefined, LONDON), false);
  assert.equal(weekCommencingForOffer('not a date', LONDON), '');
});

// ─── One copy, and both surfaces use it ───────────────────────────────────────

test('OFFER-12-NEITHER-SURFACE-KEEPS-ITS-OWN-COPY', () => {
  const guard = stripComments(codeOf('src/components/guard/GuardShiftOffersWorkspace.tsx'));
  const company = stripComments(codeOf('src/components/company/CompanyShiftOffersWorkspace.tsx'));

  for (const [name, src] of [['guard', guard], ['company', company]]) {
    assert.ok(src.includes("from '../shifts/shiftOfferTime'"), `${name} imports the shared module`);
    // The specific patterns that produced the defect, in either file.
    for (const banned of [
      'slice(0, 10)',
      'slice(0,10)',
      'getLiteralParts',
      'toLocaleTimeString',
      'toLocaleDateString',
      'getHours()',
      'getMinutes()',
      'toISOString().slice',
      '.getDay()',
    ]) {
      assert.ok(!src.includes(banned), `${name} must not use ${banned} for a scheduled time`);
    }
  }
});

test('OFFER-13-THE-SHARED-MODULE-IS-PURE', () => {
  // It has to be, or none of the above could have been executed. The loader refuses react-native, so a
  // regression here fails loudly rather than quietly becoming untestable again.
  const src = codeOf('src/components/shifts/shiftOfferTime.ts');
  assert.ok(!src.includes("from 'react"), 'no react or react-native import');
  assert.ok(src.includes("from '../../services/siteTime'"), 'it delegates to the shared time module');
});

console.log(`\n${passed} shift offer time checks passed`);
