#!/usr/bin/env node
/**
 * Writes one real CSV and one real XLSX from the control-room preview fixture. (Phase 4A.2 §10.)
 *
 * It calls the same `buildOperationsReport` / `toCsv` / `buildXlsx` the Export ▾ menu calls, with the same
 * two sheets and the same filename rule, so the files produced here are byte-for-byte what a controller
 * downloads — and they come from the SAME seven rows the screenshots show, so the board and the file can be
 * compared row by row.
 *
 *   node scripts/operations-export-sample.cjs [outDir]
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');
const { FIXTURE, NOW, LONDON } = require('./operations-timeline-preview.cjs');

const OUT_DIR = process.argv[2] || path.join(ROOT, 'preview');

const report = loadTs('src/components/company/operationsReport.ts');
const { buildXlsx } = loadTs('src/components/company/xlsxWriter.ts');
const {
  buildOperationsReport, operationsReportFilename, reportDateFor, toCsv,
  SUMMARY_COLUMNS, WELFARE_COLUMNS,
} = report;

// The scope the workspace passes: the operational date on the site clock, and the site name only when one
// site is selected. This fixture spans three sites, so there is no site in the filename.
const scope = { date: reportDateFor(new Date(NOW).toISOString(), LONDON), siteName: null };

const built = buildOperationsReport(FIXTURE, scope);

fs.mkdirSync(OUT_DIR, { recursive: true });

const csvName = operationsReportFilename(scope, 'csv');
const csv = toCsv(built);
// UTF-8, exactly as the browser Blob writes it: the leading BOM in `toCsv` becomes EF BB BF, which is what
// makes Excel open the file in Unicode rather than the machine's code page.
fs.writeFileSync(path.join(OUT_DIR, csvName), csv, 'utf8');

const xlsxName = operationsReportFilename(scope, 'xlsx');
const xlsx = buildXlsx([
  { name: 'Operations Summary', rows: [[...SUMMARY_COLUMNS], ...built.summary] },
  { name: 'Welfare Detail', rows: [[...WELFARE_COLUMNS], ...built.welfare] },
]);
fs.writeFileSync(path.join(OUT_DIR, xlsxName), Buffer.from(xlsx));

const csvLines = csv.split('\r\n').filter((line) => line !== '');

console.log('scope date   :', scope.date, `(${LONDON})`);
console.log('fixture rows :', FIXTURE.length, 'shifts');
console.log();
console.log('CSV  ', csvName);
console.log('       ', csvLines.length, 'lines =', 1, 'header +', built.welfare.length, 'Welfare window rows');
console.log('       ', WELFARE_COLUMNS.length, 'columns,', fs.statSync(path.join(OUT_DIR, csvName)).size, 'bytes');
console.log();
console.log('XLSX ', xlsxName);
console.log('       ', 'sheet "Operations Summary":', built.summary.length + 1, 'rows =', 1, 'header +', built.summary.length, 'shift rows,', SUMMARY_COLUMNS.length, 'columns');
console.log('       ', 'sheet "Welfare Detail"    :', built.welfare.length + 1, 'rows =', 1, 'header +', built.welfare.length, 'Welfare window rows,', WELFARE_COLUMNS.length, 'columns');
console.log('       ', fs.statSync(path.join(OUT_DIR, xlsxName)).size, 'bytes');
