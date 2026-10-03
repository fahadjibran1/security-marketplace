#!/usr/bin/env node
/**
 * Renders the REAL Log Book surfaces, and writes the REAL export files, from one local fixture.
 *
 * The register, the entry drawer, the printed Daily Site Log, the CSV and the XLSX are all produced
 * from the same rows here, so a screenshot and a spreadsheet cannot show different days.
 *
 * The fixture is invented for this file: two sites (one hourly, one as required), several guards, an
 * overnight shift, a missed period, Welfare Checks, an incident, a Site Request, an emergency, Book
 * On/Off and a very long entry. No production record is used.
 *
 *   node scripts/log-book-preview.cjs [outDir]
 */
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};
if (typeof globalThis.document === 'undefined') globalThis.document = {};

const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { loadTs, ROOT } = require('./load-ts.cjs');

const OUT_DIR = process.argv[2] || path.join(ROOT, 'preview-log-book');
const LONDON = 'Europe/London';
const GENERATED = '01-10-2026 · 09:15';

const reg = loadTs('src/components/company/logBookRegister.ts');
const dsl = loadTs('src/components/company/dailySiteLog.ts');
const dslPrint = loadTs('src/components/company/dailySiteLogPrint.ts');
const report = loadTs('src/components/company/operationsReport.ts');
const { buildXlsx } = loadTs('src/components/company/xlsxWriter.ts');
const { CompanyLogBookWorkspace } = loadTs('src/components/company/CompanyLogBookWorkspace.tsx');
const { CompanyLogBookEntryDrawer } = loadTs('src/components/company/CompanyLogBookEntryDrawer.tsx');

// ─── fixture ──────────────────────────────────────────────────────────────────

const SITE_A = { id: 14, name: 'Northgate Retail Park', clientName: 'Northgate Estates', client: { id: 1, name: 'Northgate Estates' }, timezone: LONDON };
const SITE_B = { id: 15, name: 'Quayside Logistics', clientName: 'Quayside Freight', client: { id: 2, name: 'Quayside Freight' }, timezone: LONDON };

const SHIFT_A = {
  id: 19, siteId: 14, siteName: SITE_A.name, site: SITE_A,
  start: '2026-09-30T18:00:00.000Z', end: '2026-09-30T22:00:00.000Z', status: 'completed',
  guard: { id: 20, fullName: 'Fahad Test' },
  closeOutNotes: 'Site secure at hand over. North gate padlock stiff — reported to the client for replacement.',
};
const SHIFT_B = {
  id: 24, siteId: 15, siteName: SITE_B.name, site: SITE_B,
  start: '2026-09-30T21:00:00.000Z', end: '2026-10-01T05:00:00.000Z', status: 'completed',
  guard: { id: 21, fullName: 'Bea Guard' },
};

const LONG_ENTRY = 'Full perimeter patrol completed from the main gate anticlockwise. '
  + 'Fence line intact along the north and east boundaries. Two pallets had been left against the '
  + 'rear shutter by the late delivery; moved clear of the fire exit and photographed for the day '
  + 'team. Lighting column 7 is still out — third night running, reported again. All doors and '
  + 'shutters checked and secure, alarm panel showing normal.';

const mk = (id, shift, logType, message, iso) => ({
  id, logType, message, createdAt: iso, shift, guard: shift.guard,
});

const LOGS = [
  mk(101, SHIFT_A, 'log_book', 'Booked on, handover received from day team. All keys accounted for.', '2026-09-30T18:05:00.000Z'),
  mk(102, SHIFT_A, 'welfare_check', 'All good', '2026-09-30T18:32:00.000Z'),
  mk(103, SHIFT_A, 'log_book', LONG_ENTRY, '2026-09-30T20:12:00.000Z'),
  mk(104, SHIFT_A, 'observation', 'Delivery van turned in the car park', '2026-09-30T20:40:00.000Z'),
  mk(105, SHIFT_A, 'welfare_check', 'All good', '2026-09-30T20:35:00.000Z'),
  mk(106, SHIFT_B, 'log_book', 'Yard sweep complete, trailers 4 and 7 sealed.', '2026-09-30T21:30:00.000Z'),
  mk(107, SHIFT_B, 'log_book', 'Night check — gatehouse manned, no movement.', '2026-10-01T01:10:00.000Z'),
];

const win = (index, start, end, state, completedAt) => ({
  index, start, end, state, applicable: true, completedAt: completedAt || null,
  completionCount: completedAt ? 1 : 0,
});

