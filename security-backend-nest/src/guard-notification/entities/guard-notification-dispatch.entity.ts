import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Notification } from '../../notification/entities/notification.entity';
import { ShiftAmendment } from '../../shift-amendment/entities/shift-amendment.entity';
import { Shift } from '../../shift/entities/shift.entity';
import { User } from '../../user/entities/user.entity';

/** The notification types a Guard can be pushed. Exactly the CHECK below. */
export const GUARD_PUSH_TYPES = [
  'shift_offered',
  'shift_offer_withdrawn',
  'shift_reacceptance_required',
  'shift_replaced',
  'shift_amendment_requested',
  'shift_amendment_responded',
  'shift_amendment_expired',
] as const;
export type GuardPushType = (typeof GUARD_PUSH_TYPES)[number];

/**
 * What happened to the push. Never a claim about the phone: 'provider_accepted' means Expo took the message, not that
 * it reached the device or was read. The in-app notice is written whatever this says.
 *
 *   pending             recorded with the business change; the push goes out once that change has committed
 *   sending             claimed by one sender (a stale 'sending' is retried)
 *   provider_accepted   Expo accepted it for at least one active device
 *   provider_rejected   Expo refused it for every device (e.g. DeviceNotRegistered, which revokes the device)
 *   no_device           the Guard has no active push device
 *   failed              Expo could not be reached; retried while the shift has not ended (at most three attempts)
 *   skipped_disabled    PUSH_GUARD_NOTIFICATIONS_ENABLED was not "true" when it would have been sent
 *   skipped_ended       the shift had already ended
 *   skipped_ineligible  the recipient was no longer a Guard of the shift's company
 */
export type GuardDispatchStatus =
  | 'pending'
  | 'sending'
  | 'provider_accepted'
  | 'provider_rejected'
  | 'no_device'
  | 'failed'
  | 'skipped_disabled'
  | 'skipped_ended'
  | 'skipped_ineligible';

export type GuardDispatchReceiptStatus = 'provider_delivery_ok' | 'provider_delivery_error';

/**
 * One Guard notification event (Migration 66): the in-app notice it wrote and the OS push it sent, at most once.
 * UNIQUE ("userId", "eventKey") is the idempotency key: a repeated or concurrent call for the same event inserts
 * nothing, writes no second notice and sends nothing. Shift times are a snapshot (`timestamp`, UTC wall time like
 * shifts.start / shifts.end) used only if the shift itself has since been deleted.
 */
@Entity('guard_notification_dispatches')
@Check(
  'CHK_guard_notification_dispatches_type',
  `"type" IN ('shift_offered', 'shift_offer_withdrawn', 'shift_reacceptance_required', 'shift_replaced', 'shift_amendment_requested', 'shift_amendment_responded', 'shift_amendment_expired')`,
)
@Check(
  'CHK_guard_notification_dispatches_status',
  `"status" IN ('pending', 'sending', 'provider_accepted', 'provider_rejected', 'no_device', 'failed', 'skipped_disabled', 'skipped_ended', 'skipped_ineligible')`,
)
@Check(
  'CHK_guard_notification_dispatches_receipt',
  `"receiptStatus" IS NULL OR "receiptStatus" IN ('provider_delivery_ok', 'provider_delivery_error')`,
)
@Index('UQ_guard_notification_dispatches_user_event', ['userId', 'eventKey'], { unique: true })
@Index('IDX_guard_notification_dispatches_status', ['status', 'createdAt'])
@Index('IDX_guard_notification_dispatches_shift', ['shiftId'])
export class GuardNotificationDispatch {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_guard_notification_dispatches' })
  id!: number;

  @Column({ type: 'int' })
  userId!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_guard_notification_dispatches_user' })
  user?: User;

  @Column({ type: 'int' })
  guardId!: number;

  @ManyToOne(() => GuardProfile, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'guardId', foreignKeyConstraintName: 'FK_guard_notification_dispatches_guard' })
  guard?: GuardProfile;

  @Column({ type: 'int' })
  companyId!: number;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId', foreignKeyConstraintName: 'FK_guard_notification_dispatches_company' })
  company?: Company;

  @Column({ type: 'int', nullable: true })
  notificationId!: number | null;

  @ManyToOne(() => Notification, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'notificationId', foreignKeyConstraintName: 'FK_guard_notification_dispatches_notification' })
  notification?: Notification | null;

  @Column({ type: 'int', nullable: true })
  shiftId!: number | null;

  @ManyToOne(() => Shift, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'shiftId', foreignKeyConstraintName: 'FK_guard_notification_dispatches_shift' })
  shift?: Shift | null;

  @Column({ type: 'int', nullable: true })
  amendmentId!: number | null;

  @ManyToOne(() => ShiftAmendment, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'amendmentId', foreignKeyConstraintName: 'FK_guard_notification_dispatches_amendment' })
  amendment?: ShiftAmendment | null;

  @Column({ type: 'varchar', length: 48 })
  type!: GuardPushType;

  @Column({ type: 'varchar', length: 160 })
  eventKey!: string;

  @Column({ type: 'timestamp', nullable: true })
  shiftStartAt!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  shiftEndAt!: Date | null;

  @Column({ type: 'varchar', length: 24, default: 'pending' })
  status!: GuardDispatchStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', default: 0 })
  deviceCount!: number;

  /** Expo ticket ids with the push_devices row each went to, used only to fetch receipts. Never a token. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  ticketIds!: Array<{ id: string; deviceId: number }>;

  @Column({ type: 'varchar', length: 32, nullable: true })
  receiptStatus!: GuardDispatchReceiptStatus | null;

  /** The provider's error code (e.g. DeviceNotRegistered), never a message body or token. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  error!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  receiptCheckedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
