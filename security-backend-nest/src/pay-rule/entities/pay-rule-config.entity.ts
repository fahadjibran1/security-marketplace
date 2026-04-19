import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Company } from '../../company/entities/company.entity';

@Entity('pay_rule_configs')
export class PayRuleConfig {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => Company, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company!: Company;

  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  overtimeThresholdHours?: number | null;

  @Column({ type: 'numeric', precision: 6, scale: 2, default: 1 })
  overtimeMultiplier!: number;

  @Column({ type: 'varchar', length: 5, nullable: true })
  nightStart?: string | null;

  @Column({ type: 'varchar', length: 5, nullable: true })
  nightEnd?: string | null;

  @Column({ type: 'numeric', precision: 6, scale: 2, default: 1 })
  nightMultiplier!: number;

  @Column({ type: 'numeric', precision: 6, scale: 2, default: 1 })
  weekendMultiplier!: number;

  @Column({ type: 'numeric', precision: 6, scale: 2, default: 1 })
  bankHolidayMultiplier!: number;

  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  minimumPaidHours?: number | null;

  @Column({ type: 'int', default: 0 })
  unpaidBreakMinutes!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
