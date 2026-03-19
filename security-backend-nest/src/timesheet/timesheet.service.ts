import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Timesheet } from './entities/timesheet.entity';
import { Shift } from '../shift/entities/shift.entity';
import { UpdateTimesheetDto } from './dto/update-timesheet.dto';
import { CompanyService } from '../company/company.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';

@Injectable()
export class TimesheetService {
  constructor(
    @InjectRepository(Timesheet) private readonly timesheetRepo: Repository<Timesheet>,
    private readonly companyService: CompanyService,
    private readonly guardProfileService: GuardProfileService,
  ) {}

  findAll(): Promise<Timesheet[]> {
    return this.timesheetRepo.find();
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
    const timesheet = this.timesheetRepo.create({
      shift,
      company: shift.company,
      guard: shift.guard,
      hoursWorked: 0,
      approvalStatus: 'pending'
    });

    return this.timesheetRepo.save(timesheet);
  }

  async update(id: number, dto: UpdateTimesheetDto): Promise<Timesheet> {
    const timesheet = await this.findOne(id);
    if (dto.hoursWorked !== undefined) timesheet.hoursWorked = dto.hoursWorked;
    if (dto.approvalStatus !== undefined) timesheet.approvalStatus = dto.approvalStatus;
    return this.timesheetRepo.save(timesheet);
  }

  async updateHoursForShift(shiftId: number, hoursWorked: number): Promise<Timesheet> {
    const timesheet = await this.timesheetRepo.findOne({ where: { shift: { id: shiftId } } });
    if (!timesheet) throw new NotFoundException('Timesheet not found');

    timesheet.hoursWorked = hoursWorked;
    return this.timesheetRepo.save(timesheet);
  }
}
