import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Shift } from '../../shift/entities/shift.entity';
import { Site } from '../../site/entities/site.entity';

export enum IncidentSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum IncidentCategory {
  TRESPASS = 'trespass',
  THEFT = 'theft',
  DAMAGE = 'damage',
  VIOLENCE = 'violence',
  FIRE = 'fire',
  HEALTH_SAFETY = 'health_safety',
  ACCESS_CONTROL = 'access_control',
  OTHER = 'other',
}

export enum IncidentStatus {
  OPEN = 'open',
  IN_REVIEW = 'in_review',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
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

  @ManyToOne(() => Site, { eager: true, nullable: true, onDelete: 'SET NULL' })
  site?: Site | null;

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

  @Column({
    type: 'enum',
    enum: IncidentCategory,
    default: IncidentCategory.OTHER,
  })
  category!: IncidentCategory;

  @Column({ type: 'varchar', nullable: true })
  locationText?: string | null;

  @Column({
    type: 'enum',
    enum: IncidentStatus,
    default: IncidentStatus.OPEN,
  })
  status!: string;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  reportedAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  reviewedAt?: Date | null;

  @Column({ type: 'int', nullable: true })
  reviewedByUserId?: number | null;

  @Column({ type: 'timestamp', nullable: true })
  closedAt?: Date | null;

  @Column({ type: 'int', nullable: true })
  closedByUserId?: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
