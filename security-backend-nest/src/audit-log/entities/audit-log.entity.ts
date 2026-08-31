import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { User } from '../../user/entities/user.entity';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, { nullable: true, eager: true, onDelete: 'SET NULL' })
  @JoinColumn()
  company?: Company | null;

  @ManyToOne(() => User, { nullable: true, eager: true, onDelete: 'SET NULL' })
  @JoinColumn()
  user?: User | null;

  @Column('varchar')
  action!: string;

  @Column('varchar')
  entityType!: string;

  @Column('int', { nullable: true })
  entityId?: number | null;

  @Column('json', { nullable: true })
  beforeData?: Record<string, unknown> | null;

  @Column('json', { nullable: true })
  afterData?: Record<string, unknown> | null;

  @Column('varchar', { nullable: true })
  ipAddress?: string | null;

  @Column('varchar', { nullable: true })
  userAgent?: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
