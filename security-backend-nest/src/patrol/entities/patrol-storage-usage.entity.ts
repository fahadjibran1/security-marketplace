import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Live patrol storage metering (Migration 70, P1-C): one row per (company, site) for photo evidence — verified objects in
 * the primary prefix (active) and objects held in quarantine (deleted but recoverable, and rejected uploads) — and one
 * company row (siteId NULL) for evidence export ZIPs. Every counter moves in the same transaction as the evidence or
 * export state change that causes it; patrol_storage_usage_daily (Migration 68) keeps a daily snapshot. No billing in
 * Phase 1.
 */
@Entity('patrol_storage_usage')
@Index('UQ_patrol_storage_usage_site', ['companyId', 'siteId'], { unique: true, where: '"siteId" IS NOT NULL' })
@Index('UQ_patrol_storage_usage_company', ['companyId'], { unique: true, where: '"siteId" IS NULL' })
export class PatrolStorageUsage {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_storage_usage' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int', nullable: true })
  siteId!: number | null;

  @Column({ type: 'int', default: 0 })
  activeObjects!: number;

  @Column({ type: 'bigint', default: 0 })
  activeBytes!: string;

  @Column({ type: 'int', default: 0 })
  quarantinedObjects!: number;

  @Column({ type: 'bigint', default: 0 })
  quarantinedBytes!: string;

  @Column({ type: 'int', default: 0 })
  exportObjects!: number;

  @Column({ type: 'bigint', default: 0 })
  exportBytes!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
