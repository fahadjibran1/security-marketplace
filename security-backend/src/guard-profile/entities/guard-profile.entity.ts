import { Column, Entity, JoinColumn, OneToMany, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { JobApplication } from '../../job-application/entities/job-application.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';
import { Shift } from '../../shift/entities/shift.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';

@Entity('guard_profiles')
export class GuardProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => User, { eager: true })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column()
  fullName!: string;

  @Column({ unique: true })
  siaLicenseNumber!: string;

  @Column()
  phone!: string;

  @Column({ default: false })
  locationSharingEnabled!: boolean;

  @Column({ default: 'pending' })
  status!: string;

  @OneToMany(() => JobApplication, (application) => application.guard)
  applications?: JobApplication[];

  @OneToMany(() => Assignment, (assignment) => assignment.guard)
  assignments?: Assignment[];

  @OneToMany(() => Shift, (shift) => shift.guard)
  shifts?: Shift[];

  @OneToMany(() => Timesheet, (timesheet) => timesheet.guard)
  timesheets?: Timesheet[];
}
