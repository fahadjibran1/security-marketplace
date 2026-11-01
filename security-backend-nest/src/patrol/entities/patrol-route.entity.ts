import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import type { PatrolOrderMode } from '../patrol-constants';

/** A named set of one site's checkpoints, in order or any order (Migration 68). Archived, never deleted. */
@Entity('patrol_routes')
@Unique('UQ_patrol_routes_id_company_site', ['id', 'companyId', 'siteId'])
@Index('IDX_patrol_routes_company_site', ['companyId', 'siteId'])
@Index('UQ_patrol_routes_superseded_by', ['supersededByRouteId'], { unique: true, where: '"supersededByRouteId" IS NOT NULL' })
@Index('IDX_patrol_routes_superseded', ['companyId'], { where: '"supersededByRouteId" IS NOT NULL' })
export class PatrolRoute {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_routes' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int' })
  siteId!: number;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: 'any' })
  orderMode!: PatrolOrderMode;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  /** Migration 74: 'custom' (chosen checkpoints) or 'auto' (every confirmed checkpoint of the site, maintained by S4). */
  @Column({ type: 'varchar', length: 16, default: 'custom' })
  kind!: 'custom' | 'auto';

  /**
   * Migration 74: the version that replaced this route after a checkpoint change (same company and site, composite
   * FK_patrol_routes_superseded_by), and the instant it took effect. Both set or both null (patrol-route-versions.ts).
   */
  @Column({ type: 'int', nullable: true })
  supersededByRouteId!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  supersededAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  createdByUserId!: number | null;

  @Column({ type: 'int', nullable: true })
  updatedByUserId!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
