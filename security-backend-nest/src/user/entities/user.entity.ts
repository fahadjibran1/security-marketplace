import {
  Column,
  CreateDateColumn,
  Entity,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum UserRole {
  ADMIN = 'admin',
  COMPANY_ADMIN = 'company_admin',
  COMPANY_STAFF = 'company_staff',
  COMPANY = 'company',
  GUARD = 'guard'
}

export enum UserStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

export const COMPANY_ADMIN_ROLES = [UserRole.COMPANY, UserRole.COMPANY_ADMIN] as const;
export const COMPANY_VIEW_ROLES = [
  UserRole.COMPANY,
  UserRole.COMPANY_ADMIN,
  UserRole.COMPANY_STAFF,
] as const;

export function isCompanyRole(role?: UserRole | null): boolean {
  return !!role && (COMPANY_VIEW_ROLES as readonly UserRole[]).includes(role);
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', nullable: true })
  firstName?: string | null;

  @Column({ type: 'varchar', nullable: true })
  lastName?: string | null;

  @Column({ unique: true })
  email!: string;

  @Column({ type: 'varchar', nullable: true })
  phone?: string | null;

  @Column()
  passwordHash!: string;

  @Column({ type: 'enum', enum: UserRole })
  role!: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.PENDING })
  status!: UserStatus;

  @Column({ default: false })
  isEmailVerified!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt?: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToOne(() => Company, (company) => company.user)
  companyProfile?: Company;

  @OneToOne(() => GuardProfile, (guardProfile) => guardProfile.user)
  guardProfile?: GuardProfile;
}
