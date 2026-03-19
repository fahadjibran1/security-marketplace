import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  JoinColumn,
} from 'typeorm';

import { Job } from '../../job/entities/job.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';
import { JobMatch } from '../../job-match/entities/job-match.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum JobSlotStatus {
  OPEN = 'open',
  FILLED = 'filled',
  CANCELLED = 'cancelled',
}

@Entity('job_slots')
export class JobSlot {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Job, (job) => job.slots, { eager: true, onDelete: 'CASCADE' })
  job!: Job;

  @Column({ type: 'int' })
  slotNumber!: number;

  @Column({
    type: 'enum',
    enum: JobSlotStatus,
    default: JobSlotStatus.OPEN,
  })
  status!: JobSlotStatus;

  @ManyToOne(() => GuardProfile, { eager: true, nullable: true })
  assignedGuard?: GuardProfile | null;

  @Column({ type: 'int', nullable: true })
  assignedGuardId?: number | null;

  @OneToOne(() => Assignment, (assignment) => assignment.jobSlot, { nullable: true })
  @JoinColumn()
  assignment?: Assignment;

  @OneToMany(() => JobMatch, (match) => match.jobSlot)
  matches?: JobMatch[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}