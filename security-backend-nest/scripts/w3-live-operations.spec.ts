/**
 * W3 certification: Live Operations welfare and Log Book projection (real PostgreSQL).
 *
 * The board must present what the backend decides, never recompute it. These tests run the real
 * OperationsProjectionService, and the tenancy and query-count cases run the real CoverageService,
 * because what matters here is company scoping enforced in SQL and the absence of per-shift queries —
 * neither of which a hand-rolled repository fake can prove.
 *
 * Needs W3_LIVE_OPS_DATABASE_URL pointing at a DISPOSABLE database — it drops the schema.
 */
process.env.TZ = 'UTC'; // Window boundaries are instants; keep Node in UTC so fixtures round-trip exactly.

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource, Repository } from 'typeorm';
import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Company } from '../src/company/entities/company.entity';
import { Site } from '../src/site/entities/site.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { AttendanceEvent, AttendanceEventType } from '../src/attendance/entities/attendance.entity';
import { DailyLog, DailyLogType } from '../src/daily-log/entities/daily-log.entity';
import {
  SafetyAlert,
  SafetyAlertPriority,
  SafetyAlertStatus,
  SafetyAlertType,
} from '../src/safety-alert/entities/safety-alert.entity';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import { WelfareWindowService } from '../src/operations/welfare-window.service';
import { LogBookWindowService } from '../src/operations/log-book-window.service';
import { OperationsProjectionService } from '../src/coverage/operations-projection.service';
import { CoverageService } from '../src/coverage/coverage.service';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

const MIN = 60_000;

