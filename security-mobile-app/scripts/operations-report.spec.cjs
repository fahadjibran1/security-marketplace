#!/usr/bin/env node
/**
 * The daily operations report — structured evidence, not a screenshot. (Phase 4A.2.)
 *
 * WHY IT IS BUILT FROM THE EXISTING DATASET
 * `listCoverageShifts` already resolves the company from the caller's own token
 * (`resolveCompanyContext(…SITES_VIEW)`), and Phase 4A published `welfare.windows[]` on it. So the export
 * needs no new endpoint and no new authorization surface: the rows it formats are rows the company could
 * already fetch, and the ones the timeline is drawing.
 *
 * WHAT THIS SUITE EXECUTES
 * The real report builder, the real CSV writer and the real XLSX writer, down to the ZIP structure and the
 * CRC. The workbook is checked by parsing the bytes back out — a "valid xlsx" that Excel refuses to open
 * is the failure mode worth guarding, and the only way to catch it is to read the archive.
 */
const assert = require('node:assert').strict;
const zlib = require('node:zlib');
const { loadTs } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };

const report = loadTs('src/components/company/operationsReport.ts');
const xlsx = loadTs('src/components/company/xlsxWriter.ts');
const {
  buildOperationsReport, toCsv, csvCell, operationsReportFilename, sanitiseFilenamePart, reportDateFor,
  SUMMARY_COLUMNS, WELFARE_COLUMNS,
} = report;
const { buildXlsx, sheetXml, columnName, xmlEscape, crc32, utf8Bytes, sanitiseSheetName } = xlsx;

const LONDON = 'Europe/London';

/** The proven Shift #19 evening: 20:35–21:35 London, Book On 20:33, 15-minute Welfare. */
const SHIFT_19 = {
  shift: {
    id: 19,
    start: '2026-09-30T19:35:00.000Z',
    end: '2026-09-30T20:35:00.000Z',
    status: 'in_progress',
    site: { name: 'test site', timezone: LONDON, client: { name: 'Test Client' } },
    guard: { fullName: 'Fahad test' },
  },
  attendance: { checkInAt: '2026-09-30T19:33:00.000Z', checkOutAt: null },
  operations: {
    welfare: {
      intervalMinutes: 15,
      missedCount: 1,
      windows: [
        { index: 0, start: '2026-09-30T19:35:00.000Z', end: '2026-09-30T19:50:00.000Z', state: 'completed', completedAt: '2026-09-30T19:48:00.000Z' },
        { index: 1, start: '2026-09-30T19:50:00.000Z', end: '2026-09-30T20:05:00.000Z', state: 'overdue', completedAt: null },
        { index: 2, start: '2026-09-30T20:05:00.000Z', end: '2026-09-30T20:20:00.000Z', state: 'missed', completedAt: null },
        { index: 3, start: '2026-09-30T20:20:00.000Z', end: '2026-09-30T20:35:00.000Z', state: 'due', completedAt: null },
      ],
    },
  },
  logs: [
    { logType: 'welfare_check' },
    { logType: 'log_book' },
    { logType: 'log_book' },
    { logType: 'observation' },
  ],
  incidents: [{ id: 5 }],
  alerts: [{ type: 'site_request' }, { type: 'panic' }, { type: 'welfare' }],
};

const SCOPE = { date: '2026-09-30', siteName: 'test site' };

// ═══════════════════ the dataset ═══════════════════

test('REPORT-01-ONE-SUMMARY-ROW-AND-ONE-ROW-PER-WELFARE-WINDOW', () => {
  const r = buildOperationsReport([SHIFT_19], SCOPE);
  assert.equal(r.summary.length, 1, 'one summary row per shift');
  assert.equal(r.welfare.length, 4, 'one detail row per Welfare window');
  assert.equal(r.summary[0].length, SUMMARY_COLUMNS.length, 'summary row matches its header');
  r.welfare.forEach((row, i) => {
    assert.equal(row.length, WELFARE_COLUMNS.length, `detail row ${i} matches its header`);
  });
});

