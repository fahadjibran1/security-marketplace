import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobSlot, JobSlotStatus } from './entities/job-slot.entity';
import { Job } from '../job/entities/job.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';

@Injectable()
export class JobSlotService {
  constructor(@InjectRepository(JobSlot) private readonly slotRepo: Repository<JobSlot>) {}

  async createSlotsForJob(job: Job): Promise<JobSlot[]> {
    if (job.guardsRequired < 1) {
      throw new BadRequestException('guardsRequired must be at least 1');
    }

    const slots = Array.from({ length: job.guardsRequired }, (_, idx) =>
      this.slotRepo.create({
        job,
        slotNumber: idx + 1,
        status: JobSlotStatus.OPEN,
      }),
    );

    return this.slotRepo.save(slots);
  }

  findAll(): Promise<JobSlot[]> {
    return this.slotRepo.find();
  }

  async findOpenSlotForJob(jobId: number): Promise<JobSlot> {
    const slot = await this.slotRepo.findOne({
      where: { job: { id: jobId }, status: JobSlotStatus.OPEN },
      order: { slotNumber: 'ASC' },
    });

    if (!slot) {
      throw new NotFoundException('No open job slot available for this job');
    }

    return slot;
  }

  async findById(id: number): Promise<JobSlot> {
    const slot = await this.slotRepo.findOne({ where: { id } });
    if (!slot) throw new NotFoundException('Job slot not found');
    return slot;
  }

  async markFilled(slotId: number, guard: GuardProfile): Promise<JobSlot> {
    const slot = await this.findById(slotId);
    if (slot.status !== JobSlotStatus.OPEN) {
      throw new BadRequestException('Job slot is not open');
    }

    slot.status = JobSlotStatus.FILLED;
    slot.assignedGuard = guard;
    return this.slotRepo.save(slot);
  }

  async reopenSlot(slotId: number): Promise<JobSlot> {
    const slot = await this.findById(slotId);
    slot.status = JobSlotStatus.OPEN;
    slot.assignedGuard = null;
    return this.slotRepo.save(slot);
  }

}