const OPS_A = {
  bookOnAt: '2026-09-30T17:58:00.000Z', bookOffAt: '2026-09-30T22:04:00.000Z',
  timezone: LONDON, missingBookOff: false,
  welfare: { enabled: true, requiredCount: 4, completedCount: 2, missedCount: 2, windows: [] },
  logBook: {
    required: true, intervalMinutes: 60, currentWindow: null, currentWindowSubmitted: false,
    requiredCount: 4, submittedCount: 2, missingCount: 2, lastEntryAt: '2026-09-30T20:12:00.000Z',
    windows: [
      win(0, '2026-09-30T18:00:00.000Z', '2026-09-30T19:00:00.000Z', 'completed', '2026-09-30T18:05:00.000Z'),
      win(1, '2026-09-30T19:00:00.000Z', '2026-09-30T20:00:00.000Z', 'missed'),
      win(2, '2026-09-30T20:00:00.000Z', '2026-09-30T21:00:00.000Z', 'completed', '2026-09-30T20:12:00.000Z'),
      win(3, '2026-09-30T21:00:00.000Z', '2026-09-30T22:00:00.000Z', 'missed'),
    ],
  },
};

const OPS_B = {
  bookOnAt: '2026-09-30T20:55:00.000Z', bookOffAt: '2026-10-01T05:06:00.000Z',
  timezone: LONDON, missingBookOff: false,
  welfare: { enabled: false, requiredCount: 0, completedCount: 0, missedCount: 0, windows: [] },
  logBook: {
    required: false, intervalMinutes: null, currentWindow: null, currentWindowSubmitted: false,
    requiredCount: 0, submittedCount: 0, missingCount: 0, lastEntryAt: '2026-10-01T01:10:00.000Z',
    windows: [],
  },
};

const OPS = new Map([[19, OPS_A], [24, OPS_B]]);
const SHIFTS_BY_ID = new Map([[19, SHIFT_A], [24, SHIFT_B]]);

const INCIDENTS = [{
  id: 4, title: 'Broken fence panel, north boundary', notes: 'Fence panel pushed in near column 7.',
  severity: 'medium', category: 'damage', status: 'resolved',
  reportedAt: '2026-09-30T19:49:00.000Z', createdAt: '2026-09-30T19:49:00.000Z',
  reviewedAt: '2026-09-30T20:30:00.000Z', closedAt: null,
  resolutionReason: 'client_informed', resolutionNote: 'Client informed; contractor booked.',
  shift: SHIFT_A, site: SITE_A, guard: SHIFT_A.guard, company: { id: 8, name: 'vesoft Test Company' },
}];

const ALERTS = [
  { id: 9, type: 'site_request', message: 'Need replacement log sheets and two torches', status: 'closed', createdAt: '2026-09-30T18:40:00.000Z', closedAt: '2026-09-30T19:10:00.000Z', shift: SHIFT_A, guard: SHIFT_A.guard },
  { id: 10, type: 'panic', message: 'Emergency alert raised by guard from the mobile app.', status: 'closed', createdAt: '2026-09-30T21:15:00.000Z', closedAt: '2026-09-30T21:25:00.000Z', shift: SHIFT_A, guard: SHIFT_A.guard },
];

const ROWS = reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, { date: '2026-09-30' });
/** The register as the dashboard builds it when a site is chosen — filters and rows must agree. */
const ROWS_SITE_A = reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, { date: '2026-09-30', siteId: 14 });
const PERIODS = reg.logBookPeriods(OPS_A).map((p) => ({
  ...p, shiftId: 19, siteName: SITE_A.name,
  startLabel: hhmm(p.start), endLabel: hhmm(p.end),
  completedLabel: p.completedAt ? hhmm(p.completedAt) : '',
}));

function hhmm(iso) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(iso));
}

// ─── pages ────────────────────────────────────────────────────────────────────

function withInlineModal(render) {
  const RNW = require('react-native-web');
  const realModal = RNW.Modal;
  RNW.Modal = ({ visible, children }) => (visible === false ? null : React.createElement(RNW.View, null, children));
  try { return render(); } finally { RNW.Modal = realModal; }
}

