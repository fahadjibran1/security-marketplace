import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * The patrol sweep's per-company progress (Migration 71, issue #67): every patrol window whose start deadline is at or
 * before judgedThrough has been judged. Advanced only in the transaction that judged up to it (under the company's sweep
 * lock), so a crash or a concurrent instance can never move it past work that did not commit.
 */
@Entity('patrol_sweep_watermarks')
export class PatrolSweepWatermark {
  @PrimaryColumn({ type: 'int', primaryKeyConstraintName: 'PK_patrol_sweep_watermarks' })
  companyId!: number;

  @Column({ type: 'timestamptz' })
  judgedThrough!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
