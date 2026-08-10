import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Shift } from '../../shift/entities/shift.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum AttendanceEventType {
  CHECK_IN = 'check-in',
  CHECK_OUT = 'check-out',
}

@Entity('attendance_events')
export class AttendanceEvent {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Shift, { eager: true, nullable: false, onDelete: 'CASCADE' })
  shift!: Shift;

  @ManyToOne(() => GuardProfile, { eager: true, nullable: false, onDelete: 'CASCADE' })
  guard!: GuardProfile;

  @Column({
    type: 'enum',
    enum: AttendanceEventType,
  })
  type!: AttendanceEventType;

  @Column({ type: 'varchar', nullable: true })
  nfcTag?: string | null;

  @Column({ type: 'boolean', default: false })
  nfcVerified!: boolean;

  @Column({ type: 'double precision', nullable: true })
  latitude?: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude?: number | null;

  @Column({ type: 'double precision', nullable: true })
  gpsAccuracyMeters?: number | null;

  @Column({ type: 'double precision', nullable: true })
  distanceFromSiteMeters?: number | null;

  @Column({ type: 'boolean', default: false })
  gpsVerified!: boolean;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @CreateDateColumn()
  occurredAt!: Date;
}
