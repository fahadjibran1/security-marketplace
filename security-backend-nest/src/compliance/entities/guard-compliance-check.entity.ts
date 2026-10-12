import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { User } from '../../user/entities/user.entity';
import { GuardDocument } from './guard-document.entity';

/**
 * A company's own SIA or Right to Work check on one Guard (Migration 62).
 *
 * Company-scoped: a check recorded by one company never satisfies another, and recording one never
 * touches the Guard's own declarations on guard_profiles (siaLicenseNumber, siaExpiryDate,
 * rightToWorkStatus, rightToWorkExpiryDate), which are shared by every company the Guard works for.
 *
 * Append-only. A follow-up check or a correction inserts a new row and stamps the previous one with
 * supersededAt / supersededByCheckId, so the full history of what the company recorded, when and by
 * whom is kept. Rows are never updated otherwise and never deleted by the application. At most one
 * current (unsuperseded) row exists per company, Guard and kind, enforced by a partial unique index.
 *
 * Dates are calendar dates in the company's zone (see compliance-dates.ts), stored as DATE.
 */
@Entity('guard_compliance_checks')
@Index('UQ_guard_compliance_checks_current', ['companyId', 'guardId', 'kind'], {
  unique: true,
  where: '"supersededAt" IS NULL',
})
@Index('IDX_guard_compliance_checks_company_guard', ['companyId', 'guardId', 'createdAt'])
export class GuardComplianceCheck {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId', foreignKeyConstraintName: 'FK_guard_compliance_checks_company' })
  company?: Company;

  @Column({ type: 'int' })
  guardId!: number;

  @ManyToOne(() => GuardProfile, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'guardId', foreignKeyConstraintName: 'FK_guard_compliance_checks_guard' })
  guard?: GuardProfile;

  /** 'sia' | 'right_to_work' — validated in compliance-check-vocabulary.ts. */
  @Column({ type: 'varchar', length: 32 })
  kind!: string;

  /** 'confirmed' | 'not_confirmed'. */
  @Column({ type: 'varchar', length: 32 })
  outcome!: string;

  /** How the check was carried out (SIA_CHECK_METHODS / RIGHT_TO_WORK_CHECK_METHODS). */
  @Column({ type: 'varchar', length: 40 })
  method!: string;

  /** Right to Work only: 'continuous' | 'time_limited' | 'time_limited_pvn'. Null for SIA. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  rightToWorkExcuse!: string | null;

  /** SIA only: the 16-digit licence number the company checked. Null for Right to Work. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  licenceNumber!: string | null;

  /** The date the check was made (for the ECS, the date of the Positive Verification Notice). */
  @Column({ type: 'date' })
  checkDate!: string;

  /**
   * SIA: licence expiry. Right to Work: when the statutory excuse ends — the permission expiry for a
   * time-limited excuse, six months from the PVN for the ECS, and null for a continuous excuse.
   */
  @Column({ type: 'date', nullable: true })
  expiryDate!: string | null;

  /** Any condition on the work the Guard may do, as shown by the check (e.g. limited hours). */
  @Column({ type: 'varchar', length: 500, nullable: true })
  workRestrictions!: string | null;

  /** Who carried out the check. Responsibility may be delegated, so it need not be the S4 user. */
  @Column({ type: 'varchar', length: 120 })
  checkedByName!: string;

  /** Where the company keeps its copy of the evidence (file reference, system record, etc.). */
  @Column({ type: 'varchar', length: 200, nullable: true })
  evidenceReference!: string | null;

  /** Optional link to evidence held in S4. Linking does not verify the document. */
  @Column({ type: 'int', nullable: true })
  evidenceDocumentId!: number | null;

  @ManyToOne(() => GuardDocument, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'evidenceDocumentId', foreignKeyConstraintName: 'FK_guard_compliance_checks_evidence_document' })
  evidenceDocument?: GuardDocument | null;

  /** The S4 user who recorded this row. */
  @Column({ type: 'int', nullable: true })
  recordedByUserId!: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'recordedByUserId', foreignKeyConstraintName: 'FK_guard_compliance_checks_recorded_by' })
  recordedBy?: User | null;

  /** 'new_check' | 'correction'. The first check for a kind is a 'new_check'. */
  @Column({ type: 'varchar', length: 32, default: 'new_check' })
  changeType!: string;

  /** Required for a correction: why the previous record was wrong. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  changeReason!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  supersededAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  supersededByCheckId!: number | null;

  @ManyToOne(() => GuardComplianceCheck, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'supersededByCheckId', foreignKeyConstraintName: 'FK_guard_compliance_checks_superseded_by' })
  supersededBy?: GuardComplianceCheck | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
