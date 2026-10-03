#!/usr/bin/env node
/**
 * UAT FIX 02 — the Daily Site Log's day boundary.
 *
 * Production asked for the 30-09-2026 Daily Site Log for "test site" and got, inside the same
 * chronological occurrence stream:
 *
 *     21:19  Welfare Check          ← genuinely 30-09
 *     16:46  Welfare Check          ← actually 02-10-2026
 *     17:25  Incident #4 resolved   ← actually 02-10-2026
 *
 * `buildDailySiteLog` filtered incidents, alerts and logs by shiftId, which answers "does this
 * belong to a shift that touched the day" — not "did this happen on the day". Rendered time-only,
 * a 02-10 action then read as 30 September on a client-facing document.
 *
 * The rule certified here: the selected date is the SITE'S local calendar day, resolved through the
 * existing site-time utilities, and an event belongs to it only if its authoritative timestamp falls
 * inside that window. Durable items raised on the day whose outcome landed later are reported
 * separately, always with their own date.
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

const dsl = loadTs('src/components/company/dailySiteLog.ts');
const dslPrint = loadTs('src/components/company/dailySiteLogPrint.ts');
const siteTime = loadTs('src/services/siteTime.ts');
const report = loadTs('src/components/company/operationsReport.ts');

const LONDON = 'Europe/London';
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log('PASS ', name); }
  catch (error) { console.error('FAIL ', name); console.error(error.message); process.exitCode = 1; }
};

// ─── the production records ──────────────────────────────────────────────────

const SITE = { id: 14, name: 'test site', clientName: null, client: null, timezone: LONDON };
const SHIFT_19 = {
  id: 19, siteId: 14, siteName: 'test site', site: SITE,
  start: '2026-09-30T19:35:00.000Z', end: '2026-09-30T20:35:00.000Z',
  status: 'in_progress', guard: { id: 20, fullName: 'Fahad test' }, closeOutNotes: null,
};
const OPS_19 = {
  bookOnAt: '2026-09-30T19:33:00.000Z', bookOffAt: null, timezone: LONDON, missingBookOff: true,
  welfare: { enabled: false, requiredCount: 0, completedCount: 0, missedCount: 0, windows: [] },
  logBook: {
    required: false, intervalMinutes: null, currentWindow: null, currentWindowSubmitted: false,
    windows: [], requiredCount: 0, submittedCount: 0, missingCount: 0,
    lastEntryAt: '2026-09-30T19:34:00.000Z',
  },
};

const LOG_BOOK_2034 = { id: 7, logType: 'log_book', message: 'Shift started 20.33 patrol done', createdAt: '2026-09-30T19:34:00.000Z', shift: SHIFT_19, guard: SHIFT_19.guard };
const WELFARE_2119 = { id: 9, logType: 'welfare_check', message: 'Late', createdAt: '2026-09-30T20:19:00.000Z', shift: SHIFT_19, guard: SHIFT_19.guard };
/** The record that should never have appeared on 30-09. */
const WELFARE_LATE = { id: 10, logType: 'welfare_check', message: 'Shdj', createdAt: '2026-10-02T15:46:00.000Z', shift: SHIFT_19, guard: SHIFT_19.guard };

const INCIDENT_4 = {
  id: 4, title: 'Broken fence', notes: 'Broken fence', severity: 'medium', category: 'other',
  status: 'resolved',
  reportedAt: '2026-09-30T19:49:00.000Z', createdAt: '2026-09-30T19:49:00.000Z',
  reviewedAt: '2026-10-02T16:25:00.000Z', closedAt: null,
  resolutionReason: 'client_informed', resolutionNote: 'no issue',
  shift: SHIFT_19, site: SITE, guard: SHIFT_19.guard, company: null,
};

const dayLog = (over = {}) => dsl.buildDailySiteLog({
  siteId: 14, dateKey: '2026-09-30',
  dateLabel: siteTime.formatUkDate('2026-09-30T12:00:00.000Z', LONDON, '2026-09-30'),
  timeZone: LONDON, companyName: 'vesoft Test Company',
  shifts: [SHIFT_19], operationsByShiftId: new Map([[19, OPS_19]]),
  dailyLogs: [LOG_BOOK_2034, WELFARE_2119, WELFARE_LATE],
  incidents: [INCIDENT_4], alerts: [],
  ...over,
});

