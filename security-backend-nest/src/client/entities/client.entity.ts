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
import { InvoiceBatch } from '../../invoice-batch/entities/invoice-batch.entity';
import { Site } from '../../site/entities/site.entity';

@Entity('clients')
export class Client {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, (company) => company.clients, { eager: true, onDelete: 'CASCADE' })
  company!: Company;

  @Column()
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  contactName?: string | null;

  @Column({ type: 'varchar', nullable: true })
  contactEmail?: string | null;

  @Column({ type: 'varchar', nullable: true })
  contactPhone?: string | null;

  @Column({ type: 'text', nullable: true })
  contactDetails?: string | null;

  @Column({ default: 'active' })
  status!: string;

  @OneToMany(() => Site, (site) => site.client)
  sites?: Site[];

  @OneToMany(() => InvoiceBatch, (invoiceBatch) => invoiceBatch.client)
  invoiceBatches?: InvoiceBatch[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
