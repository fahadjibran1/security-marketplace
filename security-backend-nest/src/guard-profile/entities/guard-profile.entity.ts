import {
  Column,
  Entity,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../user/entities/user.entity';
import { JobApplication } from '../../job-application/entities/job-application.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';
import { Shift } from '../../shift/entities/shift.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';
import { CompanyGuard } from '../../company-guard/entities/company-guard.entity';
import { JobMatch } from '../../job-match/entities/job-match.entity';

export enum GuardAvailability {
  AVAILABLE = 'available',
  LIMITED = 'limited',
  UNAVAILABLE = 'unavailable',
}

export enum GuardApprovalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended',
}

@Entity('guard_profiles')
export class GuardProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => User, { eager: true })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column()
  fullName!: string;

  @Column({ unique: true })
  siaLicenseNumber!: string;

  @Column()
  phone!: string;

  @Column({ default: false })
  locationSharingEnabled!: boolean;

  @Column({ default: 'pending' })
  status!: string;

  @Column({
    type: 'enum',
    enum: GuardAvailability,
    default: GuardAvailability.AVAILABLE,
  })
  availability!: GuardAvailability;

  @Column({
    type: 'enum',
    enum: GuardApprovalStatus,
    default: GuardApprovalStatus.PENDING,
  })
  approvalStatus!: GuardApprovalStatus;

  @Column({ default: false })
  isApproved!: boolean;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @OneToMany(() => JobApplication, (application) => application.guard)
  applications?: JobApplication[];

  @OneToMany(() => Assignment, (assignment) => assignment.guard)
  assignments?: Assignment[];

  @OneToMany(() => Shift, (shift) => shift.guard)
  shifts?: Shift[];

  @OneToMany(() => Timesheet, (timesheet) => timesheet.guard)
  timesheets?: Timesheet[];

  @OneToMany(() => CompanyGuard, (companyGuard) => companyGuard.guard)
  companyGuards?: CompanyGuard[];

  @OneToMany(() => JobMatch, (jobMatch) => jobMatch.guard)
  jobMatches?: JobMatch[];
}