test('REPORT-02-EVERY-REQUIRED-COLUMN-IS-PRESENT', () => {
  for (const column of [
    'Date', 'Client', 'Site', 'Guard', 'Scheduled Start', 'Actual Book On', 'Scheduled End',
    'Actual Book Off', 'Shift Status', 'Welfare Interval', 'Welfare Window Start',
    'Welfare Window End', 'Welfare Status', 'Welfare Completed At', 'Missed Welfare Count',
    'Log Book Entry Count', 'Incident Count', 'Site Request Count', 'Emergency Alert Count',
  ]) {
    assert.ok(WELFARE_COLUMNS.includes(column), `the detail sheet must carry ${column}`);
  }
});

test('REPORT-03-SHIFT-19-VALUES-ARE-ON-THE-SITE-CLOCK', () => {
  const r = buildOperationsReport([SHIFT_19], SCOPE);
  const col = (name) => r.welfare[0][WELFARE_COLUMNS.indexOf(name)];

  assert.equal(col('Client'), 'Test Client');
  assert.equal(col('Site'), 'test site');
  assert.equal(col('Guard'), 'Fahad test');
  assert.equal(col('Scheduled Start'), '20:35', 'BST, not 19:35 UTC');
  assert.equal(col('Actual Book On'), '20:33');
  assert.equal(col('Scheduled End'), '21:35');
  assert.equal(col('Actual Book Off'), '', 'not booked off yet');
  assert.equal(col('Welfare Interval'), '15');
  assert.equal(col('Welfare Window Start'), '20:35');
  assert.equal(col('Welfare Window End'), '20:50');
  assert.equal(col('Welfare Status'), 'Completed');
  assert.equal(col('Welfare Completed At'), '20:48');
  assert.equal(col('Missed Welfare Count'), '1');
  assert.equal(col('Log Book Entry Count'), '2', 'log_book rows only, not observations');
  assert.equal(col('Incident Count'), '1');
  assert.equal(col('Site Request Count'), '1');
  assert.equal(col('Emergency Alert Count'), '1');
});

test('REPORT-04-THE-WELFARE-STATUS-WORDING-IS-CANONICAL', () => {
  const r = buildOperationsReport([SHIFT_19], SCOPE);
  const statuses = r.welfare.map((row) => row[WELFARE_COLUMNS.indexOf('Welfare Status')]);
  assert.deepEqual(statuses, ['Completed', 'Overdue Welfare Check', 'Missed Welfare Check', 'Due']);

  // The legacy vocabulary must not appear anywhere in the file.
  const everything = [...SUMMARY_COLUMNS, ...WELFARE_COLUMNS, ...r.welfare.flat(), ...r.summary.flat()].join(' ');
  for (const banned of ['Check Call', 'Checkcall', 'check call', 'Missed Checkcall']) {
    assert.ok(!everything.includes(banned), `the export must not say "${banned}"`);
  }
});

test('REPORT-05-A-SHIFT-WITH-NO-WELFARE-STILL-APPEARS', () => {
  // An absent row would read as missing evidence rather than as no obligation.
  const noWelfare = { ...SHIFT_19, operations: { welfare: { intervalMinutes: null, missedCount: 0, windows: [] } } };
  const r = buildOperationsReport([noWelfare], SCOPE);
  assert.equal(r.summary.length, 1);
  assert.equal(r.welfare.length, 1, 'one row stating nothing was required');
  assert.equal(r.welfare[0][WELFARE_COLUMNS.indexOf('Welfare Status')], 'Not required');
  assert.equal(r.welfare[0][WELFARE_COLUMNS.indexOf('Welfare Window Start')], '');
});

test('REPORT-06-A-SHIFT-WITH-NO-OPERATIONS-AT-ALL-DOES-NOT-THROW', () => {
  const bare = { shift: { id: 1, start: SHIFT_19.shift.start, end: SHIFT_19.shift.end, siteName: 'S' } };
  const r = buildOperationsReport([bare], SCOPE);
  assert.equal(r.summary.length, 1);
  assert.equal(r.welfare.length, 1);
  assert.equal(r.summary[0][SUMMARY_COLUMNS.indexOf('Guard')], 'Unassigned');
});

