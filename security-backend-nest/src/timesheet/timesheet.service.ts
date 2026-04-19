import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
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
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { isCompanyRole, UserRole } from '../user/entities/user.entity';

@Injectable()
export class TimesheetService {
  constructor(
    @InjectRepository(Timesheet) private readonly timesheetRepo: Repository<Timesheet>,
    private readonly companyService: CompanyService,
    private readonly contractPricingService: ContractPricingService,
    private readonly guardProfileService: GuardProfileService,
    private readonly auditLogService: AuditLogService,
    private readonly notificationService: NotificationService,
  ) {}

  async findAll(): Promise<Timesheet[]> {
    const timesheets = await this.timesheetRepo.find();
    return this.contractPricingService.applyFinancials(timesheets);
  }

  async findAllForUser(user: JwtPayload): Promise<Timesheet[]> {
    if (user.role === UserRole.ADMIN) {
      return this.findAll();
    }

    if (isCompanyRole(user.role)) {
      return this.findForCompany(user.sub);
    }

    return this.findMine(user.sub);
  }

  async findForCompany(userId: number): Promise<Timesheet[]> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const timesheets = await this.timesheetRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
    return this.contractPricingService.applyFinancials(timesheets);
  }

  async findMine(userId: number): Promise<Timesheet[]> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    const timesheets = await this.buildGuardTimesheetQuery(guard.id)
      .orderBy('timesheet.createdAt', 'DESC')
      .getMany();
    return this.contractPricingService.applyFinancials(timesheets);
  }

  async findOne(id: number): Promise<Timesheet> {
    const timesheet = await this.timesheetRepo.findOne({ where: { id } });
    if (!timesheet) throw new NotFoundException('Timesheet not found');
    return this.contractPricingService.applyFinancials(timesheet);
  }

  async createForShift(shift: Shift): Promise<Timesheet> {
    const company = shift.company ?? shift.assignment?.company;
    const guard = shift.guard ?? shift.assignment?.guard;

    if (!company || !guard) {
      throw new NotFoundException('Shift is missing company or guard context for timesheet creation');
    }

    const timesheet = this.timesheetRepo.create({
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

    const saved = await this.timesheetRepo.save(timesheet);
    return this.contractPricingService.applyFinancials(saved);
  }

  async update(id: number, dto: UpdateTimesheetDto): Promise<Timesheet> {
    const timesheet = await this.findOne(id);
    this.applyTimesheetUpdates(timesheet, dto);
    const saved = await this.timesheetRepo.save(timesheet);
    return this.contractPricingService.applyFinancials(saved);
  }

  async updateMine(userId: number, id: number, dto: UpdateTimesheetDto): Promise<Timesheet> {
    const timesheet = await this.getGuardOwnedEditableTimesheet(userId, id, 'edited');
    this.applyGuardEditableUpdates(timesheet, dto);
    const saved = await this.timesheetRepo.save(timesheet);
    return this.contractPricingService.applyFinancials(saved);
  }

  async updateForCompany(userId: number, id: number, dto: UpdateTimesheetDto): Promise<Timesheet> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

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

    this.validateCompanyReviewRequest(timesheet, dto);
    this.applyTimesheetUpdates(timesheet, dto);
    this.validateCompanyReviewUpdate(timesheet, dto);
    if (dto.approvalStatus === TimesheetStatus.APPROVED) {
      timesheet.reviewedAt = new Date();
      timesheet.reviewedByUserId = userId;
      if (timesheet.approvedHours === undefined || timesheet.approvedHours === null) {
        timesheet.approvedHours = Number(timesheet.hoursWorked);
      }
      if (!timesheet.payrollStatus) {
        timesheet.payrollStatus = TimesheetPayrollStatus.UNPAID;
      }
      if (!timesheet.billingStatus) {
        timesheet.billingStatus = TimesheetBillingStatus.UNINVOICED;
      }
      timesheet.rejectionReason = null;
    } else if (dto.approvalStatus === TimesheetStatus.REJECTED) {
      timesheet.reviewedAt = new Date();
      timesheet.reviewedByUserId = userId;
      timesheet.approvedHours = null;
      timesheet.payrollStatus = TimesheetPayrollStatus.UNPAID;
      timesheet.payrollIncludedAt = null;
      timesheet.payrollPaidAt = null;
      timesheet.billingStatus = TimesheetBillingStatus.UNINVOICED;
      timesheet.invoiceIssuedAt = null;
      timesheet.invoicePaidAt = null;
      timesheet.invoiceBatch = null;
    } else if (dto.approvalStatus === TimesheetStatus.RETURNED) {
      timesheet.reviewedAt = new Date();
      timesheet.reviewedByUserId = userId;
      timesheet.approvedHours = null;
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
      action: 'timesheet.reviewed',
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
        message: isApproved
          ? `Your timesheet for shift #${saved.shift?.id ?? saved.id} has been approved.`
          : isReturned
            ? `Your timesheet for shift #${saved.shift?.id ?? saved.id} was returned for correction.`
            : `Your timesheet for shift #${saved.shift?.id ?? saved.id} was rejected.`,
      });
    }

    return this.contractPricingService.applyFinancials(saved);
  }

  async updateHoursForShift(shiftId: number, hoursWorked: number): Promise<Timesheet> {
    const timesheet = await this.timesheetRepo.findOne({ where: { shift: { id: shiftId } } });
    if (!timesheet) throw new NotFoundException('Timesheet not found');

    const workedMinutes = Math.max(0, Math.round(hoursWorked * 60));
    timesheet.hoursWorked = hoursWorked;
    timesheet.workedMinutes = workedMinutes;
    timesheet.roundedMinutes = workedMinutes;
    timesheet.actualCheckInAt = timesheet.shift.assignment?.checkedInAt ?? timesheet.actualCheckInAt ?? null;
    timesheet.actualCheckOutAt = timesheet.shift.assignment?.checkedOutAt ?? timesheet.actualCheckOutAt ?? null;
    const saved = await this.timesheetRepo.save(timesheet);
    return this.contractPricingService.applyFinancials(saved);
  }

  async submitMine(userId: number, id: number, dto: UpdateTimesheetDto): Promise<Timesheet> {
    const timesheet = await this.getGuardOwnedEditableTimesheet(userId, id, 'submitted');
    this.applyGuardEditableUpdates(timesheet, dto);
    timesheet.approvalStatus = TimesheetStatus.SUBMITTED;
    timesheet.submittedAt = new Date();
    timesheet.approvedHours = null;
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
      afterData: {
        approvalStatus: saved.approvalStatus,
        submittedAt: saved.submittedAt,
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

    return this.contractPricingService.applyFinancials(saved);
  }

  async updatePayrollForCompany(userId: number, dto: UpdateTimesheetPayrollDto): Promise<Timesheet[]> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    return this.applyPayrollUpdate({ companyId: company.id, userId, dto });
  }

  async updatePayrollAsAdmin(dto: UpdateTimesheetPayrollDto): Promise<Timesheet[]> {
    return this.applyPayrollUpdate({ userId: 0, dto });
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
    if (dto.approvedHours !== undefined) {
      timesheet.approvedHours = dto.approvedHours;
    }
    if (dto.workedMinutes !== undefined) timesheet.workedMinutes = dto.workedMinutes;
    if (dto.breakMinutes !== undefined) timesheet.breakMinutes = dto.breakMinutes;
    if (dto.roundedMinutes !== undefined) timesheet.roundedMinutes = dto.roundedMinutes;
    if (dto.reviewedAt !== undefined) {
      timesheet.reviewedAt = dto.reviewedAt ? new Date(dto.reviewedAt) : null;
    }
    if (dto.reviewedByUserId !== undefined) timesheet.reviewedByUserId = dto.reviewedByUserId;
    if (dto.rejectionReason !== undefined) timesheet.rejectionReason = dto.rejectionReason;
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

    return this.contractPricingService.applyFinancials(saved);
  }

  private validateCompanyReviewUpdate(timesheet: Timesheet, dto: UpdateTimesheetDto): void {
    const claimedHours = Number(timesheet.hoursWorked);
    const approvedHours =
      timesheet.approvedHours === undefined || timesheet.approvedHours === null
        ? null
        : Number(timesheet.approvedHours);

    if (approvedHours !== null && (!Number.isFinite(approvedHours) || approvedHours < 0)) {
      throw new BadRequestException('Approved hours must be 0 or more.');
    }

    const companyNote = timesheet.companyNote?.trim() || '';
    const approvalStatus = dto.approvalStatus ? String(dto.approvalStatus).trim().toLowerCase() : '';
    const finalApprovedHours =
      approvalStatus === TimesheetStatus.APPROVED
        ? approvedHours ?? claimedHours
        : approvedHours;

    if (
      finalApprovedHours !== null &&
      Math.abs(finalApprovedHours - claimedHours) > 0.009 &&
      !companyNote
    ) {
      throw new BadRequestException('Add a company note when approved hours differ from claimed hours.');
    }
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
      dto.reviewedAt !== undefined,
      dto.reviewedByUserId !== undefined,
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

    if (requestedStatus === TimesheetStatus.RETURNED) {
      const returnReason = dto.rejectionReason?.trim();
      if (!returnReason) {
        throw new BadRequestException('A return reason is required when returning a timesheet for correction.');
      }
    }

    if (requestedStatus === TimesheetStatus.REJECTED) {
      const rejectionReason = dto.rejectionReason?.trim();
      if (!rejectionReason) {
        throw new BadRequestException('A rejection reason is required when rejecting a timesheet.');
      }
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

    return this.contractPricingService.applyFinancials(timesheet);
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
