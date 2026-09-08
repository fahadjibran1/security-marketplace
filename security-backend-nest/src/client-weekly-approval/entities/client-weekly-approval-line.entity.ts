import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ClientWeeklyApprovalRequest } from './client-weekly-approval-request.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';

@Entity('client_weekly_approval_lines')
export class ClientWeeklyApprovalLine {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => ClientWeeklyApprovalRequest, (req) => req.lines, { nullable: false, onDelete: 'CASCADE' })
  weeklyApprovalRequest!: ClientWeeklyApprovalRequest;

  @ManyToOne(() => Timesheet, { eager: true, nullable: false })
  timesheet!: Timesheet;

  @Column({ type: 'int', default: 1 })
  submissionVersion!: number;

  @Column({ type: 'boolean', default: false })
  superseded!: boolean;

  @Column({ type: 'numeric', precision: 8, scale: 2 })
  approvedHoursAtSubmission!: number;

  @Column({ type: 'date' })
  shiftDate!: string;

  @Column({ type: 'timestamptz', nullable: true })
  scheduledStart?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  scheduledEnd?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  actualCheckIn?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  actualCheckOut?: Date | null;

  @Column({ type: 'int', nullable: true })
  verifiedMinutes?: number | null;

  @Column({ type: 'boolean', default: false })
  hasOverride!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
