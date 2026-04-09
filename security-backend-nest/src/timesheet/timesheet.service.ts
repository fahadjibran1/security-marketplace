import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Timesheet, TimesheetStatus } from './entities/timesheet.entity';
import { Shift } from '../shift/entities/shift.entity';
import { UpdateTimesheetDto } from './dto/update-timesheet.dto';
import { CompanyService } from '../company/company.service';
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
    private readonly guardProfileService: GuardProfileService,
    private readonly auditLogService: AuditLogService,
    private readonly notificationService: NotificationService,
  ) {}

  findAll(): Promise<Timesheet[]> {
    return this.timesheetRepo.find();
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

    return this.timesheetRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async findMine(userId: number): Promise<Timesheet[]> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    return this.timesheetRepo.find({
      where: { guard: { id: guard.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: number): Promise<Timesheet> {
    const timesheet = await this.timesheetRepo.findOne({ where: { id } });
    if (!timesheet) throw new NotFoundException('Timesheet not found');
    return timesheet;
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
      submittedAt: null,
      reviewedAt: null,
      reviewedByUserId: null,
      rejectionReason: null,
    });

    return this.timesheetRepo.save(timesheet);
  }

  async update(id: number, dto: UpdateTimesheetDto): Promise<Timesheet> {
    const timesheet = await this.findOne(id);
    this.applyTimesheetUpdates(timesheet, dto);
    return this.timesheetRepo.save(timesheet);
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
      rejectionReason: timesheet.rejectionReason,
      reviewedAt: timesheet.reviewedAt,
      reviewedByUserId: timesheet.reviewedByUserId,
    };

    this.applyTimesheetUpdates(timesheet, dto);
    if (
      dto.approvalStatus === TimesheetStatus.APPROVED ||
      dto.approvalStatus === TimesheetStatus.REJECTED
    ) {
      timesheet.reviewedAt = new Date();
      timesheet.reviewedByUserId = userId;
      if (dto.approvalStatus === TimesheetStatus.APPROVED) {
        timesheet.rejectionReason = null;
      } else if (dto.rejectionReason !== undefined) {
        timesheet.rejectionReason = dto.rejectionReason;
      }
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
        rejectionReason: saved.rejectionReason,
        reviewedAt: saved.reviewedAt,
        reviewedByUserId: saved.reviewedByUserId,
      },
    });

    if (saved.guard?.user?.id) {
      const isApproved = saved.approvalStatus === TimesheetStatus.APPROVED;
      await this.notificationService.createForUser({
        userId: saved.guard.user.id,
        company,
        type: isApproved
          ? NotificationType.TIMESHEET_APPROVED
          : NotificationType.TIMESHEET_REJECTED,
        title: isApproved ? 'Timesheet approved' : 'Timesheet rejected',
        message: isApproved
          ? `Your timesheet for shift #${saved.shift?.id ?? saved.id} has been approved.`
          : `Your timesheet for shift #${saved.shift?.id ?? saved.id} was rejected.`,
      });
    }

    return saved;
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
    return this.timesheetRepo.save(timesheet);
  }

  async submitMine(userId: number, id: number, dto: UpdateTimesheetDto): Promise<Timesheet> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    const timesheet = await this.timesheetRepo.findOne({
      where: { id, guard: { id: guard.id } },
    });
    if (!timesheet) throw new NotFoundException('Timesheet not found');
    const shiftStatus = timesheet.shift ? timesheet.shift.status : null;
    const normalizedShiftStatus = shiftStatus ? ['accepted'].includes(shiftStatus) ? 'ready' : ['planned', 'unassigned', 'scheduled'].includes(shiftStatus) ? 'unfilled' : ['assigned'].includes(shiftStatus) ? 'offered' : shiftStatus : null;
    if (normalizedShiftStatus !== 'in_progress') {
      throw new BadRequestException('Shift must be in progress before timesheet progression is available');
    }

    if (dto.hoursWorked !== undefined) {
      timesheet.hoursWorked = dto.hoursWorked;
      timesheet.workedMinutes = Math.max(0, Math.round(dto.hoursWorked * 60));
      timesheet.roundedMinutes = timesheet.workedMinutes;
    }

    this.applyTimesheetUpdates(timesheet, dto);
    timesheet.approvalStatus = TimesheetStatus.SUBMITTED;
    timesheet.submittedAt = new Date();
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

    return saved;
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
    if (dto.workedMinutes !== undefined) timesheet.workedMinutes = dto.workedMinutes;
    if (dto.breakMinutes !== undefined) timesheet.breakMinutes = dto.breakMinutes;
    if (dto.roundedMinutes !== undefined) timesheet.roundedMinutes = dto.roundedMinutes;
    if (dto.reviewedAt !== undefined) {
      timesheet.reviewedAt = dto.reviewedAt ? new Date(dto.reviewedAt) : null;
    }
    if (dto.reviewedByUserId !== undefined) timesheet.reviewedByUserId = dto.reviewedByUserId;
    if (dto.rejectionReason !== undefined) timesheet.rejectionReason = dto.rejectionReason;
  }
}
