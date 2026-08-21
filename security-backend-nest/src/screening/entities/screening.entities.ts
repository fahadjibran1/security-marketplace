import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum ScreeningStatus { NOT_STARTED='NOT_STARTED', IN_PROGRESS='IN_PROGRESS', READY_FOR_REVIEW='READY_FOR_REVIEW', UNDER_REVIEW='UNDER_REVIEW', VETTED='VETTED', REQUIRES_ATTENTION='REQUIRES_ATTENTION', REJECTED='REJECTED', EXPIRED='EXPIRED' }
export enum HistoryType { EMPLOYMENT='EMPLOYMENT', SELF_EMPLOYMENT='SELF_EMPLOYMENT', EDUCATION='EDUCATION', UNEMPLOYMENT='UNEMPLOYMENT', CAREER_BREAK='CAREER_BREAK', OVERSEAS='OVERSEAS', OTHER_EXPLAINED_PERIOD='OTHER_EXPLAINED_PERIOD' }
export enum VerificationState { UNVERIFIED='UNVERIFIED', PENDING='PENDING', VERIFIED='VERIFIED', REJECTED='REJECTED' }
export enum ReferenceStatus { NOT_REQUESTED='NOT_REQUESTED', REQUESTED='REQUESTED', RECEIVED='RECEIVED', SOURCE_VERIFICATION_REQUIRED='SOURCE_VERIFICATION_REQUIRED', VERIFIED='VERIFIED', UNABLE_TO_VERIFY='UNABLE_TO_VERIFY', REJECTED='REJECTED' }
export enum EvidenceCategory { IDENTITY='identity', ADDRESS='address', EMPLOYMENT='employment', EDUCATION='education', SELF_EMPLOYMENT='self_employment', UNEMPLOYMENT='unemployment', REFERENCE='reference', RIGHT_TO_WORK='right_to_work', SIA='sia', OVERSEAS='overseas', OTHER='other' }

@Entity('guard_screenings')
export class GuardScreening {
  @PrimaryGeneratedColumn() id!: number;
  @OneToOne(() => GuardProfile, { eager: true, nullable: false }) @JoinColumn({ name: 'guardId' }) guard!: GuardProfile;
  @Column({ type: 'enum', enum: ScreeningStatus, default: ScreeningStatus.NOT_STARTED }) status!: ScreeningStatus;
  @Column({ default: 5 }) screeningPeriodYears!: number;
  @Column({ type: 'varchar', nullable: true }) legalFullName?: string | null;
  @Column({ type: 'text', nullable: true }) previousNames?: string | null;
  @Column({ type: 'date', nullable: true }) dateOfBirth?: string | null;
  @Column({ type: 'varchar', nullable: true }) nationality?: string | null;
  @Column({ type: 'text', nullable: true }) currentAddress?: string | null;
  @Column({ type: 'enum', enum: VerificationState, default: VerificationState.UNVERIFIED }) identityVerification!: VerificationState;
  @Column({ type: 'varchar', nullable: true }) identityVerificationMethod?: string | null;
  @Column({ type: 'int', nullable: true }) identityVerifiedByUserId?: number | null;
  @Column({ type: 'timestamp', nullable: true }) identityVerifiedAt?: Date | null;
  @Column({ type: 'varchar', nullable: true }) siaLicenceType?: string | null;
  @Column({ type: 'enum', enum: VerificationState, default: VerificationState.UNVERIFIED }) siaRegisterVerification!: VerificationState;
  @Column({ type: 'int', nullable: true }) siaVerifiedByUserId?: number | null;
  @Column({ type: 'timestamp', nullable: true }) siaVerifiedAt?: Date | null;
  @Column({ type: 'varchar', nullable: true }) rightToWorkCheckMethod?: string | null;
  @Column({ type: 'date', nullable: true }) rightToWorkCheckDate?: string | null;
  @Column({ type: 'date', nullable: true }) rightToWorkFollowUpDate?: string | null;
  @Column({ type: 'enum', enum: VerificationState, default: VerificationState.UNVERIFIED }) rightToWorkVerification!: VerificationState;
  @Column({ type: 'int', nullable: true }) rightToWorkVerifiedByUserId?: number | null;
  @Column({ type: 'timestamp', nullable: true }) rightToWorkVerifiedAt?: Date | null;
  @Column({ type: 'text', nullable: true, select: false }) reviewNotes?: string | null;
  @Column({ type: 'timestamp', nullable: true }) submittedAt?: Date | null;
  @Column({ type: 'int', nullable: true }) reviewedByUserId?: number | null;
  @Column({ type: 'timestamp', nullable: true }) reviewedAt?: Date | null;
  @Column({ type: 'timestamp', nullable: true }) vettedAt?: Date | null;
  @Column({ type: 'timestamp', nullable: true }) retentionReviewAt?: Date | null;
  @CreateDateColumn() createdAt!: Date; @UpdateDateColumn() updatedAt!: Date;
  @OneToMany(() => ScreeningHistory, (entry) => entry.screening) history?: ScreeningHistory[];
  @OneToMany(() => ScreeningAddress, (entry) => entry.screening) addresses?: ScreeningAddress[];
  @OneToMany(() => ScreeningReference, (entry) => entry.screening) references?: ScreeningReference[];
  @OneToMany(() => ScreeningEvidence, (entry) => entry.screening) evidence?: ScreeningEvidence[];
  @OneToMany(() => ScreeningConsent, (entry) => entry.screening) consents?: ScreeningConsent[];
  @OneToMany(() => ScreeningException, (entry) => entry.screening) exceptions?: ScreeningException[];
}

