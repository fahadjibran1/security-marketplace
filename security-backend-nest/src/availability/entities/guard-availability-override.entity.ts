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

export enum GuardAvailabilityOverrideStatus {
  AVAILABLE = 'available',
  UNAVAILABLE = 'unavailable',
}

@Entity('guard_availability_overrides')
export class GuardAvailabilityOverride {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, { eager: true, nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company?: Company | null;

  @ManyToOne(() => GuardProfile, { eager: true, nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'guardId' })
  guard!: GuardProfile;

  @Column({ type: 'date' })
  date!: string;

  @Column({ type: 'varchar', length: 5, nullable: true })
  startTime?: string | null;

  @Column({ type: 'varchar', length: 5, nullable: true })
  endTime?: string | null;

  @Column({
    type: 'enum',
    enum: GuardAvailabilityOverrideStatus,
  })
  status!: GuardAvailabilityOverrideStatus;

  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
