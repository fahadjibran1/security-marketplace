import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Shift } from '../../shift/entities/shift.entity';

export enum SafetyAlertType {
  CHECK_CALL = 'check_call',
  PANIC = 'panic',
  WELFARE = 'welfare',
  LATE_CHECKIN = 'late_checkin',
  MISSED_CHECKCALL = 'missed_checkcall',
  OTHER = 'other',
}

export enum SafetyAlertPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum SafetyAlertStatus {
  OPEN = 'open',
  ACKNOWLEDGED = 'acknowledged',
  CLOSED = 'closed',
}

@Entity('safety_alerts')
export class SafetyAlert {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, { eager: true, onDelete: 'CASCADE' })
  company!: Company;

  @ManyToOne(() => GuardProfile, { eager: true, onDelete: 'CASCADE' })
  guard!: GuardProfile;

  @ManyToOne(() => Shift, { eager: true, nullable: true, onDelete: 'SET NULL' })
  shift?: Shift | null;

  @Column({
    type: 'enum',
    enum: SafetyAlertType,
    default: SafetyAlertType.OTHER,
  })
  type!: SafetyAlertType;

  @Column({
    type: 'enum',
    enum: SafetyAlertPriority,
    default: SafetyAlertPriority.MEDIUM,
  })
  priority!: SafetyAlertPriority;

  @Column({ type: 'text' })
  message!: string;

  @Column({
    type: 'enum',
    enum: SafetyAlertStatus,
    default: SafetyAlertStatus.OPEN,
  })
  status!: SafetyAlertStatus;

  @Column({ type: 'timestamp', nullable: true })
  acknowledgedAt?: Date | null;

  @Column({ type: 'int', nullable: true })
  acknowledgedByUserId?: number | null;

  @Column({ type: 'timestamp', nullable: true })
  closedAt?: Date | null;

  @Column({ type: 'int', nullable: true })
  closedByUserId?: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
