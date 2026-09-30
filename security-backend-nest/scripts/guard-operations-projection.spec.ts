/**
 * Phase 3D certification: the Guard receives the SAME welfare truth as the control room.
 *
 * WHAT WAS WRONG (TECH-DEBT-OPS-02)
 * `GET /shifts/my` returned bare Shift entities. `OperationsProjectionService` — the window grid, its
 * status, `nextDueAt`, the counts — was wired only into the company-scoped CoverageService, so none of it
 * reached the Guard app. The app therefore had its own timing: "last evidence + interval", anchored on
 * whatever log arrived last. The engine uses a FIXED half-open grid from the scheduled start, with a
 * grace period, and resolves the interval as shift ?? site ?? 60.
 *
 * Those are different answers to the same question. A Guard and their control room could disagree about
 * whether a check was due, and the Guard — the one who has to act — had the weaker version.
 *
 * WHAT THIS CERTIFIES
 * Real PostgreSQL, the real ShiftService, the real projection. Not a fake: what matters is that the
 * scoping is enforced in SQL, that the SAME engine instance answers for both surfaces, and that the
 * 15-minute UAT case comes out with the exact windows the owner specified.
 *
 * Needs GUARD_OPERATIONS_DATABASE_URL pointing at a DISPOSABLE database — it drops the schema.
 */
process.env.TZ = 'UTC'; // Window boundaries are instants; keep Node in UTC so fixtures round-trip exactly.

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource, DeepPartial, Repository } from 'typeorm';
import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Company } from '../src/company/entities/company.entity';
import { Site } from '../src/site/entities/site.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { Job } from '../src/job/entities/job.entity';
import { JobApplication } from '../src/job-application/entities/job-application.entity';
import { Timesheet } from '../src/timesheet/entities/timesheet.entity';
import { AttendanceEvent, AttendanceEventType } from '../src/attendance/entities/attendance.entity';
import { DailyLog, DailyLogType } from '../src/daily-log/entities/daily-log.entity';
import { SafetyAlert } from '../src/safety-alert/entities/safety-alert.entity';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import { WelfareWindowService } from '../src/operations/welfare-window.service';
import { LogBookWindowService } from '../src/operations/log-book-window.service';
import { OperationsProjectionService } from '../src/coverage/operations-projection.service';
import { ShiftService } from '../src/shift/shift.service';
import {
  DEFAULT_WELFARE_INTERVAL_MINUTES,
  resolveShiftWelfareInterval,
} from '../src/shift/shift-welfare-interval';
import {
  COMPANY_ONLY_OPERATIONS_FIELDS,
  GUARD_OPERATIONS_WINDOW_HOURS,
  needsGuardOperations,
  toGuardShiftOperations,
} from '../src/shift/guard-shift-operations';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

const MIN = 60_000;

