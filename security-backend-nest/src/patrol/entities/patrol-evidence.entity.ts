import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * Patrol photo evidence metadata (Migration 68). P1-A defines the record only; create / presign / complete and the
 * integrity checks are P1-C. The row outlives the image: after expiry it becomes a tombstone that keeps the hashes,
 * times and actor ids. retentionStatus carries the P1-C deletion state machine
 * (active → claimed → quarantined → purged → tombstone, with restore), with claimToken / claimedAt / quarantinedAt /
 * purgedAt / restoredAt / deletionAttempts / lastDeletionError. Migration 70 (P1-C) adds the upload / verification
 * columns, the end of the quarantine (purgeAfter) and the object-removal confirmations (primaryDeletedAt,
 * objectDeletedAt); the state machine itself is described in evidence/patrol-evidence-lifecycle.service.ts.
 */
@Entity('patrol_evidence')
@Unique('UQ_patrol_evidence_id_company', ['id', 'companyId'])
@Index('UQ_patrol_evidence_client_evidence_id', ['companyId', 'clientEvidenceId'], { unique: true })
@Index('UQ_patrol_evidence_storage_key', ['storageKey'], { unique: true, where: '"storageKey" IS NOT NULL' })
@Index('IDX_patrol_evidence_expiry', ['expiresAt'], { where: `"retentionStatus" = 'active' AND "expiresAt" IS NOT NULL` })
@Index('IDX_patrol_evidence_run', ['runId'])
@Index('IDX_patrol_evidence_lifecycle', ['companyId', 'retentionStatus'], { where: `"retentionStatus" <> 'tombstone'` })
@Index('IDX_patrol_evidence_pending_upload', ['uploadUrlIssuedAt'], { where: `"uploadStatus" IN ('pending', 'uploaded')` })
export class PatrolEvidence {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_evidence' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int' })
  siteId!: number;

  @Column({ type: 'int' })
  runId!: number;

  @Column({ type: 'int', nullable: true })
  visitId!: number | null;

  @Column({ type: 'int' })
  guardId!: number;

  @Column({ type: 'int' })
  shiftId!: number;

  @Column({ type: 'varchar', length: 16, default: 'camera' })
  source!: string;

  @Column({ type: 'varchar', length: 24, default: 'run_photo' })
  kind!: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  storageKey!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  quarantineKey!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  mimeType!: string | null;

  @Column({ type: 'bigint', nullable: true })
  sizeBytes!: string | null;

  @Column({ type: 'int', nullable: true })
  widthPx!: number | null;

  @Column({ type: 'int', nullable: true })
  heightPx!: number | null;

  @Column({ type: 'varchar', length: 64 })
  sha256Client!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  sha256Stored!: string | null;

  @Column({ type: 'timestamptz' })
  capturedAtDevice!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  receivedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  @Column({ type: 'varchar', length: 24, default: 'pending' })
  uploadStatus!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  rejectionReason!: string | null;

  @Column({ type: 'int', nullable: true })
  retentionDays!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  retentionStatus!: string;

  @Column({ type: 'uuid', nullable: true })
  claimToken!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  claimedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  quarantinedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  purgedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  restoredAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  deletionAttempts!: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  lastDeletionError!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  deletionReason!: string | null;

  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  accuracyMeters!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  coordinatesPurgedAt!: Date | null;

  @Column({ type: 'varchar', length: 64 })
  clientEvidenceId!: string;

  // ── Migration 70 (P1-C): upload, verification and the deletion state machine ─────────────────────────

  /** The size the Guard declared for the upload (≤ the configured cap); sizeBytes is what the server found. */
  @Column({ type: 'bigint', nullable: true })
  declaredSizeBytes!: string | null;

  /** What the server found the bytes to be (their signature), whatever was declared. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  detectedMimeType!: string | null;

  /** When the last upload URL was handed out (always inside the post-shift sync acceptance window). */
  @Column({ type: 'timestamptz', nullable: true })
  uploadUrlIssuedAt!: Date | null;

  /** The completion lease: one verifier at a time; a concurrent completion waits for its result. */
  @Column({ type: 'uuid', nullable: true })
  completionToken!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completionStartedAt!: Date | null;

  /** synced_after_book_off, evidence_after_alert (and, with the designed recovery grant, recovered_via_grant). */
  @Column({ type: 'jsonb', default: () => `'[]'` })
  syncFlags!: string[];

  @Column({ type: 'boolean', default: false })
  needsReview!: boolean;

  /** End of the quarantine: until then the photo can be restored; after it (and with no hold) it is purged. */
  @Column({ type: 'timestamptz', nullable: true })
  purgeAfter!: Date | null;

  /** The object under storageKey was confirmed removed (only after its quarantined copy was verified). */
  @Column({ type: 'timestamptz', nullable: true })
  primaryDeletedAt!: Date | null;

  /** The quarantined copy was confirmed removed: the row is a tombstone (hashes, sizes and times are kept). */
  @Column({ type: 'timestamptz', nullable: true })
  objectDeletedAt!: Date | null;

  /** The Owner / Admin who asked for a manual deletion (it goes through the same state machine as retention). */
  @Column({ type: 'int', nullable: true })
  deletionRequestedByUserId!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
