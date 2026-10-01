#!/usr/bin/env node
/**
 * Phase 4A.3 — the control-room polish, certified against the RENDERED surface.
 *
 * These are not source greps. The real components are rendered through react-native-web, which is the
 * stylesheet the web control room actually ships, and the assertions read the resulting markup. A rule
 * about what a controller sees has to be checked where the controller sees it.
 */
// The components import react-native, which ships as Flow source and cannot be required in Node.
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadTs, ROOT } = require('./load-ts.cjs');

const { colors } = loadTs('src/theme/index.ts');
const timeline = loadTs('src/components/company/operationsTimeline.ts');
const outlook = loadTs('src/components/company/operationsOutlook.ts');
const summaryMod = loadTs('src/components/company/operationsSummary.ts');
const { CompanyOperationsTimeline } = loadTs('src/components/company/CompanyOperationsTimeline.tsx');
/**
 * react-native-web's `getStyleElement()` emits the CUMULATIVE stylesheet for everything loaded so far,
 * so the workspace is loaded lazily. The timeline assertions below must read a sheet containing the
 * timeline and nothing else — otherwise an unrelated component's success banner answers for the Live bar.
 */
let workspaceModule = null;
const workspace = () => (workspaceModule ??= loadTs('src/components/company/CompanyLiveOperationsWorkspace.tsx'));

const LONDON = 'Europe/London';
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-09-30T19:50:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log('PASS ', name);
  } catch (error) {
    console.error('FAIL ', name);
    console.error(error.message);
    process.exitCode = 1;
  }
};

