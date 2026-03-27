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
import { Site } from '../../site/entities/site.entity';

@Entity('clients')
export class Client {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, (company) => company.clients, { eager: true, onDelete: 'CASCADE' })
  company!: Company;

  @Column()
  name!: string;

  @Column({ nullable: true })
  contactName?: string | null;

  @Column({ nullable: true })
  contactEmail?: string | null;

  @Column({ nullable: true })
  contactPhone?: string | null;

  @Column({ nullable: true })
  contactDetails?: string | null;

  @Column({ default: 'active' })
  status!: string;

  @OneToMany(() => Site, (site) => site.client)
  sites?: Site[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
