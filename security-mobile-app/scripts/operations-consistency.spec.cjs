#!/usr/bin/env node
/**
 * The board and the file must describe the same operations. (Phase 4A.2 §11.)
 *
 * A silent difference between the timeline a controller reads and the evidence they hand over is the
 * worst failure this feature could have — and it is exactly the kind that no unit test catches, because
 * each side is individually correct. So both surfaces are built from ONE fixture at ONE instant and
 * compared row for row and glyph for status.
 *
 * The fixture is the deterministic control-room dataset the visual review uses, imported rather than
 * re-declared, so the screenshots, the export proof and this check can never drift apart.
 *
 * ONE DIFFERENCE IS CORRECT AND IS ASSERTED AS SUCH. The timeline draws only what is ON the axis — a
 * window outside the visible hours is dropped, never clamped — while the export always covers the whole
 * shift. So markers are compared against the VISIBLE windows; comparing them to the whole file would be
 * comparing a screen to a day.
 */
const assert = require('node:assert/strict');
const { loadTs } = require('./load-ts.cjs');
const { FIXTURE, NOW, LONDON } = require('./operations-timeline-preview.cjs');

const timeline = loadTs('src/components/company/operationsTimeline.ts');
const report = loadTs('src/components/company/operationsReport.ts');

const scope = { date: report.reportDateFor(new Date(NOW).toISOString(), LONDON), siteName: null };
const built = report.buildOperationsReport(FIXTURE, scope);

/** The marker a controller sees, and the words the file prints for the same window. */
const GLYPH_TO_LABEL = {
  '\u2713': 'Completed',
  '\u25cf': 'Due',
  '!': 'Overdue Welfare Check',
  '\u2715': 'Missed Welfare Check',
  '\u2014': 'Not required',
};

const col = (name) => report.WELFARE_COLUMNS.indexOf(name);

let passed = 0;
const check = (ok, label) => {
  if (ok) {
    passed += 1;
    console.log('PASS ', label);
  } else {
    console.error('FAIL ', label);
    process.exitCode = 1;
  }
};

for (const hours of [8, 24]) {
  const window = timeline.resolveTimelineWindow(NOW, hours, LONDON);
  const groups = timeline.buildTimeline(FIXTURE, window, NOW);
  const rows = groups.flatMap((g) => g.rows);

  console.log('');
  console.log(`── ${hours}h window ${new Date(window.startMs).toISOString()} → ${new Date(window.endMs).toISOString()} ──`);

  check(
    timeline.timelineRowCount(groups) === built.summary.length,
    `rows drawn (${timeline.timelineRowCount(groups)}) == summary rows (${built.summary.length})`,
  );

  const markers = rows.flatMap((r) => r.welfare);
  const windowRows = built.welfare.filter((r) => r[col('Welfare Window Start')] !== '');
  const placeholders = built.welfare.length - windowRows.length;

  const visibleWindows = FIXTURE
    .flatMap((input) => input.operations?.welfare?.windows ?? [])
    .filter((w) => Date.parse(w.end) > window.startMs && Date.parse(w.start) < window.endMs);

  check(
    markers.length === visibleWindows.length,
    `markers drawn (${markers.length}) == windows on the axis (${visibleWindows.length}); the file carries all ${windowRows.length}`,
  );
  check(
    built.welfare.length === windowRows.length + placeholders,
    `Welfare sheet = ${windowRows.length} windows + ${placeholders} shifts with no Welfare grid = ${built.welfare.length}`,
  );

  // Matched by START TIME, not by index, so a dropped off-axis window cannot silently shift the
  // alignment and make two disagreeing lists look like they agree.
  let matched = 0;
  let mismatched = 0;
  for (const row of rows) {
    const exported = built.welfare.filter(
      (r) => r[col('Guard')] === row.guardName && r[col('Welfare Window Start')] !== '',
    );
    for (const marker of row.welfare) {
      const at = marker.accessibleLabel.match(/Welfare Check (\d\d:\d\d)–/)[1];
      const line = exported.find((r) => r[col('Welfare Window Start')] === at);
      if (!line || line[col('Welfare Status')] !== GLYPH_TO_LABEL[marker.glyph]) mismatched += 1;
      else matched += 1;
    }
  }
  check(
    mismatched === 0 && matched === markers.length,
    `every drawn marker matches its exported row by start time and status (${matched} matched, ${mismatched} mismatched)`,
  );
}

// A shift the timeline does not draw is off the axis, so the same scope does not put it on screen
// either — the two surfaces agree about absence as well as about content.
//
// It has to be a SETTLED shift. A shift someone booked on to and never booked off from has not ended,
// so its bar runs to now and it is drawn however old its schedule is — that is UAT FIX 01's carry-over
// rule, and the case below is asserted immediately after so the distinction is on the record.
const window8 = timeline.resolveTimelineWindow(NOW, 8, LONDON);
const settledOffAxis = {
  ...FIXTURE[0],
  shift: { ...FIXTURE[0].shift, id: 999, status: 'completed', start: '2026-09-20T08:00:00.000Z', end: '2026-09-20T16:00:00.000Z' },
  attendance: { checkInAt: '2026-09-20T07:58:00.000Z', checkOutAt: '2026-09-20T16:02:00.000Z' },
};
check(
  timeline.timelineRowCount(timeline.buildTimeline([settledOffAxis], window8, NOW)) === 0,
  'a settled shift off the axis is drawn as no row',
);

const unclosedOffAxis = {
  ...FIXTURE[0],
  shift: { ...FIXTURE[0].shift, id: 998, status: 'in_progress', start: '2026-09-20T08:00:00.000Z', end: '2026-09-20T16:00:00.000Z' },
  attendance: { checkInAt: '2026-09-20T07:58:00.000Z', checkOutAt: null },
};
check(
  timeline.timelineRowCount(timeline.buildTimeline([unclosedOffAxis], window8, NOW)) === 1,
  'but a shift still booked on IS drawn, however old — the relevance policy holds in_progress with no time bound',
);

assert.ok(FIXTURE.length > 0, 'the fixture must not be empty');

console.log('');
console.log(
  process.exitCode
    ? 'TIMELINE/EXPORT CONSISTENCY: FAILED'
    : `TIMELINE/EXPORT CONSISTENCY: ${passed} checks passed`,
);
