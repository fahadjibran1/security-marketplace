import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CompanyGuard } from '../../company-guard/entities/company-guard.entity';

export enum GuardEngagementType {
  EMPLOYEE = 'EMPLOYEE',
  SELF_EMPLOYED_CONTRACTOR = 'SELF_EMPLOYED_CONTRACTOR',
  AGENCY_WORKER = 'AGENCY_WORKER',
  SUBCONTRACTOR = 'SUBCONTRACTOR',
  CASUAL_WORKER = 'CASUAL_WORKER',
  OTHER = 'OTHER',
}

export enum GuardJobRole {
  SECURITY_OFFICER = 'SECURITY_OFFICER',
  DOOR_SUPERVISOR = 'DOOR_SUPERVISOR',
  CCTV_OPERATOR = 'CCTV_OPERATOR',
  SITE_SUPERVISOR = 'SITE_SUPERVISOR',
  CONTROL_ROOM_OPERATOR = 'CONTROL_ROOM_OPERATOR',
  MOBILE_PATROL_OFFICER = 'MOBILE_PATROL_OFFICER',
  OTHER = 'OTHER',
}

export enum GuardWorkingArrangement {
  FULL_TIME = 'FULL_TIME',
  PART_TIME = 'PART_TIME',
  ZERO_HOURS = 'ZERO_HOURS',
  CASUAL = 'CASUAL',
  TEMPORARY = 'TEMPORARY',
  FIXED_TERM = 'FIXED_TERM',
  OTHER = 'OTHER',
}

export enum GuardPayBasis {
  HOURLY = 'HOURLY',
  DAILY = 'DAILY',
  SALARY = 'SALARY',
  OTHER = 'OTHER',
}

@Entity('company_guard_employment_records')
export class CompanyGuardEmployment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  companyGuardId!: number;

  @ManyToOne(() => CompanyGuard, { nullable: false })
  @JoinColumn({ name: 'companyGuardId' })
  companyGuard!: CompanyGuard;

  @Column({ type: 'enum', enum: GuardEngagementType, enumName: 'guard_engagement_type_enum' })
  engagementType!: GuardEngagementType;

  @Column({ type: 'enum', enum: GuardJobRole, enumName: 'guard_job_role_enum' })
  jobRole!: GuardJobRole;

  @Column({ type: 'varchar', length: 100, nullable: true })
  customRole?: string | null;

  @Column({ type: 'enum', enum: GuardWorkingArrangement, enumName: 'guard_working_arrangement_enum' })
  workingArrangement!: GuardWorkingArrangement;

  @Column({ type: 'date' })
  startDate!: string;

  @Column({ type: 'date', nullable: true })
  endDate?: string | null;

  @Column({ type: 'enum', enum: GuardPayBasis, enumName: 'guard_pay_basis_enum' })
  payBasis!: GuardPayBasis;

  @Column({ type: 'int', nullable: true })
  noticePeriodDays?: number | null;

  // Company-owned HR note. Never returned to Guard or CompanyStaff.
  @Column({ type: 'text', nullable: true, select: false })
  internalNoteEnc?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
