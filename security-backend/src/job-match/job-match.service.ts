import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { JobMatch, JobMatchSourceType, JobMatchStatus } from './entities/job-match.entity';
import { JobSlotService } from '../job-slot/job-slot.service';
import { JobSourceType } from '../job/entities/job.entity';
import { CompanyGuard, CompanyGuardStatus } from '../company-guard/entities/company-guard.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Shift } from '../shift/entities/shift.entity';

@Injectable()
export class JobMatchService {
  constructor(
    @InjectRepository(JobMatch) private readonly matchRepo: Repository<JobMatch>,
    @InjectRepository(CompanyGuard) private readonly companyGuardRepo: Repository<CompanyGuard>,
    @InjectRepository(GuardProfile) private readonly guardRepo: Repository<GuardProfile>,
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    private readonly slotService: JobSlotService,
  ) {}

  async findBySlot(slotId: number): Promise<JobMatch[]> {
    return this.matchRepo.find({ where: { jobSlot: { id: slotId } }, order: { matchScore: 'DESC', id: 'ASC' } });
  }

  async rematch(slotId: number): Promise<JobMatch[]> {
    const slot = await this.slotService.findById(slotId);
    if (!slot.job) throw new NotFoundException('Job for slot not found');

    await this.matchRepo.delete({ jobSlot: { id: slotId }, status: In([JobMatchStatus.SUGGESTED, JobMatchStatus.INVITED, JobMatchStatus.VIEWED]) });

    const candidates =
      slot.job.sourceType === JobSourceType.INTERNAL
        ? await this.internalCandidates(slot.job.company.id)
        : await this.marketplaceCandidates(slot.job.company.id);

    const available = await this.excludeUnavailableByShift(candidates, slot.job.startAt, slot.job.endAt);

    const matches = available.map((guard, index) =>
      this.matchRepo.create({
        jobSlot: slot,
        guard,
        matchScore: this.scoreGuard(guard, index),
        matchReason: this.reasonFor(slot.job.sourceType),
        sourceType:
          slot.job.sourceType === JobSourceType.INTERNAL
            ? JobMatchSourceType.INTERNAL_POOL
            : JobMatchSourceType.MARKETPLACE_POOL,
        status: JobMatchStatus.SUGGESTED,
      }),
    );

    return this.matchRepo.save(matches);
  }

  private async internalCandidates(companyId: number): Promise<GuardProfile[]> {
    const relations = await this.companyGuardRepo.find({
      where: { company: { id: companyId }, status: CompanyGuardStatus.ACTIVE },
    });
    return relations.map((relation) => relation.guard);
  }

  private async marketplaceCandidates(companyId: number): Promise<GuardProfile[]> {
    const activeCompanyGuards = await this.companyGuardRepo.find({
      where: { company: { id: companyId }, status: CompanyGuardStatus.ACTIVE },
    });

    const excludedIds = activeCompanyGuards.map((entry) => entry.guard.id);
    if (excludedIds.length === 0) return this.guardRepo.find();

    return this.guardRepo.find({ where: { id: Not(In(excludedIds)) } });
  }

  private async excludeUnavailableByShift(candidates: GuardProfile[], startAt?: Date, endAt?: Date): Promise<GuardProfile[]> {
    if (!startAt || !endAt || candidates.length === 0) return candidates;

    const candidateIds = candidates.map((candidate) => candidate.id);
    const overlappingShifts = await this.shiftRepo
      .createQueryBuilder('shift')
      .select('shift.guardId', 'guardId')
      .where('shift.guardId IN (:...candidateIds)', { candidateIds })
      .andWhere('shift.start < :endAt', { endAt })
      .andWhere('shift.end > :startAt', { startAt })
      .andWhere('shift.status != :cancelledStatus', { cancelledStatus: 'cancelled' })
      .groupBy('shift.guardId')
      .getRawMany<{ guardId: string }>();

    const blocked = new Set(overlappingShifts.map((row) => Number(row.guardId)));
    return candidates.filter((candidate) => !blocked.has(candidate.id));
  }

  private scoreGuard(guard: GuardProfile, index: number): number {
    const statusBonus = guard.status === 'approved' ? 15 : 0;
    return Math.max(0, 100 - index * 5 + statusBonus);
  }

  private reasonFor(jobSourceType: JobSourceType): string {
    if (jobSourceType === JobSourceType.INTERNAL) {
      return 'Matched from active internal company guard pool';
    }

    return 'Matched from marketplace guard pool with no shift overlap';
  }
}
