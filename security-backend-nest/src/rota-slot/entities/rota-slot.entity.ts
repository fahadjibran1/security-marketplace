import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Company } from '../../company/entities/company.entity';
import { Job } from '../../job/entities/job.entity';
import { Shift } from '../../shift/entities/shift.entity';
import { Site } from '../../site/entities/site.entity';

@Entity('rota_slots')
export class RotaSlot {
  @PrimaryGeneratedColumn()
  id!: number;

  // ── Tenant root ──────────────────────────────────────────────────────────

  @Column({ name: 'companyId', type: 'int' })
  companyId!: number;

  @ManyToOne(() => Company, { nullable: false, eager: false })
  @JoinColumn({ name: 'companyId' })
  company!: Company;

  // ── Site ─────────────────────────────────────────────────────────────────
  // ON DELETE RESTRICT: sites cannot be deleted via the API (no DELETE endpoint
  // on SiteController), so this constraint is a safety net only.

  @Column({ name: 'siteId', type: 'int' })
  siteId!: number;

  @ManyToOne(() => Site, { nullable: false, eager: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'siteId' })
  site!: Site;

  // ── Job (optional context) ────────────────────────────────────────────────
  // Not the authoritative guard count. Job.guardsRequired is a recruitment cap;
  // RotaSlot.requiredGuardCount is the operational requirement for this window.

  @Column({ name: 'jobId', type: 'int', nullable: true })
  jobId?: number | null;

  @ManyToOne(() => Job, { nullable: true, eager: false, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'jobId' })
  job?: Job | null;

  // ── Copy-week idempotency ─────────────────────────────────────────────────
  // Set when a slot is created by copying another week. The unique index
  // (copiedFromSlotId, DATE(startAt)) is deferred to the Copy Week service
  // phase where it can be tested against real copy semantics.

  @Column({ name: 'copiedFromSlotId', type: 'int', nullable: true })
  copiedFromSlotId?: number | null;

  @ManyToOne(() => RotaSlot, { nullable: true, eager: false, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'copiedFromSlotId' })
  copiedFromSlot?: RotaSlot | null;

  // ── Time window ──────────────────────────────────────────────────────────

  @Column({ type: 'timestamp' })
  startAt!: Date;

  @Column({ type: 'timestamp' })
  endAt!: Date;

  // ── Staffing requirement ─────────────────────────────────────────────────
  // Authoritative per-window guard count. Enforced >= 1 by DB CHECK constraint.

  @Column({ type: 'int', default: 1 })
  requiredGuardCount!: number;

  // ── Snapshotted operational settings ─────────────────────────────────────
  // Captured from Site.welfareCheckIntervalMinutes at slot creation.
  // Locked once any child Shift reaches in_progress (enforced by service).

  @Column({ type: 'int', default: 60 })
  checkCallIntervalMinutes!: number;

  // ── Content ──────────────────────────────────────────────────────────────

  @Column({ type: 'text', nullable: true })
  instructions?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title?: string | null;

  // ── Lifecycle ────────────────────────────────────────────────────────────
  // Two values only: active | cancelled.
  // 'completed' is intentionally absent — derived from endAt < now at query time.

  @Column({ default: 'active' })
  status!: string;

  // ── Child shifts ─────────────────────────────────────────────────────────
  // N Shift records = N guard positions beneath this slot.

  @OneToMany(() => Shift, (shift) => shift.rotaSlot)
  shifts?: Shift[];

  // ── Timestamps ───────────────────────────────────────────────────────────

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
