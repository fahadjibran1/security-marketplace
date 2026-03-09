import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { JobSlot } from '../../job-slot/entities/job-slot.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum JobMatchSourceType {
  INTERNAL_POOL = 'INTERNAL_POOL',
  MARKETPLACE_POOL = 'MARKETPLACE_POOL',
}

export enum JobMatchStatus {
  SUGGESTED = 'SUGGESTED',
  INVITED = 'INVITED',
  VIEWED = 'VIEWED',
  DECLINED = 'DECLINED',
  APPLIED = 'APPLIED',
  ASSIGNED = 'ASSIGNED',
}

@Entity('job_matches')
@Unique(['jobSlot', 'guard'])
export class JobMatch {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => JobSlot, (slot) => slot.matches, { eager: true })
  jobSlot!: JobSlot;

  @ManyToOne(() => GuardProfile, (guard) => guard.jobMatches, { eager: true })
  guard!: GuardProfile;

  @Column({ type: 'numeric', precision: 5, scale: 2 })
  matchScore!: number;

  @Column({ type: 'text' })
  matchReason!: string;

  @Column({ type: 'enum', enum: JobMatchSourceType })
  sourceType!: JobMatchSourceType;

  @Column({ type: 'enum', enum: JobMatchStatus, default: JobMatchStatus.SUGGESTED })
  status!: JobMatchStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