test('REPORT-07-SCOPE-IS-WHAT-CONTROL-CHOSE', () => {
  // Two shifts in, two shifts out. The caller passes the FILTERED rows, so a site-narrowed view cannot
  // silently export the whole company.
  const other = { ...SHIFT_19, shift: { ...SHIFT_19.shift, id: 20, site: { name: 'other site', timezone: LONDON } } };
  assert.equal(buildOperationsReport([SHIFT_19], SCOPE).summary.length, 1);
  assert.equal(buildOperationsReport([SHIFT_19, other], SCOPE).summary.length, 2);
  assert.equal(buildOperationsReport([], SCOPE).welfare.length, 0, 'an empty scope exports no rows');
});

// ═══════════════════ CSV ═══════════════════

test('CSV-01-HEADER-PLUS-ONE-LINE-PER-WELFARE-WINDOW', () => {
  const csv = toCsv(buildOperationsReport([SHIFT_19], SCOPE));
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 5, 'header plus four windows');
  assert.equal(lines[0], WELFARE_COLUMNS.join(','));
  assert.ok(csv.startsWith('﻿'), 'a BOM, so Excel reads it as UTF-8');
});

test('CSV-02-FORMULA-INJECTION-IS-NEUTRALISED', () => {
  // Site and guard names come from users. Excel would treat a leading = as a formula.
  for (const danger of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\tTAB']) {
    assert.ok(csvCell(danger).startsWith("'"), `${danger} must be quoted out`);
  }
  assert.equal(csvCell('normal'), 'normal', 'and ordinary text is untouched');
});

test('CSV-03-QUOTES-COMMAS-AND-NEWLINES-ARE-ESCAPED', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell(undefined), '');
});

test('CSV-04-A-COMMA-IN-A-SITE-NAME-DOES-NOT-SHIFT-COLUMNS', () => {
  const tricky = { ...SHIFT_19, shift: { ...SHIFT_19.shift, site: { name: 'Acme, Ltd', timezone: LONDON } } };
  const csv = toCsv(buildOperationsReport([tricky], SCOPE));
  const firstRow = csv.replace(/^﻿/, '').trim().split('\r\n')[1];
  assert.ok(firstRow.includes('"Acme, Ltd"'), 'the name is quoted');
  // Count fields outside quotes to prove the column alignment survived.
  let inQuotes = false;
  let fields = 1;
  for (const ch of firstRow) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) fields += 1;
  }
  assert.equal(fields, WELFARE_COLUMNS.length, 'still one field per column');
});

// ═══════════════════ filenames ═══════════════════

test('NAME-01-USEFUL-AND-SANITISED', () => {
  assert.equal(operationsReportFilename({ date: '2026-09-30' }, 'xlsx'), 'S4-Operations-2026-09-30.xlsx');
  assert.equal(
    operationsReportFilename({ date: '2026-09-30', siteName: 'Test Site' }, 'xlsx'),
    'S4-Operations-Test-Site-2026-09-30.xlsx',
  );
  assert.equal(operationsReportFilename({ date: '2026-09-30' }, 'csv'), 'S4-Operations-2026-09-30.csv');
});

