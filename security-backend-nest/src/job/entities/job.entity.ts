import {
  Column,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Company } from '../../company/entities/company.entity';
import { JobApplication } from '../../job-application/entities/job-application.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';
import { JobSlot } from '../../job-slot/entities/job-slot.entity';
import { Site } from '../../site/entities/site.entity';

export enum JobSourceType {
  INTERNAL = 'internal',
  MARKETPLACE = 'marketplace',
}

@Entity('jobs')
export class Job {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, (company) => company.jobs, { eager: true })
  company!: Company;

  @ManyToOne(() => Site, (site) => site.jobs, { eager: true, nullable: true })
  site?: Site | null;

  @Column()
  title!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'int' })
  guardsRequired!: number;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  hourlyRate!: number;

  @Column({ default: 'open' })
  status!: string;

  @Column({
    type: 'enum',
    enum: JobSourceType,
    default: JobSourceType.INTERNAL,
  })
  sourceType!: JobSourceType;

  @Column({ type: 'timestamp', nullable: true })
  startAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  endAt?: Date;

  @OneToMany(() => JobApplication, (application) => application.job)
  applications?: JobApplication[];

  @OneToMany(() => Assignment, (assignment) => assignment.job)
  assignments?: Assignment[];

  @OneToMany(() => JobSlot, (slot) => slot.job)
  slots?: JobSlot[];
}