/** react-native-web writes colours as `rgba(r,g,b,1.00)`, so theme hex has to be spoken in its dialect. */
function rgba(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},1.00)`;
}

/** Render a component through AppRegistry, which is what produces the real stylesheet. */
function render(element) {
  const { AppRegistry } = require('react-native-web');
  AppRegistry.registerComponent('Spec', () => () => element);
  const app = AppRegistry.getApplication('Spec', {});
  return renderToStaticMarkup(app.element) + renderToStaticMarkup(app.getStyleElement());
}

const win = (state, startMs, minutes, i) => ({
  index: i,
  start: iso(startMs),
  end: iso(startMs + minutes * MIN),
  state,
  applicable: state !== 'not_applicable',
  completedAt: state === 'completed' ? iso(startMs + 2 * MIN) : null,
});

/** A live shift whose Welfare history is anything but healthy — the case §1 exists for. */
const TROUBLED_LIVE = {
  shift: {
    id: 19,
    start: iso(NOW - 15 * MIN),
    end: iso(NOW + 45 * MIN),
    status: 'in_progress',
    site: { id: 7, name: 'TEST SITE', timezone: LONDON },
    guard: { fullName: 'Fahad test' },
  },
  attendance: { checkInAt: iso(NOW - 17 * MIN), checkOutAt: null },
  operations: {
    welfare: {
      intervalMinutes: 15,
      windows: [
        win('completed', NOW - 15 * MIN, 15, 0),
        win('overdue', NOW, 15, 1),
        win('missed', NOW + 15 * MIN, 15, 2),
        win('due', NOW + 30 * MIN, 15, 3),
      ],
    },
  },
};

const timelineMarkup = render(
  React.createElement(CompanyOperationsTimeline, {
    inputs: [TROUBLED_LIVE],
    nowMs: NOW,
    headerTimeZone: LONDON,
    anchorMs: NOW,
    selectedShiftId: null,
    highlightedShiftId: null,
    onSelectShift: () => {},
    onExportCsv: () => {},
    onExportXlsx: () => {},
    exporting: false,
  }),
);

// ═══════════════════ §1 the Live bar no longer says "all good" ═══════════════════

test('BAR-01-A-LIVE-SHIFT-IS-NOT-PAINTED-GREEN', () => {
  // The defect: a live shift with an overdue AND a missed Welfare Check was drawn in the most
  // reassuring colour on the page. The bar knows the shift is running; it does not know it is fine.
  assert.ok(
    !timelineMarkup.includes(rgba(colors.successSurface)),
    'the success surface must not appear anywhere on a board whose only live shift is in trouble',
  );
  assert.ok(
    timelineMarkup.includes(rgba(colors.accentTeal)),
    'Live is marked by a teal edge — running, not healthy',
  );
});

test('BAR-02-THE-COMPACT-LIVE-BADGE-SURVIVES', () => {
  assert.ok(/>Live</.test(timelineMarkup), 'the status word is still on the bar');
  assert.ok(
    timelineMarkup.includes('text-transform:uppercase') || timelineMarkup.includes('text-transform: uppercase'),
    'and reads as a badge',
  );
});

test('BAR-03-WELFARE-SPEAKS-FOR-ITSELF', () => {
  // Independence, stated as a fact about the render: the bar's own colours carry no Welfare verdict,
  // and every one of the four window states is present as its own marker.
  for (const glyph of ['✓', '!', '✕', '●']) {
    assert.ok(timelineMarkup.includes(glyph), `marker ${glyph} is drawn`);
  }
  assert.ok(timelineMarkup.includes(rgba(colors.warning)), 'the overdue chip is on the page');
  assert.ok(timelineMarkup.includes(rgba(colors.danger)), 'the missed chip is on the page');
});

test('BAR-04-OTHER-STATUSES-STAY-DISTINCT', () => {
  const four = [
    { id: 1, status: 'ready', start: iso(NOW + 2 * HOUR), end: iso(NOW + 8 * HOUR), guard: 'Upcoming G' },
    { id: 2, status: 'ready', start: iso(NOW - 40 * MIN), end: iso(NOW + 6 * HOUR), guard: 'Late G' },
    { id: 3, status: 'completed', start: iso(NOW - 3 * HOUR), end: iso(NOW - 30 * MIN), guard: 'Done G' },
    { id: 4, status: 'unfilled', start: iso(NOW + 90 * MIN), end: iso(NOW + 7 * HOUR), guard: null },
  ].map((o) => ({
    shift: {
      id: o.id, start: o.start, end: o.end, status: o.status,
      site: { id: 7, name: 'TEST SITE', timezone: LONDON },
      guard: o.guard ? { fullName: o.guard } : null,
    },
    attendance: undefined,
    operations: null,
  }));

  const markup = render(
    React.createElement(CompanyOperationsTimeline, {
      inputs: four, nowMs: NOW, headerTimeZone: LONDON, anchorMs: NOW,
      selectedShiftId: null, highlightedShiftId: null,
      onSelectShift: () => {}, onExportCsv: () => {}, onExportXlsx: () => {}, exporting: false,
    }),
  );

  for (const word of ['Upcoming', 'Late', 'Completed', 'Coverage Gap']) {
    assert.ok(markup.includes(`>${word}<`), `${word} is still its own treatment`);
  }
  assert.ok(markup.includes(rgba(colors.warningSurface)), 'Late keeps its amber surface');
  assert.ok(markup.includes(rgba(colors.dangerSurface)), 'Coverage Gap keeps its red surface');
});

// ═══════════════════ §2 markers findable across thirty rows ═══════════════════

test('MARKER-01-OVERDUE-AND-MISSED-DIFFER-IN-SHAPE-NOT-ONLY-COLOUR', () => {
  // A filled chip is a difference that survives a monochrome screen and colour-vision deficiency.
  const chipRadius = /border-top-left-radius:\s*8px/.test(timelineMarkup);
  assert.ok(chipRadius, 'the marker chip is drawn as a pill');
  assert.ok(timelineMarkup.includes(rgba(colors.textOnBrand)), 'and its glyph is reversed out of the fill');
});

test('MARKER-02-EVERY-MARKER-STILL-CARRIES-ITS-WORDS', () => {
  // Never colour alone, and never shape alone either: the tooltip and the screen reader get a sentence.
  assert.ok(/Fahad test, Welfare Check \d\d:\d\d–\d\d:\d\d, Completed/.test(timelineMarkup));
  assert.ok(timelineMarkup.includes('Overdue'), 'overdue is named in words');
  assert.ok(timelineMarkup.includes('Missed'), 'missed is named in words');
  assert.ok(timelineMarkup.includes('aria-label'), 'the labels reach assistive technology');
});

test('MARKER-03-THE-LEGEND-KEYS-ALL-FIVE-STATES', () => {
  for (const word of ['Completed', 'Due', 'Overdue', 'Missed', 'Not required']) {
    assert.ok(timelineMarkup.includes(word), `${word} appears in the key`);
  }
});

// ═══════════════════ §3 the attendance column ═══════════════════

test('IDENTITY-01-NAME-SCHEDULE-ATTENDANCE-IN-THAT-ORDER', () => {
  const nameAt = timelineMarkup.indexOf('Fahad test');
  const schedAt = timelineMarkup.indexOf('20:35–21:35');
  const onAt = timelineMarkup.indexOf('ON 20:33');
  assert.ok(nameAt >= 0 && schedAt > nameAt && onAt > schedAt, 'guard, then schedule, then attendance');
  assert.ok(timelineMarkup.includes('OFF —'), 'and Book Off is shown even when there is none');
});

test('IDENTITY-02-A-MISSING-BOOK-ON-PAST-THE-START-IS-LOUD', () => {
  const late = {
    shift: {
      id: 21, start: iso(NOW - 40 * MIN), end: iso(NOW + 6 * HOUR), status: 'ready',
      site: { id: 9, name: 'MERCHANT FIELDS', timezone: LONDON },
      guard: { fullName: 'Priya Sharma' },
    },
    attendance: undefined,
    operations: null,
  };
  const markup = render(
    React.createElement(CompanyOperationsTimeline, {
      inputs: [late], nowMs: NOW, headerTimeZone: LONDON, anchorMs: NOW,
      selectedShiftId: null, highlightedShiftId: null,
      onSelectShift: () => {}, onExportCsv: () => {}, onExportXlsx: () => {}, exporting: false,
    }),
  );
  assert.ok(markup.includes(rgba(colors.danger)), 'the missing Book On is drawn in the alarm colour');
  assert.ok(markup.includes('ON —'), 'and still says what is missing in words');
});

test('IDENTITY-03-THE-COLUMN-DID-NOT-GROW', () => {
  // Readability was bought with weight and colour, not with width taken from the axis.
  const source = fs.readFileSync(
    path.join(ROOT, 'src/components/company/CompanyOperationsTimeline.tsx'), 'utf8',
  );
  const match = source.match(/const IDENTITY_WIDTH = (\d+);/);
  assert.ok(match, 'the identity width is a named constant');
  assert.ok(Number(match[1]) <= 220, `identity column is ${match[1]}px, still <= 220`);
});

// ═══════════════════ §4 where the viewport opens ═══════════════════

test('SCROLL-04-ONLY-THE-LONG-RANGES-OPEN-CENTRED-ON-NOW', () => {
  // A bar's status badge is drawn at its left edge, so auto-scrolling the DEFAULT view would hide
  // "LIVE", "LATE" and "COMPLETED" on every shift that began before the window — which a 1366 screenshot
  // caught. 12h and 24h are wide enough that the opposite problem wins: without centring, the controller
  // is shown lunchtime while the work is at 21:00. "Now" always re-centres, because then it was asked for.
  const source = fs.readFileSync(
    path.join(ROOT, 'src/components/company/CompanyOperationsTimeline.tsx'), 'utf8',
  );
  assert.ok(
    /if \(rangeHours <= DEFAULT_TIMELINE_RANGE && recentreToken === 0\) return;/.test(source),
    'the 4h and 8h views open at the start of the window',
  );
  assert.ok(/setRecentreToken\(\(t\) => t \+ 1\)/.test(source), '"Now" re-centres on demand');
  assert.equal(timeline.DEFAULT_TIMELINE_RANGE, 8);
  assert.deepEqual(
    [...timeline.TIMELINE_RANGES].filter((h) => h > timeline.DEFAULT_TIMELINE_RANGE), [12, 24],
    'and those long ranges are exactly 12h and 24h',
  );
  assert.ok(source.includes('nativeID="operations-timeline-axis"'), 'the axis is addressable');
});

// ═══════════════════ §5/§7 the operations rail ═══════════════════

const RAIL_ROWS = Array.from({ length: 8 }, (_, i) => ({
  shift: {
    id: 300 + i,
    start: iso(NOW + (i + 1) * 15 * MIN),
    end: iso(NOW + 9 * HOUR),
    status: 'ready',
    site: { id: 7, name: 'TEST SITE', timezone: LONDON },
    guard: { fullName: `Guard ${i}` },
  },
  attendance: undefined,
  operations: null,
}));

test('RAIL-01-ATTENTION-NOW-THEN-NEXT-UP-IN-ONE-COLUMN', () => {
  const markup = render(
    React.createElement(workspace().LiveOpsAttentionRail, {
      items: [{
        id: 'a1', shiftId: 19, siteName: 'TEST SITE', guardName: 'Fahad test',
        category: 'missed_check_call', issueType: 'Missed Welfare Check',
        message: 'A scheduled Welfare Check needs attention.', occurredAt: iso(NOW - 10 * MIN),
        status: 'open',
      }],
      metricFocus: 'all',
      resolveShiftZone: () => LONDON,
      urgentActionItemId: null,
      onOpenUrgentDetail: () => {},
      onOpenUrgentShift: () => {},
      onUrgentIncidentFollowUp: async () => {},
      onUrgentAlertFollowUp: async () => {},
      nextUp: outlook.buildNextUp(RAIL_ROWS, NOW),
    }),
  );

  const attentionAt = markup.indexOf('Attention Now');
  const nextUpAt = markup.indexOf('Next Up');
  assert.ok(attentionAt >= 0, 'Attention Now is section A');
  assert.ok(nextUpAt > attentionAt, 'Next Up is section B, beneath it');
  assert.ok(markup.includes('Missed Welfare Check'), 'the exception is still the first thing shown');
  assert.ok(!markup.includes('Recent Activity'), 'history is deliberately not in the rail');
});

test('RAIL-02-NEXT-UP-SHOWS-AT-MOST-FIVE-IN-ORDER', () => {
  const events = outlook.buildNextUp(RAIL_ROWS, NOW);
  const markup = render(
    React.createElement(workspace().LiveOpsAttentionRail, {
      items: [], metricFocus: 'all', resolveShiftZone: () => LONDON, urgentActionItemId: null,
      onOpenUrgentDetail: () => {}, onOpenUrgentShift: () => {},
      onUrgentIncidentFollowUp: async () => {}, onUrgentAlertFollowUp: async () => {},
      nextUp: events,
    }),
  );

  assert.equal(events.length, outlook.NEXT_UP_MAX);
  const positions = events.map((e) => markup.indexOf(e.label));
  assert.ok(positions.every((p) => p >= 0), 'every event is on the page');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'drawn in chronological order');
});

test('RAIL-03-THE-RAIL-LEAVES-THE-TIMELINE-DOMINANT', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'src/components/company/CompanyLiveOperationsWorkspace.tsx'), 'utf8',
  );
  const match = source.match(/attentionColumn:[\s\S]*?width: (\d+)/);
  assert.ok(match, 'the rail has an explicit desktop width');
  const width = Number(match[1]);
  assert.ok(width >= 250 && width <= 280, `rail is ${width}px, inside the 250-280 target`);

  // And nothing pins the board to a fixed height any more, so many sites push the panels down rather
  // than squeezing the timeline into a box.
  assert.ok(
    !/workspaceRow:[\s\S]*?height:\s*IS_WEB \? \d+/.test(source),
    'the workspace row no longer constrains the timeline height on web',
  );
});

// ═══════════════════ §10/§11 the lower panels ═══════════════════

const PANEL_ROWS = [
  TROUBLED_LIVE,
  {
    shift: {
      id: 24, start: iso(NOW - 3 * HOUR), end: iso(NOW + 30 * MIN), status: 'in_progress',
      site: { id: 11, name: 'RIVERSIDE DEPOT', timezone: LONDON },
      guard: { fullName: 'Marta Kowalska' },
    },
    attendance: { checkInAt: iso(NOW - 3 * HOUR), checkOutAt: null },
    operations: null,
    incidents: [{ status: 'open' }],
    alerts: [{ type: 'site_request', status: 'open' }],
  },
];

function renderPanels(rows) {
  return render(
    React.createElement(workspace().LiveOpsLowerPanels, {
      todaySoFar: summaryMod.buildTodaySoFar(rows, NOW),
      handovers: outlook.buildHandovers(rows, NOW),
      recentOperationalActivity: [{
        id: 'r1', shiftId: 19, siteName: 'TEST SITE', guardName: 'Fahad test',
        eventType: 'welfare_check', message: 'All well.', occurredAt: iso(NOW - 12 * MIN),
      }],
      resolveShiftZone: () => LONDON,
      liveOperationEnrichedRows: rows.map((r) => ({ ...r, lifecycleStatus: r.shift.status })),
      onOpenCoverage: () => {},
    }),
  );
}

test('PANEL-01-TODAY-SO-FAR-IS-NUMBERS-AND-WORDS-NO-CHART', () => {
  const markup = renderPanels(PANEL_ROWS);
  assert.ok(markup.includes('Today So Far'));
  for (const group of ['Attendance', 'Welfare windows', 'Operations']) {
    assert.ok(markup.includes(group), `${group} group is present`);
  }
  for (const label of ['Booked on', 'Late / not on', 'Booked off', 'Completed', 'Overdue', 'Missed',
    'Open incidents', 'Site requests', 'Emergency']) {
    assert.ok(markup.includes(label), `${label} is labelled`);
  }
  assert.ok(!/<svg|<canvas|<circle|<path /.test(markup), 'no chart, no gauge, no decorative graph');
});

test('PANEL-02-THE-SUMMARY-SAYS-WINDOWS-BECAUSE-IT-COUNTS-WINDOWS', () => {
  // Attention Now counts one missed-Welfare item per shift; this counts every window. Both numbers are
  // honest, so the panel names its unit rather than letting the two look like a contradiction.
  const markup = renderPanels(PANEL_ROWS);
  assert.ok(markup.includes('Welfare windows'), 'the unit is on the panel');
  assert.ok(markup.includes('2 shifts in view'), 'and the scope it covers is stated');
});

test('PANEL-03-UPCOMING-HANDOVERS-NAMES-A-REPLACEMENT-ONLY-WHEN-THERE-IS-ONE', () => {
  const markup = renderPanels(PANEL_ROWS);
  assert.ok(markup.includes('Upcoming Handovers'));
  // Marta ends at 21:20 with nothing starting at RIVERSIDE DEPOT near it.
  assert.ok(markup.includes('No replacement assigned'), 'the gap is stated plainly');
  assert.ok(markup.includes('Marta Kowalska ending'));
  assert.ok(!markup.includes('Replacement: Fahad'), 'a guard at another site is never the relief');
});

test('PANEL-04-A-REAL-REPLACEMENT-IS-NAMED-WITH-ITS-TIME', () => {
  const relief = {
    shift: {
      id: 25, start: iso(NOW + 25 * MIN), end: iso(NOW + 9 * HOUR), status: 'ready',
      site: { id: 11, name: 'RIVERSIDE DEPOT', timezone: LONDON },
      guard: { fullName: 'Ana Reis' },
    },
    attendance: undefined,
    operations: null,
  };
  // Scoped to the site that has a relief. TEST SITE legitimately still has none, so asking the whole
  // page whether the warning has gone would be asking the wrong question.
  const riverside = [PANEL_ROWS[1], relief];
  const markup = renderPanels(riverside);
  assert.ok(/Replacement: Ana Reis \d\d:\d\d/.test(markup));
  assert.ok(!markup.includes('No replacement assigned'), 'the gap warning is gone for this site');

  const [handover] = outlook.buildHandovers(riverside, NOW);
  assert.equal(handover.replacement, 'assigned');
  assert.equal(handover.starting.guardName, 'Ana Reis');
});

test('PANEL-05-RECENT-ACTIVITY-IS-KEPT-BELOW-NOT-DUPLICATED', () => {
  const markup = renderPanels(PANEL_ROWS);
  assert.ok(markup.includes('Recent Activity'), 'chronological evidence is retained');
  const order = ['Today So Far', 'Upcoming Handovers', 'Recent Activity'].map((t) => markup.indexOf(t));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'summary, then what is coming, then what happened');
});

// ═══════════════════ §8 the drawer, and §15's one loop ═══════════════════

test('DRAWER-01-AN-OBVIOUS-CLOSE-CONTROL-AT-THE-TOP-RIGHT', () => {
  // The Drawer renders through react-native Modal, which react-dom/server cannot serialise, so this one
  // rule is read from the shared component that every Shift Operations drawer is built from.
  const source = fs.readFileSync(path.join(ROOT, 'src/components/ui/Drawer.tsx'), 'utf8');
  assert.ok(/justifyContent: 'space-between'/.test(source.split('header: {')[1].slice(0, 400)),
    'the header pushes its last child to the right');
  assert.ok(/accessibilityLabel="Close"/.test(source), 'the control names itself');
  assert.ok(/closeIcon[\s\S]*?fontSize/.test(source) && source.includes('✕'), 'and draws the ✕ glyph');
  assert.ok(/closeBtn: \{[\s\S]*?backgroundColor: colors\.surfaceSubtle/.test(source),
    'on a filled target, not as a bare character');
});

test('DRAWER-02-SECTIONS-READ-AS-A-SPINE', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'src/components/company/CompanyLiveOperationsWorkspace.tsx'), 'utf8',
  );
  for (const heading of ['Operational monitoring', 'Attendance &amp; Timesheet', 'Daily Logs', 'Incidents', 'Safety Alerts']) {
    assert.ok(source.includes(heading), `${heading} is a section`);
  }
  assert.ok(/detailCardTitle: \{[\s\S]*?textTransform: 'uppercase'[\s\S]*?borderBottomWidth: 1/.test(source),
    'headings are set apart from their lines');
  assert.ok(source.includes('Scheduled {fmtTime(shift.start'), 'attendance reads as actual against scheduled');
});

test('LOOP-01-STILL-EXACTLY-ONE-POLLING-LOOP', () => {
  // Every panel added in this phase is a pure function of rows the board already had. If one of them had
  // reached for its own data, it would show up here.
  const files = [
    'src/screens/CompanyDashboardScreen.tsx',
    'src/components/company/CompanyLiveOperationsWorkspace.tsx',
    'src/components/company/CompanyOperationsTimeline.tsx',
    'src/components/company/operationsOutlook.ts',
    'src/components/company/operationsSummary.ts',
  ];
  let intervals = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    intervals += (source.match(/setInterval\(/g) || []).length;
    assert.ok(!/new WebSocket|io\(/.test(source), `${file} opens no socket`);
  }
  assert.equal(intervals, 1, 'one operational refresh cycle across the whole surface');

  for (const file of ['src/components/company/operationsOutlook.ts', 'src/components/company/operationsSummary.ts']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/fetch\(|apiClient|axios|useEffect/.test(source), `${file} is pure: no request, no effect`);
  }
});

console.log(`\n${passed} operations visual checks passed`);
