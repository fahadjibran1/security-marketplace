/**
 * Live welfare monitoring certification (Welfare & Reporting Remediation, Phase 2).
 *
 * THE DEFECT (production, 17-18 October 2026)
 * Live Operations read each shift's welfare windows from the coverage list, which covers only shifts
 * STARTING on the requested UK day that are still operational. So pilot shift 32 (21:00-07:00 BST) lost
 * every welfare marker at midnight, shift 33 lost them the moment it was booked off, and any historical day
 * showed none. The export read the same data, which is why its welfare columns said "Not required".
 *
 * THE FIX
 * GET /coverage/operations?shiftIds=... returns the same backend projection for the shifts the board names,
 * whatever their status or start day, plus each window's history: when its miss was recorded and which
 * actionable alert carried it. These tests run the real CoverageService, OperationsProjectionService and
 * welfare sweep on a real, disposable PostgreSQL database.
 *
 * Needs WELFARE_MONITORING_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
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
import { WelfareWindowService } from '../src/operations/welfare-window.service';
import { LogBookWindowService } from '../src/operations/log-book-window.service';
import { OperationsProjectionService } from '../src/coverage/operations-projection.service';
import { CoverageService, OPERATIONS_MAX_SHIFT_IDS, parseOperationsShiftIds } from '../src/coverage/coverage.service';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

const MIN = 60_000;

type WindowView = {
  index: number; start: string; end: string; state: string; applicable: boolean;
  completedAt: string | null; completionCount: number;
  missRecordedAt?: string | null;
  alert?: { id: number; status: string; acknowledged: boolean; closedAt: string | null; closedBySystem: boolean; resolutionReason: string | null } | null;
};
type OpsRow = { shiftId: number; operations: { welfare: { windows: WindowView[]; intervalMinutes: number | null; missedCount: number } } | null };

async function main() {
  const url = process.env.WELFARE_MONITORING_DATABASE_URL;
  if (!url) throw new Error('WELFARE_MONITORING_DATABASE_URL is required (use a disposable database)');
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('welfare monitoring database must be local');

  const ds = new DataSource({ type: 'postgres', url, entities: appEntities, synchronize: true, dropSchema: true, logging: false });
  await ds.initialize();
  const repo = <T extends object>(entity: new () => T): Repository<T> => ds.getRepository(entity);

  const windowEngine = new OperationalWindowService();
  const welfare = new WelfareWindowService(windowEngine);
  const newProjection = (alerts = repo(SafetyAlert), attendance = repo(AttendanceEvent), logs = repo(DailyLog)) =>
    new OperationsProjectionService(attendance, logs, alerts, windowEngine, welfare, new LogBookWindowService(windowEngine));
  const projection = newProjection();

  const companies: Company[] = [];
  const sweep = new SafetyAlertService(
    repo(SafetyAlert), repo(DailyLog), repo(AttendanceEvent), repo(Shift), {} as never, {} as never,
    { findByUserId: async (userId: number) => companies.find((c) => c.user?.id === userId) ?? null } as never,
    new AuditLogService(repo(AuditLog), {} as never),
    { createForUser: async () => undefined, createForUserUnlessRecentDuplicate: async () => undefined } as never,
    welfare, windowEngine, ds,
    { getGuardSummary: async () => { throw new Error('not exercised'); } } as never,
  );
  sweep.onModuleDestroy();

  let seq = 0;
  const makeTenant = async (label: string) => {
    const user = await repo(User).save(repo(User).create({
      email: `${label}.${(seq += 1)}@example.invalid`, passwordHash: 'x', role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE,
    }));
    const company = await repo(Company).save(repo(Company).create({
      user, name: `${label} Ltd`, companyNumber: String(50000000 + (seq += 1)), address: '1 Test Street', contactDetails: 'x@example.invalid',
    }));
    companies.push(company);
    const site = await repo(Site).save(repo(Site).create({
      company, name: `${label} Site`, address: '2 Test Street', welfareCheckIntervalMinutes: 60, timezone: 'Europe/London',
    }));
    const guardUser = await repo(User).save(repo(User).create({
      email: `${label}.g.${(seq += 1)}@example.invalid`, passwordHash: 'x', role: UserRole.GUARD, status: UserStatus.ACTIVE,
    }));
    const guard = await repo(GuardProfile).save(repo(GuardProfile).create({
      user: guardUser, fullName: `${label} Guard`, siaLicenseNumber: String(6400000000000000 + (seq += 1)), phone: '07700000000',
    }));
    return { company, site, guard, owner: user.id };
  };
  type Tenant = Awaited<ReturnType<typeof makeTenant>>;
  const alpha = await makeTenant('alpha');
  const bravo = await makeTenant('bravo');

  const coverageFor = (t: Tenant, proj = projection, shifts = repo(Shift)) =>
    new CoverageService(shifts, { resolveCompanyContext: async () => ({ company: { id: t.company.id } }) } as never, {} as never, proj);
  const operationsOf = async (t: Tenant, ids: number[]) =>
    (await coverageFor(t).listShiftOperations(t.owner, UserRole.COMPANY_ADMIN, ids.join(','))) as unknown as OpsRow[];
  const windowsOf = async (t: Tenant, shiftId: number) =>
    (await operationsOf(t, [shiftId])).find((r) => r.shiftId === shiftId)!.operations!.welfare.windows;

  const makeShift = async (opts: {
    tenant?: Tenant; startedMinsAgo: number; durationMinutes?: number; checksMinsAgo?: number[];
    bookOffMinsAgo?: number; status?: string; bookOn?: boolean;
  }) => {
    const t = opts.tenant ?? alpha;
    const start = new Date(Date.now() - opts.startedMinsAgo * MIN);
    const shift = await repo(Shift).save(repo(Shift).create({
      company: t.company, guard: t.guard, site: t.site, siteName: t.site.name, start,
      end: new Date(start.getTime() + (opts.durationMinutes ?? 600) * MIN),
      status: opts.status ?? 'in_progress', checkCallIntervalMinutes: 60,
    }));
    if (opts.bookOn !== false) {
      await repo(AttendanceEvent).save(repo(AttendanceEvent).create({ shift, guard: t.guard, type: AttendanceEventType.CHECK_IN, occurredAt: start }));
    }
    for (const ago of opts.checksMinsAgo ?? []) {
      const log = await repo(DailyLog).save(repo(DailyLog).create({ company: t.company, guard: t.guard, shift, message: 'ok', logType: DailyLogType.WELFARE_CHECK }));
      await ds.query('UPDATE daily_logs SET "createdAt" = $1 WHERE id = $2', [new Date(Date.now() - ago * MIN), log.id]);
    }
    if (opts.bookOffMinsAgo !== undefined) {
      await repo(AttendanceEvent).save(repo(AttendanceEvent).create({
        shift, guard: t.guard, type: AttendanceEventType.CHECK_OUT, occurredAt: new Date(Date.now() - opts.bookOffMinsAgo * MIN),
      }));
      await ds.query(`UPDATE shifts SET status = 'completed' WHERE id = $1`, [shift.id]);
    }
    return shift;
  };
  const states = (windows: WindowView[]) => windows.map((w) => w.state);

  try {
    await test('WM-01-SHIFT-IDS-ARE-VALIDATED', async () => {
      for (const bad of [undefined, '', ' , ', 'abc', '1,two', '0', '-3', '1.5', '99999999999']) {
        assert.throws(() => parseOperationsShiftIds(bad), BadRequestException, `refuses ${JSON.stringify(bad)}`);
      }
      const tooMany = Array.from({ length: OPERATIONS_MAX_SHIFT_IDS + 1 }, (_, i) => i + 1).join(',');
      assert.throws(() => parseOperationsShiftIds(tooMany), BadRequestException, 'refuses more than the cap');
      assert.deepEqual(parseOperationsShiftIds(' 3,1,3 '), [3, 1], 'trims and de-duplicates');
    });

    await test('WM-02-AN-OVERNIGHT-SHIFT-THAT-STARTED-YESTERDAY-KEEPS-ITS-WINDOWS', async () => {
      // Started 26 hours ago, still running (a long fixture so the windows exist): the coverage list for
      // "today" would not include it at all.
      const shift = await makeShift({ startedMinsAgo: 26 * 60, durationMinutes: 28 * 60, checksMinsAgo: [26 * 60 - 20] });
      const windows = await windowsOf(alpha, shift.id);
      assert.equal(windows.length, 28);
      assert.equal(windows[0].state, 'completed');
      assert.equal(windows[1].state, 'missed');
    });

    await test('WM-03-A-BOOKED-OFF-SHIFT-KEEPS-ITS-WINDOWS-AND-THE-PARTIAL-ONE-IS-NOT-A-MISS', async () => {
      // Booked off 20 minutes into window 2.
      const shift = await makeShift({ startedMinsAgo: 200, checksMinsAgo: [180, 110], bookOffMinsAgo: 60 });
      const windows = await windowsOf(alpha, shift.id);
      assert.deepEqual(states(windows).slice(0, 4), ['completed', 'completed', 'ended_at_book_off', 'not_applicable']);
    });

    await test('WM-04-RECONCILED-AND-HISTORICAL-SHIFTS-KEEP-THEIR-WINDOWS', async () => {
      // Completed without a Book Off (closed by Control), and a shift from three days ago.
      const reconciled = await makeShift({ startedMinsAgo: 20 * 60, durationMinutes: 600, checksMinsAgo: [20 * 60 - 30], status: 'completed' });
      const historical = await makeShift({ startedMinsAgo: 3 * 24 * 60, durationMinutes: 600, checksMinsAgo: [3 * 24 * 60 - 30], status: 'completed', bookOffMinsAgo: 3 * 24 * 60 - 600 });
      const rows = await operationsOf(alpha, [reconciled.id, historical.id]);
      for (const row of rows) {
        const windows = row.operations!.welfare.windows;
        assert.equal(windows.length, 10, `shift ${row.shiftId} has its ten windows`);
        assert.equal(windows[0].state, 'completed');
        assert.equal(windows[0].completedAt !== null, true, 'with the actual check time');
      }
    });

    await test('WM-05-ONE-CHECK-SATISFIES-ONE-WINDOW-AND-KEEPS-ITS-TIME', async () => {
      // Checks 5 and 3 minutes before window 1 starts: the first meets window 0, the second window 1.
      const shift = await makeShift({ startedMinsAgo: 125, checksMinsAgo: [70, 68] });
      const windows = await windowsOf(alpha, shift.id);
      assert.deepEqual(states(windows).slice(0, 2), ['completed', 'completed']);
      assert.equal(windows.reduce((n, w) => n + w.completionCount, 0), 2, 'two checks, attributed once each');
      assert.ok(Date.parse(windows[1].completedAt!) < Date.parse(windows[1].start), 'the early check keeps its real time');
    });

    await test('WM-06-EACH-MISSED-WINDOW-NAMES-ITS-ALERT', async () => {
      const shift = await makeShift({ startedMinsAgo: 130, checksMinsAgo: [] });
      await sweep.runMissedWelfareChecks();
      let windows = await windowsOf(alpha, shift.id);
      const [w0, w1] = windows;
      assert.ok(w0.missRecordedAt && w1.missRecordedAt, 'when each miss was recorded');
      assert.equal(w0.alert!.status, SafetyAlertStatus.OPEN);
      assert.equal(w0.alert!.id, w1.alert!.id, 'both carried by the one summary');
      assert.equal(windows[2].alert ?? null, null, 'nothing for a window not missed');

      await sweep.acknowledgeForCompany(alpha.owner, w0.alert!.id);
      windows = await windowsOf(alpha, shift.id);
      assert.equal(windows[0].alert!.acknowledged, true);

      await sweep.closeForCompany(alpha.owner, w0.alert!.id, { resolutionReason: 'guard_confirmed_safe', resolutionNote: 'Called the guard.' });
      windows = await windowsOf(alpha, shift.id);
      assert.equal(windows[0].alert!.status, SafetyAlertStatus.CLOSED);
      assert.equal(windows[0].alert!.closedBySystem, false, 'resolved by a person');
      assert.equal(windows[0].alert!.resolutionReason, 'guard_confirmed_safe');
    });

    await test('WM-07-LEGACY-SYSTEM-CLOSURES-AND-UNALERTED-MISSES-ARE-SHOWN-AS-THEY-WERE', async () => {
      // Production shift 32: summary 28799 closed by the old sweep at 03:03, window 6 then recorded missed at
      // 03:08 with no alert at all. Replayed with explicit times.
      const shift = await makeShift({ startedMinsAgo: 300, checksMinsAgo: [] });
      const at = (minsAgo: number) => new Date(Date.now() - minsAgo * MIN);
      const insert = async (fields: Partial<SafetyAlert>, createdMinsAgo: number) => {
        const row = await repo(SafetyAlert).save(repo(SafetyAlert).create({
          company: alpha.company, guard: alpha.guard, shift, type: SafetyAlertType.MISSED_CHECKCALL,
          priority: SafetyAlertPriority.HIGH, message: 'legacy', ...fields,
        }));
        await ds.query('UPDATE safety_alerts SET "createdAt" = $1 WHERE id = $2', [at(createdMinsAgo), row.id]);
        return row;
      };
      const summary = await insert({ status: SafetyAlertStatus.CLOSED, closedAt: at(170), welfareWindowIndex: null }, 175);
      await insert({ status: SafetyAlertStatus.CLOSED, closedAt: at(175), welfareWindowIndex: 1 }, 175);
      await insert({ status: SafetyAlertStatus.CLOSED, closedAt: at(115), welfareWindowIndex: 2 }, 115);
      const windows = await windowsOf(alpha, shift.id);
      assert.equal(windows[1].alert!.id, summary.id);
      assert.equal(windows[1].alert!.closedBySystem, true, 'closed by the previous sweep, not by a person');
      assert.equal(windows[2].alert, null, 'recorded after that closure: no alert carried it');
      assert.ok(windows[2].missRecordedAt, 'but the miss itself is on record');
    });

    await test('WM-08-TENANT-ISOLATION', async () => {
      const mine = await makeShift({ startedMinsAgo: 70 });
      const theirs = await makeShift({ tenant: bravo, startedMinsAgo: 70 });
      const rows = await operationsOf(alpha, [mine.id, theirs.id]);
      assert.deepEqual(rows.map((r) => r.shiftId), [mine.id], "another company's shift is simply absent");
      const theirRows = await operationsOf(bravo, [mine.id]);
      assert.deepEqual(theirRows, [], 'and mine is absent for them');
    });

    await test('WM-09-EXISTING-RESPONSES-ARE-UNCHANGED', async () => {
      const shift = await makeShift({ startedMinsAgo: 130, checksMinsAgo: [] });
      await sweep.runMissedWelfareChecks();
      const plain = (await projection.projectForShifts([shift])).get(shift.id)!;
      for (const w of plain.welfare.windows) {
        assert.ok(!('missRecordedAt' in w) && !('alert' in w), 'coverage and /shifts/my carry no history fields');
      }
      const from = new Date(Date.now() - 24 * 60 * MIN).toISOString().slice(0, 10);
      const coverageRows = (await coverageFor(alpha).listShiftCoverage(alpha.owner, UserRole.COMPANY_ADMIN, { from })) as Array<{ shiftId: number; operations: { welfare: { windows: object[] } } | null }>;
      const row = coverageRows.find((r) => r.shiftId === shift.id)!;
      assert.ok(row.operations!.welfare.windows.every((w) => !('alert' in w)), 'the coverage list is as it was');
    });

    await test('WM-10-READS-DO-NOT-GROW-WITH-THE-NUMBER-OF-SHIFTS', async () => {
      const counting = <T extends object>(entity: new () => T) => {
        const real = repo(entity);
        let calls = 0;
        const proxy = Object.create(real);
        proxy.find = (...args: unknown[]) => { calls += 1; return (real.find as never as (...a: unknown[]) => unknown)(...args); };
        return { proxy: proxy as Repository<T>, count: () => calls };
      };
      const measure = async (ids: number[]) => {
        const s = counting(Shift); const a = counting(AttendanceEvent); const d = counting(DailyLog); const al = counting(SafetyAlert);
        const proj = newProjection(al.proxy, a.proxy, d.proxy);
        await coverageFor(alpha, proj, s.proxy).listShiftOperations(alpha.owner, UserRole.COMPANY_ADMIN, ids.join(','));
        return s.count() + a.count() + d.count() + al.count();
      };
      const shifts: Shift[] = [];
      for (let i = 0; i < 12; i += 1) shifts.push(await makeShift({ startedMinsAgo: 130 + i, checksMinsAgo: [100] }));
      await sweep.runMissedWelfareChecks();
      const one = await measure([shifts[0].id]);
      const twelve = await measure(shifts.map((s) => s.id));
      assert.equal(one, twelve, `constant reads: ${one} for 1 shift, ${twelve} for 12`);
      assert.equal(one, 6, 'shifts, attendance, welfare logs, Log Book logs, active alerts, welfare history');
    });

    console.log(JSON.stringify({ event: 'welfare_monitoring_certified', tests: passed }));
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(`\nFAIL  ${error?.message ?? error}`);
  console.error(error);
  process.exit(1);
});
