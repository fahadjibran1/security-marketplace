import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, In, Repository } from 'typeorm';
import { Timesheet, TimesheetBillingStatus, TimesheetPayrollStatus, TimesheetStatus } from './entities/timesheet.entity';
import { Shift } from '../shift/entities/shift.entity';
import { UpdateTimesheetDto } from './dto/update-timesheet.dto';
import { UpdateTimesheetPayrollDto } from './dto/update-timesheet-payroll.dto';
import { CompanyService } from '../company/company.service';
import { ContractPricingService } from '../contract-pricing/contract-pricing.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  NotificationService,
} from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';
import { PayRuleService } from '../pay-rule/pay-rule.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { isCompanyRole, UserRole } from '../user/entities/user.entity';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { effectiveAttendance, groupAttendanceByShift } from '../attendance/effective-attendance';
import {
  guardHasClaimedHours,
  timesheetAttendanceDiscrepancy,
  timesheetIsSettled,
  verifiedAttendanceMinutes,
} from './timesheet-attendance';
import {
  buildTimesheetHistory,
  TIMESHEET_HISTORY_AUDIT_ACTIONS,
  timesheetDecisionNoticeMessage,
  TimesheetAuditRow,
  TimesheetHistoryItem,
  timesheetReviewReasonRefusal,
} from './timesheet-review';

@Injectable()
export class TimesheetService {
  constructor(
    @InjectRepository(Timesheet) private readonly timesheetRepo: Repository<Timesheet>,
    private readonly companyService: CompanyService,
    private readonly membershipService: CompanyMembershipService,
    private readonly contractPricingService: ContractPricingService,
    private readonly guardProfileService: GuardProfileService,
    private readonly auditLogService: AuditLogService,
    private readonly notificationService: NotificationService,
    private readonly payRuleService: PayRuleService,
  ) {}

  async findAll(): Promise<Timesheet[]> {
    const timesheets = await this.timesheetRepo.find();
    return this.withVerifiedAttendance(await this.applyDerivedFinancials(timesheets));
  }

  async findAllForUser(user: JwtPayload): Promise<Timesheet[]> {
    if (user.role === UserRole.ADMIN) {
      return this.findAll();
    }

    if (isCompanyRole(user.role)) {
      return this.findForCompany(user.sub, user.role);
    }

    return this.findMine(user.sub);
  }

  async findForCompany(userId: number, userRole: UserRole): Promise<Timesheet[]> {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole);

