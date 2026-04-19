import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Client } from '../../client/entities/client.entity';
import { Company } from '../../company/entities/company.entity';
import { Site } from '../../site/entities/site.entity';

export enum ContractPricingRuleStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

@Entity('contract_pricing_rules')
export class ContractPricingRule {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, { eager: true, onDelete: 'CASCADE' })
  company!: Company;

  @ManyToOne(() => Client, { eager: true, onDelete: 'CASCADE' })
  client!: Client;

  @ManyToOne(() => Site, { eager: true, nullable: true, onDelete: 'SET NULL' })
  site?: Site | null;

  @Column()
  name!: string;

  @Column({
    type: 'enum',
    enum: ContractPricingRuleStatus,
    default: ContractPricingRuleStatus.ACTIVE,
  })
  status!: string;

  @Column({ type: 'int', default: 100 })
  priority!: number;

  @Column({ type: 'timestamp', nullable: true })
  effectiveFrom?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  effectiveTo?: Date | null;

  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
  billingRate?: number | null;

  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  minimumBillableHours?: number | null;

  @Column({ type: 'int', nullable: true })
  roundUpToMinutes?: number | null;

  @Column({ type: 'int', nullable: true })
  graceMinutes?: number | null;

  @Column({ default: true })
  appliesOnMonday!: boolean;

  @Column({ default: true })
  appliesOnTuesday!: boolean;

  @Column({ default: true })
  appliesOnWednesday!: boolean;

  @Column({ default: true })
  appliesOnThursday!: boolean;

  @Column({ default: true })
  appliesOnFriday!: boolean;

  @Column({ default: true })
  appliesOnSaturday!: boolean;

  @Column({ default: true })
  appliesOnSunday!: boolean;

  @Column({ type: 'varchar', nullable: true })
  startTime?: string | null;

  @Column({ type: 'varchar', nullable: true })
  endTime?: string | null;

  @Column({ type: 'boolean', nullable: true })
  appliesOnBankHoliday?: boolean | null;

  @Column({ default: false })
  appliesOnWeekendOnly!: boolean;

  @Column({ type: 'boolean', nullable: true })
  appliesOnOvernightShift?: boolean | null;

  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
  flatCallOutFee?: number | null;

  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  deductionHoursBeforeBilling?: number | null;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
