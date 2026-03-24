import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Assignment, AssignmentStatus } from './entities/assignment.entity';
import { JobApplication } from '../job-application/entities/job-application.entity';

@Injectable()
export class AssignmentService {
  constructor(@InjectRepository(Assignment) private readonly assignmentRepo: Repository<Assignment>) {}

  findAll(): Promise<Assignment[]> {
    return this.assignmentRepo.find();
  }

  async findOne(id: number): Promise<Assignment> {
    const assignment = await this.assignmentRepo.findOne({ where: { id } });
    if (!assignment) throw new NotFoundException('Assignment not found');
    return assignment;
  }

  async countActiveByJob(jobId: number): Promise<number> {
    return this.assignmentRepo.count({
      where: {
        job: { id: jobId },
        status: In([
          AssignmentStatus.ACTIVE,
          AssignmentStatus.ASSIGNED,
          AssignmentStatus.ACCEPTED,
          AssignmentStatus.CHECKED_IN,
          AssignmentStatus.CHECKED_OUT,
        ]),
      },
    });
  }

  async createFromHire(application: JobApplication): Promise<Assignment> {
    const assignment = this.assignmentRepo.create({
      job: application.job,
      company: application.job.company,
      guard: application.guard,
      application,
      status: AssignmentStatus.ASSIGNED,
      assignedAt: new Date(),
    });

    return this.assignmentRepo.save(assignment);
  }

  save(assignment: Assignment): Promise<Assignment> {
    return this.assignmentRepo.save(assignment);
  }
}
