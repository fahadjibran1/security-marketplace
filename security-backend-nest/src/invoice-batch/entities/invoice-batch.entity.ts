import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Client } from '../../client/entities/client.entity';
import { Company } from '../../company/entities/company.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';

export enum InvoiceBatchStatus {
  DRAFT = 'draft',
  FINALISED = 'finalised',
  ISSUED = 'issued',
  PAID = 'paid',
}

@Entity('invoice_batches')
export class InvoiceBatch {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, (company) => company.invoiceBatches, { eager: true })
  company!: Company;

  @ManyToOne(() => Client, (client) => client.invoiceBatches, { eager: true })
  client!: Client;

  @Column({ type: 'timestamp' })
  periodStart!: Date;

  @Column({ type: 'timestamp' })
  periodEnd!: Date;

  @Column({
    type: 'enum',
    enum: InvoiceBatchStatus,
    default: InvoiceBatchStatus.DRAFT,
  })
  status!: string;

  @Column({ type: 'varchar', nullable: true })
  invoiceReference?: string | null;

  @Column({ type: 'varchar', nullable: true, unique: true })
  invoiceNumber?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  dueDate?: Date | null;

  @Column({ type: 'text', nullable: true })
  billingAddressSnapshot?: string | null;

  @Column({ type: 'varchar', nullable: true })
  clientNameSnapshot?: string | null;

  @Column({ type: 'varchar', nullable: true })
  companyNameSnapshot?: string | null;

  @Column({ type: 'text', nullable: true })
  companyAddressSnapshot?: string | null;

  @Column({ type: 'int', nullable: true, default: 30 })
  paymentTermsDays?: number | null;

  @Column({ type: 'varchar', nullable: true, default: 'GBP' })
  currency?: string | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true, default: 20 })
  vatRate?: number | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  netAmountSnapshot?: number | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  vatAmountSnapshot?: number | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  grossAmountSnapshot?: number | null;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @Column({ type: 'int', nullable: true })
  createdByUserId?: number | null;

  @Column({ type: 'timestamp', nullable: true })
  finalisedAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  issuedAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  paidAt?: Date | null;

  @OneToMany(() => Timesheet, (timesheet) => timesheet.invoiceBatch)
  timesheets?: Timesheet[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
