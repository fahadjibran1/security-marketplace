import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * A patrol exception (Migration 68): missed, late, incomplete, checkpoint missed, evidence unverified. At most one open
 * row per (company, windowKey, scopeKey, type), so concurrent sweeps raise one. Written by the P1-B engine.
 */
@Entity('patrol_exceptions')
@Index('UQ_patrol_exceptions_open_window_type', ['companyId', 'windowKey', 'scopeKey', 'type'], {
  unique: true,
  where: `"status" <> 'resolved'`,
})
@Index('IDX_patrol_exceptions_company_status', ['companyId', 'status'])
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
