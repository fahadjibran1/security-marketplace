/**
 * S4 Live Operations Phase 4: Close without Book Off (real PostgreSQL).
 *
 * A Guard booked on and never booked off. A company shift manager — never the system — closes the shift
 * with a stated reason. One transaction moves it to completed, closes its open Missing Book Off and Welfare
 * summary, and writes the audit trail. Nothing is fabricated: no Book Off event, no departure time, no
 * timesheet, no rewritten attendance, no deleted alert.
 *
 * Needs SHIFT_RECONCILIATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Company } from '../src/company/entities/company.entity';
import { Site } from '../src/site/entities/site.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { Timesheet } from '../src/timesheet/entities/timesheet.entity';
import { AttendanceEvent, AttendanceEventType } from '../src/attendance/entities/attendance.entity';
import { DailyLog } from '../src/daily-log/entities/daily-log.entity';
import { SafetyAlert, SafetyAlertStatus, SafetyAlertType } from '../src/safety-alert/entities/safety-alert.entity';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { CompanyMembership } from '../src/company-membership/entities/company-membership.entity';
import { CompanyMembershipRole, CompanyMembershipStatus, CompanyPermission, hasPermission } from '../src/company-membership/company-membership-types';
import { CompanyMembershipService } from '../src/company-membership/company-membership.service';
import { ShiftReconciliationService } from '../src/shift/shift-reconciliation.service';
import { ReconcileShiftDto } from '../src/shift/dto/reconcile-shift.dto';
import { ShiftController } from '../src/shift/shift.controller';
import { SafetyAlertService } from '../src/safety-alert/safety-alert.service';
import { OperationalWindowService } from '../src/operations/operational-window.service';
import { WelfareWindowService } from '../src/operations/welfare-window.service';
import { AttendanceService } from '../src/attendance/attendance.service';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { JwtPayload } from '../src/auth/types/jwt-payload.type';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

const MIN = 60_000;
const HOUR = 60 * MIN;

async function rejects(promise: Promise<unknown>, type: new (...args: any[]) => Error, pattern?: RegExp) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof type, `expected ${type.name}, got ${(error as Error)?.constructor?.name}: ${(error as Error)?.message}`);
    if (pattern) assert.match((error as Error).message, pattern);
    return;
  }
  assert.fail(`expected ${type.name}, but it resolved`);
}

async function main() {
  const url = process.env.SHIFT_RECONCILIATION_DATABASE_URL;
  if (!url) throw new Error('SHIFT_RECONCILIATION_DATABASE_URL is required (use a disposable database)');
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('database must be local');

  const ds = new DataSource({ type: 'postgres', url, entities: appEntities, synchronize: true, dropSchema: true, logging: false });
  await ds.initialize();
  const repo = <T extends object>(entity: new () => T): Repository<T> => ds.getRepository(entity);

  const membershipService = new CompanyMembershipService(repo(CompanyMembership), { findByUserId: async () => null } as never);
  const auditLogService = new AuditLogService(repo(AuditLog), membershipService);
  const service = new ShiftReconciliationService(ds, membershipService, auditLogService);

  // ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  const makeUser = (role: UserRole) => repo(User).save(repo(User).create({
    email: `u${(seq += 1)}@example.invalid`, passwordHash: 'not-a-real-hash', role, status: UserStatus.ACTIVE,
  }));
  const member = async (company: Company, role: CompanyMembershipRole, userRole = UserRole.COMPANY_STAFF) => {
    const user = await makeUser(userRole);
    await repo(CompanyMembership).save(repo(CompanyMembership).create({
      user, company, membershipRole: role, status: CompanyMembershipStatus.ACTIVE, invitedByUserId: null,
    }));
    return { sub: user.id, role: userRole, email: user.email } as unknown as JwtPayload;
  };
  const makeCompany = async (label: string) => {
    const ownerUser = await makeUser(UserRole.COMPANY_ADMIN);
    const company = await repo(Company).save(repo(Company).create({
      user: ownerUser, name: `${label} Ltd`, companyNumber: String(20000000 + (seq += 1)), address: '1 Street', contactDetails: 'x',
    }));
    await repo(CompanyMembership).save(repo(CompanyMembership).create({
      user: ownerUser, company, membershipRole: CompanyMembershipRole.OWNER, status: CompanyMembershipStatus.ACTIVE, invitedByUserId: null,
    }));
    const site = await repo(Site).save(repo(Site).create({ company, name: `${label} Site`, address: '2 Street', timezone: 'Europe/London', welfareCheckIntervalMinutes: 60 }));
    const guardUser = await makeUser(UserRole.GUARD);
    const guard = await repo(GuardProfile).save(repo(GuardProfile).create({
      user: guardUser, fullName: `${label} Guard`, siaLicenseNumber: String(7000000000000000 + (seq += 1)), phone: '07700000000',
    }));
    const owner = { sub: ownerUser.id, role: UserRole.COMPANY_ADMIN, email: ownerUser.email } as unknown as JwtPayload;
    return { company, site, guard, guardUser, owner };
  };
  const A = await makeCompany('alpha');
  const B = await makeCompany('bravo');

  /** A worked shift: Book On at its start, no Book Off, scheduled end `endedMinsAgo` minutes ago. */
  const workedShift = async (opts: { tenant?: typeof A; endedMinsAgo: number; status?: string; bookOn?: boolean; bookOff?: boolean }) => {
    const t = opts.tenant ?? A;
    const end = Date.now() - opts.endedMinsAgo * MIN;
    const start = end - 8 * HOUR;
    const shift = await repo(Shift).save(repo(Shift).create({
      company: t.company, guard: t.guard, site: t.site, siteName: t.site.name,
      start: new Date(start), end: new Date(end), status: opts.status ?? 'in_progress', checkCallIntervalMinutes: 60,
    }));
    if (opts.bookOn !== false) {
      await repo(AttendanceEvent).save(repo(AttendanceEvent).create({ shift, guard: t.guard, type: AttendanceEventType.CHECK_IN, occurredAt: new Date(start + 2 * MIN) }));
    }
    if (opts.bookOff) {
      await repo(AttendanceEvent).save(repo(AttendanceEvent).create({ shift, guard: t.guard, type: AttendanceEventType.CHECK_OUT, occurredAt: new Date(end) }));
    }
    return shift;
  };
  const alert = (shift: Shift, t: typeof A, type: SafetyAlertType, status: SafetyAlertStatus, welfareWindowIndex: number | null = null) =>
    repo(SafetyAlert).save(repo(SafetyAlert).create({
      company: t.company, guard: t.guard, shift, type, status, welfareWindowIndex, priority: 'high' as never, message: 'fixture',
      closedAt: status === SafetyAlertStatus.CLOSED ? new Date() : null,
    }));
  const shiftStatus = async (id: number) => (await repo(Shift).findOneByOrFail({ id })).status;
  // The alert's own columns, without eager relations (whose shift status legitimately changes).
  const alertRow = (id: number) => repo(SafetyAlert).findOneOrFail({ where: { id }, loadEagerRelations: false });
  const events = (shiftId: number) => repo(AttendanceEvent).find({ where: { shift: { id: shiftId } }, order: { id: 'ASC' }, loadEagerRelations: false });
  const audits = (action: string, entityId: number) => repo(AuditLog).find({ where: { action, entityId }, order: { id: 'ASC' }, loadEagerRelations: false });
  const timesheets = async (shiftId: number) => Number((await ds.query('SELECT count(*)::int AS n FROM timesheets WHERE "shiftId" = $1', [shiftId]))[0].n);

  try {
    // ═══════════════════ the action ═══════════════════

    await test('RECON-01-CLOSES-THE-SHIFT-AND-ITS-BOOK-OFF-AND-WELFARE-ALERTS-ONLY', async () => {
      const shift = await workedShift({ endedMinsAgo: 120 });
      const mbo = await alert(shift, A, SafetyAlertType.MISSING_BOOK_OFF, SafetyAlertStatus.OPEN);
      const summary = await alert(shift, A, SafetyAlertType.MISSED_CHECKCALL, SafetyAlertStatus.ACKNOWLEDGED);
      const evidence = await alert(shift, A, SafetyAlertType.MISSED_CHECKCALL, SafetyAlertStatus.CLOSED, 3);
      const panic = await alert(shift, A, SafetyAlertType.PANIC, SafetyAlertStatus.OPEN);
      const eventsBefore = await events(shift.id);
      const evidenceBefore = await alertRow(evidence.id);

      const result = await service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'guard_forgot_book_off', note: 'Phoned guard, off site 06:10' });
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.closedAlertIds.sort(), [mbo.id, summary.id].sort());
      assert.equal(await shiftStatus(shift.id), 'completed');

      const mboAfter = await alertRow(mbo.id);
      assert.equal(mboAfter.status, SafetyAlertStatus.CLOSED);
      assert.equal(mboAfter.resolutionReason, 'guard_forgot_book_off', 'a reason from the alert type\'s own set');
      assert.match(mboAfter.resolutionNote!, /^Closed by Control without Book Off \(shift reconciliation\): Guard forgot to Book Off\. Phoned guard/);
      assert.equal(mboAfter.closedByUserId, A.owner.sub);
      const summaryAfter = await alertRow(summary.id);
      assert.equal(summaryAfter.status, SafetyAlertStatus.CLOSED);
      assert.equal(summaryAfter.resolutionReason, 'other');
      assert.ok(summaryAfter.acknowledgedAt, 'the earlier acknowledgement is kept');
      assert.deepEqual(await alertRow(evidence.id), evidenceBefore, 'per-window evidence untouched');
      assert.equal((await alertRow(panic.id)).status, SafetyAlertStatus.OPEN, 'an unrelated alert stays open');
      assert.equal(await repo(SafetyAlert).count({ where: { shift: { id: shift.id } } }), 4, 'no alert deleted');

      assert.deepEqual(await events(shift.id), eventsBefore, 'attendance is not rewritten');
      assert.ok(!(await events(shift.id)).some((e) => e.type === AttendanceEventType.CHECK_OUT), 'no Book Off is fabricated');
      assert.equal(await timesheets(shift.id), 0, 'no timesheet is created');
    });

    await test('RECON-02-THE-AUDIT-ENTRY-RECORDS-WHO-WHAT-WHY-AND-WHEN', async () => {
      const shift = await workedShift({ endedMinsAgo: 90 });
      const mbo = await alert(shift, A, SafetyAlertType.MISSING_BOOK_OFF, SafetyAlertStatus.OPEN);
      const before = Date.now();
      await service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'control_confirmed_departure', note: null });
      const [entry] = await audits('shift.reconciled_without_book_off', shift.id);
      assert.ok(entry, 'one audit entry');
      const raw = (await ds.query('SELECT "companyId", "userId", "entityType", "beforeData", "afterData" FROM audit_logs WHERE id = $1', [entry.id]))[0];
      assert.equal(raw.companyId, A.company.id, 'company');
      assert.equal(raw.userId, A.owner.sub, 'acting user');
      assert.equal(raw.entityType, 'shift');
      assert.equal(raw.beforeData.status, 'in_progress', 'status before');
      assert.equal(raw.afterData.status, 'completed', 'status after');
      assert.equal(raw.beforeData.scheduledStart, new Date(shift.start).toISOString(), 'original scheduled start');
      assert.equal(raw.beforeData.scheduledEnd, new Date(shift.end).toISOString(), 'original scheduled end');
      const [bookOn] = await events(shift.id);
      assert.equal(raw.beforeData.bookOnAt, new Date(bookOn.occurredAt).toISOString(), 'the actual Book On');
      assert.equal(raw.beforeData.bookOffAt, null);
      assert.equal(raw.afterData.bookOffAt, null, 'no Book Off time invented');
      assert.equal(raw.afterData.reason, 'control_confirmed_departure');
      assert.equal(raw.afterData.note, null);
      assert.ok(Date.parse(raw.afterData.reconciledAt) >= before - 1000, 'reconciliation timestamp');
      assert.equal(raw.afterData.reconciledByUserId, A.owner.sub);
      assert.deepEqual(raw.afterData.closedAlertIds, [mbo.id]);
      assert.equal((await alertRow(mbo.id)).resolutionReason, 'guard_confirmed_off_site');
      const [alertAudit] = await audits('safety_alert.closed', mbo.id);
      assert.ok(alertAudit, 'each closed alert has its own closure audit');
    });

    // ═══════════════════ eligibility ═══════════════════

    await test('RECON-03-A-GENUINELY-ACTIVE-SHIFT-CANNOT-BE-CLOSED', async () => {
      const active = await workedShift({ endedMinsAgo: -120 }); // ends in two hours
      await rejects(service.reconcileWithoutBookOff(A.owner, active.id, { reason: 'guard_forgot_book_off' }), BadRequestException, /grace/);
      const inGrace = await workedShift({ endedMinsAgo: 14 });
      await rejects(service.reconcileWithoutBookOff(A.owner, inGrace.id, { reason: 'guard_forgot_book_off' }), BadRequestException, /grace/);
      assert.equal(await shiftStatus(active.id), 'in_progress');
      assert.equal(await shiftStatus(inGrace.id), 'in_progress');
      const past = await workedShift({ endedMinsAgo: 16 });
      await service.reconcileWithoutBookOff(A.owner, past.id, { reason: 'guard_forgot_book_off' });
      assert.equal(await shiftStatus(past.id), 'completed', 'end + 16 minutes is eligible');
    });

    await test('RECON-04-NO-BOOK-ON-A-BOOK-OFF-OR-THE-WRONG-STATUS-IS-REFUSED', async () => {
      const noBookOn = await workedShift({ endedMinsAgo: 120, bookOn: false });
      await rejects(service.reconcileWithoutBookOff(A.owner, noBookOn.id, { reason: 'other', note: 'x' }), BadRequestException, /no Book On/);
      const bookedOff = await workedShift({ endedMinsAgo: 120, bookOff: true });
      await rejects(service.reconcileWithoutBookOff(A.owner, bookedOff.id, { reason: 'guard_forgot_book_off' }), ConflictException, /already recorded/);
      const ready = await workedShift({ endedMinsAgo: 120, status: 'ready' });
      await rejects(service.reconcileWithoutBookOff(A.owner, ready.id, { reason: 'guard_forgot_book_off' }), BadRequestException, /in-progress/);
      const missed = await workedShift({ endedMinsAgo: 120, status: 'missed', bookOn: false });
      await rejects(service.reconcileWithoutBookOff(A.owner, missed.id, { reason: 'guard_forgot_book_off' }), BadRequestException);
      await rejects(service.reconcileWithoutBookOff(A.owner, 999999, { reason: 'guard_forgot_book_off' }), NotFoundException);
      for (const s of [noBookOn, bookedOff, ready, missed]) assert.notEqual(await shiftStatus(s.id), 'completed', `#${s.id} unchanged`);
    });

    // ═══════════════════ reasons ═══════════════════

    await test('RECON-05-A-REASON-IS-MANDATORY-AND-OTHER-NEEDS-AN-EXPLANATION', async () => {
      const shift = await workedShift({ endedMinsAgo: 120 });
      await rejects(service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'other' }), BadRequestException, /Explain/);
      await rejects(service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'other', note: '   ' }), BadRequestException, /Explain/);
      await rejects(service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'made_up' as never }), BadRequestException);
      assert.equal(await shiftStatus(shift.id), 'in_progress');
      // The request DTO refuses the same at the edge.
      for (const body of [{}, { reason: 'made_up' }, { reason: 'other', note: 'x'.repeat(1001) }, { reason: 42 }]) {
        assert.ok((await validate(plainToInstance(ReconcileShiftDto, body))).length > 0, JSON.stringify(body).slice(0, 40));
      }
      for (const reason of ['guard_forgot_book_off', 'app_connectivity_failure', 'control_confirmed_departure', 'other']) {
        assert.equal((await validate(plainToInstance(ReconcileShiftDto, { reason, note: 'ok' }))).length, 0, reason);
      }
      await service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'other', note: 'Supervisor saw guard leave' });
      assert.equal(await shiftStatus(shift.id), 'completed');
    });

    // ═══════════════════ permissions and isolation ═══════════════════

    await test('RECON-06-ONLY-RECONCILE-HOLDERS-MAY-RECONCILE', async () => {
      // shifts.reconcile: owner, admin, operations and control room. A control room may reconcile but still
      // cannot create, edit or cancel shifts — it does not hold shifts.manage.
      assert.equal(hasPermission(CompanyMembershipRole.CONTROL_ROOM, CompanyPermission.SHIFTS_RECONCILE), true);
      assert.equal(hasPermission(CompanyMembershipRole.CONTROL_ROOM, CompanyPermission.SHIFTS_MANAGE), false, 'no shift editing for a control room');
      for (const role of [CompanyMembershipRole.ADMIN, CompanyMembershipRole.OPERATIONS, CompanyMembershipRole.CONTROL_ROOM]) {
        const shift = await workedShift({ endedMinsAgo: 120 });
        await service.reconcileWithoutBookOff(await member(A.company, role), shift.id, { reason: 'guard_forgot_book_off' });
        assert.equal(await shiftStatus(shift.id), 'completed', `${role} may`);
      }
      for (const role of [CompanyMembershipRole.VIEWER, CompanyMembershipRole.FINANCE, CompanyMembershipRole.HR_COMPLIANCE]) {
        const shift = await workedShift({ endedMinsAgo: 120 });
        await rejects(service.reconcileWithoutBookOff(await member(A.company, role), shift.id, { reason: 'guard_forgot_book_off' }), ForbiddenException);
        assert.equal(await shiftStatus(shift.id), 'in_progress', `${role} may not`);
      }
      // A Guard has no company membership at all.
      const shift = await workedShift({ endedMinsAgo: 120 });
      await rejects(service.reconcileWithoutBookOff({ sub: A.guardUser.id, role: UserRole.GUARD } as never, shift.id, { reason: 'guard_forgot_book_off' }), NotFoundException);
      // The route admits company accounts only.
      const roles = Reflect.getMetadata(ROLES_KEY, ShiftController.prototype.reconcileWithoutBookOff) as UserRole[];
      assert.deepEqual([...roles].sort(), [UserRole.COMPANY, UserRole.COMPANY_ADMIN, UserRole.COMPANY_STAFF].sort());
      assert.ok(!roles.includes(UserRole.GUARD) && !roles.includes(UserRole.ADMIN));
    });

    await test('RECON-07-ANOTHER-COMPANYS-SHIFT-IS-INVISIBLE', async () => {
      const shift = await workedShift({ tenant: A, endedMinsAgo: 120 });
      const mbo = await alert(shift, A, SafetyAlertType.MISSING_BOOK_OFF, SafetyAlertStatus.OPEN);
      await rejects(service.reconcileWithoutBookOff(B.owner, shift.id, { reason: 'guard_forgot_book_off' }), NotFoundException, /not found/);
      await rejects(service.reconcileWithoutBookOff(await member(B.company, CompanyMembershipRole.OPERATIONS), shift.id, { reason: 'guard_forgot_book_off' }), NotFoundException);
      assert.equal(await shiftStatus(shift.id), 'in_progress');
      assert.equal((await alertRow(mbo.id)).status, SafetyAlertStatus.OPEN);
      assert.equal((await audits('shift.reconciled_without_book_off', shift.id)).length, 0);
    });

    // ═══════════════════ duplicates, concurrency, atomicity ═══════════════════

    await test('RECON-08-A-DUPLICATE-SUBMISSION-IS-REFUSED-AND-CHANGES-NOTHING', async () => {
      const shift = await workedShift({ endedMinsAgo: 120 });
      await alert(shift, A, SafetyAlertType.MISSING_BOOK_OFF, SafetyAlertStatus.OPEN);
      await service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'guard_forgot_book_off' });
      await rejects(service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'other', note: 'again' }), ConflictException, /already closed/);
      assert.equal((await audits('shift.reconciled_without_book_off', shift.id)).length, 1);
    });

    await test('RECON-09-CONCURRENT-SUBMISSIONS-RECONCILE-EXACTLY-ONCE', async () => {
      const shift = await workedShift({ endedMinsAgo: 120 });
      const mbo = await alert(shift, A, SafetyAlertType.MISSING_BOOK_OFF, SafetyAlertStatus.OPEN);
      const ops = await member(A.company, CompanyMembershipRole.OPERATIONS);
      const results = await Promise.allSettled([
        service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'guard_forgot_book_off' }),
        service.reconcileWithoutBookOff(ops, shift.id, { reason: 'app_connectivity_failure' }),
        service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'other', note: 'third' }),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'one wins');
      for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
        assert.ok(r.reason instanceof ConflictException, String(r.reason));
      }
      assert.equal((await audits('shift.reconciled_without_book_off', shift.id)).length, 1);
      assert.equal((await audits('safety_alert.closed', mbo.id)).length, 1, 'the alert is closed once');
    });

    await test('RECON-09B-A-RECONCILIATION-IN-FLIGHT-IS-WAITED-FOR-NOT-RACED', async () => {
      // Deterministic version of the race: another transaction holds the shift row and has already moved
      // it to completed but not committed. The service must WAIT for it, then see the committed result and
      // refuse — not read the stale in_progress status and close the shift a second time.
      const shift = await workedShift({ endedMinsAgo: 120 });
      const other = ds.createQueryRunner();
      await other.connect();
      await other.startTransaction();
      try {
        await other.query('SELECT "id" FROM "shifts" WHERE "id" = $1 FOR UPDATE', [shift.id]);
        await other.query(`UPDATE "shifts" SET "status" = 'completed' WHERE "id" = $1`, [shift.id]);
        let settled = false;
        const attempt = service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'guard_forgot_book_off' });
        attempt.then(() => { settled = true; }, () => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(settled, false, 'it waits for the reconciliation already in flight');
        await other.commitTransaction();
        await rejects(attempt, ConflictException, /already closed/);
      } finally {
        if (other.isTransactionActive) await other.rollbackTransaction();
        await other.release();
      }
      assert.equal((await audits('shift.reconciled_without_book_off', shift.id)).length, 0, 'it wrote nothing');
    });

    await test('RECON-10-A-FAILURE-ROLLS-EVERYTHING-BACK', async () => {
      const shift = await workedShift({ endedMinsAgo: 120 });
      const mbo = await alert(shift, A, SafetyAlertType.MISSING_BOOK_OFF, SafetyAlertStatus.OPEN);
      const failingAudit = new AuditLogService(repo(AuditLog), membershipService);
      failingAudit.logInTransaction = (async (manager: never, input: { action: string }) => {
        if (input.action === 'shift.reconciled_without_book_off') throw new Error('simulated audit failure');
        return AuditLogService.prototype.logInTransaction.call(failingAudit, manager, input as never);
      }) as never;
      const failing = new ShiftReconciliationService(ds, membershipService, failingAudit);
      await rejects(failing.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'guard_forgot_book_off' }), Error, /simulated/);
      assert.equal(await shiftStatus(shift.id), 'in_progress', 'status rolled back');
      assert.equal((await alertRow(mbo.id)).status, SafetyAlertStatus.OPEN, 'alert closure rolled back');
      assert.equal((await audits('safety_alert.closed', mbo.id)).length, 0, 'alert audit rolled back');
    });

    // ═══════════════════ afterwards ═══════════════════

    await test('RECON-11-THE-SWEEP-LEAVES-A-RECONCILED-SHIFT-ALONE', async () => {
      const windowEngine = new OperationalWindowService();
      const sweep = new SafetyAlertService(
        repo(SafetyAlert), repo(DailyLog), repo(AttendanceEvent), repo(Shift), null as never, null as never, null as never,
        auditLogService, { createForUser: async () => undefined, createForUserUnlessRecentDuplicate: async () => undefined } as never,
        new WelfareWindowService(windowEngine), windowEngine, ds, { getGuardSummary: async () => { throw new Error('unused'); } } as never,
      );
      const shift = await workedShift({ endedMinsAgo: 26 * 60 });
      await sweep.runMissedWelfareChecks();
      const opened = await repo(SafetyAlert).find({ where: { shift: { id: shift.id } }, loadEagerRelations: false });
      assert.ok(opened.some((a) => a.type === SafetyAlertType.MISSING_BOOK_OFF && a.status === SafetyAlertStatus.OPEN), 'the sweep raised Missing Book Off');
      await service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'guard_forgot_book_off' });
      const afterClose = await repo(SafetyAlert).count({ where: { shift: { id: shift.id } } });
      for (let i = 0; i < 3; i += 1) await sweep.runMissedWelfareChecks();
      assert.equal(await repo(SafetyAlert).count({ where: { shift: { id: shift.id } } }), afterClose, 'nothing new is raised');
      const open = await repo(SafetyAlert).count({ where: { shift: { id: shift.id }, status: SafetyAlertStatus.OPEN } });
      assert.equal(open, 0, 'nothing is reopened');
    });

    await test('RECON-12-A-LATE-BOOK-OFF-AFTER-RECONCILIATION-IS-REFUSED', async () => {
      // Book On / Book Off behaviour is unchanged; a reconciled shift simply is no longer in progress.
      const shift = await workedShift({ endedMinsAgo: 120 });
      await service.reconcileWithoutBookOff(A.owner, shift.id, { reason: 'guard_forgot_book_off' });
      const attendance = new AttendanceService(
        repo(AttendanceEvent),
        { findOne: (id: number) => repo(Shift).findOneByOrFail({ id }), normalizeLifecycleStatus: (s: string) => s } as never,
        { findByUserId: async () => A.guard } as never,
        null as never, null as never, null as never, null as never, ds, auditLogService,
      );
      await rejects(attendance.checkOut(A.guardUser.id, { shiftId: shift.id } as never), BadRequestException, /in-progress/);
      assert.ok(!(await events(shift.id)).some((e) => e.type === AttendanceEventType.CHECK_OUT), 'still no Book Off');
    });

    await test('RECON-13-NOTHING-IS-AUTOMATIC-AND-THE-AUDIT-IS-INSERT-ONLY', async () => {
      const fs = await import('node:fs');
      const src = fs.readFileSync('src/shift/shift-reconciliation.service.ts', 'utf8');
      assert.ok(!/setInterval|@Cron|onModuleInit|setTimeout/.test(src), 'no scheduler calls reconciliation');
      assert.ok(!/AttendanceEventType\.CHECK_OUT\s*,|type:\s*AttendanceEventType\.CHECK_OUT/.test(src), 'it never writes a CHECK_OUT');
      assert.ok(!/Timesheet/.test(src), 'it never touches timesheets');
      assert.ok(!/\.delete\(|\.remove\(/.test(src), 'it deletes nothing');
      const audit = fs.readFileSync('src/audit-log/audit-log.service.ts', 'utf8');
      assert.ok(!/\.update\(|\.delete\(|\.remove\(/.test(audit), 'audit entries are only ever inserted');
      const callers = fs.readFileSync('src/shift/shift.controller.ts', 'utf8');
      assert.equal((callers.match(/reconcileWithoutBookOff\(/g) || []).length, 2, 'one route is the only caller');
    });

    await test('RECON-14-RECONCILIATION-IS-READ-FROM-THE-AUDIT-ENTRY-NOT-INFERRED', async () => {
      const reconciled = await workedShift({ endedMinsAgo: 120 });
      await service.reconcileWithoutBookOff(A.owner, reconciled.id, { reason: 'control_confirmed_departure' });
      // Completed with a Book On and no Book Off, but NOT by reconciliation (e.g. a legacy edit): no audit entry.
      const legacy = await workedShift({ endedMinsAgo: 120, status: 'completed' });
      const foreign = await workedShift({ tenant: B, endedMinsAgo: 120 });
      await service.reconcileWithoutBookOff(B.owner, foreign.id, { reason: 'guard_forgot_book_off' });

      const viewer = await member(A.company, CompanyMembershipRole.VIEWER);
      const rows = await service.listReconciliations(viewer, [reconciled.id, legacy.id, foreign.id, 999999, -1, NaN]);
      assert.deepEqual(rows.map((r) => r.shiftId), [reconciled.id], 'only the audited reconciliation, only in my company');
      assert.equal(rows[0].reason, 'control_confirmed_departure');
      assert.ok(rows[0].reconciledAt && Number.isFinite(Date.parse(rows[0].reconciledAt)));
      assert.deepEqual(await service.listReconciliations(B.owner, [reconciled.id]), [], 'another company cannot see it');
      assert.deepEqual(await service.listReconciliations(viewer, []), []);
      // A Guard has no company membership.
      await rejects(service.listReconciliations({ sub: A.guardUser.id, role: UserRole.GUARD } as never, [reconciled.id]), NotFoundException);
      // The lookup route is declared before GET :id, so "reconciliations" is never parsed as a shift id.
      const fs = await import('node:fs');
      const controller = fs.readFileSync('src/shift/shift.controller.ts', 'utf8');
      assert.ok(controller.indexOf("@Get('reconciliations')") < controller.indexOf("@Get(':id')"));
      const roles = Reflect.getMetadata(ROLES_KEY, ShiftController.prototype.listReconciliations) as UserRole[];
      assert.ok(!roles.includes(UserRole.GUARD) && !roles.includes(UserRole.ADMIN), 'company accounts only');
    });

    console.log(JSON.stringify({ event: 'shift_reconciliation_certified', tests: passed }));
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(`\nFAIL  ${error?.message || error}`);
  console.error(error);
  process.exit(1);
});
