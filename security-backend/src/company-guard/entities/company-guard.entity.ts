import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum CompanyGuardStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  BLOCKED = 'BLOCKED',
}

export enum CompanyGuardRelationshipType {
  EMPLOYEE = 'EMPLOYEE',
  PREFERRED = 'PREFERRED',
  APPROVED_CONTRACTOR = 'APPROVED_CONTRACTOR',
}

@Entity('company_guards')
@Unique(['company', 'guard'])
export class CompanyGuard {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, (company) => company.companyGuards, { eager: true })
  company!: Company;

  @ManyToOne(() => GuardProfile, (guard) => guard.companyGuards, { eager: true })
  guard!: GuardProfile;

  @Column({ type: 'enum', enum: CompanyGuardStatus, default: CompanyGuardStatus.ACTIVE })
  status!: CompanyGuardStatus;

  @Column({
    type: 'enum',
    enum: CompanyGuardRelationshipType,
    default: CompanyGuardRelationshipType.APPROVED_CONTRACTOR,
  })
  relationshipType!: CompanyGuardRelationshipType;

  @CreateDateColumn()
  createdAt!: Date;
}
