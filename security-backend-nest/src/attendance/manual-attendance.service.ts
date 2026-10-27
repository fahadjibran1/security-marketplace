import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import {
  CompanyMembershipRole,
  CompanyMembershipStatus,
  CompanyPermission,
} from '../company-membership/company-membership-types';
import { ShiftService } from '../shift/shift.service';
import { TimesheetService } from '../timesheet/timesheet.service';
import { UserRole } from '../user/entities/user.entity';
import { Assignment, AssignmentStatus } from '../assignment/entities/assignment.entity';
import { lockGuardsForAssignment, returningRows, WELFARE_SWEEP_LOCK_NAMESPACE } from '../operations/advisory-locks';
import { ATTENDANCE_VERIFICATION_METHODS, AttendanceEventType, AttendanceSource } from './entities/attendance.entity';
import { CHECK_IN, CHECK_OUT, chainRoot, effectiveAttendance } from './effective-attendance';
import {
  MANUAL_ATTENDANCE_ERROR_CODES as E,
  MANUAL_ATTENDANCE_OWNER_ADMIN_ONLY_OLDER_THAN_HOURS,
  MANUAL_ATTENDANCE_WINDOW_AFTER_END_HOURS,
  MANUAL_ATTENDANCE_WINDOW_BEFORE_START_HOURS,
  ManualAttendanceInput,
  assertManualTimeAllowed,
  attendanceError,
  intervalsOverlap,
  mayManageAttendance,
  mayRecordOldAttendance,
  overlapBoundary,
  timesheetLockedForAttendance,
  validateManualAttendanceInput,
} from './manual-attendance-policy';

type Actor = { companyId: number; userId: number; role: CompanyMembershipRole; canManageAttendance: boolean };

/** One raw attendance row as the manual paths read it (no eager graph). */
type EventRow = {
  id: number;
  shiftId: number;
  guardId: number;
  type: string;
  occurredAt: Date;
  recordedAt: Date | null;
  source: string;
  recordedByUserId: number | null;
  reason: string | null;
  verificationMethod: string | null;
  verificationNote: string | null;
  correctionOfEventId: number | null;
  gpsVerified: boolean;
  nfcVerified: boolean;
};

export type AttendanceEventView = {
  id: number;
  shiftId: number;
  guardId: number;
  type: 'check-in' | 'check-out';
  occurredAt: string;
  recordedAt: string | null;
  source: 'guard_app' | 'manual';
  recordedByUserId: number | null;
  recordedByName: string | null;
  reason: string | null;
  verificationMethod: string | null;
  verificationNote: string | null;
  correctionOfEventId: number | null;
  correctedByEventId: number | null;
  isCorrection: boolean;
  effective: boolean;
  gpsVerified: boolean;
  nfcVerified: boolean;
};

type LockedShift = { id: number; status: string; guardId: number | null; start: Date; end: Date; companyId: number };

const EVENT_COLUMNS = `"id", "shiftId", "guardId", "type"::text AS "type", "occurredAt", "recordedAt", "source", "recordedByUserId",
  "reason", "verificationMethod", "verificationNote", "correctionOfEventId", "gpsVerified", "nfcVerified"`;
/** EVENT_COLUMNS qualified with the `e` alias, for the overlap read that joins "shifts". */
const OTHER_SHIFT_EVENT_COLUMNS = `e."id", e."shiftId", e."guardId", e."type"::text AS "type", e."occurredAt", e."recordedAt", e."source",
  e."recordedByUserId", e."reason", e."verificationMethod", e."verificationNote", e."correctionOfEventId", e."gpsVerified", e."nfcVerified"`;

/** "YYYY-MM-DD HH:MM:SS.mmm" UTC wall time, for the `timestamp` columns that store UTC (the process runs in UTC). */
const dbTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/** The start-of-work gate's refusal, in words a Control Room can act on (never evidence or document details). */
function guardIneligibleReason(message: string): string {
  const compliance = /^Guard compliance invalid: (.+)$/.exec(message);
  if (compliance) return compliance[1];
  if (/not active\/approved for this company/.test(message)) return 'the Guard is not currently active with this company';
  if (/Guard account is not active/.test(message)) return "the Guard's account is not active";
  return 'the company has not cleared the Guard to work';
}

/**
 * Manual attendance management (Migration 67; owner-approved 27 Oct 2026). See manual-attendance-policy.ts for the
 * rules and effective-attendance.ts for how the rows are read.
 *
 * Every write is ONE transaction, audited, in the reconciliation lock order so it can never deadlock with the welfare
 * sweep: (the Guard's assignment lock, for the overlap check) → the shift row FOR NO KEY UPDATE → the welfare-sweep
 * advisory lock for that shift. FOR NO KEY UPDATE still conflicts with the Guard app's Book On / Book Off (FOR UPDATE),
 * so a manual entry and an app tap are serialised; the one-root unique index is the final word if anything slips by.
 * Only non-key shift columns are written.
 */
