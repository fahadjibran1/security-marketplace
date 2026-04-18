import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Company } from '../../company/entities/company.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';

export enum PayrollBatchStatus {
  DRAFT = 'draft',
  FINALISED = 'finalised',
  PAID = 'paid',
}

@Entity('payroll_batches')
export class PayrollBatch {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, (company) => company.payrollBatches, { eager: true })
  company!: Company;

  @Column({ type: 'timestamp' })
  periodStart!: Date;

  @Column({ type: 'timestamp' })
  periodEnd!: Date;

  @Column({
    type: 'enum',
    enum: PayrollBatchStatus,
    default: PayrollBatchStatus.DRAFT,
  })
  status!: string;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @Column({ type: 'int', nullable: true })
  createdByUserId?: number | null;

  @Column({ type: 'timestamp', nullable: true })
  finalisedAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  paidAt?: Date | null;

  @OneToMany(() => Timesheet, (timesheet) => timesheet.payrollBatch)
  timesheets?: Timesheet[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
