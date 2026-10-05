#!/usr/bin/env node
/**
 * Renders the REAL Company Dashboard (Operations V2) to standalone HTML for visual review.
 *
 * Not a mock-up: it renders `CompanyDashboardOverview` through react-native-web's AppRegistry, which
 * produces the shipped stylesheet, and every value is computed by the certified `dashboardOverview` model
 * from a deterministic local fixture. No API client is loaded and no network call is made.
 *
 * Each page is placed in the same shell the app gives the dashboard at that width — a 228px sidebar from
 * 1280px, the 64px collapsed sidebar from 1024px, the overlay navigation below that, and 24px content
 * padding — so the dashboard is reviewed at the width it really gets, not the whole window.
 *
 *   node scripts/company-dashboard-preview.cjs [outDir]
 *
 * Output defaults to preview/dashboard-v2 (gitignored: local review artefacts, never evidence in the repo).
 */
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};
if (typeof globalThis.document === 'undefined') globalThis.document = {};

const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

const appRequire = Module.createRequire(path.join(ROOT, 'package.json'));
const React = appRequire('react');
const { renderToStaticMarkup } = appRequire('react-dom/server');
const { AppRegistry } = appRequire('react-native-web');

const model = loadTs('src/components/company/dashboardOverview.ts');
const complianceModel = loadTs('src/components/company/compliance-model.ts');
const { CompanyDashboardOverview } = loadTs('src/components/company/CompanyDashboardOverview.tsx');

const OUT_DIR = process.argv[2] || path.join(ROOT, 'preview', 'dashboard-v2');
const WIDTHS = [1440, 1024, 768, 390];

// Monday 5 October 2026, 18:55 London (BST).
const NOW = new Date('2026-10-05T17:55:00.000Z');
const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const ZONE = () => 'Europe/London';

function attention(id, category, occurred, issueType, site = 'TEST SITE', guard = 'Fahad Test', extra = {}) {
  return { id, category, shiftId: extra.shiftId ?? null, status: 'open', siteName: site, guardName: guard, issueType, message: extra.message || '', occurredAt: at(occurred) };
}

function welfare(status, extra = {}) {
  return {
    enabled: true, intervalMinutes: 30, status, currentWindow: null, windows: [],
    lastWelfareAt: extra.last ?? null, nextDueAt: extra.next ?? null, overdueByMinutes: extra.overdue ?? null,
    requiredCount: 2, completedCount: 1, missedCount: extra.missed ?? 0, consecutiveMissed: extra.missed ?? 0,
  };
}

function operations(bookOn, welfareView, lastLog = null) {
  return {
    bookOnAt: bookOn, bookOffAt: null, timezone: 'Europe/London', welfareEvidenceCount: 0, missingBookOff: false, welfareSummary: null,
    welfare: welfareView,
    logBook: { required: true, intervalMinutes: 60, currentWindow: null, currentWindowSubmitted: true, windows: [], requiredCount: 1, submittedCount: 1, missingCount: 0, lastEntryAt: lastLog },
  };
}

function liveShift(id, site, guard, startMin, endMin) {
  return { id, start: at(startMin), end: at(endMin), status: 'in_progress', site: { id: id, name: site }, guard: { id: 100 + id, fullName: guard } };
}

function complianceMetrics(statuses) {
  return complianceModel.computeMetrics(complianceModel.buildComplianceRows(
    statuses.map((status, index) => ({ guardId: index + 1, fullName: `Guard ${index + 1}`, complianceStatus: status })),
  ));
}

function scenario({ attentionItems, shifts, attendance, ops, uncovered, compliance, sources, freshness, loading }) {
  const live = model.buildLiveShiftRows(shifts, {
    attendanceByShiftId: attendance, operationsByShiftId: ops, attentionItems, resolveZone: ZONE, now: NOW,
  });
  return {
    loading: Boolean(loading),
    now: NOW,
    freshness: {
      clock: model.formatDashboardClock(NOW, 'Europe/London'),
      zoneNote: null,
      updated: model.formatUpdatedLabel(NOW, 'Europe/London'),
      refreshing: false,
      lastLoadFailed: false,
      autoRefreshSeconds: 60,
      ...freshness,
    },
    kpis: {
      activeSites: new Set(shifts.map((shift) => shift.site.id)).size,
      liveShifts: live.length,
      coverageGaps: uncovered.length,
      openIncidents: attentionItems.filter((entry) => entry.category === 'incident').length,
      alerts: attentionItems.filter((entry) => ['panic', 'missed_check_call', 'safety', 'site_request', 'missing_book_off'].includes(entry.category)).length,
    },
    attention: model.summariseAttention(attentionItems),
    liveRows: live,
    coverage: model.summariseCoverage(live.length, uncovered),
    upcoming: model.buildUpcomingShifts(shifts, { resolveZone: ZONE, now: NOW }),
    compliance: { canView: true, metrics: compliance },
    sources: { attention: 'ready', live: 'ready', coverage: 'ready', upcoming: 'ready', compliance: 'ready', ...sources },
    onNavigate() {}, onOpenCoverageGaps() {}, onOpenAttentionItem() {}, onViewAllAttention() {}, onOpenLiveShift() {},
  };
}

