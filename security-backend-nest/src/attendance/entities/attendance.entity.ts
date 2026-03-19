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

  @ManyToOne(() => Shift, { eager: true, onDelete: 'CASCADE' })
  shift!: Shift;

  @ManyToOne(() => GuardProfile, { eager: true, onDelete: 'CASCADE' })
  guard!: GuardProfile;

  @Column({
    type: 'enum',
    enum: AttendanceEventType,
  })
  type!: AttendanceEventType;

  @Column({ nullable: true })
  nfcTag?: string | null;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @CreateDateColumn()
  occurredAt!: Date;
}
