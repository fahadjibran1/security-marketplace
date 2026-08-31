import { Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { Job } from '../../job/entities/job.entity';
import { Shift } from '../../shift/entities/shift.entity';
import { Client } from '../../client/entities/client.entity';

@Entity('sites')
export class Site {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, (company) => company.sites, { eager: true, nullable: false })
  company!: Company;

  @ManyToOne(() => Client, (client) => client.sites, { eager: true, nullable: true, onDelete: 'SET NULL' })
  client?: Client | null;

  @Column()
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  clientName?: string;

  @Column()
  address!: string;

  @Column({ type: 'text', nullable: true })
  contactDetails?: string;

  @Column({ default: 'active' })
  status!: string;

  @Column({ type: 'int', default: 1 })
  requiredGuardCount!: number;

  @Column({ type: 'varchar', nullable: true })
  operatingDays?: string | null;

  @Column({ type: 'varchar', nullable: true })
  operatingStartTime?: string | null;

  @Column({ type: 'varchar', nullable: true })
  operatingEndTime?: string | null;

  @Column({ type: 'int', default: 60 })
  welfareCheckIntervalMinutes!: number;

  @Column({ type: 'text', nullable: true })
  specialInstructions?: string | null;

  @Column({ type: 'double precision', nullable: true })
  latitude?: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude?: number | null;

  @Column({ type: 'int', default: 150 })
  geofenceRadiusMeters!: number;

  @Column({ type: 'boolean', default: false })
  requireGpsCheckIn!: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  attendanceNfcTag?: string | null;

  @Column({ type: 'boolean', default: false })
  requireNfcCheckIn!: boolean;

  @OneToMany(() => Job, (job) => job.site)
  jobs?: Job[];

  @OneToMany(() => Shift, (shift) => shift.site)
  shifts?: Shift[];
}
