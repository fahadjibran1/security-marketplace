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
  GUARD = 'guard',
  CLIENT_ADMIN = 'client_admin',
  CLIENT_VIEWER = 'client_viewer',
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

export const CLIENT_PORTAL_ROLES = [UserRole.CLIENT_ADMIN, UserRole.CLIENT_VIEWER] as const;

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

  @Column({ select: false })
  passwordHash!: string;

  @Column({ type: 'enum', enum: UserRole })
  role!: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.PENDING })
  status!: UserStatus;

  @Column({ default: false })
  isEmailVerified!: boolean;

  /**
   * Whether this account must prove control of its email address before it may sign in.
   *
   * New rows default to true. Migration 61 wrote false onto every account that existed when it ran,
   * so a grandfathered account keeps working exactly as before and nobody's isEmailVerified value is
   * touched. A trusted path that has already established the address (the operator CLI) sets
   * isEmailVerified rather than clearing this flag.
   */
  @Column({ type: 'boolean', default: true })
  emailVerificationRequired!: boolean;

  /** When the account holder asked for the account to be deleted. Null when never requested. */
  @Column({ type: 'timestamptz', nullable: true })
  deletionRequestedAt?: Date | null;

  /**
   * When the account was anonymised in place. Set once and never cleared: an account carrying it can
   * never sign in, refresh, or be re-activated. The row itself is kept so operational evidence that
   * references it stays intact.
   */
  @Column({ type: 'timestamptz', nullable: true })
  deletionCompletedAt?: Date | null;

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
