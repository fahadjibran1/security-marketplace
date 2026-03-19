import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobSlot, JobSlotStatus } from './entities/job-slot.entity';

@Injectable()
export class JobSlotService {
  constructor(
    @InjectRepository(JobSlot)
    private readonly jobSlotRepo: Repository<JobSlot>,
  ) {}

  async findAll(): Promise<JobSlot[]> {
    return this.jobSlotRepo.find({
      relations: ['job'],
    });
  }

  async findOne(id: number): Promise<JobSlot> {
    const slot = await this.jobSlotRepo.findOne({
      where: { id },
      relations: ['job'],
    });

    if (!slot) {
      throw new NotFoundException(`Job slot with id ${id} not found`);
    }

    return slot;
  }

  async findById(id: number): Promise<JobSlot> {
    return this.findOne(id);
  }

  async findByJob(jobId: number): Promise<JobSlot[]> {
    return this.jobSlotRepo.find({
      where: {
        job: { id: jobId } as any,
      },
      relations: ['job'],
    });
  }

  async createSlotsForJob(jobId: number, count: number): Promise<JobSlot[]> {
    const slots: JobSlot[] = [];

    for (let i = 1; i <= count; i++) {
      const slot = this.jobSlotRepo.create({
        job: { id: jobId } as any,
        slotNumber: i,
        status: JobSlotStatus.OPEN,
      });

      slots.push(slot);
    }

    return this.jobSlotRepo.save(slots);
  }

  async markReserved(id: number): Promise<JobSlot> {
    const slot = await this.findOne(id);

    slot.status = (
      'RESERVED' in JobSlotStatus
        ? (JobSlotStatus as Record<string, JobSlotStatus>).RESERVED
        : JobSlotStatus.OPEN
    ) as JobSlotStatus;

    return this.jobSlotRepo.save(slot);
  }

  async markFilled(id: number): Promise<JobSlot> {
    const slot = await this.findOne(id);
    slot.status = JobSlotStatus.FILLED;
    return this.jobSlotRepo.save(slot);
  }

  async markOpen(id: number): Promise<JobSlot> {
    const slot = await this.findOne(id);
    slot.status = JobSlotStatus.OPEN;
    return this.jobSlotRepo.save(slot);
  }

  async markCancelled(id: number): Promise<JobSlot> {
    const slot = await this.findOne(id);
    slot.status = JobSlotStatus.CANCELLED;
    return this.jobSlotRepo.save(slot);
  }
}
