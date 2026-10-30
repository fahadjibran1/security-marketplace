import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * An exceptional offline recovery grant (Migration 72, issue #68). An Owner / Admin allows ONE Guard to send patrol data
 * for ONE shift after the standard post-shift sync window has closed, until expiresAt (default 24 h, at most 72 h after
 * issue), with a mandatory reason. Revocable; every issue / use / revoke is audited. Data accepted under a grant is
 * flagged recovered_via_grant and needsReview. Foreign keys (one composite, to the company's shift) and CHECKs live in
 * the migration only, as for the other patrol tables.
 */
@Entity('patrol_sync_recovery_grants')
@Index('IDX_patrol_sync_recovery_grants_active', ['companyId', 'shiftId', 'guardId', 'expiresAt'], { where: '"revokedAt" IS NULL' })
@Index('IDX_patrol_sync_recovery_grants_company', ['companyId', 'createdAt'])
export class PatrolSyncRecoveryGrant {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_sync_recovery_grants' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int' })
  guardId!: number;

  @Column({ type: 'int' })
  shiftId!: number;

  @Column({ type: 'varchar', length: 1000 })
  reason!: string;

  @Column({ type: 'int' })
  createdByUserId!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  revokedByUserId!: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  revokeReason!: string | null;

  @Column({ type: 'int', default: 0 })
  uses!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;
}
