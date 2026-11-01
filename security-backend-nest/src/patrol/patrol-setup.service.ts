import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { ConfirmPatrolCheckpointDto, PutPatrolSiteSetupDto } from './dto/patrol.dto';
import { PatrolAccessService, PatrolCompanyActor } from './patrol-access.service';
import { lockPatrolSite, PatrolConfigService } from './patrol-config.service';
import {
  PatrolErrorCode,
  PatrolEvidenceMode,
  PatrolSetupMode,
  PatrolWindowAnchor,
  patrolError,
} from './patrol-constants';
import { checkLabelSignature, parseCheckpointLabel, patrolQrKeyring } from './patrol-qr';
import { routeHead, routeVersionLinks, sameRouteChain } from './patrol-route-versions';
import { PATROL_SCHEDULE_SUPERSEDED_ACTION } from './patrol-schedule-versions';
import { checkpointConfirmed, serializeCheckpoint, serializePolicyFields, serializeSchedule, updateRows } from './patrol-serializers';
import { PATROL_SETUP_UPDATED_ACTION, setupActive, siteSetupOf } from './patrol-shift-windows';
import { PatrolObjectStore } from './evidence/patrol-object-store';

/** How a stored shift-anchored schedule row looks to the 1.2.1 clock engine: no window, ever (inactive, one past day). */
export const SHIFT_SCHEDULE_INERT_DATE = '2000-01-01';
export const SHIFT_SCHEDULE_NAME = 'Shift patrol';

/** The policy methods / photosPerRun an evidence mode is stored as (no new column; photos stay yes / no). */
export function evidenceModePolicy(mode: PatrolEvidenceMode): { methods: string[]; photosPerRun: number } {
  if (mode === 'photo') return { methods: ['photo'], photosPerRun: 1 };
  if (mode === 'qr_photo') return { methods: ['qr', 'photo'], photosPerRun: 1 };
  return { methods: ['qr'], photosPerRun: 0 };
}

/** The evidence mode a policy amounts to (a QR policy that asks for a run photo is QR + photos). */
export function evidenceModeOf(policy: { methods?: readonly string[] | null; photosPerRun?: number | null }): PatrolEvidenceMode {
  const methods = policy.methods ?? ['qr'];
  const qr = methods.includes('qr');
  const photo = methods.includes('photo') || Number(policy.photosPerRun ?? 0) > 0;
  if (qr && photo) return 'qr_photo';
  if (qr) return 'qr';
  return 'photo';
}

export type SetupChecklistItem = { code: string; ok: boolean; text: string };
export type TestScanReason =
  | 'malformed_payload' | 'signing_key_unavailable' | 'unknown_signing_key' | 'tampered_signature' | 'unknown_checkpoint'
  | 'wrong_site' | 'wrong_checkpoint' | 'stale_label' | 'invalid_label_version';

const TEST_SCAN_TEXT: Record<TestScanReason, string> = {
  malformed_payload: 'That is not an S4 checkpoint label.',
  signing_key_unavailable: 'Labels cannot be checked: the patrol label signing key is not configured on this server.',
  unknown_signing_key: 'The label was signed with a key this server does not hold.',
  tampered_signature: 'The label\'s signature does not match: it may have been altered.',
  unknown_checkpoint: 'The label does not belong to any checkpoint of this company.',
  wrong_site: 'The label belongs to a checkpoint at another site.',
  wrong_checkpoint: 'The label belongs to another checkpoint of this site.',
  stale_label: 'This is an old label: the checkpoint\'s labels were reprinted. Scan the current label.',
  invalid_label_version: 'The label version is newer than this checkpoint has ever issued.',
};

