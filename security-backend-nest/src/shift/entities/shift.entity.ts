import {
  Column,
  Entity,
  JoinColumn,
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
import { RotaSlot } from '../../rota-slot/entities/rota-slot.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';

@Entity('shifts')
export class Shift {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Assignment, (assignment) => assignment.shifts, { eager: true, nullable: true })
  assignment?: Assignment | null;

  @ManyToOne(() => Company, (company) => company.shifts, { eager: true, nullable: false })
  company!: Company;

  @ManyToOne(() => GuardProfile, (guard) => guard.shifts, { eager: true, nullable: true })
  guard?: GuardProfile | null;

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

  /** The EFFECTIVE operational end: after an accepted Live Shift Amendment it is the agreed, extended end. */
  @Column({ type: 'timestamp' })
  end!: Date;

  /**
   * The originally scheduled end, set once when the first extension of this shift is accepted (Migration 64); null
   * for a shift never extended. A convenience copy: the full history is the shift_amendments chain and the audit log.
   */
  @Column({ type: 'timestamp', nullable: true })
  originalEnd?: Date | null;

  @Column({ type: 'int', default: 60 })
  checkCallIntervalMinutes!: number;

  @Column({ type: 'text', nullable: true })
  instructions?: string | null;

  @Column({ type: 'text', nullable: true })
  closeOutNotes?: string | null;

  @Column({ default: 'unfilled' })
  status!: string;

  @OneToMany(() => Timesheet, (timesheet) => timesheet.shift)
  timesheets?: Timesheet[];

  @Column({ name: 'rotaSlotId', type: 'int', nullable: true })
  rotaSlotId?: number | null;

  @ManyToOne(() => RotaSlot, (slot) => slot.shifts, {
    nullable: true,
    eager: false,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'rotaSlotId' })
  rotaSlot?: RotaSlot | null;
}
