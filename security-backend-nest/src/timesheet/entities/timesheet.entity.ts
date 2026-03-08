import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Shift } from '../../shift/entities/shift.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Company } from '../../company/entities/company.entity';

@Entity('timesheets')
export class Timesheet {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Shift, (shift) => shift.timesheets, { eager: true })
  shift!: Shift;

  @ManyToOne(() => GuardProfile, (guard) => guard.timesheets, { eager: true })
  guard!: GuardProfile;

  @ManyToOne(() => Company, (company) => company.timesheets, { eager: true })
  company!: Company;

  @Column({ type: 'numeric', precision: 8, scale: 2, default: 0 })
  hoursWorked!: number;

  @Column({ default: 'pending' })
  approvalStatus!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