@Entity('screening_history')
export class ScreeningHistory {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => GuardScreening, (screening) => screening.history, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'screeningId' }) screening!: GuardScreening;
  @Column({ type: 'enum', enum: HistoryType }) type!: HistoryType;
  @Column({ type: 'date' }) startDate!: string; @Column({ type: 'date', nullable: true }) endDate?: string | null; @Column({ default: false }) isCurrent!: boolean;
  @Column({ type:'varchar', nullable: true }) organisation?: string | null; @Column({ type: 'text', nullable: true }) address?: string | null; @Column({ type:'varchar', nullable: true }) contactDetails?: string | null; @Column({ type: 'text' }) description!: string;
  @Column({ type: 'enum', enum: VerificationState, default: VerificationState.UNVERIFIED }) verificationState!: VerificationState;
  @CreateDateColumn() createdAt!: Date; @UpdateDateColumn() updatedAt!: Date;
}

@Entity('screening_addresses')
export class ScreeningAddress { @PrimaryGeneratedColumn() id!: number; @ManyToOne(() => GuardScreening, (s) => s.addresses, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'screeningId' }) screening!: GuardScreening; @Column({ type:'text' }) address!: string; @Column({ type:'date' }) startDate!: string; @Column({ type:'date', nullable:true }) endDate?: string|null; @Column({ default:false }) isCurrent!: boolean; @Column({ type:'enum', enum:VerificationState, default:VerificationState.UNVERIFIED }) verificationState!: VerificationState; @CreateDateColumn() createdAt!: Date; }

@Entity('screening_references')
export class ScreeningReference { @PrimaryGeneratedColumn() id!: number; @ManyToOne(() => GuardScreening, (s) => s.references, { onDelete:'CASCADE' }) @JoinColumn({name:'screeningId'}) screening!: GuardScreening; @ManyToOne(() => ScreeningHistory, { nullable:false, onDelete:'CASCADE' }) @JoinColumn({name:'historyId'}) history!: ScreeningHistory; @Column() organisation!: string; @Column() contactPerson!: string; @Column() relationship!: string; @Column() businessEmail!: string; @Column({type:'varchar',nullable:true}) phone?:string|null; @Column({type:'text',nullable:true}) postalDetails?:string|null; @Column({type:'enum',enum:ReferenceStatus,default:ReferenceStatus.NOT_REQUESTED}) status!:ReferenceStatus; @Column({type:'timestamp',nullable:true}) requestedAt?:Date|null; @Column({type:'timestamp',nullable:true}) receivedAt?:Date|null; @Column({type:'varchar',nullable:true}) verificationMethod?:string|null; @Column({default:false}) sourceVerified!:boolean; @Column({type:'int',nullable:true}) verifiedByUserId?:number|null; @Column({type:'timestamp',nullable:true}) verifiedAt?:Date|null; @Column({type:'text',nullable:true,select:false}) outcomeNotes?:string|null; @CreateDateColumn() createdAt!:Date; @UpdateDateColumn() updatedAt!:Date; }

@Entity('screening_evidence')
export class ScreeningEvidence { @PrimaryGeneratedColumn() id!:number; @ManyToOne(() => GuardScreening,(s)=>s.evidence,{onDelete:'CASCADE'}) @JoinColumn({name:'screeningId'}) screening!:GuardScreening; @Column({type:'enum',enum:EvidenceCategory}) category!:EvidenceCategory; @Column() storageProvider!:string; @Column({unique:true}) storageKey!:string; @Column() originalFileName!:string; @Column() mimeType!:string; @Column({type:'bigint'}) sizeBytes!:string; @Column({type:'timestamp',nullable:true}) uploadCompletedAt?:Date|null; @Column({type:'enum',enum:VerificationState,default:VerificationState.UNVERIFIED}) verificationState!:VerificationState; @Column() uploadedByUserId!:number; @Column({type:'int',nullable:true}) verifiedByUserId?:number|null; @Column({type:'timestamp',nullable:true}) verifiedAt?:Date|null; @CreateDateColumn() createdAt!:Date; }

@Entity('screening_consents')
export class ScreeningConsent { @PrimaryGeneratedColumn() id!:number; @ManyToOne(() => GuardScreening,(s)=>s.consents,{onDelete:'CASCADE'}) @JoinColumn({name:'screeningId'}) screening!:GuardScreening; @Column() consentVersion!:string; @Column() candidateUserId!:number; @Column({type:'timestamp'}) acceptedAt!:Date; @Column({type:'timestamp',nullable:true}) withdrawnAt?:Date|null; @CreateDateColumn() createdAt!:Date; }

@Entity('screening_exceptions')
export class ScreeningException { @PrimaryGeneratedColumn() id!:number; @ManyToOne(() => GuardScreening,(s)=>s.exceptions,{onDelete:'CASCADE'}) @JoinColumn({name:'screeningId'}) screening!:GuardScreening; @Column() code!:string; @Column({type:'text'}) description!:string; @Column({default:false}) resolved!:boolean; @Column({type:'int',nullable:true}) resolvedByUserId?:number|null; @Column({type:'timestamp',nullable:true}) resolvedAt?:Date|null; @CreateDateColumn() createdAt!:Date; }
