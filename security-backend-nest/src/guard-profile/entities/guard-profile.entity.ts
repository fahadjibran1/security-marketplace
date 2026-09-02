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
import { GuardDocument } from '../../compliance/entities/guard-document.entity';

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

  @OneToOne(() => User, { eager: true, nullable: false })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column()
  fullName!: string;

  @Column({ unique: true })
  siaLicenseNumber!: string;

  @Column({ type: 'date', nullable: true })
  siaExpiryDate?: string | null;

  @Column({ type: 'varchar', nullable: true })
  rightToWorkStatus?: string | null;

  @Column({ type: 'date', nullable: true })
  rightToWorkExpiryDate?: string | null;

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

  // P1A — sensitive identity fields. select: false prevents accidental inclusion
  // in general queries. Must be explicitly selected via createQueryBuilder addSelect.
  @Column({ type: 'text', nullable: true, select: false })
  ninoEnc?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, select: false })
  ninoHmac?: string | null;

  @Column({ type: 'text', nullable: true, select: false })
  utrEnc?: string | null;

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

  @OneToMany(() => GuardDocument, (document) => document.guard)
  documents?: GuardDocument[];
}
