/**
 * Control-room resolution workflow certification (real PostgreSQL).
 *
 * Migration 60 adds four nullable columns and nothing else; the Open → Acknowledged → Closed
 * lifecycle, the actors, the times and the audit trail already existed. What these tests certify is
 * that the new evidence is captured, validated against the RIGHT reason set, written to the audit
 * trail with both sides of the transition — and that none of it touches the original evidence it
 * exists to explain.
 *
 * Real services and a real database throughout: the validation lives in the service, the audit entry
 * is a row in another table, and the "resolving an alert creates no attendance" rule is a statement
 * about what is NOT in the database afterwards. None of those can be proven against a repository fake.
 *
 * Needs RESOLUTION_DATABASE_URL pointing at a DISPOSABLE database — it drops the schema.
 */
process.env.TZ = 'UTC';

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
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { Incident, IncidentSeverity, IncidentStatus } from '../src/incident/entities/incident.entity';
import {
  SafetyAlert,
  SafetyAlertPriority,
  SafetyAlertStatus,
  SafetyAlertType,
} from '../src/safety-alert/entities/safety-alert.entity';
import {
  alertRequiresResolutionNote,
  alertResolutionReasons,
  EMERGENCY_RESOLUTION_REASONS,
  INCIDENT_RESOLUTION_REASONS,
  MISSING_BOOK_OFF_RESOLUTION_REASONS,
  SITE_REQUEST_RESOLUTION_REASONS,
  WELFARE_RESOLUTION_REASONS,
} from '../src/safety-alert/resolution-reasons';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

