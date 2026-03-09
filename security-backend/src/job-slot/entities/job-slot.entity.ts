import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Job } from '../../job/entities/job.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';

export enum JobSlotStatus {
  OPEN = 'OPEN',
  FILLED = 'FILLED',
  CANCELLED = 'CANCELLED',
}

@Entity('job_slots')
export class JobSlot {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Job, (job) => job.slots, { eager: true })
  job!: Job;

  @Column({ type: 'int' })
  slotNumber!: number;

  @Column({ type: 'enum', enum: JobSlotStatus, default: JobSlotStatus.OPEN })
  status!: JobSlotStatus;

  @ManyToOne(() => GuardProfile, { eager: true, nullable: true })
  assignedGuard?: GuardProfile | null;

  @OneToOne(() => Assignment, (assignment) => assignment.jobSlot)
  assignment?: Assignment | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