test('NAME-02-PATH-TRAVERSAL-AND-NONSENSE-CANNOT-REACH-THE-FILENAME', () => {
  // A site name is user input and this string is written to the operator's disk.
  assert.equal(sanitiseFilenamePart('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitiseFilenamePart('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(sanitiseFilenamePart('  Trim  Me  '), 'Trim-Me');
  assert.equal(sanitiseFilenamePart(''), '');
  assert.ok(sanitiseFilenamePart('x'.repeat(200)).length <= 48, 'capped');

  const name = operationsReportFilename({ date: '2026-09-30', siteName: '../../evil' }, 'csv');
  assert.ok(!name.includes('..') && !name.includes('/'), `no traversal in ${name}`);
});

test('NAME-03-THE-DATE-IS-THE-SITES-OPERATIONAL-DAY', () => {
  // 23:30Z on 30 September is already 1 October at a London site in BST... and is not. BST is +1, so
  // 23:30Z is 00:30 on the 1st.
  assert.equal(reportDateFor('2026-09-30T23:30:00.000Z', LONDON), '2026-10-01');
  assert.equal(reportDateFor('2026-09-30T19:35:00.000Z', LONDON), '2026-09-30');
  assert.equal(reportDateFor('2026-09-30T19:35:00.000Z', 'America/New_York'), '2026-09-30');
});

// ═══════════════════ XLSX ═══════════════════

/** Reads a store-only ZIP back out, so the workbook is checked as an archive rather than as a blob. */
function readZip(bytes) {
  const buf = Buffer.from(bytes);
  const files = {};
  let offset = 0;
  while (offset < buf.length - 4 && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8);
    const crc = buf.readUInt32LE(offset + 14);
    const size = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + size);
    files[name] = { data, crc, method };
    offset = dataStart + size;
  }
  return files;
}

test('XLSX-01-THE-WORKBOOK-IS-A-VALID-ARCHIVE-WITH-THE-REQUIRED-PARTS', () => {
  const r = buildOperationsReport([SHIFT_19], SCOPE);
  const bytes = buildXlsx([
    { name: 'Operations Summary', rows: [[...SUMMARY_COLUMNS], ...r.summary] },
    { name: 'Welfare Detail', rows: [[...WELFARE_COLUMNS], ...r.welfare] },
  ]);

  // A ZIP, by its signature and its end-of-central-directory record.
  assert.equal(Buffer.from(bytes.slice(0, 2)).toString('latin1'), 'PK');
  assert.ok(Buffer.from(bytes).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), 'end record present');

  const files = readZip(bytes);
  for (const part of [
    '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
  ]) {
    assert.ok(files[part], `the workbook must contain ${part}`);
  }
  assert.equal(Object.keys(files).length, 6, 'and nothing else');
});

test('XLSX-02-EVERY-ENTRY-IS-STORED-WITH-A-CORRECT-CRC', () => {
  // A wrong CRC is exactly what makes Excel report a corrupt file, and it would be invisible without
  // reading the archive back.
  const bytes = buildXlsx([{ name: 'S', rows: [['a', 'b'], ['c', 'd']] }]);
  const files = readZip(bytes);
  for (const [name, entry] of Object.entries(files)) {
    assert.equal(entry.method, 0, `${name} is stored, not deflated`);
    assert.equal(crc32(new Uint8Array(entry.data)), entry.crc, `${name} CRC matches its bytes`);
  }
});

test('XLSX-03-TWO-SHEETS-NAMED-AND-ORDERED', () => {
  const bytes = buildXlsx([
    { name: 'Operations Summary', rows: [['a']] },
    { name: 'Welfare Detail', rows: [['b']] },
  ]);
  const workbook = readZip(bytes)['xl/workbook.xml'].data.toString('utf8');
  assert.ok(workbook.includes('name="Operations Summary" sheetId="1"'));
  assert.ok(workbook.includes('name="Welfare Detail" sheetId="2"'));
  assert.ok(workbook.indexOf('Operations Summary') < workbook.indexOf('Welfare Detail'), 'summary first');
});

test('XLSX-04-CELLS-ARE-INLINE-STRINGS-SO-NOTHING-IS-REINTERPRETED', () => {
  // A compliance export must say exactly what it was given. As a numeric cell, a leading-zero reference
  // or a time would be silently reformatted by Excel.
  const sheet = sheetXml({ name: 'S', rows: [['20:35', '007', '1']] });
  assert.ok(sheet.includes('t="inlineStr"'), 'inline strings throughout');
  assert.ok(sheet.includes('<t xml:space="preserve">20:35</t>'), 'the time is preserved verbatim');
  assert.ok(sheet.includes('>007<'), 'and so is a leading zero');
  assert.ok(!/t="n"/.test(sheet), 'no numeric cells');
});

