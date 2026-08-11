import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Attachment, AttachmentEntityType } from './entities/attachment.entity';
import { CreateAttachmentDto } from './dto/create-attachment.dto';
import { UserService } from '../user/user.service';
import { CompanyService } from '../company/company.service';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { Incident } from '../incident/entities/incident.entity';
import { SafetyAlert } from '../safety-alert/entities/safety-alert.entity';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { Shift } from '../shift/entities/shift.entity';

@Injectable()
export class AttachmentService {
  constructor(
    @InjectRepository(Attachment)
    private readonly attachmentRepo: Repository<Attachment>,
    @InjectRepository(Incident)
    private readonly incidentRepo: Repository<Incident>,
    @InjectRepository(SafetyAlert)
    private readonly alertRepo: Repository<SafetyAlert>,
    @InjectRepository(DailyLog)
    private readonly dailyLogRepo: Repository<DailyLog>,
    @InjectRepository(Timesheet)
    private readonly timesheetRepo: Repository<Timesheet>,
    @InjectRepository(Shift)
    private readonly shiftRepo: Repository<Shift>,
    private readonly userService: UserService,
    private readonly companyService: CompanyService,
  ) {}

  async createForUser(userId: number, dto: CreateAttachmentDto): Promise<Attachment> {
    const user = await this.userService.findById(userId);
    const target = await this.resolveTarget(dto.entityType, dto.entityId);

    if (!target) {
      throw new NotFoundException('Attachment target not found');
    }

    const targetCompany = target.company ?? target.shift?.company ?? null;
    const targetGuard = target.guard ?? target.shift?.guard ?? target.shift?.assignment?.guard ?? null;

    if (user.role !== UserRole.ADMIN) {
      if ((COMPANY_VIEW_ROLES as readonly UserRole[]).includes(user.role)) {
        const company = await this.companyService.findByUserId(userId);
        if (!company || !targetCompany || targetCompany.id !== company.id) {
          throw new ForbiddenException('Attachment target does not belong to the current company');
        }
      } else if (user.role === UserRole.GUARD) {
        if (!targetGuard?.user?.id || targetGuard.user.id !== userId) {
          throw new ForbiddenException('Attachment target does not belong to the current guard');
        }
      } else {
        throw new ForbiddenException('Attachment creation is not available for this user');
      }
    }

    const attachment = this.attachmentRepo.create({
      entityType: dto.entityType,
      entityId: dto.entityId,
      fileName: dto.fileName,
      fileUrl: dto.fileUrl,
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
      uploadedBy: user,
      company: targetCompany,
    });

    return this.attachmentRepo.save(attachment);
  }

  async findMine(userId: number): Promise<Attachment[]> {
    return this.attachmentRepo.find({
      where: { uploadedBy: { id: userId } },
      order: { createdAt: 'DESC' },
    });
  }

  async findForCompany(userId: number): Promise<Attachment[]> {
    const user = await this.userService.findById(userId);

    if (user.role === UserRole.ADMIN) {
      return this.attachmentRepo.find({ order: { createdAt: 'DESC' } });
    }

    if (!(COMPANY_VIEW_ROLES as readonly UserRole[]).includes(user.role)) {
      throw new ForbiddenException('Company attachment access is not available for this user');
    }

    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    return this.attachmentRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
  }

  private async resolveTarget(entityType: AttachmentEntityType, entityId: number): Promise<any | null> {
    switch (entityType) {
      case AttachmentEntityType.INCIDENT:
        return this.incidentRepo.findOne({ where: { id: entityId } });
      case AttachmentEntityType.ALERT:
        return this.alertRepo.findOne({ where: { id: entityId } });
      case AttachmentEntityType.DAILY_LOG:
        return this.dailyLogRepo.findOne({ where: { id: entityId } });
      case AttachmentEntityType.TIMESHEET:
        return this.timesheetRepo.findOne({ where: { id: entityId } });
      case AttachmentEntityType.SHIFT:
        return this.shiftRepo.findOne({
          where: { id: entityId },
          relations: ['assignment', 'assignment.guard', 'assignment.guard.user', 'guard', 'guard.user', 'company'],
        });
      default:
        return null;
    }
  }
}
