#!/usr/bin/env node
/**
 * UAT FIX 01 — the Daily Site Log opened a BLANK PAGE in production.
 *
 * ROOT CAUSE, proven at runtime rather than inferred: `printIncidentReport` called
 *
 *     window.open('', '_blank', 'noopener,noreferrer,width=900,height=1200')
 *
 * and `window.open()` with `noopener` is specified to return null — severing the handle is the
 * entire purpose of the flag. Chrome does exactly that: with pop-up blocking disabled, so the flag
 * is the only variable, the call above returns null while the same call without it returns a window
 * whose document can be written. The browser still opened the tab, so the report was never written
 * into it and the user saw a blank page.
 *
 * This suite drives the REAL path against the REAL production shape — site 14 "test site",
 * 2026-09-30, Shift #19, one log_book entry at 20:34 London, AS REQUIRED — through a fake `window`
 * that behaves the way a browser does, including returning null when `noopener` is passed. It fails
 * against the deployed source and passes against the fix, and it renders twice because this codebase
 * has been bitten by first-render-only assertions before.
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
const print = loadTs('src/components/company/incidentReportPrint.ts');
const siteTime = loadTs('src/services/siteTime.ts');

const LONDON = 'Europe/London';
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log('PASS ', name); }
  catch (error) { console.error('FAIL ', name); console.error(error.message); process.exitCode = 1; }
};

// ─── the production shape, read-only from the live records ───────────────────
//
// Site 14 "test site", logBookIntervalMinutes NULL (AS REQUIRED), Europe/London.
// Shift #19 runs 19:35–20:35 UTC on 2026-09-30 and is still `in_progress`.
// One log_book row, id 7, at 19:34 UTC = 20:34 London — the entry the owner sees.
// Nothing is fabricated: no Log Book windows, no attendance projection, no evidence.

const SITE = { id: 14, name: 'test site', clientName: null, client: null, timezone: LONDON };
const SHIFT_19 = {
  id: 19, siteId: 14, siteName: 'test site', site: SITE,
  start: '2026-09-30T19:35:00.000Z', end: '2026-09-30T20:35:00.000Z',
  status: 'in_progress', guard: { id: 20, fullName: 'Fahad test' },
  closeOutNotes: null,
};
const LOG_7 = {
  id: 7, logType: 'log_book', message: 'Shift started 20.33 patrol done',
  createdAt: '2026-09-30T19:34:00.000Z', shift: SHIFT_19, guard: SHIFT_19.guard,
};

/**
 * The operations projection as production would return it for a day-old shift: AS REQUIRED, no
 * windows, and a Book On but no Book Off because the shift is still in progress.
 */
const OPS_19 = {
  bookOnAt: '2026-09-30T19:36:00.000Z',
  bookOffAt: null,
  timezone: LONDON,
  missingBookOff: true,
  welfare: { enabled: false, requiredCount: 0, completedCount: 0, missedCount: 0, windows: [] },
  logBook: {
    required: false, intervalMinutes: null, currentWindow: null, currentWindowSubmitted: false,
    windows: [], requiredCount: 0, submittedCount: 0, missingCount: 0,
    lastEntryAt: '2026-09-30T19:34:00.000Z',
  },
};

/** The harsher production case: the projection has aged this shift out entirely. */
const OPS_ABSENT = new Map();

const buildModel = (operations) => dsl.buildDailySiteLog({
  siteId: 14,
  dateKey: '2026-09-30',
  dateLabel: siteTime.formatUkDate('2026-09-30T12:00:00.000Z', LONDON, '2026-09-30'),
  timeZone: LONDON,
  companyName: 'vesoft Test Company',
  shifts: [SHIFT_19],
  operationsByShiftId: operations,
  dailyLogs: [LOG_7],
  incidents: [],
  alerts: [],
});

// ─── a browser-shaped fake window ────────────────────────────────────────────

