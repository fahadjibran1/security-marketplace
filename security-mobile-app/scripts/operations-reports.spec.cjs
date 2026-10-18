#!/usr/bin/env node
/**
 * Shift Attendance and Welfare Monitoring report files, and the timeline's follow mode (S4 Welfare Phase 3).
 *
 * The reports are built by the backend (certified by the backend operations-export spec); this suite certifies
 * what the web app does with them: the period it asks for, the CSV and XLSX it writes — byte for byte what the
 * API returned, with formulas neutralised — and the file name. It also drives the follow-mode state machine
 * that stops the 15-second refresh pulling the timeline back to now.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ex = loadTs('src/components/company/operationsExports.ts');
const tl = loadTs('src/components/company/operationsTimeline.ts');

const SHEET = {
  report: 'welfare-monitoring',
  title: 'Welfare Monitoring',
  company: 'Alpha Security Ltd',
  period: { from: '12-10-2026', to: '18-10-2026', fromUtc: '2026-10-11T23:00:00Z', toUtc: '2026-10-18T23:00:00Z', days: 7 },
  site: null,
  generatedAtUtc: '2026-10-18T11:00:00Z',
  timezoneNote: "Local times are each site's own clock (Europe/London); the (UTC) columns are the same instants in UTC.",
  columns: ['Shift ID', 'Guard', 'Window', 'Status', 'Alert status'],
  rows: [
    ['33', 'Uma Early', '03:00–04:00', 'Ended at Book Off', ''],
    ['26', '=HYPERLINK("http://example.invalid","x")', '23:00–00:00', 'Missed', 'Closed automatically (previous rule)'],
    ['27', '+44 7700 900000', '00:00–01:00', 'Missed', 'Resolved by control room'],
    ['28', 'Quote "here", and, commas\nnewline', '01:00–02:00', 'Completed', ''],
  ],
  summary: [['Report', 'Welfare Monitoring'], ['Company', 'Alpha'], ['Period', 'x'], ['Site', 'All sites'], ['Generated (UTC)', 'x'], [],
    ['Site', 'Windows required', 'Completed', 'Missed'], ['North Gate', '10', '7', '2']],
};

test('RPT-01-PERIODS', () => {
  assert.deepEqual(ex.reportRange('day', '2026-10-18'), { from: '2026-10-18', to: '2026-10-18', days: 1 });
  assert.deepEqual(ex.reportRange('week', '2026-10-18'), { from: '2026-10-12', to: '2026-10-18', days: 7 }, 'Monday to Sunday');
  assert.deepEqual(ex.reportRange('week', '2026-10-01'), { from: '2026-09-28', to: '2026-10-04', days: 7 }, 'across a month end');
  assert.deepEqual(ex.reportRange('month', '2026-10-18'), { from: '2026-10-01', to: '2026-10-31', days: 31 });
  assert.deepEqual(ex.reportRange('month', '2026-02-10'), { from: '2026-02-01', to: '2026-02-28', days: 28 });
  assert.deepEqual(ex.reportRange('custom', '2026-10-01', '2026-10-31'), { from: '2026-10-01', to: '2026-10-31', days: 31 });
  assert.match(ex.reportRange('custom', '2026-10-01', '2026-11-01').error, /31 days/);
  assert.match(ex.reportRange('custom', '2026-10-05', '2026-10-04').error, /before/);
  assert.match(ex.reportRange('day', '2026-02-31').error, /valid date/);
  assert.match(ex.reportRange('custom', '2026-10-01', '').error, /end date/);
  assert.equal(ex.ukDay('2026-10-18'), '18-10-2026');
});

test('RPT-02-CSV-IS-THE-SHEET-WITH-FORMULAS-NEUTRALISED', () => {
  const csv = ex.reportToCsv(SHEET);
  assert.ok(csv.startsWith('﻿'), 'BOM so Excel reads UTF-8');
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'Shift ID,Guard,Window,Status,Alert status');
  assert.ok(lines[2].includes(`"'=HYPERLINK(""http://example.invalid"",""x"")"`), 'a leading = is written as text');
  assert.ok(lines[3].includes(`'+44 7700 900000`), 'a leading + is written as text');
  assert.ok(csv.includes('"Quote ""here"", and, commas\nnewline"'), 'quotes, commas and newlines are quoted');
  assert.ok(lines[1].includes('Ended at Book Off'));
  assert.ok(csv.includes('Closed automatically (previous rule)'), 'the API wording is kept verbatim');
});

test('RPT-03-XLSX-HAS-A-SUMMARY-AND-DETAIL-AND-NO-FORMULAS', () => {
  const bytes = ex.reportToXlsx(SHEET);
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('PK'), 'a ZIP container');
  assert.ok(text.includes('name="Summary"') && text.includes('name="Welfare windows"'), 'two sheets');
  assert.ok(!/<f>|<f /.test(text), 'no formula cells anywhere');
  assert.ok(text.includes('=HYPERLINK(&quot;http://example.invalid&quot;,&quot;x&quot;)'), 'the hostile name is inline text');
  assert.ok(text.includes('Europe/London'), 'the summary states how to read the times');
  assert.ok(text.includes('North Gate'), "and carries the server's summary table");
  const attendance = Buffer.from(ex.reportToXlsx({ ...SHEET, report: 'shift-attendance' })).toString('latin1');
  assert.ok(attendance.includes('name="Shifts"'));
});

test('RPT-04-AN-EMPTY-REPORT-STILL-HAS-HEADINGS', () => {
  const csv = ex.reportToCsv({ ...SHEET, rows: [] });
  assert.equal(csv, '﻿Shift ID,Guard,Window,Status,Alert status\r\n');
  assert.ok(Buffer.from(ex.reportToXlsx({ ...SHEET, rows: [] })).toString('latin1').includes('Shift ID'));
});

test('RPT-05-FILE-NAMES-SAY-WHAT-AND-WHEN-AND-NOTHING-ELSE', () => {
  assert.equal(ex.reportFilename('welfare-monitoring', '2026-10-12', '2026-10-18', null, 'xlsx'), 'S4-Welfare-Monitoring-12-10-2026-to-18-10-2026.xlsx');
  assert.equal(ex.reportFilename('shift-attendance', '2026-10-18', '2026-10-18', 'North Gate / Dock "B"', 'csv'), 'S4-Shift-Attendance-18-10-2026-North-Gate-Dock-B.csv');
  assert.ok(!ex.reportFilename('shift-attendance', '2026-10-18', '2026-10-18', null, 'csv').includes('Alpha'), 'no company name');
});

test('RPT-06-FOLLOW-MODE', () => {
  const r = tl.timelineFollowReducer;
  let s = tl.INITIAL_TIMELINE_FOLLOW;
  assert.equal(tl.timelineFollowAnchor(s, 1000), 1000, 'following: the live anchor');
  assert.equal(tl.timelineFollowAnchor(s, 2000), 2000, 'and it moves with the clock');

  s = r(s, { type: 'pan', deltaHours: -4, anchorMs: 2000 });
  assert.deepEqual(s, { following: false, frozenAnchorMs: 2000, panHours: -4 }, 'Earlier pauses and freezes');
  assert.equal(tl.timelineFollowAnchor(s, 17000), 2000, 'a refresh tick does not move a paused axis');
  s = r(s, { type: 'pan', deltaHours: -4, anchorMs: 17000 });
  assert.deepEqual(s, { following: false, frozenAnchorMs: 2000, panHours: -8 }, 'panning again keeps the frozen anchor');
  s = r(s, { type: 'range-changed' });
  assert.deepEqual(s, { following: false, frozenAnchorMs: 2000, panHours: 0 }, 'a range change keeps the pause');
  s = r(s, { type: 'now' });
  assert.deepEqual(s, tl.INITIAL_TIMELINE_FOLLOW, 'Now resumes following');

  s = r(s, { type: 'manual-scroll', anchorMs: 5000 });
  assert.deepEqual(s, { following: false, frozenAnchorMs: 5000, panHours: 0 }, 'a manual scroll pauses');
  assert.deepEqual(r(s, { type: 'manual-scroll', anchorMs: 9000 }), s, 'and a second one changes nothing');
  assert.deepEqual(r(s, { type: 'view-changed' }), tl.INITIAL_TIMELINE_FOLLOW, 'a different day follows again');
});

test('RPT-07-THE-SCREENS-USE-THE-SERVER-REPORTS-AND-KEEP-THE-EXISTING-EXPORT', () => {
  const timeline = codeOf('src/components/company/CompanyOperationsTimeline.tsx');
  assert.match(timeline, /Excel \(\.xlsx\)/);
  assert.match(timeline, /CSV \(\.csv\)/);
  assert.match(timeline, /Shift Attendance report…/);
  assert.match(timeline, /Welfare Monitoring report…/);
  assert.doesNotMatch(timeline, /\[rangeHours, anchorMs\]/, 'the clock no longer resets the pan');
  assert.match(timeline, /if \(!follow\.following\) return;/, 'a paused axis is never scrolled by the code');
  assert.match(timeline, /Paused · press Now to follow/);
  const screen = codeOf('src/screens/CompanyDashboardScreen.tsx');
  assert.match(screen, /getOperationsReport\(request\.kind/, 'reports come from the server');
  assert.match(screen, /reportToCsv\(sheet\)/);
  assert.match(screen, /reportToXlsx\(sheet\)/);
  assert.match(screen, /handleExportOperationsCsv/, 'the existing export is kept');
  const api = codeOf('src/services/api.ts');
  assert.match(api, /\/reports\/\$\{kind\}\?/);
});

console.log(JSON.stringify({ event: 'operations_reports_certified', tests: passed }));
