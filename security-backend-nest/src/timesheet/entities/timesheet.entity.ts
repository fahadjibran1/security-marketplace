import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Shift } from '../../shift/entities/shift.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Company } from '../../company/entities/company.entity';
import { InvoiceBatch } from '../../invoice-batch/entities/invoice-batch.entity';
import { PayrollBatch } from '../../payroll-batch/entities/payroll-batch.entity';

export enum TimesheetStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  RETURNED = 'returned',
}

export enum TimesheetPayrollStatus {
  UNPAID = 'unpaid',
  INCLUDED = 'included',
  PAID = 'paid',
}

export enum TimesheetBillingStatus {
  UNINVOICED = 'uninvoiced',
  INCLUDED = 'included',
  INVOICED = 'invoiced',
}

@Entity('timesheets')
export class Timesheet {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Shift, (shift) => shift.timesheets, { eager: true })
  shift!: Shift;

  @ManyToOne(() => GuardProfile, (guard) => guard.timesheets, { eager: true })
  guard!: GuardProfile;

  @ManyToOne(() => Company, (company) => company.timesheets, { eager: true })
  company!: Company;

  @Column({ type: 'numeric', precision: 8, scale: 2, default: 0 })
  hoursWorked!: number;

  @Column({
    type: 'enum',
    enum: TimesheetStatus,
    default: TimesheetStatus.DRAFT,
  })
  approvalStatus!: string;

  @Column({ type: 'timestamp', nullable: true })
  scheduledStartAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  scheduledEndAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  actualCheckInAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  actualCheckOutAt?: Date | null;

  @Column({ type: 'text', nullable: true })
  guardNote?: string | null;

  @Column({ type: 'text', nullable: true })
  companyNote?: string | null;

  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  approvedHours?: number | null;

  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  approvedHoursSnapshot?: number | null;

  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
  hourlyRateSnapshot?: number | null;

  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  payableHoursSnapshot?: number | null;

  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
  payableAmountSnapshot?: number | null;

  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
  billingRateSnapshot?: number | null;

  @Column({
    type: 'enum',
    enum: TimesheetPayrollStatus,
    default: TimesheetPayrollStatus.UNPAID,
  })
  payrollStatus!: string;

  @Column({ type: 'timestamp', nullable: true })
  payrollIncludedAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  payrollPaidAt?: Date | null;

  @ManyToOne(() => PayrollBatch, (payrollBatch) => payrollBatch.timesheets, {
    eager: true,
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'payrollBatchId' })
  payrollBatch?: PayrollBatch | null;

  @Column({
    type: 'enum',
    enum: TimesheetBillingStatus,
    default: TimesheetBillingStatus.UNINVOICED,
  })
  billingStatus!: string;

  @Column({ type: 'timestamp', nullable: true })
  invoiceIssuedAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  invoicePaidAt?: Date | null;

  @ManyToOne(() => InvoiceBatch, (invoiceBatch) => invoiceBatch.timesheets, {
    eager: true,
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'invoiceBatchId' })
  invoiceBatch?: InvoiceBatch | null;

  @Column({ type: 'int', default: 0 })
  workedMinutes!: number;

  @Column({ type: 'int', default: 0 })
  breakMinutes!: number;

  @Column({ type: 'int', default: 0 })
  roundedMinutes!: number;

  @Column({ type: 'timestamp', nullable: true })
  submittedAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  reviewedAt?: Date | null;

  @Column({ type: 'int', nullable: true })
  reviewedByUserId?: number | null;

  @Column({ type: 'text', nullable: true })
  rejectionReason?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  billingRate?: number | null;
  effectiveBillingRate?: number | null;
  billableHours?: number | null;
  costAmount?: number | null;
  revenueAmount?: number | null;
  marginAmount?: number | null;
  marginPercent?: number | null;
  matchedContractRuleId?: number | null;
  matchedContractRuleName?: string | null;
  payableHours?: number | null;
  payableAmount?: number | null;
  payBreakdown?: Record<string, unknown> | null;
}
