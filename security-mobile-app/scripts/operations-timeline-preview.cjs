#!/usr/bin/env node
/**
 * Renders the REAL control-room surface to standalone HTML for visual review. (Phase 4A.2 §7/§8, 4A.3 §16/§17.)
 *
 * Not a mock-up. It imports `CompanyOperationsTimeline`, `LiveOpsAttentionRail` and `LiveOpsLowerPanels`
 * themselves and renders them through react-native-web's AppRegistry, which is what produces the shipped
 * stylesheet — so what the browser shows is the components as shipped, with their real layout, spacing and
 * colours. Next Up, Upcoming Handovers and Today So Far are computed by the certified pure modules from
 * the SAME rows the timeline draws, exactly as the workspace computes them.
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
// The components import react-native, which ships as Flow source and cannot be required in Node. Point it
// at react-native-web, which is what the browser bundle uses anyway — so the preview renders the same
// components the web control room does.
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};

/**
 * The components ask `typeof document !== 'undefined'` to decide whether they are on the web, and use the
 * answer for real layout decisions — the rail's fixed desktop width among them. Under plain Node that
 * question answers "native", so without this stub the preview would render the PHONE layout and the
 * screenshots would certify a desktop that does not exist.
 *
 * It stays a bare object on purpose: react-native-web's own `canUseDOM` tests `window.document`, which is
 * still undefined, so the renderer keeps its server path.
 */
if (typeof globalThis.document === 'undefined') globalThis.document = {};

const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { loadTs, ROOT } = require('./load-ts.cjs');

const OUT_DIR = process.argv[2] || path.join(ROOT, 'preview');

// ─── the deterministic control-room fixture ──────────────────────────────────
// Wednesday 30 September 2026, 20:50 London (BST, so 19:50Z). Three sites, nine rows.
//
// It is built so every state on the surface is a real consequence of the data, never a hand-typed number:
// every marker state, every attendance state, an overnight shift, two guards overlapping at one site, a
// handover WITH a relief and a handover WITHOUT one, and enough near-term events to fill Next Up past its
// five-item cap. No completed window is ever in the future.

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
  const grid = o.windows ?? [];
  const completed = grid.filter((w) => w.state === 'completed');
  const applicable = grid.filter((w) => w.applicable);

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
            windows: grid,
            requiredCount: applicable.length,
            completedCount: completed.length,
            missedCount: grid.filter((w) => w.state === 'missed').length,
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
const AHMED_START = Date.parse('2026-09-30T18:40:00.000Z');       // 19:40 London
const NIGHT_COVER_START = Date.parse('2026-09-30T16:00:00.000Z'); // 17:00 London
const MARTA_START = Date.parse('2026-09-30T13:30:00.000Z');       // 14:30 London

