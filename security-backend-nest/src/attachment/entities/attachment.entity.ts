import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { User } from '../../user/entities/user.entity';

export enum AttachmentEntityType {
  INCIDENT = 'incident',
  ALERT = 'alert',
  DAILY_LOG = 'daily_log',
  TIMESHEET = 'timesheet',
  SHIFT = 'shift',
}

@Entity('attachments')
export class Attachment {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, { nullable: true, eager: true, onDelete: 'SET NULL' })
  @JoinColumn()
  company?: Company | null;

  @ManyToOne(() => User, { nullable: true, eager: true, onDelete: 'SET NULL' })
  @JoinColumn()
  uploadedBy?: User | null;

  @Column({
    type: 'enum',
    enum: AttachmentEntityType,
  })
  entityType!: AttachmentEntityType;

  @Column('int')
  entityId!: number;

  @Column('varchar')
  fileName!: string;

  @Column('varchar')
  fileUrl!: string;

  @Column('varchar')
  mimeType!: string;

  @Column('int')
  sizeBytes!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
