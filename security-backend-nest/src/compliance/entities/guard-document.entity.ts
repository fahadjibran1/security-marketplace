import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum GuardDocumentType {
  SIA_LICENCE = 'sia_licence',
  RIGHT_TO_WORK = 'right_to_work',
  ID_PROOF = 'id_proof',
  TRAINING = 'training',
}

@Entity('guard_documents')
export class GuardDocument {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => GuardProfile, (guard) => guard.documents, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'guardId' })
  guard!: GuardProfile;

  @Column({
    type: 'enum',
    enum: GuardDocumentType,
  })
  type!: GuardDocumentType;

  @Column({ type: 'varchar' })
  fileUrl!: string;

  @Column({ type: 'date', nullable: true })
  expiryDate?: string | null;

  @Column({ type: 'boolean', default: false })
  verified!: boolean;

  @CreateDateColumn()
  uploadedAt!: Date;
}
