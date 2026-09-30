#!/usr/bin/env node
/**
 * Renders the REAL Operations Timeline to a standalone HTML page for visual review. (Phase 4A.2 §7/§8.)
 *
 * Not a mock-up. It imports `CompanyOperationsTimeline` itself and renders it through react-native-web's
 * AppRegistry, which is what produces the component's actual stylesheet — so what the browser shows is the
 * component as shipped, with its real layout, spacing and colours.
 *
 * The fixture is deterministic and local. It never touches production: no API client is loaded, no network
 * call is made, and the data below exists only in this file.
 *
 *   node scripts/operations-timeline-preview.cjs [outDir]
 *
 * The pages are plain static HTML, so a desktop screenshot at an exact width needs no tooling beyond the
 * browser that is already installed:
 *
 *   chrome.exe --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
 *     --window-size=1366,1000 --screenshot=timeline-8h-1366.png <outDir>/timeline-8h.html
 *
 * --window-size IS the CSS viewport, so 1366 / 1440 / 1920 are true desktop widths rather than whatever the
 * developer's window happens to be.
 */
// The component imports react-native, which ships as Flow source and cannot be required in Node. Point it
// at react-native-web, which is what the browser bundle uses anyway — so the preview renders the same
// component the web control room does.
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};

const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { loadTs, ROOT } = require('./load-ts.cjs');

const OUT_DIR = process.argv[2] || path.join(ROOT, 'preview');

// ─── the deterministic control-room fixture ──────────────────────────────────
// Wednesday 30 September 2026, 20:50 London (BST, so 19:50Z). Three sites, seven rows, every marker state,
// every attendance state, an overnight shift and two guards overlapping at one site.

