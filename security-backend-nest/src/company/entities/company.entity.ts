import {
  Column,
  Entity,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../user/entities/user.entity';
import { Job } from '../../job/entities/job.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';
import { Shift } from '../../shift/entities/shift.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';
import { CompanyGuard } from '../../company-guard/entities/company-guard.entity';
import { Site } from '../../site/entities/site.entity';
import { Client } from '../../client/entities/client.entity';
import { InvoiceBatch } from '../../invoice-batch/entities/invoice-batch.entity';
import { PaymentRecord } from '../../payment-record/entities/payment-record.entity';
import { PayrollBatch } from '../../payroll-batch/entities/payroll-batch.entity';
import { CompanyVerificationStatus } from '../company-verification';

export enum CompanyStatus {
  ONBOARDING = 'onboarding',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => User, { eager: true, nullable: false })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column()
  name!: string;

  @Column()
  companyNumber!: string;

  @Column()
  address!: string;

  @Column()
  contactDetails!: string;

  @Column({ default: false })
  autoCreatePayrollBatch!: boolean;

  @Column({ default: false })
  autoCreateInvoiceBatch!: boolean;

  @Column({ default: false })
  autoFinalisePayrollBatch!: boolean;

  @Column({ default: false })
  autoIssueInvoiceBatch!: boolean;

  @Column({
    type: 'enum',
    enum: CompanyStatus,
    default: CompanyStatus.ONBOARDING,
  })
  status!: CompanyStatus;

  /**
   * SEC-PUBLIC-03 verification lifecycle (Migration 76). New companies start pending; every company that existed when
   * Migration 76 ran was backfilled `approved`, so the pilot companies keep their access. Changed only by an S4 platform
   * administrator (PUT /admin/companies/:companyId/verification, audited as company.verification_changed).
   */
  @Column({
    type: 'enum',
    enum: CompanyVerificationStatus,
    enumName: 'company_verification_status_enum',
    default: CompanyVerificationStatus.PENDING_VERIFICATION,
  })
  verificationStatus!: CompanyVerificationStatus;

  /** The administrator's reason, shown to the company (required for a rejection or suspension). */
  @Column({ type: 'text', nullable: true })
  verificationNote?: string | null;

  /** When the current verification state was decided (null until first decided, including for the Migration 76 backfill). */
  @Column({ type: 'timestamptz', nullable: true })
  verificationDecidedAt?: Date | null;

  /**
   * Patrol Management feature switch (Migration 68), off by default; only an S4 platform administrator changes it
   * (PUT /admin/patrols/companies/:companyId, audited). `select: false` keeps every existing company response exactly as
   * it was: the flag is read explicitly where Patrols needs it, never serialised with the company.
   */
  @Column({ type: 'boolean', default: false, select: false })
  patrolsEnabled?: boolean;

  @OneToMany(() => Job, (job) => job.company)
  jobs?: Job[];

  @OneToMany(() => Assignment, (assignment) => assignment.company)
  assignments?: Assignment[];

  @OneToMany(() => Shift, (shift) => shift.company)
  shifts?: Shift[];

  @OneToMany(() => Timesheet, (timesheet) => timesheet.company)
  timesheets?: Timesheet[];

  @OneToMany(() => CompanyGuard, (companyGuard) => companyGuard.company)
  companyGuards?: CompanyGuard[];

  @OneToMany(() => Site, (site) => site.company)
  sites?: Site[];

  @OneToMany(() => Client, (client) => client.company)
  clients?: Client[];

  @OneToMany(() => PayrollBatch, (payrollBatch) => payrollBatch.company)
  payrollBatches?: PayrollBatch[];

  @OneToMany(() => InvoiceBatch, (invoiceBatch) => invoiceBatch.company)
  invoiceBatches?: InvoiceBatch[];

  @OneToMany(() => PaymentRecord, (paymentRecord) => paymentRecord.company)
  paymentRecords?: PaymentRecord[];
}
