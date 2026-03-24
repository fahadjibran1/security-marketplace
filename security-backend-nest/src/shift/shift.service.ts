import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Shift } from './entities/shift.entity';
import { CreateShiftDto } from './dto/create-shift.dto';
import { AssignmentService } from '../assignment/assignment.service';
import { TimesheetService } from '../timesheet/timesheet.service';
import { SiteService } from '../site/site.service';
import { Company } from '../company/entities/company.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Job } from '../job/entities/job.entity';
import { JobApplication } from '../job-application/entities/job-application.entity';

@Injectable()
export class ShiftService {
  constructor(
    @InjectRepository(Shift)
    private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(GuardProfile)
    private readonly guardRepo: Repository<GuardProfile>,
    @InjectRepository(Job)
    private readonly jobRepo: Repository<Job>,
    @InjectRepository(JobApplication)
    private readonly jobApplicationRepo: Repository<JobApplication>,
    private readonly assignmentService: AssignmentService,
    private readonly timesheetService: TimesheetService,
    private readonly siteService: SiteService,
  ) {}

  async findAll(): Promise<Shift[]> {
    return this.shiftRepo.find({
      relations: ['assignment', 'company', 'guard'],
    });
  }

  async findOne(id: number): Promise<Shift> {
    const shift = await this.shiftRepo.findOne({
      where: { id },
      relations: ['assignment', 'company', 'guard'],
    });

    if (!shift) {
      throw new NotFoundException(`Shift with id ${id} not found`);
    }

    return shift;
  }

  async create(dto: CreateShiftDto) {
    const assignment = dto.assignmentId
      ? await this.assignmentService.findOne(dto.assignmentId)
      : null;
    const jobApplication = dto.jobApplicationId
      ? await this.jobApplicationRepo.findOne({ where: { id: dto.jobApplicationId } })
      : assignment?.application ?? null;
    const job = dto.jobId
      ? await this.jobRepo.findOne({ where: { id: dto.jobId } })
      : assignment?.job ?? jobApplication?.job ?? null;
    const company = dto.companyId
      ? await this.companyRepo.findOne({ where: { id: dto.companyId } })
      : assignment?.company ?? job?.company ?? null;
    const guard = dto.guardId
      ? await this.guardRepo.findOne({ where: { id: dto.guardId } })
      : assignment?.guard ?? jobApplication?.guard ?? null;
    const site = dto.siteId
      ? await this.siteService.findOne(dto.siteId)
      : job?.site ?? null;

    if (!company) {
      throw new NotFoundException('Company context is required to create a shift');
    }

    if (!guard) {
      throw new NotFoundException('Guard assignment context is required to create a shift');
    }

    const shift = this.shiftRepo.create({
      assignment,
      company,
      guard,
      site,
      job,
      jobApplication,
      createdByUserId: dto.createdByUserId ?? company.user?.id ?? null,
      siteName: site?.name || dto.siteName || 'Unassigned Site',
      start: new Date(dto.start),
      end: new Date(dto.end),
      status: dto.status ?? 'scheduled',
    });

    const savedShift = await this.shiftRepo.save(shift);
    const timesheet = await this.timesheetService.createForShift(savedShift);

    return { shift: savedShift, timesheet };
  }

  save(shift: Shift): Promise<Shift> {
    return this.shiftRepo.save(shift);
  }
}
