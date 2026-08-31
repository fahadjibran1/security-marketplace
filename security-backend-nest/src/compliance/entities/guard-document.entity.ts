import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Company } from '../../company/entities/company.entity';

export enum GuardDocumentType {
  SIA_LICENCE = 'sia_licence',
  RIGHT_TO_WORK = 'right_to_work',
  ID_PROOF = 'id_proof',
  TRAINING = 'training',
}

@Entity('guard_documents')
@Index('IDX_guard_documents_company_guard', ['company', 'guard'])
@Index('IDX_guard_documents_storage_key', ['storageProvider', 'storageKey'], { unique: true, where: '"storageKey" IS NOT NULL' })
export class GuardDocument {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => GuardProfile, (guard) => guard.documents, {
    eager: true,
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'guardId' })
  guard!: GuardProfile;

  @ManyToOne(() => Company, { eager: true, nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company?: Company | null;

  @Column({
    type: 'enum',
    enum: GuardDocumentType,
  })
  type!: GuardDocumentType;

  @Column({ type: 'varchar', nullable: true, select: false })
  fileUrl?: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  storageProvider?: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  storageKey?: string | null;

  @Column({ type: 'varchar', nullable: true })
  originalFileName?: string | null;

  @Column({ type: 'varchar', nullable: true })
  mimeType?: string | null;

  @Column({ type: 'bigint', nullable: true })
  sizeBytes?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  uploadCompletedAt?: Date | null;

  @Column({ type: 'date', nullable: true })
  expiryDate?: string | null;

  @Column({ type: 'boolean', default: false })
  verified!: boolean;

  @Column({ type: 'int', nullable: true })
  uploadedByUserId?: number | null;

  @Column({ type: 'int', nullable: true })
  verifiedByUserId?: number | null;

  @Column({ type: 'timestamp', nullable: true })
  verifiedAt?: Date | null;

  @CreateDateColumn()
  uploadedAt!: Date;
}
