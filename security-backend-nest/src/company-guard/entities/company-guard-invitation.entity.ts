import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { CompanyGuardRelationshipType } from './company-guard.entity';

/**
 * A company's offer to bring a Guard into its workforce, claimed with a one-time code.
 *
 * Standalone: no CompanyGuard relationship exists until the Guard accepts, because acceptance is the
 * Guard's consent and a company must not be able to attach someone silently.
 *
 * tokenDigest = SHA-256(plaintextToken) as 64-char hex. The plaintext is shown to the issuing company
 * once, at creation, and is never stored, logged or recoverable.
 *
 * State is derived rather than stored, the same way CompanyInvitation does it:
 *   PENDING  — usedAt, declinedAt and revokedAt all NULL, and expiresAt is in the future
 *   EXPIRED  — as PENDING but expiresAt has passed
 *   ACCEPTED — usedAt set
 *   DECLINED — declinedAt set
 *   REVOKED  — revokedAt set
 * Each transition is guarded, so exactly one terminal timestamp can ever be set.
 */
@Entity('company_guard_invitations')
export class CompanyGuardInvitation {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'companyId' })
  companyId!: number;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company!: Company;

  /** Copied onto the CompanyGuard relationship at acceptance. */
  @Column({
    type: 'enum',
    enum: CompanyGuardRelationshipType,
    enumName: 'company_guards_relationshiptype_enum',
    default: CompanyGuardRelationshipType.APPROVED_CONTRACTOR,
  })
  relationshipType!: CompanyGuardRelationshipType;

  /**
   * Optional binding to one specific licence. When set, only the Guard holding that SIA licence can
   * claim the code, so a leaked code is useless to anyone else. Never looked up at creation — it is
   * recorded as given and compared against the accepting Guard's own record, so it cannot be used to
   * probe whether a licence exists on the platform.
   */
  @Column({ type: 'char', length: 16, nullable: true })
  targetSiaLicenceNumber!: string | null;

  @Column({ type: 'char', length: 64, nullable: false })
  tokenDigest!: string;

  @Column({ type: 'timestamp', nullable: false })
  expiresAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  usedAt!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  declinedAt!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  revokedByUserId!: number | null;

  @Column({ type: 'int', nullable: false })
  invitedByUserId!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
