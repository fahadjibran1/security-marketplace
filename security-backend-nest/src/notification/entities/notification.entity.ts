import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { Company } from '../../company/entities/company.entity';

export enum NotificationType {
  JOB_ASSIGNED = 'job_assigned',
  SHIFT_REMINDER = 'shift_reminder',
  CHECK_CALL_MISSED = 'check_call_missed',
  INCIDENT_REPORTED = 'incident_reported',
  TIMESHEET_SUBMITTED = 'timesheet_submitted',
  TIMESHEET_APPROVED = 'timesheet_approved',
  TIMESHEET_REJECTED = 'timesheet_rejected',
  FINANCIAL_REMINDER = 'financial_reminder',
  PAYROLL_SUGGESTION = 'payroll_suggestion',
  INVOICE_SUGGESTION = 'invoice_suggestion',
  COMPLIANCE_ALERT = 'compliance_alert',
  ALERT_RAISED = 'alert_raised',
  // Live Shift Amendments (Migration 64)
  SHIFT_AMENDMENT_REQUESTED = 'shift_amendment_requested',
  SHIFT_AMENDMENT_RESPONDED = 'shift_amendment_responded',
  SHIFT_AMENDMENT_DISPUTED = 'shift_amendment_disputed',
  SHIFT_AMENDMENT_EXPIRED = 'shift_amendment_expired',
  // Guard shift notifications (Migration 66)
  SHIFT_OFFERED = 'shift_offered',
  SHIFT_OFFER_WITHDRAWN = 'shift_offer_withdrawn',
  SHIFT_REACCEPTANCE_REQUIRED = 'shift_reacceptance_required',
  /** Reserved for the Replace Guard workflow. Nothing emits it yet. */
  SHIFT_REPLACED = 'shift_replaced',
}

export enum NotificationStatus {
  UNREAD = 'unread',
  READ = 'read',
}

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, { eager: true, nullable: false, onDelete: 'CASCADE' })
  @JoinColumn()
  user!: User;

  @ManyToOne(() => Company, { nullable: true, eager: true, onDelete: 'SET NULL' })
  @JoinColumn()
  company?: Company | null;

  @Column({
    type: 'enum',
    enum: NotificationType,
  })
  type!: NotificationType;

  @Column('varchar')
  title!: string;

  @Column('text')
  message!: string;

  @Column({
    type: 'enum',
    enum: NotificationStatus,
    default: NotificationStatus.UNREAD,
  })
  status!: NotificationStatus;

  @Column('timestamp', { nullable: true })
  sentAt?: Date | null;

  @Column('timestamp', { nullable: true })
  readAt?: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
