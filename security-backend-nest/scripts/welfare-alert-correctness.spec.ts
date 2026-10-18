/**
 * Welfare alert correctness certification (Welfare & Reporting Remediation, Phase 1).
 *
 * OWNER POLICY, 18 October 2026: every genuinely missed Welfare window must create an actionable
 * control-room alert once its grace period has passed. One miss is enough.
 *
 * The production evidence this certifies against (pilot shift 32, 17-18 October 2026, hourly, all UTC):
 *   scheduled 20:00-06:00, Book On 18:26, Welfare Checks 18:29, 20:26, 21:01, 22:05, 22:57, 00:04.
 *   Window 23:00-00:00 was recorded missed at 00:08 — and, because 00:00-01:00 had already been met at
 *   00:04, the sweep raised NOTHING actionable: the miss existed only as a closed history row, which the
 *   drawer showed as "Missed Checkcall (Closed)". The Guard had in fact checked in at 22:57, three minutes
 *   before that window started.
 *
 * Two changes are certified here:
 *   1. ALERTING. A missed window opens (or escalates) the shift's single actionable summary, whatever
 *      happened after it. Nothing closes that summary automatically: not a later Welfare Check, not Book
 *      Off. A person resolves it, with a reason and a note.
 *   2. EARLY-CHECK TOLERANCE. A check made up to five minutes before a window starts counts for that
 *      window, but only when the window it was made in is already met. It satisfies one window only,
 *      never counts outside the genuine duty period, and keeps its real timestamp.
 *
 * The engine cases are pure and use fixed instants. The sweep cases run the real SafetyAlertService on a
 * real, disposable PostgreSQL database; the sweep reads the real clock, so those shifts are placed
 * relative to now, as the W2 and live-ops-correctness specs do.
 *
 * Needs WELFARE_ALERT_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Company } from '../src/company/entities/company.entity';
import { Site } from '../src/site/entities/site.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { AttendanceEvent, AttendanceEventType } from '../src/attendance/entities/attendance.entity';
import { DailyLog, DailyLogType } from '../src/daily-log/entities/daily-log.entity';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import {
  SafetyAlert,
  SafetyAlertPriority,
  SafetyAlertStatus,
  SafetyAlertType,
} from '../src/safety-alert/entities/safety-alert.entity';
import { SafetyAlertService } from '../src/safety-alert/safety-alert.service';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import {
  OperationalApplicability,
  OperationalCompletionKind,
  OperationalWindowState,
} from '../src/operations/operational-window.types';
import {
  WELFARE_EARLY_TOLERANCE_MINUTES,
  WELFARE_GRACE_MINUTES,
  WelfareWindowService,
} from '../src/operations/welfare-window.service';
import { LogBookWindowService } from '../src/operations/log-book-window.service';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

/** Asserts the call is refused with the given exception type; returns its message. */
async function refused(fn: () => Promise<unknown>, type: new (...args: never[]) => Error, because: string) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof type, `${because}: expected ${type.name}, got ${(error as Error)?.constructor?.name}`);
    return (error as Error).message;
  }
  throw new Error(`expected refusal: ${because}`);
}

const MIN = 60_000;
const { MISSED, COMPLETED, DUE, NOT_APPLICABLE } = OperationalWindowState;

// ═══════════════════ pure engine fixtures ═══════════════════

const windowEngine = new OperationalWindowService();
const welfare = new WelfareWindowService(windowEngine);
const logBook = new LogBookWindowService(windowEngine);

/** A UTC instant in October 2026. */
const Z = (day: number, hour: number, minute = 0, second = 0, ms = 0) =>
  new Date(Date.UTC(2026, 9, day, hour, minute, second, ms));

const resolveWelfareAt = (opts: {
  start: Date;
  end: Date;
  checks: Date[];
  now: Date;
  bookOnAt?: Date | null;
  bookOffAt?: Date | null;
}) =>
  welfare.resolve({
    shiftStart: opts.start,
    shiftEnd: opts.end,
    interval: { siteWelfareCheckIntervalMinutes: 60, shiftCheckCallIntervalMinutes: 60 },
    completions: opts.checks.map((at) => ({ at, kind: OperationalCompletionKind.WELFARE_CHECK })),
    applicability: {
      bookOnAt: opts.bookOnAt === undefined ? opts.start : opts.bookOnAt,
      bookOffAt: opts.bookOffAt ?? null,
      shiftEnd: opts.end,
    } as OperationalApplicability,
    now: opts.now,
  });

const statesOf = (r: { windows: { state: OperationalWindowState }[] }) => r.windows.map((w) => w.state);

/** Pilot shift 32 as recorded in production (UTC). */
const S32 = {
  start: Z(17, 20),
  end: Z(18, 6),
  bookOn: Z(17, 18, 26, 9),
  checks: [Z(17, 18, 29, 41), Z(17, 20, 26, 48), Z(17, 21, 1, 16), Z(17, 22, 5, 15), Z(17, 22, 57, 0), Z(18, 0, 4, 44)],
};

