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
import { InvoiceBatch } from '../../invoice-batch/entities/invoice-batch.entity';

export enum PaymentMethod {
  BANK_TRANSFER = 'bank_transfer',
  CASH = 'cash',
  CARD = 'card',
  OTHER = 'other',
}

@Entity('payment_records')
export class PaymentRecord {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, (company) => company.paymentRecords, {
    eager: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'companyId' })
  company!: Company;

  @ManyToOne(() => InvoiceBatch, (invoiceBatch) => invoiceBatch.paymentRecords, {
    eager: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'invoiceBatchId' })
  invoiceBatch!: InvoiceBatch;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  amount!: number;

  @Column({ type: 'timestamp' })
  paymentDate!: Date;

  @Column({
    type: 'enum',
    enum: PaymentMethod,
    default: PaymentMethod.BANK_TRANSFER,
  })
  method!: string;

  @Column({ type: 'varchar', nullable: true })
  reference?: string | null;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
