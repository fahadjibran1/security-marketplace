/**
 * S4 Live Operations correctness, Phase 1: backend alert correctness (real PostgreSQL).
 *
 * The production defect this certifies against: a shift whose Guard booked on and never booked off stays
 * `in_progress`, so its trailing run of missed Welfare windows never returns to zero. When a controller
 * closed the shift-level summary, the very next sweep found "misses, and no active summary" and opened a
 * new one for exactly the same misses (production: 11391 closed 18:43:11, 22842 opened 18:47:03; 11395
 * closed 18:42:41, 22853 opened 18:47:05; earlier 50 closed, 1003 opened).
 *
 * The rule now: a closed summary is reopened (as a fresh row) only for a miss recorded after it closed.
 *
 * Also certifies that an in-progress shift can no longer be marked completed by editing the shift, while
 * the Guard's own Book Off still completes it.
 *
 * Needs LIVE_OPS_CORRECTNESS_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { BadRequestException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Company } from '../src/company/entities/company.entity';
import { Site } from '../src/site/entities/site.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { AttendanceEvent, AttendanceEventType } from '../src/attendance/entities/attendance.entity';
import { DailyLog, DailyLogType } from '../src/daily-log/entities/daily-log.entity';
import { SafetyAlert, SafetyAlertStatus } from '../src/safety-alert/entities/safety-alert.entity';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { SafetyAlertService } from '../src/safety-alert/safety-alert.service';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import { WelfareWindowService } from '../src/operations/welfare-window.service';
import { ShiftService } from '../src/shift/shift.service';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

const MIN = 60_000;

async function main() {
  const url = process.env.LIVE_OPS_CORRECTNESS_DATABASE_URL;
  if (!url) throw new Error('LIVE_OPS_CORRECTNESS_DATABASE_URL is required (use a disposable database)');
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
    throw new Error('Live operations correctness database must be local');
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

  const auditLogService = new AuditLogService(repo(AuditLog), null as never);
  const notified: string[] = [];
  const notifications = {
    createForUser: async (n: { title: string }) => { notified.push(n.title); },
    createForUserUnlessRecentDuplicate: async (n: { title: string }) => { notified.push(n.title); },
  };
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
    { getGuardSummary: async () => { throw new Error('compliance lapse scan not exercised by this spec'); } } as never,
  );

  // ── fixtures (as W2) ─────────────────────────────────────────────────────────────────────────────
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

  const makeShift = async (opts: {
    tenant?: { company: Company; site: Site; guard: GuardProfile };
    startedMinsAgo: number;
    durationMinutes?: number;
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
        status: 'in_progress',
        checkCallIntervalMinutes: 60,
      }),
    );
    await repo(AttendanceEvent).save(
      repo(AttendanceEvent).create({
        shift,
        guard: t.guard,
        type: AttendanceEventType.CHECK_IN,
        occurredAt: start,
      }),
    );
    return shift;
  };

  /** Moves the whole shift (schedule, Book On and welfare logs) back in time, as if `minutes` had passed. */
  const advance = async (shiftId: number, minutes: number) => {
    await ds.query(
      `UPDATE daily_logs SET "createdAt" = "createdAt" - make_interval(mins => $2) WHERE "shiftId" = $1`,
      [shiftId, minutes],
    );
    await ds.query(
      `UPDATE shifts SET "start" = "start" - make_interval(mins => $2), "end" = "end" - make_interval(mins => $2) WHERE id = $1`,
      [shiftId, minutes],
    );
    await ds.query(
      `UPDATE attendance_events SET "occurredAt" = "occurredAt" - make_interval(mins => $2) WHERE "shiftId" = $1`,
      [shiftId, minutes],
    );
  };

  const summaries = async (shiftId: number, status?: SafetyAlertStatus) =>
    (await ds.query(
      `SELECT id, status, message, "resolutionReason" FROM safety_alerts
         WHERE "shiftId" = $1 AND type = 'missed_checkcall' AND "welfareWindowIndex" IS NULL
         ${status ? `AND status = '${status}'` : ''} ORDER BY id`,
      [shiftId],
    )) as { id: number; status: string; message: string; resolutionReason: string | null }[];
  const evidence = async (shiftId: number) =>
    (await ds.query(
      `SELECT id, "welfareWindowIndex" AS i, status, "closedAt", message FROM safety_alerts
         WHERE "shiftId" = $1 AND "welfareWindowIndex" IS NOT NULL ORDER BY "welfareWindowIndex"`,
      [shiftId],
    )) as unknown[];
  const bookOffAlerts = async (shiftId: number) =>
    (await ds.query(
      `SELECT id, status FROM safety_alerts WHERE "shiftId" = $1 AND type = 'missing_book_off' ORDER BY id`,
      [shiftId],
    )) as { id: number; status: string }[];
  const auditCount = async (action: string, shiftId: number) =>
    Number((await ds.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND "afterData"->>'shiftId' = $2`,
      [action, String(shiftId)],
    ))[0].n);

  /** What the controller's Close does to the row (SafetyAlertService.close), at an explicit instant. */
  const humanClose = async (alertId: number, at: Date, reason = 'app_technical_issue') => {
    await ds.query(
      `UPDATE safety_alerts SET status = 'closed', "acknowledgedAt" = COALESCE("acknowledgedAt", $2),
         "acknowledgedByUserId" = COALESCE("acknowledgedByUserId", $3), "closedAt" = $2, "closedByUserId" = $3,
         "resolutionReason" = $4 WHERE id = $1`,
      [alertId, at, base.company.user!.id, reason],
    );
  };

  try {
    // ═══════════════════ WELFARE SUMMARY: NO REOPEN FOR THE SAME MISSES ═══════════════════

    await test('LOC-01-PRODUCTION-REPLAY-STALE-SHIFT-CLOSED-SUMMARY-STAYS-CLOSED', async () => {
      // Production shift 26: 19:00-05:00 (10 h), booked on, never booked off, now ~13 h past its end.
      const shift = await makeShift({ startedMinsAgo: (10 + 13) * 60, durationMinutes: 600 });
      await sweep.runMissedWelfareChecks();
      const [summary] = await summaries(shift.id, SafetyAlertStatus.OPEN);
      assert.ok(summary, 'the first sweep opens one summary');
      const evidenceBefore = await evidence(shift.id);
      assert.ok(evidenceBefore.length >= 9, 'per-window evidence recorded');
      const [mbo] = await bookOffAlerts(shift.id);
      assert.equal(mbo.status, SafetyAlertStatus.OPEN, 'and one Missing Book Off');

      await humanClose(summary.id, new Date());
      await humanClose(mbo.id, new Date(), 'guard_forgot_book_off');
      const notifiedBefore = notified.length;

      for (let i = 0; i < 5; i += 1) await sweep.runMissedWelfareChecks();

      const after = await summaries(shift.id);
      assert.equal(after.length, 1, 'no new summary for the same misses');
      assert.equal(after[0].status, SafetyAlertStatus.CLOSED);
      assert.equal(after[0].resolutionReason, 'app_technical_issue', 'the human resolution is preserved');
      assert.deepEqual(await evidence(shift.id), evidenceBefore, 'historical evidence rows untouched');
      assert.equal(await auditCount('welfare_check.summary_opened', shift.id), 1, 'summary_opened audited once only');
      const mboAfter = await bookOffAlerts(shift.id);
      assert.equal(mboAfter.length, 1);
      assert.equal(mboAfter[0].status, SafetyAlertStatus.CLOSED, 'Missing Book Off stays closed too');
      assert.equal(notified.length, notifiedBefore, 'no repeat notification');
    });

    await test('LOC-02-A-GENUINELY-NEW-MISS-OPENS-ONE-FRESH-SUMMARY', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      await sweep.runMissedWelfareChecks();
      const [first] = await summaries(shift.id, SafetyAlertStatus.OPEN);
      await humanClose(first.id, new Date());
      await sweep.runMissedWelfareChecks();
      assert.equal((await summaries(shift.id)).length, 1, 'same misses: still closed, nothing new');

      // The shift is still running and another window is missed after the closure.
      await advance(shift.id, 60);
      await sweep.runMissedWelfareChecks();
      await sweep.runMissedWelfareChecks();

      const rows = await summaries(shift.id);
      assert.equal(rows.length, 2, 'exactly one fresh summary');
      assert.equal(rows[0].id, first.id);
      assert.equal(rows[0].status, SafetyAlertStatus.CLOSED, 'the closed one is not reopened in place');
      assert.equal(rows[1].status, SafetyAlertStatus.OPEN);
      assert.match(rows[1].message, /4 consecutive checks missed/, 'reporting the whole current run');
      assert.equal(await auditCount('welfare_check.summary_opened', shift.id), 2);
    });

    await test('LOC-03-A-MISS-DETECTED-AFTER-THE-CLOSURE-STILL-OPENS-ONE', async () => {
      // The controller closed the summary before the sweep had recorded the latest miss: they were never
      // shown it, so it is new to them even though its window ended earlier.
      const shift = await makeShift({ startedMinsAgo: 190 });
      await sweep.runMissedWelfareChecks();
      const [first] = await summaries(shift.id, SafetyAlertStatus.OPEN);
      await humanClose(first.id, new Date(Date.now() - 60 * MIN));
      await ds.query(
        `UPDATE safety_alerts SET "closedAt" = now() - interval '90 minutes'
           WHERE "shiftId" = $1 AND "welfareWindowIndex" < 2`,
        [shift.id],
      );
      await sweep.runMissedWelfareChecks();
      const rows = await summaries(shift.id, SafetyAlertStatus.OPEN);
      assert.equal(rows.length, 1, 'opened for the miss nobody had seen');
    });

    // Owner policy, 18 October 2026: the sweep no longer closes a summary when a later window is met, so the
    // "system-closed" case this test used to certify cannot arise. What it certifies now: the good news leaves
    // the summary outstanding, and a later miss escalates that same summary instead of opening a second one.
    await test('LOC-04-A-LATER-CHECK-KEEPS-THE-SUMMARY-AND-A-LATER-MISS-ESCALATES-IT', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      await sweep.runMissedWelfareChecks();
      // A welfare check inside the latest settled window.
      const saved = await repo(DailyLog).save(
        repo(DailyLog).create({ company: base.company, guard: base.guard, shift, message: 'entry', logType: DailyLogType.CHECK_CALL }),
      );
      await ds.query(`UPDATE daily_logs SET "createdAt" = now() - interval '20 minutes' WHERE id = $1`, [saved.id]);
      await sweep.runMissedWelfareChecks();
      const [kept] = await summaries(shift.id, SafetyAlertStatus.OPEN);
      assert.ok(kept, 'still outstanding after the good check');
      for (let i = 0; i < 3; i += 1) await sweep.runMissedWelfareChecks();
      assert.equal((await summaries(shift.id)).length, 1, 'repeat sweeps add nothing');

      // Two hours on: the check met window 2, and windows 3 and 4 have since been missed. The newest run is
      // two long, and windows 0 and 1 are still outstanding behind the met window.
      await advance(shift.id, 120);
      await sweep.runMissedWelfareChecks();
      const rows = await summaries(shift.id);
      assert.equal(rows.length, 1, 'no second summary beside the outstanding one');
      assert.equal(rows[0].id, kept.id);
      assert.equal(rows[0].status, SafetyAlertStatus.OPEN);
      assert.equal(rows[0].message, 'Welfare overdue - 2 consecutive checks missed (+2 earlier)', 'escalated with the new misses');
      assert.equal(await auditCount('welfare_check.summary_escalated', shift.id), 1);
    });

    await test('LOC-05-LEGACY-CLOSED-SUMMARY-WITHOUT-CLOSEDAT-IS-NOT-REOPENED', async () => {
      const shift = await makeShift({ startedMinsAgo: 23 * 60, durationMinutes: 600 });
      await sweep.runMissedWelfareChecks();
      const [summary] = await summaries(shift.id, SafetyAlertStatus.OPEN);
      await ds.query(`UPDATE safety_alerts SET status = 'closed', "closedAt" = NULL, "updatedAt" = now() WHERE id = $1`, [summary.id]);
      for (let i = 0; i < 3; i += 1) await sweep.runMissedWelfareChecks();
      assert.equal((await summaries(shift.id)).length, 1, 'falls back to the row\'s last update');
    });

    await test('LOC-06-REPEATED-AND-CONCURRENT-SWEEPS-AFTER-CLOSURE-ARE-IDEMPOTENT', async () => {
      const shift = await makeShift({ startedMinsAgo: 23 * 60, durationMinutes: 600 });
      await sweep.runMissedWelfareChecks();
      const [summary] = await summaries(shift.id, SafetyAlertStatus.OPEN);
      await humanClose(summary.id, new Date());
      await Promise.all([
        sweep.runMissedWelfareChecks(),
        sweep.runMissedWelfareChecks(),
        sweep.runMissedWelfareChecks(),
      ]);
      const counters = await sweep.runMissedWelfareChecks();
      assert.equal((await summaries(shift.id)).length, 1);
      assert.equal(counters.summariesOpened, 0);
      assert.ok(counters.summariesSuppressed >= 1, 'the suppression is counted, not silent');
    });

    await test('LOC-07-TENANT-AND-SHIFT-ISOLATION', async () => {
      // A closed summary suppresses only its own shift: not another shift of the same company, and not a
      // shift of another company with the same timings.
      const bravo = await makeCompany('bravo');
      const own = await makeShift({ startedMinsAgo: 23 * 60, durationMinutes: 600 });
      await sweep.runMissedWelfareChecks();
      const [ownSummary] = await summaries(own.id, SafetyAlertStatus.OPEN);
      await humanClose(ownSummary.id, new Date());

      const sibling = await makeShift({ startedMinsAgo: 23 * 60, durationMinutes: 600 });
      const foreign = await makeShift({ tenant: bravo, startedMinsAgo: 23 * 60, durationMinutes: 600 });
      await sweep.runMissedWelfareChecks();

      assert.equal((await summaries(own.id)).length, 1, 'own shift stays closed');
      assert.equal((await summaries(sibling.id, SafetyAlertStatus.OPEN)).length, 1, 'sibling shift gets its own');
      const [foreignSummary] = await summaries(foreign.id, SafetyAlertStatus.OPEN);
      assert.ok(foreignSummary, 'other company gets its own');
      const [{ companyId }] = await ds.query('SELECT "companyId" FROM safety_alerts WHERE id = $1', [foreignSummary.id]);
      assert.equal(companyId, bravo.company.id, 'and it belongs to that company');
    });

    // Owner decision, 18 October 2026: the new miss also reopens it (previously it stayed acknowledged).
    await test('LOC-08-ACKNOWLEDGED-SUMMARY-REOPENS-AND-ESCALATES-WITHOUT-DUPLICATES', async () => {
      const shift = await makeShift({ startedMinsAgo: 190 });
      await sweep.runMissedWelfareChecks();
      const [summary] = await summaries(shift.id);
      await ds.query(`UPDATE safety_alerts SET status = 'acknowledged', "acknowledgedAt" = now() WHERE id = $1`, [summary.id]);
      await advance(shift.id, 60);
      await sweep.runMissedWelfareChecks();
      const rows = await summaries(shift.id);
      assert.equal(rows.length, 1, 'the same summary, not a second one');
      assert.equal(rows[0].status, SafetyAlertStatus.OPEN);
      assert.match(rows[0].message, /4 consecutive checks missed/);
    });

    // ═══════════════════ SHIFT COMPLETION ═══════════════════

    const assertTransition = (from: string, to: string) =>
      (ShiftService.prototype as unknown as { assertTransition(a: string, b: string): void }).assertTransition.call(
        {}, from, to,
      );

    await test('LOC-09-EDITING-CANNOT-COMPLETE-AN-IN-PROGRESS-SHIFT', async () => {
      assert.throws(() => assertTransition('in_progress', 'completed'), (error: unknown) =>
        error instanceof BadRequestException && /booking off/.test(error.message));
      assert.throws(() => assertTransition('in_progress', 'cancelled'), BadRequestException);
      assert.throws(() => assertTransition('completed', 'in_progress'), BadRequestException);
    });

    await test('LOC-10-THE-REST-OF-THE-LIFECYCLE-IS-UNCHANGED', async () => {
      for (const [from, to] of [
        ['unfilled', 'offered'], ['unfilled', 'cancelled'],
        ['offered', 'ready'], ['offered', 'rejected'], ['offered', 'cancelled'],
        ['ready', 'in_progress'], ['ready', 'missed'], ['ready', 'cancelled'],
        ['rejected', 'unfilled'], ['missed', 'unfilled'], ['missed', 'cancelled'],
        ['in_progress', 'in_progress'], ['completed', 'completed'],
      ]) {
        assert.doesNotThrow(() => assertTransition(from, to), `${from} -> ${to}`);
      }
    });

    console.log(JSON.stringify({ event: 'live_ops_correctness_phase1_certified', tests: passed }));
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(`\nFAIL  ${error?.message || error}`);
  console.error(error);
  process.exit(1);
});