@Injectable()
export class ManualAttendanceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly membershipService: CompanyMembershipService,
    private readonly shiftService: ShiftService,
    private readonly timesheetService: TimesheetService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Who ──────────────────────────────────────────────────────────────────────────────────────────────

  private async actor(user: JwtPayload, requireManage: boolean): Promise<Actor> {
    if (user.role === UserRole.GUARD || user.role === UserRole.ADMIN) {
      throw attendanceError(HttpStatus.FORBIDDEN, E.FORBIDDEN, 'Only authorised staff of the company that owns the shift can manage its attendance.');
    }
    const { company, membershipRole } = await this.membershipService.resolveCompanyContext(user.sub, user.role);
    const [membership] = (await this.dataSource.query(
      `SELECT "canManageAttendance" FROM "company_memberships" WHERE "userId" = $1 AND "companyId" = $2 AND "status" = $3`,
      [user.sub, company.id, CompanyMembershipStatus.ACTIVE],
    )) as Array<{ canManageAttendance: boolean }>;
    const actor: Actor = {
      companyId: company.id,
      userId: user.sub,
      role: membershipRole,
      canManageAttendance: Boolean(membership?.canManageAttendance),
    };
    if (requireManage && !mayManageAttendance(actor.role, actor.canManageAttendance)) {
      throw attendanceError(HttpStatus.FORBIDDEN, E.FORBIDDEN, 'You are not authorised to record or correct attendance.');
    }
    return actor;
  }

  /** What the web needs to decide whether to offer manual attendance at all (and the limits to show). */
  async capabilities(user: JwtPayload) {
    let canManage = false;
    let canRecordOlder = false;
    try {
      const actor = await this.actor(user, false);
      canManage = mayManageAttendance(actor.role, actor.canManageAttendance);
      canRecordOlder = canManage && mayRecordOldAttendance(actor.role);
    } catch {
      canManage = false;
    }
    return {
      manualAttendance: true,
      verificationMethods: [...ATTENDANCE_VERIFICATION_METHODS],
      windowBeforeStartHours: MANUAL_ATTENDANCE_WINDOW_BEFORE_START_HOURS,
      windowAfterEndHours: MANUAL_ATTENDANCE_WINDOW_AFTER_END_HOURS,
      ownerAdminOnlyOlderThanHours: MANUAL_ATTENDANCE_OWNER_ADMIN_ONLY_OLDER_THAN_HOURS,
      canManage,
      canRecordOlderThan24h: canRecordOlder,
    };
  }

  /** Per-person Control Room authorisation, granted or revoked by an Owner / Admin (the canAmendShifts pattern). */
  async setControlRoomGrant(user: JwtPayload, targetUserId: number, canManageAttendance: boolean) {
    const actor = await this.actor(user, false);
    if (!mayRecordOldAttendance(actor.role)) {
      throw attendanceError(HttpStatus.FORBIDDEN, E.FORBIDDEN, 'Only an Owner or Admin can authorise Control Room staff.');
    }
    return this.dataSource.transaction(async (manager) => {
      const [membership] = await manager.query(
        `SELECT "id", "membershipRole", "canManageAttendance" FROM "company_memberships"
          WHERE "userId" = $1 AND "companyId" = $2 AND "status" = 'active' FOR UPDATE`,
        [targetUserId, actor.companyId],
      );
      if (!membership) throw attendanceError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Staff member not found.');
      if (membership.membershipRole !== CompanyMembershipRole.CONTROL_ROOM) {
        throw attendanceError(HttpStatus.UNPROCESSABLE_ENTITY, E.FORBIDDEN, 'Per-person authorisation applies to Control Room members only.');
      }
      await manager.query(`UPDATE "company_memberships" SET "canManageAttendance" = $2, "updatedAt" = now() WHERE "id" = $1`, [
        membership.id,
        canManageAttendance,
      ]);
      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: 'company_membership.attendance_authorisation',
        entityType: 'company_membership',
        entityId: Number(membership.id),
        beforeData: { canManageAttendance: Boolean(membership.canManageAttendance) },
        afterData: { canManageAttendance, targetUserId },
      });
      return { userId: targetUserId, canManageAttendance };
    });
  }

  // ── Book On / Book Off ───────────────────────────────────────────────────────────────────────────────

  async bookOn(user: JwtPayload, dto: ManualAttendanceInput & { shiftId: number }, now: Date = new Date()) {
    const input = validateManualAttendanceInput(dto);
    const actor = await this.actor(user, true);
    const pre = await this.readShiftForCompany(dto.shiftId, actor.companyId);
    this.assertBookOnStatus(this.shiftService.normalizeLifecycleStatus(pre.status));
    const guardId = pre.guardId;
    if (!guardId) throw attendanceError(HttpStatus.CONFLICT, E.NO_GUARD, 'This shift has no Guard assigned, so there is nobody to book on.');
    assertManualTimeAllowed({
      occurredAtMs: input.occurredAtMs, nowMs: now.getTime(), scheduledStartMs: pre.start.getTime(), scheduledEndMs: pre.end.getTime(), role: actor.role,
    });

    // The start-of-work gate (relationship + company compliance), exactly as the Guard app's Book On runs it.
    try {
      await this.shiftService.assertGuardMayStartWork(actor.companyId, guardId);
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      const reason = guardIneligibleReason(error.message);
      await this.auditLogService.log({
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: 'attendance.manual_book_on_refused',
        entityType: 'shift',
        entityId: pre.id,
        afterData: { guardId, reason },
      });
      throw attendanceError(HttpStatus.FORBIDDEN, E.GUARD_INELIGIBLE, `The Guard cannot be booked on: ${reason}.`);
    }

    return this.write(async (manager) => {
      const locked = await this.lockShift(manager, pre.id, actor.companyId, guardId);
      const status = this.shiftService.normalizeLifecycleStatus(locked.status);
      const events = await this.events(manager, locked.id);
      const effective = effectiveAttendance(events);
      if (effective.bookOn) {
        throw attendanceError(HttpStatus.CONFLICT, E.ALREADY_BOOKED_ON, 'A Book On is already recorded for this shift. Correct its time instead.');
      }
      this.assertBookOnStatus(status);
      assertManualTimeAllowed({
        occurredAtMs: input.occurredAtMs, nowMs: now.getTime(), scheduledStartMs: new Date(locked.start).getTime(),
        scheduledEndMs: new Date(locked.end).getTime(), role: actor.role,
      });
      await this.assertNoOverlap(manager, guardId, locked.id, { from: input.occurredAtMs, to: input.occurredAtMs });

      const event = await this.insertEvent(manager, {
        shiftId: locked.id, guardId, type: CHECK_IN, occurredAtMs: input.occurredAtMs, nowMs: now.getTime(), userId: actor.userId,
        reason: input.reason, method: input.verificationMethod, note: input.verificationNote, correctionOf: null,
      });
      await manager.query(`UPDATE "shifts" SET "status" = 'in_progress' WHERE "id" = $1`, [locked.id]);
      if (pre.assignmentId) {
        await manager.getRepository(Assignment).update(
          { id: pre.assignmentId },
          { status: AssignmentStatus.CHECKED_IN, acceptedAt: pre.assignmentAcceptedAt ?? event.occurredAt, checkedInAt: event.occurredAt },
        );
      }
      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: 'attendance.manual_book_on',
        entityType: 'shift',
        entityId: locked.id,
        beforeData: { status: locked.status, bookOnAt: null },
        afterData: {
          status: 'in_progress', fromStatus: status, eventId: event.id, guardId, source: AttendanceSource.MANUAL,
          occurredAt: event.occurredAt.toISOString(), recordedAt: new Date(now.getTime()).toISOString(), recordedByUserId: actor.userId,
          reason: input.reason, verificationMethod: input.verificationMethod, verificationNote: input.verificationNote,
          lateArrivalFromMissed: status === 'missed',
        },
      });
      return { event: await this.view(manager, event, [...events, event]), shift: { id: locked.id, status: 'in_progress' } };
    });
  }

  async bookOff(user: JwtPayload, dto: ManualAttendanceInput & { shiftId: number }, now: Date = new Date()) {
    const input = validateManualAttendanceInput(dto);
    const actor = await this.actor(user, true);
    const pre = await this.readShiftForCompany(dto.shiftId, actor.companyId);
    const guardId = pre.guardId;
    if (!guardId) throw attendanceError(HttpStatus.CONFLICT, E.NO_GUARD, 'This shift has no Guard assigned.');

    return this.write(async (manager) => {
      const locked = await this.lockShift(manager, pre.id, actor.companyId, guardId);
      const status = this.shiftService.normalizeLifecycleStatus(locked.status);
      const events = await this.events(manager, locked.id);
      const effective = effectiveAttendance(events);
      if (effective.bookOff) {
        throw attendanceError(HttpStatus.CONFLICT, E.ALREADY_BOOKED_OFF, 'A Book Off is already recorded for this shift. Correct its time instead.');
      }
      // In progress, or completed by Close without Book Off (completed with a Book On and no Book Off).
      if (status !== 'in_progress' && status !== 'completed') {
        throw attendanceError(HttpStatus.CONFLICT, E.BOOK_OFF_STATUS, `A ${status.replace('_', ' ')} shift cannot be booked off.`);
      }
      if (!effective.bookOn || !effective.bookOnAt) {
        throw attendanceError(HttpStatus.CONFLICT, E.NOT_BOOKED_ON, 'This shift has no Book On, so it cannot be booked off.');
      }
      assertManualTimeAllowed({
        occurredAtMs: input.occurredAtMs, nowMs: now.getTime(), scheduledStartMs: new Date(locked.start).getTime(),
        scheduledEndMs: new Date(locked.end).getTime(), role: actor.role,
      });
      if (input.occurredAtMs <= effective.bookOnAt.getTime()) {
        throw attendanceError(HttpStatus.UNPROCESSABLE_ENTITY, E.BOOK_OFF_BEFORE_BOOK_ON, 'The Book Off must be after the Book On.', {
          bookOnAt: effective.bookOnAt.toISOString(),
        });
      }
      await this.assertNoOverlap(manager, guardId, locked.id, { from: effective.bookOnAt.getTime(), to: input.occurredAtMs });
      await this.assertTimesheetOpen(manager, locked.id);

      const event = await this.insertEvent(manager, {
        shiftId: locked.id, guardId, type: CHECK_OUT, occurredAtMs: input.occurredAtMs, nowMs: now.getTime(), userId: actor.userId,
        reason: input.reason, method: input.verificationMethod, note: input.verificationNote, correctionOf: null,
      });
      const after = effectiveAttendance([...events, event]);
      if (status === 'in_progress') {
        await manager.query(`UPDATE "shifts" SET "status" = 'completed' WHERE "id" = $1`, [locked.id]);
      }

      // A Book Off ends the shift: open extensions are voided, exactly as the Guard app's Book Off does.
      const voided = returningRows<{ id: number; companyId: number }>(await manager.query(
        `UPDATE "shift_amendments" SET "status" = 'voided', "voidedReason" = 'booked_off',
            "voidedAt" = (statement_timestamp() AT TIME ZONE 'UTC'), "updatedAt" = now()
          WHERE "shiftId" = $1 AND "status" IN ('awaiting_approval', 'pending')
          RETURNING "id", "companyId"`,
        [locked.id],
      ));
      for (const row of voided) {
        await this.auditLogService.logInTransaction(manager, {
          company: { id: Number(row.companyId) },
          user: { id: actor.userId },
          action: 'shift_amendment.voided',
          entityType: 'shift_amendment',
          entityId: Number(row.id),
          beforeData: { status: 'open' },
          afterData: { status: 'voided', reason: 'booked_off', shiftId: locked.id, bookOffEventId: event.id },
        });
      }

      if (pre.assignmentId) {
        await manager.getRepository(Assignment).update(
          { id: pre.assignmentId },
          { status: AssignmentStatus.CHECKED_OUT, checkedOutAt: event.occurredAt },
        );
      }

      // The timesheet carries the attendance-verified actuals, as on a Guard-app Book Off (written once).
      await this.timesheetService.recordAttendanceActuals(
        manager,
        locked.id,
        { checkInAt: effective.bookOnAt, checkOutAt: event.occurredAt },
        { verifiedSource: after.verifiedSource, shiftLocked: true },
      );

      // The Book Off answers an open Missing Book Off alert now, not on the next sweep (which would close it too).
      const closed = returningRows<{ id: number }>(await manager.query(
        `UPDATE "safety_alerts" SET "status" = 'closed', "closedAt" = (statement_timestamp() AT TIME ZONE 'UTC')
          WHERE "shiftId" = $1 AND "type" = 'missing_book_off' AND "status" IN ('open', 'acknowledged')
          RETURNING "id"`,
        [locked.id],
      ));
      for (const alert of closed) {
        await this.auditLogService.logInTransaction(manager, {
          company: { id: actor.companyId },
          user: { id: actor.userId },
          action: 'shift.missing_book_off_resolved',
          entityType: 'safety_alert',
          entityId: Number(alert.id),
          afterData: { shiftId: locked.id, status: 'closed', closedBy: 'manual_book_off', bookOffEventId: event.id },
        });
      }

      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: 'attendance.manual_book_off',
        entityType: 'shift',
        entityId: locked.id,
        beforeData: { status: locked.status, bookOffAt: null },
        afterData: {
          status: 'completed', fromStatus: status, eventId: event.id, guardId, source: AttendanceSource.MANUAL,
          occurredAt: event.occurredAt.toISOString(), recordedAt: new Date(now.getTime()).toISOString(), recordedByUserId: actor.userId,
          reason: input.reason, verificationMethod: input.verificationMethod, verificationNote: input.verificationNote,
          bookOnAt: effective.bookOnAt.toISOString(), closedMissingBookOffAlertIds: closed.map((a) => Number(a.id)),
          afterReconciliation: status === 'completed',
        },
      });
      return { event: await this.view(manager, event, [...events, event]), shift: { id: locked.id, status: 'completed' } };
    });
  }

  // ── Corrections ──────────────────────────────────────────────────────────────────────────────────────

  async correct(user: JwtPayload, eventId: number, dto: ManualAttendanceInput, now: Date = new Date()) {
    const input = validateManualAttendanceInput(dto);
    const actor = await this.actor(user, true);
    const [target] = (await this.dataSource.query(
      `SELECT e."id", e."shiftId", e."guardId", s."companyId" FROM "attendance_events" e JOIN "shifts" s ON s."id" = e."shiftId" WHERE e."id" = $1`,
      [eventId],
    )) as Array<{ id: number; shiftId: number; guardId: number; companyId: number }>;
    if (!target || Number(target.companyId) !== actor.companyId) {
      throw attendanceError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Attendance record not found.');
    }
    const guardId = Number(target.guardId);

    return this.write(async (manager) => {
      // The Guard's lock too, so two corrections on different shifts of one Guard cannot both pass the overlap check.
      const locked = await this.lockShift(manager, Number(target.shiftId), actor.companyId, guardId);
      const events = await this.events(manager, locked.id);
      const original = events.find((e) => e.id === Number(eventId));
      if (!original) throw attendanceError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Attendance record not found.');
      const correctedBy = events.find((e) => e.correctionOfEventId === original.id);
      if (correctedBy) {
        throw attendanceError(HttpStatus.CONFLICT, E.CORRECTION_NOT_TIP, 'This time has already been corrected. Correct the latest entry instead.', {
          latestEventId: this.tipOf(events, correctedBy).id,
        });
      }
      const currentMs = new Date(original.occurredAt).getTime();
      if (input.occurredAtMs === currentMs) {
        throw attendanceError(HttpStatus.UNPROCESSABLE_ENTITY, E.CORRECTION_UNCHANGED, 'The corrected time is the same as the recorded time.');
      }
      assertManualTimeAllowed({
        occurredAtMs: input.occurredAtMs, nowMs: now.getTime(), scheduledStartMs: new Date(locked.start).getTime(),
        scheduledEndMs: new Date(locked.end).getTime(), role: actor.role, olderReferenceMs: currentMs,
      });

      const before = effectiveAttendance(events);
      const isBookOn = original.type === CHECK_IN;
      const bookOnMs = isBookOn ? input.occurredAtMs : before.bookOnAt?.getTime() ?? null;
      const bookOffMs = isBookOn ? before.bookOffAt?.getTime() ?? null : input.occurredAtMs;
      if (bookOnMs !== null && bookOffMs !== null && bookOffMs <= bookOnMs) {
        throw attendanceError(HttpStatus.UNPROCESSABLE_ENTITY, E.BOOK_OFF_BEFORE_BOOK_ON, 'The Book Off must be after the Book On.');
      }
      if (bookOnMs !== null) {
        await this.assertNoOverlap(manager, guardId, locked.id, { from: bookOnMs, to: bookOffMs ?? bookOnMs });
      }
      // Approved / rejected or payroll-batched timesheets stay locked: the correction is refused as a whole.
      await this.assertTimesheetOpen(manager, locked.id);

      const event = await this.insertEvent(manager, {
        shiftId: locked.id, guardId, type: original.type, occurredAtMs: input.occurredAtMs, nowMs: now.getTime(), userId: actor.userId,
        reason: input.reason, method: input.verificationMethod, note: input.verificationNote, correctionOf: original.id,
      });
      const after = effectiveAttendance([...events, event]);

      const [assignment] = (await manager.query(
        `SELECT a."id" FROM "shifts" s JOIN "assignments" a ON a."id" = s."assignmentId" WHERE s."id" = $1`,
        [locked.id],
      )) as Array<{ id: number }>;
      if (assignment) {
        await manager.getRepository(Assignment).update(
          { id: Number(assignment.id) },
          isBookOn ? { checkedInAt: event.occurredAt } : { checkedOutAt: event.occurredAt },
        );
      }

      const timesheet = after.bookOnAt
        ? await this.timesheetService.restampAttendanceActuals(
            manager,
            locked.id,
            { checkInAt: after.bookOnAt, checkOutAt: after.bookOffAt },
            after.verifiedSource,
            timesheetLockedForAttendance,
            () => this.timesheetLockedError(),
          )
        : { restamped: false, approvalStatus: null };

      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: 'attendance.corrected',
        entityType: 'attendance_event',
        entityId: event.id,
        beforeData: {
          shiftId: locked.id, type: original.type, correctedEventId: original.id, occurredAt: new Date(original.occurredAt).toISOString(),
          source: original.source, chainRootEventId: chainRoot(events, original).id,
        },
        afterData: {
          shiftId: locked.id, type: original.type, eventId: event.id, occurredAt: event.occurredAt.toISOString(),
          recordedAt: new Date(now.getTime()).toISOString(), recordedByUserId: actor.userId, reason: input.reason,
          verificationMethod: input.verificationMethod, verificationNote: input.verificationNote,
          timesheetRestamped: timesheet.restamped, timesheetStatus: timesheet.approvalStatus,
        },
      });
      return {
        event: await this.view(manager, event, [...events, event]),
        correctedEventId: original.id,
        timesheet,
      };
    });
  }

  // ── Read ─────────────────────────────────────────────────────────────────────────────────────────────

  /** The full raw chain of a shift's attendance, oldest first, with the effective rows marked. */
  async history(user: JwtPayload, shiftId: number) {
    if (user.role === UserRole.GUARD || user.role === UserRole.ADMIN) {
      throw attendanceError(HttpStatus.FORBIDDEN, E.FORBIDDEN, 'Only the company that owns the shift can read its attendance history.');
    }
    const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role, CompanyPermission.ATTENDANCE_VIEW);
    const [shift] = (await this.dataSource.query(
      `SELECT "id", "status", "guardId", "start", "end", "companyId" FROM "shifts" WHERE "id" = $1`,
      [shiftId],
    )) as LockedShift[];
    if (!shift || Number(shift.companyId) !== company.id) throw attendanceError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift not found.');
    const events = await this.events(this.dataSource.manager, shift.id);
    const effective = effectiveAttendance(events);
    const views = await this.views(this.dataSource.manager, events);
    const byId = new Map(views.map((v) => [v.id, v]));
    return {
      shiftId: shift.id,
      status: shift.status,
      guardId: shift.guardId === null ? null : Number(shift.guardId),
      scheduledStart: new Date(shift.start).toISOString(),
      scheduledEnd: new Date(shift.end).toISOString(),
      effective: {
        bookOn: effective.bookOn ? byId.get(effective.bookOn.id) ?? null : null,
        bookOff: effective.bookOff ? byId.get(effective.bookOff.id) ?? null : null,
        monitoredFrom: effective.monitoredFrom ? effective.monitoredFrom.toISOString() : null,
      },
      events: views,
    };
  }

  /**
   * Adds the effective flag and source fields to the rows /attendance/mine and /attendance/company return. The rows
   * themselves are unchanged and every raw row is still returned; `effective` says which one counts.
   */
  static annotate<T extends { id: number; correctionOfEventId?: number | null; source?: string | null }>(rows: T[]) {
    const corrected = new Set(rows.map((r) => r.correctionOfEventId).filter((id): id is number => id !== null && id !== undefined));
    return rows.map((row) => ({
      ...row,
      source: row.source ?? AttendanceSource.GUARD_APP,
      isCorrection: row.correctionOfEventId !== null && row.correctionOfEventId !== undefined,
      effective: !corrected.has(row.id),
    }));
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────────────────

  private async write<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      const driver = (error as { driverError?: { code?: string; constraint?: string }; code?: string; constraint?: string });
      const code = driver?.driverError?.code ?? driver?.code;
      const constraint = driver?.driverError?.constraint ?? driver?.constraint;
      if (code === '23505' && constraint === 'UQ_attendance_events_one_root') {
        throw attendanceError(HttpStatus.CONFLICT, E.CONFLICT, 'Attendance for this shift was recorded at the same moment by someone else. Reload and check it.');
      }
      if (code === '23505' && constraint === 'UQ_attendance_events_one_correction') {
        throw attendanceError(HttpStatus.CONFLICT, E.CORRECTION_NOT_TIP, 'This time was corrected by someone else at the same moment. Reload and correct the latest entry.');
      }
      if (code === '23505' || code === '40P01' || code === '40001') {
        throw attendanceError(HttpStatus.CONFLICT, E.CONFLICT, 'The shift changed while this was being recorded. Reload and try again.');
      }
      throw error;
    }
  }

  private timesheetLockedError() {
    return attendanceError(
      HttpStatus.CONFLICT,
      E.TIMESHEET_LOCKED,
      'The timesheet for this shift is approved, rejected or in a payroll batch, so its attendance can no longer be changed.',
    );
  }

  private async assertTimesheetOpen(manager: EntityManager, shiftId: number) {
    const rows = (await manager.query(
      `SELECT "approvalStatus"::text AS "approvalStatus", "payrollBatchId" FROM "timesheets" WHERE "shiftId" = $1`,
      [shiftId],
    )) as Array<{ approvalStatus: string; payrollBatchId: number | null }>;
    if (rows.some((row) => timesheetLockedForAttendance({ approvalStatus: row.approvalStatus, payrollBatchId: row.payrollBatchId === null ? null : Number(row.payrollBatchId) }))) {
      throw this.timesheetLockedError();
    }
  }

  private assertBookOnStatus(status: string) {
    if (status === 'ready' || status === 'missed') return;
    if (status === 'in_progress' || status === 'completed') {
      throw attendanceError(HttpStatus.CONFLICT, E.ALREADY_BOOKED_ON, 'This shift has already started. Correct its Book On instead.');
    }
    throw attendanceError(
      HttpStatus.CONFLICT,
      E.BOOK_ON_STATUS,
      `Only a ready or missed shift can be booked on. This shift is ${status.replace('_', ' ')}.`,
      { status },
    );
  }

  private async readShiftForCompany(shiftId: number, companyId: number) {
    const [row] = (await this.dataSource.query(
      `SELECT s."id", s."status", s."start", s."end", s."companyId", s."guardId" AS "shiftGuardId",
              a."id" AS "assignmentId", a."guardId" AS "assignmentGuardId", a."acceptedAt" AS "assignmentAcceptedAt"
         FROM "shifts" s LEFT JOIN "assignments" a ON a."id" = s."assignmentId"
        WHERE s."id" = $1`,
      [shiftId],
    )) as Array<{ id: number; status: string; start: Date; end: Date; companyId: number; shiftGuardId: number | null;
      assignmentId: number | null; assignmentGuardId: number | null; assignmentAcceptedAt: Date | null }>;
    // Another company's shift is reported exactly like one that does not exist.
    if (!row || Number(row.companyId) !== companyId) throw attendanceError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift not found.');
    const guardId = row.shiftGuardId ?? row.assignmentGuardId;
    return {
      id: Number(row.id),
      status: row.status,
      start: new Date(row.start),
      end: new Date(row.end),
      guardId: guardId === null || guardId === undefined ? null : Number(guardId),
      assignmentId: row.assignmentId === null ? null : Number(row.assignmentId),
      assignmentAcceptedAt: row.assignmentAcceptedAt ?? null,
    };
  }

  /**
   * The lock order: the Guard's assignment lock (when given, for the overlap check) → the shift row FOR NO KEY UPDATE →
   * the welfare-sweep lock for the shift. Same as Close without Book Off, so the sweep can never deadlock with this.
   */
  private async lockShift(manager: EntityManager, shiftId: number, companyId: number, guardId: number | null): Promise<LockedShift> {
    if (guardId !== null) await lockGuardsForAssignment(manager, [guardId]);
    const [row] = (await manager.query(
      `SELECT "id", "status", "guardId", "start", "end", "companyId" FROM "shifts" WHERE "id" = $1 FOR NO KEY UPDATE`,
      [shiftId],
    )) as LockedShift[];
    if (!row || Number(row.companyId) !== companyId) throw attendanceError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift not found.');
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [WELFARE_SWEEP_LOCK_NAMESPACE, row.id]);
    if (guardId !== null && row.guardId !== null && Number(row.guardId) !== guardId) {
      throw attendanceError(HttpStatus.CONFLICT, E.CONFLICT, 'The Guard on this shift changed while this was being recorded. Reload and try again.');
    }
    return { ...row, id: Number(row.id) };
  }

  private async events(manager: EntityManager, shiftId: number): Promise<EventRow[]> {
    const rows = (await manager.query(
      `SELECT ${EVENT_COLUMNS} FROM "attendance_events" WHERE "shiftId" = $1 ORDER BY "occurredAt" ASC, "id" ASC`,
      [shiftId],
    )) as EventRow[];
    return rows.map((r) => this.normalise(r));
  }

  private normalise(r: EventRow): EventRow {
    return {
      ...r,
      id: Number(r.id),
      shiftId: Number(r.shiftId),
      guardId: Number(r.guardId),
      recordedByUserId: r.recordedByUserId === null ? null : Number(r.recordedByUserId),
      correctionOfEventId: r.correctionOfEventId === null ? null : Number(r.correctionOfEventId),
      occurredAt: new Date(r.occurredAt),
      recordedAt: r.recordedAt ? new Date(r.recordedAt) : null,
    };
  }

  private tipOf(events: EventRow[], from: EventRow): EventRow {
    let current = from;
    for (;;) {
      const next = events.find((e) => e.correctionOfEventId === current.id);
      if (!next) return current;
      current = next;
    }
  }

  /**
   * No overlapping attendance with the Guard's other shifts, judged on EFFECTIVE attendance. `interval` is this
   * shift's attendance after the write; a Book On with no Book Off yet is checked as a point (its Book Off will be
   * checked when it is recorded).
   *
   * Another shift's attendance with no Book Off is bounded by `overlapBoundary` (owner decision 27 Oct 2026): open-ended
   * while that shift is in progress (or not closed), and up to its scheduled end — a PROVISIONAL boundary for this check
   * only, never written or shown as attendance — once it is closed (e.g. completed by Close without Book Off).
   */
  private async assertNoOverlap(manager: EntityManager, guardId: number, shiftId: number, interval: { from: number; to: number | null }) {
    const rows = (await manager.query(
      `SELECT ${OTHER_SHIFT_EVENT_COLUMNS}, s."status" AS "shiftStatus", s."end" AS "shiftEnd"
         FROM "attendance_events" e JOIN "shifts" s ON s."id" = e."shiftId"
        WHERE e."guardId" = $1 AND e."shiftId" <> $2`,
      [guardId, shiftId],
    )) as Array<EventRow & { shiftStatus: string; shiftEnd: Date }>;
    const byShift = new Map<number, { status: string; end: Date; events: EventRow[] }>();
    for (const raw of rows) {
      const row = this.normalise(raw);
      const entry = byShift.get(row.shiftId) ?? { status: raw.shiftStatus, end: new Date(raw.shiftEnd), events: [] };
      entry.events.push(row);
      byShift.set(row.shiftId, entry);
    }
    for (const [otherShiftId, { status, end, events }] of byShift) {
      const other = effectiveAttendance(events);
      if (!other.bookOnAt) continue;
      const boundary = overlapBoundary({
        bookOnAtMs: other.bookOnAt.getTime(),
        bookOffAtMs: other.bookOffAt ? other.bookOffAt.getTime() : null,
        status: this.shiftService.normalizeLifecycleStatus(status),
        scheduledEndMs: end.getTime(),
      });
      if (intervalsOverlap(interval, { from: other.bookOnAt.getTime(), to: boundary.to })) {
        throw attendanceError(
          HttpStatus.CONFLICT,
          E.OVERLAP,
          `This would overlap the Guard's attendance on shift #${otherShiftId}.`,
          {
            shiftId: otherShiftId, bookOnAt: other.bookOnAt.toISOString(), bookOffAt: other.bookOffAt ? other.bookOffAt.toISOString() : null,
            ...(boundary.provisional ? { provisionalEnd: true } : {}),
          },
        );
      }
    }
  }

  private async insertEvent(
    manager: EntityManager,
    input: {
      shiftId: number; guardId: number; type: string; occurredAtMs: number; nowMs: number; userId: number;
      reason: string; method: string; note: string | null; correctionOf: number | null;
    },
  ): Promise<EventRow> {
    const [row] = (await manager.query(
      `INSERT INTO "attendance_events" ("shiftId", "guardId", "type", "occurredAt", "source", "recordedAt", "recordedByUserId",
           "reason", "verificationMethod", "verificationNote", "correctionOfEventId", "gpsVerified", "nfcVerified", "notes", "nfcTag")
       VALUES ($1, $2, $3::"attendance_events_type_enum", $4, 'manual', $5, $6, $7, $8, $9, $10, false, false, NULL, NULL)
       RETURNING ${EVENT_COLUMNS}`,
      [input.shiftId, input.guardId, input.type, dbTime(input.occurredAtMs), dbTime(input.nowMs), input.userId,
        input.reason, input.method, input.note, input.correctionOf],
    )) as EventRow[];
    return this.normalise(row);
  }

  private async view(manager: EntityManager, event: EventRow, all: EventRow[]): Promise<AttendanceEventView> {
    const views = await this.views(manager, all);
    return views.find((v) => v.id === event.id)!;
  }

  private async views(manager: EntityManager, events: EventRow[]): Promise<AttendanceEventView[]> {
    const userIds = [...new Set(events.map((e) => e.recordedByUserId).filter((id): id is number => id !== null))];
    const names = new Map<number, string>();
    if (userIds.length) {
      const users = (await manager.query(`SELECT "id", "firstName", "lastName" FROM "users" WHERE "id" = ANY($1::int[])`, [userIds])) as Array<{
        id: number; firstName: string | null; lastName: string | null;
      }>;
      for (const u of users) {
        const name = [u.firstName, u.lastName].map((p) => (p ?? '').trim()).filter(Boolean).join(' ');
        names.set(Number(u.id), name || `Staff #${Number(u.id)}`);
      }
    }
    const correctedBy = new Map<number, number>();
    for (const e of events) if (e.correctionOfEventId !== null) correctedBy.set(e.correctionOfEventId, e.id);
    return events.map((e) => ({
      id: e.id,
      shiftId: e.shiftId,
      guardId: e.guardId,
      type: e.type === CHECK_OUT ? AttendanceEventType.CHECK_OUT : AttendanceEventType.CHECK_IN,
      occurredAt: e.occurredAt.toISOString(),
      recordedAt: e.recordedAt ? e.recordedAt.toISOString() : null,
      source: e.source === AttendanceSource.MANUAL ? 'manual' : 'guard_app',
      recordedByUserId: e.recordedByUserId,
      recordedByName: e.recordedByUserId !== null ? names.get(e.recordedByUserId) ?? null : null,
      reason: e.reason,
      verificationMethod: e.verificationMethod,
      verificationNote: e.verificationNote,
      correctionOfEventId: e.correctionOfEventId,
      correctedByEventId: correctedBy.get(e.id) ?? null,
      isCorrection: e.correctionOfEventId !== null,
      effective: !correctedBy.has(e.id),
      gpsVerified: Boolean(e.gpsVerified),
      nfcVerified: Boolean(e.nfcVerified),
    }));
  }
}
