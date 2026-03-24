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

export enum DailyLogType {
  PATROL = 'patrol',
  OBSERVATION = 'observation',
  VISITOR = 'visitor',
  DELIVERY = 'delivery',
  MAINTENANCE = 'maintenance',
  OTHER = 'other',
}

@Entity('daily_logs')
export class DailyLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, { eager: true, onDelete: 'CASCADE' })
  company!: Company;

  @ManyToOne(() => GuardProfile, { eager: true, onDelete: 'CASCADE' })
  guard!: GuardProfile;

  @ManyToOne(() => Shift, { eager: true, onDelete: 'CASCADE' })
  shift!: Shift;

  @Column({ type: 'text' })
  message!: string;

  @Column({
    type: 'enum',
    enum: DailyLogType,
    default: DailyLogType.OTHER,
  })
  logType!: DailyLogType;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
