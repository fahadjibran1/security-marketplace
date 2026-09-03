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

export enum DrivingLicenceStatus {
  NONE = 'NONE',
  PROVISIONAL = 'PROVISIONAL',
  FULL = 'FULL',
  OTHER_OR_FOREIGN = 'OTHER_OR_FOREIGN',
}

export enum PrimaryTravelMethod {
  CAR = 'CAR',
  MOTORCYCLE = 'MOTORCYCLE',
  PUBLIC_TRANSPORT = 'PUBLIC_TRANSPORT',
  BICYCLE = 'BICYCLE',
  WALK = 'WALK',
  OTHER = 'OTHER',
}

@Entity('guard_driving_profiles')
export class GuardDrivingProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => GuardProfile, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'guardId' })
  guard!: GuardProfile;

  @Column({ type: 'enum', enum: DrivingLicenceStatus, default: DrivingLicenceStatus.NONE })
  licenceStatus!: DrivingLicenceStatus;

  // AES-256-GCM envelope — never returned in any response; revealed only via explicit audit-logged endpoint.
  @Column({ type: 'text', nullable: true, select: false })
  licenceNumberEnc?: string | null;

  @Column({ type: 'simple-json', nullable: true })
  licenceCategories?: string[] | null;

  @Column({ type: 'date', nullable: true })
  licenceExpiryDate?: string | null;

  @Column({ type: 'boolean', nullable: true })
  willingToDriveToWork?: boolean | null;

  @Column({ type: 'boolean', nullable: true })
  ownsVehicle?: boolean | null;

  @Column({ type: 'boolean', nullable: true })
  hasVehicleAccess?: boolean | null;

  @Column({ type: 'enum', enum: PrimaryTravelMethod, nullable: true })
  primaryTravelMethod?: PrimaryTravelMethod | null;

  // Integer miles — kept as raw int for future Smart Matching distance queries.
  @Column({ type: 'int', nullable: true })
  maxTravelDistanceMiles?: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
