#!/usr/bin/env node
/**
 * Export proof: write the real CSV and XLSX, then read the XLSX BACK and check what is in it.
 *
 * Building a workbook and asserting on the arrays that went in proves only that the arrays were
 * right. This unzips the file that would reach a client's disk and reads the cells out of its XML,
 * so "the workbook opens" and "the entry text survived" are claims about the artefact.
 *
 *   node scripts/log-book-export-proof.cjs [outDir]
 */
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');

const OUT_DIR = process.argv[2]
  || path.join(__dirname, '..', 'preview-log-book');

const preview = require('./log-book-preview.cjs');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log('PASS ', name); }
  catch (error) { console.error('FAIL ', name); console.error(error.message); process.exitCode = 1; }
};

// ─── a minimal ZIP reader ─────────────────────────────────────────────────────
//
// The writer stores entries uncompressed (method 0) and may use deflate elsewhere; both are handled
// so this reader tests the file rather than an assumption about how it was made.

function readZip(buffer) {
  const files = new Map();
  // Walk local file headers from the start: PK\x03\x04
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    offset = dataStart + compressedSize;
  }
  return files;
}

/** A1-style column reference to a zero-based index: A→0, K→10, AA→26. */
function columnIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || [''])[0];
  let index = 0;
  for (const character of letters) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * The cell values of one sheet, row by row, resolving shared strings.
 *
 * Cells are placed by their `r` reference rather than by the order they appear. A writer is free to
 * omit an empty cell entirely — and this one does — so reading positionally would silently shift
 * every column after the first blank, which is exactly how an export proof can pass while the file
 * a client opens is wrong.
 */
function sheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowXml of xml.match(/<row[^>]*>[\s\S]*?<\/row>|<row[^>]*\/>/g) || []) {
    const cells = [];
    for (const cell of rowXml.match(/<c[^>]*>[\s\S]*?<\/c>|<c[^>]*\/>/g) || []) {
      const ref = (cell.match(/\sr="([A-Z]+\d+)"/) || [])[1];
      const type = (cell.match(/\st="([^"]+)"/) || [])[1];
      const raw = (cell.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      const inline = (cell.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/) || [])[1];
      let value = inline ?? raw ?? '';
      if (type === 's' && raw != null) value = sharedStrings[Number(raw)] ?? '';
      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = unescapeXml(value);
    }
    rows.push(cells);
  }
  return rows;
}

const unescapeXml = (value) => String(value)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#10;/g, '\n').replace(/&amp;/g, '&');

// ─── the artefacts ────────────────────────────────────────────────────────────

const xlsxPath = path.join(OUT_DIR, 'operations.xlsx');
const csvPath = path.join(OUT_DIR, 'operations.csv');
assert.ok(fs.existsSync(xlsxPath), `missing ${xlsxPath} — run log-book-preview.cjs first`);

const zip = readZip(fs.readFileSync(xlsxPath));
const text = (name) => (zip.get(name) ? zip.get(name).toString('utf8') : '');
const shared = [...(text('xl/sharedStrings.xml').match(/<t[^>]*>[\s\S]*?<\/t>/g) || [])]
  .map((t) => unescapeXml(t.replace(/<\/?t[^>]*>/g, '')));

const workbook = text('xl/workbook.xml');
const sheets = [1, 2, 3].map((n) => sheetRows(text(`xl/worksheets/sheet${n}.xml`), shared));
const [summarySheet, welfareSheet, logBookSheet] = sheets;
const csv = fs.readFileSync(csvPath, 'utf8');

test('EXPORT-01-THE-WORKBOOK-IS-VALID-AND-COMPLETE', () => {
  assert.ok(zip.has('[Content_Types].xml'), 'content types present');
  assert.ok(zip.has('xl/workbook.xml'), 'workbook present');
  assert.ok(zip.has('xl/worksheets/sheet1.xml'), 'sheet 1 present');
  assert.ok(zip.has('xl/worksheets/sheet3.xml'), 'sheet 3 present');
  for (const name of ['Operations Summary', 'Welfare Detail', 'Log Book']) {
    assert.ok(workbook.includes(name), `the workbook declares "${name}"`);
  }
});

