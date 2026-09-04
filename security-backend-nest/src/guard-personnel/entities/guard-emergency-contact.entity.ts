import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum EmergencyContactRelationship {
  SPOUSE_PARTNER = 'SPOUSE_PARTNER',
  PARENT = 'PARENT',
  SIBLING = 'SIBLING',
  CHILD = 'CHILD',
  RELATIVE = 'RELATIVE',
  FRIEND = 'FRIEND',
  OTHER = 'OTHER',
}

@Entity('guard_emergency_contacts')
export class GuardEmergencyContact {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => GuardProfile, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'guardId' })
  guard!: GuardProfile;

  // Third-party PII — contact's name encrypted at rest, never serialised directly.
  @Column({ type: 'text', select: false })
  contactNameEnc!: string;

  @Column({
    type: 'enum',
    enum: EmergencyContactRelationship,
    enumName: 'emergency_contact_relationship_enum',
  })
  relationship!: EmergencyContactRelationship;

  // Only meaningful when relationship = OTHER; plaintext — not sensitive in isolation.
  @Column({ type: 'varchar', length: 100, nullable: true })
  customRelationship?: string | null;

  // Phone numbers — encrypted at rest, never logged, never returned as ciphertext.
  @Column({ type: 'text', select: false })
  primaryPhoneEnc!: string;

  @Column({ type: 'text', nullable: true, select: false })
  alternatePhoneEnc?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