const FIXTURE = [
  // ── TEST SITE: the UAT shift, a second guard overlapping it, and its relief. ──
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
    start: iso(AHMED_START), end: iso(AHMED_START + 9 * HOUR), status: 'in_progress',
    attendance: { checkInAt: iso(AHMED_START - 2 * MIN), checkOutAt: null },
    interval: 30,
    // 19:40, 20:10 elapsed and done; 20:40–21:10 is the window running now.
    windows: windows(['completed', 'completed', 'due', 'not_applicable'], AHMED_START, 30),
  }),
  shift({
    id: 26, siteId: 7, siteName: 'TEST SITE', clientName: 'Northgate Retail', guard: 'Sam Okafor',
    // Starts five minutes before Fahad's shift ends: the one unambiguous relief in the fixture.
    start: iso(SHIFT_19_START + 55 * MIN), end: iso(SHIFT_19_START + 55 * MIN + 8 * HOUR), status: 'ready',
    attendance: undefined,
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
    start: iso(NIGHT_COVER_START), end: '2026-10-01T04:00:00.000Z', status: 'in_progress',
    attendance: { checkInAt: iso(NIGHT_COVER_START - 2 * MIN), checkOutAt: null },
    interval: 60,
    windows: windows(['completed', 'completed', 'completed', 'due'], NIGHT_COVER_START, 60),
  }),

  // ── RIVERSIDE DEPOT: a finished shift, a shift ending with nobody arranged, and an uncovered one. ──
  shift({
    id: 24, siteId: 11, siteName: 'RIVERSIDE DEPOT', clientName: 'Riverside Logistics', guard: 'Dan Obi',
    start: iso(NOW - 3 * HOUR), end: iso(NOW - 20 * MIN), status: 'completed',
    attendance: { checkInAt: iso(NOW - 3 * HOUR - 2 * MIN), checkOutAt: iso(NOW - 18 * MIN) },
    interval: 60,
    windows: windows(['completed', 'completed', 'missed'], NOW - 3 * HOUR, 60),
  }),
  shift({
    id: 27, siteId: 11, siteName: 'RIVERSIDE DEPOT', clientName: 'Riverside Logistics', guard: 'Marta Kowalska',
    // Ends at 21:20 and the only later shift at this site starts at 22:50 — an hour and a half away, so
    // nothing here establishes a relief. This is the "No replacement assigned" case.
    start: iso(MARTA_START), end: iso(NOW + 30 * MIN), status: 'in_progress',
    attendance: { checkInAt: iso(MARTA_START + 1 * MIN), checkOutAt: null },
    interval: 60,
    windows: windows(['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'due'], MARTA_START, 60),
    alerts: [{ id: 502, shiftId: 27, type: 'site_request', status: 'open' }],
  }),
  shift({
    id: 25, siteId: 11, siteName: 'RIVERSIDE DEPOT', clientName: 'Riverside Logistics', guard: null,
    start: iso(NOW + 2 * HOUR), end: iso(NOW + 10 * HOUR), status: 'unfilled',
    attendance: undefined, // COVERAGE GAP
  }),
];

/** One Attention Now item, pointing at the shift with the missed Welfare Check. */
const ATTENTION_ITEM = {
  id: 'checkcall-501',
  alertId: 501,
  shiftId: 19,
  status: 'open',
  siteName: 'TEST SITE',
  guardName: 'Fahad test',
  category: 'missed_check_call',
  issueType: 'Missed Welfare Check',
  message: 'A scheduled Welfare Check was not completed.',
  occurredAt: '2026-09-30T20:20:00.000Z',
};

const RECENT_ACTIVITY = [
  { id: 'a1', shiftId: 19, siteName: 'TEST SITE', guardName: 'Fahad test', eventType: 'log_book', message: 'Perimeter walked, all clear.', occurredAt: '2026-09-30T20:02:00.000Z' },
  { id: 'a2', shiftId: 20, siteName: 'TEST SITE', guardName: 'Ahmed Khan', eventType: 'welfare_check', message: 'All well.', occurredAt: '2026-09-30T19:43:00.000Z' },
  { id: 'a3', shiftId: 24, siteName: 'RIVERSIDE DEPOT', guardName: 'Dan Obi', eventType: 'book_off', message: 'Booked off.', occurredAt: '2026-09-30T19:32:00.000Z' },
  { id: 'a4', shiftId: 27, siteName: 'RIVERSIDE DEPOT', guardName: 'Marta Kowalska', eventType: 'site_request', message: 'Gate light out.', occurredAt: '2026-09-30T19:20:00.000Z' },
];

// ─── the derivations, from the SAME rows ─────────────────────────────────────

const outlook = loadTs('src/components/company/operationsOutlook.ts');
const summaryModule = loadTs('src/components/company/operationsSummary.ts');

const NEXT_UP = outlook.buildNextUp(FIXTURE, NOW);
const HANDOVERS = outlook.buildHandovers(FIXTURE, NOW);
const TODAY_SO_FAR = summaryModule.buildTodaySoFar(FIXTURE, NOW);

// ─── render ───────────────────────────────────────────────────────────────────

const timelineModule = loadTs('src/components/company/operationsTimeline.ts');

/**
 * Reproduces the component's opening scroll position on a static page.
 *
 * The page carries no React, so the effect that puts NOW in shot never runs and a 24h screenshot would
 * otherwise show lunchtime — the very defect §4 fixes. This injects the SHIPPED `nowScrollOffset`
 * function, serialised from the module itself rather than written out a second time, and applies it to
 * the real axis element. Same arithmetic, same answer a browser gives.
 */
function viewportScript(nowFraction, rangeHours) {
  // Mirrors the component's own condition: only the long ranges open centred, so an 8h screenshot shows
  // the same left-aligned axis a controller gets.
  if (rangeHours <= timelineModule.DEFAULT_TIMELINE_RANGE) return '';
  // The compiled default parameter still names the module constant, which does not exist in a plain
  // page. Inline its value so nothing in the serialised function can dangle.
  const source = timelineModule.nowScrollOffset
    .toString()
    .replace('exports.NOW_OFFSET_FRACTION', String(timelineModule.NOW_OFFSET_FRACTION));
  return `<script>
(function () {
  var nowScrollOffset = ${source};
  var axis = document.getElementById('operations-timeline-axis');
  if (!axis) return;
  // The offset fraction is passed explicitly: the module constant it defaults to is not in this page.
  axis.scrollLeft = nowScrollOffset(${nowFraction}, axis.scrollWidth, axis.clientWidth, ${timelineModule.NOW_OFFSET_FRACTION});
})();
</script>`;
}

function renderPage({ rangeLabel, rangeHours, drawerOpen, highlightShiftId }) {
  const RNW = require('react-native-web');
  const { AppRegistry } = RNW;
  const { CompanyOperationsTimeline } = loadTs('src/components/company/CompanyOperationsTimeline.tsx');
  const { LiveOpsAttentionRail, LiveOpsLowerPanels } =
    loadTs('src/components/company/CompanyLiveOperationsWorkspace.tsx');

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
            selectedShiftId: drawerOpen ? ATTENTION_ITEM.shiftId : null,
            highlightedShiftId: highlightShiftId ?? null,
            onSelectShift: () => {},
            onExportCsv: () => {},
            onExportXlsx: () => {},
            exporting: false,
          }),
        ),
        // The SHIPPED rail, with Attention Now and Next Up, at its real 268px.
        React.createElement(LiveOpsAttentionRail, {
          items: [ATTENTION_ITEM],
          metricFocus: 'all',
          resolveShiftZone: () => LONDON,
          urgentActionItemId: null,
          onOpenUrgentDetail: () => {},
          onOpenUrgentShift: () => {},
          onUrgentIncidentFollowUp: async () => {},
          onUrgentAlertFollowUp: async () => {},
          nextUp: NEXT_UP,
        }),
      ),
      // The SHIPPED lower panels: Today So Far, Upcoming Handovers, Recent Activity.
      React.createElement(LiveOpsLowerPanels, {
        todaySoFar: TODAY_SO_FAR,
        handovers: HANDOVERS,
        recentOperationalActivity: RECENT_ACTIVITY,
        resolveShiftZone: () => LONDON,
        liveOperationEnrichedRows: FIXTURE.map((row) => ({ ...row, lifecycleStatus: row.shift.status })),
        onOpenCoverage: () => {},
      }),
      drawerOpen ? React.createElement(DrawerStandIn) : null,
    );

  AppRegistry.registerComponent('Preview', () => Root);
  const { element, getStyleElement } = AppRegistry.getApplication('Preview', {});
  const { renderToStaticMarkup } = require('react-dom/server');

  const window_ = timelineModule.resolveTimelineWindow(NOW, rangeHours, LONDON);
  const nowFraction = timelineModule.axisFraction(NOW, window_);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>S4 Operations Timeline — preview</title>
