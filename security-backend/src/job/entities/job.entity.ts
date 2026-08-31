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

export enum JobSourceType {
  INTERNAL = 'INTERNAL',
  MARKETPLACE = 'MARKETPLACE',
}

@Entity('jobs')
export class Job {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({
    type: 'enum',
    enum: JobSourceType,
    default: JobSourceType.MARKETPLACE,
  })
  sourceType!: JobSourceType;

  @OneToMany(() => JobSlot, (slot) => slot.job)
  slots!: JobSlot[];

  @ManyToOne(() => Company, (company) => company.jobs, { eager: true })
  company!: Company;

  @Column()
  title!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ nullable: true })
  siteName?: string;

  @Column({ type: 'timestamp' })
  startAt!: Date;

  @Column({ type: 'timestamp' })
  endAt!: Date;

  @Column({ type: 'int', default: 1 })
  guardsRequired!: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  hourlyRate!: number;

  @Column({ default: 'OPEN' })
  status!: string;

  @OneToMany(() => JobApplication, (application) => application.job)
  applications!: JobApplication[];

  @OneToMany(() => Assignment, (assignment) => assignment.job)
  assignments!: Assignment[];
}