function page(title, body) {
  const RNW = require('react-native-web');
  const { AppRegistry } = RNW;
  AppRegistry.registerComponent('LogBookPreview', () => () =>
    React.createElement(
      RNW.View,
      { style: { padding: 16, backgroundColor: '#F4F7FA', gap: 12 } },
      React.createElement(RNW.Text, { style: { fontSize: 19, fontWeight: '800', color: '#0B1F33' } }, title),
      body(),
    ));
  const { element, getStyleElement } = AppRegistry.getApplication('LogBookPreview', {});
  const { renderToStaticMarkup } = require('react-dom/server');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>S4 — ${title}</title>
<style>html,body{margin:0;padding:0;background:#F4F7FA;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;}</style>
${renderToStaticMarkup(getStyleElement())}
</head><body><div id="root">${renderToStaticMarkup(element)}</div></body></html>`;
}

const registerProps = (over = {}) => ({
  rows: ROWS_SITE_A, periods: PERIODS, date: '2026-09-30',
  onDateChange: () => {}, search: '', onSearchChange: () => {},
  clientOptions: [{ label: 'Northgate Estates', value: 'Northgate Estates' }, { label: 'Quayside Freight', value: 'Quayside Freight' }],
  siteOptions: [{ label: SITE_A.name, value: '14' }, { label: SITE_B.name, value: '15' }],
  guardOptions: [{ label: 'Fahad Test', value: '20' }, { label: 'Bea Guard', value: '21' }],
  clientFilter: '', siteFilter: '14', guardFilter: '',
  onClientFilter: () => {}, onSiteFilter: () => {}, onGuardFilter: () => {},
  onOpenEntry: () => {}, onOpenDailySiteLog: () => {}, dailySiteLogEnabled: true,
  timeLabel: hhmm,
  ...over,
});

const dayModel = (shifts, siteId) => dsl.buildDailySiteLog({
  siteId, dateKey: '2026-09-30', dateLabel: '30-09-2026', timeZone: LONDON,
  companyName: 'vesoft Test Company',
  shifts, operationsByShiftId: OPS, dailyLogs: LOGS, incidents: INCIDENTS, alerts: ALERTS,
});

fs.mkdirSync(OUT_DIR, { recursive: true });

const pages = [
  ['register.html', () => page('Management → Log Book', () =>
    React.createElement(CompanyLogBookWorkspace, registerProps()))],
  ['register-as-required.html', () => page('Log Book — as required site', () =>
    React.createElement(CompanyLogBookWorkspace, registerProps({
      rows: reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, { date: '2026-09-30', siteId: 15 }),
      periods: [], siteFilter: '15',
    })))],
  ['entry-detail.html', () => withInlineModal(() => page('Log Book entry', () =>
    React.createElement(CompanyLogBookEntryDrawer, {
      entry: {
        ...ROWS.find((r) => r.id === 103),
        scheduledShift: '30-09-2026 · 19:00–23:00',
        recordedAt: '30-09-2026 · 21:12',
        periodLabel: '21:00–22:00',
      },
      onClose: () => {},
    })))],
];

for (const [name, build] of pages) {
  fs.writeFileSync(path.join(OUT_DIR, name), build());
  console.log('wrote', path.join(OUT_DIR, name));
}

// The printed A4 documents.
for (const [name, shifts, siteId] of [
  ['print-daily-site-log.html', [SHIFT_A], 14],
  ['print-as-required.html', [SHIFT_B], 15],
]) {
  fs.writeFileSync(
    path.join(OUT_DIR, name),
    dslPrint.renderDailySiteLogHtml(dayModel(shifts, siteId), { generatedAt: GENERATED }),
  );
  console.log('wrote', path.join(OUT_DIR, name));
}

// ─── export artefacts ─────────────────────────────────────────────────────────

const inputs = [
  { shift: SHIFT_A, operations: OPS_A, logs: LOGS.filter((l) => l.shift.id === 19), attendance: { checkInAt: OPS_A.bookOnAt, checkOutAt: OPS_A.bookOffAt }, incidents: INCIDENTS, alerts: ALERTS },
  { shift: SHIFT_B, operations: OPS_B, logs: LOGS.filter((l) => l.shift.id === 24), attendance: { checkInAt: OPS_B.bookOnAt, checkOutAt: OPS_B.bookOffAt }, incidents: [], alerts: [] },
];
const built = report.buildOperationsReport(inputs, { date: '2026-09-30', siteName: null });

fs.writeFileSync(path.join(OUT_DIR, 'operations.csv'), report.toCsv(built), 'utf8');
const bytes = buildXlsx([
  { name: 'Operations Summary', rows: [[...report.SUMMARY_COLUMNS], ...built.summary] },
  { name: 'Welfare Detail', rows: [[...report.WELFARE_COLUMNS], ...built.welfare] },
  { name: 'Log Book', rows: [[...report.LOG_BOOK_COLUMNS], ...built.logBook] },
]);
fs.writeFileSync(path.join(OUT_DIR, 'operations.xlsx'), Buffer.from(bytes));

console.log('\nlog book rows :', built.logBook.length);
console.log('summary rows  :', built.summary.length);
console.log('welfare rows  :', built.welfare.length);
console.log('xlsx bytes    :', bytes.length);

module.exports = { built, bytes, ROWS, PERIODS, dayModel, SHIFT_A, SHIFT_B, LONG_ENTRY, report };
