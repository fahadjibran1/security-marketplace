import { Column, CreateDateColumn, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { Client } from '../../client/entities/client.entity';
import { Site } from '../../site/entities/site.entity';
import { ClientWeeklyApprovalLine } from './client-weekly-approval-line.entity';
import { ClientShiftDispute } from './client-shift-dispute.entity';

export enum ClientWeeklyApprovalStatus {
  PENDING_APPROVAL = 'pending_approval',
  CLIENT_APPROVED  = 'client_approved',
  DISPUTED         = 'disputed',
  RESOLVED         = 'resolved',
  LOCKED           = 'locked',
}

@Entity('client_weekly_approval_requests')
export class ClientWeeklyApprovalRequest {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, { eager: true, nullable: false, onDelete: 'CASCADE' })
  company!: Company;

  @ManyToOne(() => Client, { eager: true, nullable: false, onDelete: 'CASCADE' })
  client!: Client;

  @ManyToOne(() => Site, { eager: true, nullable: false, onDelete: 'CASCADE' })
  site!: Site;

  @Column({ type: 'date' })
  weekCommencing!: string;

  @Column({ type: 'date' })
  weekEnding!: string;

  @Column({ type: 'enum', enum: ClientWeeklyApprovalStatus, default: ClientWeeklyApprovalStatus.PENDING_APPROVAL })
  status!: ClientWeeklyApprovalStatus;

  @Column({ type: 'int', default: 1 })
  currentVersion!: number;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt?: Date | null;

  @Column({ type: 'int', nullable: true })
  submittedByUserId?: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  clientRespondedAt?: Date | null;

  @Column({ type: 'int', nullable: true })
  clientRespondedBy?: number | null;

  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  totalApprovedHours?: number | null;

  @Column({ type: 'text', nullable: true })
  companyInternalNote?: string | null;

  @Column({ type: 'text', nullable: true })
  clientSubmissionNote?: string | null;

  @OneToMany(() => ClientWeeklyApprovalLine, (line) => line.weeklyApprovalRequest)
  lines?: ClientWeeklyApprovalLine[];

  @OneToMany(() => ClientShiftDispute, (d) => d.weeklyApprovalRequest)
  disputes?: ClientShiftDispute[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
