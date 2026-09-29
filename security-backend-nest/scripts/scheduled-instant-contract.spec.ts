/**
 * Scheduled times are TRUE INSTANTS — server contract. (Phase 1, UAT Round 1 Finding 4.)
 *
 * WHAT WENT WRONG
 * The Rota Planner posted "2026-09-29T11:30:00", with no offset. `@IsDateString()` accepted it, and the
 * service resolved it with `new Date(...)`, which treats an offset-less date-time as LOCAL. Running in UTC
 * that became 11:30Z and was stored as 11:30 — an hour later than the operator meant during BST. Every
 * consumer that treats a shift start as a real moment inherited the hour: a guard booking on one minute
 * early was told "1 hr 1 min early", and the welfare engine believed a live shift had not started.
 *
 * The client now sends an instant. These tests hold the SERVER to it, so an old build, a script or a
 * future caller cannot reintroduce the ambiguous form: the request is refused with a message that names
 * the problem, instead of quietly writing a time nobody chose.
 *
 * They run the real DTOs through the real validation pipe configuration, and execute the real conversion
 * and the real process-clock assertion.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe, ArgumentMetadata } from '@nestjs/common';
import { CreateRotaSlotDto } from '../src/rota-slot/dto/create-rota-slot.dto';
import { ChangeRotaSlotTimeDto } from '../src/rota-slot/dto/change-rota-slot-time.dto';
import { CreateShiftDto } from '../src/shift/dto/create-shift.dto';
import { UpdateShiftDto } from '../src/shift/dto/update-shift.dto';
import { HireApplicationDto } from '../src/job-application/dto/hire-application.dto';
import { RecordAttendanceDto } from '../src/attendance/dto/record-attendance.dto';
import {
  AMBIGUOUS_POLICY,
  DEFAULT_SITE_TIME_ZONE,
  hasExplicitUtcOffset,
  offsetSuffix,
  siteLocalEndToInstant,
  siteLocalToInstant,
  zoneOffsetMs,
} from '../src/common/site-time';
import { assertProcessTimezone, requireUtcProcessTimezone } from '../src/config/process-timezone';
import { WelfareWindowService } from '../src/operations/welfare-window.service';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import { OperationalWindowState } from '../src/operations/operational-window.types';

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

// Exactly the configuration main.ts applies in production.
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const meta = (metatype: unknown): ArgumentMetadata => ({ type: 'body', metatype: metatype as never, data: '' });
const validate = (dto: unknown, body: Record<string, unknown>) => pipe.transform(body, meta(dto));
const errorsFrom = async (dto: unknown, body: Record<string, unknown>) => {
  try {
    await validate(dto, body);
    return null;
  } catch (e) {
    return JSON.stringify((e as { response?: unknown }).response ?? (e as Error).message);
  }
};

const LONDON = 'Europe/London';
const slotBody = { siteId: 1 };
const shiftBody = { siteId: 1 };

/** The instant a resolution refers to, as a UTC ISO string — what actually reaches the column. */
function utcOf(resolution: ReturnType<typeof siteLocalToInstant>) {
  assert.equal(resolution.ok, true, `expected a resolvable time: ${'message' in resolution ? resolution.message : ''}`);
  return new Date((resolution as { instant: number }).instant).toISOString();
}

/** A site-local clock time at the London site, as epoch milliseconds. Throws if it does not exist. */
function instantOf(date: string, time: string, timeZone = LONDON): number {
  const resolved = siteLocalToInstant(date, time, timeZone);
  assert.equal(resolved.ok, true, `${date} ${time} should resolve at ${timeZone}`);
  return (resolved as { instant: number }).instant;
}

/** The same for an end time, rolling to the next site-local day when the shift runs past midnight. */
function endInstantOf(date: string, startTime: string, endTime: string, timeZone = LONDON): number {
  const resolved = siteLocalEndToInstant(date, startTime, endTime, timeZone);
  assert.equal(resolved.ok, true, `${date} ${startTime}–${endTime} should resolve at ${timeZone}`);
  return (resolved as { instant: number }).instant;
}

// The REAL welfare engine, not a reimplementation of it: this is the code the sweep and Live Operations
// both call, so if the corrected instants do not produce live windows here, they do not in production.
const welfare = new WelfareWindowService(new OperationalWindowService());