/**
 * `window.open` as Chrome implements it.
 *
 * The one behaviour that matters: `noopener` in the feature string returns null. Everything else is
 * just enough document to record what was written.
 */
function makeWindow() {
  const opened = [];
  const win = {
    open(url, target, features) {
      const noopener = /\bnoopener\b/.test(String(features || ''));
      opened.push({ url, target, features, noopener });
      if (noopener) return null; // exactly what a browser does
      let buffer = '';
      let closed = false;
      const frame = {
        document: {
          readyState: 'complete',
          open() { buffer = ''; },
          write(html) { buffer += html; },
          close() { closed = true; },
        },
        focus() {},
        print() { frame.printed = true; },
        addEventListener() {},
        printed: false,
        get written() { return buffer; },
        get documentClosed() { return closed; },
      };
      opened[opened.length - 1].frame = frame;
      return frame;
    },
    opened,
  };
  return win;
}

function withWindow(win, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previous = globalThis.window;
  globalThis.window = win;
  try { return run(); } finally {
    if (had) globalThis.window = previous; else delete globalThis.window;
  }
}

// ─── the regression ──────────────────────────────────────────────────────────

test('DSL-01-THE-REPORT-WINDOW-IS-ACTUALLY-WRITTEN', () => {
  const html = dslPrint.renderDailySiteLogHtml(buildModel(new Map([[19, OPS_19]])), {
    generatedAt: '03-10-2026 · 09:15',
  });
  assert.ok(html.length > 2000, 'the document itself is substantial');

  const win = makeWindow();
  const ok = withWindow(win, () => print.printIncidentReport(html));

  assert.equal(ok, true, 'printIncidentReport reports success');
  assert.equal(win.opened.length, 1, 'exactly one window is opened');
  assert.equal(win.opened[0].noopener, false, 'opened WITHOUT noopener, or the handle would be null');

  const frame = win.opened[0].frame;
  assert.ok(frame, 'a usable window handle came back');
  assert.ok(frame.written.length > 2000, 'the document was written into it — not a blank page');
  assert.equal(frame.documentClosed, true, 'and the document was closed');
  assert.match(frame.written, /Daily Site Log/);
  assert.match(frame.written, /test site/);
  assert.match(frame.written, /Shift started 20\.33 patrol done/, 'the real entry is in the page');
});

