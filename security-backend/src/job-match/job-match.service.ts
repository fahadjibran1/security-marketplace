import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import {
  JobMatch,
  JobMatchSourceType,
  JobMatchStatus,
} from './entities/job-match.entity';
import { JobSlotService } from '../job-slot/job-slot.service';
import { JobSourceType } from '../job/entities/job.entity';
import {
  CompanyGuard,
  CompanyGuardStatus,
} from '../company-guard/entities/company-guard.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Shift } from '../shift/entities/shift.entity';

@Injectable()
export class JobMatchService {
  constructor(
    @InjectRepository(JobMatch)
    private readonly matchRepo: Repository<JobMatch>,

    @InjectRepository(CompanyGuard)
    private readonly companyGuardRepo: Repository<CompanyGuard>,

    @InjectRepository(GuardProfile)
    private readonly guardRepo: Repository<GuardProfile>,

    @InjectRepository(Shift)
    private readonly shiftRepo: Repository<Shift>,

    private readonly slotService: JobSlotService,
  ) {}

  async findBySlot(slotId: number): Promise<JobMatch[]> {
    return this.matchRepo.find({
      where: { jobSlot: { id: slotId } },
      order: { matchScore: 'DESC', id: 'ASC' },
    });
  }

  async rematch(slotId: number): Promise<JobMatch[]> {
    const slot = await this.getSlotById(slotId);
    if (!slot?.job) {
      throw new NotFoundException('Job for slot not found');
    }

    await this.matchRepo.delete({
      jobSlot: { id: slotId },
      status: In([
        JobMatchStatus.SUGGESTED,
        JobMatchStatus.INVITED,
        JobMatchStatus.VIEWED,
      ]),
    });

    const sourceType = this.getJobSourceType(slot.job);
    const companyId = slot.job?.company?.id;
    const startAt = slot.job?.startAt;
    const endAt = slot.job?.endAt;

    const candidates =
      sourceType === JobSourceType.INTERNAL
        ? await this.internalCandidates(companyId)
        : await this.marketplaceCandidates(companyId);

    const available = await this.excludeUnavailableByShift(
      candidates,
      startAt,
      endAt,
    );

    const matches = available.map((guard, index) =>
      this.matchRepo.create({
        jobSlot: slot,
        guard,
        matchScore: this.scoreGuard(guard, index),
        matchReason: this.reasonFor(sourceType),
        sourceType:
          sourceType === JobSourceType.INTERNAL
            ? JobMatchSourceType.INTERNAL_POOL
            : JobMatchSourceType.MARKETPLACE_POOL,
        status: JobMatchStatus.SUGGESTED,
      }),
    );

    return this.matchRepo.save(matches);
  }

  async createMatchFromApplication(
    jobSlotId: number | string,
    guardId: number | string,
  ): Promise<JobMatch> {
    const numericSlotId = Number(jobSlotId);
    const numericGuardId = Number(guardId);

    const slot = await this.getSlotById(numericSlotId);
    if (!slot?.job) {
      throw new NotFoundException('Job for slot not found');
    }

    const guard = await this.guardRepo.findOne({
      where: { id: numericGuardId as any },
    });

    if (!guard) {
      throw new NotFoundException('Guard not found');
    }

    const sourceType = this.getJobSourceType(slot.job);

    const match = this.matchRepo.create({
      jobSlot: slot,
      guard,
      matchScore: this.scoreGuard(guard, 0),
      matchReason: this.reasonFor(sourceType),
      sourceType:
        sourceType === JobSourceType.INTERNAL
          ? JobMatchSourceType.INTERNAL_POOL
          : JobMatchSourceType.MARKETPLACE_POOL,
      status: JobMatchStatus.SUGGESTED,
    });

    return this.matchRepo.save(match);
  }

  private async getSlotById(slotId: number): Promise<any> {
    const serviceAsAny = this.slotService as any;

    if (typeof serviceAsAny.findById === 'function') {
      return serviceAsAny.findById(slotId);
    }

    if (typeof serviceAsAny.findOne === 'function') {
      return serviceAsAny.findOne(slotId);
    }

    throw new NotFoundException('Job slot lookup method not available');
  }

  private getJobSourceType(job: any): JobSourceType {
    return job?.sourceType === JobSourceType.INTERNAL
      ? JobSourceType.INTERNAL
      : JobSourceType.MARKETPLACE;
  }

  private async internalCandidates(companyId: number): Promise<GuardProfile[]> {
    if (!companyId) {
      return [];
    }

    const relations = await this.companyGuardRepo.find({
      where: {
        company: { id: companyId },
        status: CompanyGuardStatus.ACTIVE,
      },
      relations: ['guard'],
    });

    return relations
      .map((relation) => relation.guard)
      .filter((guard): guard is GuardProfile => !!guard);
  }

  private async marketplaceCandidates(
    companyId: number,
  ): Promise<GuardProfile[]> {
    const activeCompanyGuards = companyId
      ? await this.companyGuardRepo.find({
          where: {
            company: { id: companyId },
            status: CompanyGuardStatus.ACTIVE,
          },
          relations: ['guard'],
        })
      : [];

    const excludedIds = activeCompanyGuards
      .map((entry) => entry.guard?.id)
      .filter((id): id is number => typeof id === 'number');

    if (excludedIds.length === 0) {
      return this.guardRepo.find();
    }

    return this.guardRepo.find({
      where: { id: Not(In(excludedIds)) as any },
    });
  }

  private async excludeUnavailableByShift(
    candidates: GuardProfile[],
    startAt?: Date,
    endAt?: Date,
  ): Promise<GuardProfile[]> {
    if (!startAt || !endAt || candidates.length === 0) {
      return candidates;
    }

    const candidateIds = candidates.map((candidate) => candidate.id);

    const overlappingShifts = await this.shiftRepo
      .createQueryBuilder('shift')
      .select('shift.guardId', 'guardId')
      .where('shift.guardId IN (:...candidateIds)', { candidateIds })
      .andWhere('shift.startAt < :endAt', { endAt })
      .andWhere('shift.endAt > :startAt', { startAt })
      .groupBy('shift.guardId')
      .getRawMany<{ guardId: string }>();

    const blocked = new Set(overlappingShifts.map((row) => Number(row.guardId)));

    return candidates.filter((candidate) => !blocked.has(candidate.id));
  }

  private scoreGuard(guard: GuardProfile, index: number): number {
    const statusBonus = (guard as any).status === 'approved' ? 15 : 0;
    return Math.max(0, 100 - index * 5 + statusBonus);
  }

  private reasonFor(jobSourceType: JobSourceType): string {
    if (jobSourceType === JobSourceType.INTERNAL) {
      return 'Matched from active internal company guard pool';
    }

    return 'Matched from marketplace guard pool with no shift overlap';
  }
}