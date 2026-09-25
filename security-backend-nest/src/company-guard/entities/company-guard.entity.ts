import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum CompanyGuardStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  BLOCKED = 'BLOCKED',
}

export enum CompanyGuardRelationshipType {
  EMPLOYEE = 'EMPLOYEE',
  PREFERRED = 'PREFERRED',
  APPROVED_CONTRACTOR = 'APPROVED_CONTRACTOR',
}

@Entity('company_guards')
@Unique(['company', 'guard'])
export class CompanyGuard {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, (company) => company.companyGuards, { eager: true, nullable: false })
  company!: Company;

  @ManyToOne(() => GuardProfile, (guard) => guard.companyGuards, { eager: true, nullable: false })
  guard!: GuardProfile;

  @Column({ type: 'enum', enum: CompanyGuardStatus, default: CompanyGuardStatus.ACTIVE })
  status!: CompanyGuardStatus;

  @Column({
    type: 'enum',
    enum: CompanyGuardRelationshipType,
    default: CompanyGuardRelationshipType.APPROVED_CONTRACTOR,
  })
  relationshipType!: CompanyGuardRelationshipType;

  /**
   * When the Guard consented to this relationship, and the invitation they consented through.
   *
   * Both NULL for a relationship established any other way — a hire, or a direct company link — which
   * covers every row that predates workforce invitations. A NULL acceptedAt therefore means "not
   * established by guard consent", not "not consented".
   */
  @Column({ type: 'timestamp', nullable: true })
  acceptedAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  invitationId!: number | null;

  @CreateDateColumn()
  createdAt!: Date;
}