test('DSL-02-NOOPENER-IS-THE-DEFECT-AND-IS-GONE', () => {
  // The mutation, executed: a window.open WITH noopener yields null and nothing is written.
  const win = makeWindow();
  const asDeployed = win.open('', '_blank', 'noopener,noreferrer,width=900,height=1200');
  assert.equal(asDeployed, null, 'noopener severs the handle — this is what produced the blank page');

  /**
   * The shipped CODE must not ask for it.
   *
   * Comments are stripped first: the fix carries a comment quoting the defective call verbatim, and
   * an assertion that matched that would pass no matter what the code did.
   */
  const source = fs.readFileSync(path.join(ROOT, 'src/components/company/incidentReportPrint.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const callAt = source.indexOf('window.open(');
  assert.ok(callAt > 0, 'the call was located in code');
  const call = source.slice(callAt, callAt + 120);
  assert.ok(!/noopener/.test(call), `the shipped call does not pass noopener — got: ${call.split('\n')[0]}`);
  assert.ok(!/noreferrer/.test(call), 'nor noreferrer, which implies it');
});

test('DSL-03-THE-PRODUCTION-SHAPE-RENDERS-A-REAL-REPORT', () => {
  const model = buildModel(new Map([[19, OPS_19]]));

  // The day is not empty: the entry and the Book On are both there.
  assert.ok(model.events.some((e) => e.kind === 'log_book' && e.detail === 'Shift started 20.33 patrol done'));
  assert.ok(model.events.some((e) => e.kind === 'book_on'));
  assert.equal(model.siteName, 'test site');
  assert.equal(model.shifts.length, 1);
  assert.equal(model.shifts[0].shiftId, 19);

  // AS REQUIRED, told honestly — no manufactured periods, no "0 missing".
  assert.equal(model.logBook.scheduled, false);
  assert.equal(model.logBook.entries, 1);
  assert.deepEqual(model.periods, []);

  const html = dslPrint.renderDailySiteLogHtml(model, { generatedAt: '03-10-2026 · 09:15' });
  assert.match(html, /As required/);
  assert.ok(!/Missing periods/.test(html));
  assert.match(html, /Book On/);
  assert.match(html, /Missing Book Off|Not booked on|On site/, 'the attendance state is stated');
  for (const leak of ['undefined', 'NaN', 'Invalid Date', '[object Object]']) {
    assert.ok(!html.includes(leak), `the page never renders "${leak}"`);
  }
});

test('DSL-04-A-MISSING-OPERATIONS-PROJECTION-STILL-RENDERS', () => {
  /**
   * The projection ages a shift out after about a day, so by the time a client asks for last week's
   * Daily Site Log there may be no operations row at all. That must degrade, not blank: the Log Book
   * entries are still stored and still belong in the occurrence record.
   */
  const model = buildModel(OPS_ABSENT);
  assert.equal(model.shifts.length, 1, 'the shift is still listed');
  assert.equal(model.shifts[0].bookOn, dsl.NOT_RECORDED, 'with its attendance honestly absent');
  assert.equal(model.shifts[0].state, dsl.NOT_RECORDED);
  assert.ok(
    model.events.some((e) => e.kind === 'log_book'),
    'and the Log Book entry is still an occurrence',
  );
  assert.equal(model.logBook.scheduled, false, 'no obligation is invented from a missing projection');

  const html = dslPrint.renderDailySiteLogHtml(model, { generatedAt: '03-10-2026 · 09:15' });
  assert.match(html, /Shift started 20\.33 patrol done/);
  for (const leak of ['undefined', 'NaN', 'Invalid Date']) {
    assert.ok(!html.includes(leak), `no "${leak}"`);
  }
});

test('DSL-05-A-SECOND-RENDER-BEHAVES-IDENTICALLY', () => {
  // Not an initial-render-only fix: build and print twice, from scratch and from the same model.
  const first = buildModel(new Map([[19, OPS_19]]));
  const second = buildModel(new Map([[19, OPS_19]]));
  assert.deepEqual(
    second.events.map((e) => `${e.kind}@${e.at}`),
    first.events.map((e) => `${e.kind}@${e.at}`),
    'two builds of the same day agree',
  );

  const html = dslPrint.renderDailySiteLogHtml(first, { generatedAt: '03-10-2026 · 09:15' });
  const win = makeWindow();
  withWindow(win, () => {
    assert.equal(print.printIncidentReport(html), true, 'first print succeeds');
    assert.equal(print.printIncidentReport(html), true, 'second print succeeds too');
  });
  assert.equal(win.opened.length, 2, 'two windows, both real');
  for (const entry of win.opened) {
    assert.equal(entry.noopener, false);
    assert.ok(entry.frame.written.length > 2000, 'each one received the document');
  }
});

// ─── UK date display ─────────────────────────────────────────────────────────

test('DSL-06-UK-DATE-FORMAT-ON-THE-LOG-BOOK-SURFACES', () => {
  assert.equal(siteTime.formatUkDate('2026-09-30T19:34:00.000Z', LONDON), '30-09-2026');
  assert.equal(siteTime.formatUkDateTime('2026-09-30T19:34:00.000Z', LONDON), '30-09-2026 · 20:34');
  // Same day: the date is stated once.
  assert.equal(
    siteTime.formatUkRange('2026-09-30T19:35:00.000Z', '2026-09-30T20:35:00.000Z', LONDON),
    '30-09-2026 · 20:35–21:35',
  );
  // Overnight: both calendar dates, because the change of day is the point.
  assert.equal(
    siteTime.formatUkRange('2026-09-30T19:00:00.000Z', '2026-10-01T07:00:00.000Z', LONDON),
    '30-09-2026 · 20:00 – 01-10-2026 · 08:00',
  );
  // Absent input stays absent rather than becoming a wrong date.
  assert.equal(siteTime.formatUkDate(null, LONDON), '—');
  assert.equal(siteTime.formatUkRange('2026-09-30T19:00:00.000Z', null, LONDON), '—');

  // And it reaches the report.
  const model = buildModel(new Map([[19, OPS_19]]));
  assert.equal(model.dateLabel, '30-09-2026');
  assert.equal(model.shifts[0].scheduled, '30-09-2026 · 20:35–21:35');
  const html = dslPrint.renderDailySiteLogHtml(model, { generatedAt: '03-10-2026 · 09:15' });
  assert.match(html, /30-09-2026/);
  assert.match(html, /Report generated 03-10-2026 · 09:15/);
});

test('DSL-07-INTERNAL-DATE-FORMATS-ARE-STILL-ISO', () => {
  /**
   * Display only. A filter key, a date input value, a report scope and a filename all stay ISO —
   * swapping those for DD-MM-YYYY would break sorting, comparison and deterministic naming.
   */
  const model = buildModel(new Map([[19, OPS_19]]));
  assert.equal(model.dateKey, '2026-09-30', 'the key the register filters on stays ISO');

  const workspace = fs.readFileSync(path.join(ROOT, 'src/components/company/CompanyLogBookWorkspace.tsx'), 'utf8');
  assert.match(workspace, /placeholder="YYYY-MM-DD"/, 'the date input still takes ISO');

  const screen = fs.readFileSync(path.join(ROOT, 'src/screens/CompanyDashboardScreen.tsx'), 'utf8');
  assert.match(screen, /function todaySiteDayKey/, 'and the default day key is ISO');
  const keyFn = screen.slice(screen.indexOf('function todaySiteDayKey'), screen.indexOf('function todaySiteDayKey') + 420);
  assert.match(keyFn, /en-CA/, 'en-CA yields YYYY-MM-DD');

  const report = loadTs('src/components/company/operationsReport.ts');
  assert.match(
    report.operationsReportFilename({ date: '2026-09-30', siteName: 'test site' }, 'xlsx'),
    /2026-09-30\.xlsx$/,
    'the filename keeps the ISO date',
  );

  // The register's own day bucketing is still ISO.
  const reg = loadTs('src/components/company/logBookRegister.ts');
  assert.equal(reg.siteDayKey('2026-09-30T19:34:00.000Z', LONDON), '2026-09-30');
});

test('DSL-08-THE-INCIDENT-REPORT-KEEPS-ITS-OWN-DATE-STYLE', () => {
  // The owner asked for UK format on the Log Book workflow, not on the Incident Report.
  const incidentReport = fs.readFileSync(path.join(ROOT, 'src/components/company/incidentReport.ts'), 'utf8');
  const whenFn = incidentReport.slice(incidentReport.indexOf('const WHEN ='), incidentReport.indexOf('const WHEN =') + 160);
  assert.match(whenFn, /formatInstantDateTime/, 'the Incident Report still formats its own way');

  const report = loadTs('src/components/company/incidentReport.ts');
  const model = report.buildIncidentReport({
    id: 4, title: 'Broken fence', notes: 'Broken fence', severity: 'medium', category: 'other',
    status: 'open', reportedAt: '2026-09-30T19:49:00.000Z', createdAt: '2026-09-30T19:49:00.000Z',
    shift: SHIFT_19, site: SITE, guard: SHIFT_19.guard, company: null,
  }, [], [], LONDON);
  const reported = model.overview.find((f) => f.label === 'Reported').value;
  assert.match(reported, /Sept 2026/, 'still "Wed, 30 Sept 2026 · 20:49", unchanged');
  assert.ok(!/30-09-2026/.test(reported), 'and not restyled as collateral');
});

console.log(`\n${passed} Daily Site Log runtime checks passed`);