/**
 * S4 1.3.0 B1 site patrol setup (owner decisions 1–5): one view and one save per site, activation, and the checkpoint
 * test scan. Company accounts; reads need patrols.view, writes patrols.manage; every write is one transaction with its
 * audit entries, under the site's setup lock (PATROL_SITE_SETUP_LOCK_NAMESPACE).
 *
 *   GET  /patrols/sites/:siteId/setup           the setup, its checkpoints (confirmed or not), the route version in
 *                                               force, a checklist and warnings
 *   PUT  /patrols/sites/:siteId/setup           policy (setupMode, windowAnchor, evidence mode as methods / photosPerRun)
 *                                               + the site's shift-anchored schedule (a frequency change after it could
 *                                               have had windows = a successor, Migration 73) + the automatic route
 *                                               version, in ONE transaction. Saving never activates.
 *   POST /patrols/sites/:siteId/setup/confirm   activation: 422 PATROL_SETUP_INCOMPLETE with the checklist unless complete;
 *                                               the automatic route version in force is frozen (brought up to date first)
 *   POST /patrols/checkpoints/:id/confirm       an authorised test scan of the checkpoint's CURRENT signed label
 */
@Injectable()
export class PatrolSetupService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: PatrolAccessService,
    private readonly config: PatrolConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly store: PatrolObjectStore,
  ) {}

  async getSetup(user: JwtPayload, siteId: number) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    await this.assertSite(actor, siteId);
    return this.view(this.dataSource.manager, actor, siteId);
  }

  async putSetup(user: JwtPayload, siteId: number, dto: PutPatrolSiteSetupDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    await this.assertSite(actor, siteId);
    const setupMode = dto.setupMode as PatrolSetupMode;
    const evidenceMode = dto.evidenceMode as PatrolEvidenceMode;
    const windowAnchor = (dto.windowAnchor ?? 'scheduled_start') as PatrolWindowAnchor;
    const frequency = dto.frequencyMinutes;
    return this.dataSource.transaction(async (manager) => {
      await lockPatrolSite(manager, siteId);
      const policyRow = await this.sitePolicyRow(manager, actor, siteId);
      const before = await this.summary(manager, actor, siteId, policyRow);

      // 1. Policy: the setup columns and the evidence mode (no per-checkpoint photos; photos stay yes / no).
      const evidence = evidenceModePolicy(evidenceMode);
      const [policy] = await updateRows(manager,
        `UPDATE "patrol_policies" SET "setupMode" = $2, "windowAnchor" = $3, "methods" = $4::jsonb, "photosPerRun" = $5, "photosPerCheckpoint" = 0,
            "updatedByUserId" = $6, "updatedAt" = now() WHERE "id" = $1 RETURNING *`,
        [policyRow.id, setupMode, windowAnchor, JSON.stringify(evidence.methods), evidence.photosPerRun, actor.userId],
      );

      // 2. The route patrols follow: a chosen custom route, or the automatic route (its current version).
      let routeId: number | null = null;
      if (evidence.methods.includes('qr')) {
        if (dto.routeId != null) {
          const [route] = await manager.query(`SELECT * FROM "patrol_routes" WHERE "id" = $1 AND "companyId" = $2`, [dto.routeId, actor.companyId]);
          if (!route) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Route not found.');
          if (Number(route.siteId) !== siteId || route.archivedAt || route.kind === 'auto') {
            throw patrolError(HttpStatus.UNPROCESSABLE_ENTITY, PatrolErrorCode.ROUTE_NOT_FOR_SITE,
              'Choose a current route of this site (or leave the route empty for every confirmed checkpoint).');
          }
          routeId = Number(route.id);
        } else {
          const auto = await this.config.syncAutoRoute(manager, actor, siteId, 'setup_saved', true);
          routeId = auto ? Number(auto.id) : null;
        }
      }

      // 3. The site's shift-anchored schedule.
      const schedule = await this.saveShiftSchedule(manager, actor, siteId, frequency, routeId, policy, setupMode);

      const after = await this.summary(manager, actor, siteId, policy);
      const requirementChanged = (before.setupMode ?? null) !== setupMode || before.windowAnchor !== windowAnchor;
      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: PATROL_SETUP_UPDATED_ACTION,
        entityType: 'patrol_policy',
        entityId: Number(policy.id),
        beforeData: { siteId, ...before },
        afterData: { siteId, ...after, scheduleId: schedule ? Number(schedule.id) : null, requirementChanged },
      });
      return this.view(manager, actor, siteId);
    });
  }

  async confirmSetup(user: JwtPayload, siteId: number) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    await this.assertSite(actor, siteId);
    return this.dataSource.transaction(async (manager) => {
      await lockPatrolSite(manager, siteId);
      const [policyRow] = await manager.query(
        `SELECT * FROM "patrol_policies" WHERE "companyId" = $1 AND "siteId" = $2 FOR UPDATE`, [actor.companyId, siteId],
      );
      // "Freeze" the automatic route: bring it up to the current confirmed set before the checklist reads it.
      const evidenceMode = evidenceModeOf(await this.config.effectivePolicy(actor.companyId, siteId, manager));
      const schedule = await this.currentShiftSchedule(manager, actor, siteId);
      const links = await routeVersionLinks(manager, actor.companyId);
      const scheduleRoute = await this.routeRowById(manager, routeHead(links, schedule?.routeId == null ? null : Number(schedule.routeId)));
      if (evidenceMode !== 'photo' && (!scheduleRoute || scheduleRoute.kind === 'auto')) {
        await this.config.syncAutoRoute(manager, actor, siteId, 'setup_confirmed', true);
      }
      const view = await this.view(manager, actor, siteId);
      const failed = view.checklist.filter((c) => !c.ok);
      if (!policyRow || failed.length) {
        throw patrolError(HttpStatus.UNPROCESSABLE_ENTITY, PatrolErrorCode.SETUP_INCOMPLETE,
          `The patrol setup of this site is not complete: ${failed.map((c) => c.text).join(' ')}`.trim(), { checklist: view.checklist });
      }
      if (policyRow.setupConfirmedAt) return view; // already active: nothing changes (activation is not re-dated)
      const [confirmed] = await updateRows(manager,
        `UPDATE "patrol_policies" SET "setupConfirmedAt" = now(), "setupConfirmedByUserId" = $2, "updatedAt" = now() WHERE "id" = $1 RETURNING *`,
        [policyRow.id, actor.userId],
      );
      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: 'patrol.setup.confirmed',
        entityType: 'patrol_policy',
        entityId: Number(policyRow.id),
        beforeData: { siteId, setupConfirmedAt: null },
        afterData: {
          siteId, setupConfirmedAt: new Date(confirmed.setupConfirmedAt).toISOString(), setupMode: view.setupMode, evidenceMode: view.evidenceMode,
          frequencyMinutes: view.frequencyMinutes, windowAnchor: view.windowAnchor, scheduleId: view.schedule?.id ?? null,
          routeId: view.route?.currentVersion?.id ?? null, routeMode: view.route?.mode ?? 'none',
          checkpointIds: view.route?.currentVersion?.checkpoints.map((c: any) => c.checkpointId) ?? [],
        },
      });
      return this.view(manager, actor, siteId);
    });
  }

  // ── Checkpoint test scan ──────────────────────────────────────────────────────────────────────────

  /**
   * Owner decision 2: a person with patrols.manage scans the printed label at the checkpoint and sends the payload. The
   * server checks it exactly as a patrol scan is checked (patrol-qr.ts: format, signature and key id), plus that the label
   * is THIS checkpoint's (publicId) at its site, its CURRENT version (tokenVersion), and that the checkpoint is not revoked.
   * Accepted: confirmedAt / confirmedByUserId / confirmedTokenVersion are recorded (audited patrol.checkpoint.confirmed)
   * and the site's automatic route gets a new version that includes it. Refused: 422 PATROL_CHECKPOINT_TEST_SCAN_INVALID
   * (details.reason) or 409 PATROL_CHECKPOINT_REVOKED — audited patrol.checkpoint.test_scan_rejected, nothing changed.
   * Repeating an accepted scan of the same version changes nothing.
   */
  async confirmCheckpoint(user: JwtPayload, id: number, dto: ConfirmPatrolCheckpointDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_MANAGE);
    const [checkpoint] = await this.dataSource.query(`SELECT * FROM "patrol_checkpoints" WHERE "id" = $1 AND "companyId" = $2`, [id, actor.companyId]);
    if (!checkpoint) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Checkpoint not found.');
    const parsed = parseCheckpointLabel(dto.scanPayload);
    const reject = async (reason: TestScanReason | 'checkpoint_revoked') => {
      await this.auditLogService.log({
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: 'patrol.checkpoint.test_scan_rejected',
        entityType: 'patrol_checkpoint',
        entityId: Number(checkpoint.id),
        afterData: {
          reason, siteId: Number(checkpoint.siteId), scannedPublicId: parsed?.publicId ?? null, scannedTokenVersion: parsed?.tokenVersion ?? null,
          scannedKeyId: parsed?.keyId ?? null, currentTokenVersion: Number(checkpoint.tokenVersion),
        },
      });
      if (reason === 'checkpoint_revoked') {
        return patrolError(HttpStatus.CONFLICT, PatrolErrorCode.CHECKPOINT_REVOKED, 'This checkpoint is revoked or switched off; it cannot be confirmed.', { reason });
      }
      return patrolError(HttpStatus.UNPROCESSABLE_ENTITY, PatrolErrorCode.CHECKPOINT_TEST_SCAN_INVALID, TEST_SCAN_TEXT[reason], { reason });
    };
    if (checkpoint.revokedAt || !checkpoint.active) throw await reject('checkpoint_revoked');
    const reason = await this.testScanProblem(actor, checkpoint, parsed, dto.siteId ?? null);
    if (reason) throw await reject(reason);

    const result = await this.dataSource.transaction(async (manager) => {
      const current = await this.config.lockedCheckpoint(manager, actor, id);
      // Re-checked under the lock: a rotation or revocation may have committed since the checks above.
      if (current.revokedAt || !current.active) return { error: 'checkpoint_revoked' as const };
      if (Number(current.tokenVersion) !== parsed!.tokenVersion) return { error: (parsed!.tokenVersion < Number(current.tokenVersion) ? 'stale_label' : 'invalid_label_version') as TestScanReason };
      if (checkpointConfirmed(current)) {
        const auto = await this.config.syncAutoRoute(manager, actor, Number(current.siteId), 'checkpoint_confirmed');
        return { row: current, autoRouteId: auto ? Number(auto.id) : null, repeated: true };
      }
      const [row] = await updateRows(manager,
        `UPDATE "patrol_checkpoints" SET "confirmedAt" = now(), "confirmedByUserId" = $2, "confirmedTokenVersion" = $3, "updatedAt" = now()
          WHERE "id" = $1 RETURNING *`,
        [id, actor.userId, parsed!.tokenVersion],
      );
      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: 'patrol.checkpoint.confirmed',
        entityType: 'patrol_checkpoint',
        entityId: id,
        beforeData: { confirmedAt: current.confirmedAt ? new Date(current.confirmedAt).toISOString() : null, confirmedTokenVersion: current.confirmedTokenVersion == null ? null : Number(current.confirmedTokenVersion) },
        afterData: {
          siteId: Number(row.siteId), confirmedAt: new Date(row.confirmedAt).toISOString(), confirmedTokenVersion: Number(row.confirmedTokenVersion),
          keyId: parsed!.keyId, publicId: row.publicId,
        },
      });
      const auto = await this.config.syncAutoRoute(manager, actor, Number(row.siteId), 'checkpoint_confirmed');
      return { row, autoRouteId: auto ? Number(auto.id) : null, repeated: false };
    });
    if ('error' in result) throw await reject(result.error as TestScanReason | 'checkpoint_revoked');
    return { checkpoint: serializeCheckpoint(result.row), automaticRouteId: result.autoRouteId, alreadyConfirmed: result.repeated };
  }

  private async testScanProblem(actor: PatrolCompanyActor, checkpoint: any, parsed: ReturnType<typeof parseCheckpointLabel>, siteId: number | null): Promise<TestScanReason | null> {
    if (!parsed) return 'malformed_payload';
    const signature = checkLabelSignature(parsed, patrolQrKeyring());
    if (signature === 'no_key') return 'signing_key_unavailable';
    if (signature === 'unknown_key') return 'unknown_signing_key';
    if (signature === 'invalid') return 'tampered_signature';
    if (siteId != null && siteId !== Number(checkpoint.siteId)) return 'wrong_site';
    if (parsed.publicId !== checkpoint.publicId) {
      const [owner] = await this.dataSource.query(`SELECT "siteId" FROM "patrol_checkpoints" WHERE "publicId" = $1 AND "companyId" = $2`, [parsed.publicId, actor.companyId]);
      if (!owner) return 'unknown_checkpoint';
      return Number(owner.siteId) !== Number(checkpoint.siteId) ? 'wrong_site' : 'wrong_checkpoint';
    }
    if (parsed.tokenVersion < Number(checkpoint.tokenVersion)) return 'stale_label';
    if (parsed.tokenVersion > Number(checkpoint.tokenVersion)) return 'invalid_label_version';
    return null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────

  /** The site's own policy row, locked; created with the inherited values when the site has none. */
  private async sitePolicyRow(manager: EntityManager, actor: PatrolCompanyActor, siteId: number) {
    const find = async () => (await manager.query(
      `SELECT * FROM "patrol_policies" WHERE "companyId" = $1 AND "siteId" = $2 FOR UPDATE`, [actor.companyId, siteId],
    ))[0];
    let row = await find();
    if (row) return row;
    const inherited = await this.config.effectivePolicy(actor.companyId, null, manager);
    await manager.query(
      `INSERT INTO "patrol_policies" ("companyId", "siteId", "updatedByUserId", "methods", "photosPerRun", "photosPerCheckpoint", "orderMode",
          "startGraceMinutes", "maxPatrolDurationMinutes", "completionGraceMinutes", "syncGraceMinutes", "requirementScope", "retentionDays",
          "incompleteNeedsAction", "postShiftSyncHours", "clockDriftThresholdMinutes", "allowUnscheduledPatrols", "escalateUnverified")
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) ON CONFLICT DO NOTHING`,
      [actor.companyId, siteId, actor.userId, JSON.stringify(inherited.methods), inherited.photosPerRun, inherited.photosPerCheckpoint, inherited.orderMode,
        inherited.startGraceMinutes, inherited.maxPatrolDurationMinutes, inherited.completionGraceMinutes, inherited.syncGraceMinutes,
        inherited.requirementScope, inherited.retentionDays, inherited.incompleteNeedsAction, inherited.postShiftSyncHours,
        inherited.clockDriftThresholdMinutes, inherited.allowUnscheduledPatrols, inherited.escalateUnverified],
    );
    row = await find();
    return row;
  }

  private async currentShiftSchedule(runner: { query: EntityManager['query'] }, actor: PatrolCompanyActor, siteId: number, lock = false) {
    const [row] = await runner.query(
      `SELECT * FROM "patrol_schedules" WHERE "companyId" = $1 AND "siteId" = $2 AND "anchor" = 'shift' AND "archivedAt" IS NULL
        ORDER BY "id" DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [actor.companyId, siteId],
    );
    return row ?? null;
  }

  /**
   * The site's shift-anchored schedule (one current row per site). Stored inactive with startsOn = endsOn = 2000-01-01 so
   * the 1.2.1 clock engine yields no window for it after a code rollback; 1.3.0 reads it by anchor. A frequency change is
   * a timing change (Migration 73): in place only while it can never have had a window (the setup was never activated,
   * and no run or exception names it, and it is not itself a successor); otherwise the current version is archived and
   * linked to a successor with a new id, so every window belongs to the version in force at its start. A route switch
   * (automatic ↔ chosen route) is applied in place, as for clock schedules; a newer version of the same route is not a
   * change (the schedule keeps the id it was given).
   */
  private async saveShiftSchedule(manager: EntityManager, actor: PatrolCompanyActor, siteId: number, frequency: number, routeId: number | null, policy: any, setupMode: PatrolSetupMode) {
    const current = await this.currentShiftSchedule(manager, actor, siteId, true);
    if (!current) {
      if (setupMode === 'off') return null;
      const [row] = await manager.query(
        `INSERT INTO "patrol_schedules" ("companyId", "siteId", "routeId", "name", "daysOfWeek", "activeFrom", "activeTo", "frequencyMinutes",
            "windowMinutes", "startsOn", "endsOn", "active", "anchor", "createdByUserId", "updatedByUserId")
         VALUES ($1, $2, $3, $4, '[1, 2, 3, 4, 5, 6, 7]'::jsonb, '00:00', '00:00', $5, $5, $6, $6, false, 'shift', $7, $7) RETURNING *`,
        [actor.companyId, siteId, routeId, SHIFT_SCHEDULE_NAME, frequency, SHIFT_SCHEDULE_INERT_DATE, actor.userId],
      );
      await this.audit(manager, actor, 'patrol.schedule.created', 'patrol_schedule', Number(row.id), null, { ...serializeSchedule(row), managedBy: 'site_setup' });
      return row;
    }
    const links = await routeVersionLinks(manager, actor.companyId);
    const currentRoute = current.routeId == null ? null : Number(current.routeId);
    const routeChanged = !(currentRoute === routeId || (currentRoute != null && routeId != null && sameRouteChain(links, currentRoute, routeId)));
    const timingChanged = Number(current.frequencyMinutes) !== frequency;
    if (!timingChanged && !routeChanged) return current;
    const nextRoute = routeChanged ? routeId : currentRoute;
    if (timingChanged && (policy.setupConfirmedAt != null || await this.scheduleHistory(manager, Number(current.id)))) {
      const [successor] = await manager.query(
        `INSERT INTO "patrol_schedules" ("companyId", "siteId", "routeId", "name", "daysOfWeek", "activeFrom", "activeTo", "frequencyMinutes",
            "windowMinutes", "startsOn", "endsOn", "active", "anchor", "createdByUserId", "updatedByUserId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, '[1, 2, 3, 4, 5, 6, 7]'::jsonb, '00:00', '00:00', $5, $5, $6, $6, false, 'shift', $7, $7, now(), now()) RETURNING *`,
        [actor.companyId, siteId, nextRoute, current.name, frequency, SHIFT_SCHEDULE_INERT_DATE, actor.userId],
      );
      // As Migration 73: the predecessor's updatedAt (its judging floor) is left as it was.
      const [archived] = await updateRows(manager,
        `UPDATE "patrol_schedules" SET "active" = false, "archivedAt" = $3, "supersededByScheduleId" = $4, "supersededAt" = $3, "updatedByUserId" = $2
          WHERE "id" = $1 AND "archivedAt" IS NULL AND "supersededByScheduleId" IS NULL RETURNING *`,
        [Number(current.id), actor.userId, successor.createdAt, Number(successor.id)],
      );
      if (!archived) throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.VALIDATION, 'The site\'s shift patrol schedule changed meanwhile. Reload the setup and try again.');
      const effectiveAt = new Date(successor.createdAt).toISOString();
      await this.audit(manager, actor, PATROL_SCHEDULE_SUPERSEDED_ACTION, 'patrol_schedule', Number(current.id), serializeSchedule(current), {
        ...serializeSchedule(archived), successorId: Number(successor.id), effectiveAt, reason: 'timing_changed', managedBy: 'site_setup',
      });
      await this.audit(manager, actor, 'patrol.schedule.created', 'patrol_schedule', Number(successor.id), null, {
        ...serializeSchedule(successor), predecessorId: Number(current.id), effectiveAt, managedBy: 'site_setup',
      });
      return successor;
    }
    const [row] = await updateRows(manager,
      `UPDATE "patrol_schedules" SET "frequencyMinutes" = $2, "windowMinutes" = $2, "routeId" = $3, "updatedByUserId" = $4, "updatedAt" = now()
        WHERE "id" = $1 RETURNING *`,
      [Number(current.id), frequency, nextRoute, actor.userId],
    );
    await this.audit(manager, actor, 'patrol.schedule.updated', 'patrol_schedule', Number(current.id), serializeSchedule(current), { ...serializeSchedule(row), managedBy: 'site_setup' });
    return row;
  }

  private async scheduleHistory(manager: EntityManager, id: number): Promise<boolean> {
    const [refs] = await manager.query(
      `SELECT EXISTS (SELECT 1 FROM "patrol_runs" WHERE "scheduleId" = $1) AS "runs",
              EXISTS (SELECT 1 FROM "patrol_exceptions" WHERE "scheduleId" = $1) AS "exceptions",
              EXISTS (SELECT 1 FROM "patrol_schedules" WHERE "supersededByScheduleId" = $1) AS "successor"`,
      [id],
    );
    return Boolean(refs.runs || refs.exceptions || refs.successor);
  }

  private async summary(manager: EntityManager, actor: PatrolCompanyActor, siteId: number, policyRow: any) {
    const setup = siteSetupOf(policyRow);
    const schedule = await this.currentShiftSchedule(manager, actor, siteId);
    return {
      setupMode: setup.setupMode,
      windowAnchor: setup.windowAnchor,
      evidenceMode: evidenceModeOf({ methods: policyRow.methods, photosPerRun: Number(policyRow.photosPerRun) }),
      frequencyMinutes: schedule ? Number(schedule.frequencyMinutes) : null,
      routeId: schedule?.routeId == null ? null : Number(schedule.routeId),
      setupConfirmedAt: setup.setupConfirmedAt ? setup.setupConfirmedAt.toISOString() : null,
    };
  }

  private async routeRowById(runner: { query: EntityManager['query'] }, id: number | null) {
    if (id == null) return null;
    const [row] = await runner.query(`SELECT * FROM "patrol_routes" WHERE "id" = $1`, [id]);
    return row ?? null;
  }

  /** The one setup view (GET, and the answer to every write). */
  async view(runner: EntityManager, actor: PatrolCompanyActor, siteId: number) {
    const [site] = await runner.query(`SELECT "id", "name", "timezone" FROM "sites" WHERE "id" = $1 AND "companyId" = $2`, [siteId, actor.companyId]);
    const [policyRow] = await runner.query(`SELECT * FROM "patrol_policies" WHERE "companyId" = $1 AND "siteId" = $2`, [actor.companyId, siteId]);
    const effective = await this.config.effectivePolicy(actor.companyId, siteId, runner);
    const setup = siteSetupOf(policyRow);
    const evidenceMode = evidenceModeOf(effective);
    const schedule = await this.currentShiftSchedule(runner, actor, siteId);
    const links = await routeVersionLinks(runner, actor.companyId);
    const headId = routeHead(links, schedule?.routeId == null ? null : Number(schedule.routeId));
    const route = await this.routeRowById(runner, headId);
    const routeItems = route ? await this.config.routeCheckpoints(runner, Number(route.id)) : [];
    const versions = route ? [...links.values()].filter((l) => sameRouteChain(links, Number(schedule!.routeId), l.successorId)).length + 1 : 0;
    const checkpoints = await runner.query(
      `SELECT * FROM "patrol_checkpoints" WHERE "companyId" = $1 AND "siteId" = $2 AND "revokedAt" IS NULL ORDER BY "label", "id"`,
      [actor.companyId, siteId],
    );
    const onRoute = new Set(routeItems.map((c: any) => Number(c.checkpointId)));
    const confirmedCount = checkpoints.filter(checkpointConfirmed).length;
    const qr = evidenceMode !== 'photo';
    const routeMode: 'auto' | 'custom' | 'none' = !qr || !route ? 'none' : route.kind === 'auto' ? 'auto' : 'custom';
    const requiredOnRoute = routeItems.filter((c: any) => c.required && c.active && !c.revokedAt).length;

    const checklist: SetupChecklistItem[] = [
      {
        code: 'setup_mode',
        ok: setup.setupMode === 'every_shift' || setup.setupMode === 'per_shift',
        text: setup.setupMode === 'off'
          ? 'Patrols are switched off for this site: choose every shift, or only shifts marked as requiring patrols.'
          : 'Choose which shifts patrol: every shift, or only shifts marked as requiring patrols.',
      },
      { code: 'frequency', ok: schedule != null, text: 'Set how often a patrol is due during a shift.' },
    ];
    if (qr && routeMode !== 'custom') {
      checklist.push({ code: 'confirmed_checkpoints', ok: confirmedCount > 0,
        text: 'Site setup incomplete: no confirmed checkpoints. Test-scan at least one printed checkpoint label.' });
    }
    if (qr && routeMode === 'custom') {
      checklist.push({ code: 'route_checkpoints', ok: requiredOnRoute > 0, text: 'The chosen route has no required, active checkpoint.' });
    }
    const warnings: Array<{ code: string; message: string }> = [];
    const unconfirmed = checkpoints.filter((c: any) => c.active && !checkpointConfirmed(c));
    if (qr && unconfirmed.length) {
      warnings.push({
        code: 'CHECKPOINTS_NOT_CONFIRMED',
        message: `${unconfirmed.length} checkpoint${unconfirmed.length === 1 ? ' has' : 's have'} not been test-scanned${routeMode === 'auto' ? ' and ' + (unconfirmed.length === 1 ? 'is' : 'are') + ' not part of the automatic route' : ''}: ${unconfirmed.map((c: any) => c.label).join(', ')}.`,
      });
    }
    if (qr && !patrolQrKeyring().current) {
      warnings.push({ code: 'QR_SIGNING_KEY_UNAVAILABLE', message: 'Checkpoint labels cannot be printed or test-scanned: the label signing key is not configured on this server.' });
    }
    if (evidenceMode !== 'qr' && !this.store.available()) {
      warnings.push({ code: 'EVIDENCE_STORAGE_UNAVAILABLE', message: 'Photo evidence storage is not configured on this server: photos cannot be verified.' });
    }
    if (!setup.setupConfirmedAt && setup.setupMode && setup.setupMode !== 'off') {
      warnings.push({ code: 'SETUP_NOT_ACTIVE', message: 'Saved but not active: confirm the setup to start shift patrols.' });
    }
    return {
      siteId,
      siteName: site?.name ?? null,
      timezone: site?.timezone ?? null,
      setupMode: setup.setupMode,
      evidenceMode,
      frequencyMinutes: schedule ? Number(schedule.frequencyMinutes) : null,
      windowAnchor: setup.windowAnchor,
      active: setupActive(setup),
      confirmedAt: setup.setupConfirmedAt ? setup.setupConfirmedAt.toISOString() : null,
      confirmedByUserId: setup.setupConfirmedByUserId,
      policy: { ...serializePolicyFields(effective), source: effective.source },
      schedule: schedule ? serializeSchedule(schedule) : null,
      route: qr ? {
        mode: routeMode,
        scheduleRouteId: schedule?.routeId == null ? null : Number(schedule.routeId),
        versions,
        currentVersion: route ? {
          id: Number(route.id),
          kind: route.kind,
          name: route.name,
          createdAt: new Date(route.createdAt).toISOString(),
          checkpoints: routeItems.map((c: any) => ({ checkpointId: Number(c.checkpointId), label: c.label, required: Boolean(c.required), position: Number(c.position) })),
        } : null,
      } : null,
      checkpoints: checkpoints.map((c: any) => ({ ...serializeCheckpoint(c), onCurrentRoute: onRoute.has(Number(c.id)) })),
      checklist,
      ready: checklist.every((c) => c.ok),
      warnings,
    };
  }

  private async assertSite(actor: PatrolCompanyActor, siteId: number) {
    const [site] = await this.dataSource.query(`SELECT "id" FROM "sites" WHERE "id" = $1 AND "companyId" = $2`, [siteId, actor.companyId]);
    if (!site) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.SITE_NOT_FOUND, 'Site not found.');
  }

  private audit(manager: EntityManager, actor: PatrolCompanyActor, action: string, entityType: string, entityId: number,
    beforeData: Record<string, unknown> | null, afterData: Record<string, unknown> | null) {
    return this.auditLogService.logInTransaction(manager, {
      company: { id: actor.companyId }, user: { id: actor.userId }, action, entityType, entityId, beforeData, afterData,
    });
  }
}
