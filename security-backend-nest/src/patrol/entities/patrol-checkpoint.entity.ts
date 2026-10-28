import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * A patrol checkpoint (Migration 68). publicId is 128 bits of randomness (32 hex), never a sequential id; it is what
 * the printed label carries, signed with tokenVersion (patrol-qr.ts). Rotating ("reprint labels") increments
 * tokenVersion so older labels are flagged revoked_label; revoking rejects every scan of it.
 */
@Entity('patrol_checkpoints')
@Unique('UQ_patrol_checkpoints_public_id', ['publicId'])
@Unique('UQ_patrol_checkpoints_id_company', ['id', 'companyId'])
@Unique('UQ_patrol_checkpoints_id_company_site', ['id', 'companyId', 'siteId'])
@Index('IDX_patrol_checkpoints_company_site', ['companyId', 'siteId'])
export class PatrolCheckpoint {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_checkpoints' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int' })
  siteId!: number;

  @Column({ type: 'varchar', length: 32 })
  publicId!: string;

  @Column({ type: 'varchar', length: 120 })
  label!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  @Column({ type: 'int', default: 1 })
  tokenVersion!: number;

  /** Not accepted while location verification is disabled. */
  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ type: 'int', nullable: true })
  proximityMeters!: number | null;

  @Column({ type: 'boolean', default: false })
  photoRequired!: boolean;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  rotatedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  revokedByUserId!: number | null;

  @Column({ type: 'int', nullable: true })
  createdByUserId!: number | null;

  @Column({ type: 'int', nullable: true })
  updatedByUserId!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
