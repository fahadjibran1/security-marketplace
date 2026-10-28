import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A hold that protects patrol evidence from deletion (Migration 68): one photo, a run, a shift, or a site and date
 * range. Manual (Owner / Admin, with a reason) or automatic while an incident, alert or exception is open. Kept six
 * years after release. Placing and releasing holds is P1-C; P1-A only reads them.
 */
@Entity('patrol_evidence_holds')
@Index('IDX_patrol_evidence_holds_active', ['companyId'], { where: '"releasedAt" IS NULL' })
export class PatrolEvidenceHold {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_evidence_holds' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'varchar', length: 24 })
  scope!: string;

  @Column({ type: 'int', nullable: true })
  evidenceId!: number | null;

  @Column({ type: 'int', nullable: true })
  runId!: number | null;

  @Column({ type: 'int', nullable: true })
  shiftId!: number | null;

  @Column({ type: 'int', nullable: true })
  siteId!: number | null;

  @Column({ type: 'date', nullable: true })
  fromDate!: string | null;

  @Column({ type: 'date', nullable: true })
  toDate!: string | null;

  @Column({ type: 'varchar', length: 1000 })
  reason!: string;

  @Column({ type: 'varchar', length: 16, default: 'manual' })
  source!: string;

  @Column({ type: 'int', nullable: true })
  incidentId!: number | null;

  @Column({ type: 'int', nullable: true })
  safetyAlertId!: number | null;

  @Column({ type: 'int', nullable: true })
  exceptionId!: number | null;

  @Column({ type: 'int', nullable: true })
  createdByUserId!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  autoReleaseAfter!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  releasedAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  releasedByUserId!: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  releaseReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
