import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Shift } from '../../shift/entities/shift.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum AttendanceEventType {
  CHECK_IN = 'check-in',
  CHECK_OUT = 'check-out',
}

export enum AttendanceSource {
  GUARD_APP = 'guard_app',
  MANUAL = 'manual',
}

export const ATTENDANCE_VERIFICATION_METHODS = [
  'phone_call',
  'supervisor_on_site',
  'cctv',
  'client_confirmation',
  'radio',
  'other',
] as const;
export type AttendanceVerificationMethod = (typeof ATTENDANCE_VERIFICATION_METHODS)[number];

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

  @Column({ type: 'varchar', nullable: true, select: false })
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

  /**
   * When the Guard actually booked on / off. For a Guard-app row it is the server time of the request; for a manual
   * row (or a correction) it is the time stated by the staff member who recorded it, never the time of recording.
   */
  @CreateDateColumn()
  occurredAt!: Date;

  // ── Manual attendance (Migration 67). Original rows are never updated: a correction is a NEW row pointing at the
  // row it corrects (correctionOfEventId), and the effective value is the chain's tip (see ../effective-attendance.ts).

  /** 'guard_app' (the Guard's own Book On / Off) or 'manual' (recorded by authorised company staff). */
  @Column({ type: 'varchar', length: 20, default: AttendanceSource.GUARD_APP })
  source!: AttendanceSource;

  /** Server time the row was written. NULL on rows written before Migration 67 (read as occurredAt). */
  @Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
  recordedAt?: Date | null;

  /** The staff member who recorded a manual row. Plain id: accounts are anonymised in place, never deleted. */
  @Column({ type: 'int', nullable: true })
  recordedByUserId?: number | null;

  @Column({ type: 'text', nullable: true })
  reason?: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  verificationMethod?: AttendanceVerificationMethod | null;

  @Column({ type: 'text', nullable: true })
  verificationNote?: string | null;

  /** The row this one corrects (same shift and type, enforced by a composite foreign key). */
  @Column({ type: 'int', nullable: true })
  correctionOfEventId?: number | null;
}