/** Asserts the call is refused, and returns the message so the reason for refusal can be checked. */
async function refused(fn: () => Promise<unknown>, because: string): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected refusal: ${because}`);
}

const MIN = 60_000;

async function main() {
  const url = process.env.RESOLUTION_DATABASE_URL;
  if (!url) throw new Error('RESOLUTION_DATABASE_URL is required (use a disposable database)');
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
    throw new Error('resolution workflow database must be local');
  }

  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities,
    synchronize: true, dropSchema: true, logging: false,
  });
  await ds.initialize();
  const repo = <T extends object>(entity: new () => T): Repository<T> => ds.getRepository(entity);

  // ── the real services, with only their collaborators stubbed ─────────────────────────────────
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { IncidentService } = await import('../src/incident/incident.service');
  const { AuditLogService } = await import('../src/audit-log/audit-log.service');

  let seq = 0;
  const tenantUser = await repo(User).save(repo(User).create({
    email: `res.${(seq += 1)}@example.invalid`, passwordHash: 'x',
    role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE,
  }));
  const company = await repo(Company).save(repo(Company).create({
    user: tenantUser, name: 'Resolution Security Ltd', companyNumber: String(30000000 + seq),
    address: '1 Test Street', contactDetails: 'ops@res.example.invalid',
  }));
  const site = await repo(Site).save(repo(Site).create({
    company, name: 'TEST SITE', address: '2 Test Street',
    welfareCheckIntervalMinutes: 60, timezone: 'Europe/London',
  }));
  const guardUser = await repo(User).save(repo(User).create({
    email: `res.g.${(seq += 1)}@example.invalid`, passwordHash: 'x',
    role: UserRole.GUARD, status: UserStatus.ACTIVE,
  }));
  const guard = await repo(GuardProfile).save(repo(GuardProfile).create({
    user: guardUser, fullName: 'Fahad test',
    siaLicenseNumber: String(6200000000000000 + seq), phone: '07700000000',
  }));

  // The membership service is only consulted by the audit service's own READ paths; `log()` writes
  // the row directly, which is all these tests exercise.
  const auditLogService = new AuditLogService(repo(AuditLog), {} as never);
  const companyServiceStub = { findByUserId: async () => company } as never;

  // The welfare sweep is exercised for real by the Missing Book Off cases, so its engine, its window
  // service and its repositories are the real ones. Only the notification sink is a stub — what it
  // sends is W2/W3's subject, not this phase's.
  const { WelfareWindowService } = await import('../src/operations/welfare-window.service');
  const { OperationalWindowService } = await import('../src/operations/operational-window.service');
  const { DailyLog } = await import('../src/daily-log/entities/daily-log.entity');
  const windowEngine = new OperationalWindowService();
  const notificationStub = {
    createForUser: async () => undefined,
    createForUserUnlessRecentDuplicate: async () => undefined,
  } as never;

  const alertService = new SafetyAlertService(
    repo(SafetyAlert), repo(DailyLog), repo(AttendanceEvent), repo(Shift),
    {} as never, {} as never, companyServiceStub, auditLogService,
    notificationStub, new WelfareWindowService(windowEngine), windowEngine, ds,
  );
  // The sweep timer belongs to the running application, not to a test process.
  alertService.onModuleDestroy();

  const incidentService = new IncidentService(
    repo(Incident), {} as never, {} as never,
    { resolveCompanyContext: async () => ({ company }) } as never,
    auditLogService, {} as never,
  );

  const ACTOR = tenantUser.id;

  const makeShift = async (opts: { endsInMins: number; bookOnMinsAgo?: number | null }) => {
    const end = new Date(Date.now() + opts.endsInMins * MIN);
    const shift = await repo(Shift).save(repo(Shift).create({
      company, guard, site, siteName: site.name,
      start: new Date(end.getTime() - 60 * MIN), end,
      status: 'in_progress', checkCallIntervalMinutes: 60,
    }));
    if (opts.bookOnMinsAgo != null) {
      await repo(AttendanceEvent).save(repo(AttendanceEvent).create({
        shift, guard, type: AttendanceEventType.CHECK_IN,
        occurredAt: new Date(Date.now() - opts.bookOnMinsAgo * MIN),
      }));
    }
    return shift;
  };

  const makeAlert = async (type: SafetyAlertType, shift?: Shift, message = 'Original alert text') =>
    repo(SafetyAlert).save(repo(SafetyAlert).create({
      company, guard, shift: shift ?? null, type,
      priority: type === SafetyAlertType.PANIC ? SafetyAlertPriority.CRITICAL : SafetyAlertPriority.MEDIUM,
      status: SafetyAlertStatus.OPEN, message,
    }));

  const auditFor = (entityType: string, entityId: number) =>
    repo(AuditLog).find({ where: { entityType, entityId }, order: { id: 'ASC' } });

  // ═══════════════════ lifecycle ═══════════════════

  await test('LIFE-01-OPEN-TO-ACKNOWLEDGED-KEEPS-ACTOR-AND-TIME', async () => {
    const alert = await makeAlert(SafetyAlertType.MISSED_CHECKCALL);
    const acked = await alertService.acknowledgeForCompany(ACTOR, alert.id);

    assert.equal(acked.status, SafetyAlertStatus.ACKNOWLEDGED);
    assert.ok(acked.acknowledgedAt instanceof Date, 'acknowledged time recorded');
    assert.equal(acked.acknowledgedByUserId, ACTOR, 'acknowledging actor recorded');
    assert.equal(acked.closedAt ?? null, null, 'and it is not closed');
    assert.equal(acked.resolutionReason ?? null, null, 'acknowledging states no reason');
  });

  await test('LIFE-02-ACKNOWLEDGED-TO-CLOSED-RETAINS-BOTH-ACTORS', async () => {
    const alert = await makeAlert(SafetyAlertType.MISSED_CHECKCALL);
    const acked = await alertService.acknowledgeForCompany(ACTOR, alert.id);
    const ackTime = acked.acknowledgedAt!;

    const closed = await alertService.closeForCompany(ACTOR, alert.id, {
      resolutionReason: 'guard_confirmed_safe',
      resolutionNote: 'Called the guard, confirmed safe at the gatehouse.',
    });

    assert.equal(closed.status, SafetyAlertStatus.CLOSED);
    assert.equal(closed.acknowledgedAt!.getTime(), ackTime.getTime(), 'the original acknowledgement is kept');
    assert.equal(closed.acknowledgedByUserId, ACTOR);
    assert.ok(closed.closedAt instanceof Date, 'closing time recorded');
    assert.equal(closed.closedByUserId, ACTOR, 'closing actor recorded');
  });

  await test('LIFE-03-OPEN-STRAIGHT-TO-CLOSED-BACKFILLS-ACKNOWLEDGEMENT', async () => {
    // Permitted: a controller who resolves something on sight has, by definition, seen it.
    const alert = await makeAlert(SafetyAlertType.MISSED_CHECKCALL);
    const closed = await alertService.closeForCompany(ACTOR, alert.id, {
      resolutionReason: 'false_duplicate',
      resolutionNote: 'Duplicate of the alert raised two minutes earlier.',
    });

    assert.equal(closed.status, SafetyAlertStatus.CLOSED);
    assert.ok(closed.acknowledgedAt, 'acknowledgement is not left blank');
    assert.equal(closed.acknowledgedByUserId, ACTOR);
  });

  await test('LIFE-04-CLOSED-LEAVES-THE-QUEUE-AND-STAYS-IN-THE-REGISTER', async () => {
    const alert = await makeAlert(SafetyAlertType.MISSED_CHECKCALL);
    await alertService.closeForCompany(ACTOR, alert.id, {
      resolutionReason: 'guard_confirmed_safe',
      resolutionNote: 'Guard answered on the second attempt.',
    });

    const outstanding = (await alertService.findForCompany(ACTOR))
      .filter((a) => a.status !== SafetyAlertStatus.CLOSED);
    assert.ok(!outstanding.some((a) => a.id === alert.id), 'gone from the outstanding queue');

    const register = await alertService.findForCompany(ACTOR);
    const kept = register.find((a) => a.id === alert.id);
    assert.ok(kept, 'still in the historical register');
    assert.equal(kept!.message, 'Original alert text', 'with its original text intact');
    assert.equal(kept!.resolutionReason, 'guard_confirmed_safe');
  });

  // ═══════════════════ resolution evidence ═══════════════════

  await test('EVID-01-REASON-AND-NOTE-ARE-PERSISTED', async () => {
    const alert = await makeAlert(SafetyAlertType.MISSED_CHECKCALL);
    await alertService.closeForCompany(ACTOR, alert.id, {
      resolutionReason: 'network_signal_issue',
      resolutionNote: 'No signal in the basement; guard checked in on return to ground floor.',
    });

    const stored = await repo(SafetyAlert).findOneByOrFail({ id: alert.id });
    assert.equal(stored.resolutionReason, 'network_signal_issue');
    assert.equal(
      stored.resolutionNote,
      'No signal in the basement; guard checked in on return to ground floor.',
    );
  });

  await test('EVID-02-ORIGINAL-EVIDENCE-IS-NEVER-OVERWRITTEN', async () => {
    const alert = await makeAlert(SafetyAlertType.MISSED_CHECKCALL, undefined, 'Welfare Check missed at 21:05.');
    await alertService.closeForCompany(ACTOR, alert.id, {
      resolutionReason: 'guard_missed_check',
      resolutionNote: 'Guard apologised; briefed on the schedule.',
    });

    const stored = await repo(SafetyAlert).findOneByOrFail({ id: alert.id });
    assert.equal(stored.message, 'Welfare Check missed at 21:05.', 'the alert as raised is untouched');
    assert.equal(stored.createdAt.getTime(), alert.createdAt.getTime(), 'and so is when it was raised');
  });

  await test('EVID-03-A-REFUSED-RESOLUTION-CHANGES-NOTHING', async () => {
    const alert = await makeAlert(SafetyAlertType.MISSED_CHECKCALL);
    await refused(
      () => alertService.closeForCompany(ACTOR, alert.id, { resolutionReason: 'other' }),
      'other without a note',
    );

    const stored = await repo(SafetyAlert).findOneByOrFail({ id: alert.id });
    assert.equal(stored.status, SafetyAlertStatus.OPEN, 'still open');
    assert.equal(stored.closedAt ?? null, null, 'and still in the queue');
  });

  // ═══════════════════ the reason sets are per type ═══════════════════

  await test('REASON-01-A-WRONG-FAMILY-REASON-IS-REFUSED', async () => {
    const bookOff = await makeAlert(SafetyAlertType.MISSING_BOOK_OFF);
    const message = await refused(
      () => alertService.closeForCompany(ACTOR, bookOff.id, {
        resolutionReason: 'network_signal_issue',
        resolutionNote: 'should not be accepted',
      }),
      'a welfare reason on a Missing Book Off',
    );
    assert.match(message, /not a resolution reason for a missing_book_off alert/);

    const welfare = await makeAlert(SafetyAlertType.MISSED_CHECKCALL);
    await refused(
      () => alertService.closeForCompany(ACTOR, welfare.id, {
        resolutionReason: 'shift_extended',
        resolutionNote: 'should not be accepted',
      }),
      'a Book Off reason on a Welfare Check',
    );
  });

  await test('REASON-02-EACH-TYPE-OFFERS-ITS-OWN-SET', async () => {
    assert.deepEqual(alertResolutionReasons(SafetyAlertType.MISSED_CHECKCALL), WELFARE_RESOLUTION_REASONS);
    assert.deepEqual(alertResolutionReasons(SafetyAlertType.CHECK_CALL), WELFARE_RESOLUTION_REASONS);
    assert.deepEqual(alertResolutionReasons(SafetyAlertType.MISSING_BOOK_OFF), MISSING_BOOK_OFF_RESOLUTION_REASONS);
    assert.deepEqual(alertResolutionReasons(SafetyAlertType.SITE_REQUEST), SITE_REQUEST_RESOLUTION_REASONS);
    // `welfare` is the historical Site Request label and must resolve from the same set.
    assert.deepEqual(alertResolutionReasons(SafetyAlertType.WELFARE), SITE_REQUEST_RESOLUTION_REASONS);
    assert.deepEqual(alertResolutionReasons(SafetyAlertType.PANIC), EMERGENCY_RESOLUTION_REASONS);
  });

  await test('REASON-03-THE-DIALOG-IS-SERVED-THE-SAME-SET-THE-API-ENFORCES', async () => {
    const panic = await makeAlert(SafetyAlertType.PANIC);
    const options = await alertService.resolutionOptions(ACTOR, panic.id, false);

    assert.equal(options.type, SafetyAlertType.PANIC);
    assert.deepEqual(options.reasons.map((r) => r.value), [...EMERGENCY_RESOLUTION_REASONS]);
    assert.ok(options.reasons.every((r) => r.noteRequired), 'every emergency reason needs words');
  });

  // ═══════════════════ note policy ═══════════════════

  await test('NOTE-01-OTHER-ALWAYS-REQUIRES-A-NOTE', async () => {
    for (const type of [
      SafetyAlertType.MISSED_CHECKCALL,
      SafetyAlertType.MISSING_BOOK_OFF,
      SafetyAlertType.SITE_REQUEST,
      SafetyAlertType.OTHER,
    ]) {
      assert.equal(alertRequiresResolutionNote(type, 'other'), true, `${type} + other`);
      const alert = await makeAlert(type);
      const message = await refused(
        () => alertService.closeForCompany(ACTOR, alert.id, { resolutionReason: 'other' }),
        `${type} closed as other with no note`,
      );
      assert.match(message, /note is required/i);
    }
  });

  await test('NOTE-02-WHITESPACE-IS-NOT-A-NOTE', async () => {
    const alert = await makeAlert(SafetyAlertType.MISSED_CHECKCALL);
    await refused(
      () => alertService.closeForCompany(ACTOR, alert.id, {
        resolutionReason: 'guard_confirmed_safe',
        resolutionNote: '   \n\t  ',
      }),
      'a note of whitespace',
    );

    const stored = await repo(SafetyAlert).findOneByOrFail({ id: alert.id });
    assert.equal(stored.status, SafetyAlertStatus.OPEN);
  });

  await test('NOTE-03-EVERY-SAFETY-TYPE-REQUIRES-A-NOTE-EXCEPT-SITE-REQUEST', async () => {
    assert.equal(alertRequiresResolutionNote(SafetyAlertType.MISSED_CHECKCALL, 'guard_confirmed_safe'), true);
    assert.equal(alertRequiresResolutionNote(SafetyAlertType.MISSING_BOOK_OFF, 'shift_extended'), true);
    assert.equal(alertRequiresResolutionNote(SafetyAlertType.PANIC, 'guard_confirmed_safe'), true);
    assert.equal(alertRequiresResolutionNote(SafetyAlertType.SITE_REQUEST, 'request_completed'), false);
    assert.equal(alertRequiresResolutionNote(SafetyAlertType.WELFARE, 'request_completed'), false);

    const request = await makeAlert(SafetyAlertType.SITE_REQUEST);
    const closed = await alertService.closeForCompany(ACTOR, request.id, {
      resolutionReason: 'request_completed',
    });
    assert.equal(closed.status, SafetyAlertStatus.CLOSED, 'a site request closes without a note');
    assert.equal(closed.resolutionNote ?? null, null);
  });

  await test('NOTE-04-EMERGENCY-CANNOT-BE-CLOSED-SILENTLY', async () => {
    const panic = await makeAlert(SafetyAlertType.PANIC);

    await refused(() => alertService.closeForCompany(ACTOR, panic.id, {}), 'no reason at all');
    await refused(
      () => alertService.closeForCompany(ACTOR, panic.id, { resolutionReason: 'guard_confirmed_safe' }),
      'a reason with no note',
    );

    const closed = await alertService.closeForCompany(ACTOR, panic.id, {
      resolutionReason: 'guard_confirmed_safe',
      resolutionNote: 'Spoke to the guard; accidental press, no incident.',
    });
    assert.equal(closed.status, SafetyAlertStatus.CLOSED);
    assert.equal(closed.priority, SafetyAlertPriority.CRITICAL, 'the critical record is preserved as raised');
  });

  // ═══════════════════ audit ═══════════════════

  await test('AUDIT-01-THE-TRANSITION-IS-FULLY-RECORDED', async () => {
    const alert = await makeAlert(SafetyAlertType.MISSED_CHECKCALL);
    await alertService.acknowledgeForCompany(ACTOR, alert.id);
    await alertService.closeForCompany(ACTOR, alert.id, {
      resolutionReason: 'control_contacted_guard',
      resolutionNote: 'Control called the guard, who confirmed the site was secure.',
    });

    const entries = await auditFor('safety_alert', alert.id);
    const ack = entries.find((e) => e.action === 'safety_alert.acknowledged');
    const closed = entries.find((e) => e.action === 'safety_alert.closed');

    assert.ok(ack && closed, 'both transitions are audited');

    // Previous status — the gap this phase closed. The alert path recorded only the outcome before.
    assert.equal((ack!.beforeData as Record<string, unknown>).status, SafetyAlertStatus.OPEN);
    assert.equal((closed!.beforeData as Record<string, unknown>).status, SafetyAlertStatus.ACKNOWLEDGED);

    const after = closed!.afterData as Record<string, unknown>;
    assert.equal(after.status, SafetyAlertStatus.CLOSED, 'new status');
    assert.equal(after.type, SafetyAlertType.MISSED_CHECKCALL, 'type');
    assert.equal(after.resolutionReason, 'control_contacted_guard', 'reason');
    assert.equal(
      after.resolutionNote,
      'Control called the guard, who confirmed the site was secure.',
      'note',
    );
    assert.equal(closed!.entityId, alert.id, 'entity id');
    assert.equal(closed!.user?.id, ACTOR, 'actor');
    assert.ok(closed!.createdAt instanceof Date, 'timestamp');
  });

  // ═══════════════════ missing Book Off ═══════════════════

  await test('BOOKOFF-01-RAISED-ONLY-AFTER-THE-EXISTING-GRACE', async () => {
    // Inside the 15-minute grace a Book Off is late, not missing.
    const young = await makeShift({ endsInMins: -10, bookOnMinsAgo: 70 });
    await alertService.runMissedWelfareChecks();
    const none = await repo(SafetyAlert).find({
      where: { shift: { id: young.id }, type: SafetyAlertType.MISSING_BOOK_OFF },
    });
    assert.equal(none.length, 0, 'nothing raised inside the grace');

    const overdue = await makeShift({ endsInMins: -20, bookOnMinsAgo: 80 });
    await alertService.runMissedWelfareChecks();
    const raised = await repo(SafetyAlert).find({
      where: { shift: { id: overdue.id }, type: SafetyAlertType.MISSING_BOOK_OFF },
    });
    assert.equal(raised.length, 1, 'raised once the grace has passed');
  });

  await test('BOOKOFF-02-NEVER-DUPLICATED', async () => {
    const shift = await makeShift({ endsInMins: -40, bookOnMinsAgo: 100 });
    await alertService.runMissedWelfareChecks();
    await alertService.runMissedWelfareChecks();
    await alertService.runMissedWelfareChecks();

    const alerts = await repo(SafetyAlert).find({
      where: { shift: { id: shift.id }, type: SafetyAlertType.MISSING_BOOK_OFF },
    });
    assert.equal(alerts.length, 1, 'the partial unique index holds across repeated sweeps');
  });

  await test('BOOKOFF-03-RESOLVING-THE-ALERT-CREATES-NO-ATTENDANCE', async () => {
    // THE rule for this item. Closing the alert is an admin act about the ALERT; it must never put a
    // Book Off into the attendance record, which is evidence of what the guard actually did.
    const shift = await makeShift({ endsInMins: -30, bookOnMinsAgo: 90 });
    await alertService.runMissedWelfareChecks();
    const alert = (await repo(SafetyAlert).findOneOrFail({
      where: { shift: { id: shift.id }, type: SafetyAlertType.MISSING_BOOK_OFF },
    }));

    const before = await repo(AttendanceEvent).find({ where: { shift: { id: shift.id } } });
    const shiftBefore = await repo(Shift).findOneByOrFail({ id: shift.id });

    await alertService.closeForCompany(ACTOR, alert.id, {
      resolutionReason: 'guard_confirmed_off_site',
      resolutionNote: 'Guard confirmed by phone that they left at 21:40.',
    });

    const after = await repo(AttendanceEvent).find({ where: { shift: { id: shift.id } } });
    assert.equal(after.length, before.length, 'no attendance event was created');
    assert.equal(
      after.filter((e) => e.type === AttendanceEventType.CHECK_OUT).length, 0,
      'and certainly no Book Off',
    );

    const shiftAfter = await repo(Shift).findOneByOrFail({ id: shift.id });
    assert.equal(shiftAfter.end.getTime(), shiftBefore.end.getTime(), 'the shift end is unchanged');
    assert.equal(shiftAfter.status, shiftBefore.status, 'and so is its status');
  });

  await test('BOOKOFF-04-A-REAL-LATE-BOOK-OFF-STILL-CLOSES-IT-AUTOMATICALLY', async () => {
    const shift = await makeShift({ endsInMins: -30, bookOnMinsAgo: 90 });
    await alertService.runMissedWelfareChecks();
    const alert = await repo(SafetyAlert).findOneOrFail({
      where: { shift: { id: shift.id }, type: SafetyAlertType.MISSING_BOOK_OFF },
    });
    assert.equal(alert.status, SafetyAlertStatus.OPEN);

    await repo(AttendanceEvent).save(repo(AttendanceEvent).create({
      shift, guard, type: AttendanceEventType.CHECK_OUT, occurredAt: new Date(),
    }));
    await alertService.runMissedWelfareChecks();

    const closed = await repo(SafetyAlert).findOneByOrFail({ id: alert.id });
    assert.equal(closed.status, SafetyAlertStatus.CLOSED, 'the system closed it');
    assert.ok(closed.closedAt, 'with a closing time');
    // The automatic path forms no view about why, so it records none — rather than inventing one.
    assert.equal(closed.resolutionReason ?? null, null, 'and claims no resolution reason');
    assert.equal(closed.createdAt.getTime(), alert.createdAt.getTime(), 'history preserved');
  });

  // ═══════════════════ incidents ═══════════════════

  const makeIncident = async () => repo(Incident).save(repo(Incident).create({
    company, guard, shift: null, site,
    title: 'Broken window, north side', notes: 'Guard reported glass on the ground at 20:55.',
    severity: IncidentSeverity.MEDIUM, status: IncidentStatus.OPEN, reportedAt: new Date(),
  }));

  await test('INC-01-THE-DISCARDED-NOTE-BUG-IS-FIXED', async () => {
    // Before this phase `UpdateIncidentStatusDto.notes` was accepted by the API and dropped on the
    // floor by applyStatusUpdate. The note now reaches the database — in its own column.
    const incident = await makeIncident();
    const resolved = await incidentService.updateStatusForCompany(
      ACTOR, UserRole.COMPANY_ADMIN, incident.id, IncidentStatus.RESOLVED,
      { resolutionReason: 'maintenance_arranged', resolutionNote: 'Glazier booked for 08:00.' },
    );

    assert.equal(resolved.resolutionReason, 'maintenance_arranged');
    assert.equal(resolved.resolutionNote, 'Glazier booked for 08:00.');

    const stored = await repo(Incident).findOneByOrFail({ id: incident.id });
    assert.equal(stored.resolutionNote, 'Glazier booked for 08:00.', 'persisted, not discarded');
    assert.equal(
      stored.notes, 'Guard reported glass on the ground at 20:55.',
      'and the guard\'s own report is untouched',
    );
  });

  await test('INC-02-RESOLUTION-REQUIRES-A-REASON-AND-A-NOTE', async () => {
    const incident = await makeIncident();
    await refused(
      () => incidentService.updateStatusForCompany(
        ACTOR, UserRole.COMPANY_ADMIN, incident.id, IncidentStatus.RESOLVED,
        { resolutionReason: 'false_alarm' },
      ),
      'a reason with no note',
    );
    await refused(
      () => incidentService.updateStatusForCompany(
        ACTOR, UserRole.COMPANY_ADMIN, incident.id, IncidentStatus.RESOLVED,
        { resolutionNote: 'no reason given' },
      ),
      'a note with no reason',
    );
    await refused(
      () => incidentService.updateStatusForCompany(
        ACTOR, UserRole.COMPANY_ADMIN, incident.id, IncidentStatus.RESOLVED,
        { resolutionReason: 'shift_extended', resolutionNote: 'wrong family' },
      ),
      'a Book Off reason on an incident',
    );

    const stored = await repo(Incident).findOneByOrFail({ id: incident.id });
    assert.equal(stored.status, IncidentStatus.OPEN, 'none of it changed the incident');
  });

  await test('INC-03-MOVING-TO-IN-REVIEW-NEEDS-NO-RESOLUTION', async () => {
    // Picking an incident up is not resolving it, and must not demand an explanation for one.
    const incident = await makeIncident();
    const reviewing = await incidentService.updateStatusForCompany(
      ACTOR, UserRole.COMPANY_ADMIN, incident.id, IncidentStatus.IN_REVIEW,
    );
    assert.equal(reviewing.status, IncidentStatus.IN_REVIEW);
    assert.ok(reviewing.reviewedAt, 'the reviewing actor and time are still recorded');
    assert.equal(reviewing.reviewedByUserId, ACTOR);
  });

  await test('INC-04-THE-INCIDENT-TRANSITION-IS-AUDITED-WITH-BOTH-SIDES', async () => {
    const incident = await makeIncident();
    await incidentService.updateStatusForCompany(
      ACTOR, UserRole.COMPANY_ADMIN, incident.id, IncidentStatus.RESOLVED,
      { resolutionReason: 'resolved_on_site', resolutionNote: 'Window boarded by the guard.' },
    );

    const entry = (await auditFor('incident', incident.id))
      .find((e) => e.action === 'incident.status_updated');
    assert.ok(entry, 'the transition is audited');
    assert.equal((entry!.beforeData as Record<string, unknown>).status, IncidentStatus.OPEN);
    const after = entry!.afterData as Record<string, unknown>;
    assert.equal(after.status, IncidentStatus.RESOLVED);
    assert.equal(after.resolutionReason, 'resolved_on_site');
    assert.equal(after.resolutionNote, 'Window boarded by the guard.');
    assert.equal(entry!.user?.id, ACTOR);
  });

  await test('INC-05-RESOLVED-INCIDENTS-ARE-NEVER-DELETED', async () => {
    const incident = await makeIncident();
    await incidentService.updateStatusForCompany(
      ACTOR, UserRole.COMPANY_ADMIN, incident.id, IncidentStatus.RESOLVED,
      { resolutionReason: 'false_alarm', resolutionNote: 'Nothing found on inspection.' },
    );

    const register = await incidentService.findForCompany(ACTOR, UserRole.COMPANY_ADMIN);
    const kept = register.find((i) => i.id === incident.id);
    assert.ok(kept, 'still in the incident register');
    assert.equal(kept!.resolutionReason, 'false_alarm');
    assert.equal(kept!.title, 'Broken window, north side', 'with its original record intact');
  });

  await test('INC-06-THE-REASON-SETS-DO-NOT-OVERLAP-WRONGLY', async () => {
    // One union would let an incident take a Book-Off-only reason. These are the guards against that.
    assert.ok(!INCIDENT_RESOLUTION_REASONS.includes('shift_extended' as never));
    assert.ok(!INCIDENT_RESOLUTION_REASONS.includes('network_signal_issue' as never));
    assert.ok(!MISSING_BOOK_OFF_RESOLUTION_REASONS.includes('guard_confirmed_safe' as never));
    assert.ok(!WELFARE_RESOLUTION_REASONS.includes('shift_extended' as never));
    assert.ok(!EMERGENCY_RESOLUTION_REASONS.includes('other' as never),
      'emergency has no catch-all that could be clicked through');
  });

  // ═══════════════════ legacy compatibility ═══════════════════

  await test('LEGACY-01-CHECK-CALL-ROWS-STILL-RESOLVE', async () => {
    // Historical rows carry `check_call`; Phase 3C renamed the surface, not the stored label.
    const legacy = await makeAlert(SafetyAlertType.CHECK_CALL, undefined, 'Check call missed at 03:00.');
    const closed = await alertService.closeForCompany(ACTOR, legacy.id, {
      resolutionReason: 'guard_confirmed_safe',
      resolutionNote: 'Reviewed historically; guard logged a check two minutes later.',
    });

    assert.equal(closed.status, SafetyAlertStatus.CLOSED);
    assert.equal(closed.type, SafetyAlertType.CHECK_CALL, 'the stored enum is not rewritten');
    assert.equal(closed.message, 'Check call missed at 03:00.', 'nor is the historical text');
  });

  await test('LEGACY-02-HISTORICAL-ROWS-READ-BACK-WITH-NULL-EVIDENCE', async () => {
    const alert = await makeAlert(SafetyAlertType.MISSED_CHECKCALL);
    await repo(SafetyAlert).update(alert.id, {
      status: SafetyAlertStatus.CLOSED, closedAt: new Date(), closedByUserId: ACTOR,
    });

    const stored = await repo(SafetyAlert).findOneByOrFail({ id: alert.id });
    assert.equal(stored.resolutionReason ?? null, null, 'closed before the columns existed');
    assert.equal(stored.resolutionNote ?? null, null);
    assert.equal(stored.status, SafetyAlertStatus.CLOSED, 'and still reads as closed');
  });

  await ds.destroy();
  console.log(`\n══ CONTROL-ROOM RESOLUTION WORKFLOW: ${passed} PASS / 0 FAIL ══`);
  console.log(JSON.stringify({ event: 'resolution_workflow_certified', tests: passed }));
}

main().catch((error) => {
  console.error('FAIL ', error?.message || error);
  process.exit(1);
});
