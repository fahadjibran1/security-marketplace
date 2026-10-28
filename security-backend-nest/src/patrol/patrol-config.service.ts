import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyMembershipRole, CompanyPermission } from '../company-membership/company-membership-types';
import {
  CreatePatrolCheckpointDto,
  CreatePatrolRouteDto,
  CreatePatrolScheduleDto,
  PatrolListQueryDto,
  PatrolRouteCheckpointInput,
  UpdatePatrolCheckpointDto,
  UpdatePatrolRouteDto,
  UpdatePatrolScheduleDto,
  UpsertPatrolPolicyDto,
} from './dto/patrol.dto';
import { PatrolAccessService, PatrolCompanyActor } from './patrol-access.service';
import { PATROL_EXTENDED_RETENTION_DAYS, PATROL_POLICY_DEFAULTS, PatrolErrorCode, patrolError } from './patrol-constants';
import { newCheckpointPublicId, signCheckpointLabel, patrolQrKeyring } from './patrol-qr';
import { serializeCheckpoint, serializePolicyFields, serializeRoute, serializeSchedule, updateRows } from './patrol-serializers';

const POLICY_FIELDS = [
  'methods', 'photosPerRun', 'photosPerCheckpoint', 'orderMode', 'startGraceMinutes', 'maxPatrolDurationMinutes',
  'completionGraceMinutes', 'syncGraceMinutes', 'requirementScope', 'retentionDays', 'incompleteNeedsAction',
  'qrRequireProximity', 'proximityMeters',
] as const;
type PolicyFields = ReturnType<typeof serializePolicyFields>;
export type EffectivePolicy = PolicyFields & { source: 'site' | 'company' | 'default' };

/** Only an Owner or Admin may extend evidence retention to 90 days (owner decision, 28 Oct 2026). */
export function mayExtendPatrolRetention(role: CompanyMembershipRole): boolean {
  return role === CompanyMembershipRole.OWNER || role === CompanyMembershipRole.ADMIN;
}

/**
 * Company configuration: site policies (and the company default), schedules, checkpoints and routes. Every read needs
 * patrols.view and every write patrols.manage (PatrolAccessService.companyActor). Every write is one transaction with
 * its audit entry. Configuration is never hard-deleted: schedules and routes are archived, checkpoints revoked.
 */
