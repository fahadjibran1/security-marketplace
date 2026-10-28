import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Daily storage metering snapshot per company and site (Migration 68). Written by P1-C; no billing in Phase 1. */
@Entity('patrol_storage_usage_daily')
@Unique('UQ_patrol_storage_usage_daily_day', ['companyId', 'siteId', 'day'])
export class PatrolStorageUsageDaily {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_storage_usage_daily' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int' })
  siteId!: number;

  @Column({ type: 'date' })
  day!: string;

  @Column({ type: 'int', default: 0 })
  objects!: number;

  @Column({ type: 'bigint', default: 0 })
  bytes!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  computedAt!: Date;
}