// ─── the rule ────────────────────────────────────────────────────────────────

test('DAY-01-ONLY-THE-SELECTED-SITE-DAY-IS-IN-THE-OCCURRENCE-RECORD', () => {
  const model = dayLog();
  const stream = model.events.map((e) => `${e.kind}|${e.at}|${e.detail}`);

  assert.ok(stream.some((s) => s.includes('Shift started 20.33 patrol done')), '20:34 Log Book INCLUDED');
  assert.ok(stream.some((s) => s.startsWith('welfare_check|21:19')), '21:19 Welfare INCLUDED');
  assert.ok(model.events.some((e) => e.kind === 'incident_reported'), 'Incident reported INCLUDED');

  assert.ok(!stream.some((s) => s.includes('Shdj')), '02-10 Welfare EXCLUDED');
  assert.ok(!model.events.some((e) => e.kind === 'incident_in_review'), '02-10 In Review EXCLUDED');
  assert.ok(!model.events.some((e) => e.kind === 'incident_resolved'), '02-10 resolution EXCLUDED');

  const window = siteTime.siteDayWindow('2026-09-30', LONDON);
  for (const event of model.events) {
    assert.ok(
      event.atMs >= window.startMs && event.atMs < window.endMs,
      `no event is rendered under a false day — ${event.kind} at ${event.at}`,
    );
  }
});

