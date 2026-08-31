import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { JobApplication } from '../job-application/entities/job-application.entity';

@Injectable()
export class PreHireComplianceAuthorizationService {
  constructor(
    @InjectRepository(JobApplication)
    private readonly applicationRepo: Repository<JobApplication>,
  ) {}

  async authorize(companyId: number, guardId: number): Promise<JobApplication> {
    const application = await this.applicationRepo.findOne({
      where: {
        guard: { id: guardId },
        job: { company: { id: companyId }, status: 'open' },
        status: 'under_review',
      },
    });

    if (!application) {
      throw new ForbiddenException('Guard does not have an eligible pre-hire application for this company');
    }
    return application;
  }
}
