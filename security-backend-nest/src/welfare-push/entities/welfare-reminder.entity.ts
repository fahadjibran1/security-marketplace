import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Shift } from '../../shift/entities/shift.entity';

export type WelfareReminderKind = 'window_open' | 'follow_up';

/**
 * What the push provider said. Never a claim about the phone: 'provider_accepted' means Expo took the message,
 * not that it reached the device, and nothing here means the Guard saw it or is safe.
 */
export type WelfareReminderStatus = 'sending' | 'provider_accepted' | 'provider_rejected' | 'no_device' | 'failed';

/** From Expo's push receipts: the provider's report of handing the message to Apple/Google — still not the phone. */
export type WelfareReminderReceiptStatus = 'provider_delivery_ok' | 'provider_delivery_error';

/**
 * One Welfare Check reminder decided for one window of one shift (Migration 65). UNIQUE (shiftId, windowIndex, kind):
 * however often or concurrently the reminder job runs, each reminder is sent at most once. Window times are
 * `timestamp` columns holding UTC wall time, exactly like shifts.start / shifts.end.
 *
 * A reminder is never a Welfare Check. Completion is only ever a welfare_check daily log, graded by the window engine.
 */
@Entity('welfare_reminders')
@Check('CHK_welfare_reminders_kind', `"kind" IN ('window_open', 'follow_up')`)
@Check('CHK_welfare_reminders_status', `"status" IN ('sending', 'provider_accepted', 'provider_rejected', 'no_device', 'failed')`)
@Check('CHK_welfare_reminders_receipt', `"receiptStatus" IS NULL OR "receiptStatus" IN ('provider_delivery_ok', 'provider_delivery_error')`)
@Index('UQ_welfare_reminders_window_kind', ['shiftId', 'windowIndex', 'kind'], { unique: true })
@Index('IDX_welfare_reminders_company_shift', ['companyId', 'shiftId'])
export class WelfareReminder {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_welfare_reminders' })
  id!: number;

  @Column({ type: 'int' })
  shiftId!: number;

  @ManyToOne(() => Shift, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'shiftId', foreignKeyConstraintName: 'FK_welfare_reminders_shift' })
  shift?: Shift;

  @Column({ type: 'int' })
  companyId!: number;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'companyId', foreignKeyConstraintName: 'FK_welfare_reminders_company' })
  company?: Company;

  @Column({ type: 'int' })
  guardId!: number;

  @ManyToOne(() => GuardProfile, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'guardId', foreignKeyConstraintName: 'FK_welfare_reminders_guard' })
  guard?: GuardProfile;

  @Column({ type: 'int' })
  windowIndex!: number;

  @Column({ type: 'varchar', length: 16 })
  kind!: WelfareReminderKind;

  @Column({ type: 'timestamp' })
  windowStart!: Date;

  @Column({ type: 'timestamp' })
  windowEnd!: Date;

  @Column({ type: 'varchar', length: 24 })
  status!: WelfareReminderStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', default: 0 })
  deviceCount!: number;

  /** Expo ticket ids with the push_devices row each went to, used only to fetch receipts. Never a token. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  ticketIds!: Array<{ id: string; deviceId: number }>;

  @Column({ type: 'varchar', length: 32, nullable: true })
  receiptStatus!: WelfareReminderReceiptStatus | null;

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