const UPCOMING = [
  { id: 60, start: at(65), end: at(185), status: 'offered', site: { id: 7, name: 'TEST SITE' }, guard: { id: 5, fullName: 'Sam Guard' } },
  { id: 61, start: at(20 * 60), end: at(28 * 60), status: 'unfilled', site: { id: 8, name: 'NORTH GATE' }, guard: null },
  { id: 62, start: at(26 * 60), end: at(34 * 60), status: 'ready', site: { id: 7, name: 'TEST SITE' }, guard: { id: 3, fullName: 'Fahad Test' } },
];

const SCENARIOS = {
  populated: scenario({
    attentionItems: [
      attention('panic-1', 'panic', -2, 'Active panic alert', 'TEST SITE', 'Fahad Test', { shiftId: 19 }),
      attention('checkcall-2', 'missed_check_call', -42, 'Missed Welfare Check', 'TEST SITE', 'Fahad Test', { shiftId: 19 }),
      attention('incident-3', 'incident', -90, 'Incident unresolved', 'NORTH GATE', 'Alex Long'),
      attention('mbo-4', 'missing_book_off', -30, 'Missing Book Off', 'EAST DEPOT', 'Jo Night', { message: 'Scheduled end 18:00 · 55 min overdue' }),
      attention('uncovered-5', 'uncovered_shift', 65, 'Uncovered shift', 'NORTH GATE', 'No confirmed guard'),
      attention('late-6', 'late_start', -12, 'Guard not booked on', 'WEST YARD', 'Pat Early'),
      attention('site-request-7', 'site_request', -5, 'Site Request', 'TEST SITE', 'Fahad Test'),
    ],
    shifts: [liveShift(19, 'TEST SITE', 'Fahad Test', -20, 40), liveShift(20, 'NORTH GATE', 'Alex Long', -60, 120), ...UPCOMING],
    attendance: new Map([[19, { checkInAt: at(-21), checkOutAt: null }], [20, { checkInAt: at(-58), checkOutAt: null }]]),
    ops: new Map([
      [19, operations(at(-21), welfare('missed', { next: at(5), missed: 1 }), at(-9))],
      [20, operations(at(-58), welfare('current', { last: at(-25), next: at(5) }), at(-40))],
    ]),
    uncovered: [{ siteId: 8 }],
    compliance: complianceMetrics(['valid', 'valid', 'valid', 'expiring', 'expired', 'unknown']),
  }),
  zero: scenario({
    attentionItems: [], shifts: [], attendance: new Map(), ops: new Map(), uncovered: [],
    compliance: complianceModel.computeMetrics([]),
  }),
  one: scenario({
    attentionItems: [attention('checkcall-1', 'missed_check_call', -8, 'Missed Welfare Check', 'TEST SITE', 'Fahad Test', { shiftId: 19 })],
    shifts: [liveShift(19, 'TEST SITE', 'Fahad Test', -20, 40), UPCOMING[0]],
    attendance: new Map([[19, { checkInAt: at(-21), checkOutAt: null }]]),
    ops: new Map([[19, operations(at(-21), welfare('missed', { next: at(5), missed: 1 }), null)]]),
    uncovered: [],
    compliance: complianceMetrics(['valid']),
  }),
  five: scenario({
    attentionItems: [
      attention('a1', 'panic', -2, 'Active panic alert'),
      attention('a2', 'incident', -50, 'Incident unresolved', 'NORTH GATE', 'Alex Long'),
      attention('a3', 'missed_check_call', -20, 'Missed Welfare Check'),
      attention('a4', 'uncovered_shift', 120, 'Uncovered shift', 'EAST DEPOT', 'No confirmed guard'),
      attention('a5', 'site_request', -3, 'Site Request'),
    ],
    shifts: [liveShift(19, 'TEST SITE', 'Fahad Test', -20, 40), ...UPCOMING],
    attendance: new Map([[19, { checkInAt: at(-21), checkOutAt: null }]]),
    ops: new Map(),
    uncovered: [{ siteId: 9 }],
    compliance: complianceMetrics(['valid', 'expiring']),
  }),
  busy: scenario({
    attentionItems: Array.from({ length: 12 }, (_, index) => attention(
      `busy-${index}`, index % 3 === 0 ? 'missed_check_call' : index % 3 === 1 ? 'uncovered_shift' : 'safety',
      -(index * 7 + 3), index % 3 === 0 ? 'Missed Welfare Check' : index % 3 === 1 ? 'Uncovered shift' : 'Safety / welfare needs attention',
      'HEATHROW TERMINAL 5 CARGO DISTRIBUTION CENTRE — NORTH PERIMETER GATEHOUSE', 'Alexandra Catherine Montgomery-Fitzgerald',
    )),
    shifts: Array.from({ length: 8 }, (_, index) => liveShift(30 + index,
      index === 0 ? 'HEATHROW TERMINAL 5 CARGO DISTRIBUTION CENTRE — NORTH PERIMETER GATEHOUSE' : `SITE ${index + 1}`,
      index === 0 ? 'Alexandra Catherine Montgomery-Fitzgerald' : `Guard ${index + 1}`, -30 - index * 5, 200)).concat(UPCOMING),
    attendance: new Map(Array.from({ length: 8 }, (_, index) => [30 + index, { checkInAt: at(-31 - index * 5), checkOutAt: null }])),
    ops: new Map([[30, operations(at(-31), welfare('overdue', { next: at(-12), overdue: 12, missed: 2 }), at(-15))]]),
    uncovered: [{ siteId: 8 }, { siteId: 8 }, { siteId: 9 }],
    compliance: complianceMetrics(['valid', 'expired', 'invalid', 'expiring', 'unknown', 'unknown']),
    sources: { live: 'error' },
    freshness: { lastLoadFailed: true, updated: 'Updated 18:52', zoneNote: 'Europe/London' },
  }),
};

