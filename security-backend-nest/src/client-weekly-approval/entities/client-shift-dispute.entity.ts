import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { ClientWeeklyApprovalRequest } from './client-weekly-approval-request.entity';
import { ClientWeeklyApprovalLine } from './client-weekly-approval-line.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';

export enum ClientShiftDisputeStatus {
  OPEN      = 'open',
  RESOLVED  = 'resolved',
  WITHDRAWN = 'withdrawn',
}

@Entity('client_shift_disputes')
export class ClientShiftDispute {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => ClientWeeklyApprovalRequest, (req) => req.disputes, { nullable: false })
  weeklyApprovalRequest!: ClientWeeklyApprovalRequest;

  @ManyToOne(() => ClientWeeklyApprovalLine, { eager: true, nullable: false })
  line!: ClientWeeklyApprovalLine;

  @ManyToOne(() => Timesheet, { nullable: false })
  timesheet!: Timesheet;

  @Column({ type: 'int' })
  submissionVersion!: number;

  @Column({ type: 'text' })
  disputeReason!: string;

  @Column({ type: 'int', nullable: true })
  disputedByUserId?: number | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  disputedAt!: Date;

  @Column({ type: 'enum', enum: ClientShiftDisputeStatus, enumName: 'client_shift_dispute_status_enum', default: ClientShiftDisputeStatus.OPEN })
  status!: ClientShiftDisputeStatus;

  @Column({ type: 'text', nullable: true })
  resolutionMessage?: string | null;

  @Column({ type: 'int', nullable: true })
  resolvedByUserId?: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
