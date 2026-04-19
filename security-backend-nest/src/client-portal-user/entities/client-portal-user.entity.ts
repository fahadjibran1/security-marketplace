import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Client } from '../../client/entities/client.entity';
import { UserRole } from '../../user/entities/user.entity';

@Entity('client_portal_users')
export class ClientPortalUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Client, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'clientId' })
  client!: Client;

  @Column({ type: 'varchar', unique: true })
  email!: string;

  @Column({ type: 'varchar' })
  passwordHash!: string;

  @Column({ type: 'varchar' })
  firstName!: string;

  @Column({ type: 'varchar' })
  lastName!: string;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({
    type: 'enum',
    enum: [UserRole.CLIENT_ADMIN, UserRole.CLIENT_VIEWER],
    default: UserRole.CLIENT_VIEWER,
  })
  role!: UserRole.CLIENT_ADMIN | UserRole.CLIENT_VIEWER;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt?: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
