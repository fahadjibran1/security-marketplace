import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { AttendanceEvent, AttendanceEventType } from '../attendance/entities/attendance.entity';
import {
  SafetyAlert,
  SafetyAlertStatus,
  SafetyAlertType,
} from '../safety-alert/entities/safety-alert.entity';
import { WELFARE_SWEEP_LOCK_NAMESPACE } from '../operations/advisory-locks';
import { Shift } from './entities/shift.entity';
import { ReconcileShiftDto } from './dto/reconcile-shift.dto';
import {
  MISSING_BOOK_OFF_REASON_FOR,
  RECONCILIATION_BOOK_OFF_GRACE_MINUTES,
  SHIFT_RECONCILIATION_REASONS,
  ShiftReconciliationReason,
  WELFARE_SUMMARY_REASON_FOR,
  reconciliationAlertNote,
} from './shift-reconciliation';

export type ShiftReconciliationResult = {
  shiftId: number;
  status: 'completed';
  reconciledAt: string;
  reason: ShiftReconciliationReason;
  closedAlertIds: number[];
};

/**
 * Close without Book Off (S4 Live Operations Phase 4).
 *
 * A Guard booked on and never booked off, the shift is over, and a person in the company's control room —
 * never the system — closes it with a stated reason. In ONE transaction:
 *
 *   - the shift moves in_progress → completed
 *   - its open Missing Book Off alert and open Welfare summary are closed with that reason
 *   - an audit entry records who, which company and shift, why, the schedule, the real Book On, when, and
 *     the status before and after
 *
 * and nothing else. No Book Off event is created and no departure time is invented: "completed with a Book
 * On and no Book Off" is exactly how every view tells a reconciled shift apart from a booked-off one. No
 * timesheet is created or changed (hours are a separate, evidence-backed company decision), attendance is
 * not rewritten, and no alert is deleted — closed alerts keep their history.
 *
 * The shift row is locked FOR UPDATE, so two controllers pressing at once are serialised: the second sees
 * a completed shift and is refused. The welfare sweep's per-shift advisory lock is taken too, so a sweep
 * can never open or close an alert on this shift half-way through.
 */
