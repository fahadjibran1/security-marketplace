import { Column, CreateDateColumn, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Job } from '../../job/entities/job.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';

@Entity('job_applications')
export class JobApplication {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Job, (job) => job.applications, { eager: true })
  job!: Job;

  @ManyToOne(() => GuardProfile, (guard) => guard.applications, { eager: true })
  guard!: GuardProfile;

  @Column({ default: 'applied' })
  status!: string;

  @CreateDateColumn()
  appliedAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  hiredAt?: Date;

  @OneToMany(() => Assignment, (assignment) => assignment.application)
  assignments?: Assignment[];
}
