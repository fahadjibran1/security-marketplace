import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../../user/entities/user.entity';

export type PushPlatform = 'ios' | 'android';

/**
 * One app installation's Expo push token, for the account signed in on it (Migration 65). A token is unique: the same
 * phone registering under another account moves the row, it never duplicates it. Revoked (never deleted by the
 * product) on sign-out, on the provider's DeviceNotRegistered, or when the token changes.
 *
 * The token only addresses a phone. It is not a credential: holding one lets nobody act as the Guard.
 */
@Entity('push_devices')
@Check('CHK_push_devices_platform', `"platform" IN ('ios', 'android')`)
@Index('UQ_push_devices_token', ['token'], { unique: true })
@Index('IDX_push_devices_user', ['userId'])
export class PushDevice {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_push_devices' })
  id!: number;

  @Column({ type: 'int' })
  userId!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_push_devices_user' })
  user?: User;

  @Column({ type: 'varchar', length: 255 })
  token!: string;

  @Column({ type: 'varchar', length: 16 })
  platform!: PushPlatform;

  @Column({ type: 'varchar', length: 32, nullable: true })
  appVersion!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  lastSeenAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  revokedReason!: string | null;
}