test('EXPORT-02-THE-LOG-BOOK-SHEET-HAS-THE-EXPECTED-SHAPE', () => {
  assert.deepEqual(logBookSheet[0], [...preview.report.LOG_BOOK_COLUMNS], 'header row');
  // 3 entries + 2 missing periods across the two shifts, plus the header.
  assert.equal(logBookSheet.length, preview.built.logBook.length + 1, 'every built row reached the file');
  assert.equal(logBookSheet.length, 7);
  assert.equal(summarySheet.length, preview.built.summary.length + 1);
  assert.equal(welfareSheet.length, preview.built.welfare.length + 1);
});

test('EXPORT-03-FULL-LOG-BOOK-TEXT-SURVIVES-THE-ROUND-TRIP', () => {
  const entryColumn = preview.report.LOG_BOOK_COLUMNS.indexOf('Entry');
  const long = logBookSheet.find((row) => (row[entryColumn] || '').length > 200);
  assert.ok(long, 'the long entry is in the file');
  assert.equal(long[entryColumn], preview.LONG_ENTRY, 'to the character — nothing was truncated');
  assert.ok(
    logBookSheet.some((row) => row[entryColumn].includes('trailers 4 and 7 sealed')),
    'the as-required site’s entry is there too',
  );
});

test('EXPORT-04-MISSING-PERIODS-ARE-PRESERVED', () => {
  const statusColumn = preview.report.LOG_BOOK_COLUMNS.indexOf('Period Status');
  const startColumn = preview.report.LOG_BOOK_COLUMNS.indexOf('Required Period Start');
  const missing = logBookSheet.filter((row) => row[statusColumn] === 'Missing');

  assert.equal(missing.length, 2, 'both missed periods are in the workbook');
  assert.deepEqual(missing.map((row) => row[startColumn]).sort(), ['20:00', '22:00']);
  // The as-required site contributes no period rows at all.
  const shiftColumn = preview.report.LOG_BOOK_COLUMNS.indexOf('Shift');
  assert.ok(
    !missing.some((row) => row[shiftColumn] === '#24'),
    'a site with no obligation has no missing period',
  );
});

test('EXPORT-05-ORDERING-AND-CONSISTENCY-WITH-THE-REGISTER', () => {
  const entryColumn = preview.report.LOG_BOOK_COLUMNS.indexOf('Entry');
  const recordedColumn = preview.report.LOG_BOOK_COLUMNS.indexOf('Recorded At');
  const guardColumn = preview.report.LOG_BOOK_COLUMNS.indexOf('Guard');

  const exported = logBookSheet.slice(1)
    .filter((row) => row[entryColumn])
    .map((row) => ({ at: row[recordedColumn], entry: row[entryColumn], guard: row[guardColumn] }));

  // The register for the same day AND the same site must agree entry-for-entry with the report.
  const registerForSiteA = preview.ROWS.filter((row) => row.siteId === 14);
  for (const row of registerForSiteA) {
    const match = exported.find((e) => e.entry === row.message);
    assert.ok(match, `the export carries the register entry "${row.message.slice(0, 32)}…"`);
    assert.equal(match.guard, row.guardName, 'same guard on both surfaces');
  }

  // The Daily Site Log tells the same day, in order.
  const model = preview.dayModel([preview.SHIFT_A], 14);
  const logEvents = model.events.filter((e) => e.kind === 'log_book');
  assert.deepEqual(
    logEvents.map((e) => e.detail),
    registerForSiteA.map((r) => r.message),
    'report and register list the same entries in the same order',
  );
});

test('EXPORT-06-NO-USER-TEXT-BECAME-A-FORMULA', () => {
  for (let n = 1; n <= 3; n += 1) {
    const xml = text(`xl/worksheets/sheet${n}.xml`);
    assert.ok(!/<f>/.test(xml), `sheet${n} contains no formula element`);
  }
  // And the CSV guard is intact for every hostile prefix.
  for (const hostile of ['=1+1', '+1', '-1', '@x']) {
    assert.ok(preview.report.csvCell(hostile).startsWith("'"), `${hostile} is neutralised`);
  }
  assert.ok(csv.startsWith('﻿'), 'the CSV keeps its BOM');
});

test('EXPORT-07-THE-CSV-IS-ONE-DOCUMENTED-DATASET', () => {
  const header = csv.replace(/^﻿/, '').split('\r\n')[0];
  assert.equal(header, [...preview.report.WELFARE_COLUMNS].join(','),
    'the CSV remains the Welfare-window stream, not a dishonest flattening of three record types');
  const lines = csv.replace(/^﻿/, '').trimEnd().split('\r\n');
  assert.equal(lines.length, preview.built.welfare.length + 1);
});

console.log(`\n${passed} export proof checks passed`);
