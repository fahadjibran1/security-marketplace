import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum GuardLeaveType {
  ANNUAL_LEAVE = 'annual_leave',
  SICK = 'sick',
  UNAVAILABLE = 'unavailable',
  TRAINING = 'training',
  SUSPENSION = 'suspension',
  OTHER = 'other',
}

export enum GuardLeaveStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

@Entity('guard_leave')
export class GuardLeave {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company!: Company;

  @ManyToOne(() => GuardProfile, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'guardId' })
  guard!: GuardProfile;

  @Column({
    type: 'enum',
    enum: GuardLeaveType,
  })
  leaveType!: GuardLeaveType;

  @Column({ type: 'timestamp' })
  startAt!: Date;

  @Column({ type: 'timestamp' })
  endAt!: Date;

  @Column({ type: 'text', nullable: true })
  reason?: string | null;

  @Column({
    type: 'enum',
    enum: GuardLeaveStatus,
    default: GuardLeaveStatus.PENDING,
  })
  status!: GuardLeaveStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
