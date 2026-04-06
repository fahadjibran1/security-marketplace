import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Incident,
  IncidentCategory,
  IncidentStatus,
} from './entities/incident.entity';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { ShiftService } from '../shift/shift.service';
import { CompanyService } from '../company/company.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';

@Injectable()
export class IncidentService {
  constructor(
    @InjectRepository(Incident)
    private readonly incidentRepo: Repository<Incident>,
    private readonly guardProfileService: GuardProfileService,
    private readonly shiftService: ShiftService,
    private readonly companyService: CompanyService,
    private readonly auditLogService: AuditLogService,
    private readonly notificationService: NotificationService,
  ) {}

  async createForGuard(userId: number, dto: CreateIncidentDto): Promise<Incident> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    let shift = null;
    if (dto.shiftId) {
      shift = await this.shiftService.findOne(dto.shiftId);
      this.shiftService.assertGuardCanOperateShift(shift, guard.id, 'submit an incident');
    }

    const company = shift?.company;
    if (!company) {
      throw new BadRequestException('Incident reports must be linked to an assigned shift');
    }

    const incident = this.incidentRepo.create({
      company,
      guard,
      shift,
      site: shift?.site ?? null,
      title: dto.title,
      notes: dto.notes,
      severity: dto.severity,
      category: dto.category ?? IncidentCategory.OTHER,
      locationText: dto.locationText || null,
      status: IncidentStatus.OPEN,
      reportedAt: new Date(),
    });

    const saved = await this.incidentRepo.save(incident);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'incident.reported',
      entityType: 'incident',
      entityId: saved.id,
      afterData: {
        title: saved.title,
        severity: saved.severity,
        category: saved.category,
        status: saved.status,
      },
    });

    if (company.user?.id) {
      await this.notificationService.createForUser({
        userId: company.user.id,
        company,
        type: NotificationType.INCIDENT_REPORTED,
        title: 'Incident reported',
        message: `${guard.user?.firstName ?? 'A guard'} reported "${saved.title}".`,
      });
    }

    return saved;
  }

  async findMine(userId: number): Promise<Incident[]> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    return this.incidentRepo.find({
      where: { guard: { id: guard.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async findForCompany(userId: number): Promise<Incident[]> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    return this.incidentRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async updateStatusForCompany(
    userId: number,
    incidentId: number,
    status: IncidentStatus,
  ): Promise<Incident> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const incident = await this.incidentRepo.findOne({ where: { id: incidentId } });
    if (!incident) throw new NotFoundException('Incident not found');
    if (incident.company.id !== company.id) {
      throw new BadRequestException('This incident does not belong to the current company');
    }

    const beforeData = {
      status: incident.status,
      reviewedAt: incident.reviewedAt,
      reviewedByUserId: incident.reviewedByUserId,
      closedAt: incident.closedAt,
      closedByUserId: incident.closedByUserId,
    };

    incident.status = status;
    if (status === IncidentStatus.IN_REVIEW || status === IncidentStatus.RESOLVED) {
      incident.reviewedAt = new Date();
      incident.reviewedByUserId = userId;
    }
    if (status === IncidentStatus.CLOSED) {
      incident.closedAt = new Date();
      incident.closedByUserId = userId;
      incident.reviewedAt ??= new Date();
      incident.reviewedByUserId ??= userId;
    }
    const saved = await this.incidentRepo.save(incident);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'incident.status_updated',
      entityType: 'incident',
      entityId: saved.id,
      beforeData,
      afterData: {
        status: saved.status,
        reviewedAt: saved.reviewedAt,
        reviewedByUserId: saved.reviewedByUserId,
        closedAt: saved.closedAt,
        closedByUserId: saved.closedByUserId,
      },
    });
    return saved;
  }
}
