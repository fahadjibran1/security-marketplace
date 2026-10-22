import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Company } from '../../company/entities/company.entity';

const numeric = { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) };

/**
 * A company's Live Shift Amendment policy (Migration 64). No row means the defaults in shift-amendment-policy.ts with
 * amendments DISABLED. `amendmentsEnabled` is switched only by S4 (platform administrator), never by the company:
 * activation is an S4 owner decision (D5). The thresholds are planning safeguards on scheduled hours, not legal limits.
 */
@Entity('company_shift_policies')
@Check('CHK_company_shift_policies_positive', `"fatigueWarningHours" > 0 AND "approvalRequiredHours" > 0 AND "minRestHours" >= 0 AND "weeklyReviewHours" > 0 AND "lastMinuteWarningMinutes" >= 0`)
@Check('CHK_company_shift_policies_order', `"fatigueWarningHours" <= "approvalRequiredHours" AND ("hardLimitHours" IS NULL OR "hardLimitHours" >= "approvalRequiredHours")`)
@Index('UQ_company_shift_policies_company', ['companyId'], { unique: true })
export class CompanyShiftPolicy {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId', foreignKeyConstraintName: 'FK_company_shift_policies_company' })
  company?: Company;

  @Column({ type: 'boolean', default: false })
  amendmentsEnabled!: boolean;

  @Column({ type: 'numeric', precision: 5, scale: 2, default: 12, transformer: numeric })
  fatigueWarningHours!: number;

  @Column({ type: 'numeric', precision: 5, scale: 2, default: 14, transformer: numeric })
  approvalRequiredHours!: number;

  /** Null = no hard limit. */
  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true, default: 16, transformer: numeric })
  hardLimitHours!: number | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, default: 11, transformer: numeric })
  minRestHours!: number;

  @Column({ type: 'numeric', precision: 6, scale: 2, default: 48, transformer: numeric })
  weeklyReviewHours!: number;

  @Column({ type: 'int', default: 10 })
  lastMinuteWarningMinutes!: number;

  @Column({ type: 'int', nullable: true })
  updatedByUserId!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
