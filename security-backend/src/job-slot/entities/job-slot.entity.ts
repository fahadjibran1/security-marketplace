import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Job } from '../../job/entities/job.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';
import { JobMatch } from '../../job-match/entities/job-match.entity';

export enum JobSlotStatus {
  OPEN = 'OPEN',
  FILLED = 'FILLED',
  CANCELLED = 'CANCELLED',
}

@Entity('job_slots')
export class JobSlot {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToMany(() => JobMatch, (match) => match.jobSlot)
  matches!: JobMatch[];

  @ManyToOne(() => Job, (job) => job.slots, { eager: true })
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

  @OneToOne(() => Assignment, (assignment) => assignment.jobSlot, {
    nullable: true,
  })
  assignment?: Assignment | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}