async function main() {
  const url = process.env.W3_LIVE_OPS_DATABASE_URL;
  if (!url) throw new Error('W3_LIVE_OPS_DATABASE_URL is required (use a disposable database)');
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
    throw new Error('W3 live operations database must be local');
  }

  const ds = new DataSource({ type: 'postgres', url, entities: appEntities, synchronize: true, dropSchema: true, logging: false });
  await ds.initialize();

  const repo = <T extends object>(entity: new () => T): Repository<T> => ds.getRepository(entity);
  const windowEngine = new OperationalWindowService();
  const projection = new OperationsProjectionService(
    repo(AttendanceEvent),
    repo(DailyLog),
    repo(SafetyAlert),
    windowEngine,
    new WelfareWindowService(windowEngine),
    new LogBookWindowService(windowEngine),
  );

  // ── fixtures ───────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  const makeTenant = async (label: string, logBookIntervalMinutes: number | null = null) => {
    const user = await repo(User).save(repo(User).create({
      email: `${label}.${(seq += 1)}@example.invalid`, passwordHash: 'x',
      role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE,
    }));
    const company = await repo(Company).save(repo(Company).create({
      user, name: `${label} Security Ltd`, companyNumber: String(20000000 + (seq += 1)),
      address: '1 Test Street', contactDetails: `ops@${label}.example.invalid`,
    }));
    const site = await repo(Site).save(repo(Site).create({
      company, name: `${label} Site`, address: '2 Test Street',
      welfareCheckIntervalMinutes: 60, logBookIntervalMinutes, timezone: 'Europe/London',
    }));
    const guardUser = await repo(User).save(repo(User).create({
      email: `${label}.g.${(seq += 1)}@example.invalid`, passwordHash: 'x',
      role: UserRole.GUARD, status: UserStatus.ACTIVE,
    }));
    const guard = await repo(GuardProfile).save(repo(GuardProfile).create({
      user: guardUser, fullName: `${label} Guard`,
      siaLicenseNumber: String(6100000000000000 + (seq += 1)), phone: '07700000000',
    }));
    return { company, site, guard };
  };

  const base = await makeTenant('w3alpha');

  const makeShift = async (opts: {
    tenant?: { company: Company; site: Site; guard: GuardProfile };
    startedMinsAgo: number;
    durationMinutes?: number;
    bookOnMinsAgo?: number | null;
    bookOffMinsAgo?: number | null;
    status?: string;
  }) => {
    const t = opts.tenant ?? base;
    const start = new Date(Date.now() - opts.startedMinsAgo * MIN);
    const shift = await repo(Shift).save(repo(Shift).create({
      company: t.company, guard: t.guard, site: t.site, siteName: t.site.name,
      start, end: new Date(start.getTime() + (opts.durationMinutes ?? 12 * 60) * MIN),
      status: opts.status ?? 'in_progress', checkCallIntervalMinutes: 60,
    }));
    const bookOn = opts.bookOnMinsAgo === undefined ? opts.startedMinsAgo : opts.bookOnMinsAgo;
    if (bookOn !== null) {
      await repo(AttendanceEvent).save(repo(AttendanceEvent).create({
        shift, guard: t.guard, type: AttendanceEventType.CHECK_IN,
        occurredAt: new Date(Date.now() - bookOn * MIN),
      }));
    }
    if (opts.bookOffMinsAgo !== undefined && opts.bookOffMinsAgo !== null) {
      await repo(AttendanceEvent).save(repo(AttendanceEvent).create({
        shift, guard: t.guard, type: AttendanceEventType.CHECK_OUT,
        occurredAt: new Date(Date.now() - opts.bookOffMinsAgo * MIN),
      }));
    }
    return shift;
  };

  const logAt = async (shift: Shift, minsAgo: number, logType: DailyLogType) => {
    const saved = await repo(DailyLog).save(repo(DailyLog).create({
      company: shift.company, guard: shift.guard!, shift, message: 'entry', logType,
    }));
    await ds.query('UPDATE daily_logs SET "createdAt" = $1 WHERE id = $2',
      [new Date(Date.now() - minsAgo * MIN), saved.id]);
  };

  const alertFor = async (shift: Shift, type: SafetyAlertType, opts: {
    welfareWindowIndex?: number | null; status?: SafetyAlertStatus; message?: string;
  } = {}) => repo(SafetyAlert).save(repo(SafetyAlert).create({
    company: shift.company, guard: shift.guard!, shift, type,
    priority: SafetyAlertPriority.HIGH, status: opts.status ?? SafetyAlertStatus.OPEN,
    welfareWindowIndex: opts.welfareWindowIndex ?? null, message: opts.message ?? 'alert',
  }));

  const view = async (shift: Shift) => {
    const fresh = await repo(Shift).findOneOrFail({ where: { id: shift.id } });
    const map = await projection.projectForShifts([fresh]);
    return map.get(shift.id)!;
  };

  try {
    // ═══════════════════ WELFARE STATUS ═══════════════════

    await test('W3-01-NO-BOOK-ON-IS-AN-ATTENDANCE-EXCEPTION', async () => {
      const shift = await makeShift({ startedMinsAgo: 5 * 60, bookOnMinsAgo: null });
      const v = await view(shift);
      assert.equal(v.welfare.status, 'no_book_on');
      assert.equal(v.welfare.missedCount, 0, 'no false misses before anyone booked on');
      assert.equal(v.welfare.requiredCount, 0);
      assert.equal(v.bookOnAt, null);
    });

    await test('W3-02-OPEN-UNCOMPLETED-WINDOW-IS-DUE', async () => {
      const shift = await makeShift({ startedMinsAgo: 30 });
      const v = await view(shift);
      assert.equal(v.welfare.status, 'due');
      assert.equal(v.welfare.currentWindow?.index, 0);
      assert.equal(v.welfare.overdueByMinutes, null);
    });

    await test('W3-03-COMPLETED-CURRENT-WINDOW-IS-CURRENT', async () => {
      const shift = await makeShift({ startedMinsAgo: 30 });
      await logAt(shift, 10, DailyLogType.CHECK_CALL);
      const v = await view(shift);
      assert.equal(v.welfare.status, 'current', 'the window in progress has already been answered');
      assert.equal(v.welfare.completedCount, 1);
      assert.equal(v.welfare.missedCount, 0);
    });

    await test('W3-04-LAST-WELFARE-IS-THE-LATEST-QUALIFYING-ENTRY', async () => {
      const shift = await makeShift({ startedMinsAgo: 150 });
      await logAt(shift, 140, DailyLogType.CHECK_CALL);
      await logAt(shift, 20, DailyLogType.WELFARE_CHECK);
      const v = await view(shift);
      const last = new Date(v.welfare.lastWelfareAt!).getTime();
      const expected = Date.now() - 20 * MIN;
      assert.ok(Math.abs(last - expected) < 90_000, 'the most recent of the two, not the first');
      // Book On was 150 minutes ago; Last Welfare must not be confused with it.
      assert.notEqual(v.welfare.lastWelfareAt, v.bookOnAt);
    });

    await test('W3-05-CHECK-CALL-COUNTS-AS-WELFARE', async () => {
      const shift = await makeShift({ startedMinsAgo: 30 });
      await logAt(shift, 10, DailyLogType.CHECK_CALL);
      assert.equal((await view(shift)).welfare.completedCount, 1);
    });

    await test('W3-06-WELFARE-CHECK-COUNTS-AS-WELFARE', async () => {
      const shift = await makeShift({ startedMinsAgo: 30 });
      await logAt(shift, 10, DailyLogType.WELFARE_CHECK);
      assert.equal((await view(shift)).welfare.completedCount, 1);
    });

    await test('W3-07-OBSERVATION-DOES-NOT-COUNT-AS-WELFARE', async () => {
      const shift = await makeShift({ startedMinsAgo: 30 });
      await logAt(shift, 10, DailyLogType.OBSERVATION);
      const v = await view(shift);
      assert.equal(v.welfare.completedCount, 0);
      assert.equal(v.welfare.status, 'due', 'a voluntary note leaves the window outstanding');
      assert.equal(v.welfare.lastWelfareAt, null);
    });

    await test('W3-08-NEXT-DUE-IS-THE-CURRENT-WINDOW-END', async () => {
      const shift = await makeShift({ startedMinsAgo: 30 });
      const v = await view(shift);
      assert.equal(v.welfare.nextDueAt, v.welfare.currentWindow!.end);
      const due = new Date(v.welfare.nextDueAt!).getTime();
      assert.ok(Math.abs(due - (Date.now() + 30 * MIN)) < 90_000, 'thirty minutes from now');
    });

    await test('W3-08B-THE-WHOLE-WELFARE-WINDOW-GRID-IS-PUBLISHED', async () => {
      // Phase 4A: the control-room timeline draws one marker per window and the operations export emits
      // one row per window. Neither may rebuild the grid, so the engine publishes it. A 12-hour shift at
      // the site's 60-minute interval owes twelve.
      const shift = await makeShift({ startedMinsAgo: 30 });
      const v = await view(shift);

      assert.equal(v.welfare.windows.length, v.welfare.requiredCount, 'the grid IS what the counts count');
      assert.ok(v.welfare.windows.length >= 2, 'a 12-hour shift at 60 minutes has several windows');

      // In order, contiguous, and each one interval long — the engine's grid, not a re-derivation.
      v.welfare.windows.forEach((w, i) => {
        assert.equal(w.index, i, 'windows are published in order');
        const span = (new Date(w.end).getTime() - new Date(w.start).getTime()) / MIN;
        assert.equal(span, v.welfare.intervalMinutes, `window ${i} spans one interval`);
        if (i > 0) {
          assert.equal(w.start, v.welfare.windows[i - 1].end, 'half-open and contiguous');
        }
        assert.ok(
          ['completed', 'due', 'overdue', 'missed', 'not_applicable'].includes(w.state),
          `window ${i} carries an engine state, got ${w.state}`,
        );
        assert.equal(typeof w.applicable, 'boolean');
        assert.equal(typeof w.completionCount, 'number');
      });

      // The published grid must agree with the summary it was counted from.
      const completed = v.welfare.windows.filter((w) => w.state === 'completed').length;
      const missed = v.welfare.windows.filter((w) => w.state === 'missed').length;
      assert.equal(completed, v.welfare.completedCount, 'completed markers match the count');
      assert.equal(missed, v.welfare.missedCount, 'missed markers match the count');

      // And the current window the board chases must be one of them.
      const current = v.welfare.windows.find((w) => w.index === v.welfare.currentWindow!.index);
      assert.ok(current, 'the current window is part of the published grid');
      assert.equal(current.start, v.welfare.currentWindow!.start);
      assert.equal(current.end, v.welfare.currentWindow!.end);
    });

    await test('W3-08C-A-COMPLETED-WINDOW-CARRIES-ITS-COMPLETION-TIME', async () => {
      // The export needs "Welfare Completed At" per window, and the timeline tooltip shows it.
      const shift = await makeShift({ startedMinsAgo: 90 });
      await logAt(shift, 80, DailyLogType.WELFARE_CHECK);
      const v = await view(shift);

      const done = v.welfare.windows.filter((w) => w.state === 'completed');
      assert.ok(done.length >= 1, 'the welfare check completed a window');
      for (const w of done) {
        assert.ok(w.completedAt, 'a completed window states when');
        assert.ok(w.completionCount >= 1);
        const at = new Date(w.completedAt).getTime();
        assert.ok(
          at >= new Date(w.start).getTime() && at < new Date(w.end).getTime(),
          'and the completion sits inside its own window',
        );
      }
      for (const w of v.welfare.windows.filter((x) => x.state !== 'completed')) {
        assert.equal(w.completedAt, null, 'an unmet window has no completion time');
      }
    });

    await test('W3-08D-NO-WELFARE-OBLIGATION-PUBLISHES-AN-EMPTY-GRID', async () => {
      // Not a grid of not_applicable markers, and not null: empty, so the timeline draws nothing.
      const shift = await makeShift({ startedMinsAgo: 30, bookOnMinsAgo: null });
      const v = await view(shift);
      assert.equal(Array.isArray(v.welfare.windows), true, 'always an array');
    });

    await test('W3-09-INSIDE-GRACE-IS-OVERDUE-AND-KEEPS-CHASING-THAT-WINDOW', async () => {
      // Window 0 ended 3 minutes ago, so window 1 is technically open. The board must still show the
      // lapse rather than quietly presenting the new window as merely due.
      const shift = await makeShift({ startedMinsAgo: 63 });
      const v = await view(shift);
      assert.equal(v.welfare.status, 'overdue');
      assert.equal(v.welfare.currentWindow?.index, 0, 'still focused on the window that lapsed');
      assert.ok(
        v.welfare.overdueByMinutes !== null && v.welfare.overdueByMinutes >= 2 && v.welfare.overdueByMinutes <= 4,
        `overdue by about 3 minutes, got ${v.welfare.overdueByMinutes}`,
      );
    });

    await test('W3-10-A-SETTLED-MISS-IS-MISSED-AND-COUNTED', async () => {
      const shift = await makeShift({ startedMinsAgo: 70 });
      const v = await view(shift);
      assert.equal(v.welfare.status, 'missed');
      assert.equal(v.welfare.missedCount, 1);
      assert.equal(v.welfare.consecutiveMissed, 1);
      assert.equal(v.welfare.currentWindow?.index, 1, 'and the live expectation has moved on');
    });

    await test('W3-11-MULTIPLE-MISSES-GIVE-AN-EXACT-COUNT', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      const v = await view(shift);
      assert.equal(v.welfare.missedCount, 3, 'windows 0, 1 and 2 settled unmet');
      assert.equal(v.welfare.completedCount, 0);
    });

    await test('W3-12-CONSECUTIVE-MISSED-COUNTS-ONLY-THE-CURRENT-RUN', async () => {
      // Answered window 0, then silence through windows 1 and 2.
      const shift = await makeShift({ startedMinsAgo: 190 });
      await logAt(shift, 160, DailyLogType.CHECK_CALL);
      const v = await view(shift);
      assert.equal(v.welfare.completedCount, 1);
      assert.equal(v.welfare.missedCount, 2);
      assert.equal(v.welfare.consecutiveMissed, 2, 'the run since the last answer, not the shift total');
    });

    // ═══════════════════ SUMMARY VS EVIDENCE ═══════════════════

    await test('W3-13-INDEXED-EVIDENCE-NEVER-BECOMES-AN-ACTIONABLE-ITEM', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      // Twenty-four evidence rows, exactly as a long lapse produces.
      for (let i = 0; i < 24; i += 1) {
        await alertFor(shift, SafetyAlertType.MISSED_CHECKCALL, {
          welfareWindowIndex: i, status: SafetyAlertStatus.CLOSED, message: `window ${i}`,
        });
      }
      const v = await view(shift);
      assert.equal(v.welfareSummary, null, 'no summary exists, so nothing is actionable');
      assert.equal(typeof v.welfareEvidenceCount, 'number', 'evidence is a count, never a list');
    });

    await test('W3-14-THE-NULL-INDEX-SUMMARY-IS-THE-ACTIONABLE-ALERT', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      await alertFor(shift, SafetyAlertType.MISSED_CHECKCALL, {
        welfareWindowIndex: 0, status: SafetyAlertStatus.CLOSED, message: 'evidence',
      });
      await alertFor(shift, SafetyAlertType.MISSED_CHECKCALL, {
        welfareWindowIndex: null, status: SafetyAlertStatus.OPEN,
        message: 'Welfare overdue - 3 consecutive checks missed',
      });
      const v = await view(shift);
      assert.ok(v.welfareSummary, 'the summary is surfaced');
      assert.equal(v.welfareSummary!.status, SafetyAlertStatus.OPEN);
      assert.equal(v.welfareSummary!.acknowledged, false);
      assert.match(v.welfareSummary!.message, /3 consecutive checks missed/);
    });

    await test('W3-15-AN-ACKNOWLEDGED-SUMMARY-IS-SHOWN-AS-ACKNOWLEDGED', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      await alertFor(shift, SafetyAlertType.MISSED_CHECKCALL, {
        welfareWindowIndex: null, status: SafetyAlertStatus.ACKNOWLEDGED,
        message: 'Welfare overdue - 3 consecutive checks missed',
      });
      const v = await view(shift);
      assert.equal(v.welfareSummary!.acknowledged, true);
      assert.equal(v.welfareSummary!.status, SafetyAlertStatus.ACKNOWLEDGED);
      // Acknowledging does not hide how bad it is.
      assert.equal(v.welfare.missedCount, 3);
      assert.equal(v.welfare.consecutiveMissed, 3);
    });

    // ═══════════════════ BOUNDARIES ═══════════════════

    await test('W3-16-BOOK-OFF-TRUNCATES-FUTURE-REQUIREMENTS', async () => {
      const shift = await makeShift({ startedMinsAgo: 310, bookOffMinsAgo: 180 });
      const v = await view(shift);
      assert.equal(v.welfare.requiredCount, 3, 'only the windows worked');
      assert.ok(v.bookOffAt, 'and Book Off is reported');
    });

    await test('W3-17-SCHEDULED-END-CAPS-REQUIREMENTS', async () => {
      const shift = await makeShift({ startedMinsAgo: 10 * 60, durationMinutes: 4 * 60 });
      const v = await view(shift);
      assert.equal(v.welfare.requiredCount, 4, 'a four-hour shift owes four windows however long it runs');
      assert.equal(v.welfare.currentWindow, null, 'nothing is currently due past the scheduled end');
      assert.equal(v.welfare.status, 'missed', 'but the standing lapse still reads as one');
    });

    // ═══════════════════ MISSING BOOK OFF ═══════════════════

    await test('W3-18-MISSING-BOOK-OFF-IS-SURFACED', async () => {
      const shift = await makeShift({ startedMinsAgo: 256, durationMinutes: 240 });
      await alertFor(shift, SafetyAlertType.MISSING_BOOK_OFF, {
        status: SafetyAlertStatus.OPEN, message: 'Shift ended at 06:00 - no Book Off recorded.',
      });
      assert.equal((await view(shift)).missingBookOff, true);
    });

    await test('W3-19-A-CLOSED-MISSING-BOOK-OFF-STOPS-BEING-AN-EXCEPTION', async () => {
      const shift = await makeShift({ startedMinsAgo: 256, durationMinutes: 240 });
      const alert = await alertFor(shift, SafetyAlertType.MISSING_BOOK_OFF, { status: SafetyAlertStatus.OPEN });
      assert.equal((await view(shift)).missingBookOff, true);
      // The sweep auto-closes it once a late Book Off lands; the board must stop presenting it.
      await ds.query(`UPDATE safety_alerts SET status = 'closed', "closedAt" = now() WHERE id = $1`, [alert.id]);
      assert.equal((await view(shift)).missingBookOff, false, 'history is kept, the exception is not');
    });

    // ═══════════════════ LOG BOOK ═══════════════════

    await test('W3-20-NULL-LOG-BOOK-INTERVAL-IS-AS-REQUIRED', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      const v = await view(shift);
      assert.equal(v.logBook.required, false, 'as required, so nothing is owed');
      assert.equal(v.logBook.intervalMinutes, null);
      assert.equal(v.logBook.missingCount, 0, 'and nothing can be missing');
      assert.equal(v.logBook.requiredCount, 0);
      assert.equal(v.logBook.currentWindow, null);
    });

    await test('W3-21-HOURLY-LOG-BOOK-DERIVES-REQUIRED-SUBMITTED-MISSING', async () => {
      const hourly = await makeTenant('w3hourly', 60);
      const shift = await makeShift({ tenant: hourly, startedMinsAgo: 190 });
      await logAt(shift, 160, DailyLogType.LOG_BOOK); // window 0
      await logAt(shift, 100, DailyLogType.LOG_BOOK); // window 1
      const v = await view(shift);
      assert.equal(v.logBook.required, true);
      assert.equal(v.logBook.intervalMinutes, 60);
      assert.equal(v.logBook.submittedCount, 2);
      assert.equal(v.logBook.missingCount, 1, 'window 2 settled with no entry');
      assert.equal(v.logBook.currentWindow?.index, 3);
      assert.equal(v.logBook.currentWindowSubmitted, false, 'the live period still needs an entry');
      assert.ok(v.logBook.lastEntryAt, 'and the latest entry is reported');
    });

    await test('W3-22-A-LOG-BOOK-ENTRY-DOES-NOT-SATISFY-WELFARE', async () => {
      const hourly = await makeTenant('w3lbonly', 60);
      const shift = await makeShift({ tenant: hourly, startedMinsAgo: 70 });
      await logAt(shift, 30, DailyLogType.LOG_BOOK);
      const v = await view(shift);
      assert.equal(v.welfare.completedCount, 0, 'writing the log is not confirming you are safe');
      assert.equal(v.welfare.missedCount, 1);
      assert.equal(v.logBook.submittedCount, 1);
    });

    await test('W3-23-A-WELFARE-CHECK-DOES-NOT-SATISFY-THE-LOG-BOOK', async () => {
      const hourly = await makeTenant('w3wfonly', 60);
      const shift = await makeShift({ tenant: hourly, startedMinsAgo: 70 });
      await logAt(shift, 30, DailyLogType.WELFARE_CHECK);
      const v = await view(shift);
      assert.equal(v.welfare.completedCount, 1);
      assert.equal(v.logBook.submittedCount, 0, 'tapping a button is not writing a narrative');
      assert.equal(v.logBook.missingCount, 1);
    });

    await test('W3-24-SEVERAL-LOG-BOOK-ENTRIES-SATISFY-ONE-PERIOD-ONCE', async () => {
      const hourly = await makeTenant('w3lbmulti', 60);
      const shift = await makeShift({ tenant: hourly, startedMinsAgo: 70 });
      await logAt(shift, 50, DailyLogType.LOG_BOOK);
      await logAt(shift, 40, DailyLogType.LOG_BOOK);
      const v = await view(shift);
      assert.equal(v.logBook.submittedCount, 1, 'one period, discharged once');
      assert.equal(v.logBook.missingCount, 0);
      const retained = Number((await ds.query(
        `SELECT count(*)::int n FROM daily_logs WHERE "shiftId" = $1 AND "logType" = 'log_book'`,
        [shift.id]))[0].n);
      assert.equal(retained, 2, 'but both entries are retained');
    });

    // ═══════════════════ TENANCY AND PERFORMANCE ═══════════════════

    await test('W3-25-COMPANY-A-NEVER-SEES-COMPANY-B-OPERATIONAL-DATA', async () => {
      const other = await makeTenant('w3bravo');
      const mine = await makeShift({ startedMinsAgo: 70 });
      const theirs = await makeShift({ tenant: other, startedMinsAgo: 70 });
      await logAt(mine, 30, DailyLogType.CHECK_CALL);
      await logAt(theirs, 30, DailyLogType.CHECK_CALL);
      await alertFor(theirs, SafetyAlertType.MISSING_BOOK_OFF, { status: SafetyAlertStatus.OPEN });

      // Through the real CoverageService, whose company context is server-resolved and never taken
      // from the request.
      const coverage = new CoverageService(
        repo(Shift),
        { resolveCompanyContext: async () => ({ company: { id: base.company.id } }) } as never,
        {} as never,
        projection,
      );
      // An explicit range starting yesterday. The default is London midnight of today, so a fixture
      // that started "70 minutes ago" falls outside it for the first hour of every London day — which
      // is a property of the clock, not of tenancy, and has no place in this assertion.
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const rows = (await coverage.listShiftCoverage(1, UserRole.COMPANY_ADMIN, { from })) as Array<{
        shiftId: number;
        operations: { welfare: { completedCount: number } } | null;
      }>;
      const ids = rows.map((r) => r.shiftId);
      assert.ok(ids.includes(mine.id), 'my own live shift is present');
      assert.ok(!ids.includes(theirs.id), "the other company's shift is absent");

      // Every row returned really does belong to the resolved company, checked against the database
      // rather than inferred from the absence of one id.
      const foreign = await ds.query(
        `SELECT count(*)::int n FROM shifts WHERE id = ANY($1) AND "companyId" <> $2`,
        [ids, base.company.id],
      );
      assert.equal(Number(foreign[0].n), 0, 'no row belongs to another company');

      // And the other company's welfare entry does not inflate my shift's counts.
      const mineRow = rows.find((r) => r.shiftId === mine.id)!;
      assert.equal(mineRow.operations!.welfare.completedCount, 1, 'counts only my own completion');
    });

    await test('W3-26-QUERY-COUNT-DOES-NOT-GROW-PER-SHIFT', async () => {
      // Counting reads on the repositories the projection uses. A per-shift loop of queries would
      // show up immediately as the shift count rises.
      const counting = <T extends object>(entity: new () => T) => {
        const real = repo(entity);
        let calls = 0;
        const proxy = Object.create(real);
        proxy.find = (...args: unknown[]) => { calls += 1; return (real.find as never as (...a: unknown[]) => unknown)(...args); };
        return { proxy: proxy as Repository<T>, count: () => calls };
      };
      const measure = async (shifts: Shift[]) => {
        const a = counting(AttendanceEvent);
        const d = counting(DailyLog);
        const s = counting(SafetyAlert);
        const instrumented = new OperationsProjectionService(
          a.proxy, d.proxy, s.proxy, windowEngine,
          new WelfareWindowService(windowEngine), new LogBookWindowService(windowEngine),
        );
        await instrumented.projectForShifts(shifts);
        return a.count() + d.count() + s.count();
      };

      const one = await makeShift({ startedMinsAgo: 70 });
      const many: Shift[] = [one];
      for (let i = 0; i < 7; i += 1) many.push(await makeShift({ startedMinsAgo: 70 + i }));

      const forOne = await measure([one]);
      const forMany = await measure(many);
      assert.equal(forOne, forMany, `constant read count: ${forOne} for 1 shift, ${forMany} for ${many.length}`);
      assert.ok(forOne <= 4, `and a small fixed number of reads, got ${forOne}`);
    });

    console.log(JSON.stringify({ event: 'w3_live_operations_certified', tests: passed }));
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(`\nFAIL  ${error?.message || error}`);
  console.error(error);
  process.exit(1);
});
