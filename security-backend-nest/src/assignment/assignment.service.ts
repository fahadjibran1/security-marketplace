import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Assignment, AssignmentStatus } from './entities/assignment.entity';
import { JobApplication } from '../job-application/entities/job-application.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyService } from '../company/company.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { isCompanyRole, UserRole } from '../user/entities/user.entity';

@Injectable()
export class AssignmentService {
  constructor(
    @InjectRepository(Assignment) private readonly assignmentRepo: Repository<Assignment>,
    private readonly companyService: CompanyService,
    private readonly guardProfileService: GuardProfileService,
  ) {}

  findAll(): Promise<Assignment[]> {
    return this.assignmentRepo.find();
  }

  async findAllForUser(user: JwtPayload): Promise<Assignment[]> {
    if (user.role === UserRole.ADMIN) {
      return this.findAll();
    }

    if (isCompanyRole(user.role)) {
      const company = await this.companyService.findByUserId(user.sub);
      if (!company) {
        throw new NotFoundException('Company not found');
      }

      return this.assignmentRepo.find({
        where: { company: { id: company.id } },
        order: { id: 'DESC' },
      });
    }

    const guard = await this.guardProfileService.findByUserId(user.sub);
    if (!guard) {
      throw new NotFoundException('Guard profile not found');
    }

    return this.assignmentRepo.find({
      where: { guard: { id: guard.id } },
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number): Promise<Assignment> {
    const assignment = await this.assignmentRepo.findOne({ where: { id } });
    if (!assignment) throw new NotFoundException('Assignment not found');
    return assignment;
  }

  async findOneForUser(user: JwtPayload, id: number): Promise<Assignment> {
    const assignment = await this.findOne(id);

    if (user.role === UserRole.ADMIN) {
      return assignment;
    }

    if (isCompanyRole(user.role)) {
      const company = await this.companyService.findByUserId(user.sub);
      if (!company || assignment.company.id !== company.id) {
        throw new NotFoundException('Assignment not found');
      }
      return assignment;
    }

    const guard = await this.guardProfileService.findByUserId(user.sub);
    if (!guard || assignment.guard.id !== guard.id) {
      throw new NotFoundException('Assignment not found');
    }

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