function shellFor(width) {
  if (width >= 1280) return { sidebar: 228 };
  if (width >= 1024) return { sidebar: 64 };
  return { sidebar: 0 };
}

function page(name, props, width) {
  const element = React.createElement(CompanyDashboardOverview, props);
  const key = `Dashboard_${name}_${width}`;
  AppRegistry.registerComponent(key, () => () => element);
  const app = AppRegistry.getApplication(key, {});
  const body = renderToStaticMarkup(app.element);
  const styles = renderToStaticMarkup(app.getStyleElement());
  const { sidebar } = shellFor(width);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard V2 — ${name} @ ${width}px</title>${styles}
<style>html,body{margin:0;background:#EAF0F5;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.shell{display:flex;min-height:100vh}.sidebar{width:${sidebar}px;background:#0B1F33;flex-shrink:0}
.content{flex:1;min-width:0;padding:24px 24px 48px}.title{font-size:28px;font-weight:800;color:#0B1F33;margin:0 0 4px}
.caption{font-size:14px;color:#52606D;margin:0 0 16px;padding-bottom:16px;border-bottom:1px solid #DCE3EA}
.topbar{height:56px;background:#fff;border-bottom:1px solid #DCE3EA}</style></head>
<body><div class="shell">${sidebar ? '<div class="sidebar" aria-hidden="true"></div>' : ''}<div class="content-col" style="flex:1;min-width:0">
<div class="topbar" aria-hidden="true"></div><div class="content"><h1 class="title">Dashboard</h1>
<p class="caption">Your live operational position and items requiring attention.</p>${body}</div></div></div></body></html>`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const written = [];
for (const [name, props] of Object.entries(SCENARIOS)) {
  for (const width of WIDTHS) {
    const file = `dashboard-${name}-${width}.html`;
    fs.writeFileSync(path.join(OUT_DIR, file), page(name, props, width));
    written.push(file);
  }
}
console.log(`Wrote ${written.length} pages to ${OUT_DIR}`);
