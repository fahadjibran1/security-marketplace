#!/usr/bin/env node
/**
 * S4 Live Operations Phase 3: UK dates (DD-MM-YYYY), site-timezone correctness and the historical
 * timeline.
 *
 * Executes the real shared calendar (services/ukDate.ts), site-time module, timeline and report modules,
 * plus source checks for screen wiring that cannot run without a DOM. Every user-facing operational date
 * is DD-MM-YYYY; every value the app stores, filters on or sends stays ISO YYYY-MM-DD.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const uk = loadTs('src/services/ukDate.ts');
const ukLegacyPath = loadTs('src/components/company/ukDate.ts');
const site = loadTs('src/services/siteTime.ts');
const timeline = loadTs('src/components/company/operationsTimeline.ts');
const report = loadTs('src/components/company/operationsReport.ts');
const board = loadTs('src/components/company/liveOperationsBoard.ts');

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';
const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };

// ═══════════════════ 1. DD-MM-YYYY formatting and parsing ═══════════════════

test('UK-01-ISO-TO-DD-MM-YYYY-AND-BACK', () => {
  assert.equal(uk.isoToUkOperationalDate('2026-09-30'), '30-09-2026');
  assert.equal(uk.ukOperationalDateToIso('30-09-2026'), '2026-09-30');
  assert.equal(uk.ukOperationalDateToIso('1-1-2027'), '2027-01-01', 'single digits are normalised');
  assert.equal(uk.ukOperationalDateToIso(' 05-11-2026 '), '2026-11-05', 'surrounding space is trimmed');
  assert.equal(uk.ukOperationalDateToIso('05/11/2026'), '2026-11-05', 'a slash is accepted in place of the dash');
  for (const iso of ['2026-01-01', '2026-12-31', '2028-02-29', '2000-02-29']) {
    assert.equal(uk.ukOperationalDateToIso(uk.isoToUkOperationalDate(iso)), iso, `round trip ${iso}`);
  }
});

test('UK-02-IMPOSSIBLE-DATES-ARE-REFUSED-NEVER-ROLLED-OVER', () => {
  for (const bad of ['31-02-2026', '30-02-2026', '29-02-2025', '29-02-1900', '31-04-2026', '31-06-2026',
    '31-09-2026', '31-11-2026', '32-01-2026', '00-01-2026', '01-00-2026', '01-13-2026']) {
    assert.equal(uk.ukOperationalDateToIso(bad), null, `${bad} is not a real date`);
  }
  for (const iso of ['2026-02-31', '2025-02-29', '2026-04-31', '2026-13-01', '2026-00-10']) {
    assert.equal(uk.isIsoCalendarDate(iso), false, iso);
    assert.equal(uk.isoToUkOperationalDate(iso), null, `${iso} is never displayed as if real`);
    assert.equal(site.isSiteDateInput(iso), false, `siteTime refuses ${iso} too (it used to accept rollover)`);
  }
});

test('UK-03-JUNK-AND-AMBIGUOUS-FORMS-ARE-REFUSED', () => {
  for (const bad of ['', '   ', 'tomorrow', '2026-09-30', '30-09-26', '30.09.2026', '30-09/2026', '30--09-2026',
    '300-09-2026', '30-09-20266', null, undefined]) {
    assert.equal(uk.ukOperationalDateToIso(bad), null, JSON.stringify(bad));
  }
});

test('UK-04-LEAP-YEARS-ARE-CALCULATED', () => {
  assert.equal(uk.ukOperationalDateToIso('29-02-2028'), '2028-02-29', '2028 is a leap year');
  assert.equal(uk.ukOperationalDateToIso('29-02-2024'), '2024-02-29');
  assert.equal(uk.ukOperationalDateToIso('29-02-2000'), '2000-02-29', 'divisible by 400');
  assert.equal(uk.ukOperationalDateToIso('29-02-2100'), null, 'a century that is not');
  assert.equal(uk.ukOperationalDateToIso('29-02-2026'), null);
  assert.equal(site.isSiteDateInput('2028-02-29'), true);
});

test('UK-05-CLEAR-ERROR-MESSAGES', () => {
  assert.equal(uk.ukOperationalDateError(''), null, 'empty is the form\'s decision, not a date error');
  assert.equal(uk.ukOperationalDateError('30-09-2026'), null);
  assert.equal(uk.ukOperationalDateError('31-02-2026'), '31-02-2026 is not a real date: February 2026 has 28 days.');
  assert.equal(uk.ukOperationalDateError('29-02-2025'), '29-02-2025 is not a real date: February 2025 has 28 days.');
  assert.equal(uk.ukOperationalDateError('31-04-2026'), '31-04-2026 is not a real date: April 2026 has 30 days.');
  assert.equal(uk.ukOperationalDateError('10-13-2026'), 'The month must be between 01 and 12.');
  assert.equal(uk.ukOperationalDateError('2026-09-30'), 'Enter the date as DD-MM-YYYY, for example 30-09-2026.');
  assert.equal(uk.UK_OPERATIONAL_DATE_PLACEHOLDER, 'DD-MM-YYYY');
});

test('UK-06-ONE-CALENDAR-NOT-TWO', () => {
  // The Compliance spelling (DD/MM/YYYY) and the operational one agree on every date, because both are
  // the same day/month/year rule. Compliance still refuses the dash form, as its own spec requires.
  for (const [d, m, y] of [[31, 2, 2026], [29, 2, 2028], [29, 2, 2025], [31, 12, 2026], [1, 1, 2027], [31, 4, 2026]]) {
    const dd = String(d).padStart(2, '0'); const mm = String(m).padStart(2, '0');
    assert.equal(uk.ukDateToIso(`${dd}/${mm}/${y}`), uk.ukOperationalDateToIso(`${dd}-${mm}-${y}`), `${dd} ${mm} ${y}`);
  }
  assert.equal(uk.ukDateToIso('01-01-2028'), null, 'Compliance keeps DD/MM/YYYY only');
  assert.equal(stripComments(codeOf('src/components/company/ukDate.ts')).trim(), "export * from '../../services/ukDate';",
    'the old import path only re-exports the one module');
  assert.equal(ukLegacyPath.ukDateToIso('29/02/2028'), '2028-02-29');
  // No Date in the calendar module, and siteTime delegates its date-only validation to it.
  const src = stripComments(codeOf('src/services/ukDate.ts'));
  assert.doesNotMatch(src, /new Date\(|Date\.parse|toISOString|getTimezoneOffset/);
  const siteSrc = stripComments(codeOf('src/services/siteTime.ts'));
  assert.ok(siteSrc.includes('return isIsoCalendarDate(value);'), 'isSiteDateInput is the shared rule');
  assert.ok(siteSrc.includes("from './ukDate'"));
});

test('UK-07-WEEKDAYS-BY-ARITHMETIC-AGREE-WITH-INTL-FOR-EVERY-DAY', () => {
  // Every day from 2024 to 2029, against Intl in UTC (never the device's zone or locale).
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' });
  for (let t = Date.UTC(2024, 0, 1, 12); t < Date.UTC(2030, 0, 1); t += 86_400_000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    assert.equal(uk.isoWeekday(iso), fmt.format(new Date(t)), iso);
  }
  assert.equal(uk.formatUkOperationalDay('2026-10-13'), 'Tuesday 13-10-2026');
  assert.equal(uk.formatUkOperationalDay('2026-10-13', 'short'), 'Tue 13-10-2026');
  assert.equal(uk.isoWeekday('2026-02-31'), null);
});

// ═══════════════════ 2. site-local midnight, BST/GMT, overnight ═══════════════════

test('TZ-01-SITE-LOCAL-MIDNIGHT', () => {
  // 23:30Z on 29 Sep is 00:30 BST on the 30th in London and 19:30 on the 29th in New York.
  const instant = '2026-09-29T23:30:00.000Z';
  assert.equal(site.formatUkDate(instant, LONDON), '30-09-2026');
  assert.equal(site.formatUkDate(instant, NEW_YORK), '29-09-2026');
  assert.equal(site.formatUkDay(instant, LONDON), 'Wednesday 30-09-2026');
  assert.equal(site.siteToday(LONDON, new Date(instant)), '2026-09-30', 'Today at 00:30 BST is the 30th');
  assert.equal(new Date(instant).toISOString().slice(0, 10), '2026-09-29', 'which is exactly what UTC slicing got wrong');
});

test('TZ-02-THE-CLOCKS-GO-BACK', () => {
  // 25 Oct 2026: 02:00 BST -> 01:00 GMT.
  assert.equal(site.formatUkDate('2026-10-24T23:30:00.000Z', LONDON), '25-10-2026', '00:30 BST');
  assert.equal(site.formatUkDate('2026-10-25T00:30:00.000Z', LONDON), '25-10-2026', '01:30 BST (first)');
  assert.equal(site.formatUkDate('2026-10-25T01:30:00.000Z', LONDON), '25-10-2026', '01:30 GMT (repeated hour)');
  assert.equal(site.formatUkDate('2026-10-25T23:30:00.000Z', LONDON), '25-10-2026', '23:30 GMT, still the 25th');
  assert.equal(site.formatUkDate('2026-10-26T00:30:00.000Z', LONDON), '26-10-2026');
});

test('TZ-03-THE-CLOCKS-GO-FORWARD', () => {
  // 29 Mar 2026: 01:00 GMT -> 02:00 BST.
  assert.equal(site.formatUkDate('2026-03-28T23:30:00.000Z', LONDON), '28-03-2026', '23:30 GMT');
  assert.equal(site.formatUkDate('2026-03-29T00:30:00.000Z', LONDON), '29-03-2026', '00:30 GMT');
  assert.equal(site.formatUkDate('2026-03-29T23:30:00.000Z', LONDON), '30-03-2026', '00:30 BST next day');
});

test('TZ-04-OVERNIGHT-SHIFTS-STATE-BOTH-DATES-AND-BELONG-TO-THEIR-START', () => {
  assert.equal(
    site.formatUkRange('2026-09-30T19:00:00.000Z', '2026-10-01T07:00:00.000Z', LONDON),
    '30-09-2026 · 20:00 – 01-10-2026 · 08:00',
  );
  assert.equal(site.formatUkRange('2026-09-30T08:00:00.000Z', '2026-09-30T16:00:00.000Z', LONDON), '30-09-2026 · 09:00–17:00');
  // Start-day membership on the site's clock, the rule Live Operations and the Rota Planner now share.
  assert.equal(site.formatSiteDateInput('2026-09-30T19:00:00.000Z', LONDON), '2026-09-30');
});

test('TZ-05-SCREEN-NO-LONGER-SLICES-UTC-OR-ASKS-THE-DEVICE', () => {
  const screen = stripComments(codeOf('src/screens/CompanyDashboardScreen.tsx'));
  assert.ok(!screen.includes('shift.start.slice(0, 10)'), 'no shift is placed on its UTC date');
  assert.ok(!screen.includes('toLocaleDateString([]'), 'no week label in the device\'s locale');
  const today = screen.slice(screen.indexOf('function todayIsoDate()'), screen.indexOf('}', screen.indexOf('function todayIsoDate()')));
  assert.ok(today.includes('siteToday(DEFAULT_SITE_TIME_ZONE)'), 'todayIsoDate is the site\'s today');
  assert.ok(!today.includes('toISOString'), 'not the UTC date');
  const legacy = screen.slice(screen.indexOf('const legacyShiftsByDate = React.useMemo'), screen.indexOf('}, [shifts, plannerWeekDays, resolveSiteZone]);'));
  assert.ok(legacy.includes('formatSiteDateInput(shift.start, resolveSiteZone('), 'Rota places a shift on its site start day');
  assert.ok(legacy.includes('formatSiteTime(shift.start, zone)'), 'and reads its times on the site clock');
  const week = screen.slice(screen.indexOf('function buildWeekDays('), screen.indexOf('function normalizePlannerStatus('));
  assert.ok(week.includes("isoWeekday(iso, 'long')") && week.includes('isoToUkOperationalDate(iso)'), 'week labels from the shared calendar');
  const wc = screen.slice(screen.indexOf('function weekCommencingFor('), screen.indexOf('function buildWeekDays('));
  assert.ok(wc.includes('siteToday(DEFAULT_SITE_TIME_ZONE)'), 'the default week is the site\'s current week');
});

// ═══════════════════ 3. Today and the inputs ═══════════════════

test('TODAY-01-TODAY-SELECTS-THE-SITE-DATE-AND-THE-INPUT-SHOWS-IT', () => {
  const now = new Date('2026-09-29T23:30:00.000Z'); // 00:30 BST on the 30th
  const iso = site.siteToday(LONDON, now);
  assert.equal(iso, '2026-09-30');
  assert.equal(uk.isoToUkOperationalDate(iso), '30-09-2026', 'what the visible field shows');
  assert.equal(board.boardDateMode(iso, LONDON, now), 'today');
  const screen = codeOf('src/screens/CompanyDashboardScreen.tsx');
  const handler = screen.slice(screen.indexOf('const handleLiveOperationsToday'), screen.indexOf('}, [liveOperationsZone]);'));
  for (const step of ['date: siteToday(liveOperationsZone)', 'setTimelineRecentreSignal(', 'loadData(true)']) {
    assert.ok(handler.includes(step), step);
  }
  // The field follows a value set from outside (Today, the day arrows) — the effect re-derives the draft.
  const input = codeOf('src/components/company/NativeDateInput.tsx');
  assert.ok(/React\.useEffect\(\(\) => \{\s*const draftIso = /.test(input), 'the field re-syncs when the value changes');
  assert.ok(input.includes('if (draftIso !== value) setDraft(display(value));'));
});

test('TODAY-02-THE-DATE-FIELD-EMITS-ISO-OR-THE-REFUSED-TEXT-NEVER-A-STALE-DATE', () => {
  const input = stripComments(codeOf('src/components/company/NativeDateInput.tsx'));
  assert.ok(input.includes("onChange(trimmed ? ukOperationalDateToIso(trimmed) ?? trimmed : '');"));
  assert.ok(input.includes('ukOperationalDateError(draft)'), 'its message comes from the shared calendar');
  // Rota refuses that text with UK wording (it used to say YYYY-MM-DD).
  const rota = codeOf('src/components/company/CompanyRotaPlannerWorkspace.tsx');
  assert.ok(!rota.includes('(YYYY-MM-DD)'), 'no ISO wording left in the Rota Planner');
  assert.ok(rota.includes("'Enter a real date as DD-MM-YYYY.'"));
  // A refused value is never a board date: it falls back to the live view.
  assert.equal(board.effectiveBoardDate('31-02-2026'), '');
  assert.equal(board.effectiveBoardDate('2026-02-31'), '');
});

test('TODAY-03-LIVE-OPS-AND-ROTA-LABELS-ARE-DD-MM-YYYY', () => {
  const ws = stripComments(codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx'));
  assert.ok(!/formatInstantDate\(|formatInstantDateTime\(/.test(ws), 'Live Operations no longer prints "Tue, 29 Sep 2026"');
  assert.ok(ws.includes('formatUkRange(shift.start, shift.end, zone)'));
  const rota = stripComments(codeOf('src/components/company/CompanyRotaPlannerWorkspace.tsx'));
  assert.ok(rota.includes('return formatUkDay(iso, timeZone);'), 'slot dates read "Tuesday 29-09-2026"');
});

// ═══════════════════ 4. the historical timeline ═══════════════════

const NOW = Date.parse('2026-10-16T22:11:00.000Z');
const reconciliationRow = () => deepFreeze({
  shift: {
    id: 26, status: 'in_progress', start: '2026-10-13T19:00:00.000Z', end: '2026-10-14T05:00:00.000Z',
    siteName: 'Site', site: { id: 1, name: 'Site', timezone: LONDON }, guard: { fullName: 'Guard' },
  },
  attendance: { checkInAt: '2026-10-13T19:49:00.000Z', checkOutAt: null },
  operations: null,
});

test('HIST-01-A-RECONCILIATION-BAR-STOPS-AT-THE-SCHEDULED-END', () => {
  const row = reconciliationRow();
  assert.equal(timeline.effectiveShiftEndMs(row.shift, row.attendance, NOW), Date.parse(row.shift.end));
  const tuesday = timeline.resolveTimelineWindow(Date.parse('2026-10-13T11:00:00.000Z'), 24, LONDON);
  const groups = timeline.buildTimeline([row], tuesday, NOW);
  assert.equal(timeline.timelineRowCount(groups), 1, 'drawn on its own day');
  const drawn = groups[0].rows[0];
  assert.equal(drawn.status, 'Missing Book Off', 'clearly marked');
  assert.equal(drawn.attendance.bookOn, 'ON 20:49', 'the actual Book On time is kept (20:49 BST)');
  assert.equal(drawn.attendance.bookOff, 'OFF missing', 'and no Book Off time is shown');
  assert.ok(drawn.span.clippedEnd, 'the bar runs to the edge of a window that ends before 05:00 on the 14th');
  const friday = timeline.resolveTimelineWindow(NOW, 8, LONDON);
  assert.equal(timeline.timelineRowCount(timeline.buildTimeline([row], friday, NOW)), 0, 'and not stretched onto Friday');
});

test('HIST-02-AN-OVERDUE-BAR-UNDER-24-HOURS-STILL-RUNS-TO-NOW', () => {
  const row = { ...reconciliationRow(), shift: { ...reconciliationRow().shift, start: '2026-10-16T10:00:00.000Z', end: '2026-10-16T18:00:00.000Z' } };
  assert.equal(timeline.effectiveShiftEndMs(row.shift, { checkInAt: '2026-10-16T10:00:00.000Z', checkOutAt: null }, NOW), NOW);
  assert.equal(timeline.resolveTimelineStatus(row.shift, { checkInAt: 'x', checkOutAt: null }, NOW), 'No Book Off');
});

test('HIST-03-NOTHING-IS-FABRICATED-OR-MUTATED', () => {
  const row = reconciliationRow(); // frozen: any write by the modules would throw
  const tuesday = timeline.resolveTimelineWindow(Date.parse('2026-10-13T11:00:00.000Z'), 24, LONDON);
  timeline.buildTimeline([row], tuesday, NOW);
  const built = report.buildOperationsReport([row], { date: '2026-10-13', siteName: null });
  const summary = built.summary[0];
  assert.equal(summary[report.SUMMARY_COLUMNS.indexOf('Actual Book Off')], '', 'the export invents no Book Off');
  assert.equal(summary[report.SUMMARY_COLUMNS.indexOf('Actual Book On')], '20:49');
  assert.equal(row.attendance.checkOutAt, null);
  assert.equal(row.shift.status, 'in_progress', 'stored status untouched');
  for (const file of ['operationsTimeline.ts', 'liveOperationsBoard.ts', 'liveOperationsPolicy.ts']) {
    const src = stripComments(codeOf(`src/components/company/${file}`));
    assert.ok(!/services\/api|fetch\(|checkOut\(|updateShift/.test(src), `${file} makes no request or write`);
  }
});

test('HIST-04-NO-CROSS-COMPANY-ROWS', () => {
  // The timeline and the board only ever return the rows they were given — the company's own scoped
  // GET /shifts result. Two companies' rows in, each output row is one of the inputs and nothing else.
  const a = reconciliationRow();
  const b = deepFreeze({ ...reconciliationRow(), shift: { ...reconciliationRow().shift, id: 27 } });
  const tuesday = timeline.resolveTimelineWindow(Date.parse('2026-10-13T11:00:00.000Z'), 24, LONDON);
  const ids = timeline.buildTimeline([a], tuesday, NOW).flatMap((g) => g.rows.map((r) => r.shiftId));
  assert.deepEqual(ids, [26], 'only the row given is drawn');
  const sel = board.selectLiveBoard([a], (r) => ({ shift: r.shift, bookedOn: true, timeZone: LONDON }), { now: new Date(NOW), date: '', referenceZone: LONDON });
  assert.ok(!sel.reconciliation.includes(b), 'another company\'s row never appears unless it was in the input');
});

// ═══════════════════ 5. exports unchanged ═══════════════════

test('EXPORT-01-MACHINE-READABLE-EXPORT-FORMATS-ARE-UNCHANGED', () => {
  const row = reconciliationRow();
  const built = report.buildOperationsReport([row], { date: '2026-10-13', siteName: null });
  // The export's Date column keeps its existing "Tue, 13 Oct 2026" form, as separately agreed.
  assert.equal(built.summary[0][report.SUMMARY_COLUMNS.indexOf('Date')], 'Tue, 13 Oct 2026');
  assert.equal(built.summary[0][report.SUMMARY_COLUMNS.indexOf('Scheduled Start')], '20:00');
  const src = codeOf('src/components/company/operationsReport.ts');
  assert.ok(src.includes('date: formatInstantDate(input.shift.start, tz),'), 'the report still uses its own formatter');
});

console.log(`\n${passed} UK operational date checks passed`);