async function engineCases() {
  await test('WAC-E01-TOLERANCE-IS-FIVE-MINUTES-AND-GRACE-IS-UNCHANGED', () => {
    assert.equal(WELFARE_EARLY_TOLERANCE_MINUTES, 5, 'owner-approved tolerance');
    assert.equal(WELFARE_GRACE_MINUTES, 5, 'grace period unchanged');
  });

  await test('WAC-E02-PRODUCTION-SHIFT-32-REPLAY', () => {
    // At 02:08:14Z, when production recorded window 5 missed.
    const r = resolveWelfareAt({ start: S32.start, end: S32.end, checks: S32.checks, bookOnAt: S32.bookOn, now: Z(18, 2, 8, 14) });
    assert.deepEqual(statesOf(r).slice(0, 7), [COMPLETED, COMPLETED, COMPLETED, COMPLETED, COMPLETED, MISSED, DUE]);
    assert.equal(r.windows[3].completedAt?.toISOString(), Z(17, 22, 57).toISOString(), '22:57 met 23:00-00:00, real time kept');
    assert.equal(r.windows[2].completedAt?.toISOString(), Z(17, 22, 5, 15).toISOString(), '22:05 still meets 22:00-23:00');
    assert.equal(r.windows[2].completionCount, 1, '22:57 is attributed to one window only');
    assert.equal(r.windows[3].completionCount, 1);
    assert.equal(r.windows[0].completionCount, 1, 'the 18:29 check before the shift is outside every window, as before');
    assert.equal(r.summary.missedCount, 1, 'only 01:00-02:00 is missed');
  });

  await test('WAC-E03-THE-BOUNDARY-IS-INCLUSIVE-AT-EXACTLY-FIVE-MINUTES', () => {
    const base = { start: Z(17, 20), end: Z(18, 6), now: Z(18, 7) };
    const at = resolveWelfareAt({ ...base, checks: [Z(17, 20, 10), Z(17, 20, 55, 0, 0)] });
    assert.equal(at.windows[1].state, COMPLETED, '20:55:00.000 counts for 21:00-22:00');
    const before = resolveWelfareAt({ ...base, checks: [Z(17, 20, 10), Z(17, 20, 54, 59, 999)] });
    assert.equal(before.windows[1].state, MISSED, '20:54:59.999 does not');
    assert.equal(before.windows[0].completionCount, 2, 'it stays in its own window');
  });

  await test('WAC-E04-A-LONE-EARLY-CHECK-NEVER-EMPTIES-ITS-OWN-WINDOW', () => {
    // The only check of 22:00-23:00 is at 22:58. It must meet 22:00-23:00, not move on and leave it missed.
    const r = resolveWelfareAt({ start: Z(17, 20), end: Z(18, 6), checks: [Z(17, 20, 30), Z(17, 21, 30), Z(17, 22, 58)], now: Z(18, 0, 10) });
    assert.deepEqual(statesOf(r).slice(0, 4), [COMPLETED, COMPLETED, COMPLETED, MISSED]);
    assert.equal(r.windows[2].completedAt?.toISOString(), Z(17, 22, 58).toISOString());
  });

  await test('WAC-E05-TWO-CHECKS-IN-THE-ZONE-MEET-TWO-WINDOWS-IN-ORDER', () => {
    const r = resolveWelfareAt({ start: Z(17, 20), end: Z(18, 6), checks: [Z(17, 20, 56), Z(17, 20, 58)], now: Z(17, 22, 10) });
    assert.deepEqual(statesOf(r).slice(0, 2), [COMPLETED, COMPLETED]);
    assert.equal(r.windows[0].completedAt?.toISOString(), Z(17, 20, 56).toISOString(), 'the first meets its own window');
    assert.equal(r.windows[1].completedAt?.toISOString(), Z(17, 20, 58).toISOString(), 'the second meets the next');
  });

  await test('WAC-E06-ONE-CHECK-SATISFIES-ONE-WINDOW', () => {
    const checks = [Z(17, 20, 5), Z(17, 20, 57), Z(17, 21, 57), Z(17, 22, 57)];
    const r = resolveWelfareAt({ start: Z(17, 20), end: Z(18, 6), checks, now: Z(18, 7) });
    const attributed = r.windows.reduce((sum, w) => sum + w.completionCount, 0);
    assert.equal(attributed, checks.length, 'every check attributed exactly once');
    assert.equal(r.summary.completedCount, 4, 'four checks, four windows, never more');
    assert.deepEqual(statesOf(r).slice(0, 5), [COMPLETED, COMPLETED, COMPLETED, COMPLETED, MISSED]);
  });

  await test('WAC-E07-NOTHING-COUNTS-BEFORE-GENUINE-BOOK-ON', () => {
    // Before the first window: 19:57 counts for 20:00-21:00 only if the Guard was already booked on.
    const on = resolveWelfareAt({ start: Z(17, 20), end: Z(18, 6), checks: [Z(17, 19, 57)], bookOnAt: Z(17, 19, 30), now: Z(17, 21, 10) });
    assert.equal(on.windows[0].state, COMPLETED, 'booked on at 19:30: the 19:57 check meets the first window');
    const notYet = resolveWelfareAt({ start: Z(17, 20), end: Z(18, 6), checks: [Z(17, 19, 57)], bookOnAt: Z(17, 19, 58), now: Z(17, 21, 10) });
    assert.equal(notYet.windows[0].state, MISSED, 'booked on at 19:58: a 19:57 check is not counted');
    // Inside a window the Guard booked on part-way through.
    const mid = resolveWelfareAt({ start: Z(17, 20), end: Z(18, 6), checks: [Z(17, 20, 5)], bookOnAt: Z(17, 20, 10), now: Z(17, 21, 10) });
    assert.equal(mid.windows[0].state, MISSED, 'a check before Book On discharges nothing');
    assert.equal(mid.windows[0].completionCount, 1, 'but the entry is still shown');
    assert.equal(mid.windows[0].completedAt, null);
  });

  await test('WAC-E08-NOTHING-COUNTS-AFTER-BOOK-OFF-OR-INTO-A-WINDOW-OFF-DUTY', () => {
    const after = resolveWelfareAt({ start: Z(17, 20), end: Z(18, 6), checks: [Z(17, 22, 31)], bookOffAt: Z(17, 22, 30), now: Z(18, 7) });
    assert.equal(after.windows[2].state, MISSED, 'a check after Book Off discharges nothing');
    // Booked off at 22:58: 23:00-00:00 carried no obligation, so a 22:57 check stays where it was made.
    const edge = resolveWelfareAt({
      start: Z(17, 20), end: Z(18, 6), checks: [Z(17, 22, 10), Z(17, 22, 57)], bookOffAt: Z(17, 22, 58), now: Z(18, 7),
    });
    assert.equal(edge.windows[2].completionCount, 2, 'not moved into a window the Guard was not on duty for');
    assert.equal(edge.windows[3].state, NOT_APPLICABLE);
  });

  await test('WAC-E09-LOG-BOOK-HAS-NO-TOLERANCE', () => {
    const r = logBook.resolve({
      shiftStart: Z(17, 20), shiftEnd: Z(18, 6), intervalMinutes: 60,
      completions: [Z(17, 20, 10), Z(17, 20, 58)].map((at) => ({ at, kind: OperationalCompletionKind.LOG_BOOK })),
      applicability: { bookOnAt: Z(17, 20), bookOffAt: null, shiftEnd: Z(18, 6) },
      now: Z(17, 22, 10),
    });
    assert.equal(r.windows[0].completionCount, 2, 'both entries stay in their own period');
    assert.equal(r.windows[1].state, MISSED, 'Log Book periods are unchanged');
  });

  await test('WAC-E10-A-LATER-CHECK-NEVER-CHANGES-A-SETTLED-WINDOW', () => {
    // Property: adding a check at t (at or after every earlier one) leaves every window that ended at or
    // before t exactly as it was. Seeded, so a failure reproduces.
    let seed = 20261018;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const start = Z(17, 20);
    const end = Z(18, 6);
    for (let run = 0; run < 300; run += 1) {
      const checks: Date[] = [];
      let t = start.getTime() - 10 * MIN;
      const n = 1 + Math.floor(rand() * 12);
      for (let i = 0; i < n; i += 1) {
        t += Math.floor(rand() * 90 * MIN);
        checks.push(new Date(t));
      }
      const now = end;
      for (let k = 1; k <= checks.length; k += 1) {
        const before = resolveWelfareAt({ start, end, checks: checks.slice(0, k - 1), now });
        const after = resolveWelfareAt({ start, end, checks: checks.slice(0, k), now });
        const at = checks[k - 1].getTime();
        before.windows.forEach((w, i) => {
          if (w.end.getTime() <= at) {
            assert.equal(after.windows[i].state, w.state, `run ${run}: window ${i} changed when a check at ${checks[k - 1].toISOString()} arrived`);
          }
        });
      }
    }
  });

  await test('WAC-E11-CROSS-MIDNIGHT-SHIFT', () => {
    // 21:00-07:00 BST (20:00-06:00Z), checking at :58 every hour: each check is the first in its window,
    // so each meets its own window and nothing shifts across midnight.
    const checks = Array.from({ length: 10 }, (_, i) => new Date(Z(17, 20, 58).getTime() + i * 60 * MIN));
    const r = resolveWelfareAt({ start: Z(17, 20), end: Z(18, 6), checks, now: Z(18, 7) });
    assert.equal(r.windows.length, 10);
    assert.ok(statesOf(r).every((s) => s === COMPLETED), 'all ten windows met, either side of midnight');
    assert.equal(r.windows[4].start.toISOString(), Z(18, 0).toISOString(), 'window 4 is 00:00-01:00Z');
  });

  await test('WAC-E12-AUTUMN-CLOCK-CHANGE-25-OCTOBER-2026', () => {
    // UK clocks go back at 01:00Z: 21:00 BST on the 24th to 07:00 GMT on the 25th is eleven real hours.
    const start = Z(24, 20);
    const end = Z(25, 7);
    const r = resolveWelfareAt({ start, end, checks: [Z(25, 0, 10), Z(25, 0, 57)], now: Z(25, 2, 10) });
    assert.equal(r.windows.length, 11, 'eleven 60-minute windows');
    assert.equal(r.windows[5].start.toISOString(), Z(25, 1).toISOString());
    assert.equal(r.windows[5].state, COMPLETED, 'the 00:57Z check meets 01:00-02:00Z across the change');
    assert.ok(r.windows.every((w) => w.end.getTime() - w.start.getTime() === 60 * MIN));
  });

  await test('WAC-E13-SPRING-CLOCK-CHANGE-29-MARCH-2026', () => {
    // UK clocks go forward at 01:00Z: 21:00 GMT on the 28th to 07:00 BST on the 29th is nine real hours.
    const start = new Date(Date.UTC(2026, 2, 28, 21));
    const end = new Date(Date.UTC(2026, 2, 29, 6));
    const r = resolveWelfareAt({
      start, end, checks: [new Date(Date.UTC(2026, 2, 29, 0, 20)), new Date(Date.UTC(2026, 2, 29, 0, 56))],
      now: new Date(Date.UTC(2026, 2, 29, 2, 10)),
    });
    assert.equal(r.windows.length, 9);
    assert.equal(r.windows[4].state, COMPLETED, 'the 00:56Z check meets 01:00-02:00Z');
  });
}

