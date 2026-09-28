/**
 * W2 certification: per-window Welfare Check evidence (real PostgreSQL).
 *
 * The measured pre-W2 baseline was that a Guard out of contact for twenty-four hours produced
 * exactly ONE alert, because the old sweep carried a single rolling deadline from the most recent
 * contact. The point of W2 is that every applicable elapsed window now settles on its own and leaves
 * durable evidence, so the same lapse produces twenty-four records — while the control room still
 * sees only one actionable alert.
 *
 * Runs the real SafetyAlertService against a real schema, because almost everything that matters
 * here is enforced by the database: the partial unique indexes that make the sweep idempotent, the
 * advisory lock that serialises concurrent sweeps, and the company scoping of what it reads.
 *
 * Needs W2_WELFARE_DATABASE_URL pointing at a DISPOSABLE database — it drops the schema.
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
  SafetyAlertStatus,
  SafetyAlertType,
} from '../src/safety-alert/entities/safety-alert.entity';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { SafetyAlertService } from '../src/safety-alert/safety-alert.service';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import { WelfareWindowService } from '../src/operations/welfare-window.service';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

const MIN = 60_000;

async function main() {
  const url = process.env.W2_WELFARE_DATABASE_URL;
  if (!url) throw new Error('W2_WELFARE_DATABASE_URL is required (use a disposable database)');
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
    throw new Error('W2 welfare database must be local');
  }

  const ds = new DataSource({
    type: 'postgres',
    url,
    entities: appEntities,
    synchronize: true,
    dropSchema: true,
    logging: false,
  });
  await ds.initialize();

  const repo = <T extends object>(entity: new () => T): Repository<T> => ds.getRepository(entity);
  const alerts = repo(SafetyAlert);
  const shifts = repo(Shift);

  // The sweep uses the repositories, the audit log, notifications, the window service and the
  // DataSource. The three services it never touches on this path are left unwired on purpose, so a
  // future change that starts depending on them fails loudly here rather than silently.
  const auditLogService = new AuditLogService(repo(AuditLog), null as never);
  const notifications = { createForUser: async () => undefined, createForUserUnlessRecentDuplicate: async () => undefined };
  const windowEngine = new OperationalWindowService();
  const welfare = new WelfareWindowService(windowEngine);
  const sweep = new SafetyAlertService(
    alerts,
    repo(DailyLog),
    repo(AttendanceEvent),
    shifts,
    null as never,
    null as never,
    null as never,
    auditLogService,
    notifications as never,
    welfare,
    windowEngine,
    ds,
  );

  // ── fixtures ───────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  const makeCompany = async (label: string) => {
    const user = await repo(User).save(
      repo(User).create({
        email: `${label}.${(seq += 1)}@example.invalid`,
        passwordHash: 'not-a-real-hash',
        role: UserRole.COMPANY_ADMIN,
        status: UserStatus.ACTIVE,
      }),
    );
    const company = await repo(Company).save(
      repo(Company).create({
        user,
        name: `${label} Security Ltd`,
        companyNumber: String(10000000 + (seq += 1)),
        address: '1 Test Street',
        contactDetails: `ops@${label}.example.invalid`,
      }),
    );
    const site = await repo(Site).save(
      repo(Site).create({
        company,
        name: `${label} Site`,
        address: '2 Test Street',
        welfareCheckIntervalMinutes: 60,
        timezone: 'Europe/London',
      }),
    );
    const guardUser = await repo(User).save(
      repo(User).create({
        email: `${label}.guard.${(seq += 1)}@example.invalid`,
        passwordHash: 'not-a-real-hash',
        role: UserRole.GUARD,
        status: UserStatus.ACTIVE,
      }),
    );
    const guard = await repo(GuardProfile).save(
      repo(GuardProfile).create({
        user: guardUser,
        fullName: `${label} Guard`,
        siaLicenseNumber: String(6000000000000000 + (seq += 1)),
        phone: '07700000000',
      }),
    );
    return { company, site, guard };
  };

  const base = await makeCompany('alpha');

  /** A shift that started `startedHoursAgo` ago and runs for `durationHours`, with an optional Book On. */
  const makeShift = async (opts: {
    tenant?: { company: Company; site: Site; guard: GuardProfile };
    startedMinsAgo: number;
    durationMinutes?: number;
    bookOnMinsAgo?: number | null;
    bookOffMinsAgo?: number | null;
    status?: string;
    intervalMinutes?: number;
  }) => {
    const t = opts.tenant ?? base;
    const start = new Date(Date.now() - opts.startedMinsAgo * MIN);
    const shift = await shifts.save(
      shifts.create({
        company: t.company,
        guard: t.guard,
        site: t.site,
        siteName: t.site.name,
        start,
        end: new Date(start.getTime() + (opts.durationMinutes ?? 12 * 60) * MIN),
        status: opts.status ?? 'in_progress',
        checkCallIntervalMinutes: opts.intervalMinutes ?? 60,
      }),
    );
    const bookOn = opts.bookOnMinsAgo === undefined ? opts.startedMinsAgo : opts.bookOnMinsAgo;
    if (bookOn !== null) {
      await repo(AttendanceEvent).save(
        repo(AttendanceEvent).create({
          shift,
          guard: t.guard,
          type: AttendanceEventType.CHECK_IN,
          occurredAt: new Date(Date.now() - bookOn * MIN),
        }),
      );
    }
    if (opts.bookOffMinsAgo !== undefined && opts.bookOffMinsAgo !== null) {
      await repo(AttendanceEvent).save(
        repo(AttendanceEvent).create({
          shift,
          guard: t.guard,
          type: AttendanceEventType.CHECK_OUT,
          occurredAt: new Date(Date.now() - opts.bookOffMinsAgo * MIN),
        }),
      );
    }
    return shift;
  };

  const logAt = async (shift: Shift, minsAgo: number, logType = DailyLogType.CHECK_CALL) => {
    // createdAt is a CreateDateColumn, so it is set explicitly with an update after insert.
    const saved = await repo(DailyLog).save(
      repo(DailyLog).create({ company: shift.company, guard: shift.guard!, shift, message: 'entry', logType }),
    );
    await ds.query('UPDATE daily_logs SET "createdAt" = $1 WHERE id = $2', [
      new Date(Date.now() - minsAgo * MIN),
      saved.id,
    ]);
  };

  const indexedEvidence = async (shiftId: number) =>
    Number(
      (
        await ds.query(
          `SELECT count(*)::int AS n FROM safety_alerts
             WHERE "shiftId" = $1 AND type = 'missed_checkcall' AND "welfareWindowIndex" IS NOT NULL`,
          [shiftId],
        )
      )[0].n,
    );
  const evidenceIndexes = async (shiftId: number) =>
    (
      await ds.query(
        `SELECT "welfareWindowIndex" AS i FROM safety_alerts
           WHERE "shiftId" = $1 AND "welfareWindowIndex" IS NOT NULL ORDER BY 1`,
        [shiftId],
      )
    ).map((r: { i: number }) => r.i);
  const summaries = async (shiftId: number, status?: SafetyAlertStatus) =>
    (
      await ds.query(
        `SELECT id, status, message FROM safety_alerts
           WHERE "shiftId" = $1 AND type = 'missed_checkcall' AND "welfareWindowIndex" IS NULL
           ${status ? `AND status = '${status}'` : ''}
           ORDER BY id`,
        [shiftId],
      )
    ) as { id: number; status: string; message: string }[];
  const bookOffAlerts = async (shiftId: number) =>
    (
      await ds.query(
        `SELECT id, status, priority, message FROM safety_alerts
           WHERE "shiftId" = $1 AND type = 'missing_book_off' ORDER BY id`,
        [shiftId],
      )
    ) as { id: number; status: string; priority: string; message: string }[];
  const auditCount = async (action: string, shiftId: number) =>
    Number(
      (
        await ds.query(
          `SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND "afterData"->>'shiftId' = $2`,
          [action, String(shiftId)],
        )
      )[0].n,
    );

  try {
    // ═══════════════════ THE HEADLINE: the baseline that produced ONE alert ═══════════════════

    await test('W2-01-THREE-MISSED-WINDOWS-THREE-EVIDENCE-ROWS', async () => {
      // Booked on 3h10m ago with no contact since: windows 0, 1 and 2 have elapsed unmet, and
      // window 3 is still running.
      const shift = await makeShift({ startedMinsAgo: 190 });
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 3, 'three settled missed windows, three records');
      assert.deepEqual(await evidenceIndexes(shift.id), [0, 1, 2]);
    });

    await test('W2-02-TWENTYFOUR-MISSED-WINDOWS-TWENTYFOUR-EVIDENCE-ROWS', async () => {
      // The measured pre-W2 case: ~24h of silence on an hourly interval, which used to be ONE alert.
      const shift = await makeShift({ startedMinsAgo: 24 * 60 + 10, durationMinutes: 26 * 60 });
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 24, 'twenty-four independent records, not one');
      assert.equal((await summaries(shift.id)).length, 1, 'and exactly one actionable summary');
    });

    await test('W2-03-REPEATED-SWEEPS-ARE-IDEMPOTENT', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      for (let i = 0; i < 5; i += 1) await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 3, 'five sweeps, still three records');
      assert.equal((await summaries(shift.id)).length, 1, 'and still one summary');
      assert.equal(await auditCount('welfare_check.window_missed', shift.id), 3, 'no duplicate audit rows');
    });

    await test('W2-04-CONCURRENT-SWEEPS-CREATE-NO-DUPLICATES', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      await Promise.all([
        sweep.runMissedWelfareChecks(),
        sweep.runMissedWelfareChecks(),
        sweep.runMissedWelfareChecks(),
      ]);
      assert.equal(await indexedEvidence(shift.id), 3, 'the unique index is the final guard');
      assert.deepEqual(await evidenceIndexes(shift.id), [0, 1, 2]);
    });

    await test('W2-05-DELAYED-SWEEP-CATCHES-UP-EVERY-WINDOW', async () => {
      // Nothing ran for hours. State comes entirely from timestamps, so one sweep resolves them all.
      const shift = await makeShift({ startedMinsAgo: 8 * 60 + 10 });
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 8, 'all eight elapsed windows caught up at once');
    });

    // ═══════════════════ COMPLETION SUPPRESSION ═══════════════════

    await test('W2-06-COMPLETED-WINDOW-LEAVES-NO-EVIDENCE', async () => {
      const shift = await makeShift({ startedMinsAgo: 70 });
      await logAt(shift, 40); // inside window 0
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 0);
      assert.equal((await summaries(shift.id)).length, 0, 'nothing missed, so no summary');
    });

    await test('W2-07-CHECK-CALL-COUNTS-AS-COMPLETION', async () => {
      const shift = await makeShift({ startedMinsAgo: 70 });
      await logAt(shift, 40, DailyLogType.CHECK_CALL);
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 0, 'historical check_call still counts');
    });

    await test('W2-08-WELFARE-CHECK-COUNTS-AS-COMPLETION', async () => {
      const shift = await makeShift({ startedMinsAgo: 70 });
      await logAt(shift, 40, DailyLogType.WELFARE_CHECK);
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 0);
    });

    await test('W2-09-OBSERVATION-DOES-NOT-COUNT', async () => {
      const shift = await makeShift({ startedMinsAgo: 70 });
      await logAt(shift, 40, DailyLogType.OBSERVATION);
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 1, 'a voluntary note is not a welfare confirmation');
    });

    await test('W2-10-LOG-BOOK-ENTRY-DOES-NOT-COUNT', async () => {
      const shift = await makeShift({ startedMinsAgo: 70 });
      await logAt(shift, 40, DailyLogType.LOG_BOOK);
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 1, 'writing the log is not confirming you are safe');
    });

    // ═══════════════════ ATTENDANCE APPLICABILITY ═══════════════════

    await test('W2-11-LATE-BOOK-ON-CREATES-NO-RETROSPECTIVE-MISSES', async () => {
      // Scheduled 4h10m ago, booked on 2h10m ago: windows 0 and 1 carried no obligation.
      const shift = await makeShift({ startedMinsAgo: 250, bookOnMinsAgo: 130 });
      await sweep.runMissedWelfareChecks();
      const indexes = await evidenceIndexes(shift.id);
      assert.ok(!indexes.includes(0) && !indexes.includes(1), `no retrospective misses: ${indexes}`);
      assert.deepEqual(indexes, [2, 3], 'only windows overlapping duty');
    });

    await test('W2-12-NO-BOOK-ON-MEANS-NO-WELFARE-EVIDENCE', async () => {
      const shift = await makeShift({ startedMinsAgo: 5 * 60, bookOnMinsAgo: null });
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 0, 'an absent Guard is not a welfare breach');
      assert.equal((await summaries(shift.id)).length, 0);
    });

    await test('W2-13-EARLY-BOOK-OFF-TRUNCATES-FUTURE-WINDOWS', async () => {
      // Started 5h10m ago, booked off 3h ago: windows from the Book Off onward are not required.
      const shift = await makeShift({ startedMinsAgo: 310, bookOffMinsAgo: 180 });
      await sweep.runMissedWelfareChecks();
      const indexes = await evidenceIndexes(shift.id);
      // Window 2 was partly worked, so it still carried an obligation; window 3 began after Book Off.
      assert.deepEqual(indexes, [0, 1, 2], 'nothing required after Book Off');
    });

    await test('W2-14-LATE-BOOK-OFF-ADDS-NO-WINDOWS-PAST-SCHEDULED-END', async () => {
      // This is the baseline defect W2-E fixes: a 4h shift that has been live for 10h.
      const shift = await makeShift({ startedMinsAgo: 10 * 60, durationMinutes: 4 * 60 });
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 4, 'four windows fit the scheduled shift, and no more');
      assert.deepEqual(await evidenceIndexes(shift.id), [0, 1, 2, 3]);
    });

    await test('W2-15-CANCELLED-SHIFT-CARRIES-NO-OBLIGATION', async () => {
      const shift = await makeShift({ startedMinsAgo: 5 * 60, status: 'cancelled' });
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 0);
    });

    await test('W2-16-PARTIAL-TAIL-RAISES-NO-FALSE-MISS', async () => {
      // 90 minutes elapsed of a 90-minute shift on a 60-minute interval: one whole window, not two.
      const shift = await makeShift({ startedMinsAgo: 95, durationMinutes: 90 });
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 1, 'the trailing half hour is not a period');
    });

    await test('W2-17-GRACE-IS-FIVE-MINUTES', async () => {
      const inGrace = await makeShift({ startedMinsAgo: 64 });
      const pastGrace = await makeShift({ startedMinsAgo: 66 });
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(inGrace.id), 0, 'end + 4 minutes is overdue, not missed');
      assert.equal(await indexedEvidence(pastGrace.id), 1, 'end + 6 minutes is missed');
    });

    await test('W2-18-STATE-IS-DERIVED-ENTIRELY-FROM-THE-DATABASE', async () => {
      // A brand-new service instance, as after a restart, reaches the same conclusion.
      const shift = await makeShift({ startedMinsAgo: 190 });
      const restarted = new SafetyAlertService(
        alerts, repo(DailyLog), repo(AttendanceEvent), shifts,
        null as never, null as never, null as never,
        auditLogService, notifications as never, welfare, windowEngine, ds,
      );
      await restarted.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 3, 'no in-memory state is involved');
    });

    await test('W2-19-TENANT-ISOLATION', async () => {
      const other = await makeCompany('bravo');
      const mine = await makeShift({ startedMinsAgo: 190 });
      const theirs = await makeShift({ tenant: other, startedMinsAgo: 190 });
      await sweep.runMissedWelfareChecks();
      const mineRows = await ds.query(
        `SELECT DISTINCT "companyId" AS c FROM safety_alerts WHERE "shiftId" = $1`, [mine.id]);
      const theirRows = await ds.query(
        `SELECT DISTINCT "companyId" AS c FROM safety_alerts WHERE "shiftId" = $1`, [theirs.id]);
      assert.equal(mineRows[0].c, base.company.id, 'evidence is attributed to its own company');
      assert.equal(theirRows[0].c, other.company.id);
      assert.notEqual(mineRows[0].c, theirRows[0].c);
    });

    // ═══════════════════ SUMMARY ALERT LIFECYCLE ═══════════════════

    await test('W2-20-FIRST-MISS-OPENS-ONE-SUMMARY', async () => {
      const shift = await makeShift({ startedMinsAgo: 66 });
      await sweep.runMissedWelfareChecks();
      const rows = await summaries(shift.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, SafetyAlertStatus.OPEN);
      assert.match(rows[0].message, /1 consecutive check missed/);
    });

    await test('W2-21-CONSECUTIVE-MISSES-ESCALATE-THE-SAME-SUMMARY', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      await sweep.runMissedWelfareChecks();
      const first = await summaries(shift.id);
      assert.equal(first.length, 1);
      assert.match(first[0].message, /3 consecutive checks missed/);

      // Time moves on by another window; the same row escalates rather than a fourth appearing.
      await ds.query('UPDATE shifts SET "start" = "start" - interval \'60 minutes\' WHERE id = $1', [shift.id]);
      await ds.query(
        `UPDATE attendance_events SET "occurredAt" = "occurredAt" - interval '60 minutes' WHERE "shiftId" = $1`,
        [shift.id],
      );
      await sweep.runMissedWelfareChecks();
      const after = await summaries(shift.id);
      assert.equal(after.length, 1, 'still exactly one summary');
      assert.equal(after[0].id, first[0].id, 'and it is the same row');
      assert.match(after[0].message, /4 consecutive checks missed/);
    });

    await test('W2-22-EVIDENCE-AND-SUMMARY-COEXIST', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 3, 'three indexed evidence rows');
      assert.equal((await summaries(shift.id)).length, 1, 'plus one NULL-index summary');
      const open = await ds.query(
        `SELECT count(*)::int AS n FROM safety_alerts WHERE "shiftId" = $1 AND status = 'open'`, [shift.id]);
      assert.equal(open[0].n, 1, 'only the summary is an open, actionable alert');
    });

    await test('W2-23-A-LATER-WELFARE-CHECK-RESOLVES-THE-SUMMARY', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      await sweep.runMissedWelfareChecks();
      assert.equal((await summaries(shift.id, SafetyAlertStatus.OPEN)).length, 1);

      // Contact inside the latest settled window, so the trailing run of misses reaches zero.
      await logAt(shift, 20);
      await sweep.runMissedWelfareChecks();

      assert.equal((await summaries(shift.id, SafetyAlertStatus.OPEN)).length, 0, 'summary no longer open');
      assert.equal((await summaries(shift.id, SafetyAlertStatus.CLOSED)).length, 1, 'it was closed, not deleted');
      assert.ok((await indexedEvidence(shift.id)) >= 3, 'historical evidence is untouched');
    });

    await test('W2-24-A-RESOLVED-SUMMARY-IS-NOT-REOPENED-BY-A-REPEAT-SWEEP', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      await sweep.runMissedWelfareChecks();
      await logAt(shift, 20);
      await sweep.runMissedWelfareChecks();
      const closed = await summaries(shift.id, SafetyAlertStatus.CLOSED);
      assert.equal(closed.length, 1);
      for (let i = 0; i < 3; i += 1) await sweep.runMissedWelfareChecks();
      assert.equal((await summaries(shift.id, SafetyAlertStatus.OPEN)).length, 0, 'not reopened');
      assert.equal((await summaries(shift.id)).length, 1, 'and no second summary invented');
    });

    await test('W2-25-ACKNOWLEDGED-SUMMARY-KEEPS-ITS-STATUS-WHILE-MISSES-CONTINUE', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      await sweep.runMissedWelfareChecks();
      const [summary] = await summaries(shift.id);
      await ds.query(
        `UPDATE safety_alerts SET status = 'acknowledged', "acknowledgedAt" = now(), "acknowledgedByUserId" = $2
           WHERE id = $1`,
        [summary.id, base.company.user!.id],
      );

      await ds.query('UPDATE shifts SET "start" = "start" - interval \'60 minutes\' WHERE id = $1', [shift.id]);
      await ds.query(
        `UPDATE attendance_events SET "occurredAt" = "occurredAt" - interval '60 minutes' WHERE "shiftId" = $1`,
        [shift.id],
      );
      await sweep.runMissedWelfareChecks();

      const after = await summaries(shift.id);
      assert.equal(after.length, 1, 'no second summary beside the acknowledged one');
      assert.equal(after[0].id, summary.id);
      assert.equal(after[0].status, SafetyAlertStatus.ACKNOWLEDGED, 'a human took ownership; do not undo that');
      assert.match(after[0].message, /4 consecutive checks missed/, 'but it still escalates');
      const ack = await ds.query('SELECT "acknowledgedByUserId" AS u FROM safety_alerts WHERE id = $1', [summary.id]);
      assert.ok(ack[0].u, 'and the acknowledging user is preserved');
    });

    // ═══════════════════ MISSING BOOK OFF ═══════════════════

    await test('W2-26-END-PLUS-14-MINUTES-RAISES-NOTHING', async () => {
      const shift = await makeShift({ startedMinsAgo: 254, durationMinutes: 240 });
      await sweep.runMissedWelfareChecks();
      assert.equal((await bookOffAlerts(shift.id)).length, 0, 'a Book Off can be 14 minutes late');
    });

    await test('W2-27-END-PLUS-16-MINUTES-RAISES-ONE-ALERT', async () => {
      const shift = await makeShift({ startedMinsAgo: 256, durationMinutes: 240 });
      await sweep.runMissedWelfareChecks();
      const rows = await bookOffAlerts(shift.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, SafetyAlertStatus.OPEN);
      assert.equal(rows[0].priority, 'medium');
      assert.match(rows[0].message, /^Shift ended at \d{2}:\d{2} - no Book Off recorded\.$/);
    });

    await test('W2-28-REPEATED-SWEEPS-KEEP-ONE-MISSING-BOOK-OFF', async () => {
      const shift = await makeShift({ startedMinsAgo: 256, durationMinutes: 240 });
      for (let i = 0; i < 4; i += 1) await sweep.runMissedWelfareChecks();
      assert.equal((await bookOffAlerts(shift.id)).length, 1);
      assert.equal(await auditCount('shift.missing_book_off', shift.id), 1, 'audited once');
    });

    await test('W2-29-A-LATE-BOOK-OFF-AUTO-CLOSES-THE-ALERT', async () => {
      const shift = await makeShift({ startedMinsAgo: 256, durationMinutes: 240 });
      await sweep.runMissedWelfareChecks();
      const [raised] = await bookOffAlerts(shift.id);
      assert.equal(raised.status, SafetyAlertStatus.OPEN);

      // The Guard books off late, which in production also moves the shift to 'completed'.
      await repo(AttendanceEvent).save(
        repo(AttendanceEvent).create({
          shift, guard: base.guard, type: AttendanceEventType.CHECK_OUT, occurredAt: new Date(),
        }),
      );
      await ds.query(`UPDATE shifts SET status = 'completed' WHERE id = $1`, [shift.id]);
      await sweep.runMissedWelfareChecks();

      const after = await bookOffAlerts(shift.id);
      assert.equal(after.length, 1, 'history preserved, not deleted');
      assert.equal(after[0].id, raised.id);
      assert.equal(after[0].status, SafetyAlertStatus.CLOSED);
      assert.equal(await auditCount('shift.missing_book_off_resolved', shift.id), 1);
    });

    await test('W2-30-NO-BOOK-ON-RAISES-NO-MISSING-BOOK-OFF', async () => {
      const shift = await makeShift({ startedMinsAgo: 256, durationMinutes: 240, bookOnMinsAgo: null });
      await sweep.runMissedWelfareChecks();
      assert.equal((await bookOffAlerts(shift.id)).length, 0, 'never arrived is a different exception');
    });

    await test('W2-31-CANCELLED-SHIFT-RAISES-NO-MISSING-BOOK-OFF', async () => {
      const shift = await makeShift({ startedMinsAgo: 256, durationMinutes: 240, status: 'cancelled' });
      await sweep.runMissedWelfareChecks();
      assert.equal((await bookOffAlerts(shift.id)).length, 0);
    });

    await test('W2-32-CONCURRENT-SWEEPS-CREATE-ONE-MISSING-BOOK-OFF', async () => {
      const shift = await makeShift({ startedMinsAgo: 256, durationMinutes: 240 });
      await Promise.all([
        sweep.runMissedWelfareChecks(),
        sweep.runMissedWelfareChecks(),
        sweep.runMissedWelfareChecks(),
      ]);
      assert.equal((await bookOffAlerts(shift.id)).length, 1, 'the partial unique index holds');
    });

    // ═══════════════════ BACKWARD COMPATIBILITY ═══════════════════

    await test('W2-33-LEGACY-NULL-INDEX-ALERTS-ARE-NOT-EVIDENCE', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      // A row exactly as the old rolling sweep wrote it.
      await ds.query(
        `INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status)
         VALUES ($1,$2,$3,'missed_checkcall','high','Welfare check overdue by more than 60 minutes.','open')`,
        [base.company.id, base.guard.id, shift.id],
      );
      await sweep.runMissedWelfareChecks();

      assert.equal(await indexedEvidence(shift.id), 3, 'the legacy row is not counted as evidence');
      const rows = await summaries(shift.id);
      assert.equal(rows.length, 1, 'and it is adopted as the summary rather than duplicated');
      assert.match(rows[0].message, /consecutive checks missed/, 'its message is brought up to date');
    });

    await test('W2-34-HISTORICAL-AND-NEW-ALERT-TYPES-ARE-ALL-VALID', async () => {
      const shift = await makeShift({ startedMinsAgo: 30 });
      for (const type of ['welfare', 'site_request', 'missing_book_off', 'panic', 'other']) {
        await ds.query(
          `INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status)
           VALUES ($1,$2,$3,$4,'medium','representable','closed')`,
          [base.company.id, base.guard.id, type === 'missing_book_off' ? null : shift.id, type],
        );
      }
      const kinds = await ds.query(
        `SELECT DISTINCT type FROM safety_alerts WHERE message = 'representable' ORDER BY 1`);
      assert.deepEqual(
        kinds.map((r: { type: string }) => r.type).sort(),
        ['missing_book_off', 'other', 'panic', 'site_request', 'welfare'],
        'welfare stays valid and site_request/missing_book_off are representable',
      );
    });

    await test('W2-35-ALL-DAILY-LOG-TYPES-INCLUDING-LOG-BOOK-PERSIST', async () => {
      const shift = await makeShift({ startedMinsAgo: 30 });
      for (const logType of [
        DailyLogType.OBSERVATION,
        DailyLogType.CHECK_CALL,
        DailyLogType.WELFARE_CHECK,
        DailyLogType.LOG_BOOK,
        DailyLogType.PATROL,
      ]) {
        await repo(DailyLog).save(
          repo(DailyLog).create({ company: base.company, guard: base.guard, shift, message: 'persisted', logType }),
        );
      }
      const stored = await ds.query(
        `SELECT DISTINCT "logType" AS t FROM daily_logs WHERE message = 'persisted' ORDER BY 1`);
      assert.deepEqual(
        stored.map((r: { t: string }) => r.t).sort(),
        ['check_call', 'log_book', 'observation', 'patrol', 'welfare_check'],
      );
    });

    await test('W2-36-LOG-BOOK-INTERVAL-DEFAULTS-TO-NULL', async () => {
      const fresh = await repo(Site).save(
        repo(Site).create({
          company: base.company, name: 'No log book site', address: '3 Test Street', timezone: 'Europe/London',
        }),
      );
      const [row] = await ds.query('SELECT "logBookIntervalMinutes" AS v FROM sites WHERE id = $1', [fresh.id]);
      assert.equal(row.v, null, 'a new site has no periodic Log Book obligation');
      fresh.logBookIntervalMinutes = 120;
      await repo(Site).save(fresh);
      const [updated] = await ds.query('SELECT "logBookIntervalMinutes" AS v FROM sites WHERE id = $1', [fresh.id]);
      assert.equal(updated.v, 120, 'and it can be set when a client asks for one');
    });

    await test('W2-37-SITE-INTERVAL-OVERRIDES-THE-SHIFT-INTERVAL', async () => {
      // Proves the sweep reads the authoritative resolver: site 30 beats shift 60.
      const tenant = await makeCompany('charlie');
      tenant.site.welfareCheckIntervalMinutes = 30;
      await repo(Site).save(tenant.site);
      const shift = await makeShift({ tenant, startedMinsAgo: 70, intervalMinutes: 60 });
      await sweep.runMissedWelfareChecks();
      assert.equal(await indexedEvidence(shift.id), 2, 'two 30-minute windows elapsed, not one 60-minute one');
    });

    console.log(JSON.stringify({ event: 'w2_welfare_evidence_certified', tests: passed }));
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(`\nFAIL  ${error?.message || error}`);
  console.error(error);
  process.exit(1);
});
