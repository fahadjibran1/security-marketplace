import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * One checkpoint's place on a route (Migration 68). The composite foreign keys (routeId, companyId, siteId) and
 * (checkpointId, companyId, siteId) make a link between a route and another site's checkpoint impossible to store.
 */
@Entity('patrol_route_checkpoints')
@Unique('UQ_patrol_route_checkpoints_position', ['routeId', 'position'])
@Unique('UQ_patrol_route_checkpoints_checkpoint', ['routeId', 'checkpointId'])
@Index('IDX_patrol_route_checkpoints_checkpoint', ['checkpointId'])
export class PatrolRouteCheckpoint {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_patrol_route_checkpoints' })
  id!: number;

  @Column({ type: 'int' })
  companyId!: number;

  @Column({ type: 'int' })
  siteId!: number;

  @Column({ type: 'int' })
  routeId!: number;

  @Column({ type: 'int' })
  checkpointId!: number;

  @Column({ type: 'int' })
  position!: number;

  @Column({ type: 'boolean', default: true })
  required!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