    const timesheets = await this.timesheetRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
    return this.withVerifiedAttendance(await this.applyDerivedFinancials(timesheets));
  }

  async findMine(userId: number): Promise<Timesheet[]> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    const timesheets = await this.buildGuardTimesheetQuery(guard.id)
      .orderBy('timesheet.createdAt', 'DESC')
      .getMany();
    return this.withVerifiedAttendance(await this.applyDerivedFinancials(timesheets));
  }

  async findOne(id: number): Promise<Timesheet> {
    const timesheet = await this.timesheetRepo.findOne({ where: { id } });
    if (!timesheet) throw new NotFoundException('Timesheet not found');
    return this.applyDerivedFinancials(timesheet);
  }

  /**
   * The timesheet's review history (submitted / returned / rejected / approved / approved-hours changes), derived from
   * the existing audit_logs entries, so a return reason and the previous claim stay visible after the Guard resubmits
   * (submitMine clears rejectionReason on the row). Readable by the owning Guard and the owning company (and admins);
   * anyone else gets 404. Items carry no ids; actors are shown by role and display name (see timesheet-review.ts).
   */
  async findHistory(user: JwtPayload, id: number): Promise<{ items: TimesheetHistoryItem[] }> {
    let companyId: number;
    let audience: 'guard' | 'company' = 'company';
    if (user.role === UserRole.ADMIN) {
      const timesheet = await this.timesheetRepo.findOne({ where: { id } });
      if (!timesheet) throw new NotFoundException('Timesheet not found');
      companyId = timesheet.company.id;
    } else if (user.role === UserRole.GUARD) {
      const guard = await this.guardProfileService.findByUserId(user.sub);
      if (!guard) throw new NotFoundException('Timesheet not found');
      const timesheet = await this.buildGuardTimesheetQuery(guard.id)
        .andWhere('timesheet.id = :timesheetId', { timesheetId: id })
        .getOne();
      if (!timesheet) throw new NotFoundException('Timesheet not found');
      companyId = timesheet.company.id;
      audience = 'guard';
    } else if (isCompanyRole(user.role)) {
      const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role);
      const timesheet = await this.timesheetRepo.findOne({ where: { id, company: { id: company.id } } });
      if (!timesheet) throw new NotFoundException('Timesheet not found');
      companyId = company.id;
    } else {
      throw new NotFoundException('Timesheet not found');
    }

    const rows = (await this.timesheetRepo.manager.query(
      `SELECT a."action", a."beforeData", a."afterData", a."createdAt", u."role"::text AS "role",
              u."firstName", u."lastName"
         FROM "audit_logs" a
         LEFT JOIN "users" u ON u."id" = a."userId"
        WHERE a."entityType" = 'timesheet' AND a."entityId" = $1 AND a."companyId" = $2 AND a."action" = ANY($3::text[])
        ORDER BY a."createdAt" ASC, a."id" ASC`,
      [id, companyId, [...TIMESHEET_HISTORY_AUDIT_ACTIONS]],
    )) as TimesheetAuditRow[];
    const parse = (value: unknown): Record<string, unknown> | null => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string') {
        try {
          return JSON.parse(value) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
      return value as Record<string, unknown>;
    };
    const items = buildTimesheetHistory(
      rows.map((r) => ({ ...r, beforeData: parse(r.beforeData), afterData: parse(r.afterData) })),
      audience,
    );
    return { items };
  }

  async createForShift(shift: Shift, manager?: EntityManager): Promise<Timesheet> {
    const timesheetRepo = manager?.getRepository(Timesheet) ?? this.timesheetRepo;
    const company = shift.company ?? shift.assignment?.company;
    const guard = shift.guard ?? shift.assignment?.guard;

    if (!company || !guard) {
      throw new NotFoundException('Shift is missing company or guard context for timesheet creation');
    }

    const timesheet = timesheetRepo.create({
      shift,
      company,
      guard,
      hoursWorked: 0,
      approvalStatus: TimesheetStatus.DRAFT,
      scheduledStartAt: shift.start ? new Date(shift.start) : null,
      scheduledEndAt: shift.end ? new Date(shift.end) : null,
      actualCheckInAt: shift.assignment?.checkedInAt ?? null,
      actualCheckOutAt: shift.assignment?.checkedOutAt ?? null,
      workedMinutes: 0,
      breakMinutes: 0,
      roundedMinutes: 0,
      payrollStatus: TimesheetPayrollStatus.UNPAID,
      payrollIncludedAt: null,
      payrollPaidAt: null,
      billingStatus: TimesheetBillingStatus.UNINVOICED,
      invoiceIssuedAt: null,
      invoicePaidAt: null,
      submittedAt: null,
      reviewedAt: null,
      reviewedByUserId: null,
      rejectionReason: null,
    });

    const saved = await timesheetRepo.save(timesheet);
    return this.applyDerivedFinancials(saved);
  }

  async updateAsAdmin(userId: number, id: number, dto: UpdateTimesheetDto): Promise<Timesheet> {
    const timesheet = await this.findOne(id);
    this.validateAdminCorrection(timesheet, dto);
    const reason = dto.correctionReason!.trim();
    const beforeData = this.adminCorrectionSnapshot(timesheet, reason);

    this.applyAdminEditableUpdates(timesheet, dto);
    let overrideApplied = false;
    if (dto.approvedMinutes !== undefined || dto.approvedHours !== undefined) {
      overrideApplied = this.applyApprovalDuration(
        timesheet,
        { ...dto, overrideReason: reason },
        userId,
      );
    }

    const saved = await this.timesheetRepo.save(timesheet);
    await this.auditLogService.log({
      company: saved.company,
      user: { id: userId },
      action: 'timesheet.admin_corrected',
      entityType: 'timesheet',
      entityId: saved.id,
      beforeData,
      afterData: this.adminCorrectionSnapshot(saved, reason),
    });
    if (overrideApplied) {
      await this.auditLogService.log({
        company: saved.company,
        user: { id: userId },
        action: 'timesheet.approved_duration_overridden',
        entityType: 'timesheet',
        entityId: saved.id,
        beforeData: { verifiedMinutes: saved.verifiedMinutes },
        afterData: {
          approvedMinutes: saved.approvedMinutes,
          overrideReason: saved.overrideReason,
          overrideBy: saved.overrideBy,
          overrideAt: saved.overrideAt,
        },
      });
    }
    return this.applyDerivedFinancials(saved);
  }

  async updateMine(userId: number, id: number, dto: UpdateTimesheetDto): Promise<Timesheet> {
    const timesheet = await this.getGuardOwnedEditableTimesheet(userId, id, 'edited');
    this.applyGuardEditableUpdates(timesheet, dto);
    const saved = await this.timesheetRepo.save(timesheet);
    return this.applyDerivedFinancials(saved);
  }

  async updateForCompany(userId: number, userRole: UserRole, id: number, dto: UpdateTimesheetDto): Promise<Timesheet> {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.TIMESHEETS_REVIEW);

    const timesheet = await this.timesheetRepo.findOne({
      where: { id, company: { id: company.id } },
    });
    if (!timesheet) throw new NotFoundException('Timesheet not found');

    const beforeData = {
      approvalStatus: timesheet.approvalStatus,
      approvedHours: timesheet.approvedHours,
      companyNote: timesheet.companyNote,
      rejectionReason: timesheet.rejectionReason,
      reviewedAt: timesheet.reviewedAt,
      reviewedByUserId: timesheet.reviewedByUserId,
    };

    const currentStatus = String(timesheet.approvalStatus).trim().toLowerCase();
    const approvedNoteOnlyUpdate =
      currentStatus === TimesheetStatus.APPROVED &&
      dto.companyNote !== undefined &&
      dto.approvalStatus === undefined &&
      dto.approvedHours === undefined &&
      dto.approvedMinutes === undefined &&
      dto.overrideReason === undefined &&
      dto.rejectionReason === undefined &&
      dto.companyApprovedStartAt === undefined &&
      dto.companyApprovedEndAt === undefined;
    if (approvedNoteOnlyUpdate) {
      const trimmedCompanyNote = dto.companyNote?.trim();
      timesheet.companyNote = trimmedCompanyNote ? trimmedCompanyNote : null;
      const saved = await this.timesheetRepo.save(timesheet);
      await this.auditLogService.log({
        company,
        user: { id: userId },
        action: 'timesheet.company_note_updated',
        entityType: 'timesheet',
        entityId: saved.id,
        beforeData,
        afterData: {
          approvalStatus: saved.approvalStatus,
          approvedHours: saved.approvedHours,
          companyNote: saved.companyNote,
          rejectionReason: saved.rejectionReason,
          reviewedAt: saved.reviewedAt,
          reviewedByUserId: saved.reviewedByUserId,
        },
      });
      return this.applyDerivedFinancials(saved);
    }

    // Approved timesheets allow updating companyApprovedStartAt/EndAt before weekly client submission.
    // This is a separate operation from internal approval — the company sets client-facing approved times.
    const approvedTimeUpdate =
      currentStatus === TimesheetStatus.APPROVED &&
      (dto.companyApprovedStartAt !== undefined || dto.companyApprovedEndAt !== undefined) &&
      dto.approvalStatus === undefined &&
      dto.rejectionReason === undefined;
    if (approvedTimeUpdate) {
      // P1H-C freeze: once a Client submission exists (active non-superseded line),
      // Layer 4 payroll fields cannot be changed via the generic PATCH. Use the
      // controlled Client billing correction endpoint (/revise-approved-time) instead.
      const activeRows = await this.timesheetRepo.manager.query(
        `SELECT COUNT(*)::int AS count FROM "client_weekly_approval_lines" WHERE "timesheetId" = $1 AND "superseded" = FALSE`,
        [timesheet.id],
      );
      if (Number(activeRows[0]?.count ?? 0) > 0) {
        throw new ForbiddenException(
          'Approved time cannot be changed after Client submission. If the request is disputed, use the controlled Client billing correction workflow.',
        );
      }

      if (dto.companyApprovedStartAt === null && dto.companyApprovedEndAt === null) {
        this.clearApprovalDuration(timesheet);
      } else {
        this.applyApprovalDuration(timesheet, dto, userId);
      }
      const saved = await this.timesheetRepo.save(timesheet);
      await this.auditLogService.log({
        company,
        user: { id: userId },
        action: 'timesheet.company_approved_times_updated',
        entityType: 'timesheet',
        entityId: saved.id,
        beforeData,
        afterData: {
          companyApprovedStartAt: saved.companyApprovedStartAt,
          companyApprovedEndAt: saved.companyApprovedEndAt,
          approvedMinutes: saved.approvedMinutes,
          overrideReason: saved.overrideReason,
        },
      });
      return this.applyDerivedFinancials(saved);
    }

    this.validateCompanyReviewRequest(timesheet, dto);
    this.applyTimesheetUpdates(timesheet, dto);

    let overrideApplied = false;
    if (dto.approvalStatus === TimesheetStatus.APPROVED) {
      timesheet.reviewedAt = new Date();
      timesheet.reviewedByUserId = userId;
      overrideApplied = this.applyApprovalDuration(timesheet, dto, userId);
      if (!timesheet.payrollStatus) {
        timesheet.payrollStatus = TimesheetPayrollStatus.UNPAID;
      }
      if (!timesheet.billingStatus) {
        timesheet.billingStatus = TimesheetBillingStatus.UNINVOICED;
      }
      timesheet.rejectionReason = null;
    } else if (dto.approvalStatus === TimesheetStatus.REJECTED) {
      timesheet.rejectionReason = dto.rejectionReason!.trim();
      timesheet.reviewedAt = new Date();
      timesheet.reviewedByUserId = userId;
      this.clearApprovalDuration(timesheet);
      timesheet.payrollStatus = TimesheetPayrollStatus.UNPAID;
      timesheet.payrollIncludedAt = null;
      timesheet.payrollPaidAt = null;
      timesheet.billingStatus = TimesheetBillingStatus.UNINVOICED;
      timesheet.invoiceIssuedAt = null;
      timesheet.invoicePaidAt = null;
      timesheet.invoiceBatch = null;
    } else if (dto.approvalStatus === TimesheetStatus.RETURNED) {
      timesheet.rejectionReason = dto.rejectionReason!.trim();
      timesheet.reviewedAt = new Date();
      timesheet.reviewedByUserId = userId;
      this.clearApprovalDuration(timesheet);
      timesheet.payrollStatus = TimesheetPayrollStatus.UNPAID;
      timesheet.payrollIncludedAt = null;
      timesheet.payrollPaidAt = null;
      timesheet.billingStatus = TimesheetBillingStatus.UNINVOICED;
      timesheet.invoiceIssuedAt = null;
      timesheet.invoicePaidAt = null;
      timesheet.invoiceBatch = null;
    }
    const saved = await this.timesheetRepo.save(timesheet);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action:
        saved.approvalStatus === TimesheetStatus.APPROVED
          ? 'timesheet.approved'
          : saved.approvalStatus === TimesheetStatus.RETURNED
            ? 'timesheet.returned'
            : saved.approvalStatus === TimesheetStatus.REJECTED
              ? 'timesheet.rejected'
              : 'timesheet.reviewed',
      entityType: 'timesheet',
      entityId: saved.id,
      beforeData,
      afterData: {
        approvalStatus: saved.approvalStatus,
        approvedHours: saved.approvedHours,
        verifiedMinutes: saved.verifiedMinutes,
        approvedMinutes: saved.approvedMinutes,
        overrideReason: saved.overrideReason,
        overrideBy: saved.overrideBy,
        overrideAt: saved.overrideAt,
        companyNote: saved.companyNote,
        rejectionReason: saved.rejectionReason,
        reviewedAt: saved.reviewedAt,
        reviewedByUserId: saved.reviewedByUserId,
      },
    });

    if (overrideApplied) {
      await this.auditLogService.log({
        company,
        user: { id: userId },
        action: 'timesheet.approved_duration_overridden',
        entityType: 'timesheet',
        entityId: saved.id,
        beforeData: { verifiedMinutes: saved.verifiedMinutes },
        afterData: {
          approvedMinutes: saved.approvedMinutes,
          overrideReason: saved.overrideReason,
          overrideBy: saved.overrideBy,
          overrideAt: saved.overrideAt,
        },
      });
    }

    if (saved.guard?.user?.id) {
      const isApproved = saved.approvalStatus === TimesheetStatus.APPROVED;
      const isReturned = saved.approvalStatus === TimesheetStatus.RETURNED;
      await this.notificationService.createForUser({
        userId: saved.guard.user.id,
        company,
        type: isApproved
          ? NotificationType.TIMESHEET_APPROVED
          : NotificationType.TIMESHEET_REJECTED,
        title: isApproved
          ? 'Timesheet approved'
          : isReturned
            ? 'Timesheet returned'
            : 'Timesheet rejected',
        // A return / reject notice carries the reason (in-app only: timesheet notices are never pushed).
        message: isApproved
          ? `Your timesheet for shift #${saved.shift?.id ?? saved.id} has been approved.`
          : timesheetDecisionNoticeMessage(isReturned ? 'returned' : 'rejected', saved.shift?.id ?? saved.id, saved.rejectionReason),
      });
    }

    return this.applyDerivedFinancials(saved);
  }

  // RB-007: called only from attendance.service.ts checkOut(), once both the
  // CHECK_IN and CHECK_OUT events have real server timestamps. verifiedMinutes
  // is the attendance-verified duration and is never guard- or company-editable
  // (it's not part of applyGuardEditableUpdates or the company review DTO path).
  async updateHoursForShift(
    shiftId: number,
    input: { hoursWorked: number; verifiedMinutes: number },
  ): Promise<Timesheet> {
    const timesheet = await this.timesheetRepo.findOne({ where: { shift: { id: shiftId } } });
    if (!timesheet) throw new NotFoundException('Timesheet not found');

    const workedMinutes = Math.max(0, Math.round(input.hoursWorked * 60));
    timesheet.hoursWorked = input.hoursWorked;
    timesheet.workedMinutes = workedMinutes;
    timesheet.roundedMinutes = workedMinutes;
    timesheet.verifiedMinutes = Math.max(0, Math.round(input.verifiedMinutes));
    timesheet.actualCheckInAt = timesheet.shift.assignment?.checkedInAt ?? timesheet.actualCheckInAt ?? null;
    timesheet.actualCheckOutAt = timesheet.shift.assignment?.checkedOutAt ?? timesheet.actualCheckOutAt ?? null;
    const saved = await this.timesheetRepo.save(timesheet);
    return this.applyDerivedFinancials(saved);
  }

  /**
   * Book Off: a worked Shift has exactly one Timesheet, and it carries the attendance-verified duration. Runs inside
   * the caller's Book Off transaction (`manager`).
   *
   *  - The Shift row is locked first, so concurrent Book Offs and the create-if-missing paths serialise and can never
   *    both create a Timesheet.
   *  - A Timesheet that already exists (any creation path — Shift create/assign, an earlier Book Off) is reused.
   *    Rota-created Shifts never had one, which is why Book Off used to fail with "Timesheet not found".
   *  - verifiedMinutes / verifiedSource (the attendance evidence and the approval default) are stamped once, keyed on
   *    verifiedMinutes being unset — NOT on the Guard's claimed check-out, which the Guard may have typed already
   *    (that used to leave the timesheet with no verified minutes at all). A retried Book Off is a no-op.
   *  - The Guard's claim (actualCheckInAt / actualCheckOutAt, hoursWorked / workedMinutes / roundedMinutes) is only
   *    PRE-FILLED: each claimed time only while it is empty, the hours only while the Guard has entered none. A
   *    Timesheet created by this call (e.g. a marketplace hire whose assignment stamps were copied in a moment ago)
   *    holds no Guard input, so it is filled in full.
   *  - An approved, rejected or payroll-batched Timesheet is never touched (see timesheetIsSettled). The attendance is
   *    still recorded by the caller; the difference is shown beside the timesheet (attendanceDiscrepancy) for review.
   */
  async recordAttendanceActuals(
    manager: EntityManager,
    shiftId: number,
    actuals: { checkInAt: Date; checkOutAt: Date },
    options: {
      /** Where the actuals come from (Migration 67, informational). Default: the Guard app. */
      verifiedSource?: 'guard_app' | 'manual' | 'corrected';
      /**
       * The caller already holds a lock on the shift row that conflicts with every FOR UPDATE (manual attendance holds
       * FOR NO KEY UPDATE and the welfare-sweep lock, in the reconciliation order). Re-locking FOR UPDATE here would
       * upgrade that lock and could deadlock with a transaction holding FOR KEY SHARE on the shift, so it is skipped.
       */
      shiftLocked?: boolean;
    } = {},
  ): Promise<Timesheet> {
    if (!options.shiftLocked) {
      const locked: Array<{ id: number }> = await manager.query('SELECT "id" FROM "shifts" WHERE "id" = $1 FOR UPDATE', [
        shiftId,
      ]);
      if (locked.length === 0) throw new NotFoundException('Shift not found');
    }

    const timesheetRepo = manager.getRepository(Timesheet);
    let timesheet = await timesheetRepo.findOne({ where: { shift: { id: shiftId } }, order: { id: 'ASC' } });
    let createdNow = false;
    if (!timesheet) {
      const shift = await manager.getRepository(Shift).findOne({ where: { id: shiftId } });
      if (!shift) throw new NotFoundException('Shift not found');
      timesheet = await this.createForShift(shift, manager);
      createdNow = true;
    }
    if (timesheetIsSettled(timesheet)) return timesheet;
    if (!createdNow && timesheet.verifiedMinutes !== null && timesheet.verifiedMinutes !== undefined) return timesheet;

    const verifiedMinutes = Math.max(0, Math.round((actuals.checkOutAt.getTime() - actuals.checkInAt.getTime()) / 60000));
    timesheet.verifiedMinutes = verifiedMinutes;
    timesheet.verifiedSource = options.verifiedSource ?? 'guard_app';
    if (createdNow || !timesheet.actualCheckInAt) timesheet.actualCheckInAt = actuals.checkInAt;
    if (createdNow || !timesheet.actualCheckOutAt) timesheet.actualCheckOutAt = actuals.checkOutAt;
    if (createdNow || !guardHasClaimedHours(timesheet)) {
      const hoursWorked = Number((verifiedMinutes / 60).toFixed(2));
      const workedMinutes = Math.max(0, Math.round(hoursWorked * 60));
      timesheet.hoursWorked = hoursWorked;
      timesheet.workedMinutes = workedMinutes;
      timesheet.roundedMinutes = workedMinutes;
    }
    const saved = await timesheetRepo.save(timesheet);
    return this.applyDerivedFinancials(saved);
  }

  /**
   * The verified attendance of each timesheet's shift, beside the Guard's claim, for the review screens. Read from the
   * shift's append-only attendance events (effective Book On / Book Off), never from the timesheet's claimed columns,
   * so it is right for every timesheet — including an approved one whose attendance changed after approval, which is
   * flagged rather than rewritten. One indexed read for the whole list; nothing is written.
   */
  async withVerifiedAttendance<T extends Timesheet | Timesheet[]>(timesheetOrTimesheets: T): Promise<T> {
    const list = (Array.isArray(timesheetOrTimesheets) ? timesheetOrTimesheets : [timesheetOrTimesheets]) as Timesheet[];
    const shiftIds = [...new Set(list.map((t) => t.shift?.id).filter((id): id is number => typeof id === 'number'))];
    const rows = shiftIds.length
      ? ((await this.timesheetRepo.manager.query(
          `SELECT "id", "shiftId", "type"::text AS "type", "occurredAt", "recordedAt", "source", "correctionOfEventId"
             FROM "attendance_events" WHERE "shiftId" = ANY($1::int[])`,
          [shiftIds],
        )) as Array<{ id: number; shiftId: number; type: string; occurredAt: Date; recordedAt: Date | null; source: string | null;
          correctionOfEventId: number | null }>)
      : [];
    const byShift = groupAttendanceByShift(
      rows.map((r) => ({ ...r, id: Number(r.id), shiftId: Number(r.shiftId),
        correctionOfEventId: r.correctionOfEventId === null ? null : Number(r.correctionOfEventId) })),
    );
    for (const timesheet of list) {
      const effective = effectiveAttendance(byShift.get(Number(timesheet.shift?.id)) ?? []);
      timesheet.verifiedCheckInAt = effective.bookOnAt;
      timesheet.verifiedCheckOutAt = effective.bookOffAt;
      timesheet.verifiedAttendanceMinutes = verifiedAttendanceMinutes(effective.bookOnAt, effective.bookOffAt);
      timesheet.attendanceDiscrepancy = timesheetAttendanceDiscrepancy({
        approvalStatus: timesheet.approvalStatus,
        verifiedCheckInAt: effective.bookOnAt,
        verifiedCheckOutAt: effective.bookOffAt,
        claimedCheckInAt: timesheet.actualCheckInAt,
        claimedCheckOutAt: timesheet.actualCheckOutAt,
        claimedHours: timesheet.hoursWorked,
        approvedMinutes: timesheet.approvedMinutes,
        approvedHours: timesheet.approvedHours,
        approvedStartAt: timesheet.companyApprovedStartAt,
        approvedEndAt: timesheet.companyApprovedEndAt,
      });
    }
    return timesheetOrTimesheets;
  }

  /**
   * Manual attendance correction (Migration 67): the effective Book On / Book Off changed, so the timesheet's
   * attendance-verified actuals follow it — ONLY while the timesheet is still in the ordinary workflow (draft,
   * submitted or returned) and not in a payroll batch. The caller refuses the correction before calling this when the
   * timesheet is locked; this re-checks under the timesheet row lock and refuses the same way.
   *
   * verifiedMinutes / verifiedSource are restamped. The Guard's claim follows attendance only where the Guard has not
   * entered anything of their own: a claimed time moves only while it is empty or still equals the attendance time it
   * was pre-filled from (`previous`, the effective attendance before this correction); the claimed hours (hoursWorked /
   * workedMinutes / roundedMinutes) only while they are unset or still equal what attendance stamped. A Guard's own
   * edit is never overwritten. Approval itself is unchanged: the company approves through the existing review, which
   * defaults approved minutes to verifiedMinutes.
   *
   * Returns whether the verified duration was restamped and the timesheet's status (null when the shift has no
   * timesheet; restamped false while there is no Book Off yet, e.g. a corrected Book On on a shift still in progress).
   */
  async restampAttendanceActuals(
    manager: EntityManager,
    shiftId: number,
    actuals: { checkInAt: Date; checkOutAt: Date | null },
    previous: { checkInAt: Date | null; checkOutAt: Date | null },
    verifiedSource: 'guard_app' | 'manual' | 'corrected',
    isLocked: (row: { approvalStatus: string; payrollBatchId: number | null }) => boolean,
    onLocked: () => Error,
  ): Promise<{ restamped: boolean; approvalStatus: string | null }> {
    const [row] = (await manager.query(
      `SELECT "id", "approvalStatus"::text AS "approvalStatus", "payrollBatchId", "actualCheckInAt", "actualCheckOutAt",
              "verifiedMinutes", "workedMinutes", "hoursWorked"
         FROM "timesheets" WHERE "shiftId" = $1 ORDER BY "id" ASC LIMIT 1 FOR UPDATE`,
      [shiftId],
    )) as Array<{ id: number; approvalStatus: string; payrollBatchId: number | null; actualCheckInAt: Date | null;
      actualCheckOutAt: Date | null; verifiedMinutes: number | null; workedMinutes: number; hoursWorked: string | number }>;
    if (!row) return { restamped: false, approvalStatus: null };
    if (isLocked({ approvalStatus: row.approvalStatus, payrollBatchId: row.payrollBatchId === null ? null : Number(row.payrollBatchId) })) {
      throw onLocked();
    }
    // A claimed time follows attendance only while it is empty or still the attendance time it was pre-filled from.
    const follows = (claimed: Date | null, prior: Date | null) =>
      claimed === null || (prior !== null && new Date(claimed).getTime() === prior.getTime());
    const moveIn = follows(row.actualCheckInAt, previous.checkInAt);
    if (!actuals.checkOutAt) {
      // No Book Off yet (the Book Off will stamp the verified duration). Only an untouched claimed Book On moves.
      if (moveIn) {
        await manager.query(`UPDATE "timesheets" SET "actualCheckInAt" = $2, "updatedAt" = now() WHERE "id" = $1`, [row.id, actuals.checkInAt]);
      }
      return { restamped: false, approvalStatus: row.approvalStatus };
    }
    const moveOut = follows(row.actualCheckOutAt, previous.checkOutAt);
    const derived = (minutes: number) => {
      const hours = Number((minutes / 60).toFixed(2));
      return { hours, worked: Math.max(0, Math.round(hours * 60)) };
    };
    const verifiedMinutes = Math.max(0, Math.round((actuals.checkOutAt.getTime() - actuals.checkInAt.getTime()) / 60000));
    const next = derived(verifiedMinutes);
    const prior = row.verifiedMinutes === null ? null : derived(Number(row.verifiedMinutes));
    const claimedUntouched = !guardHasClaimedHours(row)
      || (prior !== null && Number(row.workedMinutes) === prior.worked && Number(row.hoursWorked) === prior.hours);
    await manager.query(
      `UPDATE "timesheets" SET "verifiedMinutes" = $2, "verifiedSource" = $3,
              "actualCheckInAt" = CASE WHEN $4 THEN $5::timestamp ELSE "actualCheckInAt" END,
              "actualCheckOutAt" = CASE WHEN $6 THEN $7::timestamp ELSE "actualCheckOutAt" END,
              "hoursWorked" = CASE WHEN $8 THEN $9 ELSE "hoursWorked" END,
              "workedMinutes" = CASE WHEN $8 THEN $10 ELSE "workedMinutes" END,
              "roundedMinutes" = CASE WHEN $8 THEN $10 ELSE "roundedMinutes" END,
              "updatedAt" = now()
        WHERE "id" = $1`,
      [row.id, verifiedMinutes, verifiedSource, moveIn, actuals.checkInAt, moveOut, actuals.checkOutAt, claimedUntouched, next.hours, next.worked],
    );
    return { restamped: true, approvalStatus: row.approvalStatus };
  }

  async submitMine(userId: number, id: number, dto: UpdateTimesheetDto): Promise<Timesheet> {
    const timesheet = await this.getGuardOwnedEditableTimesheet(userId, id, 'submitted');
    const beforeData = {
      approvalStatus: timesheet.approvalStatus,
      hoursWorked: timesheet.hoursWorked,
      guardNote: timesheet.guardNote,
      submittedAt: timesheet.submittedAt,
    };
    this.applyGuardEditableUpdates(timesheet, dto);
    timesheet.approvalStatus = TimesheetStatus.SUBMITTED;
    timesheet.submittedAt = new Date();
    this.clearApprovalDuration(timesheet);
    timesheet.payrollStatus = TimesheetPayrollStatus.UNPAID;
    timesheet.payrollIncludedAt = null;
    timesheet.payrollPaidAt = null;
    timesheet.billingStatus = TimesheetBillingStatus.UNINVOICED;
    timesheet.invoiceIssuedAt = null;
    timesheet.invoicePaidAt = null;
    timesheet.invoiceBatch = null;
    timesheet.reviewedAt = null;
    timesheet.reviewedByUserId = null;
    timesheet.rejectionReason = null;
    const saved = await this.timesheetRepo.save(timesheet);
    await this.auditLogService.log({
      company: saved.company,
      user: { id: userId },
      action: 'timesheet.submitted',
      entityType: 'timesheet',
      entityId: saved.id,
      beforeData,
      afterData: {
        approvalStatus: saved.approvalStatus,
        submittedAt: saved.submittedAt,
        hoursWorked: saved.hoursWorked,
        actualCheckInAt: saved.actualCheckInAt,
        actualCheckOutAt: saved.actualCheckOutAt,
        guardNote: saved.guardNote,
        approvedHours: saved.approvedHours,
        companyNote: saved.companyNote,
        workedMinutes: saved.workedMinutes,
        roundedMinutes: saved.roundedMinutes,
      },
    });

    if (saved.company?.user?.id) {
      await this.notificationService.createForUser({
        userId: saved.company.user.id,
        company: saved.company,
        type: NotificationType.TIMESHEET_SUBMITTED,
        title: 'Timesheet submitted',
        message: `${saved.guard?.user?.firstName ?? 'A guard'} submitted a timesheet for shift #${saved.shift?.id ?? saved.id}.`,
      });
    }

    return this.applyDerivedFinancials(saved);
  }

  async updatePayrollForCompany(userId: number, userRole: UserRole, dto: UpdateTimesheetPayrollDto): Promise<Timesheet[]> {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.PAYROLL_MANAGE);
    return this.applyPayrollUpdate({ companyId: company.id, userId, dto });
  }

  async updatePayrollAsAdmin(userId: number, dto: UpdateTimesheetPayrollDto): Promise<Timesheet[]> {
    return this.applyPayrollUpdate({ userId, dto });
  }

  private applyTimesheetUpdates(timesheet: Timesheet, dto: UpdateTimesheetDto): void {
    if (dto.hoursWorked !== undefined) {
      timesheet.hoursWorked = dto.hoursWorked;
      if (dto.workedMinutes === undefined) {
        timesheet.workedMinutes = Math.max(0, Math.round(dto.hoursWorked * 60));
      }
    }
    if (dto.approvalStatus !== undefined) timesheet.approvalStatus = dto.approvalStatus;
    if (dto.submittedAt !== undefined) {
      timesheet.submittedAt = dto.submittedAt ? new Date(dto.submittedAt) : null;
    }
    if (dto.actualCheckInAt !== undefined) {
      timesheet.actualCheckInAt = dto.actualCheckInAt ? new Date(dto.actualCheckInAt) : null;
    }
    if (dto.actualCheckOutAt !== undefined) {
      timesheet.actualCheckOutAt = dto.actualCheckOutAt ? new Date(dto.actualCheckOutAt) : null;
    }
    if (dto.guardNote !== undefined) {
      const trimmedGuardNote = dto.guardNote?.trim();
      timesheet.guardNote = trimmedGuardNote ? trimmedGuardNote : null;
    }
    if (dto.companyNote !== undefined) {
      const trimmedCompanyNote = dto.companyNote?.trim();
      timesheet.companyNote = trimmedCompanyNote ? trimmedCompanyNote : null;
    }
    // RB-007: approvedHours/approvedMinutes are deliberately NOT set here. They are
    // payroll-authoritative and can only change via applyApprovalDuration(), which
    // enforces the verified-attendance-default + override-reason gate. A raw
    // dto.approvedHours passthrough would let a reviewer bypass that gate entirely.
    if (dto.workedMinutes !== undefined) timesheet.workedMinutes = dto.workedMinutes;
    if (dto.breakMinutes !== undefined) timesheet.breakMinutes = dto.breakMinutes;
    if (dto.roundedMinutes !== undefined) timesheet.roundedMinutes = dto.roundedMinutes;
    if (dto.rejectionReason !== undefined) timesheet.rejectionReason = dto.rejectionReason;
  }

  private applyAdminEditableUpdates(timesheet: Timesheet, dto: UpdateTimesheetDto): void {
    this.applyTimesheetUpdates(timesheet, {
      hoursWorked: dto.hoursWorked,
      guardNote: dto.guardNote,
      companyNote: dto.companyNote,
      workedMinutes: dto.workedMinutes,
      breakMinutes: dto.breakMinutes,
      roundedMinutes: dto.roundedMinutes,
    });
  }

  private validateAdminCorrection(timesheet: Timesheet, dto: UpdateTimesheetDto): void {
    const input = dto as Record<string, unknown>;
    const reason = dto.correctionReason?.trim();
    if (!reason) {
      throw new BadRequestException('An admin correction reason is required.');
    }

    const serverControlledFields = [
      'verifiedMinutes',
      'actualCheckInAt',
      'actualCheckOutAt',
      'reviewedByUserId',
      'reviewedAt',
      'overrideBy',
      'overrideAt',
      'submittedAt',
    ];
    if (serverControlledFields.some((field) => Object.prototype.hasOwnProperty.call(input, field))) {
      throw new BadRequestException('Admin correction cannot change system-derived attendance or review identity.');
    }

    if (dto.approvalStatus !== undefined || dto.rejectionReason !== undefined || dto.overrideReason !== undefined) {
      throw new BadRequestException('Admin correction cannot bypass timesheet status workflows.');
    }

    const currentStatus = String(timesheet.approvalStatus).trim().toLowerCase();
    if (currentStatus === TimesheetStatus.REJECTED) {
      throw new ForbiddenException('Rejected timesheets are final and cannot be corrected.');
    }

    const durationRequested = dto.approvedMinutes !== undefined || dto.approvedHours !== undefined;
    if (durationRequested && currentStatus !== TimesheetStatus.APPROVED) {
      throw new ForbiddenException('Approved duration can only be corrected on an approved timesheet.');
    }

    const payrollFinal =
      timesheet.payrollStatus === TimesheetPayrollStatus.PAID ||
      !!timesheet.payrollPaidAt ||
      !!timesheet.payrollBatch;
    const invoiceFinal =
      timesheet.billingStatus === TimesheetBillingStatus.INVOICED ||
      !!timesheet.invoiceIssuedAt ||
      !!timesheet.invoicePaidAt ||
      !!timesheet.invoiceBatch;
    if (payrollFinal || invoiceFinal) {
      throw new ForbiddenException('Financially committed timesheets cannot be corrected.');
    }
  }

  private adminCorrectionSnapshot(timesheet: Timesheet, reason: string): Record<string, unknown> {
    return {
      reason,
      companyId: timesheet.company?.id ?? null,
      approvalStatus: timesheet.approvalStatus,
      hoursWorked: timesheet.hoursWorked,
      workedMinutes: timesheet.workedMinutes,
      breakMinutes: timesheet.breakMinutes,
      roundedMinutes: timesheet.roundedMinutes,
      verifiedMinutes: timesheet.verifiedMinutes,
      approvedMinutes: timesheet.approvedMinutes,
      approvedHours: timesheet.approvedHours,
      reviewedByUserId: timesheet.reviewedByUserId,
      reviewedAt: timesheet.reviewedAt,
      overrideReason: timesheet.overrideReason,
      overrideBy: timesheet.overrideBy,
      overrideAt: timesheet.overrideAt,
      payrollStatus: timesheet.payrollStatus,
      payrollBatchId: timesheet.payrollBatch?.id ?? null,
      billingStatus: timesheet.billingStatus,
      invoiceBatchId: timesheet.invoiceBatch?.id ?? null,
      companyNote: timesheet.companyNote,
      guardNote: timesheet.guardNote,
    };
  }

  private applyGuardEditableUpdates(timesheet: Timesheet, dto: UpdateTimesheetDto): void {
    this.applyTimesheetUpdates(timesheet, {
      hoursWorked: dto.hoursWorked,
      actualCheckInAt: dto.actualCheckInAt,
      actualCheckOutAt: dto.actualCheckOutAt,
      guardNote: dto.guardNote,
      workedMinutes: dto.workedMinutes,
      breakMinutes: dto.breakMinutes,
      roundedMinutes: dto.roundedMinutes,
    });
  }

  // RB-007: sets the payroll-authoritative approvedMinutes on approval.
  // Defaults to the attendance-verified duration (timesheet.verifiedMinutes).
  // A reviewer may request a different duration (via dto.approvedMinutes, or
  // legacy dto.approvedHours converted to minutes), but that is an override:
  // it requires a non-empty overrideReason, and overrideBy/overrideAt are
  // always server-derived (never accepted from the client). Returns true if
  // an override was applied, so the caller can emit a dedicated audit entry.
  private applyApprovalDuration(timesheet: Timesheet, dto: UpdateTimesheetDto, userId: number): boolean {
    const verifiedMinutes =
      timesheet.verifiedMinutes === undefined || timesheet.verifiedMinutes === null
        ? null
        : Math.round(Number(timesheet.verifiedMinutes));

    let requestedMinutes: number | null;

    if (dto.companyApprovedStartAt && dto.companyApprovedEndAt) {
      const startMs = new Date(dto.companyApprovedStartAt).getTime();
      const endMs = new Date(dto.companyApprovedEndAt).getTime();
      if (isNaN(startMs) || isNaN(endMs)) {
        throw new BadRequestException('Invalid companyApprovedStartAt or companyApprovedEndAt timestamp.');
      }
      if (endMs <= startMs) {
        throw new BadRequestException('Approved end time must be after approved start time.');
      }
      requestedMinutes = Math.round((endMs - startMs) / 60000);
      timesheet.companyApprovedStartAt = new Date(dto.companyApprovedStartAt);
      timesheet.companyApprovedEndAt = new Date(dto.companyApprovedEndAt);
    } else {
      requestedMinutes = this.resolveRequestedApprovedMinutes(dto, verifiedMinutes);
    }

    if (requestedMinutes === null) {
      throw new BadRequestException(
        'No verified attendance duration is available for this shift. Provide approvedMinutes and an overrideReason to approve it.',
      );
    }

    if (!Number.isFinite(requestedMinutes) || requestedMinutes < 0) {
      throw new BadRequestException('Approved minutes must be 0 or more.');
    }

    const isOverride = verifiedMinutes === null || requestedMinutes !== verifiedMinutes;

    if (isOverride) {
      const overrideReason = dto.overrideReason?.trim();
      if (!overrideReason) {
        throw new BadRequestException(
          'An override reason is required when approved duration differs from verified attendance duration.',
        );
      }
      timesheet.overrideReason = overrideReason;
      timesheet.overrideBy = userId;
      timesheet.overrideAt = new Date();
    } else {
      timesheet.overrideReason = null;
      timesheet.overrideBy = null;
      timesheet.overrideAt = null;
    }

    timesheet.approvedMinutes = requestedMinutes;
    timesheet.approvedHours = Math.round((requestedMinutes / 60) * 100) / 100;

    return isOverride;
  }

  private resolveRequestedApprovedMinutes(dto: UpdateTimesheetDto, verifiedMinutes: number | null): number | null {
    if (dto.approvedMinutes !== undefined && dto.approvedMinutes !== null) {
      return Math.round(Number(dto.approvedMinutes));
    }
    if (dto.approvedHours !== undefined && dto.approvedHours !== null) {
      return Math.round(Number(dto.approvedHours) * 60);
    }
    return verifiedMinutes;
  }

  private clearApprovalDuration(timesheet: Timesheet): void {
    timesheet.approvedHours = null;
    timesheet.approvedMinutes = null;
    timesheet.overrideReason = null;
    timesheet.overrideBy = null;
    timesheet.overrideAt = null;
    timesheet.companyApprovedStartAt = null;
    timesheet.companyApprovedEndAt = null;
  }

  private async applyPayrollUpdate({
    companyId,
    userId,
    dto,
  }: {
    companyId?: number;
    userId: number;
    dto: UpdateTimesheetPayrollDto;
  }): Promise<Timesheet[]> {
    const uniqueIds = Array.from(new Set((dto.ids || []).filter((value) => Number.isInteger(value) && value > 0)));
    if (!uniqueIds.length) {
      throw new BadRequestException('Select at least one approved timesheet for payroll updates.');
    }

    const requestedPayrollStatus = String(dto.payrollStatus || '').trim().toLowerCase();
    if (
      requestedPayrollStatus !== TimesheetPayrollStatus.UNPAID &&
      requestedPayrollStatus !== TimesheetPayrollStatus.INCLUDED &&
      requestedPayrollStatus !== TimesheetPayrollStatus.PAID
    ) {
      throw new BadRequestException('Payroll status must be unpaid, included, or paid.');
    }

    const timesheets = companyId
      ? await this.timesheetRepo.find({
          where: uniqueIds.map((id) => ({ id, company: { id: companyId } })),
        })
      : await this.timesheetRepo.find({
          where: { id: In(uniqueIds) },
        });

    if (timesheets.length !== uniqueIds.length) {
      throw new NotFoundException('One or more timesheets were not found for this company.');
    }

    timesheets.forEach((timesheet) => {
      if (String(timesheet.approvalStatus).trim().toLowerCase() !== TimesheetStatus.APPROVED) {
        throw new ForbiddenException('Only approved timesheets can be managed in payroll.');
      }

      if (timesheet.payrollBatch) {
        throw new ForbiddenException('Timesheets attached to a payroll batch must be managed through that batch.');
      }
    });

    const now = new Date();
    const updatedTimesheets = timesheets.map((timesheet) => {
      const beforeData = {
        payrollStatus: timesheet.payrollStatus,
        payrollIncludedAt: timesheet.payrollIncludedAt,
        payrollPaidAt: timesheet.payrollPaidAt,
      };

      if (requestedPayrollStatus === TimesheetPayrollStatus.UNPAID) {
        timesheet.payrollStatus = TimesheetPayrollStatus.UNPAID;
        timesheet.payrollIncludedAt = null;
        timesheet.payrollPaidAt = null;
      } else if (requestedPayrollStatus === TimesheetPayrollStatus.INCLUDED) {
        timesheet.payrollStatus = TimesheetPayrollStatus.INCLUDED;
        timesheet.payrollIncludedAt = timesheet.payrollIncludedAt ?? now;
        timesheet.payrollPaidAt = null;
      } else {
        timesheet.payrollStatus = TimesheetPayrollStatus.PAID;
        timesheet.payrollIncludedAt = timesheet.payrollIncludedAt ?? now;
        timesheet.payrollPaidAt = now;
      }

      return { beforeData, timesheet };
    });

    const saved = await this.timesheetRepo.save(updatedTimesheets.map((entry) => entry.timesheet));

    await Promise.all(
      saved.map((timesheet, index) =>
        this.auditLogService.log({
          company: timesheet.company,
          user: userId ? { id: userId } : undefined,
          action: 'timesheet.payroll_updated',
          entityType: 'timesheet',
          entityId: timesheet.id,
          beforeData: updatedTimesheets[index].beforeData,
          afterData: {
            payrollStatus: timesheet.payrollStatus,
            payrollIncludedAt: timesheet.payrollIncludedAt,
            payrollPaidAt: timesheet.payrollPaidAt,
          },
        }),
      ),
    );

    return this.applyDerivedFinancials(saved);
  }

  private validateCompanyReviewRequest(timesheet: Timesheet, dto: UpdateTimesheetDto): void {
    const disallowedCompanyFields = [
      dto.hoursWorked !== undefined,
      dto.submittedAt !== undefined,
      dto.actualCheckInAt !== undefined,
      dto.actualCheckOutAt !== undefined,
      dto.guardNote !== undefined,
      dto.workedMinutes !== undefined,
      dto.breakMinutes !== undefined,
      dto.roundedMinutes !== undefined,
      Object.prototype.hasOwnProperty.call(dto, 'reviewedAt'),
      Object.prototype.hasOwnProperty.call(dto, 'reviewedByUserId'),
    ];

    if (disallowedCompanyFields.some(Boolean)) {
      throw new BadRequestException('Company review cannot change claimed guard timesheet fields.');
    }

    const currentStatus = String(timesheet.approvalStatus).trim().toLowerCase();
    if (currentStatus === TimesheetStatus.APPROVED) {
      throw new ForbiddenException('Approved timesheets are final and cannot be edited.');
    }

    if (currentStatus === TimesheetStatus.REJECTED) {
      throw new ForbiddenException('Rejected timesheets are final and cannot be edited.');
    }

    if (currentStatus === TimesheetStatus.DRAFT || currentStatus === TimesheetStatus.RETURNED) {
      throw new ForbiddenException('Only submitted timesheets can be reviewed by the company.');
    }

    if (currentStatus !== TimesheetStatus.SUBMITTED) {
      throw new ForbiddenException('Only submitted timesheets can be reviewed by the company.');
    }

    if (dto.approvalStatus === undefined) {
      return;
    }

    const requestedStatus = String(dto.approvalStatus).trim().toLowerCase();
    if (
      requestedStatus !== TimesheetStatus.APPROVED &&
      requestedStatus !== TimesheetStatus.REJECTED &&
      requestedStatus !== TimesheetStatus.RETURNED
    ) {
      throw new BadRequestException('Company review can only approve, reject, or return a submitted timesheet.');
    }

    // A return or a rejection needs a reason the Guard can act on (400 TIMESHEET_REVIEW_REASON_REQUIRED /
    // TIMESHEET_REVIEW_REASON_TOO_LONG). There is no generic default: the reason is what the Guard is shown.
    if (requestedStatus === TimesheetStatus.RETURNED || requestedStatus === TimesheetStatus.REJECTED) {
      const refusal = timesheetReviewReasonRefusal(dto.rejectionReason, requestedStatus);
      if (refusal) throw refusal;
    }
  }

  private async getGuardOwnedEditableTimesheet(
    userId: number,
    timesheetId: number,
    action: 'edited' | 'submitted',
  ): Promise<Timesheet> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) {
      throw new NotFoundException('Guard profile not found');
    }

    const timesheet = await this.buildGuardTimesheetQuery(guard.id)
      .andWhere('timesheet.id = :timesheetId', { timesheetId })
      .getOne();

    if (!timesheet) {
      throw new ForbiddenException('This timesheet does not belong to the current guard');
    }

    if (
      timesheet.approvalStatus !== TimesheetStatus.DRAFT &&
      timesheet.approvalStatus !== TimesheetStatus.RETURNED
    ) {
      throw new ForbiddenException(`Only draft or returned timesheets can be ${action} by the guard`);
    }

    return this.applyDerivedFinancials(timesheet);
  }

  private async applyDerivedFinancials<T extends Timesheet | Timesheet[]>(timesheetOrTimesheets: T): Promise<T> {
    const withCommercials = await this.contractPricingService.applyFinancials(timesheetOrTimesheets);
    return this.payRuleService.applyPayCalculations(withCommercials);
  }

  private buildGuardTimesheetQuery(guardId: number) {
    return this.timesheetRepo
      .createQueryBuilder('timesheet')
      .leftJoinAndSelect('timesheet.shift', 'shift')
      .leftJoinAndSelect('shift.assignment', 'assignment')
      .leftJoinAndSelect('assignment.guard', 'assignmentGuard')
      .leftJoinAndSelect('shift.guard', 'shiftGuard')
      .leftJoinAndSelect('shift.site', 'site')
      .leftJoinAndSelect('timesheet.guard', 'timesheetGuard')
      .leftJoinAndSelect('timesheet.company', 'company')
      .where(
        new Brackets((qb) => {
          qb.where('timesheetGuard.id = :guardId', { guardId })
            .orWhere('shiftGuard.id = :guardId', { guardId })
            .orWhere('assignmentGuard.id = :guardId', { guardId });
        }),
      );
  }
}
