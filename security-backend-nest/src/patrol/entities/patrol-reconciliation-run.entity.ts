import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * One catch-up of the patrol sweep after a gap longer than its normal lookback (Migration 71, issue #67). Written only by
 * PatrolSweepService under the company's sweep lock.
 *
 *   fromAt        the watermark (start deadlines) the catch-up starts from — never older than the horizon
 *   throughAt     how far it has judged so far: advanced in the same transaction as each batch
 *   targetAt      where the live sweep's lookback takes over (now − lookback, as of the last batch)
 *   unjudgedFrom  … unjudgedTo: start deadlines older than the 14-day horizon, recorded as NOT judged (audited and alerted
 *                 once), never silently dropped
 *
 * running → completed. At most one running per company (UQ_patrol_reconciliation_runs_running).
 */
@Entity('patrol_reconciliation_runs')
@Unique('UQ_patrol_reconciliation_runs_id_company', ['id', 'companyId'])
@Index('UQ_patrol_reconciliation_runs_running', ['companyId'], { unique: true, where: `"status" = 'running'` })
@Index('IDX_patrol_reconciliation_runs_company', ['companyId', 'startedAt'])
export class PatrolReconciliationRun {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_reconciliation_runs' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'varchar', length: 16, default: 'running' })
  status!: string;

  @Column({ type: 'timestamptz' })
  fromAt!: Date;

  @Column({ type: 'timestamptz' })
  throughAt!: Date;

  @Column({ type: 'timestamptz' })
  targetAt!: Date;

  @Column({ type: 'int' })
  horizonDays!: number;

  @Column({ type: 'timestamptz', nullable: true })
  unjudgedFrom!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  unjudgedTo!: Date | null;

  @Column({ type: 'int', default: 0 })
  batches!: number;

  @Column({ type: 'int', default: 0 })
  windowsJudged!: number;

  @Column({ type: 'int', default: 0 })
  exceptionsRaised!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
