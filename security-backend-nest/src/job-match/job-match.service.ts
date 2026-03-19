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
    const slot = await this.slotService.findById(slotId);
    if (!slot.job) {
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

    const candidates =
      slot.job.sourceType === JobSourceType.INTERNAL
        ? await this.internalCandidates(slot.job.company.id)
        : await this.marketplaceCandidates(slot.job.company.id);

    const available = await this.excludeUnavailableByShift(
      candidates,
      slot.job.startAt,
      slot.job.endAt,
    );

    const matches = available.map((guard, index) =>
      this.matchRepo.create({
        jobSlot: slot,
        guard,
        matchScore: Math.max(100 - index * 10, 10),
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

  async createMatchFromApplication(
    jobSlotId: number,
    guardId: number,
  ): Promise<JobMatch> {
    const slot = await this.slotService.findById(jobSlotId);
    if (!slot) {
      throw new NotFoundException('Job slot not found');
    }

    const guard = await this.guardRepo.findOne({ where: { id: guardId } });
    if (!guard) {
      throw new NotFoundException('Guard not found');
    }

    const existing = await this.matchRepo.findOne({
      where: {
        jobSlot: { id: jobSlotId },
        guard: { id: guardId },
      },
    });

    if (existing) {
      return existing;
    }

    const match = this.matchRepo.create({
      jobSlot: slot,
      guard,
      matchScore: 100,
      matchReason: 'Guard applied to this job slot',
      sourceType: JobMatchSourceType.MARKETPLACE_POOL,
      status: JobMatchStatus.APPLIED,
    });

    return this.matchRepo.save(match);
  }

  private async internalCandidates(companyId: number): Promise<GuardProfile[]> {
    const companyGuards = await this.companyGuardRepo.find({
      where: {
        company: { id: companyId },
        status: CompanyGuardStatus.ACTIVE,
      },
      relations: ['guard'],
    });

    return companyGuards
      .map((cg) => cg.guard)
      .filter((guard): guard is GuardProfile => !!guard);
  }

  private async marketplaceCandidates(companyId: number): Promise<GuardProfile[]> {
    const internalLinks = await this.companyGuardRepo.find({
      where: { company: { id: companyId } },
      relations: ['guard'],
    });

    const excludedGuardIds = internalLinks
      .map((link) => link.guard?.id)
      .filter((id): id is number => typeof id === 'number');

    if (excludedGuardIds.length > 0) {
      return this.guardRepo.find({
        where: {
          status: 'approved',
          id: Not(In(excludedGuardIds)),
        },
      });
    }

    return this.guardRepo.find({
      where: { status: 'approved' },
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

    const overlappingShifts = await this.shiftRepo.find({
      where: {
        status: In(['scheduled', 'in_progress']),
      },
      relations: ['guard'],
    });

    const blockedGuardIds = new Set(
      overlappingShifts
        .filter((shift) => {
          if (!shift.start || !shift.end || !shift.guard) return false;
          return shift.start < endAt && shift.end > startAt;
        })
        .map((shift) => shift.guard.id),
    );

    return candidates.filter((guard) => !blockedGuardIds.has(guard.id));
  }

  private reasonFor(sourceType: JobSourceType): string {
    return sourceType === JobSourceType.INTERNAL
      ? 'Matched from internal company guard pool'
      : 'Matched from marketplace guard pool';
  }
}
