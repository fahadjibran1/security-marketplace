import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import type { PatrolRunStatus, PatrolVerificationStatus } from '../patrol-constants';

/**
 * One patrol by one Guard on one shift (Migration 68). Device and server times are both kept (clockOffsetMs = server −
 * device at start). Completion (status) and verification (verificationStatus) are separate. clientRunId makes the
 * Guard app's start idempotent; windowKey / windowStart / windowEnd / scopeKey are assigned by the P1-B engine.
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