const NOW = Date.parse('2026-09-30T19:50:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const LONDON = 'Europe/London';
const iso = (ms) => new Date(ms).toISOString();

/** Builds a welfare grid from a list of states, one per interval from `startMs`. */
const windows = (states, startMs, intervalMin) =>
  states.map((state, i) => ({
    index: i,
    start: iso(startMs + i * intervalMin * MIN),
    end: iso(startMs + (i + 1) * intervalMin * MIN),
    state,
    applicable: state !== 'not_applicable',
    completedAt: state === 'completed' ? iso(startMs + i * intervalMin * MIN + 3 * MIN) : null,
    completionCount: state === 'completed' ? 1 : 0,
  }));

/**
 * One operational row exactly as the workspace assembles it: the shift, its attendance, the authoritative
 * projection, and the evidence rows the same API response carries.
 *
 * The Welfare summary counts and the evidence logs are DERIVED from the window grid rather than typed in,
 * so the fixture cannot contradict itself — a completed window always has a log behind it, and the missed
 * count always equals the number of missed windows, which is what production guarantees.
 */
const shift = (o) => {
  const windows = o.windows ?? [];
  const completed = windows.filter((w) => w.state === 'completed');
  const applicable = windows.filter((w) => w.applicable);

  return {
    shift: {
      id: o.id,
      start: o.start,
      end: o.end,
      status: o.status,
      site: {
        id: o.siteId,
        name: o.siteName,
        timezone: o.tz || LONDON,
        client: { id: o.siteId, name: o.clientName },
      },
      guard: o.guard ? { fullName: o.guard } : undefined,
    },
    attendance: o.attendance,
    operations: o.windows
      ? {
          welfare: {
            enabled: true,
            intervalMinutes: o.interval,
            windows,
            requiredCount: applicable.length,
            completedCount: completed.length,
            missedCount: windows.filter((w) => w.state === 'missed').length,
          },
        }
      : null,
    // The Welfare Check a guard submits is a daily_log; the window it landed in is what turned green.
    logs: [
      ...completed.map((w, i) => ({
        id: o.id * 100 + i,
        shiftId: o.id,
        logType: 'welfare_check',
        createdAt: w.completedAt,
        message: 'All well.',
      })),
      ...(o.logBookEntries ?? []).map((createdAt, i) => ({
        id: o.id * 100 + 50 + i,
        shiftId: o.id,
        logType: 'log_book',
        createdAt,
        message: 'Perimeter walked, all clear.',
      })),
    ],
    incidents: o.incidents ?? [],
    alerts: o.alerts ?? [],
  };
};

/** The proven Shift #19 evening: 20:35–21:35, Book On 20:33, 15-minute Welfare, ✓ ! ✕ ●. */
const SHIFT_19_START = Date.parse('2026-09-30T19:35:00.000Z');

const FIXTURE = [
  // ── TEST SITE: the UAT shift, plus a second guard overlapping it. ─────────
  shift({
    id: 19, siteId: 7, siteName: 'TEST SITE', clientName: 'Northgate Retail', guard: 'Fahad test',
    start: iso(SHIFT_19_START), end: iso(SHIFT_19_START + HOUR), status: 'in_progress',
    attendance: { checkInAt: '2026-09-30T19:33:00.000Z', checkOutAt: null },
    interval: 15,
    windows: windows(['completed', 'overdue', 'missed', 'due'], SHIFT_19_START, 15),
    // The evidence the drawer lists for this shift, so the board, the drawer and the file agree.
    logBookEntries: ['2026-09-30T20:02:00.000Z'],
    incidents: [{ id: 401, shiftId: 19, status: 'open', title: 'Broken window, north side' }],
    alerts: [{ id: 501, shiftId: 19, type: 'missed_checkcall', status: 'open' }],
  }),
  shift({
    id: 20, siteId: 7, siteName: 'TEST SITE', clientName: 'Northgate Retail', guard: 'Ahmed Khan',
    start: iso(SHIFT_19_START + 25 * MIN), end: iso(SHIFT_19_START + 25 * MIN + 9 * HOUR),
    status: 'in_progress',
    attendance: { checkInAt: iso(SHIFT_19_START + 23 * MIN), checkOutAt: null },
    interval: 30,
    windows: windows(['completed', 'completed', 'due', 'not_applicable'], SHIFT_19_START + 25 * MIN, 30),
  }),

  // ── MERCHANT FIELDS: a late guard, an upcoming one, and an overnight shift. ─
  shift({
    id: 21, siteId: 9, siteName: 'MERCHANT FIELDS', clientName: 'Merchant Holdings', guard: 'Priya Sharma',
    start: iso(NOW - 40 * MIN), end: iso(NOW + 7 * HOUR), status: 'ready',
    attendance: undefined, // never booked on — LATE
  }),
  shift({
    id: 22, siteId: 9, siteName: 'MERCHANT FIELDS', clientName: 'Merchant Holdings', guard: 'Tom Whelan',
    start: iso(NOW + 70 * MIN), end: iso(NOW + 9 * HOUR), status: 'ready',
    attendance: undefined, // UPCOMING
  }),
  shift({
    id: 23, siteId: 9, siteName: 'MERCHANT FIELDS', clientName: 'Merchant Holdings', guard: 'Night Cover',
    start: '2026-09-30T19:00:00.000Z', end: '2026-10-01T07:00:00.000Z', status: 'in_progress',
    attendance: { checkInAt: '2026-09-30T18:58:00.000Z', checkOutAt: null },
    interval: 60,
    windows: windows(['completed', 'completed', 'completed', 'due'], Date.parse('2026-09-30T19:00:00.000Z'), 60),
  }),

  // ── RIVERSIDE DEPOT: a finished shift and an uncovered one. ────────────────
  shift({
    id: 24, siteId: 11, siteName: 'RIVERSIDE DEPOT', clientName: 'Riverside Logistics', guard: 'Dan Obi',
    start: iso(NOW - 3 * HOUR), end: iso(NOW - 20 * MIN), status: 'completed',
    attendance: { checkInAt: iso(NOW - 3 * HOUR - 2 * MIN), checkOutAt: iso(NOW - 18 * MIN) },
    interval: 60,
    windows: windows(['completed', 'completed', 'missed'], NOW - 3 * HOUR, 60),
  }),
  shift({
    id: 25, siteId: 11, siteName: 'RIVERSIDE DEPOT', clientName: 'Riverside Logistics', guard: null,
    start: iso(NOW + 2 * HOUR), end: iso(NOW + 10 * HOUR), status: 'unfilled',
    attendance: undefined, // COVERAGE GAP
  }),
];

/** One Attention Now item, pointing at the shift with the missed Welfare Check. */
const ATTENTION = {
  issueType: 'Missed Welfare Check',
  badge: 'Welfare',
  site: 'TEST SITE',
  guard: 'Fahad test',
  time: '21:20',
  shiftId: 19,
};

// ─── render ───────────────────────────────────────────────────────────────────


function renderPage({ rangeLabel, rangeHours, drawerOpen, highlightShiftId }) {
  const RNW = require('react-native-web');
  const { AppRegistry } = RNW;
  const { CompanyOperationsTimeline } = loadTs('src/components/company/CompanyOperationsTimeline.tsx');

  const Root = () =>
    React.createElement(
      RNW.View,
      // No 100vh here: the page must be exactly as tall as its content so the capture helper can fit the
      // whole board into the frame. The page background comes from the document stylesheet instead.
      { style: { padding: 16, backgroundColor: '#F4F7FA', gap: 12 } },
      // A minimal stand-in for the page chrome around the timeline, so the screenshot shows the
      // timeline in the position a controller sees it rather than floating alone.
      React.createElement(PageHeading),
      React.createElement(SummaryStrip),
      React.createElement(FilterStrip, { rangeLabel }),
      React.createElement(
        RNW.View,
        { style: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' } },
        React.createElement(
          RNW.View,
          { style: { flex: 1, minWidth: 0 } },
          React.createElement(CompanyOperationsTimeline, {
            inputs: FIXTURE,
            nowMs: NOW,
            headerTimeZone: LONDON,
            anchorMs: NOW,
            initialRangeHours: rangeHours,
            selectedShiftId: drawerOpen ? ATTENTION.shiftId : null,
            highlightedShiftId: highlightShiftId ?? null,
            onSelectShift: () => {},
            onExportCsv: () => {},
            onExportXlsx: () => {},
            exporting: false,
          }),
        ),
        React.createElement(AttentionRail, { highlighted: !!highlightShiftId }),
      ),
      drawerOpen ? React.createElement(DrawerStandIn) : null,
    );

  AppRegistry.registerComponent('Preview', () => Root);
  const { element, getStyleElement } = AppRegistry.getApplication('Preview', {});
  const { renderToStaticMarkup } = require('react-dom/server');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>S4 Operations Timeline — preview</title>
<style>html,body{margin:0;padding:0;background:#F4F7FA;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;}</style>
${renderToStaticMarkup(getStyleElement())}
</head><body><div id="root">${renderToStaticMarkup(element)}</div></body></html>`;
}

// ── page chrome stand-ins, so the timeline is shown in context ───────────────

function PageHeading() {
  const RNW = require('react-native-web');
  return React.createElement(
    RNW.View,
    { style: { gap: 2 } },
    React.createElement(RNW.Text, { style: { fontSize: 20, fontWeight: '800', color: '#0B1F33' } }, 'Live Operations'),
    React.createElement(RNW.Text, { style: { fontSize: 12, color: '#5A6B7B' } },
      'Monitor book-ons, Welfare Checks, and the Log Book.'),
  );
}

function SummaryStrip() {
  const RNW = require('react-native-web');
  const metrics = [
    ['Live Shifts', '3', '#0F817E'],
    ['Guards Not Booked On', '1', '#A15C07'],
    ['Open Incidents', '1', '#B42318'],
    ['Missed Welfare Checks', '2', '#B42318'],
    ['Active Emergency Alerts', '0', '#5A6B7B'],
  ];
  return React.createElement(
    RNW.View,
    { style: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' } },
    ...metrics.map(([label, value, tone]) =>
      React.createElement(
        RNW.View,
        { key: label, style: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D9E2EC', borderRadius: 8, minWidth: 150 } },
        React.createElement(RNW.Text, { style: { fontSize: 10, fontWeight: '700', color: '#5A6B7B', letterSpacing: 0.4 } }, label.toUpperCase()),
        React.createElement(RNW.Text, { style: { fontSize: 20, fontWeight: '800', color: tone } }, value),
      )),
  );
}

function FilterStrip({ rangeLabel }) {
  const RNW = require('react-native-web');
  const chip = (text, active) => React.createElement(
    RNW.View,
    { key: text, style: { paddingHorizontal: 10, paddingVertical: 7, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: active ? '#16A6A1' : '#CBD5E0', borderRadius: 8 } },
    React.createElement(RNW.Text, { style: { fontSize: 12, color: active ? '#0F817E' : '#5A6B7B', fontWeight: '600' } }, text),
  );
  return React.createElement(
    RNW.View,
    { style: { flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
    chip('Client', false), chip('Site', false), chip('Guard', false),
    React.createElement(
      RNW.View,
      { style: { flexDirection: 'row', gap: 4, alignItems: 'center' } },
      chip('‹', false),
      chip('2026-09-30', false),
      chip('›', false),
      chip('Today', true),
    ),
    chip('Status', false),
    React.createElement(RNW.Text, { style: { fontSize: 11, color: '#7B8794', marginLeft: 8 } }, `showing ${rangeLabel}`),
  );
}

function AttentionRail({ highlighted }) {
  const RNW = require('react-native-web');
  return React.createElement(
    RNW.View,
    { style: { width: 300, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D9E2EC', borderRadius: 12, overflow: 'hidden' } },
    React.createElement(
      RNW.View,
      { style: { paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#F7FAFC', borderBottomWidth: 1, borderBottomColor: '#D9E2EC', flexDirection: 'row', justifyContent: 'space-between' } },
      React.createElement(RNW.Text, { style: { fontSize: 13, fontWeight: '800', color: '#0B1F33' } }, 'Attention Now'),
      React.createElement(
        RNW.View,
        { style: { backgroundColor: '#B42318', borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1 } },
        React.createElement(RNW.Text, { style: { fontSize: 11, fontWeight: '800', color: '#FFFFFF' } }, '1'),
      ),
    ),
    React.createElement(
      RNW.View,
      { style: { padding: 12, gap: 4, backgroundColor: highlighted ? '#FFFAEB' : '#FFFFFF' } },
      React.createElement(
        RNW.View,
        { style: { flexDirection: 'row', alignItems: 'center', gap: 6 } },
        React.createElement(RNW.View, { style: { width: 8, height: 8, borderRadius: 999, backgroundColor: '#B42318' } }),
        React.createElement(RNW.Text, { style: { fontSize: 12, fontWeight: '800', color: '#B42318' } }, ATTENTION.issueType),
        React.createElement(RNW.Text, { style: { fontSize: 11, color: '#7B8794', marginLeft: 'auto' } }, ATTENTION.time),
      ),
      React.createElement(RNW.Text, { style: { fontSize: 11, color: '#5A6B7B' } }, `${ATTENTION.site} · ${ATTENTION.guard}`),
      React.createElement(
        RNW.View,
        { style: { flexDirection: 'row', gap: 6, marginTop: 6 } },
        React.createElement(
          RNW.View,
          { style: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#0B1F33', borderRadius: 8 } },
          React.createElement(RNW.Text, { style: { fontSize: 11, fontWeight: '700', color: '#FFFFFF' } }, 'View Safety Detail'),
        ),
        React.createElement(
          RNW.View,
          { style: { paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: '#CBD5E0', borderRadius: 8 } },
          React.createElement(RNW.Text, { style: { fontSize: 11, fontWeight: '700', color: '#5A6B7B' } }, 'Open Shift'),
        ),
      ),
    ),
  );
}

/**
 * Stands in for the Shift Operations drawer.
 *
 * The real Drawer renders through react-native Modal, which react-dom/server cannot serialise (it is a DOM
 * portal and comes out empty under static markup — the same limitation the Phase 2 modal tests documented).
 * This shows the drawer's real position and width so the screenshot answers the review question that
 * matters: how much of the timeline it covers.
 */
function DrawerStandIn() {
  const RNW = require('react-native-web');
  const section = (title, lines) => React.createElement(
    RNW.View,
    { key: title, style: { gap: 3, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#EDF2F7' } },
    React.createElement(RNW.Text, { style: { fontSize: 10, fontWeight: '800', color: '#5A6B7B', letterSpacing: 0.6 } }, title.toUpperCase()),
    ...lines.map((line) => React.createElement(RNW.Text, { key: line, style: { fontSize: 12, color: '#243B53' } }, line)),
  );

  return React.createElement(
    RNW.View,
    { style: { position: 'fixed', top: 0, right: 0, bottom: 0, width: 620, backgroundColor: '#FFFFFF', borderLeftWidth: 1, borderLeftColor: '#D9E2EC', padding: 18, gap: 2, boxShadow: '-8px 0 24px rgba(11,31,51,0.18)' } },
    React.createElement(RNW.Text, { style: { fontSize: 16, fontWeight: '800', color: '#0B1F33' } }, 'Shift Operations'),
    React.createElement(RNW.Text, { style: { fontSize: 12, color: '#5A6B7B', marginBottom: 6 } }, 'TEST SITE · Fahad test'),
    section('Operational monitoring', [
      'Welfare Check · OVERDUE · next due 21:05 · 1 min over',
      'Every 15 min · 1 completed · 1 missed',
      'Log Book · hourly · current entry submitted',
    ]),
    section('Attendance & timesheet', [
      'Book On 20:33 (scheduled 20:35)',
      'Book Off — · duration 17 min',
      'Timesheet: draft',
    ]),
    section('Daily logs', ['21:02 Log Book — perimeter walked, all clear', '20:38 Welfare Check — all well']),
    section('Incidents', ['20:55 Guard incident — broken window, north side (open)']),
    section('Safety alerts', ['21:20 Missed Welfare Check (open)']),
  );
}

// ─── write the pages ──────────────────────────────────────────────────────────

// Required as a module, this file is just the fixture — so the export proof and the screenshots are
// generated from the same seven rows rather than from two datasets that could quietly diverge.
module.exports = { FIXTURE, NOW, LONDON, ATTENTION };

if (require.main !== module) return;

fs.mkdirSync(OUT_DIR, { recursive: true });

const pages = [
  ['timeline-8h.html', { rangeLabel: '8h (default)', rangeHours: 8, drawerOpen: false }],
  ['timeline-24h.html', { rangeLabel: '24h', rangeHours: 24, drawerOpen: false }],
  ['timeline-drawer.html', { rangeLabel: '8h', rangeHours: 8, drawerOpen: true }],
  ['timeline-attention.html', { rangeLabel: '8h', rangeHours: 8, drawerOpen: false, highlightShiftId: 19 }],
];

for (const [name, options] of pages) {
  fs.writeFileSync(path.join(OUT_DIR, name), renderPage(options));
  console.log('wrote', path.join(OUT_DIR, name));
}

console.log(`\nfixture: ${FIXTURE.length} rows across ${new Set(FIXTURE.map((f) => f.shift.site.id)).size} sites`);
console.log('now    :', new Date(NOW).toISOString(), '(20:50 Europe/London)');
