import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * A patrol schedule (Migration 68): consecutive windows of windowMinutes every frequencyMinutes (15–1440) between
 * activeFrom and activeTo, SITE-LOCAL wall-clock "HH:mm" (an overnight period such as 22:00–06:00 belongs to the day it
 * starts), on the chosen ISO days of week (1 = Monday … 7 = Sunday). Window generation is P1-B (siteLocalToInstant).
 */
@Entity('patrol_schedules')
@Unique('UQ_patrol_schedules_id_company_site', ['id', 'companyId', 'siteId'])
@Index('IDX_patrol_schedules_company_site', ['companyId', 'siteId'])
export class PatrolSchedule {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_schedules' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int' })
  siteId!: number;

  @Column({ type: 'int', nullable: true })
  routeId!: number | null;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'jsonb', default: () => `'[1, 2, 3, 4, 5, 6, 7]'` })
  daysOfWeek!: number[];

  @Column({ type: 'varchar', length: 5 })
  activeFrom!: string;

  @Column({ type: 'varchar', length: 5 })
  activeTo!: string;

  @Column({ type: 'int' })
  frequencyMinutes!: number;

  @Column({ type: 'int' })
  windowMinutes!: number;

  @Column({ type: 'date', nullable: true })
  startsOn!: string | null;

  @Column({ type: 'date', nullable: true })
  endsOn!: string | null;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  createdByUserId!: number | null;

  @Column({ type: 'int', nullable: true })
  updatedByUserId!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
