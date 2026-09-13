import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { Company } from '../../company/entities/company.entity';
import { CompanyMembershipRole, CompanyMembershipStatus } from '../company-membership-types';

// One row per user/company pair. Unique constraint: uq_cm_user_company (userId, companyId).
// Partial unique index: uq_one_active_membership_per_user (userId WHERE status = 'active').
// Both constraints are created by migration 1720800000005 — not by TypeORM synchronize.
@Entity('company_memberships')
export class CompanyMembership {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'userId' })
  userId!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ name: 'companyId' })
  companyId!: number;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'companyId' })
  company!: Company;

  @Column({
    type: 'enum',
    enum: CompanyMembershipRole,
    enumName: 'company_membership_role',
  })
  membershipRole!: CompanyMembershipRole;

  @Column({
    type: 'enum',
    enum: CompanyMembershipStatus,
    enumName: 'company_membership_status',
    default: CompanyMembershipStatus.ACTIVE,
  })
  status!: CompanyMembershipStatus;

  @Column({ type: 'int', nullable: true })
  invitedByUserId!: number | null;

  @Column({ type: 'timestamp', nullable: false, default: () => 'NOW()' })
  acceptedAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  disabledAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  disabledByUserId!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
