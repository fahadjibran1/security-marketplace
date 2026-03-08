import { Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { JobApplication } from '../../job-application/entities/job-application.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';

@Entity('jobs')
export class Job {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, (company) => company.jobs, { eager: true })
  company!: Company;

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

  @OneToMany(() => JobApplication, (application) => application.job)
  applications?: JobApplication[];

  @OneToMany(() => Assignment, (assignment) => assignment.job)
  assignments?: Assignment[];
}