test('XLSX-05-AN-EMPTY-CELL-IS-OMITTED-NOT-EMITTED-EMPTY', () => {
  const sheet = sheetXml({ name: 'S', rows: [['a', '', 'c']] });
  assert.ok(sheet.includes('r="A1"'));
  assert.ok(!sheet.includes('r="B1"'), 'the blank is skipped');
  assert.ok(sheet.includes('r="C1"'), 'and the column after it keeps its own reference');
});

test('XLSX-06-XML-IS-ESCAPED-AND-ILLEGAL-CONTROL-CHARACTERS-ARE-STRIPPED', () => {
  assert.equal(xmlEscape('a & b < c > d "e" \'f\''), 'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
  // XML 1.0 forbids these outright, and one stray byte makes the whole workbook unopenable.
  assert.equal(xmlEscape('a\u0000b\u000bc\u001fd'), 'abcd');
  const sheet = sheetXml({ name: 'S', rows: [['Acme & Co <Ltd>']] });
  assert.ok(sheet.includes('Acme &amp; Co &lt;Ltd&gt;'));
});

test('XLSX-07-COLUMN-NAMES-PAST-Z', () => {
  // The detail sheet has 19 columns today and will grow; AA must be right when it does.
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(18), 'S');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(27), 'AB');
  assert.equal(columnName(51), 'AZ');
  assert.equal(columnName(52), 'BA');
});

test('XLSX-08-SHEET-NAMES-ARE-MADE-ACCEPTABLE-TO-EXCEL', () => {
  // Excel refuses to OPEN a workbook whose sheet name breaks these rules, so this is correctness.
  assert.equal(sanitiseSheetName('Welfare: Detail'), 'Welfare  Detail');
  assert.equal(sanitiseSheetName('a/b\\c?d*e[f]'), 'a b c d e f');
  assert.equal(sanitiseSheetName('x'.repeat(50)).length, 31);
  assert.equal(sanitiseSheetName(''), 'Sheet');
});

test('XLSX-09-THE-SAME-REPORT-PRODUCES-IDENTICAL-BYTES', () => {
  // Timestamps are fixed rather than taken from the clock, so two exports of the same evidence can be
  // compared byte for byte.
  const rows = [['a', 'b'], ['c', 'd']];
  const first = buildXlsx([{ name: 'S', rows }]);
  const second = buildXlsx([{ name: 'S', rows }]);
  assert.deepEqual(Buffer.from(first), Buffer.from(second));
});

test('XLSX-10-UTF8-SURVIVES-THE-ROUND-TRIP', () => {
  const bytes = buildXlsx([{ name: 'S', rows: [['Façade — Ω 中文']] }]);
  const sheet = readZip(bytes)['xl/worksheets/sheet1.xml'].data.toString('utf8');
  assert.ok(sheet.includes('Façade — Ω 中文'), 'non-ASCII is intact');
  assert.deepEqual(Array.from(utf8Bytes('£')), [0xc2, 0xa3], 'and the encoder is correct');
});

test('XLSX-11-A-WORKBOOK-NEEDS-A-SHEET', () => {
  assert.throws(() => buildXlsx([]), /at least one sheet/);
});

// ═══════════════════ formula safety in BOTH formats ═══════════════════

test('SAFE-01-XLSX-CELLS-CANNOT-BECOME-FORMULAS', () => {
  // Excel evaluates a formula from a <f> element, or from a cell it parses as one. An inline string is
  // displayed verbatim, which is why the writer emits t="inlineStr" for every cell. That is a stronger
  // guarantee than quote-prefixing: the dangerous value cannot execute AND is preserved exactly, which
  // matters when the file is evidence.
  const dangerous = ['=1+1', '+SUM(A1)', '-2+3', '@SUM(1)', '=HYPERLINK("http://x")'];
  const sheet = sheetXml({ name: 'S', rows: [dangerous] });

  assert.ok(!sheet.includes('<f>'), 'no formula element anywhere');
  assert.ok(!/t="str"/.test(sheet), 'and no formula-result cell type');
  dangerous.forEach((value, i) => {
    const ref = columnName(i) + '1';
    assert.ok(sheet.includes('r="' + ref + '" t="inlineStr"'), ref + ' is an inline string');
  });
  assert.ok(sheet.includes('=1+1'), 'and the text is carried through unaltered');
});

