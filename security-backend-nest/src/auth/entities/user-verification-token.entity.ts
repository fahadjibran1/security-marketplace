import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';

/**
 * What a verification token may be spent on. Stored as plain varchar and validated here rather than
 * as a PostgreSQL enum, so a later purpose is an application change and never an ALTER TYPE.
 */
export enum VerificationTokenPurpose {
  PASSWORD_RESET = 'password_reset',
  EMAIL_VERIFICATION = 'email_verification',
}

export const VERIFICATION_TOKEN_PURPOSES: readonly string[] = Object.values(VerificationTokenPurpose);

/**
 * A single-use token emailed to an account holder: a password reset link or an email verification link.
 *
 * Only the SHA-256 hash of the token is stored, so a database disclosure cannot be replayed. A token is
 * spendable only while all of these hold: it has not expired, it has not been used, and it has not been
 * invalidated. Issuing a new token for the same purpose invalidates every unspent predecessor, so only
 * the most recent link in somebody's inbox works.
 *
 * The user foreign key cascades on delete, and that is deliberately harmless: a token is a credential,
 * not evidence, and S4 never physically deletes a user row — account deletion anonymises in place.
 * Nothing references this table, so a cascade can never reach operational records.
 */
@Entity('user_verification_tokens')
@Index('IDX_user_verification_tokens_user_purpose', ['userId', 'purpose'])
export class UserVerificationToken {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'int' })
  userId!: number;

  @Column({ type: 'varchar', length: 32 })
  purpose!: VerificationTokenPurpose;

  /** SHA-256 hex of the emailed token. Unique: the hash is the lookup key. */
  @Index('UQ_user_verification_tokens_token_hash', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  tokenHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt?: Date | null;

  /** Set when a newer token for the same purpose superseded this one, or the account was deleted. */
  @Column({ type: 'timestamptz', nullable: true })
  invalidatedAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
