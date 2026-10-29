import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * A bounded ZIP export of patrol photo evidence with its manifest (Migration 70, P1-C). Requested by an Owner / Admin for
 * a scope (site, date range, run ids) and built asynchronously; the ZIP lives in the private bucket under the export
 * prefix for 24 hours (expiresAt) and is downloaded through a short-lived signed URL (every download audited). The row
 * is the export record (kept 24 months with the audit trail): who asked, why, what was in scope, what was included or
 * left out, and the SHA-256 of the ZIP and of its manifest.
 *
 *   queued → running → ready → expired      (failed: retried by the maintenance job up to a bound, then left failed)
 */
@Entity('patrol_evidence_exports')
@Unique('UQ_patrol_evidence_exports_id_company', ['id', 'companyId'])
@Index('UQ_patrol_evidence_exports_storage_key', ['storageKey'], { unique: true, where: '"storageKey" IS NOT NULL' })
@Index('IDX_patrol_evidence_exports_company', ['companyId', 'createdAt'])
@Index('IDX_patrol_evidence_exports_open', ['status'], { where: `"status" IN ('queued', 'running', 'ready')` })
export class PatrolEvidenceExport {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_evidence_exports' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int' })
  requestedByUserId!: number;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status!: string;

  @Column({ type: 'varchar', length: 32 })
  purpose!: string;

  @Column({ type: 'int', nullable: true })
  siteId!: number | null;

  @Column({ type: 'date', nullable: true })
  fromDate!: string | null;

  @Column({ type: 'date', nullable: true })
  toDate!: string | null;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  runIds!: number[];

  @Column({ type: 'int', default: 0 })
  itemCount!: number;

  @Column({ type: 'int', default: 0 })
  includedCount!: number;

  @Column({ type: 'int', default: 0 })
  excludedCount!: number;

  @Column({ type: 'bigint', default: 0 })
  includedBytes!: string;

  @Column({ type: 'bigint', nullable: true })
  zipBytes!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  zipSha256!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  manifestSha256!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  storageKey!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  error!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'uuid', nullable: true })
  claimToken!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  claimedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  objectDeletedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
