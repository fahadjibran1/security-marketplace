import {
  Column,
  Entity,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../user/entities/user.entity';
import { Job } from '../../job/entities/job.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';
import { Shift } from '../../shift/entities/shift.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';
import { CompanyGuard } from '../../company-guard/entities/company-guard.entity';
import { Site } from '../../site/entities/site.entity';

@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => User, { eager: true })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column()
  name!: string;

  @Column()
  companyNumber!: string;

  @Column()
  address!: string;

  @Column()
  contactDetails!: string;

  @OneToMany(() => Job, (job) => job.company)
  jobs?: Job[];

  @OneToMany(() => Assignment, (assignment) => assignment.company)
  assignments?: Assignment[];

  @OneToMany(() => Shift, (shift) => shift.company)
  shifts?: Shift[];

  @OneToMany(() => Timesheet, (timesheet) => timesheet.company)
  timesheets?: Timesheet[];

  @OneToMany(() => CompanyGuard, (companyGuard) => companyGuard.company)
  companyGuards?: CompanyGuard[];

  @OneToMany(() => Site, (site) => site.company)
  sites?: Site[];
}
