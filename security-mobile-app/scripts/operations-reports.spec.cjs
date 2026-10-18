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

/**
 * Opens the workbook the way a spreadsheet application would: reads the ZIP's central directory, takes
 * each stored entry, and reads every inline-string cell back. Proves the file's contents, not only that
 * bytes were produced.
 */
function readXlsx(bytes) {
  const buf = Buffer.from(bytes);
  const entries = new Map();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  assert.ok(eocd >= 0, 'end of central directory present');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(method, 0, 'stored entry');
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    entries.set(name, buf.slice(dataAt, dataAt + size).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const workbook = entries.get('xl/workbook.xml');
  const names = [...workbook.matchAll(/<sheet name="([^"]+)" sheetId="(\d+)"/g)].map((m) => unescape(m[1]));
  const sheets = {};
  names.forEach((name, i) => {
    const xml = entries.get(`xl/worksheets/sheet${i + 1}.xml`);
    assert.ok(!/<f[ >]/.test(xml), `no formulas in ${name}`);
    // Cells are placed by their reference (A, B, ...): an empty cell is omitted from the file, as Excel
    // expects, and reads back as empty — exactly what a spreadsheet application shows.
    const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    sheets[name] = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>|<row[^>]*\/>/g)].map((row) => {
      const cells = [];
      for (const c of (row[1] || '').matchAll(/<c r="([A-Z]+)\d+" t="inlineStr"><is><t xml:space="preserve">([\s\S]*?)<\/t><\/is><\/c>/g)) {
        cells[colIndex(c[1])] = unescape(c[2]);
      }
      return Array.from(cells, (v) => v ?? '');
    });
  });
  return sheets;
}

/** Reads the CSV back: RFC 4180 quoting, the BOM, and the formula guard's leading apostrophe. */
function readCsv(text) {
  assert.ok(text.startsWith('\ufeff'));
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = text.slice(1);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && s[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; }
    else cell += ch;
  }
  return rows;
}

test('RPT-08-THE-FILES-READ-BACK-EXACTLY-AS-THE-API-SHEET', () => {
  const sheets = readXlsx(ex.reportToXlsx(SHEET));
  assert.deepEqual(Object.keys(sheets), ['Summary', 'Welfare windows']);
  const trim = (row) => { const out = [...row]; while (out.length && out[out.length - 1] === '') out.pop(); return out; };
  assert.deepEqual(sheets['Welfare windows'], [SHEET.columns, ...SHEET.rows].map(trim), 'every detail cell, verbatim (trailing empty cells are absent, as in Excel)');
  assert.deepEqual(sheets.Summary[0], ['Welfare Monitoring']);
  assert.deepEqual(sheets.Summary.find((r) => r[0] === 'Period'), ['Period', '12-10-2026 to 18-10-2026']);
  assert.ok(sheets.Summary.some((r) => r[0] === 'North Gate' && r[3] === '2'), "the server's summary table");
  const csv = readCsv(ex.reportToCsv(SHEET));
  assert.deepEqual(csv[0], SHEET.columns);
  const unguard = (v) => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);
  assert.deepEqual(csv.slice(1).map((r) => r.map(unguard)), SHEET.rows, 'every CSV cell, with only the formula guard added');
  assert.equal(csv[2][1], `'=HYPERLINK("http://example.invalid","x")`, 'and the guard is there');
});

test('RPT-09-A-LARGE-REPORT-BUILDS-AND-READS-BACK', () => {
  // Welfare Phase 5: the ZIP builder used to spread every byte into a call, which overflowed the call stack
  // at about 60 welfare rows — a weekly Welfare Monitoring workbook could not be downloaded.
  const rows = Array.from({ length: 20000 }, (_, i) => [String(i), `Guard ${i}`, '01:00–02:00', i % 7 ? 'Completed' : 'Missed', '']);
  const big = { ...SHEET, rows };
  const bytes = ex.reportToXlsx(big);
  assert.ok(bytes.length > 2_000_000, `a large workbook (${bytes.length} bytes)`);
  const sheets = readXlsx(bytes);
  assert.equal(sheets['Welfare windows'].length, 20001, 'every row back');
  // 19999 is a multiple of 7, so that row is 'Missed'.
  assert.deepEqual(sheets['Welfare windows'][20000], ['19999', 'Guard 19999', '01:00–02:00', 'Missed']);
  assert.ok(ex.reportToCsv(big).length > 600_000);
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

test('RPT-10-ANALYTICS-SHOWS-THE-WELFARE-REPORT-WHEN-ANOTHER-REPORT-IS-REFUSED', () => {
  // Welfare release gate: /reports/welfare is open to reports.operational roles; incidents and site risk are
  // still owner-only. The page settles each report on its own, so a refusal does not blank the others.
  const page = codeOf('src/components/company/CompanyAnalyticsWorkspace.tsx');
  assert.match(page, /await Promise\.allSettled\(\[\s*getIncidentAnalyticsReport\(filters\),\s*getWelfareAnalyticsReport\(filters\),\s*getSiteRiskReport\(filters\),\s*\]\)/);
  assert.match(page, /setWelfareReport\(nextWelfare\.status === 'fulfilled' \? nextWelfare\.value : null\)/);
  assert.match(page, /could not be loaded\. Your role may not have access\./);
  assert.doesNotMatch(page, /await Promise\.all\(\[\s*getIncidentAnalyticsReport/);
});

console.log(JSON.stringify({ event: 'operations_reports_certified', tests: passed }));
