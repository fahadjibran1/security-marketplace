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

@Entity('guard_availability_rules')
export class GuardAvailabilityRule {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, { eager: true, nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company?: Company | null;

  @ManyToOne(() => GuardProfile, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'guardId' })
  guard!: GuardProfile;

  @Column({ type: 'int' })
  weekday!: number;

  @Column({ type: 'varchar', length: 5 })
  startTime!: string;

  @Column({ type: 'varchar', length: 5 })
  endTime!: string;

  @Column({ type: 'boolean', default: true })
  isAvailable!: boolean;

  @Column({ type: 'date', nullable: true })
  effectiveFrom?: string | null;

  @Column({ type: 'date', nullable: true })
  effectiveTo?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