test('DAY-02-LATE-OUTCOMES-APPEAR-UNDER-FOLLOW-UP-WITH-THEIR-DATE', () => {
  const model = dayLog();
  assert.equal(model.followUps.length, 1);
  const followUp = model.followUps[0];

  assert.match(followUp.title, /Incident #4 — Broken fence/);
  assert.equal(followUp.outstanding, false);
  const byLabel = Object.fromEntries(followUp.lines.map((l) => [l.label, l.value]));
  assert.equal(byLabel.Reported, '30-09-2026 · 20:49');
  assert.equal(byLabel.Resolved, '02-10-2026 · 17:25');
  assert.equal(byLabel.Resolution, 'Client informed');
  assert.equal(byLabel['Resolution note'], 'no issue');
  /**
   * And NOT a "Marked In Review" line at the same minute.
   *
   * `incidents.reviewedAt` is overwritten on resolve, so on a resolved incident it IS the resolution
   * time. Reporting it twice under two labels would show a client two events that the record cannot
   * distinguish.
   */
  assert.ok(!('Marked In Review' in byLabel), 'no duplicate review line on a resolved incident');

  // Never time-only: every follow-up moment carries DD-MM-YYYY.
  for (const line of followUp.lines) {
    if (/\b\d{2}:\d{2}\b/.test(line.value)) {
      assert.match(line.value, /^\d{2}-\d{2}-\d{4} · \d{2}:\d{2}$/, `"${line.label}" is dated`);
    }
  }

  const html = dslPrint.renderDailySiteLogHtml(model, { generatedAt: '03-10-2026 · 09:15' });
  assert.match(html, /Follow-up \/ outcomes/i);
  assert.match(html, /02-10-2026 · 17:25/);
  assert.ok(html.indexOf('Occurrence record') < html.indexOf('Follow-up'), 'separate from the chronology');
  assert.ok(!/>16:46</.test(html), 'and the excluded 02-10 Welfare is nowhere in the document');
});

test('DAY-03-AN-UNRESOLVED-INCIDENT-IS-OUTSTANDING-NOT-INVENTED', () => {
  const model = dayLog({
    incidents: [{ ...INCIDENT_4, status: 'open', reviewedAt: null, resolutionReason: null, resolutionNote: null }],
  });
  const followUp = model.followUps[0];
  assert.equal(followUp.outstanding, true);
  const byLabel = Object.fromEntries(followUp.lines.map((l) => [l.label, l.value]));
  assert.equal(byLabel.Status, 'Outstanding');
  assert.ok(!('Resolved' in byLabel), 'no outcome is invented');
  assert.ok(!('Resolution' in byLabel));
  assert.match(dslPrint.renderDailySiteLogHtml(model, { generatedAt: 'x' }), /Outstanding/);
});

test('DAY-04-AN-OVERNIGHT-SHIFT-SPLITS-ACROSS-TWO-DAYS', () => {
  const night = { ...SHIFT_19, id: 30, start: '2026-09-30T19:00:00.000Z', end: '2026-10-01T07:00:00.000Z' };
  const ops = new Map([[30, { ...OPS_19, bookOnAt: '2026-09-30T18:58:00.000Z', bookOffAt: '2026-10-01T07:04:00.000Z' }]]);
  const logs = [
    { id: 201, logType: 'log_book', message: 'Evening round', createdAt: '2026-09-30T21:00:00.000Z', shift: night, guard: night.guard },
    { id: 202, logType: 'log_book', message: 'Small hours round', createdAt: '2026-10-01T01:30:00.000Z', shift: night, guard: night.guard },
  ];
  const build = (dateKey) => dsl.buildDailySiteLog({
    siteId: 14, dateKey, dateLabel: dateKey, timeZone: LONDON, companyName: '',
    shifts: [night], operationsByShiftId: ops, dailyLogs: logs, incidents: [], alerts: [],
  });

  const first = build('2026-09-30');
  const second = build('2026-10-01');

  assert.deepEqual(first.events.map((e) => e.kind), ['book_on', 'log_book']);
  assert.ok(first.events.some((e) => e.detail === 'Evening round'));
  assert.ok(!first.events.some((e) => e.detail === 'Small hours round'), 'the 01-10 entry is not on 30-09');
  assert.ok(!first.events.some((e) => e.kind === 'book_off'), 'nor the 01-10 Book Off');

  assert.deepEqual(second.events.map((e) => e.kind), ['log_book', 'book_off']);
  assert.ok(second.events.some((e) => e.detail === 'Small hours round'));

  // The shift is still identified on both days, and its window states both dates.
  assert.equal(first.shifts[0].shiftId, 30);
  assert.equal(second.shifts[0].shiftId, 30);
  assert.equal(first.shifts[0].scheduled, '30-09-2026 · 20:00 – 01-10-2026 · 08:00');

  /**
   * The entry COUNT follows the same boundary as the record.
   *
   * Counting by shift alone reported 2 entries on a day whose occurrence record listed 1 — a
   * contradiction inside one document.
   */
  assert.equal(first.logBook.entries, 1, 'one entry on 30-09');
  assert.equal(second.logBook.entries, 1, 'and one on 01-10');
});

test('DAY-05-THE-BOUNDARY-IS-THE-SITE-ZONE-AND-SURVIVES-DST', () => {
  // Not the device zone, and not a naive UTC slice: New York midnight is 04:00Z in EDT.
  const ny = siteTime.siteDayWindow('2026-09-30', 'America/New_York');
  assert.equal(new Date(ny.startMs).toISOString(), '2026-09-30T04:00:00.000Z');
  assert.equal(ny.endMs - ny.startMs, 24 * 3600 * 1000);

  // London clocks go back 25-10-2026 (25-hour day) and forward 29-03-2026 (23-hour day).
  assert.equal(siteTime.siteDayWindow('2026-10-25', LONDON).endMs - siteTime.siteDayWindow('2026-10-25', LONDON).startMs, 25 * 3600 * 1000);
  assert.equal(siteTime.siteDayWindow('2026-03-29', LONDON).endMs - siteTime.siteDayWindow('2026-03-29', LONDON).startMs, 23 * 3600 * 1000);

  const longDay = siteTime.siteDayWindow('2026-10-25', LONDON);
  assert.equal(siteTime.isWithinSiteDay('2026-10-25T23:30:00.000Z', longDay), true, 'late on a 25-hour day still counts');
  assert.equal(siteTime.isWithinSiteDay('2026-10-26T00:30:00.000Z', longDay), false);

  // Nothing is invented for a malformed key.
  assert.equal(siteTime.siteDayWindow('not-a-date', LONDON), null);
  assert.equal(siteTime.isWithinSiteDay('2026-09-30T12:00:00.000Z', null), false);

  // And a New York site's events are bucketed by ITS day.
  const nySite = { ...SITE, timezone: 'America/New_York' };
  const nyShift = { ...SHIFT_19, id: 40, site: nySite, start: '2026-09-30T22:00:00.000Z', end: '2026-10-01T06:00:00.000Z' };
  const model = dsl.buildDailySiteLog({
    siteId: 14, dateKey: '2026-09-30', dateLabel: '30-09-2026', timeZone: 'America/New_York', companyName: '',
    shifts: [nyShift], operationsByShiftId: new Map([[40, { ...OPS_19, bookOnAt: '2026-09-30T22:00:00.000Z', bookOffAt: null }]]),
    // 23:00Z on 30-09 is 19:00 in New York — still 30 September there.
    dailyLogs: [{ id: 301, logType: 'log_book', message: 'NY evening', createdAt: '2026-09-30T23:00:00.000Z', shift: nyShift, guard: nyShift.guard }],
    incidents: [], alerts: [],
  });
  assert.ok(model.events.some((e) => e.detail === 'NY evening'), 'bucketed by the site zone, not UTC');
});

test('DAY-06-LOG-BOOK-PERIODS-AND-WELFARE-ARE-CLIPPED-TO-THE-DAY', () => {
  const night = { ...SHIFT_19, id: 31, start: '2026-09-30T21:00:00.000Z', end: '2026-10-01T01:00:00.000Z' };
  const win = (i, s, e, state) => ({ index: i, start: s, end: e, state, applicable: true, completedAt: null, completionCount: 0 });
  const windows = [
    win(0, '2026-09-30T21:00:00.000Z', '2026-09-30T22:00:00.000Z', 'missed'),
    win(1, '2026-09-30T22:00:00.000Z', '2026-09-30T23:00:00.000Z', 'missed'),
    win(2, '2026-09-30T23:00:00.000Z', '2026-10-01T00:00:00.000Z', 'missed'),
    win(3, '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', 'missed'),
  ];
  const ops = new Map([[31, {
    ...OPS_19, bookOnAt: null, bookOffAt: null,
    welfare: { enabled: true, requiredCount: 4, completedCount: 0, missedCount: 4, windows },
    logBook: {
      required: true, intervalMinutes: 60, currentWindow: null, currentWindowSubmitted: false,
      requiredCount: 4, submittedCount: 0, missingCount: 4, lastEntryAt: null, windows,
    },
  }]]);
  const build = (dateKey) => dsl.buildDailySiteLog({
    siteId: 14, dateKey, dateLabel: dateKey, timeZone: LONDON, companyName: '',
    shifts: [night], operationsByShiftId: ops, dailyLogs: [], incidents: [], alerts: [],
  });

  // BST: 21:00Z–01:00Z is 22:00–02:00 local, so two periods each side of midnight.
  const first = build('2026-09-30');
  const second = build('2026-10-01');

  assert.equal(first.periods.length, 2, '30-09 carries only its own periods');
  assert.equal(second.periods.length, 2);
  assert.equal(first.logBook.required, 2, 'counts describe the day, not the whole shift');
  assert.equal(first.logBook.missing, 2);
  assert.equal(first.logBook.required + second.logBook.required, 4, 'and the obligation is counted once overall');

  assert.equal(first.welfare.required, 2, 'Welfare is clipped the same way');
  assert.equal(first.welfare.missed, 2);
  assert.equal(second.welfare.required, 2);

  // AS REQUIRED still manufactures nothing.
  const asRequired = dayLog();
  assert.equal(asRequired.logBook.scheduled, false);
  assert.deepEqual(asRequired.periods, []);
});

test('DAY-07-A-LATE-SITE-REQUEST-CLOSURE-BECOMES-A-FOLLOW-UP', () => {
  const raisedToday = {
    id: 9, type: 'site_request', message: 'Need replacement log sheets', status: 'closed',
    createdAt: '2026-09-30T18:40:00.000Z', closedAt: '2026-10-02T09:10:00.000Z',
    shift: SHIFT_19, guard: SHIFT_19.guard,
  };
  const raisedLater = {
    id: 11, type: 'panic', message: 'Emergency on 02-10', status: 'closed',
    createdAt: '2026-10-02T11:00:00.000Z', closedAt: '2026-10-02T11:30:00.000Z',
    shift: SHIFT_19, guard: SHIFT_19.guard,
  };
  const model = dayLog({ alerts: [raisedToday, raisedLater], incidents: [] });

  assert.ok(model.events.some((e) => e.kind === 'site_request'), 'the raise is on 30-09');
  assert.ok(!model.events.some((e) => e.kind === 'site_request_resolved'), 'its 02-10 closure is not');
  assert.ok(!model.events.some((e) => e.kind === 'emergency'), 'an item raised on 02-10 is absent entirely');
  assert.equal(model.operational.emergencies, 0, 'and is not counted');
  assert.equal(model.operational.siteRequests, 1);

  const followUp = model.followUps.find((f) => f.key === 'alert-9');
  assert.ok(followUp);
  const byLabel = Object.fromEntries(followUp.lines.map((l) => [l.label, l.value]));
  assert.equal(byLabel.Raised, '30-09-2026 · 19:40');
  assert.equal(byLabel.Resolved, '02-10-2026 · 10:10');

  // Welfare is NOT a durable follow-up item: a later Welfare Check simply belongs to its own day.
  assert.ok(
    !dayLog().followUps.some((f) => /welfare/i.test(f.title)),
    'no Welfare follow-up is manufactured',
  );
});

test('DAY-08-THE-EXPORT-APPLIES-THE-SAME-BOUNDARY', () => {
  const rows = report.buildOperationsReport([{
    shift: SHIFT_19, operations: OPS_19,
    logs: [
      { logType: 'log_book', createdAt: '2026-09-30T19:34:00.000Z', message: 'Shift started 20.33 patrol done' },
      { logType: 'log_book', createdAt: '2026-10-02T15:46:00.000Z', message: 'Entry made two days later' },
    ],
    attendance: {}, incidents: [], alerts: [],
  }], { date: '2026-09-30' }).logBook;

  const entryColumn = report.LOG_BOOK_COLUMNS.indexOf('Entry');
  assert.deepEqual(
    rows.map((row) => row[entryColumn]).filter(Boolean),
    ['Shift started 20.33 patrol done'],
    'a 02-10 entry does not reach a 30-09 export merely because the shift matches',
  );

  // An overnight shift's later-day missing period does not land on the earlier day either.
  const night = { ...SHIFT_19, id: 31, start: '2026-09-30T21:00:00.000Z', end: '2026-10-01T01:00:00.000Z' };
  const win = (i, s, e) => ({ index: i, start: s, end: e, state: 'missed', applicable: true, completedAt: null, completionCount: 0 });
  const nightRows = report.buildOperationsReport([{
    shift: night, logs: [], attendance: {}, incidents: [], alerts: [],
    operations: { ...OPS_19, logBook: { required: true, intervalMinutes: 60, windows: [
      win(0, '2026-09-30T21:00:00.000Z', '2026-09-30T22:00:00.000Z'),
      win(1, '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z'),
    ], currentWindow: null, currentWindowSubmitted: false, requiredCount: 2, submittedCount: 0, missingCount: 2, lastEntryAt: null } },
  }], { date: '2026-09-30' }).logBook;
  assert.equal(nightRows.length, 1, 'only the period on 30-09');

  // Formula-injection guarding is untouched.
  assert.ok(report.csvCell('=1+1').startsWith("'"));
  assert.ok(report.csvCell('@x').startsWith("'"));
  assert.ok(report.csvCell('-2').startsWith("'"));
});

test('DAY-09-MUTATION-REMOVING-THE-SITE-DAY-FILTER-IS-CAUGHT', () => {
  /**
   * The filter, executed both ways on the real records. Without it the two 02-10 rows re-enter the
   * 30-09 stream — exactly the production defect.
   */
  const window = siteTime.siteDayWindow('2026-09-30', LONDON);
  const candidates = [
    LOG_BOOK_2034.createdAt, WELFARE_2119.createdAt, WELFARE_LATE.createdAt, INCIDENT_4.reviewedAt,
  ];
  const kept = candidates.filter((iso) => siteTime.isWithinSiteDay(iso, window));

  assert.equal(kept.length, 2, 'the filter keeps only the two 30-09 records');
  assert.equal(candidates.length, 4, 'without it, both 02-10 records would survive');
  assert.ok(!kept.includes(WELFARE_LATE.createdAt));
  assert.ok(!kept.includes(INCIDENT_4.reviewedAt));

  // The shipped builder applies it, resolved from the SITE zone and the report's own date.
  const source = fs.readFileSync(path.join(ROOT, 'src/components/company/dailySiteLog.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(source, /isWithinSiteDay\(iso, dayWindow\)/, 'the event pusher applies the window');
  assert.match(source, /siteDayWindow\(input\.dateKey, timeZone\)/, 'from the site zone and report date');
  assert.ok(!/deviceTimeZone\(\)/.test(source), 'never the browser zone');
});

test('DAY-10-THE-FOOTER-STAMP-IS-UK-FORMAT-TOO', () => {
  /**
   * The printed footer must not drift from the dates in the body.
   *
   * Production showed "Report generated Sat, 03 Oct 2026 · 20:22" under a report whose every other
   * date read DD-MM-YYYY — the call site passed the Incident Report's formatter. It now goes through
   * the report's own `generatedAtLabel`, so there is one formatting path, not two.
   */
  assert.equal(
    dsl.generatedAtLabel('2026-10-03T19:22:00.000Z', LONDON), '03-10-2026 · 20:22',
    'the helper produces the UK stamp',
  );

  const html = dslPrint.renderDailySiteLogHtml(
    dayLog(), { generatedAt: dsl.generatedAtLabel('2026-10-03T19:22:00.000Z', LONDON) },
  );
  assert.ok(html.includes('Report generated 03-10-2026 · 20:22'), 'the footer reads the UK stamp');
  assert.ok(!/Report generated Sat, 03 Oct 2026/.test(html), 'and never the long form');
  assert.ok(!/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/.test(html),
    'no long-form date survives anywhere in the Daily Site Log');

  // The shipped call site routes through the helper rather than formatting its own.
  const screen = fs.readFileSync(path.join(ROOT, 'src/screens/CompanyDashboardScreen.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const call = screen.slice(screen.indexOf('renderDailySiteLogHtml(model'), screen.indexOf('renderDailySiteLogHtml(model') + 220);
  assert.match(call, /generatedAt: generatedAtLabel\(/, 'the Daily Site Log uses its own helper');
  assert.ok(!/generatedAt: formatInstantDateTime\(/.test(call), 'and not the long-date formatter');
});

test('DAY-11-THE-INCIDENT-REPORT-KEEPS-ITS-LONG-DATE-PRESENTATION', () => {
  // The owner's UK request covers the Log Book workflow; the Incident Report is a different document.
  const incidentPrint = loadTs('src/components/company/incidentReportPrint.ts');
  const incidentReport = loadTs('src/components/company/incidentReport.ts');

  const model = incidentReport.buildIncidentReport(INCIDENT_4, [], [], LONDON);
  const reported = model.overview.find((f) => f.label === 'Reported').value;
  assert.match(reported, /Wed, 30 Sept 2026 · 20:49/, 'still the approved long form');
  assert.ok(!/30-09-2026/.test(reported), 'not restyled as collateral');

  const html = incidentPrint.renderIncidentReportHtml(model, { generatedAt: 'Sat, 03 Oct 2026 · 20:22' });
  assert.match(html, /Report generated Sat, 03 Oct 2026 · 20:22/, 'and its own footer is unchanged');

  // The screen still passes the long formatter for the Incident Report specifically.
  const screen = fs.readFileSync(path.join(ROOT, 'src/screens/CompanyDashboardScreen.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const call = screen.slice(screen.indexOf('renderIncidentReportHtml(incidentReportModel'), screen.indexOf('renderIncidentReportHtml(incidentReportModel') + 260);
  assert.match(call, /generatedAt: formatInstantDateTime\(/, 'the Incident Report keeps the long formatter');
});

console.log(`\n${passed} day boundary checks passed`);
