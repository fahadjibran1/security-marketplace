import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import {
  SafetyAlert,
  SafetyAlertPriority,
  SafetyAlertStatus,
  SafetyAlertType,
} from './entities/safety-alert.entity';
import { CreateSafetyAlertDto } from './dto/create-safety-alert.dto';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { ShiftService } from '../shift/shift.service';
import { CompanyService } from '../company/company.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';
import { DailyLog, DailyLogType } from '../daily-log/entities/daily-log.entity';
import { AttendanceEvent, AttendanceEventType } from '../attendance/entities/attendance.entity';
import { Shift } from '../shift/entities/shift.entity';

@Injectable()
export class SafetyAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SafetyAlertService.name);
  private welfareInterval?: NodeJS.Timeout;

  constructor(
    @InjectRepository(SafetyAlert)
    private readonly safetyAlertRepo: Repository<SafetyAlert>,
    @InjectRepository(DailyLog)
    private readonly dailyLogRepo: Repository<DailyLog>,
    @InjectRepository(AttendanceEvent)
    private readonly attendanceRepo: Repository<AttendanceEvent>,
    @InjectRepository(Shift)
    private readonly shiftRepo: Repository<Shift>,
    private readonly guardProfileService: GuardProfileService,
    private readonly shiftService: ShiftService,
    private readonly companyService: CompanyService,
    private readonly auditLogService: AuditLogService,
    private readonly notificationService: NotificationService,
  ) {}

  onModuleInit() {
    this.welfareInterval = setInterval(() => {
      this.runMissedWelfareChecks().catch((error) =>
        this.logger.error(`Missed welfare check scan failed: ${error?.message || error}`),
      );
    }, 5 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.welfareInterval) clearInterval(this.welfareInterval);
  }

  findAll(): Promise<SafetyAlert[]> {
    return this.safetyAlertRepo.find({ order: { createdAt: 'DESC' } });
  }

  async createForGuard(userId: number, dto: CreateSafetyAlertDto): Promise<SafetyAlert> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    let shift = null;
    if (dto.shiftId) {
      shift = await this.shiftService.findOne(dto.shiftId);
      this.shiftService.assertGuardCanOperateShift(shift, guard.id, 'raise a safety alert');
    }

    const company = shift?.company;
    if (!company) {
      throw new BadRequestException('Safety alerts must be linked to an assigned shift');
    }

    const type = dto.type ?? SafetyAlertType.OTHER;
    const priority =
      type === SafetyAlertType.PANIC
        ? SafetyAlertPriority.CRITICAL
        : dto.priority ?? SafetyAlertPriority.MEDIUM;

    const safetyAlert = this.safetyAlertRepo.create({
      company,
      guard,
      shift,
      type,
      priority,
      message: dto.message.trim(),
      status: SafetyAlertStatus.OPEN,
    });

    const saved = await this.safetyAlertRepo.save(safetyAlert);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'safety_alert.created',
      entityType: 'safety_alert',
      entityId: saved.id,
      afterData: {
        type: saved.type,
        priority: saved.priority,
        status: saved.status,
      },
    });

    if (company.user?.id) {
      const isPanic = saved.type === SafetyAlertType.PANIC;
      await this.notificationService.createForUser({
        userId: company.user.id,
        company,
        type: NotificationType.ALERT_RAISED,
        title: isPanic ? 'CRITICAL: Panic alert raised' : 'Safety alert raised',
        message: `${guard.user?.firstName ?? 'A guard'} raised a ${saved.type.replace('_', ' ')} alert.`,
      });
    }

    return saved;
  }

  async runMissedWelfareChecks() {
    const now = new Date();
    const shifts = await this.shiftRepo.find({
      where: { status: 'in_progress' },
      order: { start: 'ASC' },
    });

    let alertsCreated = 0;
    for (const shift of shifts) {
      const guard = shift.guard ?? shift.assignment?.guard;
      if (!guard?.id || !shift.company?.id) continue;

      const intervalMinutes = Math.max(
        5,
        Number(shift.site?.welfareCheckIntervalMinutes ?? shift.checkCallIntervalMinutes ?? 60) || 60,
      );

      const [latestWelfare, latestCheckIn] = await Promise.all([
        this.dailyLogRepo.findOne({
          where: { shift: { id: shift.id }, logType: DailyLogType.WELFARE_CHECK },
          order: { createdAt: 'DESC' },
        }),
        this.attendanceRepo.findOne({
          where: { shift: { id: shift.id }, type: AttendanceEventType.CHECK_IN },
          order: { occurredAt: 'DESC' },
        }),
      ]);

      const referenceCandidates = [
        new Date(shift.start),
        latestCheckIn?.occurredAt,
        latestWelfare?.createdAt,
      ].filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()));
      const reference = new Date(Math.max(...referenceCandidates.map((value) => value.getTime())));
      const deadline = new Date(reference.getTime() + intervalMinutes * 60 * 1000);
      if (now <= deadline) continue;

      const existing = await this.safetyAlertRepo.findOne({
        where: {
          shift: { id: shift.id },
          type: SafetyAlertType.MISSED_CHECKCALL,
          createdAt: MoreThan(reference),
        },
        order: { createdAt: 'DESC' },
      });
      if (existing) continue;

      const alert = this.safetyAlertRepo.create({
        company: shift.company,
        guard,
        shift,
        type: SafetyAlertType.MISSED_CHECKCALL,
        priority: SafetyAlertPriority.HIGH,
        message: `Welfare check overdue by more than ${intervalMinutes} minutes.`,
        status: SafetyAlertStatus.OPEN,
      });
      const saved = await this.safetyAlertRepo.save(alert);
      alertsCreated += 1;

      await this.auditLogService.log({
        company: shift.company,
        user: null,
        action: 'welfare_check.missed',
        entityType: 'safety_alert',
        entityId: saved.id,
        afterData: {
          shiftId: shift.id,
          guardId: guard.id,
          intervalMinutes,
          referenceAt: reference,
          deadlineAt: deadline,
        },
      });

      if (shift.company.user?.id) {
        await this.notificationService.createForUserUnlessRecentDuplicate(
          {
            userId: shift.company.user.id,
            company: shift.company,
            type: NotificationType.ALERT_RAISED,
            title: 'Missed welfare check',
            message: `${guard.fullName || 'A guard'} has missed the welfare check interval for ${shift.siteName}.`,
          },
          intervalMinutes,
        );
      }
    }

    return { shiftsChecked: shifts.length, alertsCreated };
  }

  async findMine(userId: number): Promise<SafetyAlert[]> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    return this.safetyAlertRepo.find({
      where: { guard: { id: guard.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async findForCompany(userId: number): Promise<SafetyAlert[]> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    return this.safetyAlertRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async acknowledgeForCompany(userId: number, alertId: number): Promise<SafetyAlert> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    if (alert.company.id !== company.id) {
      throw new BadRequestException('This alert does not belong to the current company');
    }

    return this.acknowledge(alert, userId, company);
  }

  async acknowledgeAsAdmin(userId: number, alertId: number): Promise<SafetyAlert> {
    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    return this.acknowledge(alert, userId, alert.company);
  }

  async closeForCompany(userId: number, alertId: number): Promise<SafetyAlert> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    if (alert.company.id !== company.id) {
      throw new BadRequestException('This alert does not belong to the current company');
    }

    return this.close(alert, userId, company);
  }

  async closeAsAdmin(userId: number, alertId: number): Promise<SafetyAlert> {
    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    return this.close(alert, userId, alert.company);
  }

  private async acknowledge(alert: SafetyAlert, userId: number, company: SafetyAlert['company']) {
    alert.status = SafetyAlertStatus.ACKNOWLEDGED;
    alert.acknowledgedAt = new Date();
    alert.acknowledgedByUserId = userId;
    const saved = await this.safetyAlertRepo.save(alert);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'safety_alert.acknowledged',
      entityType: 'safety_alert',
      entityId: saved.id,
      afterData: {
        status: saved.status,
        acknowledgedAt: saved.acknowledgedAt,
        acknowledgedByUserId: saved.acknowledgedByUserId,
      },
    });
    return saved;
  }

  private async close(alert: SafetyAlert, userId: number, company: SafetyAlert['company']) {
    if (!alert.acknowledgedAt) {
      alert.acknowledgedAt = new Date();
      alert.acknowledgedByUserId = userId;
    }
    alert.status = SafetyAlertStatus.CLOSED;
    alert.closedAt = new Date();
    alert.closedByUserId = userId;
    const saved = await this.safetyAlertRepo.save(alert);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'safety_alert.closed',
      entityType: 'safety_alert',
      entityId: saved.id,
      afterData: {
        status: saved.status,
        closedAt: saved.closedAt,
        closedByUserId: saved.closedByUserId,
      },
    });
    return saved;
  }
}