@Injectable()
export class PatrolConfigService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: PatrolAccessService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Policies ───────────────────────────────────────────────────────────────────────────────────────

  /** Site row → company default row → PATROL_POLICY_DEFAULTS. */
  async effectivePolicy(companyId: number, siteId: number | null, manager?: EntityManager): Promise<EffectivePolicy> {
    const rows = await (manager ?? this.dataSource).query(
      `SELECT * FROM "patrol_policies" WHERE "companyId" = $1 AND ("siteId" IS NULL OR "siteId" = $2)`,
      [companyId, siteId ?? -1],
    );
    const site = siteId == null ? null : rows.find((r: any) => r.siteId != null && Number(r.siteId) === siteId);
    const company = rows.find((r: any) => r.siteId == null);
    if (site) return { ...serializePolicyFields(site), source: 'site' };
    if (company) return { ...serializePolicyFields(company), source: 'company' };
    return { ...serializePolicyFields(PATROL_POLICY_DEFAULTS), source: 'default' };
  }

  async getPolicies(user: JwtPayload) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const sites = await this.dataSource.query(
      `SELECT "id", "name", "timezone" FROM "sites" WHERE "companyId" = $1 ORDER BY "name", "id"`,
      [actor.companyId],
    );
    const companyDefault = await this.effectivePolicy(actor.companyId, null);
    const out = [];
    for (const site of sites) {
      const policy = await this.effectivePolicy(actor.companyId, Number(site.id));
      out.push({ siteId: Number(site.id), siteName: site.name, timezone: site.timezone, policy });
    }
    return {
      defaults: serializePolicyFields(PATROL_POLICY_DEFAULTS),
      companyDefault,
      sites: out,
      locationVerificationAvailable: false,
      extendedRetentionAllowed: mayExtendPatrolRetention(actor.role),
    };
  }

  async upsertPolicy(user: JwtPayload, siteId: number | null, dto: UpsertPatrolPolicyDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    if (dto.qrRequireProximity === true || (dto.proximityMeters !== undefined && dto.proximityMeters !== null)) {
      throw patrolError(
        HttpStatus.BAD_REQUEST,
        PatrolErrorCode.LOCATION_VERIFICATION_DISABLED,
        'Location-based patrol verification is disabled until the privacy assessment is approved.',
      );
    }
    if (siteId != null) await this.assertSite(actor, siteId);

    return this.dataSource.transaction(async (manager) => {
      const find = async () =>
        (await manager.query(
          `SELECT * FROM "patrol_policies" WHERE "companyId" = $1 AND ${siteId == null ? '"siteId" IS NULL' : '"siteId" = $2'} FOR UPDATE`,
          siteId == null ? [actor.companyId] : [actor.companyId, siteId],
        ))[0];
      let existing = await find();
      const inherited = siteId == null
        ? { ...serializePolicyFields(PATROL_POLICY_DEFAULTS), source: 'default' as const }
        : await this.effectivePolicy(actor.companyId, null, manager);
      const before: PolicyFields = existing ? serializePolicyFields(existing) : stripSource(inherited);
      const after: PolicyFields = { ...before };
      for (const field of POLICY_FIELDS) {
        const value = (dto as Record<string, unknown>)[field];
        if (value !== undefined) (after as Record<string, unknown>)[field] = value;
      }
      after.qrRequireProximity = false;
      after.proximityMeters = null;

      if (after.retentionDays === PATROL_EXTENDED_RETENTION_DAYS && before.retentionDays !== PATROL_EXTENDED_RETENTION_DAYS
        && !mayExtendPatrolRetention(actor.role)) {
        throw patrolError(
          HttpStatus.FORBIDDEN,
          PatrolErrorCode.RETENTION_REQUIRES_OWNER_ADMIN,
          'Only a company Owner or Admin can extend patrol evidence retention to 90 days.',
        );
      }

      if (!existing) {
        await manager.query(
          `INSERT INTO "patrol_policies" ("companyId", "siteId", "updatedByUserId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [actor.companyId, siteId, actor.userId],
        );
        existing = await find();
      }
      const [row] = await updateRows(manager,
        `UPDATE "patrol_policies" SET "methods" = $2::jsonb, "photosPerRun" = $3, "photosPerCheckpoint" = $4, "orderMode" = $5,
            "startGraceMinutes" = $6, "maxPatrolDurationMinutes" = $7, "completionGraceMinutes" = $8, "syncGraceMinutes" = $9,
            "requirementScope" = $10, "retentionDays" = $11, "incompleteNeedsAction" = $12, "qrRequireProximity" = false,
            "proximityMeters" = NULL, "updatedByUserId" = $13, "updatedAt" = now()
          WHERE "id" = $1 RETURNING *`,
        [
          existing.id, JSON.stringify(after.methods), after.photosPerRun, after.photosPerCheckpoint, after.orderMode,
          after.startGraceMinutes, after.maxPatrolDurationMinutes, after.completionGraceMinutes, after.syncGraceMinutes,
          after.requirementScope, after.retentionDays, after.incompleteNeedsAction, actor.userId,
        ],
      );
      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: 'patrol.policy.updated',
        entityType: 'patrol_policy',
        entityId: Number(row.id),
        beforeData: { siteId, ...before },
        afterData: { siteId, ...serializePolicyFields(row) },
      });
      return { siteId, policy: { ...serializePolicyFields(row), source: siteId == null ? 'company' : 'site' } };
    });
  }

  // ── Schedules ──────────────────────────────────────────────────────────────────────────────────────

  async listSchedules(user: JwtPayload, query: PatrolListQueryDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const rows = await this.dataSource.query(
      `SELECT * FROM "patrol_schedules" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2)
          AND ($3::boolean OR "archivedAt" IS NULL) ORDER BY "siteId", "name", "id"`,
      [actor.companyId, query.siteId ?? null, query.includeInactive === 'true'],
    );
    return rows.map(serializeSchedule);
  }

  async getSchedule(user: JwtPayload, id: number) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    return serializeSchedule(await this.scheduleRow(actor, id));
  }

  async createSchedule(user: JwtPayload, dto: CreatePatrolScheduleDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    await this.assertSite(actor, dto.siteId);
    const values = {
      routeId: dto.routeId ?? null,
      name: dto.name.trim(),
      daysOfWeek: [...(dto.daysOfWeek ?? [1, 2, 3, 4, 5, 6, 7])].sort((a, b) => a - b),
      activeFrom: dto.activeFrom,
      activeTo: dto.activeTo,
      frequencyMinutes: dto.frequencyMinutes,
      windowMinutes: dto.windowMinutes ?? dto.frequencyMinutes,
      startsOn: dto.startsOn ?? null,
      endsOn: dto.endsOn ?? null,
      active: dto.active ?? true,
    };
    this.assertScheduleValues(values);
    return this.dataSource.transaction(async (manager) => {
      if (values.routeId != null) await this.assertRouteForSite(manager, actor, values.routeId, dto.siteId);
      const [row] = await manager.query(
        `INSERT INTO "patrol_schedules" ("companyId", "siteId", "routeId", "name", "daysOfWeek", "activeFrom", "activeTo",
            "frequencyMinutes", "windowMinutes", "startsOn", "endsOn", "active", "createdByUserId", "updatedByUserId")
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $13) RETURNING *`,
        [actor.companyId, dto.siteId, values.routeId, values.name, JSON.stringify(values.daysOfWeek), values.activeFrom, values.activeTo,
          values.frequencyMinutes, values.windowMinutes, values.startsOn, values.endsOn, values.active, actor.userId],
      );
      await this.audit(manager, actor, 'patrol.schedule.created', 'patrol_schedule', row.id, null, serializeSchedule(row));
      return serializeSchedule(row);
    });
  }

  async updateSchedule(user: JwtPayload, id: number, dto: UpdatePatrolScheduleDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    return this.dataSource.transaction(async (manager) => {
      const current = await this.scheduleRow(actor, id, manager, true);
      if (current.archivedAt) throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.VALIDATION, 'This schedule is archived.');
      const frequencyMinutes = dto.frequencyMinutes ?? Number(current.frequencyMinutes);
      const values = {
        routeId: dto.routeId !== undefined ? dto.routeId : current.routeId == null ? null : Number(current.routeId),
        name: dto.name !== undefined ? dto.name.trim() : current.name,
        daysOfWeek: [...(dto.daysOfWeek ?? current.daysOfWeek)].sort((a: number, b: number) => a - b),
        activeFrom: dto.activeFrom ?? current.activeFrom,
        activeTo: dto.activeTo ?? current.activeTo,
        frequencyMinutes,
        // Changing only the frequency keeps "window = frequency" schedules consistent.
        windowMinutes: dto.windowMinutes ?? (dto.frequencyMinutes !== undefined && Number(current.windowMinutes) === Number(current.frequencyMinutes)
          ? frequencyMinutes : Number(current.windowMinutes)),
        startsOn: dto.startsOn !== undefined ? dto.startsOn : dateText(current.startsOn),
        endsOn: dto.endsOn !== undefined ? dto.endsOn : dateText(current.endsOn),
        active: dto.active ?? Boolean(current.active),
      };
      this.assertScheduleValues(values);
      if (values.routeId != null) await this.assertRouteForSite(manager, actor, values.routeId, Number(current.siteId));
      const [row] = await updateRows(manager,
        `UPDATE "patrol_schedules" SET "routeId" = $2, "name" = $3, "daysOfWeek" = $4::jsonb, "activeFrom" = $5, "activeTo" = $6,
            "frequencyMinutes" = $7, "windowMinutes" = $8, "startsOn" = $9, "endsOn" = $10, "active" = $11,
            "updatedByUserId" = $12, "updatedAt" = now()
          WHERE "id" = $1 RETURNING *`,
        [id, values.routeId, values.name, JSON.stringify(values.daysOfWeek), values.activeFrom, values.activeTo, values.frequencyMinutes,
          values.windowMinutes, values.startsOn, values.endsOn, values.active, actor.userId],
      );
      await this.audit(manager, actor, 'patrol.schedule.updated', 'patrol_schedule', id, serializeSchedule(current), serializeSchedule(row));
      return serializeSchedule(row);
    });
  }

  /** DELETE archives: runs keep pointing at the schedule they were started for. Repeating it changes nothing. */
  async archiveSchedule(user: JwtPayload, id: number) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    return this.dataSource.transaction(async (manager) => {
      const current = await this.scheduleRow(actor, id, manager, true);
      if (current.archivedAt) return serializeSchedule(current);
      const [row] = await updateRows(manager,
        `UPDATE "patrol_schedules" SET "active" = false, "archivedAt" = now(), "updatedByUserId" = $2, "updatedAt" = now()
          WHERE "id" = $1 RETURNING *`,
        [id, actor.userId],
      );
      await this.audit(manager, actor, 'patrol.schedule.archived', 'patrol_schedule', id, serializeSchedule(current), serializeSchedule(row));
      return serializeSchedule(row);
    });
  }

  // ── Checkpoints ────────────────────────────────────────────────────────────────────────────────────

  async listCheckpoints(user: JwtPayload, query: PatrolListQueryDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const rows = await this.dataSource.query(
      `SELECT * FROM "patrol_checkpoints" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2)
          AND ($3::boolean OR "revokedAt" IS NULL) ORDER BY "siteId", "label", "id"`,
      [actor.companyId, query.siteId ?? null, query.includeInactive === 'true'],
    );
    return rows.map(serializeCheckpoint);
  }

  async getCheckpoint(user: JwtPayload, id: number) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    return serializeCheckpoint(await this.checkpointRow(actor, id));
  }

  async createCheckpoint(user: JwtPayload, dto: CreatePatrolCheckpointDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    this.rejectCheckpointLocation(dto);
    await this.assertSite(actor, dto.siteId);
    return this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(
        `INSERT INTO "patrol_checkpoints" ("companyId", "siteId", "publicId", "label", "description", "photoRequired", "createdByUserId", "updatedByUserId")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
        [actor.companyId, dto.siteId, newCheckpointPublicId(), dto.label.trim(), dto.description?.trim() || null, dto.photoRequired ?? false, actor.userId],
      );
      await this.audit(manager, actor, 'patrol.checkpoint.created', 'patrol_checkpoint', row.id, null, serializeCheckpoint(row));
      return serializeCheckpoint(row);
    });
  }

  async updateCheckpoint(user: JwtPayload, id: number, dto: UpdatePatrolCheckpointDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    this.rejectCheckpointLocation(dto);
    return this.dataSource.transaction(async (manager) => {
      const current = await this.checkpointRow(actor, id, manager, true);
      if (current.revokedAt) {
        throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.CHECKPOINT_REVOKED, 'This checkpoint is revoked. Create a new checkpoint instead.');
      }
      const [row] = await updateRows(manager,
        `UPDATE "patrol_checkpoints" SET "label" = $2, "description" = $3, "photoRequired" = $4, "active" = $5,
            "updatedByUserId" = $6, "updatedAt" = now() WHERE "id" = $1 RETURNING *`,
        [
          id,
          dto.label !== undefined ? dto.label.trim() : current.label,
          dto.description !== undefined ? dto.description?.trim() || null : current.description,
          dto.photoRequired ?? current.photoRequired,
          dto.active ?? current.active,
          actor.userId,
        ],
      );
      await this.audit(manager, actor, 'patrol.checkpoint.updated', 'patrol_checkpoint', id, serializeCheckpoint(current), serializeCheckpoint(row));
      return serializeCheckpoint(row);
    });
  }

  /** "Reprint labels": tokenVersion + 1, so every older printed label of this checkpoint is flagged revoked_label. */
  async rotateCheckpoint(user: JwtPayload, id: number) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    return this.dataSource.transaction(async (manager) => {
      const current = await this.checkpointRow(actor, id, manager, true);
      if (current.revokedAt) {
        throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.CHECKPOINT_REVOKED, 'This checkpoint is revoked; its labels cannot be reissued.');
      }
      const [row] = await updateRows(manager,
        `UPDATE "patrol_checkpoints" SET "tokenVersion" = "tokenVersion" + 1, "rotatedAt" = now(), "updatedByUserId" = $2, "updatedAt" = now()
          WHERE "id" = $1 RETURNING *`,
        [id, actor.userId],
      );
      await this.audit(manager, actor, 'patrol.checkpoint.rotated', 'patrol_checkpoint', id,
        { tokenVersion: Number(current.tokenVersion) }, { tokenVersion: Number(row.tokenVersion) });
      return serializeCheckpoint(row);
    });
  }

  /** Revocation is final: every later scan of this checkpoint is flagged checkpoint_revoked. Repeating it changes nothing. */
  async revokeCheckpoint(user: JwtPayload, id: number) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    return this.dataSource.transaction(async (manager) => {
      const current = await this.checkpointRow(actor, id, manager, true);
      if (current.revokedAt) return serializeCheckpoint(current);
      const [row] = await updateRows(manager,
        `UPDATE "patrol_checkpoints" SET "active" = false, "revokedAt" = now(), "revokedByUserId" = $2, "updatedByUserId" = $2, "updatedAt" = now()
          WHERE "id" = $1 RETURNING *`,
        [id, actor.userId],
      );
      await this.audit(manager, actor, 'patrol.checkpoint.revoked', 'patrol_checkpoint', id, serializeCheckpoint(current), serializeCheckpoint(row));
      return serializeCheckpoint(row);
    });
  }

  /**
   * The signed label payload to print as a QR code. Refused (503 PATROL_QR_SIGNING_KEY_UNAVAILABLE) when the server
   * has no PATROL_QR_SIGNING_KEY: an unsigned label could never be verified.
   */
  async checkpointLabel(user: JwtPayload, id: number) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    const row = await this.checkpointRow(actor, id);
    if (row.revokedAt || !row.active) {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.CHECKPOINT_REVOKED, 'Labels are only issued for active checkpoints.');
    }
    const keyring = patrolQrKeyring();
    const payload = signCheckpointLabel(row.publicId, Number(row.tokenVersion), keyring);
    if (!payload) {
      throw patrolError(
        HttpStatus.SERVICE_UNAVAILABLE,
        PatrolErrorCode.QR_SIGNING_KEY_UNAVAILABLE,
        'Checkpoint labels cannot be issued: the patrol label signing key is not configured on this server.',
      );
    }
    await this.auditLogService.log({
      company: { id: actor.companyId },
      user: { id: actor.userId },
      action: 'patrol.checkpoint.label_issued',
      entityType: 'patrol_checkpoint',
      entityId: Number(row.id),
      afterData: { tokenVersion: Number(row.tokenVersion), keyId: keyring.current!.keyId },
    });
    return {
      checkpointId: Number(row.id),
      siteId: Number(row.siteId),
      publicId: row.publicId,
      label: row.label,
      tokenVersion: Number(row.tokenVersion),
      keyId: keyring.current!.keyId,
      payload,
    };
  }

  // ── Routes ─────────────────────────────────────────────────────────────────────────────────────────

  async listRoutes(user: JwtPayload, query: PatrolListQueryDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const rows = await this.dataSource.query(
      `SELECT * FROM "patrol_routes" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2)
          AND ($3::boolean OR "archivedAt" IS NULL) ORDER BY "siteId", "name", "id"`,
      [actor.companyId, query.siteId ?? null, query.includeInactive === 'true'],
    );
    const out = [];
    for (const row of rows) out.push(serializeRoute(row, await this.routeCheckpoints(this.dataSource.manager, Number(row.id))));
    return out;
  }

  async getRoute(user: JwtPayload, id: number) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const row = await this.routeRow(actor, id);
    return serializeRoute(row, await this.routeCheckpoints(this.dataSource.manager, id));
  }

  async createRoute(user: JwtPayload, dto: CreatePatrolRouteDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    await this.assertSite(actor, dto.siteId);
    return this.dataSource.transaction(async (manager) => {
      await this.assertRouteCheckpoints(manager, actor, dto.siteId, dto.checkpoints);
      const [row] = await manager.query(
        `INSERT INTO "patrol_routes" ("companyId", "siteId", "name", "orderMode", "createdByUserId", "updatedByUserId")
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
        [actor.companyId, dto.siteId, dto.name.trim(), dto.orderMode ?? 'any', actor.userId],
      );
      await this.writeRouteCheckpoints(manager, actor, row, dto.checkpoints);
      const result = serializeRoute(row, await this.routeCheckpoints(manager, Number(row.id)));
      await this.audit(manager, actor, 'patrol.route.created', 'patrol_route', row.id, null, result);
      return result;
    });
  }

  async updateRoute(user: JwtPayload, id: number, dto: UpdatePatrolRouteDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    return this.dataSource.transaction(async (manager) => {
      const current = await this.routeRow(actor, id, manager, true);
      if (current.archivedAt) throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.VALIDATION, 'This route is archived.');
      const before = serializeRoute(current, await this.routeCheckpoints(manager, id));
      if (dto.checkpoints) await this.assertRouteCheckpoints(manager, actor, Number(current.siteId), dto.checkpoints);
      const [row] = await updateRows(manager,
        `UPDATE "patrol_routes" SET "name" = $2, "orderMode" = $3, "active" = $4, "updatedByUserId" = $5, "updatedAt" = now()
          WHERE "id" = $1 RETURNING *`,
        [id, dto.name !== undefined ? dto.name.trim() : current.name, dto.orderMode ?? current.orderMode, dto.active ?? current.active, actor.userId],
      );
      if (dto.checkpoints) {
        await manager.query(`DELETE FROM "patrol_route_checkpoints" WHERE "routeId" = $1`, [id]);
        await this.writeRouteCheckpoints(manager, actor, row, dto.checkpoints);
      }
      const after = serializeRoute(row, await this.routeCheckpoints(manager, id));
      await this.audit(manager, actor, 'patrol.route.updated', 'patrol_route', id, before, after);
      return after;
    });
  }

  async archiveRoute(user: JwtPayload, id: number) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    return this.dataSource.transaction(async (manager) => {
      const current = await this.routeRow(actor, id, manager, true);
      if (current.archivedAt) return serializeRoute(current, await this.routeCheckpoints(manager, id));
      const [row] = await updateRows(manager,
        `UPDATE "patrol_routes" SET "active" = false, "archivedAt" = now(), "updatedByUserId" = $2, "updatedAt" = now() WHERE "id" = $1 RETURNING *`,
        [id, actor.userId],
      );
      await this.audit(manager, actor, 'patrol.route.archived', 'patrol_route', id, { archivedAt: null }, { archivedAt: row.archivedAt });
      return serializeRoute(row, await this.routeCheckpoints(manager, id));
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────────────

  async routeCheckpoints(manager: EntityManager, routeId: number) {
    return manager.query(
      `SELECT rc."position", rc."required", rc."checkpointId", c."publicId", c."label", c."active", c."revokedAt"
         FROM "patrol_route_checkpoints" rc JOIN "patrol_checkpoints" c ON c."id" = rc."checkpointId"
        WHERE rc."routeId" = $1 ORDER BY rc."position"`,
      [routeId],
    );
  }

  private async writeRouteCheckpoints(manager: EntityManager, actor: PatrolCompanyActor, route: any, items: PatrolRouteCheckpointInput[]) {
    let position = 0;
    for (const item of items) {
      position += 1;
      await manager.query(
        `INSERT INTO "patrol_route_checkpoints" ("companyId", "siteId", "routeId", "checkpointId", "position", "required")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [actor.companyId, route.siteId, route.id, item.checkpointId, position, item.required ?? true],
      );
    }
  }

  /** Same company (else 404, as if it did not exist), same site, active and not revoked, no repeats. */
  private async assertRouteCheckpoints(manager: EntityManager, actor: PatrolCompanyActor, siteId: number, items: PatrolRouteCheckpointInput[]) {
    const ids = items.map((i) => i.checkpointId);
    if (new Set(ids).size !== ids.length) {
      throw patrolError(HttpStatus.UNPROCESSABLE_ENTITY, PatrolErrorCode.ROUTE_DUPLICATE_CHECKPOINT, 'A checkpoint can appear on a route only once.');
    }
    const rows = await manager.query(
      `SELECT "id", "siteId", "active", "revokedAt" FROM "patrol_checkpoints" WHERE "companyId" = $1 AND "id" = ANY($2::int[])`,
      [actor.companyId, ids],
    );
    if (rows.length !== ids.length) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Checkpoint not found.');
    const wrongSite = rows.filter((r: any) => Number(r.siteId) !== siteId).map((r: any) => Number(r.id));
    if (wrongSite.length) {
      throw patrolError(HttpStatus.UNPROCESSABLE_ENTITY, PatrolErrorCode.ROUTE_CHECKPOINT_WRONG_SITE,
        'Every checkpoint on a route must belong to the route\'s site.', { checkpointIds: wrongSite });
    }
    const unavailable = rows.filter((r: any) => r.revokedAt || !r.active).map((r: any) => Number(r.id));
    if (unavailable.length) {
      throw patrolError(HttpStatus.UNPROCESSABLE_ENTITY, PatrolErrorCode.ROUTE_CHECKPOINT_UNAVAILABLE,
        'Revoked or inactive checkpoints cannot be added to a route.', { checkpointIds: unavailable });
    }
  }

  private async assertRouteForSite(manager: EntityManager, actor: PatrolCompanyActor, routeId: number, siteId: number) {
    const [route] = await manager.query(`SELECT "id", "siteId", "archivedAt" FROM "patrol_routes" WHERE "id" = $1 AND "companyId" = $2`, [routeId, actor.companyId]);
    if (!route) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Route not found.');
    if (Number(route.siteId) !== siteId || route.archivedAt) {
      throw patrolError(HttpStatus.UNPROCESSABLE_ENTITY, PatrolErrorCode.ROUTE_NOT_FOR_SITE, 'The route must be an active route of the same site.');
    }
  }

  private assertScheduleValues(v: { windowMinutes: number; frequencyMinutes: number; startsOn: string | null; endsOn: string | null }) {
    if (v.frequencyMinutes < 15 || v.frequencyMinutes > 1440) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'frequencyMinutes must be between 15 and 1440.');
    }
    if (v.windowMinutes > v.frequencyMinutes) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'windowMinutes cannot be longer than frequencyMinutes.');
    }
    if (v.startsOn && v.endsOn && v.endsOn < v.startsOn) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'endsOn cannot be before startsOn.');
    }
  }

  private rejectCheckpointLocation(dto: { latitude?: unknown; longitude?: unknown; proximityMeters?: unknown }) {
    if ([dto.latitude, dto.longitude, dto.proximityMeters].some((v) => v !== undefined && v !== null)) {
      throw patrolError(
        HttpStatus.BAD_REQUEST,
        PatrolErrorCode.LOCATION_VERIFICATION_DISABLED,
        'Checkpoint locations are not accepted while location-based patrol verification is disabled.',
      );
    }
  }

  private async assertSite(actor: PatrolCompanyActor, siteId: number) {
    const [site] = await this.dataSource.query(`SELECT "id" FROM "sites" WHERE "id" = $1 AND "companyId" = $2`, [siteId, actor.companyId]);
    if (!site) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.SITE_NOT_FOUND, 'Site not found.');
  }

  private async scheduleRow(actor: PatrolCompanyActor, id: number, manager?: EntityManager, lock = false) {
    const [row] = await (manager ?? this.dataSource).query(
      `SELECT * FROM "patrol_schedules" WHERE "id" = $1 AND "companyId" = $2${lock ? ' FOR UPDATE' : ''}`,
      [id, actor.companyId],
    );
    if (!row) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Schedule not found.');
    return row;
  }

  private async checkpointRow(actor: PatrolCompanyActor, id: number, manager?: EntityManager, lock = false) {
    const [row] = await (manager ?? this.dataSource).query(
      `SELECT * FROM "patrol_checkpoints" WHERE "id" = $1 AND "companyId" = $2${lock ? ' FOR UPDATE' : ''}`,
      [id, actor.companyId],
    );
    if (!row) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Checkpoint not found.');
    return row;
  }

  private async routeRow(actor: PatrolCompanyActor, id: number, manager?: EntityManager, lock = false) {
    const [row] = await (manager ?? this.dataSource).query(
      `SELECT * FROM "patrol_routes" WHERE "id" = $1 AND "companyId" = $2${lock ? ' FOR UPDATE' : ''}`,
      [id, actor.companyId],
    );
    if (!row) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Route not found.');
    return row;
  }

  private audit(manager: EntityManager, actor: PatrolCompanyActor, action: string, entityType: string, entityId: number,
    beforeData: Record<string, unknown> | null, afterData: Record<string, unknown> | null) {
    return this.auditLogService.logInTransaction(manager, {
      company: { id: actor.companyId },
      user: { id: actor.userId },
      action,
      entityType,
      entityId: Number(entityId),
      beforeData,
      afterData,
    });
  }
}

function stripSource(policy: EffectivePolicy): PolicyFields {
  const { source: _source, ...fields } = policy;
  return fields;
}

function dateText(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}
