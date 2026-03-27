import {
  Column,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Assignment } from '../../assignment/entities/assignment.entity';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { JobApplication } from '../../job-application/entities/job-application.entity';
import { Job } from '../../job/entities/job.entity';
import { Site } from '../../site/entities/site.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';

@Entity('shifts')
export class Shift {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Assignment, (assignment) => assignment.shifts, { eager: true, nullable: true })
  assignment?: Assignment | null;

  @ManyToOne(() => Company, (company) => company.shifts, { eager: true })
  company!: Company;

  @ManyToOne(() => GuardProfile, (guard) => guard.shifts, { eager: true })
  guard!: GuardProfile;

  @ManyToOne(() => Site, (site) => site.shifts, { eager: true, nullable: true })
  site?: Site | null;

  @ManyToOne(() => Job, (job) => job.assignments, { eager: true, nullable: true })
  job?: Job | null;

  @ManyToOne(() => JobApplication, (application) => application.assignments, {
    eager: true,
    nullable: true,
  })
  jobApplication?: JobApplication | null;

  @Column({ type: 'int', nullable: true })
  createdByUserId?: number | null;

  @Column()
  siteName!: string;

  @Column({ type: 'timestamp' })
  start!: Date;

  @Column({ type: 'timestamp' })
  end!: Date;

  @Column({ type: 'int', default: 60 })
  checkCallIntervalMinutes!: number;

  @Column({ default: 'scheduled' })
  status!: string;

  @OneToMany(() => Timesheet, (timesheet) => timesheet.shift)
  timesheets?: Timesheet[];
}