async function main() {
  // ── The contract at the HTTP edge ──────────────────────────────────────────────────────────────

  await test('INSTANT-01-ROTA-CREATE-ACCEPTS-OFFSET', async () => {
    const out = (await validate(CreateRotaSlotDto, {
      ...slotBody,
      startAt: '2026-09-29T11:30:00+01:00',
      endAt: '2026-09-29T19:30:00+01:00',
    })) as CreateRotaSlotDto;
    assert.equal(out.startAt, '2026-09-29T11:30:00+01:00');
    assert.equal(new Date(out.startAt).toISOString(), '2026-09-29T10:30:00.000Z');
  });

  await test('INSTANT-02-ROTA-CREATE-ACCEPTS-Z', async () => {
    const errors = await errorsFrom(CreateRotaSlotDto, {
      ...slotBody,
      startAt: '2026-12-15T11:30:00.000Z',
      endAt: '2026-12-15T19:30:00.000Z',
    });
    assert.equal(errors, null, `a UTC instant must be accepted: ${errors}`);
  });

  await test('INSTANT-03-ROTA-CREATE-REJECTS-NAIVE', async () => {
    // The exact request the old client sent.
    const errors = await errorsFrom(CreateRotaSlotDto, {
      ...slotBody,
      startAt: '2026-09-29T11:30:00',
      endAt: '2026-09-29T19:30:00',
    });
    assert.ok(errors, 'an offset-less date-time must be refused, not silently reinterpreted');
    assert.ok(
      errors!.includes('explicit UTC offset'),
      `the message must name the problem, got ${errors}`,
    );
  });

  await test('INSTANT-04-ROTA-CHANGE-TIME-REJECTS-NAIVE', async () => {
    const naive = await errorsFrom(ChangeRotaSlotTimeDto, {
      startAt: '2026-09-29T11:30:00',
      endAt: '2026-09-29T19:30:00',
    });
    assert.ok(naive, 'editing a slot must be held to the same contract as creating one');
    const withOffset = await errorsFrom(ChangeRotaSlotTimeDto, {
      startAt: '2026-09-29T11:30:00+01:00',
      endAt: '2026-09-29T19:30:00+01:00',
    });
    assert.equal(withOffset, null, `an instant must still be accepted: ${withOffset}`);
  });

  await test('INSTANT-05-SHIFT-CREATE-REJECTS-NAIVE', async () => {
    const naive = await errorsFrom(CreateShiftDto, {
      ...shiftBody,
      start: '2026-09-29T11:30:00',
      end: '2026-09-29T19:30:00',
    });
    assert.ok(naive, 'the legacy shift endpoint must be held to the contract too');
    const withOffset = await errorsFrom(CreateShiftDto, {
      ...shiftBody,
      start: '2026-09-29T11:30:00+01:00',
      end: '2026-09-29T19:30:00+01:00',
    });
    assert.equal(withOffset, null, `an instant must be accepted: ${withOffset}`);
  });

  await test('INSTANT-06-SHIFT-UPDATE-INHERITS-THE-CONTRACT', async () => {
    // UpdateShiftDto is a PartialType of the create DTO, so it must carry the same rule.
    const naive = await errorsFrom(UpdateShiftDto, { start: '2026-09-29T11:30:00' });
    assert.ok(naive, 'a partial update must not be a way around the contract');
    const withOffset = await errorsFrom(UpdateShiftDto, { start: '2026-09-29T11:30:00+01:00' });
    assert.equal(withOffset, null, `an instant must be accepted: ${withOffset}`);
    // An update that does not touch the times is unaffected.
    const untouched = await errorsFrom(UpdateShiftDto, { closeOutNotes: 'handover complete' });
    assert.equal(untouched, null, `unrelated fields must still update: ${untouched}`);
  });

  await test('INSTANT-07-HIRE-WITH-SHIFT-REJECTS-NAIVE', async () => {
    const naive = await errorsFrom(HireApplicationDto, {
      createShift: true,
      siteId: 1,
      start: '2026-09-29T11:30:00',
      end: '2026-09-29T19:30:00',
    });
    assert.ok(naive, 'hiring can create the first shift, so it writes a scheduled time');
    // Hiring without creating a shift passes no times at all, and must stay valid.
    const withoutShift = await errorsFrom(HireApplicationDto, { createShift: false });
    assert.equal(withoutShift, null, `hiring without a shift must stay valid: ${withoutShift}`);
  });

  await test('INSTANT-08-MALFORMED-AND-EMPTY-STILL-REFUSED', async () => {
    for (const bad of ['', 'tomorrow', '29/09/2026 11:30', '2026-09-29', '2026-09-29T11:30', 'Z']) {
      const errors = await errorsFrom(ChangeRotaSlotTimeDto, {
        startAt: bad,
        endAt: '2026-09-29T19:30:00+01:00',
      });
      assert.ok(errors, `"${bad}" must be refused`);
    }
  });

  await test('INSTANT-09-ATTENDANCE-SEMANTICS-UNCHANGED', async () => {
    // Deliberate scope limit. Attendance is not a scheduled time: the client sends no timestamp at all,
    // and `occurredAt` is stamped by the server when the event arrives. So there is nothing here to
    // tighten, and nothing this phase changes — which is exactly what this check pins.
    const accepted = await errorsFrom(RecordAttendanceDto, { shiftId: 1 });
    assert.equal(accepted, null, `a plain Book On must stay valid: ${accepted}`);

    // A client-supplied timestamp is refused by the whitelist, as it was before this phase.
    const supplied = await errorsFrom(RecordAttendanceDto, {
      shiftId: 1,
      occurredAt: '2026-09-29T11:30:00+01:00',
    });
    assert.ok(supplied, 'the device must not be able to choose when an attendance event happened');

    // Book On still carries its GPS evidence unchanged.
    const withGps = await errorsFrom(RecordAttendanceDto, {
      shiftId: 1,
      latitude: 53.7965,
      longitude: -1.5478,
      gpsAccuracyMeters: 12,
    });
    assert.equal(withGps, null, `GPS Book On must be unaffected: ${withGps}`);
  });

  // ── The conversion itself ──────────────────────────────────────────────────────────────────────

  await test('INSTANT-10-SERVER-CONVERSION-MATCHES-THE-CLIENT', async () => {
    // Same inputs, same answers as security-mobile-app/scripts/site-time.spec.cjs (TZ-01, TZ-02).
    assert.equal(siteLocalToInstant('2026-09-29', '11:30', LONDON).ok, true);
    assert.equal(utcOf(siteLocalToInstant('2026-09-29', '11:30', LONDON)), '2026-09-29T10:30:00.000Z');
    assert.equal(utcOf(siteLocalToInstant('2026-12-15', '11:30', LONDON)), '2026-12-15T11:30:00.000Z');
    assert.equal(utcOf(siteLocalToInstant('2026-09-29', '11:30', 'Asia/Dubai')), '2026-09-29T07:30:00.000Z');
  });

  await test('INSTANT-11-NO-UK-SPECIFIC-ARITHMETIC', async () => {
    // A hard-coded "+01:00", or a "subtract an hour" rule, would break one of these.
    assert.equal(offsetSuffix(zoneOffsetMs(new Date('2026-07-01T12:00:00Z'), LONDON)), '+01:00');
    assert.equal(offsetSuffix(zoneOffsetMs(new Date('2026-01-01T12:00:00Z'), LONDON)), 'Z');
    assert.equal(offsetSuffix(zoneOffsetMs(new Date('2026-07-01T12:00:00Z'), 'Asia/Kolkata')), '+05:30');
  });

  await test('INSTANT-12-SPRING-FORWARD-REJECTED', async () => {
    const resolved = siteLocalToInstant('2026-03-29', '01:30', LONDON);
    assert.equal(resolved.ok, false);
    assert.equal((resolved as { reason: string }).reason, 'nonexistent');
  });

  await test('INSTANT-13-FALL-BACK-TAKES-THE-EARLIER-OCCURRENCE', async () => {
    const resolved = siteLocalToInstant('2026-10-25', '01:30', LONDON);
    assert.equal(resolved.ok, true);
    assert.equal((resolved as { ambiguous: boolean }).ambiguous, true);
    assert.equal(utcOf(resolved), '2026-10-25T00:30:00.000Z');
    assert.equal(AMBIGUOUS_POLICY, 'earliest-occurrence');
  });

  await test('INSTANT-14-TRANSITION-NIGHTS-ARE-THEIR-REAL-LENGTH', async () => {
    const nights: Array<[string, number]> = [
      ['2026-09-29', 8], // ordinary BST night
      ['2026-12-15', 8], // ordinary GMT night
      ['2026-10-24', 9], // clocks go back
      ['2026-03-28', 7], // clocks go forward
    ];
    for (const [date, hours] of nights) {
      const start = siteLocalToInstant(date, '22:00', LONDON);
      const end = siteLocalEndToInstant(date, '22:00', '06:00', LONDON);
      const actual =
        ((end as { instant: number }).instant - (start as { instant: number }).instant) / 3600000;
      assert.equal(actual, hours, `${date} 22:00–06:00 should be ${hours} hours, got ${actual}`);
    }
  });

  await test('INSTANT-15-OFFSET-DETECTION-IS-STRICT', async () => {
    for (const value of ['2026-09-29T11:30:00Z', '2026-09-29T11:30:00+01:00', '2026-09-29T11:30:00-0400', '2026-09-29T11:30:00+05']) {
      assert.equal(hasExplicitUtcOffset(value), true, `${value} carries an offset`);
    }
    for (const value of ['2026-09-29T11:30:00', '2026-09-29T11:30:00.000', '2026-09-29', '']) {
      assert.equal(hasExplicitUtcOffset(value), false, `${value} does NOT carry an offset`);
    }
  });

  await test('INSTANT-16-DEFAULT-SITE-ZONE', async () => {
    assert.equal(DEFAULT_SITE_TIME_ZONE, 'Europe/London');
  });

  // ── Welfare monitoring, the consequence that mattered most ─────────────────────────────────────

  /** The window the guard is inside at `now`, or null when `now` falls in no window. */
  const currentWindow = (resolution: { windows: Array<{ start: Date; end: Date }> }, now: Date) =>
    resolution.windows.find(
      (window) => window.start.getTime() <= now.getTime() && now.getTime() < window.end.getTime(),
    ) ?? null;

  await test('WELFARE-TZ-01-BST-WINDOWS-ARE-LIVE-IMMEDIATELY', async () => {
    // The reported defect: an 11:30 BST shift was stored as 11:30Z, so the whole welfare grid sat an hour
    // late. Minutes into the shift the guard was inside no window at all, and the first check call did not
    // fall due until an hour after it should have.
    const shiftStart = new Date(instantOf('2026-09-29', '11:30'));
    const shiftEnd = new Date(instantOf('2026-09-29', '19:30'));
    assert.equal(shiftStart.toISOString(), '2026-09-29T10:30:00.000Z', 'the corrected instant');

    const bookOn = new Date(instantOf('2026-09-29', '11:31'));
    const now = new Date(instantOf('2026-09-29', '11:35'));

    const resolution = welfare.resolve({
      shiftStart,
      shiftEnd,
      interval: { siteWelfareCheckIntervalMinutes: 60 },
      completions: [],
      applicability: { bookOnAt: bookOn, bookOffAt: null, shiftEnd },
      now,
    });

    assert.equal(resolution.intervalMinutes, 60);
    const first = resolution.windows[0];
    const second = resolution.windows[1];
    assert.equal(first.start.toISOString(), '2026-09-29T10:30:00.000Z');
    assert.equal(first.end.toISOString(), '2026-09-29T11:30:00.000Z');
    assert.equal(second.start.toISOString(), '2026-09-29T11:30:00.000Z');
    assert.equal(second.end.toISOString(), '2026-09-29T12:30:00.000Z');

    // Five minutes into the shift the guard is inside the FIRST window, which is applicable and awaiting
    // a check. The check call falls due at 11:30 site time, one interval after the shift began.
    const current = currentWindow(resolution, now);
    assert.ok(current, 'a guard five minutes into a live shift must be inside a welfare window');
    assert.equal(current!.start.toISOString(), '2026-09-29T10:30:00.000Z');
    assert.equal(first.applicable, true, 'the live window must be applicable');
    assert.equal(first.state, OperationalWindowState.DUE);
    assert.equal(first.dueAt.toISOString(), '2026-09-29T11:30:00.000Z');
    assert.equal(second.applicable, true);
  });

  await test('WELFARE-TZ-02-THE-OLD-NAIVE-START-SHIFTED-THE-WHOLE-GRID-LATE', async () => {
    // Negative control. With the start an hour late — exactly what used to be stored — the guard is inside
    // NO window five minutes into the shift, and the first check call does not fall due until 13:30 site
    // time instead of 12:30. That is the monitoring gap the fix closes.
    const wrongStart = new Date('2026-09-29T11:30:00.000Z'); // the old stored value
    const wrongEnd = new Date('2026-09-29T19:30:00.000Z');
    const bookOn = new Date(instantOf('2026-09-29', '11:31'));
    const now = new Date(instantOf('2026-09-29', '11:35'));

    const resolution = welfare.resolve({
      shiftStart: wrongStart,
      shiftEnd: wrongEnd,
      interval: { siteWelfareCheckIntervalMinutes: 60 },
      completions: [],
      applicability: { bookOnAt: bookOn, bookOffAt: null, shiftEnd: wrongEnd },
      now,
    });

    assert.equal(
      currentWindow(resolution, now),
      null,
      'the old behaviour must still be demonstrably broken, or this suite proves nothing',
    );
    assert.equal(
      resolution.windows[0].dueAt.toISOString(),
      '2026-09-29T12:30:00.000Z',
      'the first check call used to fall due an hour late',
    );
  });

  await test('WELFARE-TZ-03-THE-SAME-HOLDS-IN-GMT', async () => {
    // In winter the offset is zero, so the naive convention happened to be right. The fix must not have
    // broken the season that already worked.
    const shiftStart = new Date(instantOf('2026-12-15', '11:30'));
    const shiftEnd = new Date(instantOf('2026-12-15', '19:30'));
    assert.equal(shiftStart.toISOString(), '2026-12-15T11:30:00.000Z');

    const resolution = welfare.resolve({
      shiftStart,
      shiftEnd,
      interval: { siteWelfareCheckIntervalMinutes: 60 },
      completions: [],
      applicability: {
        bookOnAt: new Date(instantOf('2026-12-15', '11:31')),
        bookOffAt: null,
        shiftEnd,
      },
      now: new Date(instantOf('2026-12-15', '11:35')),
    });

    assert.equal(resolution.windows[0].start.toISOString(), '2026-12-15T11:30:00.000Z');
    assert.equal(resolution.windows[0].end.toISOString(), '2026-12-15T12:30:00.000Z');
    assert.equal(resolution.windows[0].applicable, true);
    assert.equal(resolution.windows[0].state, OperationalWindowState.DUE);
  });

  await test('WELFARE-TZ-04-A-TRANSITION-NIGHT-GETS-ITS-EXTRA-WINDOW', async () => {
    // 22:00–06:00 across the night the clocks go back is nine real hours, so a 60-minute interval owes
    // nine checks, not eight. Wall-clock arithmetic would short the guard a window.
    const shiftStart = new Date(instantOf('2026-10-24', '22:00'));
    const shiftEnd = new Date(endInstantOf('2026-10-24', '22:00', '06:00'));
    assert.equal((shiftEnd.getTime() - shiftStart.getTime()) / 3600000, 9);

    const resolution = welfare.resolve({
      shiftStart,
      shiftEnd,
      interval: { siteWelfareCheckIntervalMinutes: 60 },
      completions: [],
      applicability: { bookOnAt: shiftStart, bookOffAt: null, shiftEnd },
      now: shiftEnd,
    });
    assert.equal(resolution.windows.length, 9, 'nine hours of duty owes nine welfare windows');
  });

  // ── Timesheet duration ─────────────────────────────────────────────────────────────────────────

  await test('TIMESHEET-TZ-01-NO-PHANTOM-HOUR-IN-SCHEDULED-DURATION', async () => {
    // A 2-hour shift must be 120 minutes in both seasons and across a clock change. The phantom hour used
    // to appear as scheduled-vs-actual variance that no one had worked.
    const cases: Array<[string, string, string, number]> = [
      ['2026-09-29', '11:30', '13:30', 120], // BST
      ['2026-12-15', '11:30', '13:30', 120], // GMT
      ['2026-03-28', '22:00', '06:00', 420], // clocks forward: 7 real hours
      ['2026-10-24', '22:00', '06:00', 540], // clocks back: 9 real hours
    ];
    for (const [date, start, end, minutes] of cases) {
      const actual = (endInstantOf(date, start, end) - instantOf(date, start)) / 60000;
      assert.equal(actual, minutes, `${date} ${start}–${end} should be ${minutes} min, got ${actual}`);
    }
  });

  await test('TIMESHEET-TZ-02-ONE-MINUTE-EARLY-IS-ONE-MINUTE', async () => {
    // The exact UAT report: 29 Sep 2026, London site, shift scheduled 11:30, guard taps Book On at 11:29.
    const early = (instantOf('2026-09-29', '11:30') - instantOf('2026-09-29', '11:29')) / 60000;
    assert.equal(early, 1, 'a phantom hour here is the whole defect');

    // Negative control against the value that used to be stored.
    const oldBehaviour =
      (new Date('2026-09-29T11:30:00.000Z').getTime() - instantOf('2026-09-29', '11:29')) / 60000;
    assert.equal(oldBehaviour, 61, 'the old behaviour must still be demonstrably wrong');
  });

  // ── The process clock the naive columns depend on ──────────────────────────────────────────────

  const env = (tz: string) => ({ TZ: tz }) as NodeJS.ProcessEnv;
  const now = new Date('2026-07-01T12:00:00Z');

  await test('TZ-ASSERT-01-UTC-PASSES', async () => {
    for (const name of ['UTC', 'Etc/UTC']) {
      const assertion = assertProcessTimezone(env(name), now, { timeZone: name, offsetMinutes: 0 });
      assert.equal(assertion.ok, true, `${name} must pass: ${assertion.message}`);
      assert.equal(assertion.message, '');
    }
    // And the real process, which on Render and in CI is UTC.
    const real = assertProcessTimezone();
    console.log(`      (this process: ${real.resolvedTimeZone}, offset ${real.offsetMinutes}, ok=${real.ok})`);
  });

  await test('TZ-ASSERT-02-NON-UTC-FAILS-LOUDLY', async () => {
    // Europe/London is the dangerous one: it sits at +00:00 every winter, so an offset-only check would
    // pass in January and fail in July. The zone NAME is what decides, which is why BOTH of these fail.
    const risky: Array<[string, number]> = [
      ['Europe/London', 0], // winter: zero offset, still not UTC
      ['Europe/London', 60], // summer
      ['America/New_York', -240],
      ['Asia/Kolkata', 330],
    ];
    for (const [timeZone, offsetMinutes] of risky) {
      const assertion = assertProcessTimezone(env(timeZone), now, { timeZone, offsetMinutes });
      assert.equal(assertion.ok, false, `${timeZone} (${offsetMinutes}) must fail`);
      assert.ok(assertion.message.includes('TZ=UTC'), 'the message must say what to do');
      assert.ok(
        assertion.message.includes('timestamp without time zone'),
        'the message must say why it matters',
      );
      // And it must actually stop the process, not merely report.
      assert.throws(
        () => requireUtcProcessTimezone(env(timeZone), now, { timeZone, offsetMinutes }),
        /Refusing to start/,
        `${timeZone} must refuse to boot`,
      );
    }
  });

  await test('TZ-ASSERT-03-A-ZERO-OFFSET-IS-NOT-ENOUGH', async () => {
    // The subtle failure this guards: a service left on Europe/London deploys fine in December and starts
    // corrupting instants in March, with nothing in between to notice.
    const winter = assertProcessTimezone(env('Europe/London'), new Date('2026-01-15T12:00:00Z'), {
      timeZone: 'Europe/London',
      offsetMinutes: 0,
    });
    assert.equal(winter.ok, false, 'a zero offset in a DST zone must not be mistaken for UTC');
    assert.ok(winter.message.includes('Europe/London'), 'the diagnosis must name the zone');
  });

  await test('TZ-ASSERT-04-REPORTS-THE-DIAGNOSIS', async () => {
    const assertion = assertProcessTimezone(env('UTC'), now, { timeZone: 'UTC', offsetMinutes: 0 });
    assert.equal(assertion.resolvedTimeZone, 'UTC');
    assert.equal(assertion.envTimeZone, 'UTC');
    assert.equal(assertion.offsetMinutes, 0);

    // An unset TZ is reported as unset rather than guessed at, so an operator can tell the two apart.
    const unset = assertProcessTimezone({} as NodeJS.ProcessEnv, now, {
      timeZone: 'Europe/London',
      offsetMinutes: 60,
    });
    assert.equal(unset.envTimeZone, null);
    assert.ok(unset.message.includes('TZ=unset'));
  });

  await test('TZ-ASSERT-05-BOOTSTRAP-CALLS-IT-BEFORE-LISTENING', async () => {
    // A correct assertion that nothing calls is worth nothing.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const assertAt = code.indexOf('requireUtcProcessTimezone(');
    const listenAt = code.indexOf('app.listen(');
    assert.ok(assertAt > 0, 'bootstrap must assert the process clock');
    assert.ok(listenAt > 0, 'expected app.listen in bootstrap');
    assert.ok(assertAt < listenAt, 'the assertion must run before the service starts serving');
  });

  console.log(`\n${passed} scheduled-instant contract checks passed.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
