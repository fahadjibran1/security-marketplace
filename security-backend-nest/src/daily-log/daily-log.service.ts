import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyLog, DailyLogType } from './entities/daily-log.entity';
import { CreateDailyLogDto } from './dto/create-daily-log.dto';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { ShiftService } from '../shift/shift.service';
import { CompanyService } from '../company/company.service';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class DailyLogService {
  constructor(
    @InjectRepository(DailyLog)
    private readonly dailyLogRepo: Repository<DailyLog>,
    private readonly guardProfileService: GuardProfileService,
    private readonly shiftService: ShiftService,
    private readonly companyService: CompanyService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createForGuard(userId: number, dto: CreateDailyLogDto): Promise<DailyLog> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    const shift = await this.shiftService.findOne(dto.shiftId);
    this.shiftService.assertGuardCanOperateShift(shift, guard.id, 'record a daily log');

    const dailyLog = this.dailyLogRepo.create({
      company: shift.company,
      guard,
      shift,
      message: dto.message,
      logType: dto.logType ?? DailyLogType.OTHER,
    });

    const saved = await this.dailyLogRepo.save(dailyLog);
    await this.auditLogService.log({
      company: shift.company,
      user: { id: userId },
      action: 'daily_log.created',
      entityType: 'daily_log',
      entityId: saved.id,
      afterData: {
        logType: saved.logType,
        shiftId: saved.shift?.id,
      },
    });
    return saved;
  }

  async findMine(userId: number): Promise<DailyLog[]> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    return this.dailyLogRepo.find({
      where: { guard: { id: guard.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async findForCompany(userId: number): Promise<DailyLog[]> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    return this.dailyLogRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
  }
}
