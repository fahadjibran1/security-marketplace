import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { PatrolMethod, PatrolOrderMode, PatrolRequirementScope } from '../patrol-constants';

/**
 * A patrol policy (Migration 68): the company default (siteId NULL) or one site's settings. A site without its own row
 * inherits the company default, and a company without one inherits PATROL_POLICY_DEFAULTS.
 */
@Entity('patrol_policies')
@Index('UQ_patrol_policies_company_default', ['companyId'], { unique: true, where: '"siteId" IS NULL' })
@Index('UQ_patrol_policies_company_site', ['companyId', 'siteId'], { unique: true, where: '"siteId" IS NOT NULL' })
export class PatrolPolicy {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_policies' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int', nullable: true })
  siteId!: number | null;

  @Column({ type: 'jsonb', default: () => `'["qr"]'` })
  methods!: PatrolMethod[];

  @Column({ type: 'int', default: 0 })
  photosPerRun!: number;

  @Column({ type: 'int', default: 0 })
  photosPerCheckpoint!: number;

  @Column({ type: 'varchar', length: 16, default: 'any' })
  orderMode!: PatrolOrderMode;

  @Column({ type: 'int', default: 15 })
  startGraceMinutes!: number;

  @Column({ type: 'int', default: 45 })
  maxPatrolDurationMinutes!: number;

  @Column({ type: 'int', default: 30 })
  completionGraceMinutes!: number;

  @Column({ type: 'int', default: 60 })
  syncGraceMinutes!: number;

  @Column({ type: 'varchar', length: 16, default: 'site' })
  requirementScope!: PatrolRequirementScope;

  @Column({ type: 'int', default: 30 })
  retentionDays!: number;

  @Column({ type: 'boolean', default: true })
  incompleteNeedsAction!: boolean;

  /** Migration 69: hours after Book Off (or the shift end) in which offline patrol data is still accepted. */
  @Column({ type: 'int', default: 24 })
  postShiftSyncHours!: number;

  /** Migration 69: device clock drift beyond this is flagged clock_drift_suspect. */
  @Column({ type: 'int', default: 5 })
  clockDriftThresholdMinutes!: number;

  /** Migration 69: a run with no schedule needs no matching window. */
  @Column({ type: 'boolean', default: true })
  allowUnscheduledPatrols!: boolean;

  /** Migration 69: evidence still not on the server at the sync deadline also raises a Live Operations alert. */
  @Column({ type: 'boolean', default: false })
  escalateUnverified!: boolean;

  /** Disabled until the privacy assessment: always false (the API refuses true). */
  @Column({ type: 'boolean', default: false })
  qrRequireProximity!: boolean;

  @Column({ type: 'int', nullable: true })
  proximityMeters!: number | null;

  @Column({ type: 'int', nullable: true })
  updatedByUserId!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