@Injectable()
export class ShiftReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly membershipService: CompanyMembershipService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async reconcileWithoutBookOff(
    user: JwtPayload,
    shiftId: number,
    dto: ReconcileShiftDto,
    now: Date = new Date(),
  ): Promise<ShiftReconciliationResult> {
    const reason = dto.reason;
    if (!SHIFT_RECONCILIATION_REASONS.includes(reason)) {
      throw new BadRequestException('Choose a reason for closing this shift without a Book Off.');
    }
    const note = dto.note?.trim() || null;
    if (reason === 'other' && !note) {
      throw new BadRequestException('Explain why the shift is being closed without a Book Off.');
    }

    // Shift-management permission in the caller's own company. Checked before anything is read.
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub,
      user.role,
      CompanyPermission.SHIFTS_MANAGE,
    );

    return this.dataSource.transaction(async (manager) => {
      const [row] = (await manager.query(
        'SELECT "id", "status", "start", "end", "companyId" FROM "shifts" WHERE "id" = $1 FOR UPDATE',
        [shiftId],
      )) as Array<{ id: number; status: string; start: Date; end: Date; companyId: number }>;
      // Another company's shift is reported exactly like one that does not exist.
      if (!row || Number(row.companyId) !== Number(company.id)) throw new NotFoundException('Shift not found');

      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [WELFARE_SWEEP_LOCK_NAMESPACE, row.id]);

      const status = (row.status || '').trim().toLowerCase();
      if (status === 'completed') {
        throw new ConflictException('This shift is already closed.');
      }
      if (status !== 'in_progress') {
        throw new BadRequestException('Only an in-progress shift can be closed without a Book Off.');
      }

      const events = await manager.getRepository(AttendanceEvent).find({
        where: { shift: { id: row.id } },
        order: { occurredAt: 'ASC', id: 'ASC' },
        loadEagerRelations: false,
      });
      const bookOn = events.find((event) => event.type === AttendanceEventType.CHECK_IN) ?? null;
      if (!bookOn) {
        throw new BadRequestException('This shift has no Book On, so there is nothing to close without a Book Off.');
      }
      if (events.some((event) => event.type === AttendanceEventType.CHECK_OUT)) {
        throw new ConflictException('A Book Off is already recorded for this shift.');
      }

      const scheduledEnd = new Date(row.end);
      const eligibleFrom = new Date(scheduledEnd.getTime() + RECONCILIATION_BOOK_OFF_GRACE_MINUTES * 60_000);
      if (now.getTime() <= eligibleFrom.getTime()) {
        throw new BadRequestException(
          'This shift is still within its scheduled time or the 15-minute Book Off grace, so it cannot be closed without a Book Off yet.',
        );
      }

      await manager.getRepository(Shift).update({ id: row.id }, { status: 'completed' });

      // The alerts this resolves: the open Missing Book Off and the open Welfare summary. Per-window Welfare
      // evidence is already closed and is left exactly as it is; every other alert type stays open.
      const alertRepo = manager.getRepository(SafetyAlert);
      const alerts = await alertRepo.find({
        where: [
          {
            shift: { id: row.id },
            type: SafetyAlertType.MISSING_BOOK_OFF,
            status: In([SafetyAlertStatus.OPEN, SafetyAlertStatus.ACKNOWLEDGED]),
          },
          {
            shift: { id: row.id },
            type: SafetyAlertType.MISSED_CHECKCALL,
            welfareWindowIndex: IsNull(),
            status: In([SafetyAlertStatus.OPEN, SafetyAlertStatus.ACKNOWLEDGED]),
          },
        ],
        order: { id: 'ASC' },
        loadEagerRelations: false,
      });

      const alertNote = reconciliationAlertNote(reason, note);
      const closedAlertIds: number[] = [];
      for (const alert of alerts) {
        const before = {
          status: alert.status,
          acknowledgedAt: alert.acknowledgedAt ?? null,
          acknowledgedByUserId: alert.acknowledgedByUserId ?? null,
          closedAt: alert.closedAt ?? null,
          closedByUserId: alert.closedByUserId ?? null,
          resolutionReason: alert.resolutionReason ?? null,
        };
        const resolutionReason = alert.type === SafetyAlertType.MISSING_BOOK_OFF
          ? MISSING_BOOK_OFF_REASON_FOR[reason]
          : WELFARE_SUMMARY_REASON_FOR[reason];
        const changes = {
          status: SafetyAlertStatus.CLOSED,
          acknowledgedAt: alert.acknowledgedAt ?? now,
          acknowledgedByUserId: alert.acknowledgedByUserId ?? user.sub,
          closedAt: now,
          closedByUserId: user.sub,
          resolutionReason,
          resolutionNote: alertNote,
        };
        await alertRepo.update({ id: alert.id }, changes);
        closedAlertIds.push(alert.id);
        await this.auditLogService.logInTransaction(manager, {
          company: { id: company.id },
          user: { id: user.sub },
          action: 'safety_alert.closed',
          entityType: 'safety_alert',
          entityId: alert.id,
          beforeData: before,
          afterData: { type: alert.type, ...changes, closedBy: 'shift_reconciliation', shiftId: row.id },
        });
      }

      await this.auditLogService.logInTransaction(manager, {
        company: { id: company.id },
        user: { id: user.sub },
        action: 'shift.reconciled_without_book_off',
        entityType: 'shift',
        entityId: row.id,
        beforeData: {
          shiftId: row.id,
          status: row.status,
          scheduledStart: new Date(row.start).toISOString(),
          scheduledEnd: scheduledEnd.toISOString(),
          bookOnAt: bookOn.occurredAt ? new Date(bookOn.occurredAt).toISOString() : null,
          bookOffAt: null,
        },
        afterData: {
          shiftId: row.id,
          status: 'completed',
          reason,
          note,
          reconciledAt: now.toISOString(),
          reconciledByUserId: user.sub,
          bookOffAt: null,
          closedAlertIds,
        },
      });

      return {
        shiftId: row.id,
        status: 'completed' as const,
        reconciledAt: now.toISOString(),
        reason,
        closedAlertIds,
      };
    });
  }
}
