import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Shift } from '../../shift/entities/shift.entity';
import type {
  AmendmentResponseMethod,
  AmendmentStatus,
  ConfirmationEmailStatus,
  FatigueAssessment,
  VerbalContactMethod,
} from '../shift-amendment-policy';

/**
 * One proposed extension of an in-progress shift (Migration 64). Never deleted: every proposal, response, withdrawal,
 * expiry, void, dispute and resolution stays as evidence. Times are `timestamp` columns holding UTC wall time, exactly
 * like shifts.start / shifts.end. User ids are plain integers (accounts are anonymised in place, never deleted).
 *
 * Database rules (created by the migration, not by this entity): one open proposal per shift
 * (UQ_shift_amendments_one_open), a unique sequence per shift, and CHECK constraints on status, the extension,
 * the agreed terms, the response method, and the fields each state requires.
 */
@Entity('shift_amendments')
@Check('CHK_shift_amendments_status', `"status" IN ('awaiting_approval', 'pending', 'accepted', 'declined', 'withdrawn', 'expired', 'voided', 'disputed', 'dispute_upheld', 'dispute_corrected')`)
@Check('CHK_shift_amendments_extends', `"proposedEnd" > "previousEnd"`)
@Check('CHK_shift_amendments_agreed_terms', `"agreedEnd" IS NULL OR "agreedEnd" = "proposedEnd"`)
@Check('CHK_shift_amendments_response_method', `"responseMethod" IS NULL OR "responseMethod" IN ('guard_app', 'staff_recorded_verbal')`)
@Check('CHK_shift_amendments_agreed_fields', `"status" NOT IN ('accepted', 'disputed', 'dispute_upheld', 'dispute_corrected') OR ("agreedEnd" IS NOT NULL AND "respondedAt" IS NOT NULL AND "responseMethod" IS NOT NULL)`)
@Check('CHK_shift_amendments_verbal_fields', `"responseMethod" IS DISTINCT FROM 'staff_recorded_verbal' OR ("verbalContactMethod" IS NOT NULL AND "verbalContactAt" IS NOT NULL AND "verbalConfirmation" IS NOT NULL)`)
@Check('CHK_shift_amendments_dispute_verbal_only', `"status" NOT IN ('disputed', 'dispute_upheld', 'dispute_corrected') OR "responseMethod" = 'staff_recorded_verbal'`)
@Check('CHK_shift_amendments_email_status', `"confirmationEmailStatus" IS NULL OR "confirmationEmailStatus" IN ('provider_accepted', 'captured_outbox', 'not_configured', 'failed', 'no_address')`)
@Index('UQ_shift_amendments_one_open', ['shiftId'], {
  unique: true,
  where: `"status" IN ('awaiting_approval', 'pending')`,
})
@Index('UQ_shift_amendments_shift_sequence', ['shiftId', 'sequence'], { unique: true })
@Index('IDX_shift_amendments_company_status', ['companyId', 'status'])
@Index('IDX_shift_amendments_guard_status', ['guardId', 'status'])
export class ShiftAmendment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int' })
  shiftId!: number;

  @ManyToOne(() => Shift, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'shiftId', foreignKeyConstraintName: 'FK_shift_amendments_shift' })
  shift?: Shift;

  @Column({ type: 'int' })
  companyId!: number;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'companyId', foreignKeyConstraintName: 'FK_shift_amendments_company' })
  company?: Company;

  @Column({ type: 'int' })
  guardId!: number;

  @ManyToOne(() => GuardProfile, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'guardId', foreignKeyConstraintName: 'FK_shift_amendments_guard' })
  guard?: GuardProfile;

  /** 1, 2, 3 … per shift, in proposal order. */
  @Column({ type: 'int' })
  sequence!: number;

  @Column({ type: 'varchar', length: 32 })
  status!: AmendmentStatus;

  /** The shift's originally scheduled end (before any extension). */
  @Column({ type: 'timestamp' })
  originalEnd!: Date;

  /** The effective end this proposal extends from; acceptance requires the shift to still end here. */
  @Column({ type: 'timestamp' })
  previousEnd!: Date;

  @Column({ type: 'timestamp' })
  proposedEnd!: Date;

  /** Set on acceptance; always equal to proposedEnd (CHECK). */
  @Column({ type: 'timestamp', nullable: true })
  agreedEnd!: Date | null;

  @Column({ type: 'varchar', length: 500 })
  reason!: string;

  @Column({ type: 'int' })
  proposedByUserId!: number;

  @Column({ type: 'timestamp' })
  proposedAt!: Date;

  /** The effective end at proposal time: no acceptance at or after it. */
  @Column({ type: 'timestamp' })
  expiresAt!: Date;

  @Column({ type: 'jsonb' })
  fatigueAssessment!: FatigueAssessment;

  @Column({ type: 'boolean', default: false })
  approvalRequired!: boolean;

  @Column({ type: 'int', nullable: true })
  approvedByUserId!: number | null;

  @Column({ type: 'timestamp', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  approvalStatement!: string | null;

  @Column({ type: 'boolean', default: false })
  selfApproved!: boolean;

  @Column({ type: 'varchar', length: 32, nullable: true })
  responseMethod!: AmendmentResponseMethod | null;

  @Column({ type: 'int', nullable: true })
  respondedByUserId!: number | null;

  @Column({ type: 'timestamp', nullable: true })
  respondedAt!: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  responseReason!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  verbalContactMethod!: VerbalContactMethod | null;

  @Column({ type: 'timestamp', nullable: true })
  verbalContactAt!: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  verbalConfirmation!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  confirmationEmailStatus!: ConfirmationEmailStatus | null;

  @Column({ type: 'timestamp', nullable: true })
  confirmationEmailAttemptedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  confirmationEmailAttempts!: number;

  @Column({ type: 'int', nullable: true })
  withdrawnByUserId!: number | null;

  @Column({ type: 'timestamp', nullable: true })
  withdrawnAt!: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  voidedReason!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  voidedAt!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  expiredAt!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  disputedAt!: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  disputeReason!: string | null;

  @Column({ type: 'int', nullable: true })
  disputeResolvedByUserId!: number | null;

  @Column({ type: 'timestamp', nullable: true })
  disputeResolvedAt!: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  disputeResolution!: 'upheld' | 'corrected' | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  disputeResolutionNote!: string | null;

  /** 'synced_draft' | 'flagged_locked' | 'no_timesheet', set on acceptance. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  timesheetSync!: string | null;

  @Column({ type: 'boolean', default: false })
  payrollReviewRequired!: boolean;

  /** Every extension is flagged for billing review (owner rule D1/D3). */
  @Column({ type: 'boolean', default: true })
  billingReviewRequired!: boolean;

  @Column({ type: 'boolean', default: false })
  complianceReviewRequired!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
