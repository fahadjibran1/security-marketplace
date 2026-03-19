import { Injectable } from '@nestjs/common';
import { JobMatch } from '../job-match/entities/job-match.entity';
import { JobMatchService } from '../job-match/job-match.service';

@Injectable()
export class MatchingService {
  constructor(private readonly jobMatchService: JobMatchService) {}

  findBySlot(slotId: number): Promise<JobMatch[]> {
    return this.jobMatchService.findBySlot(slotId);
  }

  rematch(slotId: number): Promise<JobMatch[]> {
    return this.jobMatchService.rematch(slotId);
  }

  async createMatchFromApplication(jobSlotId: number, guardId: number): Promise<JobMatch | null> {
    return this.jobMatchService.createMatchFromApplication(jobSlotId, guardId);
  }
}
