import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Shift } from '../../shift/entities/shift.entity';

export enum IncidentSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

@Entity('incidents')
export class Incident {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, { eager: true, onDelete: 'CASCADE' })
  company!: Company;

  @ManyToOne(() => GuardProfile, { eager: true, onDelete: 'CASCADE' })
  guard!: GuardProfile;

  @ManyToOne(() => Shift, { eager: true, nullable: true, onDelete: 'SET NULL' })
  shift?: Shift | null;

  @Column()
  title!: string;

  @Column({ type: 'text' })
  notes!: string;

  @Column({
    type: 'enum',
    enum: IncidentSeverity,
    default: IncidentSeverity.MEDIUM,
  })
  severity!: IncidentSeverity;

  @Column({ type: 'varchar', nullable: true })
  locationText?: string | null;

  @Column({ default: 'open' })
  status!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
