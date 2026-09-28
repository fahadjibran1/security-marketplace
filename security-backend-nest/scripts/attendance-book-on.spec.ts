/**
 * UAT-ATT-01 certification: when a Book On is accepted, and the one case where it is not.
 *
 * The locked product rule is that an assigned Guard whose Shift is READY may Book On early, exactly on
 * time, or late — S4 records reality rather than preventing attendance from being recorded. The backend
 * already had no time gate at all, which is why this file exists: that permissiveness was accidental
 * and completely uncertified, so nothing stopped someone "tidying up" a time check back into place.
 *
 * It also certifies the one new restriction. Nothing in the system ever transitions a stale `ready`
 * Shift to `missed`, so without a boundary an abandoned Shift from weeks ago would stay bookable
 * forever. The boundary is scheduled END + 12 h — far beyond any operational delay.
 *
 * Runs the real AttendanceService against a real PostgreSQL schema, because the lifecycle transitions,
 * the idempotent retry ordering and the Timesheet actuals are all database behaviour.
 *
 * Needs ATTENDANCE_DATABASE_URL pointing at a DISPOSABLE database — it drops the schema.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Company } from '../src/company/entities/company.entity';
import { Site } from '../src/site/entities/site.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { AttendanceEvent, AttendanceEventType } from '../src/attendance/entities/attendance.entity';
import { AttendanceService, STALE_BOOK_ON_GRACE_HOURS } from '../src/attendance/attendance.service';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import { WelfareWindowService } from '../src/operations/welfare-window.service';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

async function expectRejection(
  id: string,
  fn: () => Promise<unknown>,
  expected: RegExp,
  type: unknown = BadRequestException,
) {
  await test(id, async () => {
    await assert.rejects(fn, (error: unknown) => {
      assert.ok(error instanceof (type as never), `expected ${(type as { name: string }).name}, got ${error}`);
      assert.match((error as Error).message, expected);
      return true;
    });
  });
}

const HOUR = 3_600_000;
const MIN = 60_000;

async function main() {
  const url = process.env.ATTENDANCE_DATABASE_URL;
  if (!url) throw new Error('ATTENDANCE_DATABASE_URL is required (use a disposable database)');

  const ds = new DataSource({ type: 'postgres', url, entities: appEntities, synchronize: true, dropSchema: true, logging: false });
  await ds.initialize();

  try {
    const users = ds.getRepository(User);
    const guards = ds.getRepository(GuardProfile);
    const companies = ds.getRepository(Company);
    const sites = ds.getRepository(Site);
    const shifts = ds.getRepository(Shift);
    const attendance = ds.getRepository(AttendanceEvent);

    const owner = await users.save(users.create({
      email: 'att.owner@example.invalid', passwordHash: 'x',
      role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE, isEmailVerified: true,
    }));
    const company = await companies.save(companies.create({
      user: owner, name: 'Attendance Security Ltd', companyNumber: '44444444',
      address: '1 Attendance Way', contactDetails: 'ops@att.example.invalid',
    }));
    // No GPS / NFC requirement, so the evidence gate is dormant and cannot mask a timing result.
    const site: Site = await sites.save(sites.create({
      company, name: 'Attendance Site', address: '2 Attendance Way',
      requireGpsCheckIn: false, requireNfcCheckIn: false,
    } as Partial<Site>));

    let sia = 3000000000000000;
    const makeGuard = async (label: string) => {
      const user = await users.save(users.create({
        email: `${label}@example.invalid`, passwordHash: 'x',
        role: UserRole.GUARD, status: UserStatus.ACTIVE, isEmailVerified: true,
      }));
      sia += 1;
      return guards.save(guards.create({
        user, fullName: `${label} Guard`, siaLicenseNumber: String(sia),
        siaExpiryDate: '2028-01-01', rightToWorkStatus: 'british', phone: '07000000000',
      }));
    };

    const guardA = await makeGuard('attguarda');
    const guardB = await makeGuard('attguardb');

    /** A Shift whose scheduled window is positioned relative to now, in the given lifecycle state. */
    const makeShift = async (
      guard: GuardProfile | null,
      startOffsetMs: number,
      durationMs = 8 * HOUR,
      status = 'ready',
    ) => {
      const start = new Date(Date.now() + startOffsetMs);
      const saved: Shift = await shifts.save(shifts.create({
        company, site, siteName: site.name, guard: guard ?? undefined,
        status, start, end: new Date(start.getTime() + durationMs),
        checkCallIntervalMinutes: 60,
      } as Partial<Shift>));
      return saved;
    };

    // ── the service under test, with only the collaborators check-in actually touches ──
    const guardProfileService = {
      findByUserId: async (userId: number) => guards.findOne({ where: { user: { id: userId } } }),
      findOne: async (id: number) => guards.findOneOrFail({ where: { id } }),
    } as never;
    const shiftService = {
      findOne: async (id: number) => shifts.findOneOrFail({ where: { id } }),
      save: (shift: Shift) => shifts.save(shift),
      normalizeLifecycleStatus: (status: string) => String(status || '').toLowerCase(),
    } as never;
    const siteService = {
      findVerificationConfig: async (id: number) => sites.findOneOrFail({ where: { id } }),
    } as never;

    const service = new AttendanceService(
      attendance,
      shiftService,
      guardProfileService,
      { recordAttendanceActuals: async () => undefined } as never,
      { save: async () => undefined } as never,
      { resolveCompanyContext: async () => { throw new Error('not used'); } } as never,
      siteService,
      ds,
    );

    const bookOn = (guard: GuardProfile, shift: Shift) => service.checkIn(guard.user.id, { shiftId: shift.id } as never);

    // ══════════ 16-19: the full accepted range ══════════

    await test('ATT-16-TWO-HOURS-EARLY-IS-ACCEPTED', async () => {
      const shift = await makeShift(guardA, 2 * HOUR);
      const event = await bookOn(guardA, shift);
      assert.equal(event.type, AttendanceEventType.CHECK_IN);
      const after = await shifts.findOneOrFail({ where: { id: shift.id } });
      assert.equal(after.status, 'in_progress', 'the shift goes live even though it has not started');
    });

    await test('ATT-16B-TWELVE-HOURS-EARLY-IS-ACCEPTED', async () => {
      // There is no early cutoff at all, so an extreme early value must also pass.
      const shift = await makeShift(guardA, 12 * HOUR);
      await bookOn(guardA, shift);
    });

    await test('ATT-17-EXACT-SCHEDULED-START-IS-ACCEPTED', async () => {
      const shift = await makeShift(guardA, 0);
      await bookOn(guardA, shift);
    });

    await test('ATT-18-LATE-BOOK-ON-IS-ACCEPTED', async () => {
      for (const lateBy of [5 * MIN, 2 * HOUR]) {
        const shift = await makeShift(guardA, -lateBy);
        await bookOn(guardA, shift);
      }
    });

    await test('ATT-19-END-PLUS-ELEVEN-HOURS-FIFTY-NINE-IS-ACCEPTED', async () => {
      assert.equal(STALE_BOOK_ON_GRACE_HOURS, 12, 'the documented boundary');
      // An 8h shift that ended 11h59m ago: start = -(8h + 11h59m).
      const shift = await makeShift(guardA, -(8 * HOUR + 11 * HOUR + 59 * MIN));
      const event = await bookOn(guardA, shift);
      assert.equal(event.type, AttendanceEventType.CHECK_IN, 'just inside the boundary still books on');
    });

    // ══════════ 20-21: the stale boundary ══════════

    const staleShift = await makeShift(guardA, -(8 * HOUR + 12 * HOUR + 1 * MIN));
    await expectRejection(
      'ATT-20-END-PLUS-TWELVE-HOURS-ONE-MINUTE-IS-REJECTED',
      () => bookOn(guardA, staleShift),
      /too old to Book On/,
    );

    await test('ATT-21-THE-STALE-MESSAGE-IS-USER-SAFE', async () => {
      const error = await bookOn(guardA, staleShift).catch((e: Error) => e);
      assert.equal((error as Error).message, 'This shift is too old to Book On. Contact Control.');
      // No internals: no timestamps, ids, SQL, class names or configuration values.
      assert.doesNotMatch((error as Error).message, /\d{4}-\d{2}-\d{2}|shiftId|SELECT|Exception|\d+ ?h(our)?s?\b/i);
      const untouched = await shifts.findOneOrFail({ where: { id: staleShift.id } });
      assert.equal(untouched.status, 'ready', 'a rejected Book On changes nothing');
      assert.equal(await attendance.count({ where: { shift: { id: staleShift.id } } }), 0, 'and writes no event');
    });

    // ══════════ 22-24: the legitimate blockers still bite ══════════

    const cancelled = await makeShift(guardA, -HOUR, 8 * HOUR, 'cancelled');
    await expectRejection(
      'ATT-22-CANCELLED-SHIFT-IS-REJECTED',
      () => bookOn(guardA, cancelled),
      /Only ready shifts can be checked in/,
    );

    const completed = await makeShift(guardA, -HOUR, 8 * HOUR, 'completed');
    await expectRejection(
      'ATT-23-COMPLETED-SHIFT-IS-REJECTED',
      () => bookOn(guardA, completed),
      /Only ready shifts can be checked in/,
    );

    const notMine = await makeShift(guardA, 0);
    await expectRejection(
      'ATT-24-WRONG-GUARD-IS-REJECTED',
      () => bookOn(guardB, notMine),
      /not assigned to the current guard/,
      ForbiddenException,
    );

    await expectRejection(
      'ATT-24B-UNFILLED-SHIFT-IS-REJECTED',
      async () => {
        const unfilled = await makeShift(null, 0, 8 * HOUR, 'unfilled');
        return bookOn(guardA, unfilled);
      },
      /not assigned to the current guard/,
      ForbiddenException,
    );

    // ══════════ 25: idempotency, including across the stale boundary ══════════

    await test('ATT-25-A-SUCCESSFUL-BOOK-ON-RETRY-STAYS-IDEMPOTENT', async () => {
      const shift = await makeShift(guardA, -MIN);
      const first = await bookOn(guardA, shift);
      const retry = await bookOn(guardA, shift);
      assert.equal(retry.id, first.id, 'the same event comes back, not a duplicate');
      assert.equal(await attendance.count({ where: { shift: { id: shift.id } } }), 1);
    });

    await test('ATT-25B-THE-RETRY-BRANCH-PRECEDES-THE-STALE-CHECK', async () => {
      // The ordering that matters: a Guard who really did Book On must keep getting their event back
      // even if the retry arrives after the boundary. Otherwise a lost response near the boundary
      // would convert a successful Book On into an error.
      const shift = await makeShift(guardA, -MIN);
      const first = await bookOn(guardA, shift);
      await shifts.update({ id: shift.id }, {
        start: new Date(Date.now() - (30 * HOUR)),
        end: new Date(Date.now() - (22 * HOUR)),                    // ended 22 h ago: well past END + 12 h
      });
      const retry = await bookOn(guardA, shift);
      assert.equal(retry.id, first.id, 'idempotent retry survives the stale boundary');
    });

    // ══════════ 26-27: scheduled times preserved, actual time real ══════════

    await test('ATT-26-EARLY-BOOK-ON-DOES-NOT-MOVE-THE-SCHEDULED-TIMES', async () => {
      const shift = await makeShift(guardA, 3 * HOUR);
      const scheduledStart = shift.start.getTime();
      const scheduledEnd = shift.end.getTime();
      await bookOn(guardA, shift);
      const after = await shifts.findOneOrFail({ where: { id: shift.id } });
      assert.equal(new Date(after.start).getTime(), scheduledStart, 'scheduled start is untouched');
      assert.equal(new Date(after.end).getTime(), scheduledEnd, 'scheduled end is untouched');
    });

    await test('ATT-27-THE-EVENT-RECORDS-THE-REAL-ATTENDANCE-INSTANT', async () => {
      const shift = await makeShift(guardA, 4 * HOUR);
      const event = await bookOn(guardA, shift);

      // Asserted in SQL against the database's OWN clock. attendance_events.occurredAt is a
      // `timestamp` without time zone, so comparing it to a JS Date in the test process would be
      // comparing through the driver's timezone interpretation rather than testing the behaviour.
      const [row] = (await ds.query(
        `SELECT ("occurredAt" BETWEEN now() - interval '5 minutes' AND now() + interval '5 minutes') AS is_now,
                ("occurredAt" < s."start")                                                          AS before_scheduled_start,
                s."start" - "occurredAt"                                                            AS early_by
           FROM attendance_events e JOIN shifts s ON s.id = e."shiftId"
          WHERE e.id = $1`,
        [event.id],
      )) as Array<{ is_now: boolean; before_scheduled_start: boolean; early_by: unknown }>;

      // Server-stamped at the real instant, NOT clipped forward to the scheduled start.
      assert.equal(row.is_now, true, 'occurredAt is the moment the Book On happened');
      assert.equal(row.before_scheduled_start, true, `and is genuinely before the scheduled start (early by ${JSON.stringify(row.early_by)})`);
    });

    // ══════════ 28-29: Welfare is anchored to the SCHEDULED start ══════════

    const windowEngine = new OperationalWindowService();
    const welfare = new WelfareWindowService(windowEngine);

    /** The production welfare path: resolve, then keep only the windows that actually applied. */
    const applicableWelfare = (intervalMinutes: number, shiftStart: Date, shiftEnd: Date, bookOnAt: Date) =>
      welfare
        .resolve({
          shiftStart,
          shiftEnd,
          interval: { shiftCheckCallIntervalMinutes: intervalMinutes },
          completions: [],
          applicability: { bookOnAt, bookOffAt: null, shiftEnd, cancelled: false },
          // Long after the shift so every window has elapsed and been judged.
          now: new Date(shiftEnd.getTime() + HOUR),
        })
        .windows.filter((window) => window.state !== 'not_applicable');

    await test('ATT-28-EARLY-BOOK-ON-CREATES-NO-PRE-START-WELFARE-WINDOWS', async () => {
      // Scheduled 18:00-06:00 hourly, actual Book On 16:00 — two hours early.
      const shiftStart = new Date(Date.UTC(2026, 8, 28, 18, 0));
      const shiftEnd = new Date(Date.UTC(2026, 8, 29, 6, 0));
      const bookOnAt = new Date(Date.UTC(2026, 8, 28, 16, 0));
      const applicable = applicableWelfare(60, shiftStart, shiftEnd, bookOnAt);

      assert.ok(applicable.length > 0, 'the shift still has welfare obligations');
      assert.ok(
        applicable.every((w) => w.start.getTime() >= shiftStart.getTime()),
        'no window may begin before the SCHEDULED start, however early the Guard booked on',
      );
      assert.equal(
        applicable[0].start.getTime(),
        shiftStart.getTime(),
        'the first applicable window is 18:00-19:00 — there is no 16:00-17:00 or 17:00-18:00 obligation',
      );
      assert.equal(applicable.length, 12, 'a 12-hour shift at hourly intervals has 12 windows, not 14');
    });

    await test('ATT-29-LATE-BOOK-ON-CREATES-NO-RETROSPECTIVE-MISSES', async () => {
      // Scheduled 18:00, actual Book On 18:25 — 18:00-19:00 is still the first applicable window.
      const shiftStart = new Date(Date.UTC(2026, 8, 28, 18, 0));
      const shiftEnd = new Date(Date.UTC(2026, 8, 29, 6, 0));
      const bookOnAt = new Date(Date.UTC(2026, 8, 28, 18, 25));
      const applicable = applicableWelfare(60, shiftStart, shiftEnd, bookOnAt);

      assert.equal(applicable[0].start.getTime(), shiftStart.getTime(), 'the 18:00-19:00 window applies');
      assert.ok(
        applicable.every((w) => w.end.getTime() > bookOnAt.getTime()),
        'no window that had already closed before Book On is applicable, so nothing is retrospectively missed',
      );

      // With a shorter interval, only whole windows already closed before Book On drop out.
      const quarterHour = applicableWelfare(15, shiftStart, shiftEnd, bookOnAt);
      assert.equal(
        quarterHour[0].start.getTime(),
        new Date(Date.UTC(2026, 8, 28, 18, 15)).getTime(),
        'the 18:15-18:30 window is the first still open at 18:25',
      );
      assert.ok(
        quarterHour.every((w) => w.end.getTime() > bookOnAt.getTime()),
        'the 18:00-18:15 window closed before Book On and is not a miss',
      );
    });

    console.log(`\n${passed} attendance book on checks passed`);
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
