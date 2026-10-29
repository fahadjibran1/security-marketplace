import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * A patrol exception (Migration 68): missed, late, incomplete, checkpoint missed, evidence unverified. At most one open
 * row per (company, windowKey, scopeKey, type), so concurrent sweeps raise one. Written by the P1-B engine.
 *
 * Migration 69 adds the window, the Guard it concerns, the acknowledgement, and an append-only annotation list: late
 * evidence is recorded as an annotation ("evidence received after alert"), never by rewriting the exception.
 */
@Entity('patrol_exceptions')
@Index('UQ_patrol_exceptions_open_window_type', ['companyId', 'windowKey', 'scopeKey', 'type'], {
  unique: true,
  where: `"status" <> 'resolved'`,
})
@Index('IDX_patrol_exceptions_company_status', ['companyId', 'status'])
@Index('IDX_patrol_exceptions_window_type', ['companyId', 'windowKey', 'scopeKey', 'type'])
export class PatrolException {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_exceptions' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int' })
  siteId!: number;

  @Column({ type: 'int', nullable: true })
  runId!: number | null;

  @Column({ type: 'int', nullable: true })
  scheduleId!: number | null;

  @Column({ type: 'int', nullable: true })
  shiftId!: number | null;

  @Column({ type: 'varchar', length: 64 })
  windowKey!: string;

  @Column({ type: 'varchar', length: 32, default: 'site' })
  scopeKey!: string;

  @Column({ type: 'varchar', length: 32 })
  type!: string;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: string;

  @Column({ type: 'int', nullable: true })
  safetyAlertId!: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  resolution!: string | null;

  @Column({ type: 'int', nullable: true })
  resolvedByUserId!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  /** Migration 69: the Guard the exception is about (the run's performer, or the on-duty Guard for a missed window). */
  @Column({ type: 'int', nullable: true })
  guardId!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  windowStart!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  windowEnd!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  acknowledgedAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  acknowledgedByUserId!: number | null;

  /** Migration 69: when evidence for this window / run first arrived after the exception was raised. */
  @Column({ type: 'timestamptz', nullable: true })
  lateEvidenceAt!: Date | null;

  /** Migration 69: append-only notes ({ at, kind, text, runId? }); never rewritten. */
  @Column({ type: 'jsonb', default: () => `'[]'` })
  annotations!: Array<Record<string, unknown>>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
