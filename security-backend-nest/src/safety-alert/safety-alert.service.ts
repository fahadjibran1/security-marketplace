import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

@Injectable()
export class SafetyAlertService {
  constructor(
    @InjectRepository(SafetyAlert)
    private readonly safetyAlertRepo: Repository<SafetyAlert>,
    private readonly guardProfileService: GuardProfileService,
    private readonly shiftService: ShiftService,
    private readonly companyService: CompanyService,
    private readonly auditLogService: AuditLogService,
    private readonly notificationService: NotificationService,
  ) {}

  async createForGuard(userId: number, dto: CreateSafetyAlertDto): Promise<SafetyAlert> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    let shift = null;
    if (dto.shiftId) {
      shift = await this.shiftService.findOne(dto.shiftId);
      if (shift.guard.id !== guard.id) {
        throw new BadRequestException('This shift is not assigned to the current guard');
      }
    }

    const company = shift?.company;
    if (!company) {
      throw new BadRequestException('Safety alerts must be linked to an assigned shift');
    }

    const safetyAlert = this.safetyAlertRepo.create({
      company,
      guard,
      shift,
      type: dto.type ?? SafetyAlertType.OTHER,
      priority: dto.priority ?? SafetyAlertPriority.MEDIUM,
      message: dto.message,
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
      await this.notificationService.createForUser({
        userId: company.user.id,
        company,
        type: NotificationType.ALERT_RAISED,
        title: 'Safety alert raised',
        message: `${guard.user?.firstName ?? 'A guard'} raised a ${saved.type.replace('_', ' ')} alert.`,
      });
    }

    return saved;
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

  async closeForCompany(userId: number, alertId: number): Promise<SafetyAlert> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    if (alert.company.id !== company.id) {
      throw new BadRequestException('This alert does not belong to the current company');
    }

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