// ═══════════════════ the real sweep on a real database ═══════════════════

async function sweepCases() {
  const url = process.env.WELFARE_ALERT_DATABASE_URL;
  if (!url) throw new Error('WELFARE_ALERT_DATABASE_URL is required (use a disposable database)');
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
    throw new Error('welfare alert database must be local');
  }

  const ds = new DataSource({ type: 'postgres', url, entities: appEntities, synchronize: true, dropSchema: true, logging: false });
  await ds.initialize();
  const repo = <T extends object>(entity: new () => T): Repository<T> => ds.getRepository(entity);

  const companies: Company[] = [];
  const notified: { userId: number; message: string }[] = [];
  const notifications = {
    createForUser: async (n: { userId: number; message: string }) => void notified.push(n),
    createForUserUnlessRecentDuplicate: async (n: { userId: number; message: string }) => void notified.push(n),
  };
  const auditLogService = new AuditLogService(repo(AuditLog), {} as never);
  const sweep = new SafetyAlertService(
    repo(SafetyAlert), repo(DailyLog), repo(AttendanceEvent), repo(Shift),
    {} as never, {} as never,
    // The alert actor: the owner of a company acts for that company.
    { findByUserId: async (userId: number) => companies.find((c) => c.user?.id === userId) ?? null } as never,
    auditLogService, notifications as never, welfare, windowEngine, ds,
    { getGuardSummary: async () => { throw new Error('compliance lapse scan not exercised by this spec'); } } as never,
  );
  sweep.onModuleDestroy();

  let seq = 0;
  const makeCompany = async (label: string) => {
    const user = await repo(User).save(repo(User).create({
      email: `${label}.${(seq += 1)}@example.invalid`, passwordHash: 'not-a-real-hash',
      role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE,
    }));
    const company = await repo(Company).save(repo(Company).create({
      user, name: `${label} Security Ltd`, companyNumber: String(40000000 + (seq += 1)),
      address: '1 Test Street', contactDetails: `ops@${label}.example.invalid`,
    }));
    companies.push(company);
    const site = await repo(Site).save(repo(Site).create({
      company, name: `${label} Site`, address: '2 Test Street', welfareCheckIntervalMinutes: 60, timezone: 'Europe/London',
    }));
    const guardUser = await repo(User).save(repo(User).create({
      email: `${label}.g.${(seq += 1)}@example.invalid`, passwordHash: 'not-a-real-hash',
      role: UserRole.GUARD, status: UserStatus.ACTIVE,
    }));
    const guard = await repo(GuardProfile).save(repo(GuardProfile).create({
      user: guardUser, fullName: `${label} Guard`, siaLicenseNumber: String(6300000000000000 + (seq += 1)), phone: '07700000000',
    }));
    return { company, site, guard, owner: user.id };
  };
  type Tenant = Awaited<ReturnType<typeof makeCompany>>;

  const alpha = await makeCompany('alpha');
  const bravo = await makeCompany('bravo');

  /** A shift `startedMinsAgo` ago, booked on at `bookOnMinsAgo` (default: at start), with checks `checksMinsAgo`. */
  const makeShift = async (opts: {
    tenant?: Tenant; startedMinsAgo: number; durationMinutes?: number; bookOnMinsAgo?: number; checksMinsAgo?: number[];
  }) => {
    const t = opts.tenant ?? alpha;
    const start = new Date(Date.now() - opts.startedMinsAgo * MIN);
    const shift = await repo(Shift).save(repo(Shift).create({
      company: t.company, guard: t.guard, site: t.site, siteName: t.site.name, start,
      end: new Date(start.getTime() + (opts.durationMinutes ?? 600) * MIN),
      status: 'in_progress', checkCallIntervalMinutes: 60,
    }));
    await repo(AttendanceEvent).save(repo(AttendanceEvent).create({
      shift, guard: t.guard, type: AttendanceEventType.CHECK_IN,
      occurredAt: new Date(Date.now() - (opts.bookOnMinsAgo ?? opts.startedMinsAgo) * MIN),
    }));
    for (const ago of opts.checksMinsAgo ?? []) await checkAt(shift, ago, t);
    return shift;
  };
  const checkAt = async (shift: Shift, minsAgo: number, t: Tenant = alpha) => {
    const saved = await repo(DailyLog).save(repo(DailyLog).create({
      company: t.company, guard: t.guard, shift, message: 'ok', logType: DailyLogType.WELFARE_CHECK,
    }));
    await ds.query('UPDATE daily_logs SET "createdAt" = $1 WHERE id = $2', [new Date(Date.now() - minsAgo * MIN), saved.id]);
  };
  /** Time passes for one shift: every instant belonging to it moves into the past. */
  const advance = async (shiftId: number, minutes: number) => {
    await ds.query(`UPDATE daily_logs SET "createdAt" = "createdAt" - make_interval(mins => $2) WHERE "shiftId" = $1`, [shiftId, minutes]);
    await ds.query(`UPDATE shifts SET "start" = "start" - make_interval(mins => $2), "end" = "end" - make_interval(mins => $2) WHERE id = $1`, [shiftId, minutes]);
    await ds.query(`UPDATE attendance_events SET "occurredAt" = "occurredAt" - make_interval(mins => $2) WHERE "shiftId" = $1`, [shiftId, minutes]);
  };

  const evidence = async (shiftId: number) =>
    (await ds.query(
      `SELECT id, "welfareWindowIndex" AS i, status, "closedByUserId" AS by FROM safety_alerts
         WHERE "shiftId" = $1 AND type = 'missed_checkcall' AND "welfareWindowIndex" IS NOT NULL ORDER BY 2`,
      [shiftId],
    )) as { id: number; i: number; status: string; by: number | null }[];
  const summaries = async (shiftId: number) =>
    (await ds.query(
      `SELECT id, status, priority, message, "companyId", "guardId", "closedByUserId", "resolutionReason"
         FROM safety_alerts WHERE "shiftId" = $1 AND type = 'missed_checkcall' AND "welfareWindowIndex" IS NULL ORDER BY id`,
      [shiftId],
    )) as { id: number; status: string; priority: string; message: string; companyId: number; guardId: number; closedByUserId: number | null; resolutionReason: string | null }[];
  const audits = async (action: string, shiftId: number) =>
    (await ds.query(
      `SELECT id, "userId", "afterData" FROM audit_logs WHERE action = $1 AND "afterData"->>'shiftId' = $2 ORDER BY id`,
      [action, String(shiftId)],
    )) as { id: number; userId: number | null; afterData: Record<string, unknown> }[];
  const counts = async () =>
    (await ds.query(`SELECT
        (SELECT count(*)::int FROM attendance_events) AS attendance,
        (SELECT count(*)::int FROM daily_logs) AS logs,
        (SELECT count(*)::int FROM timesheets) AS timesheets`))[0] as { attendance: number; logs: number; timesheets: number };

  const RESOLVE = { resolutionReason: 'guard_confirmed_safe', resolutionNote: 'Phoned the guard; safe and on patrol.' };

  try {
    await test('WAC-01-ONE-ISOLATED-MISS-OPENS-ONE-ACTIONABLE-ALERT', async () => {
      // The production 01:08 case without the early check: 23:00-00:00 unmet, 00:00-01:00 met at 00:04,
      // swept at 00:08. Before this change the result was a closed history row and nothing else.
      const shift = await makeShift({ startedMinsAgo: 248, checksMinsAgo: [222, 187, 123, 4] });
      const before = notified.length;
      await sweep.runMissedWelfareChecks();

      const ev = await evidence(shift.id);
      assert.deepEqual(ev.map((e) => e.i), [3], 'the one missed window is recorded');
      assert.equal(ev[0].status, SafetyAlertStatus.CLOSED, 'as permanent closed history');
      assert.equal(ev[0].by, null, 'with no closing user: nobody resolved it');

      const [summary, ...extra] = await summaries(shift.id);
      assert.ok(summary && !extra.length, 'exactly one actionable alert');
      assert.equal(summary.status, SafetyAlertStatus.OPEN);
      assert.equal(summary.priority, SafetyAlertPriority.HIGH);
      assert.equal(summary.companyId, alpha.company.id);
      assert.equal(summary.guardId, alpha.guard.id);
      assert.equal(summary.message, 'Welfare overdue - 1 consecutive check missed');

      const [opened] = await audits('welfare_check.summary_opened', shift.id);
      assert.deepEqual(opened.afterData.welfareWindowIndexes, [3], 'linked to its welfare window');
      assert.deepEqual(opened.afterData.evidenceAlertIds, [ev[0].id], 'and to the evidence row');
      assert.equal(opened.userId, null, 'raised by the system');
      assert.equal(notified.length - before, 1, 'the company is notified once');
    });

    await test('WAC-02-PRODUCTION-SHIFT-32-REPLAY-THROUGH-THE-SWEEP', async () => {
      // Shift 32 placed so that now is 02:08:14Z on 18 October: started 368.2 minutes ago.
      const ago = (d: Date) => (Z(18, 2, 8, 14).getTime() - d.getTime()) / MIN;
      const shift = await makeShift({
        startedMinsAgo: ago(S32.start), bookOnMinsAgo: ago(S32.bookOn), checksMinsAgo: S32.checks.map(ago),
      });
      await sweep.runMissedWelfareChecks();
      assert.deepEqual((await evidence(shift.id)).map((e) => e.i), [5], '23:00-00:00 met by 22:57; only 01:00-02:00 missed');
      const rows = await summaries(shift.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].message, 'Welfare overdue - 1 consecutive check missed');
    });

    await test('WAC-03-CONSECUTIVE-MISSES-ESCALATE-ONE-ALERT', async () => {
      const shift = await makeShift({ startedMinsAgo: 130, checksMinsAgo: [] });
      await sweep.runMissedWelfareChecks();
      const [first] = await summaries(shift.id);
      assert.equal(first.message, 'Welfare overdue - 2 consecutive checks missed');
      const before = notified.length;
      await advance(shift.id, 60);
      await sweep.runMissedWelfareChecks();
      const rows = await summaries(shift.id);
      assert.equal(rows.length, 1, 'one alert, not one per hour');
      assert.equal(rows[0].id, first.id);
      assert.equal(rows[0].message, 'Welfare overdue - 3 consecutive checks missed');
      assert.equal((await audits('welfare_check.summary_escalated', shift.id)).length, 1);
      assert.equal(notified.length - before, 1, 'escalation notifies');
    });

    await test('WAC-04-A-LATER-CHECK-NEITHER-RESOLVES-NOR-REWRITES-THE-ALERT', async () => {
      const shift = await makeShift({ startedMinsAgo: 70, checksMinsAgo: [] });
      await sweep.runMissedWelfareChecks();
      const [opened] = await summaries(shift.id);
      await checkAt(shift, 1); // contact in the current window
      await advance(shift.id, 60); // ...which then settles as met
      await sweep.runMissedWelfareChecks();
      await sweep.runMissedWelfareChecks();
      const rows = await summaries(shift.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, SafetyAlertStatus.OPEN, 'still outstanding after the good check');
      assert.equal(rows[0].message, opened.message, 'unchanged');
      assert.equal((await audits('welfare_check.summary_escalated', shift.id)).length, 0);
      assert.equal((await audits('welfare_check.summary_resolved', shift.id)).length, 0);

      // A second, separate miss escalates the same alert and says it is not part of one run.
      await advance(shift.id, 60);
      await sweep.runMissedWelfareChecks();
      const after = await summaries(shift.id);
      assert.equal(after.length, 1);
      assert.equal(after[0].message, 'Welfare overdue - 1 consecutive check missed (+1 earlier)');
    });

    await test('WAC-05-REPEATED-SWEEPS-DUPLICATE-NOTHING', async () => {
      const shift = await makeShift({ startedMinsAgo: 190, checksMinsAgo: [100] });
      await sweep.runMissedWelfareChecks();
      const snapshot = async () => ({
        evidence: await evidence(shift.id),
        summaries: await summaries(shift.id),
        opened: (await audits('welfare_check.summary_opened', shift.id)).length,
        escalated: (await audits('welfare_check.summary_escalated', shift.id)).length,
        missed: (await audits('welfare_check.window_missed', shift.id)).length,
      });
      const first = await snapshot();
      const before = notified.length;
      for (let i = 0; i < 5; i += 1) await sweep.runMissedWelfareChecks();
      assert.deepEqual(await snapshot(), first);
      assert.equal(notified.length, before, 'no repeat notifications');
    });

    await test('WAC-06-CONCURRENT-SWEEPS-CREATE-ONE-ALERT', async () => {
      const shift = await makeShift({ startedMinsAgo: 70, checksMinsAgo: [] });
      const before = notified.length;
      await Promise.all([sweep.runMissedWelfareChecks(), sweep.runMissedWelfareChecks(), sweep.runMissedWelfareChecks()]);
      assert.equal((await summaries(shift.id)).length, 1);
      assert.equal((await evidence(shift.id)).length, 1);
      assert.equal((await audits('welfare_check.summary_opened', shift.id)).length, 1);
      assert.equal(notified.length - before, 1, 'one notification');
    });

    await test('WAC-07-BOOK-OFF-DOES-NOT-RESOLVE-AN-OUTSTANDING-ALERT', async () => {
      const shift = await makeShift({ startedMinsAgo: 70, checksMinsAgo: [] });
      await sweep.runMissedWelfareChecks();
      await repo(AttendanceEvent).save(repo(AttendanceEvent).create({
        shift, guard: alpha.guard, type: AttendanceEventType.CHECK_OUT, occurredAt: new Date(),
      }));
      await ds.query(`UPDATE shifts SET status = 'completed' WHERE id = $1`, [shift.id]);
      for (let i = 0; i < 3; i += 1) await sweep.runMissedWelfareChecks();
      const [summary] = await summaries(shift.id);
      assert.equal(summary.status, SafetyAlertStatus.OPEN, 'Book Off is not a resolution');
      assert.equal(summary.closedByUserId, null);
    });

    await test('WAC-08-ACKNOWLEDGE-THEN-RESOLVE-WITH-REASON-AND-NOTE', async () => {
      const shift = await makeShift({ startedMinsAgo: 70, checksMinsAgo: [] });
      await sweep.runMissedWelfareChecks();
      const [summary] = await summaries(shift.id);

      const acked = await sweep.acknowledgeForCompany(alpha.owner, summary.id);
      assert.equal(acked.status, SafetyAlertStatus.ACKNOWLEDGED);
      assert.equal(acked.acknowledgedByUserId, alpha.owner);

      // Escalation keeps the human's acknowledgement.
      await advance(shift.id, 60);
      await sweep.runMissedWelfareChecks();
      const [escalated] = await summaries(shift.id);
      assert.equal(escalated.status, SafetyAlertStatus.ACKNOWLEDGED);
      assert.equal(escalated.message, 'Welfare overdue - 2 consecutive checks missed');

      await refused(() => sweep.closeForCompany(alpha.owner, summary.id), BadRequestException, 'no reason at all');
      await refused(
        () => sweep.closeForCompany(alpha.owner, summary.id, { resolutionReason: 'guard_confirmed_safe' }),
        BadRequestException, 'a reason without a note',
      );
      await refused(
        () => sweep.closeForCompany(alpha.owner, summary.id, { resolutionReason: 'request_completed', resolutionNote: 'x' }),
        BadRequestException, 'a reason from another family',
      );
      assert.equal((await summaries(shift.id))[0].status, SafetyAlertStatus.ACKNOWLEDGED, 'refusals change nothing');

      const closed = await sweep.closeForCompany(alpha.owner, summary.id, RESOLVE);
      assert.equal(closed.status, SafetyAlertStatus.CLOSED);
      assert.equal(closed.closedByUserId, alpha.owner);
      assert.equal(closed.resolutionReason, 'guard_confirmed_safe');
      assert.equal(closed.acknowledgedByUserId, alpha.owner, 'the acknowledgement is kept');

      const trail = await ds.query(
        `SELECT action, "userId", "beforeData", "afterData" FROM audit_logs WHERE "entityType" = 'safety_alert' AND "entityId" = $1 ORDER BY id`,
        [summary.id],
      );
      assert.deepEqual(trail.map((a: { action: string }) => a.action),
        ['welfare_check.summary_opened', 'safety_alert.acknowledged', 'welfare_check.summary_escalated', 'safety_alert.closed']);
      const close = trail[3];
      assert.equal(close.userId, alpha.owner);
      assert.equal(close.beforeData.status, SafetyAlertStatus.ACKNOWLEDGED);
      assert.equal(close.afterData.resolutionReason, 'guard_confirmed_safe');
      assert.equal(close.afterData.resolutionNote, RESOLVE.resolutionNote);

      // A settled record cannot be reopened or re-resolved.
      await refused(() => sweep.acknowledgeForCompany(alpha.owner, summary.id), ConflictException, 'acknowledging a closed alert');
      await refused(
        () => sweep.closeForCompany(alpha.owner, summary.id, { resolutionReason: 'other', resolutionNote: 'overwrite' }),
        ConflictException, 'closing it again',
      );
      const [kept] = await summaries(shift.id);
      assert.equal(kept.resolutionReason, 'guard_confirmed_safe', 'the resolution is never overwritten');
    });

    await test('WAC-09-MISSED-WINDOW-HISTORY-CANNOT-BE-ACKNOWLEDGED-OR-CLOSED', async () => {
      const shift = await makeShift({ startedMinsAgo: 70, checksMinsAgo: [] });
      await sweep.runMissedWelfareChecks();
      const [row] = await evidence(shift.id);
      const message = await refused(() => sweep.acknowledgeForCompany(alpha.owner, row.id), ConflictException, 'acknowledging evidence');
      assert.match(message, /permanent record of a missed Welfare Check window/);
      await refused(() => sweep.closeForCompany(alpha.owner, row.id, RESOLVE), ConflictException, 'closing evidence');
      const [after] = await evidence(shift.id);
      assert.deepEqual(after, row, 'the history row is unchanged');
    });

    await test('WAC-10-RESOLVED-MISSES-NEVER-REOPEN-A-NEW-MISS-OPENS-ONE', async () => {
      const shift = await makeShift({ startedMinsAgo: 130, checksMinsAgo: [] });
      await sweep.runMissedWelfareChecks();
      const [first] = await summaries(shift.id);
      await sweep.closeForCompany(alpha.owner, first.id, RESOLVE);
      for (let i = 0; i < 3; i += 1) await sweep.runMissedWelfareChecks();
      assert.equal((await summaries(shift.id)).length, 1, 'the same misses never reopen anything');

      await advance(shift.id, 60);
      await sweep.runMissedWelfareChecks();
      await sweep.runMissedWelfareChecks();
      const rows = await summaries(shift.id);
      assert.equal(rows.length, 2, 'one fresh alert for the new miss');
      assert.equal(rows[0].status, SafetyAlertStatus.CLOSED);
      assert.equal(rows[1].status, SafetyAlertStatus.OPEN);
      assert.equal(rows[1].message, 'Welfare overdue - 3 consecutive checks missed', 'reporting the whole current silence');
      const [, reopened] = await audits('welfare_check.summary_opened', shift.id);
      assert.deepEqual(reopened.afterData.welfareWindowIndexes, [2], 'but covering only the miss nobody has seen');
    });

    await test('WAC-11-TENANT-ISOLATION', async () => {
      const mine = await makeShift({ startedMinsAgo: 70, checksMinsAgo: [] });
      const theirs = await makeShift({ tenant: bravo, startedMinsAgo: 70, checksMinsAgo: [] });
      await sweep.runMissedWelfareChecks();
      const [a] = await summaries(mine.id);
      const [b] = await summaries(theirs.id);
      assert.equal(a.companyId, alpha.company.id);
      assert.equal(b.companyId, bravo.company.id);
      await refused(() => sweep.acknowledgeForCompany(bravo.owner, a.id), BadRequestException, 'another company acknowledging');
      await refused(() => sweep.closeForCompany(bravo.owner, a.id, RESOLVE), BadRequestException, 'another company resolving');
      assert.equal((await summaries(mine.id))[0].status, SafetyAlertStatus.OPEN, 'untouched');
      const alphaAlerts = (await sweep.findForCompany(alpha.owner)).map((x) => x.id);
      assert.ok(alphaAlerts.includes(a.id) && !alphaAlerts.includes(b.id), 'each company sees only its own');
    });

    await test('WAC-12-SOS-AND-OTHER-ALERT-TYPES-ARE-UNCHANGED', async () => {
      const make = (type: SafetyAlertType) => repo(SafetyAlert).save(repo(SafetyAlert).create({
        company: alpha.company, guard: alpha.guard, type, status: SafetyAlertStatus.OPEN, message: 'raised',
        priority: type === SafetyAlertType.PANIC ? SafetyAlertPriority.CRITICAL : SafetyAlertPriority.MEDIUM,
      }));
      const panic = await make(SafetyAlertType.PANIC);
      assert.equal((await sweep.acknowledgeForCompany(alpha.owner, panic.id)).status, SafetyAlertStatus.ACKNOWLEDGED);
      await refused(() => sweep.closeForCompany(alpha.owner, panic.id, { resolutionReason: 'guard_confirmed_safe' }), BadRequestException, 'SOS without a note');
      const closedPanic = await sweep.closeForCompany(alpha.owner, panic.id, RESOLVE);
      assert.equal(closedPanic.priority, SafetyAlertPriority.CRITICAL);

      const request = await make(SafetyAlertType.SITE_REQUEST);
      assert.equal((await sweep.closeForCompany(alpha.owner, request.id, { resolutionReason: 'request_completed' })).status,
        SafetyAlertStatus.CLOSED, 'a site request still closes without a note');

      const other = await make(SafetyAlertType.OTHER);
      assert.equal((await sweep.closeForCompany(alpha.owner, other.id)).status, SafetyAlertStatus.CLOSED,
        'the legacy no-payload close is unchanged for the types that had it');

      // Missing Book Off still closes itself on a late Book Off.
      const late = await makeShift({ startedMinsAgo: 90, durationMinutes: 60, checksMinsAgo: [60] });
      await sweep.runMissedWelfareChecks();
      const mbo = () => ds.query(`SELECT status FROM safety_alerts WHERE "shiftId" = $1 AND type = 'missing_book_off'`, [late.id]);
      assert.equal((await mbo())[0].status, SafetyAlertStatus.OPEN);
      await repo(AttendanceEvent).save(repo(AttendanceEvent).create({ shift: late, guard: alpha.guard, type: AttendanceEventType.CHECK_OUT, occurredAt: new Date() }));
      await ds.query(`UPDATE shifts SET status = 'completed' WHERE id = $1`, [late.id]);
      await sweep.runMissedWelfareChecks();
      assert.equal((await mbo())[0].status, SafetyAlertStatus.CLOSED);
    });

    await test('WAC-13-NO-FABRICATED-EVENTS-AND-NO-SYSTEM-RESOLUTIONS', async () => {
      const before = await counts();
      const shift = await makeShift({ startedMinsAgo: 250, checksMinsAgo: [200] });
      const created = await counts();
      for (let i = 0; i < 3; i += 1) await sweep.runMissedWelfareChecks();
      assert.deepEqual(await counts(), created, 'the sweep writes no attendance, no Welfare Checks, no timesheets');
      assert.ok(created.attendance === before.attendance + 1 && created.logs === before.logs + 1);
      assert.equal(created.timesheets, 0);

      const systemClosedSummaries = await ds.query(
        `SELECT count(*)::int AS n FROM safety_alerts
           WHERE type = 'missed_checkcall' AND "welfareWindowIndex" IS NULL AND status = 'closed' AND "closedByUserId" IS NULL`,
      );
      assert.equal(systemClosedSummaries[0].n, 0, 'no actionable alert anywhere was closed by the system');
      const resolvedAudits = await ds.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'welfare_check.summary_resolved'`);
      assert.equal(resolvedAudits[0].n, 0);
      assert.ok((await evidence(shift.id)).every((e) => e.status === SafetyAlertStatus.CLOSED && e.by === null),
        'history rows are closed by nobody');
    });

    console.log(JSON.stringify({ event: 'welfare_alert_correctness_certified', tests: passed }));
  } finally {
    await ds.destroy();
  }
}

async function main() {
  await engineCases();
  await sweepCases();
}

main().catch((error) => {
  console.error(`\nFAIL  ${error?.message ?? error}`);
  console.error(error);
  process.exit(1);
});
