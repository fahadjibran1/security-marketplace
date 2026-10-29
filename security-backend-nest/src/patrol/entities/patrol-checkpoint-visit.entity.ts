import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import type { PatrolScanFlag, PatrolSyncFlag, PatrolVisitResult } from '../patrol-constants';

/**
 * One checkpoint label scan (Migration 68): evidence that the LABEL was scanned, never proof that the Guard was there.
 * The server's verification result and its reasons (flags) are stored with what was scanned; the scan stays
 * provisional until the P1-B engine finalises it. Location columns exist for a later, privacy-approved phase and are
 * never written while location verification is disabled. clientVisitId makes the upload idempotent.
 */
@Entity('patrol_checkpoint_visits')
@Unique('UQ_patrol_checkpoint_visits_id_company', ['id', 'companyId'])
@Index('UQ_patrol_checkpoint_visits_client_visit_id', ['companyId', 'clientVisitId'], { unique: true })
@Index('IDX_patrol_checkpoint_visits_run', ['runId'])
@Index('IDX_patrol_checkpoint_visits_checkpoint', ['checkpointId'])
export class PatrolCheckpointVisit {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_checkpoint_visits' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int' })
  runId!: number;

  @Column({ type: 'int', nullable: true })
  checkpointId!: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  scannedPublicId!: string | null;

  @Column({ type: 'int', nullable: true })
  scannedTokenVersion!: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  scannedKeyId!: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  scanPayload!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'qr' })
  method!: string;

  @Column({ type: 'varchar', length: 16 })
  result!: PatrolVisitResult;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  flags!: PatrolScanFlag[];

  @Column({ type: 'boolean', default: true })
  provisional!: boolean;

  @Column({ type: 'timestamptz' })
  scannedAtDevice!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  receivedAtServer!: Date;

  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  accuracyMeters!: number | null;

  @Column({ type: 'double precision', nullable: true })
  distanceMeters!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  coordinatesPurgedAt!: Date | null;

  @Column({ type: 'varchar', length: 64 })
  clientVisitId!: string;

  /** Migration 69: reached the server after the shift ended. */
  @Column({ type: 'boolean', default: false })
  syncedLate!: boolean;

  /** Migration 69: how the scan synced (separate from the scan's verification flags). */
  @Column({ type: 'jsonb', default: () => `'[]'` })
  syncFlags!: PatrolSyncFlag[];

  /** Migration 69: server receipt − the device's sentAtDevice, when the app sent it. */
  @Column({ type: 'int', nullable: true })
  clockDriftMs!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