test('SAFE-02-USER-CONTROLLED-NAMES-ARE-SAFE-IN-BOTH-FORMATS', () => {
  // Site, client and guard names are free text typed by a company, and they reach both exports.
  const hostile = {
    ...SHIFT_19,
    shift: {
      ...SHIFT_19.shift,
      site: { name: '=1+1', timezone: LONDON, client: { name: '@SUM(A1)' } },
      guard: { fullName: '-cmd' },
    },
  };
  const r = buildOperationsReport([hostile], SCOPE);

  const csv = toCsv(r);
  for (const neutralised of ["'=1+1", "'@SUM(A1)", "'-cmd"]) {
    assert.ok(csv.includes(neutralised), 'CSV must neutralise ' + neutralised);
  }

  const sheet = sheetXml({ name: 'Welfare Detail', rows: r.welfare });
  assert.ok(!sheet.includes('<f>'), 'XLSX has no formula element');
  assert.ok(sheet.includes('t="inlineStr"'), 'every value is a string');
});

// ═══════════════════ the screen and the file agree ═══════════════════

test('CONSISTENCY-01-THE-EXPORT-MATCHES-WHAT-THE-TIMELINE-DRAWS', () => {
  // A silent difference between the board a controller reads and the evidence they hand over is the
  // worst failure this feature could have. Same fixture, same instant, both surfaces.
  const timeline = loadTs('src/components/company/operationsTimeline.ts');
  const nowMs = Date.parse('2026-09-30T19:50:00.000Z');
  const window = timeline.resolveTimelineWindow(nowMs, 4, LONDON);

  const inputs = [SHIFT_19];
  const groups = timeline.buildTimeline(inputs, window, nowMs);
  const r = buildOperationsReport(inputs, SCOPE);

  assert.equal(timeline.timelineRowCount(groups), r.summary.length, 'visible shifts == summary rows');

  const drawn = groups[0].rows[0].welfare;
  assert.equal(drawn.length, r.welfare.length, 'markers drawn == welfare detail rows');

  const glyphToLabel = {
    '\u2713': 'Completed',
    '\u25cf': 'Due',
    '!': 'Overdue Welfare Check',
    '\u2715': 'Missed Welfare Check',
    '\u2014': 'Not required',
  };
  drawn.forEach((marker, i) => {
    const row = r.welfare[i];
    assert.equal(
      row[WELFARE_COLUMNS.indexOf('Welfare Status')],
      glyphToLabel[marker.glyph],
      'window ' + i + ': marker and exported status must agree',
    );
    assert.ok(
      marker.accessibleLabel.includes(row[WELFARE_COLUMNS.indexOf('Welfare Window Start')]),
      'window ' + i + ': the exported start appears in the marker label',
    );
  });

  // A shift the timeline does not draw is off the axis, so the same scope does not export it either.
  //
  // SETTLED, deliberately. UAT FIX 01: a shift booked on and never booked off has not ended, so its bar
  // runs to now and it stays on the board however old its schedule is. Taking SHIFT_19's live attendance
  // and only moving its dates would construct that carry-over by accident and assert the opposite of
  // what this line means.
  const offAxis = {
    ...SHIFT_19,
    shift: { ...SHIFT_19.shift, id: 99, status: 'completed', start: '2026-09-25T08:00:00.000Z', end: '2026-09-25T16:00:00.000Z' },
    attendance: { checkInAt: '2026-09-25T07:58:00.000Z', checkOutAt: '2026-09-25T16:01:00.000Z' },
  };
  assert.equal(timeline.timelineRowCount(timeline.buildTimeline([offAxis], window, nowMs)), 0);
});

console.log(`\n${passed} operations report checks passed`);
