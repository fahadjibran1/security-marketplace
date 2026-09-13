import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { CompanyMembershipRole } from '../company-membership-types';

// Standalone invitation record. No User or CompanyMembership is created until acceptance.
// tokenDigest = SHA-256(plaintextToken) as 64-char hex. Plaintext is never stored.
// Invitation state is derived: PENDING (usedAt IS NULL AND revokedAt IS NULL AND expiresAt > NOW),
//   USED (usedAt IS NOT NULL), REVOKED (revokedAt IS NOT NULL), EXPIRED (derived from expiresAt).
@Entity('company_invitations')
export class CompanyInvitation {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'companyId' })
  companyId!: number;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company!: Company;

  @Column({ type: 'varchar', nullable: false })
  email!: string;

  @Column({
    type: 'enum',
    enum: CompanyMembershipRole,
    enumName: 'company_membership_role',
  })
  intendedMembershipRole!: CompanyMembershipRole;

  @Column({ type: 'char', length: 64, nullable: false })
  tokenDigest!: string;

  @Column({ type: 'timestamp', nullable: false })
  expiresAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  usedAt!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  revokedByUserId!: number | null;

  @Column({ type: 'int', nullable: false })
  invitedByUserId!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
