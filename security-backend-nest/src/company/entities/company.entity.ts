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
import { PayrollBatch } from '../../payroll-batch/entities/payroll-batch.entity';

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

  @OneToOne(() => User, { eager: true })
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

  @Column({
    type: 'enum',
    enum: CompanyStatus,
    default: CompanyStatus.ONBOARDING,
  })
  status!: CompanyStatus;

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
}
