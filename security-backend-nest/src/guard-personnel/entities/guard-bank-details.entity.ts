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

@Entity('guard_bank_details')
export class GuardBankDetails {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  guardId!: number;

  @OneToOne(() => GuardProfile, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'guardId' })
  guard!: GuardProfile;

  // All three bank fields are select:false — never returned by default ORM queries.
  // Use findWithSensitive() + addSelect() before any decryption path.
  @Column({ type: 'text', nullable: true, select: false })
  accountHolderNameEnc?: string | null;

  @Column({ type: 'text', nullable: true, select: false })
  sortCodeEnc?: string | null;

  @Column({ type: 'text', nullable: true, select: false })
  accountNumberEnc?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