async function main() {
  const url = process.env.GUARD_OPERATIONS_DATABASE_URL;
  if (!url) throw new Error('GUARD_OPERATIONS_DATABASE_URL is required (use a disposable database)');
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
    throw new Error('Guard operations database must be local');
  }

  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: true, dropSchema: true, logging: false,
  });
  await ds.initialize();

  const repo = <T extends object>(entity: new () => T): Repository<T> => ds.getRepository(entity);

  // ONE engine, ONE projection — shared by the company path and the Guard path below. If the two
  // surfaces can disagree, it cannot be because they used different arithmetic.
  const windowEngine = new OperationalWindowService();
  const projection = new OperationsProjectionService(
    repo(AttendanceEvent), repo(DailyLog), repo(SafetyAlert),
    windowEngine, new WelfareWindowService(windowEngine), new LogBookWindowService(windowEngine),
  );

  const stub = {} as any;
  const guardProfileStub = (byUserId: Map<number, GuardProfile>) => ({
    findByUserId: async (userId: number) => byUserId.get(userId) ?? null,
  });

  const makeShiftService = (byUserId: Map<number, GuardProfile>) =>
    new ShiftService(
      repo(Shift), repo(Company), repo(GuardProfile), repo(Job), repo(JobApplication), repo(Timesheet),
      stub, stub, stub, stub, guardProfileStub(byUserId) as any, stub, stub, stub,
      ds, { log: async () => undefined } as any,
      projection,
    );

  // ── fixtures ───────────────────────────────────────────────────────────────
  let seq = 0;
  const makeTenant = async (
    label: string,
    opts: { siteWelfareInterval?: number; logBookInterval?: number } = {},
  ) => {
    const companyUser = await repo(User).save(repo(User).create({
      email: `${label}.co.${(seq += 1)}@example.invalid`, passwordHash: 'x',
      role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE,
    }));
    const company = await repo(Company).save(repo(Company).create({
      user: companyUser, name: `${label} Security Ltd`,
      companyNumber: String(30000000 + (seq += 1)), address: '1 Test Street',
      contactDetails: `ops@${label}.example.invalid`,
    }));
    const site = await repo(Site).save(repo(Site).create({
      company, name: `${label} Site`, address: '2 Test Street',
      timezone: 'Europe/London',
      welfareCheckIntervalMinutes: opts.siteWelfareInterval ?? undefined,
      logBookIntervalMinutes: opts.logBookInterval ?? undefined,
    }));
    return { company, site };
  };

  const makeGuard = async (label: string) => {
    const user = await repo(User).save(repo(User).create({
      email: `${label}.guard.${(seq += 1)}@example.invalid`, passwordHash: 'x',
      role: UserRole.GUARD, status: UserStatus.ACTIVE,
    }));
    const guard = await repo(GuardProfile).save(repo(GuardProfile).create({
      user, fullName: `${label} Guard`,
      siaLicenseNumber: String(6200000000000000 + (seq += 1)), phone: '07700000000',
    }));
    return { user, guard };
  };

  const makeShift = async (input: {
    company: Company; site: Site; guard?: GuardProfile;
    start: Date; end: Date; status?: string; checkCallIntervalMinutes?: number;
  }) => {
    const draft: DeepPartial<Shift> = {
      company: input.company, site: input.site, siteName: input.site.name,
      start: input.start, end: input.end, status: input.status ?? 'in_progress',
      checkCallIntervalMinutes: input.checkCallIntervalMinutes ?? undefined,
    };
    if (input.guard) draft.guard = input.guard;
    return repo(Shift).save(repo(Shift).create(draft));
  };

  const bookOn = (shift: Shift, at: Date) => {
    const draft: DeepPartial<AttendanceEvent> = { shift, type: AttendanceEventType.CHECK_IN, occurredAt: at };
    if (shift.guard) draft.guard = shift.guard;
    return repo(AttendanceEvent).save(repo(AttendanceEvent).create(draft));
  };

  const logAt = (shift: Shift, at: Date, logType: DailyLogType) => {
    const draft: DeepPartial<DailyLog> = { shift, company: shift.company, message: 'note', logType, createdAt: at };
    if (shift.guard) draft.guard = shift.guard;
    return repo(DailyLog).save(repo(DailyLog).create(draft));
  };

  // ═══════════════════ the 15-minute UAT case ═══════════════════
  // 11:10–12:10 Europe/London on 30 September 2026 — BST, so 10:10Z–11:10Z. Shift override 15 minutes,
  // site default 60. Effective interval must be 15, giving four windows.

  const SHIFT_START = new Date('2026-09-30T10:10:00.000Z');
  const SHIFT_END = new Date('2026-09-30T11:10:00.000Z');

  const uat = await makeTenant('uat', { siteWelfareInterval: 60, logBookInterval: 60 });
  const uatGuard = await makeGuard('uat');
  const uatShift = await makeShift({
    company: uat.company, site: uat.site, guard: uatGuard.guard,
    start: SHIFT_START, end: SHIFT_END, checkCallIntervalMinutes: 15,
  });
  await bookOn(uatShift, SHIFT_START);

  const uatShifts = makeShiftService(new Map([[uatGuard.user.id, uatGuard.guard]]));

  /** The Guard's view of their own shift at one instant, through the real service. */
  const guardViewAt = async (at: Date) => {
    const realNow = Date.now;
    Date.now = () => at.getTime();
    const OriginalDate = global.Date;
    // The service takes `new Date()` for now; pin it without touching the service's signature.
    (global as any).Date = class extends OriginalDate {
      constructor(...args: any[]) {
        // @ts-expect-error - passthrough constructor
        super(...(args.length ? args : [at.getTime()]));
      }
      static now() { return at.getTime(); }
    };
    try {
      const rows = await uatShifts.getGuardShifts({ sub: uatGuard.user.id, role: UserRole.GUARD } as any);
      return rows.find((row) => row.id === uatShift.id)!;
    } finally {
      (global as any).Date = OriginalDate;
      Date.now = realNow;
    }
  };

  await test('UAT15-01-THE-SHIFT-OVERRIDE-BEATS-THE-SITE-DEFAULT', async () => {
    const row = await guardViewAt(new Date('2026-09-30T10:20:00.000Z'));
    assert.ok(row.operations, 'the Guard must receive an operations projection');
    assert.equal(row.operations!.welfare.intervalMinutes, 15, 'shift 15 beats site 60');
    assert.equal(row.operations!.welfare.enabled, true);
    assert.equal(row.operations!.timezone, 'Europe/London');
  });

  await test('UAT15-02-FOUR-FIFTEEN-MINUTE-WINDOWS-ON-THE-SITE-CLOCK', async () => {
    // 11:10–11:25, 11:25–11:40, 11:40–11:55, 11:55–12:10 site time.
    const row = await guardViewAt(new Date('2026-09-30T10:20:00.000Z'));
    assert.equal(row.operations!.welfare.requiredCount, 4, 'a one-hour shift at 15 minutes owes four');

    // The current window at 11:20 is the FIRST one.
    const current = row.operations!.welfare.currentWindow!;
    assert.equal(current.index, 0);
    assert.equal(current.start, SHIFT_START.toISOString());
    assert.equal(current.end, new Date(SHIFT_START.getTime() + 15 * MIN).toISOString());

    // Rendered on the site's clock those are 11:10 and 11:25 — the owner's stated grid.
    const asSiteTime = (iso: string) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    assert.equal(asSiteTime(current.start), '11:10');
    assert.equal(asSiteTime(current.end), '11:25');
    assert.equal(asSiteTime(row.operations!.welfare.nextDueAt!), '11:25');
  });

  await test('UAT15-03-AT-11-20-THE-CHECK-IS-DUE-UNTIL-IT-IS-DONE', async () => {
    const before = await guardViewAt(new Date('2026-09-30T10:20:00.000Z'));
    assert.equal(before.operations!.welfare.status, 'due');
    assert.equal(before.operations!.welfare.completedCount, 0);

    // A Welfare Check inside window 0, written as the canonical type.
    await logAt(uatShift, new Date('2026-09-30T10:21:00.000Z'), DailyLogType.WELFARE_CHECK);

    const after = await guardViewAt(new Date('2026-09-30T10:22:00.000Z'));
    assert.equal(after.operations!.welfare.status, 'current', 'the current window now reads as satisfied');
    assert.equal(after.operations!.welfare.completedCount, 1);
    assert.equal(after.operations!.welfare.currentWindow!.index, 0, 'still inside window 0');
    assert.equal(after.operations!.welfare.lastWelfareAt, new Date('2026-09-30T10:21:00.000Z').toISOString());
  });

  await test('UAT15-04-AT-11-41-WINDOW-1-IS-OVERDUE-INSIDE-THE-ENGINES-GRACE', async () => {
    // Window 0 was completed above. Window 1 runs 11:25–11:40, and the engine allows
    // WELFARE_GRACE_MINUTES after a window closes before calling it missed — so at 11:41 it is OVERDUE,
    // not missed. This asserts what the engine actually decides; an earlier version of this test
    // asserted a miss at 11:41 and was wrong about the grace, which is exactly the assumption the
    // instruction warned against restating.
    const row = await guardViewAt(new Date('2026-09-30T10:41:00.000Z'));
    const welfare = row.operations!.welfare;

    assert.equal(welfare.status, 'overdue', 'inside the grace it is overdue, not yet missed');
    assert.equal(welfare.missedCount, 0, 'nothing is a miss until the grace expires');
    assert.equal(welfare.completedCount, 1, 'the completed window is still counted');
    assert.equal(welfare.overdueByMinutes, 1, 'one minute past the 11:40 window end');
    assert.equal(
      welfare.currentWindow!.end,
      new Date(SHIFT_START.getTime() + 30 * MIN).toISOString(),
      'the window being chased is window 1, ending 11:40',
    );
  });

  await test('UAT15-04B-AT-11-46-THE-GRACE-HAS-EXPIRED-AND-IT-IS-A-MISS', async () => {
    // The other side of the same boundary, five minutes later. Asserting both sides is what makes this
    // a certification of the grace rather than a restatement of it.
    const row = await guardViewAt(new Date('2026-09-30T10:46:00.000Z'));
    const welfare = row.operations!.welfare;

    assert.equal(welfare.missedCount, 1, 'window 1 is now a miss');
    assert.equal(welfare.consecutiveMissed, 1, 'and it is a standing lapse');
    assert.ok(
      ['overdue', 'missed'].includes(welfare.status),
      `a lapsed shift must not read as satisfied, got ${welfare.status}`,
    );
    assert.equal(welfare.completedCount, 1);
  });

  await test('UAT15-05-GUARD-AND-COMPANY-AGREE-AT-EVERY-INSTANT', async () => {
    // The point of Phase 3D. Same shift, same instant, both surfaces — and the Guard's numbers are a
    // narrowing of the company's, so any divergence is a bug in the narrowing.
    for (const at of [
      '2026-09-30T10:12:00.000Z',
      '2026-09-30T10:20:00.000Z',
      '2026-09-30T10:26:00.000Z',
      '2026-09-30T10:41:00.000Z',
      '2026-09-30T10:45:00.000Z',
      '2026-09-30T10:46:00.000Z',
      '2026-09-30T11:05:00.000Z',
      '2026-09-30T11:30:00.000Z',
    ]) {
      const instant = new Date(at);
      const company = (await projection.projectForShifts([uatShift], instant)).get(uatShift.id)!;
      const guard = (await guardViewAt(instant)).operations!;

      assert.equal(guard.welfare.status, company.welfare.status, `status at ${at}`);
      assert.equal(guard.welfare.intervalMinutes, company.welfare.intervalMinutes, `interval at ${at}`);
      assert.equal(guard.welfare.nextDueAt, company.welfare.nextDueAt, `next due at ${at}`);
      assert.equal(guard.welfare.missedCount, company.welfare.missedCount, `missed at ${at}`);
      assert.equal(guard.welfare.completedCount, company.welfare.completedCount, `completed at ${at}`);
      assert.equal(guard.welfare.consecutiveMissed, company.welfare.consecutiveMissed, `run at ${at}`);
      assert.deepEqual(guard.welfare.currentWindow, company.welfare.currentWindow, `window at ${at}`);
      assert.equal(guard.welfare.requiredCount, company.welfare.requiredCount, `required at ${at}`);
      assert.equal(guard.welfare.overdueByMinutes, company.welfare.overdueByMinutes, `overdue at ${at}`);
      assert.equal(guard.timezone, company.timezone, `zone at ${at}`);
    }
  });

  // ═══════════════════ interval resolution ═══════════════════

  await test('INTERVAL-01-THE-SITE-DEFAULT-IS-MATERIALISED-WHEN-A-SHIFT-IS-WRITTEN', async () => {
    // Where the site's default actually applies. `shifts.checkCallIntervalMinutes` is NOT NULL DEFAULT
    // 60 and migration 1719040000000 backfilled it from each site, so it is a materialised copy of the
    // effective interval rather than an override that can be absent. The window engine's `shift ?? site
    // ?? 60` therefore never reaches its site term — because this rule already consulted the site.
    assert.equal(resolveShiftWelfareInterval(undefined, 30), 30, 'the site default applies');
    assert.equal(resolveShiftWelfareInterval(null, 30), 30);
    assert.equal(resolveShiftWelfareInterval(15, 30), 15, 'an explicit request wins');
    assert.equal(resolveShiftWelfareInterval(undefined, undefined), 60, 'then the system default');
    assert.equal(resolveShiftWelfareInterval(undefined, null), 60);
    assert.equal(DEFAULT_WELFARE_INTERVAL_MINUTES, 60);

    // Nonsense is not an instruction. A zero interval would mean a Welfare Check owed continuously, so
    // it falls through rather than being stored.
    assert.equal(resolveShiftWelfareInterval(0, 30), 30);
    assert.equal(resolveShiftWelfareInterval(-15, 30), 30);
    assert.equal(resolveShiftWelfareInterval(Number.NaN, 30), 30);
    assert.equal(resolveShiftWelfareInterval(0, 0), 60);
  });

  await test('INTERVAL-02-THE-ENGINE-HONOURS-WHATEVER-WAS-MATERIALISED', async () => {
    // A shift carrying 30 — whether the site put it there or the planner did — produces a 30-minute
    // grid, and both surfaces read the same number.
    const tenant = await makeTenant('materialised', { siteWelfareInterval: 30 });
    const g = await makeGuard('materialised');
    const shift = await makeShift({
      company: tenant.company, site: tenant.site, guard: g.guard,
      start: SHIFT_START, end: SHIFT_END,
      checkCallIntervalMinutes: resolveShiftWelfareInterval(undefined, tenant.site.welfareCheckIntervalMinutes),
    });
    await bookOn(shift, SHIFT_START);

    const view = (await projection.projectForShifts([shift], new Date('2026-09-30T10:20:00.000Z'))).get(shift.id)!;
    const guard = toGuardShiftOperations(view)!;
    assert.equal(guard.welfare.intervalMinutes, 30);
    assert.equal(guard.welfare.requiredCount, 2, 'a one-hour shift at 30 minutes owes two');
  });

  await test('INTERVAL-03-THE-RULE-IS-NOT-RESTATED-IN-THE-SERVICE', async () => {
    // It was written out three times — create, the rota-slot create path, and update — which is three
    // chances to drift. Executed above; this only holds the line.
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../src/shift/shift.service.ts'), 'utf8',
    );
    assert.ok(
      !/\?\?\s*site\.welfareCheckIntervalMinutes\s*\?\?/.test(source),
      'no inline copy of the resolution chain may remain',
    );
    const calls = (source.match(/resolveShiftWelfareInterval\(/g) || []).length;
    assert.equal(calls, 3, `all three write paths must use the shared rule, found ${calls}`);
  });
  // ═══════════════════ legacy completion evidence ═══════════════════

  await test('LEGACY-01-A-check_call-ROW-STILL-COMPLETES-A-WINDOW', async () => {
    // Everything recorded before Phase 3C wrote check_call. If only welfare_check counted, every shift
    // worked before the rename would read as a lapse.
    const tenant = await makeTenant('legacy');
    const g = await makeGuard('legacy');
    const shift = await makeShift({
      company: tenant.company, site: tenant.site, guard: g.guard,
      start: SHIFT_START, end: SHIFT_END, checkCallIntervalMinutes: 15,
    });
    await bookOn(shift, SHIFT_START);
    await logAt(shift, new Date('2026-09-30T10:12:00.000Z'), DailyLogType.CHECK_CALL);

    const view = (await projection.projectForShifts([shift], new Date('2026-09-30T10:20:00.000Z'))).get(shift.id)!;
    const guard = toGuardShiftOperations(view)!;
    assert.equal(guard.welfare.completedCount, 1, 'the legacy type completed window 0');
    assert.equal(guard.welfare.status, 'current');
  });

  await test('LEGACY-02-A-log_book-ROW-DOES-NOT-COMPLETE-A-WELFARE-WINDOW', async () => {
    // The distinction the types exist to make: a written Log Book entry is not a welfare check.
    const tenant = await makeTenant('logbook');
    const g = await makeGuard('logbook');
    const shift = await makeShift({
      company: tenant.company, site: tenant.site, guard: g.guard,
      start: SHIFT_START, end: SHIFT_END, checkCallIntervalMinutes: 15,
    });
    await bookOn(shift, SHIFT_START);
    await logAt(shift, new Date('2026-09-30T10:12:00.000Z'), DailyLogType.LOG_BOOK);

    const view = (await projection.projectForShifts([shift], new Date('2026-09-30T10:20:00.000Z'))).get(shift.id)!;
    const guard = toGuardShiftOperations(view)!;
    assert.equal(guard.welfare.completedCount, 0, 'a Log Book entry owes a welfare check still');
    assert.equal(guard.welfare.status, 'due');
  });

  await test('LEGACY-03-BOTH-TYPES-TOGETHER-ON-ONE-SHIFT', async () => {
    // A shift worked across the upgrade. Both rows count, in whatever order they were written.
    const tenant = await makeTenant('mixed');
    const g = await makeGuard('mixed');
    const shift = await makeShift({
      company: tenant.company, site: tenant.site, guard: g.guard,
      start: SHIFT_START, end: SHIFT_END, checkCallIntervalMinutes: 15,
    });
    await bookOn(shift, SHIFT_START);
    await logAt(shift, new Date('2026-09-30T10:12:00.000Z'), DailyLogType.CHECK_CALL);
    await logAt(shift, new Date('2026-09-30T10:27:00.000Z'), DailyLogType.WELFARE_CHECK);

    const view = (await projection.projectForShifts([shift], new Date('2026-09-30T10:35:00.000Z'))).get(shift.id)!;
    assert.equal(toGuardShiftOperations(view)!.welfare.completedCount, 2, 'both windows satisfied');
    assert.equal(toGuardShiftOperations(view)!.welfare.missedCount, 0);
  });

  // ═══════════════════ authorization ═══════════════════

  await test('AUTHZ-01-A-GUARD-RECEIVES-ONLY-THEIR-OWN-SHIFTS', async () => {
    const tenant = await makeTenant('authz');
    const mine = await makeGuard('mine');
    const theirs = await makeGuard('theirs');

    const myShift = await makeShift({
      company: tenant.company, site: tenant.site, guard: mine.guard,
      start: SHIFT_START, end: SHIFT_END, checkCallIntervalMinutes: 15,
    });
    const theirShift = await makeShift({
      company: tenant.company, site: tenant.site, guard: theirs.guard,
      start: SHIFT_START, end: SHIFT_END, checkCallIntervalMinutes: 15,
    });
    await bookOn(myShift, SHIFT_START);
    await bookOn(theirShift, SHIFT_START);

    const service = makeShiftService(new Map([
      [mine.user.id, mine.guard], [theirs.user.id, theirs.guard],
    ]));
    const rows = await service.getGuardShifts({ sub: mine.user.id, role: UserRole.GUARD } as any);
    const ids = rows.map((row) => row.id);

    assert.ok(ids.includes(myShift.id), 'own shift present');
    assert.ok(!ids.includes(theirShift.id), "another Guard's shift must not be returned");
  });

  await test('AUTHZ-02-THERE-IS-NO-IDENTIFIER-TO-TAMPER-WITH', async () => {
    // The strongest form of the requirement: the Guard operations path takes NO shift id, guard id or
    // company id from the caller. Scoping comes from the token's own subject, in SQL. Changing an id is
    // not "denied" — there is no id to change.
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../src/shift/shift.service.ts'), 'utf8',
    );
    const body = source.slice(
      source.indexOf('async getGuardShifts('),
      source.indexOf('\n  }', source.indexOf('async getGuardShifts(')),
    );
    assert.ok(body.includes('findByUserId(user.sub)'), 'the guard is resolved from the token subject');
    assert.ok(body.includes('where: { guard: { id: guard.id } }'), 'and the query is scoped by that guard');

    const signature = source.slice(source.indexOf('async getGuardShifts('), source.indexOf(')', source.indexOf('async getGuardShifts(')));
    assert.ok(!/shiftId|guardId|companyId|\bid\b/.test(signature), `no identifier parameter: ${signature}`);
  });

  await test('AUTHZ-03-CROSS-COMPANY-SHIFTS-ARE-NOT-REACHABLE', async () => {
    const a = await makeTenant('tenant-a');
    const b = await makeTenant('tenant-b');
    const g = await makeGuard('crosser');

    // One guard, one shift at company A. Company B has a shift with no guard at all.
    const own = await makeShift({
      company: a.company, site: a.site, guard: g.guard,
      start: SHIFT_START, end: SHIFT_END, checkCallIntervalMinutes: 15,
    });
    const other = await makeShift({
      company: b.company, site: b.site,
      start: SHIFT_START, end: SHIFT_END, status: 'unfilled',
    });

    const service = makeShiftService(new Map([[g.user.id, g.guard]]));
    const rows = await service.getGuardShifts({ sub: g.user.id, role: UserRole.GUARD } as any);
    assert.deepEqual(rows.map((row) => row.id), [own.id], 'exactly their own shift, from their own company');
    assert.ok(!rows.some((row) => row.id === other.id));
  });

  await test('AUTHZ-04-A-GUARD-WITH-NO-PROFILE-IS-REFUSED', async () => {
    const service = makeShiftService(new Map());
    await assert.rejects(
      () => service.getGuardShifts({ sub: 999999, role: UserRole.GUARD } as any),
      /Guard profile not found/,
    );
  });

  // ═══════════════════ what the Guard is NOT told ═══════════════════

  await test('SCOPE-01-CONTROL-ROOM-ONLY-FIELDS-ARE-WITHHELD', async () => {
    // The company view carries the Welfare ALERT raised against this Guard, including whether it has been
    // acknowledged, the count of durable missed-window evidence rows, and the missing-Book-Off exception.
    // Those are for the company to act on, not for the Guard to receive.
    const row = await guardViewAt(new Date('2026-09-30T10:41:00.000Z'));
    const guard = row.operations! as Record<string, unknown>;

    for (const field of COMPANY_ONLY_OPERATIONS_FIELDS) {
      assert.ok(!(field in guard), `${field} must not reach the Guard`);
    }
    assert.deepEqual(Object.keys(guard).sort(), ['logBook', 'timezone', 'welfare']);

    const welfareKeys = Object.keys(guard.welfare as object).sort();
    assert.deepEqual(welfareKeys, [
      'completedCount', 'consecutiveMissed', 'currentWindow', 'enabled', 'intervalMinutes',
      'lastWelfareAt', 'missedCount', 'nextDueAt', 'overdueByMinutes', 'requiredCount', 'status',
    ]);
    assert.deepEqual(Object.keys(guard.logBook as object).sort(), [
      'currentWindow', 'currentWindowSubmitted', 'intervalMinutes', 'lastEntryAt', 'required',
    ]);
  });

  await test('SCOPE-02-COMPANY-PERMISSIONS-ARE-UNCHANGED', async () => {
    // The company projection still carries everything it did; narrowing for the Guard must not have
    // removed anything from the control room's own view.
    const company = (await projection.projectForShifts([uatShift], new Date('2026-09-30T10:41:00.000Z'))).get(uatShift.id)!;
    for (const field of COMPANY_ONLY_OPERATIONS_FIELDS) {
      assert.ok(field in company, `the company view must still carry ${field}`);
    }
  });

  // ═══════════════════ which shifts are projected ═══════════════════

  await test('RELEVANCE-01-IN-PROGRESS-IS-ALWAYS-PROJECTED', async () => {
    const now = new Date('2026-09-30T10:41:00.000Z');
    // Even one that should have ended days ago: that is the exception the Guard most needs to see.
    assert.equal(needsGuardOperations(
      { status: 'in_progress', start: '2026-09-25T08:00:00.000Z', end: '2026-09-25T16:00:00.000Z' }, now,
    ), true);
  });

  await test('RELEVANCE-02-OLD-AND-DISTANT-SHIFTS-ARE-NOT', async () => {
    const now = new Date('2026-09-30T10:41:00.000Z');
    const hours = (n: number) => new Date(now.getTime() + n * 3_600_000).toISOString();

    assert.equal(GUARD_OPERATIONS_WINDOW_HOURS, 24);
    // Inside the window either side.
    assert.equal(needsGuardOperations({ status: 'completed', start: hours(-30), end: hours(-23) }, now), true);
    assert.equal(needsGuardOperations({ status: 'ready', start: hours(20), end: hours(28) }, now), true);
    // Outside it.
    assert.equal(needsGuardOperations({ status: 'completed', start: hours(-40), end: hours(-25) }, now), false);
    assert.equal(needsGuardOperations({ status: 'ready', start: hours(25), end: hours(33) }, now), false);
    // Unusable schedule is not guessed at.
    assert.equal(needsGuardOperations({ status: 'ready', start: 'nonsense', end: 'nonsense' }, now), false);
  });

  await test('RELEVANCE-03-A-SHIFT-OUTSIDE-THE-WINDOW-GETS-NULL-NOT-ZEROES', async () => {
    // Null means "nothing owed here", which the app renders as nothing. Zeroes would read as a shift that
    // owed four checks and completed none.
    const tenant = await makeTenant('ancient');
    const g = await makeGuard('ancient');
    const old = await makeShift({
      company: tenant.company, site: tenant.site, guard: g.guard,
      start: new Date('2026-08-01T08:00:00.000Z'), end: new Date('2026-08-01T16:00:00.000Z'),
      status: 'completed', checkCallIntervalMinutes: 15,
    });

    const service = makeShiftService(new Map([[g.user.id, g.guard]]));
    const rows = await service.getGuardShifts({ sub: g.user.id, role: UserRole.GUARD } as any);
    const row = rows.find((r) => r.id === old.id)!;
    assert.equal(row.operations, null);
    assert.equal(toGuardShiftOperations(null), null);
    assert.equal(toGuardShiftOperations(undefined), null);
  });

  // ═══════════════════ Log Book ═══════════════════

  await test('LOGBOOK-01-THE-CURRENT-PERIOD-STATE-REACHES-THE-GUARD', async () => {
    const row = await guardViewAt(new Date('2026-09-30T10:20:00.000Z'));
    const logBook = row.operations!.logBook;
    assert.equal(logBook.required, true, 'the site sets a 60-minute Log Book interval');
    assert.equal(logBook.intervalMinutes, 60);
    assert.ok(logBook.currentWindow, 'and there is a current period');
    assert.equal(logBook.currentWindowSubmitted, false, 'nothing submitted yet');

    await logAt(uatShift, new Date('2026-09-30T10:25:00.000Z'), DailyLogType.LOG_BOOK);
    const after = await guardViewAt(new Date('2026-09-30T10:30:00.000Z'));
    assert.equal(after.operations!.logBook.currentWindowSubmitted, true, 'and now it is');
    assert.equal(
      after.operations!.logBook.lastEntryAt,
      new Date('2026-09-30T10:25:00.000Z').toISOString(),
    );
  });

  await test('LOGBOOK-02-NO-INTERVAL-MEANS-NOTHING-IS-OWED', async () => {
    const tenant = await makeTenant('no-logbook', {});
    const g = await makeGuard('no-logbook');
    const shift = await makeShift({
      company: tenant.company, site: tenant.site, guard: g.guard,
      start: SHIFT_START, end: SHIFT_END, checkCallIntervalMinutes: 15,
    });
    await bookOn(shift, SHIFT_START);

    const view = (await projection.projectForShifts([shift], new Date('2026-09-30T10:20:00.000Z'))).get(shift.id)!;
    assert.equal(toGuardShiftOperations(view)!.logBook.required, false, 'as required, never missing');
  });

  // ═══════════════════ no Book On ═══════════════════

  await test('BOOKON-01-NO-BOOK-ON-IS-AN-ATTENDANCE-EXCEPTION-NOT-A-WELFARE-BREACH', async () => {
    const tenant = await makeTenant('nobookon');
    const g = await makeGuard('nobookon');
    const shift = await makeShift({
      company: tenant.company, site: tenant.site, guard: g.guard,
      start: SHIFT_START, end: SHIFT_END, checkCallIntervalMinutes: 15,
    });

    const view = (await projection.projectForShifts([shift], new Date('2026-09-30T10:41:00.000Z'))).get(shift.id)!;
    assert.equal(toGuardShiftOperations(view)!.welfare.status, 'no_book_on');
  });

  await ds.destroy();
  console.log(`\nGUARD OPERATIONS PROJECTION: ${passed} PASS / 0 FAIL`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