<style>html,body{margin:0;padding:0;background:#F4F7FA;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;}</style>
${renderToStaticMarkup(getStyleElement())}
</head><body><div id="root">${renderToStaticMarkup(element)}</div>
${viewportScript(nowFraction, rangeHours)}</body></html>`;
}

// ── page chrome stand-ins, so the timeline is shown in context ───────────────

function PageHeading() {
  const RNW = require('react-native-web');
  return React.createElement(
    RNW.View,
    { style: { gap: 2 } },
    React.createElement(RNW.Text, { style: { fontSize: 20, fontWeight: '800', color: '#0B1F33' } }, 'Live Operations'),
    React.createElement(RNW.Text, { style: { fontSize: 12, color: '#5A6B7B' } },
      'Monitor live shifts, attendance, Welfare Checks and operational alerts.'),
  );
}

function SummaryStrip() {
  const RNW = require('react-native-web');
  // Derived, not typed: the strip cannot claim a number the board does not hold.
  const live = FIXTURE.filter((row) => row.shift.status === 'in_progress').length;
  const metrics = [
    ['Live Shifts', String(live), '#0F817E'],
    ['Guards Not Booked On', String(TODAY_SO_FAR.attendance.lateNotBookedOn), '#A15C07'],
    ['Open Incidents', String(TODAY_SO_FAR.operations.openIncidents), '#B42318'],
    ['Missed Welfare Checks', String(TODAY_SO_FAR.welfare.missed), '#B42318'],
    ['Active Emergency Alerts', String(TODAY_SO_FAR.operations.emergencyAlerts), '#5A6B7B'],
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

/**
 * Stands in for the Shift Operations drawer.
 *
 * The real Drawer renders through react-native Modal, which react-dom/server cannot serialise (it is a DOM
 * portal and comes out empty under static markup — the same limitation the Phase 2 modal tests documented).
 * Everything here mirrors the shared `Drawer` component it stands for, INCLUDING the top-right ✕ close
 * control, so the screenshot answers the review questions that matter: how much of the timeline it covers,
 * and how a controller gets out of it.
 */
function DrawerStandIn() {
  const RNW = require('react-native-web');
  const section = (title, lines, lead) => React.createElement(
    RNW.View,
    { key: title, style: { gap: 3, paddingVertical: 11 } },
    React.createElement(
      RNW.Text,
      { style: { fontSize: 10, fontWeight: '800', color: '#5A6B7B', letterSpacing: 0.9, marginBottom: 6, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: '#E2E8F0' } },
      title.toUpperCase(),
    ),
    lead
      ? React.createElement(RNW.Text, { style: { fontSize: 13, fontWeight: '700', color: '#0B1F33', lineHeight: 19 } }, lead)
      : null,
    ...lines.map((line) => React.createElement(RNW.Text, { key: line, style: { fontSize: 12, color: '#243B53', lineHeight: 18 } }, line)),
  );

  return React.createElement(
    RNW.View,
    { style: { position: 'fixed', top: 0, right: 0, bottom: 0, width: 620, backgroundColor: '#FFFFFF', borderLeftWidth: 1, borderLeftColor: '#D9E2EC', boxShadow: '-8px 0 24px rgba(11,31,51,0.18)' } },
    // Header: copy on the left, the close target on the right, exactly as the shared Drawer lays it out.
    React.createElement(
      RNW.View,
      { style: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: '#E2E8F0' } },
      React.createElement(
        RNW.View,
        { style: { flex: 1, gap: 2 } },
        React.createElement(RNW.Text, { style: { fontSize: 16, fontWeight: '800', color: '#0B1F33' } }, 'Shift Operations'),
        React.createElement(RNW.Text, { style: { fontSize: 12, color: '#5A6B7B' } }, 'TEST SITE · Fahad test'),
      ),
      React.createElement(
        RNW.View,
        { style: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7FAFC' } },
        React.createElement(RNW.Text, { style: { fontSize: 13, fontWeight: '700', color: '#5A6B7B', lineHeight: 18 } }, '✕'),
      ),
    ),
    React.createElement(
      RNW.View,
      { style: { paddingHorizontal: 20, paddingVertical: 4 } },
      section('Operational monitoring',
        ['Every 15 min · 1 completed · 1 missed', 'Log Book · hourly · current entry submitted'],
        'Welfare Check · OVERDUE · next due 21:05 · 1 min over'),
      section('Attendance & timesheet',
        ['Timesheet: draft'],
        'Book On 20:33  ·  Scheduled 20:35\nBook Off —  ·  Scheduled 21:35'),
      section('Daily logs', ['21:02  Perimeter walked, all clear', '20:38  All well.']),
      section('Incidents', ['20:55  Broken window, north side (Open)']),
      section('Safety alerts', ['21:20  Missed Checkcall (Open)']),
    ),
  );
}

// ─── write the pages ──────────────────────────────────────────────────────────

// Required as a module, this file is just the fixture — so the export proof and the screenshots are
// generated from the same rows rather than from two datasets that could quietly diverge.
module.exports = { FIXTURE, NOW, LONDON, ATTENTION: ATTENTION_ITEM, NEXT_UP, HANDOVERS, TODAY_SO_FAR };

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

const sites = new Set(FIXTURE.map((f) => f.shift.site.id)).size;
console.log(`\nfixture   : ${FIXTURE.length} rows across ${sites} sites`);
console.log('now       :', new Date(NOW).toISOString(), '(20:50 Europe/London)');
console.log('next up   :', NEXT_UP.map((e) => `${e.at} ${e.label}`).join(' | '));
console.log('handovers :', HANDOVERS.map((h) => `${h.at} ${h.siteName}: ${h.note}`).join(' | '));
console.log('today     :', JSON.stringify(TODAY_SO_FAR));
