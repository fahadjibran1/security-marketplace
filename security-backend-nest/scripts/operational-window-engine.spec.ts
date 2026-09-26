/**
 * Operational window engine certification (W1).
 *
 * The engine decides, for one shift, which periodic obligations existed and whether each one was
 * met. Two features share it — WELFARE CHECK (periodic safety confirmation) and LOG BOOK
 * (periodic written narrative) — and the most important property tested here is that they cannot
 * satisfy one another: a diligent log entry is not a welfare confirmation, and a welfare tap is
 * not a written log.
 *
 * Everything below is pure. The services are constructed with `new`, there is no Nest container,
 * no database and no reliance on the host machine's timezone.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import {
  MAX_WINDOWS_PER_SHIFT,
  OperationalWindowService,
} from '../src/operations/operational-window.service';
import {
  OperationalApplicability,
  OperationalCompletion,
  OperationalCompletionKind,
  OperationalWindowState,
} from '../src/operations/operational-window.types';
import {
  WELFARE_GRACE_MINUTES,
  WelfareWindowService,
} from '../src/operations/welfare-window.service';
import {
  LOG_BOOK_GRACE_MINUTES,
  LogBookWindowService,
} from '../src/operations/log-book-window.service';
import {
  classifyDailyLogType,
  toOperationalCompletions,
} from '../src/operations/operational-completion';
import { DailyLogType } from '../src/daily-log/entities/daily-log.entity';

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

const windowEngine = new OperationalWindowService();
const welfare = new WelfareWindowService(windowEngine);
const logBook = new LogBookWindowService(windowEngine);

/** September 2026, as UTC instants. Day 21 is the shift date, day 22 the following morning. */
const D = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(Date.UTC(2026, 8, day, hour, minute, second));

const SHIFT_START = D(21, 18);
const SHIFT_END = D(22, 6);
/** After the shift has finished, so every window has elapsed. */
const AFTER_SHIFT = D(22, 7);

const MINUTE = 60_000;

const onDutyThroughout = (): OperationalApplicability => ({
  bookOnAt: SHIFT_START,
  bookOffAt: null,
  shiftEnd: SHIFT_END,
});

const welfareAt = (date: Date): OperationalCompletion => ({
  at: date,
  kind: OperationalCompletionKind.WELFARE_CHECK,
});
const logBookAt = (date: Date): OperationalCompletion => ({
  at: date,
  kind: OperationalCompletionKind.LOG_BOOK,
});
const unclassifiedAt = (date: Date): OperationalCompletion => ({
  at: date,
  kind: OperationalCompletionKind.UNCLASSIFIED,
});

const resolveWelfare = (overrides: {
  completions?: OperationalCompletion[];
  applicability?: OperationalApplicability;
  now?: Date;
  siteInterval?: number | null;
  shiftInterval?: number | null;
}) =>
  welfare.resolve({
    shiftStart: SHIFT_START,
    shiftEnd: SHIFT_END,
    interval: {
      siteWelfareCheckIntervalMinutes: overrides.siteInterval ?? null,
      shiftCheckCallIntervalMinutes: overrides.shiftInterval ?? null,
    },
    completions: overrides.completions ?? [],
    applicability: overrides.applicability ?? onDutyThroughout(),
    now: overrides.now ?? AFTER_SHIFT,
  });

const resolveLogBook = (overrides: {
  intervalMinutes?: number | null;
  completions?: OperationalCompletion[];
  applicability?: OperationalApplicability;
  now?: Date;
}) =>
  logBook.resolve({
    shiftStart: SHIFT_START,
    shiftEnd: SHIFT_END,
    intervalMinutes: overrides.intervalMinutes === undefined ? 60 : overrides.intervalMinutes,
    completions: overrides.completions ?? [],
    applicability: overrides.applicability ?? onDutyThroughout(),
    now: overrides.now ?? AFTER_SHIFT,
  });

const states = (resolution: { windows: { state: OperationalWindowState }[] }) =>
  resolution.windows.map((window) => window.state);

