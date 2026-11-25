import { Check, Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { User } from '../../user/entities/user.entity';

/**
 * Platform Admin two-step verification (Migration 77): one row per Platform Admin who has started or completed
 * authenticator-app (TOTP) enrolment. No row means not enrolled.
 *
 * Secrets are held only as AES-256-GCM envelopes (EncryptionService, GUARD_DATA_ENCRYPTION_KEY), never in plain text,
 * and are never returned by the API once enrolment is confirmed. `lastUsedStep` is the last accepted TOTP time step:
 * a code for that step or an earlier one is refused, so an observed code cannot be replayed.
 *
 * Kept out of the users table on purpose, so no query or response that loads a user can ever carry the secret.
 */
@Entity('platform_admin_mfa')
@Check('CHK_platform_admin_mfa_enabled_secret', `("enabledAt" IS NULL) = ("totpSecretEncrypted" IS NULL)`)
@Check('CHK_platform_admin_mfa_pending_pair', `("pendingSecretEncrypted" IS NULL) = ("pendingCreatedAt" IS NULL)`)
export class PlatformAdminMfa {
  @PrimaryColumn({ type: 'int', primaryKeyConstraintName: 'PK_platform_admin_mfa' })
  userId!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_platform_admin_mfa_user' })
  user?: User;

  /** The active secret (encrypted). Set exactly when enabledAt is set. */
  @Column({ type: 'text', nullable: true })
  totpSecretEncrypted!: string | null;

  /** A secret issued by "start enrolment" and not yet confirmed with a code (encrypted). */
  @Column({ type: 'text', nullable: true })
  pendingSecretEncrypted!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  pendingCreatedAt!: Date | null;

  /** When enrolment was confirmed. Null: not enrolled (sign-in is password only, unless the rollout flag requires it). */
  @Column({ type: 'timestamptz', nullable: true })
  enabledAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  lastUsedStep!: number | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
