import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import type { PatrolRunStatus, PatrolSyncFlag, PatrolVerificationStatus } from '../patrol-constants';

/**
 * One patrol by one Guard on one shift (Migration 68). Device and server times are both kept (clockOffsetMs = server −
 * device at start). Completion (status) and verification (verificationStatus) are separate. clientRunId makes the
 * Guard app's start idempotent; windowKey / windowStart / windowEnd / scopeKey are assigned by the P1-B engine.
 *
 * Migration 69 (P1-B) adds lateStart, provisional, needsReview, syncFlags, clockDriftMs and verificationFinalAt: how the run
 * reached the server (offline, after Book Off, with a drifting clock) and whether a person should review it.
 */
@Entity('patrol_runs')
@Unique('UQ_patrol_runs_id_company', ['id', 'companyId'])
@Index('UQ_patrol_runs_client_run_id', ['companyId', 'clientRunId'], { unique: true })
@Index('UQ_patrol_runs_schedule_window_scope', ['scheduleId', 'windowKey', 'scopeKey'], {
  unique: true,
  where: '"scheduleId" IS NOT NULL AND "windowKey" IS NOT NULL',
})
@Index('UQ_patrol_runs_one_open_per_guard_shift', ['shiftId', 'guardId'], { unique: true, where: `"status" = 'in_progress'` })
@Index('IDX_patrol_runs_company_site_started', ['companyId', 'siteId', 'startedAtServer'])
@Index('IDX_patrol_runs_shift', ['shiftId'])
@Index('IDX_patrol_runs_open', ['companyId'], { where: `"status" = 'in_progress'` })
export class PatrolRun {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_runs' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int' })
  siteId!: number;

  @Column({ type: 'int' })
  shiftId!: number;

  @Column({ type: 'int' })
  guardId!: number;

  @Column({ type: 'int' })
  startedByUserId!: number;

  @Column({ type: 'int', nullable: true })
  scheduleId!: number | null;

  @Column({ type: 'int', nullable: true })
  routeId!: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  windowKey!: string | null;

  @Column({ type: 'varchar', length: 32, default: 'site' })
  scopeKey!: string;

  @Column({ type: 'timestamptz', nullable: true })
  windowStart!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  windowEnd!: Date | null;

  @Column({ type: 'varchar', length: 24, default: 'in_progress' })
  status!: PatrolRunStatus;

  @Column({ type: 'varchar', length: 24, default: 'pending' })
  verificationStatus!: PatrolVerificationStatus;

  @Column({ type: 'timestamptz' })
  startedAtDevice!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  startedAtServer!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAtDevice!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAtServer!: Date | null;

  @Column({ type: 'int', nullable: true })
  clockOffsetMs!: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  exceptionReason!: string | null;

  @Column({ type: 'varchar', length: 64 })
  clientRunId!: string;

  @Column({ type: 'boolean', default: false })
  syncedLate!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  /** Migration 69: started after its window ended but within the start grace. */
  @Column({ type: 'boolean', default: false })
  lateStart!: boolean;

  /** Migration 69: first reached the server after the shift ended; its device times are provisional. */
  @Column({ type: 'boolean', default: false })
  provisional!: boolean;

  /** Migration 69: accepted, but legitimacy is only partly supported (see syncFlags). */
  @Column({ type: 'boolean', default: false })
  needsReview!: boolean;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  syncFlags!: PatrolSyncFlag[];

  /** Migration 69: server receipt − the device's sentAtDevice at start, when the app sent it. */
  @Column({ type: 'int', nullable: true })
  clockDriftMs!: number | null;

  /** Migration 69: when the verification result settled (sync deadline + 24 h); later evidence no longer changes it. */
  @Column({ type: 'timestamptz', nullable: true })
  verificationFinalAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