async function main() {
  // ── Grid construction ──────────────────────────────────────────────────────────────────────

  await test('W1-01-GRID-12-WINDOWS-AT-60', () => {
    const windows = windowEngine.windowsFor({
      anchor: SHIFT_START,
      intervalMinutes: 60,
      notAfter: SHIFT_END,
    });
    assert.equal(windows.length, 12, 'an 18:00-06:00 shift has twelve hourly windows');
    assert.equal(windows[0].start.toISOString(), SHIFT_START.toISOString());
    assert.equal(windows[0].end.toISOString(), D(21, 19).toISOString());
    assert.equal(windows[11].end.toISOString(), SHIFT_END.toISOString(), 'the last window ends at the scheduled end');
    windows.forEach((window, index) => assert.equal(window.index, index, 'indices are contiguous from zero'));
  });

  await test('W1-02-GRID-24-WINDOWS-AT-30', () => {
    const windows = windowEngine.windowsFor({ anchor: SHIFT_START, intervalMinutes: 30, notAfter: SHIFT_END });
    assert.equal(windows.length, 24);
    assert.equal(windows[23].end.toISOString(), SHIFT_END.toISOString());
  });

  await test('W1-03-GRID-8-WHOLE-WINDOWS-AT-90', () => {
    const windows = windowEngine.windowsFor({ anchor: SHIFT_START, intervalMinutes: 90, notAfter: SHIFT_END });
    assert.equal(windows.length, 8, '720 minutes divides into eight 90-minute windows exactly');
    assert.equal(windows[7].end.toISOString(), SHIFT_END.toISOString());
  });

  await test('W1-04-HALF-OPEN-BOUNDARY', () => {
    const windows = windowEngine.windowsFor({ anchor: SHIFT_START, intervalMinutes: 60, notAfter: SHIFT_END });
    // No instant may belong to two windows, so the boundary belongs to the later one.
    assert.equal(windowEngine.windowContaining(windows, D(21, 18, 59, 59))?.index, 0);
    assert.equal(windowEngine.windowContaining(windows, new Date(D(21, 19).getTime() - 1))?.index, 0);
    assert.equal(windowEngine.windowContaining(windows, D(21, 19, 0, 0))?.index, 1);
    assert.equal(windowEngine.windowContaining(windows, SHIFT_START)?.index, 0, 'the anchor opens window 0');
    assert.equal(windowEngine.windowContaining(windows, SHIFT_END), null, 'the scheduled end is past the last window');
  });

  await test('W1-05-PARTIAL-TAIL-NOT-REQUIRED', () => {
    // 18:00 to 06:30 is twelve and a half hours. The trailing half hour is not a period anyone
    // can be asked to complete, so it carries no obligation.
    const windows = windowEngine.windowsFor({
      anchor: SHIFT_START,
      intervalMinutes: 60,
      notAfter: D(22, 6, 30),
    });
    assert.equal(windows.length, 12, 'twelve required, not thirteen');
    assert.equal(windows[11].end.toISOString(), SHIFT_END.toISOString());
  });

  // ── Completion attribution ─────────────────────────────────────────────────────────────────

  await test('W1-06-TWO-COMPLETIONS-COMPLETE-ONE-WINDOW-ONCE', () => {
    const resolution = resolveWelfare({ completions: [welfareAt(D(21, 18, 10)), welfareAt(D(21, 18, 40))] });
    assert.equal(resolution.windows[0].state, OperationalWindowState.COMPLETED);
    assert.equal(resolution.windows[0].completionCount, 2, 'both entries are retained');
    assert.equal(
      resolution.windows[0].completedAt?.toISOString(),
      D(21, 18, 10).toISOString(),
      'the first qualifying entry discharges the obligation',
    );
    assert.equal(resolution.summary.completedCount, 1, 'but the obligation is satisfied exactly once');
  });

  await test('W1-07-COMPLETION-DOES-NOT-CARRY-FORWARD', () => {
    const resolution = resolveWelfare({ completions: [welfareAt(D(21, 18, 30))] });
    assert.equal(resolution.windows[0].state, OperationalWindowState.COMPLETED);
    assert.equal(resolution.windows[1].state, OperationalWindowState.MISSED, 'the next window is its own obligation');
    assert.equal(resolution.summary.missedCount, 11);
  });

  await test('W1-08-COMPLETION-DOES-NOT-CARRY-BACK', () => {
    const resolution = resolveWelfare({ completions: [welfareAt(D(21, 19, 30))] });
    assert.equal(resolution.windows[0].state, OperationalWindowState.MISSED, 'a later entry cannot repair an earlier window');
    assert.equal(resolution.windows[1].state, OperationalWindowState.COMPLETED);
  });

  await test('W1-09-GRACE-IS-5-MINUTES', () => {
    assert.equal(WELFARE_GRACE_MINUTES, 5, 'product-locked Welfare grace');
    assert.equal(LOG_BOOK_GRACE_MINUTES, 5, 'product-locked Log Book grace');

    const firstWindowEnd = D(21, 19).getTime();
    const stateAt = (offsetMinutes: number) =>
      resolveWelfare({ now: new Date(firstWindowEnd + offsetMinutes * MINUTE) }).windows[0].state;

    assert.equal(stateAt(-1), OperationalWindowState.DUE, 'not yet elapsed');
    assert.equal(stateAt(4), OperationalWindowState.OVERDUE, 'elapsed, inside grace');
    assert.equal(stateAt(5), OperationalWindowState.MISSED, 'the grace boundary is inclusive of MISSED');
    assert.equal(stateAt(6), OperationalWindowState.MISSED, 'elapsed, beyond grace');
  });

  // ── Attendance applicability ───────────────────────────────────────────────────────────────

  await test('W1-10-NO-BOOK-ON-NOTHING-WAS-REQUIRED', () => {
    // A Guard who never booked on has an attendance exception, not twelve missed welfare checks.
    const resolution = resolveWelfare({
      applicability: { bookOnAt: null, bookOffAt: null, shiftEnd: SHIFT_END },
    });
    assert.ok(
      states(resolution).every((state) => state === OperationalWindowState.NOT_APPLICABLE),
      'every window is not applicable',
    );
    assert.equal(resolution.summary.requiredCount, 0);
    assert.equal(resolution.summary.missedCount, 0);
    assert.equal(resolution.summary.compliancePercent, null, 'no obligation is not 0% compliance');
  });

  await test('W1-11-LATE-BOOK-ON-EXCLUDES-EARLIER-WINDOWS', () => {
    const resolution = resolveWelfare({
      applicability: { bookOnAt: D(21, 20, 15), bookOffAt: null, shiftEnd: SHIFT_END },
    });
    assert.equal(resolution.windows[0].state, OperationalWindowState.NOT_APPLICABLE, '18:00-19:00');
    assert.equal(resolution.windows[1].state, OperationalWindowState.NOT_APPLICABLE, '19:00-20:00');
    assert.equal(resolution.windows[2].applicable, true, '20:00-21:00 overlaps duty, so it applies');
    assert.equal(resolution.summary.requiredCount, 10);
    assert.equal(resolution.summary.notApplicableCount, 2);
  });

  await test('W1-12-EARLY-BOOK-OFF-TRUNCATES-APPLICABILITY', () => {
    const resolution = resolveWelfare({
      applicability: { bookOnAt: SHIFT_START, bookOffAt: D(21, 22), shiftEnd: SHIFT_END },
    });
    assert.equal(resolution.windows[3].applicable, true, '21:00-22:00 elapsed while on duty');
    assert.equal(resolution.windows[4].state, OperationalWindowState.NOT_APPLICABLE, '22:00-23:00 is after Book Off');
    assert.equal(resolution.summary.requiredCount, 4);
  });

  await test('W1-13-LATE-BOOK-OFF-DOES-NOT-EXTEND-OBLIGATION', () => {
    const resolution = resolveWelfare({
      applicability: { bookOnAt: SHIFT_START, bookOffAt: D(22, 8), shiftEnd: SHIFT_END },
    });
    assert.equal(resolution.windows.length, 12, 'overrunning the shift adds no windows');
    assert.equal(resolution.summary.requiredCount, 12);
    assert.equal(
      resolution.windows[11].end.toISOString(),
      SHIFT_END.toISOString(),
      'obligation still stops at the scheduled end',
    );
  });

  await test('W1-14-CANCELLED-SHIFT-IS-DETERMINISTIC', () => {
    const resolution = resolveWelfare({
      completions: [welfareAt(D(21, 18, 10))],
      applicability: { bookOnAt: SHIFT_START, bookOffAt: null, shiftEnd: SHIFT_END, cancelled: true },
    });
    assert.ok(states(resolution).every((state) => state === OperationalWindowState.NOT_APPLICABLE));
    assert.equal(resolution.summary.requiredCount, 0);
    assert.equal(resolution.summary.compliancePercent, null);
    assert.equal(
      resolution.windows[0].completionCount,
      1,
      'the entry is still reported, so the Operations Log can show it; only the obligation is gone',
    );
  });

  // ── Time and DST ───────────────────────────────────────────────────────────────────────────

  await test('W1-15-DST-WINDOWS-ARE-60-REAL-MINUTES', () => {
    // Europe/London springs forward at 2026-03-29T01:00Z: the local clock reads 01:00 GMT then
    // 02:00 BST. A window spanning that instant is still exactly 60 minutes of elapsed time.
    const londonZone = (date: Date) =>
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' })
        .formatToParts(date)
        .find((part) => part.type === 'timeZoneName')?.value;
    assert.equal(londonZone(new Date('2026-03-29T00:59:00Z')), 'GMT', 'sanity: still GMT');
    assert.equal(londonZone(new Date('2026-03-29T01:00:00Z')), 'BST', 'sanity: a real transition is being crossed');

    const anchor = new Date('2026-03-28T22:00:00Z');
    const notAfter = new Date('2026-03-29T06:00:00Z');
    const windows = windowEngine.windowsFor({ anchor, intervalMinutes: 60, notAfter });

    assert.equal(windows.length, 8, 'eight real hours elapse, whatever the local clock says');
    windows.forEach((window) =>
      assert.equal(
        window.end.getTime() - window.start.getTime(),
        60 * MINUTE,
        'every window is 60 real minutes, including the one containing the transition',
      ),
    );
    assert.equal(
      windows[7].end.getTime() - windows[0].start.getTime(),
      8 * 60 * MINUTE,
      'the grid spans exactly interval x count',
    );
    // The boundary crossing the transition is the instant, not the local hour: the window ending
    // at 01:00Z is followed immediately by the one starting at 01:00Z, even though the London
    // clock reads 01:00 and then 02:00.
    assert.equal(windows[2].end.toISOString(), '2026-03-29T01:00:00.000Z');
    assert.equal(windows[3].start.toISOString(), '2026-03-29T01:00:00.000Z');
  });

  // ── Welfare interval precedence ────────────────────────────────────────────────────────────

  await test('W1-16-WELFARE-INTERVAL-PRECEDENCE', () => {
    const resolve = (site: number | null, shift: number | null) =>
      welfare.resolveIntervalMinutes({
        siteWelfareCheckIntervalMinutes: site,
        shiftCheckCallIntervalMinutes: shift,
      });

    assert.equal(resolve(30, 60), 30, 'the site setting wins');
    assert.equal(resolve(null, 45), 45, 'then the shift setting');
    assert.equal(resolve(null, null), 60, 'then the 60-minute default');
    assert.equal(resolve(1, null), 5, 'floored at 5 minutes so bad config cannot cause an alert storm');
    // Pinning the pre-existing `Number(x) || 60` semantics the sweep has always had: a zero site
    // interval resolves to the default rather than falling through to the shift value.
    assert.equal(resolve(0, 45), 60, 'a zero site interval means the default, not the shift value');
    assert.equal(resolve(Number.NaN, null), 60, 'unusable values become the default');
  });

  // ── Completion classification ──────────────────────────────────────────────────────────────

  await test('W1-17-HISTORICAL-CHECK-CALL-COUNTS-AS-WELFARE', () => {
    assert.equal(classifyDailyLogType(DailyLogType.CHECK_CALL), OperationalCompletionKind.WELFARE_CHECK);
    assert.equal(welfare.isWelfareCompletionLogType(DailyLogType.CHECK_CALL), true);

    // Through the real mapping a persisted row takes, so the rename cannot invalidate history.
    const resolution = resolveWelfare({
      completions: toOperationalCompletions([{ logType: DailyLogType.CHECK_CALL, createdAt: D(21, 18, 20) }]),
    });
    assert.equal(resolution.windows[0].state, OperationalWindowState.COMPLETED);
  });

  await test('W1-18-WELFARE-CHECK-COUNTS-AS-WELFARE', () => {
    assert.equal(classifyDailyLogType(DailyLogType.WELFARE_CHECK), OperationalCompletionKind.WELFARE_CHECK);
    const resolution = resolveWelfare({
      completions: toOperationalCompletions([{ logType: DailyLogType.WELFARE_CHECK, createdAt: D(21, 18, 20) }]),
    });
    assert.equal(resolution.windows[0].state, OperationalWindowState.COMPLETED);
  });

  await test('W1-19-OBSERVATION-DOES-NOT-COMPLETE-WELFARE', () => {
    assert.equal(classifyDailyLogType(DailyLogType.OBSERVATION), OperationalCompletionKind.UNCLASSIFIED);
    const resolution = resolveWelfare({
      completions: toOperationalCompletions([{ logType: DailyLogType.OBSERVATION, createdAt: D(21, 18, 20) }]),
    });
    assert.equal(
      resolution.windows[0].state,
      OperationalWindowState.MISSED,
      'a voluntary note is not a safety confirmation',
    );
  });

  await test('W1-20-COMPLETION-SETS-ARE-STRUCTURALLY-INDEPENDENT', () => {
    // No persisted log type may classify as LOG_BOOK: the `log_book` enum value does not exist
    // until Migration 59, and faking it would let voluntary notes discharge a written obligation.
    const persisted = Object.values(DailyLogType);
    assert.ok(persisted.length > 0, 'sanity: the enum was read');
    persisted.forEach((logType) =>
      assert.notEqual(
        classifyDailyLogType(logType),
        OperationalCompletionKind.LOG_BOOK,
        `${logType} must not be treated as a Log Book entry before Migration 59`,
      ),
    );

    // One mixed batch, handed to both resolvers. Each sees only its own kind.
    const mixed = [welfareAt(D(21, 18, 10)), logBookAt(D(21, 19, 10)), unclassifiedAt(D(21, 20, 10))];
    const welfareResolution = resolveWelfare({ completions: mixed });
    const logBookResolution = resolveLogBook({ completions: mixed });

    assert.equal(welfareResolution.summary.completedCount, 1, 'welfare sees only the welfare entry');
    assert.equal(welfareResolution.windows[0].state, OperationalWindowState.COMPLETED);
    assert.equal(logBookResolution.summary.completedCount, 1, 'log book sees only the log book entry');
    assert.equal(logBookResolution.windows[1].state, OperationalWindowState.COMPLETED);
    assert.equal(logBookResolution.windows[0].state, OperationalWindowState.MISSED);
  });

  // ── Log Book ───────────────────────────────────────────────────────────────────────────────

  await test('W1-21-NULL-LOG-BOOK-INTERVAL-REQUIRES-NOTHING', () => {
    const resolution = resolveLogBook({ intervalMinutes: null, completions: [logBookAt(D(21, 18, 10))] });
    assert.equal(resolution.intervalMinutes, null, '"As required" is reported as null, not 0');
    assert.deepEqual(resolution.windows, [], 'no periodic obligation means no windows');
    assert.equal(resolution.summary.requiredCount, 0);
    assert.equal(resolution.summary.missedCount, 0, 'nothing can ever be missing');
    assert.equal(resolution.summary.compliancePercent, null);
  });

  await test('W1-22-WELFARE-60-AND-LOG-BOOK-120-ARE-INDEPENDENT-GRIDS', () => {
    const welfareResolution = resolveWelfare({ siteInterval: 60 });
    const logBookResolution = resolveLogBook({ intervalMinutes: 120 });
    assert.equal(welfareResolution.windows.length, 12);
    assert.equal(logBookResolution.windows.length, 6);

    // The same instant sits in different periods for each obligation.
    const at2130 = D(21, 21, 30);
    assert.equal(windowEngine.windowContaining(welfareResolution.windows, at2130)?.index, 3);
    assert.equal(windowEngine.windowContaining(logBookResolution.windows, at2130)?.index, 1);

    // And a non-multiple interval produces boundaries welfare does not have at all.
    const ninety = windowEngine.windowsFor({ anchor: SHIFT_START, intervalMinutes: 90, notAfter: SHIFT_END });
    assert.equal(ninety[1].start.toISOString(), D(21, 19, 30).toISOString());
    assert.equal(
      welfareResolution.windows.some((window) => window.start.getTime() === ninety[1].start.getTime()),
      false,
      'the two grids need not share boundaries',
    );
  });

  await test('W1-23-MULTIPLE-LOG-BOOK-ENTRIES-IN-ONE-PERIOD', () => {
    // A Guard who writes twice in an hour has recorded more, not complied twice. Both entries
    // must survive for the logbook to be worth anything as a record.
    const resolution = resolveLogBook({
      completions: [logBookAt(D(21, 18, 10)), logBookAt(D(21, 18, 50))],
    });
    assert.equal(resolution.windows[0].completionCount, 2, 'both entries retained');
    assert.equal(resolution.windows[0].state, OperationalWindowState.COMPLETED);
    assert.equal(resolution.summary.completedCount, 1, 'one obligation discharged');
  });

  await test('W1-24-LOG-BOOK-ENTRY-DOES-NOT-SATISFY-WELFARE', () => {
    const resolution = resolveWelfare({
      completions: [logBookAt(D(21, 18, 10)), logBookAt(D(21, 19, 10))],
    });
    assert.equal(resolution.summary.completedCount, 0);
    assert.equal(resolution.summary.missedCount, 12, 'writing the log is not confirming you are safe');
  });

  await test('W1-25-WELFARE-CHECK-DOES-NOT-SATISFY-LOG-BOOK', () => {
    const resolution = resolveLogBook({
      completions: [welfareAt(D(21, 18, 10)), welfareAt(D(21, 19, 10))],
    });
    assert.equal(resolution.summary.completedCount, 0);
    assert.equal(resolution.summary.missedCount, 12, 'tapping a button is not writing a narrative');
  });

  // ── Supporting guarantees ──────────────────────────────────────────────────────────────────

  await test('W1-26-SUMMARY-ARITHMETIC', () => {
    // Six of twelve hourly windows completed.
    const completions = [0, 1, 2, 3, 4, 5].map((hour) => welfareAt(D(21, 18 + hour, 30)));
    const resolution = resolveWelfare({ completions });
    assert.equal(resolution.summary.requiredCount, 12);
    assert.equal(resolution.summary.completedCount, 6);
    assert.equal(resolution.summary.missedCount, 6);
    assert.equal(resolution.summary.compliancePercent, 50);
    assert.equal(
      resolution.summary.completedCount + resolution.summary.missedCount,
      resolution.summary.requiredCount,
      'every applicable window resolves to exactly one outcome once elapsed',
    );
  });

  await test('W1-27-IN-PROGRESS-SHIFT-MIXES-DUE-AND-SETTLED', () => {
    // Mid-shift at 20:30: windows 0 and 1 have elapsed, window 2 is still running.
    const resolution = resolveWelfare({ completions: [welfareAt(D(21, 18, 30))], now: D(21, 20, 30) });
    assert.equal(resolution.windows[0].state, OperationalWindowState.COMPLETED);
    assert.equal(resolution.windows[1].state, OperationalWindowState.MISSED);
    assert.equal(resolution.windows[2].state, OperationalWindowState.DUE, 'the current window is not yet late');
    assert.equal(resolution.summary.dueCount, 10);
  });

  await test('W1-28-APPLICABLE-WINDOWS-HELPER-AGREES-WITH-RESOLVE', () => {
    const applicability: OperationalApplicability = {
      bookOnAt: D(21, 20, 15),
      bookOffAt: D(21, 23),
      shiftEnd: SHIFT_END,
    };
    const grid = windowEngine.windowsFor({ anchor: SHIFT_START, intervalMinutes: 60, notAfter: SHIFT_END });
    const applicable = windowEngine.applicableWindows(grid, applicability);
    const resolution = resolveWelfare({ applicability });
    assert.deepEqual(
      applicable.map((window) => window.index),
      resolution.windows.filter((window) => window.applicable).map((window) => window.index),
      'the helper and the resolver must never disagree about what was required',
    );
    assert.deepEqual(applicable.map((window) => window.index), [2, 3, 4]);
  });

  await test('W1-29-MALFORMED-GRIDS-PRODUCE-NO-OBLIGATION', () => {
    const nothing = (intervalMinutes: number | null, notAfter: Date) =>
      windowEngine.windowsFor({ anchor: SHIFT_START, intervalMinutes, notAfter });
    assert.deepEqual(nothing(0, SHIFT_END), [], 'a zero interval is no obligation, not an infinite loop');
    assert.deepEqual(nothing(-60, SHIFT_END), []);
    assert.deepEqual(nothing(60, SHIFT_START), [], 'a zero-length shift requires nothing');
    assert.deepEqual(nothing(60, D(21, 17)), [], 'an end before the start requires nothing');
    assert.deepEqual(nothing(60, new Date(Number.NaN)), []);

    // A runaway shift end is capped rather than allowed to exhaust memory inside the sweep.
    const runaway = windowEngine.windowsFor({
      anchor: SHIFT_START,
      intervalMinutes: 5,
      notAfter: new Date('9999-01-01T00:00:00Z'),
    });
    assert.equal(runaway.length, MAX_WINDOWS_PER_SHIFT);
  });

  await test('W1-30-RESOLVER-IS-BEHAVIOUR-IDENTICAL-TO-THE-OLD-SWEEP-EXPRESSION', () => {
    // W1 repointed the missed-welfare sweep at resolveIntervalMinutes. That is only a safe
    // internal refactor if the resolver is indistinguishable from the expression it replaced, so
    // the old one is reproduced verbatim here and compared across every awkward input.
    const previous = (site: unknown, shift: unknown) =>
      Math.max(5, Number((site ?? shift ?? 60) as number) || 60);

    const candidates: unknown[] = [null, undefined, 0, 1, 5, 30, 45, 60, 120, -10, Number.NaN, '30', 'oops'];
    candidates.forEach((site) =>
      candidates.forEach((shift) =>
        assert.equal(
          welfare.resolveIntervalMinutes({
            siteWelfareCheckIntervalMinutes: site as number | null,
            shiftCheckCallIntervalMinutes: shift as number | null,
          }),
          previous(site, shift),
          `interval must be unchanged for site=${String(site)} shift=${String(shift)}`,
        ),
      ),
    );
  });

  console.log(`\n${passed} operational window engine checks passed`);
}

main().catch((error) => {
  console.error(`\nFAIL  ${error?.message || error}`);
  process.exit(1);
});
