import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Shift } from '../../shift/entities/shift.entity';

export enum SafetyAlertType {
  CHECK_CALL = 'check_call',
  PANIC = 'panic',
  /**
   * A Guard-raised request about the site. Historical rows carry this type and remain valid; it is
   * presented as SITE REQUEST. New records will use SITE_REQUEST once the Guard app is renamed.
   */
  WELFARE = 'welfare',
  SITE_REQUEST = 'site_request',
  LATE_CHECKIN = 'late_checkin',
  /**
   * A missed Welfare Check. Two distinct roles, told apart by `welfareWindowIndex`:
   *   NOT NULL — durable per-window evidence, one row per missed window
   *   NULL     — the actionable shift-level summary, and every legacy rolling alert
   */
  MISSED_CHECKCALL = 'missed_checkcall',
  MISSING_BOOK_OFF = 'missing_book_off',
  OTHER = 'other',
}

export enum SafetyAlertPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum SafetyAlertStatus {
  OPEN = 'open',
  ACKNOWLEDGED = 'acknowledged',
  CLOSED = 'closed',
}

/**
 * Both indexes are declared here as well as in migration 59 so the entity metadata tells the truth
 * about the constraints the welfare sweep relies on. They are what make its ON CONFLICT DO NOTHING
 * inserts idempotent, so anything that builds this schema from entity metadata needs them too.
 */
@Index('uq_safety_alerts_shift_welfare_window', ['shift', 'welfareWindowIndex'], {
  unique: true,
  where: '"welfareWindowIndex" IS NOT NULL',
})
@Index('uq_safety_alerts_shift_missing_book_off', ['shift'], {
  unique: true,
  where: `"type" = 'missing_book_off'`,
})
@Entity('safety_alerts')
export class SafetyAlert {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, { eager: true, onDelete: 'CASCADE' })
  company!: Company;

  @ManyToOne(() => GuardProfile, { eager: true, onDelete: 'CASCADE' })
  guard!: GuardProfile;

  @ManyToOne(() => Shift, { eager: true, nullable: true, onDelete: 'SET NULL' })
  shift?: Shift | null;

  @Column({
    type: 'enum',
    enum: SafetyAlertType,
    default: SafetyAlertType.OTHER,
  })
  type!: SafetyAlertType;

  @Column({
    type: 'enum',
    enum: SafetyAlertPriority,
    default: SafetyAlertPriority.MEDIUM,
  })
  priority!: SafetyAlertPriority;

  @Column({ type: 'text' })
  message!: string;

  /**
   * Which Welfare Check window this row is evidence for, counted from the scheduled shift start.
   *
   * NULL on everything else, including the shift-level summary alert and every alert written by the
   * old rolling sweep. A partial unique index on (shiftId, welfareWindowIndex) WHERE NOT NULL is what
   * makes the sweep idempotent and safe against concurrent runs.
   */
  @Column({ type: 'int', nullable: true })
  welfareWindowIndex?: number | null;

  @Column({
    type: 'enum',
    enum: SafetyAlertStatus,
    default: SafetyAlertStatus.OPEN,
  })
  status!: SafetyAlertStatus;

  @Column({ type: 'timestamp', nullable: true })
  acknowledgedAt?: Date | null;

  @Column({ type: 'int', nullable: true })
  acknowledgedByUserId?: number | null;

  @Column({ type: 'timestamp', nullable: true })
  closedAt?: Date | null;

  @Column({ type: 'int', nullable: true })
  closedByUserId?: number | null;

  /**
   * Why Control closed this, as a stable machine value from the set for THIS alert type — never the
   * words that were on the button. NULL on a row closed before resolution evidence was captured, and
   * on one the system closed itself (a late Book Off answering its own Missing Book Off alert).
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  resolutionReason?: string | null;

  /** What Control wrote. Separate from `message`, which is the alert as it was raised. */
  @Column({ type: 'text', nullable: true })
  resolutionNote?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
