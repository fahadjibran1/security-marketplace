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

export enum ComplianceRecordType {
  SIA = 'SIA',
  RIGHT_TO_WORK = 'RIGHT_TO_WORK',
  TRAINING = 'TRAINING',
  OTHER = 'OTHER',
}

export enum ComplianceRecordStatus {
  VALID = 'valid',
  EXPIRING = 'expiring',
  EXPIRED = 'expired',
}

@Entity('compliance_records')
export class ComplianceRecord {
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
    enum: ComplianceRecordType,
  })
  type!: ComplianceRecordType;

  @Column()
  documentName!: string;

  @Column({ nullable: true })
  documentNumber?: string | null;

  @Column({ type: 'date', nullable: true })
  issueDate?: string | null;

  @Column({ type: 'date' })
  expiryDate!: string;

  @Column({
    type: 'enum',
    enum: ComplianceRecordStatus,
    default: ComplianceRecordStatus.VALID,
  })
  status!: ComplianceRecordStatus;

  @Column({ type: 'timestamp', nullable: true })
  reminderSentAt?: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
