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
 * A renewable mobile session.
 *
 * The refresh token itself is never stored. Only its SHA-256 hash is persisted, so a database
 * disclosure cannot be replayed against the API. Every successful refresh rotates the token:
 * the presented row is revoked and a successor is written carrying the same `familyId`.
 *
 * Presenting an already-rotated token therefore means the token leaked — the whole family is
 * revoked rather than just that row, which is the standard reuse-detection response.
 */
@Entity('auth_sessions')
export class AuthSession {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  /** SHA-256 of the opaque refresh token. Unique so a hash collision cannot alias two sessions. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  tokenHash!: string;

  /** Shared by every rotation of one login, so reuse detection can revoke the whole chain. */
  @Index()
  @Column({ type: 'uuid' })
  familyId!: string;

  /** The session this one replaced, for tracing a rotation chain. */
  @Column({ type: 'int', nullable: true })
  rotatedFromId?: number | null;

  /** Idle expiry. Extended on every successful refresh, never beyond absoluteExpiresAt. */
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /** Hard ceiling set at login. Refresh can never push a family past this. */
  @Column({ type: 'timestamptz' })
  absoluteExpiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt?: Date | null;

  /** Why the row stopped being usable — rotation is routine, the others are not. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  revokedReason?: 'rotated' | 'logout' | 'reuse_detected' | 'password_change' | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
