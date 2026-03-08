import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobApplication } from './entities/job-application.entity';
import { CreateJobApplicationDto } from './dto/create-job-application.dto';
import { JobService } from '../job/job.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { AssignmentService } from '../assignment/assignment.service';
import { HireApplicationDto } from './dto/hire-application.dto';
import { ShiftService } from '../shift/shift.service';

@Injectable()
export class JobApplicationService {
  constructor(
    @InjectRepository(JobApplication)
    private readonly appRepo: Repository<JobApplication>,
    private readonly jobsService: JobService,
    private readonly guardService: GuardProfileService,
    private readonly assignmentService: AssignmentService,
    private readonly shiftService: ShiftService
  ) {}

  findAll(): Promise<JobApplication[]> {
    return this.appRepo.find();
  }

  async findOne(id: number): Promise<JobApplication> {
    const app = await this.appRepo.findOne({ where: { id } });
    if (!app) throw new NotFoundException('Job application not found');
    return app;
  }

  async create(dto: CreateJobApplicationDto): Promise<JobApplication> {
    const job = await this.jobsService.findOne(dto.jobId);
    const guard = await this.guardService.findOne(dto.guardId);

    const existing = await this.appRepo.findOne({
      where: {
        job: { id: job.id },
        guard: { id: guard.id }
      }
    });

    if (existing) throw new ConflictException('Application already exists for this guard/job');

    const application = this.appRepo.create({ job, guard, status: 'submitted' });
    return this.appRepo.save(application);
  }

  async hire(applicationId: number, dto: HireApplicationDto) {
    const application = await this.findOne(applicationId);
    if (application.status === 'hired') throw new ConflictException('Application already hired');

    const activeCount = await this.assignmentService.countActiveByJob(application.job.id);
    if (activeCount >= application.job.guardsRequired) {
      throw new ConflictException('Job guard capacity reached');
    }

    application.status = 'hired';
    application.hiredAt = new Date();
    await this.appRepo.save(application);

    const assignment = await this.assignmentService.createFromHire(application);

    let shiftResult: unknown = null;
    if (dto.createShift) {
      if (!dto.siteName || !dto.start || !dto.end) {
        throw new BadRequestException('siteName, start, end are required when createShift=true');
      }

      shiftResult = await this.shiftService.create({
        assignmentId: assignment.id,
        siteName: dto.siteName,
        start: dto.start,
        end: dto.end
      });
    }

    return {
      application,
      assignment,
      shiftBundle: shiftResult
    };
  }
}
