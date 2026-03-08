import { Column, CreateDateColumn, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Job } from '../../job/entities/job.entity';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { JobApplication } from '../../job-application/entities/job-application.entity';
import { Shift } from '../../shift/entities/shift.entity';

@Entity('assignments')
export class Assignment {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Job, (job) => job.assignments, { eager: true })
  job!: Job;

  @ManyToOne(() => Company, (company) => company.assignments, { eager: true })
  company!: Company;

  @ManyToOne(() => GuardProfile, (guard) => guard.assignments, { eager: true })
  guard!: GuardProfile;

  @ManyToOne(() => JobApplication, (application) => application.assignments, { eager: true })
  application!: JobApplication;

  @Column({ default: 'active' })
  status!: string;

  @CreateDateColumn()
  hiredAt!: Date;

  @OneToMany(() => Shift, (shift) => shift.assignment)
  shifts?: Shift[];
}
