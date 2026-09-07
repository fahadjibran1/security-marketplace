import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CompanyGuard } from '../../company-guard/entities/company-guard.entity';
import { Company } from '../../company/entities/company.entity';

export enum GuardPayFrequency {
  WEEKLY      = 'WEEKLY',
  FORTNIGHTLY = 'FORTNIGHTLY',
  FOUR_WEEKLY = 'FOUR_WEEKLY',
  MONTHLY     = 'MONTHLY',
  IRREGULAR   = 'IRREGULAR',
}

export enum GuardPayrollPaymentMethod {
  BACS  = 'BACS',
  CHAPS = 'CHAPS',
  CASH  = 'CASH',
  OTHER = 'OTHER',
}

export enum GuardPayrollStatus {
  ACTIVE   = 'ACTIVE',
  ON_HOLD  = 'ON_HOLD',
  EXCLUDED = 'EXCLUDED',
}

@Entity('company_guard_payroll_records')
export class CompanyGuardPayroll {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  companyGuardId!: number;

  @OneToOne(() => CompanyGuard, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'companyGuardId' })
  companyGuard!: CompanyGuard;

  // Denormalised FK — enables the partial unique index on (companyId, payrollReference).
  @Column()
  companyId!: number;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'companyId' })
  company!: Company;

  @Column({ type: 'varchar', length: 50, nullable: true })
  payrollReference?: string | null;

  @Column({
    type: 'enum',
    enum: GuardPayFrequency,
    enumName: 'guard_pay_frequency_enum',
    nullable: true,
  })
  payFrequency?: GuardPayFrequency | null;

  @Column({
    type: 'enum',
    enum: GuardPayrollPaymentMethod,
    enumName: 'guard_payroll_payment_method_enum',
    nullable: true,
  })
  payrollPaymentMethod?: GuardPayrollPaymentMethod | null;

  @Column({
    type: 'enum',
    enum: GuardPayrollStatus,
    enumName: 'guard_payroll_status_enum',
    default: GuardPayrollStatus.ACTIVE,
  })
  payrollStatus!: GuardPayrollStatus;

  @Column({ type: 'date', nullable: true })
  payrollStartDate?: string | null;

  @Column({ type: 'date', nullable: true })
  payrollEndDate?: string | null;

  // Company-owned internal note. Never returned to Guard, Admin, or CompanyStaff.
  @Column({ type: 'text', nullable: true, select: false })
  payrollNoteEnc?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
