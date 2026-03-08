import { Column, Entity, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum UserRole {
  ADMIN = 'admin',
  COMPANY = 'company',
  GUARD = 'guard'
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  email!: string;

  @Column()
  passwordHash!: string;

  @Column({ type: 'enum', enum: UserRole })
  role!: UserRole;

  @OneToOne(() => Company, (company) => company.user)
  companyProfile?: Company;

  @OneToOne(() => GuardProfile, (guardProfile) => guardProfile.user)
  guardProfile?: GuardProfile;
}
