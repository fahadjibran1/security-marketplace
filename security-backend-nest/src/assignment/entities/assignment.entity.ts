import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Job } from '../../job/entities/job.entity';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { JobApplication } from '../../job-application/entities/job-application.entity';
import { Shift } from '../../shift/entities/shift.entity';
import { JobSlot } from '../../job-slot/entities/job-slot.entity';

export enum AssignmentStatus {
  ASSIGNED = 'assigned',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
  CHECKED_IN = 'checked_in',
  CHECKED_OUT = 'checked_out',
  NO_SHOW = 'no_show',
  ACTIVE = 'active',
}

@Entity('assignments')
export class Assignment {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Job, (job) => job.assignments, { eager: true, nullable: true })
  job?: Job;

  @ManyToOne(() => Company, (company) => company.assignments, { eager: true })
  company!: Company;

  @ManyToOne(() => GuardProfile, (guard) => guard.assignments, { eager: true })
  guard!: GuardProfile;

  @ManyToOne(() => JobApplication, (application) => application.assignments, {
    eager: true,
    nullable: true,
  })
  application?: JobApplication;

  @Column({ type: 'varchar', default: AssignmentStatus.ASSIGNED })
  status!: string;

  @CreateDateColumn()
  hiredAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  assignedAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  acceptedAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  checkedInAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  checkedOutAt?: Date | null;

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true })
  checkInLat?: number | null;

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true })
  checkInLng?: number | null;

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true })
  checkOutLat?: number | null;

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true })
  checkOutLng?: number | null;

  @OneToMany(() => Shift, (shift) => shift.assignment)
  shifts?: Shift[];

  @OneToOne(() => JobSlot, (slot) => slot.assignment, { nullable: true })
  jobSlot?: JobSlot;
}
