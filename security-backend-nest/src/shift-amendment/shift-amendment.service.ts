import { BadRequestException, ForbiddenException, HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AttendanceEventType } from '../attendance/entities/attendance.entity';
import { AvailabilityService } from '../availability/availability.service';
import { assertNoShiftClash } from '../availability/shift-clash';
import { CompanyGuardService } from '../company-guard/company-guard.service';
import { hasExplicitUtcOffset } from '../common/site-time';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyMembershipRole, CompanyMembershipStatus, CompanyPermission } from '../company-membership/company-membership-types';
import { ComplianceService } from '../compliance/compliance.service';
import { TransactionalEmailService } from '../email/transactional-email.service';
import { GuardNotificationService } from '../guard-notification/guard-notification.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { NotificationStatus, NotificationType } from '../notification/entities/notification.entity';
import { WELFARE_SWEEP_LOCK_NAMESPACE, lockGuardsForAssignment } from '../operations/advisory-locks';
import { SingleFlightJob } from '../scheduler/single-flight-job';
import { UserRole } from '../user/entities/user.entity';
import { CompanyShiftPolicy } from './entities/company-shift-policy.entity';
import { ShiftAmendment } from './entities/shift-amendment.entity';
import {
  AMENDMENT_ERROR_CODES as E,
  AmendmentAction,
  AmendmentStatus,
  ConfirmationEmailStatus,
  DEFAULT_SHIFT_POLICY,
  FatigueAssessment,
  OPEN_AMENDMENT_STATUSES,
  ShiftPolicyValues,
  amendmentError,
  assessFatigue,
  mayPerformAmendmentAction,
  platformSafetyViolations,
  toDbTimestamp,
  withinPlatformSafety,
} from './shift-amendment-policy';
import {
  ApproveAmendmentDto,
  DisputeAmendmentDto,
  ProposeAmendmentDto,
  RecordVerbalAgreementDto,
  ResolveDisputeDto,
  RespondAmendmentDto,
  UpdateShiftPolicyDto,
  WithdrawAmendmentDto,
} from './dto/shift-amendment.dto';


/** How often lapsed proposals are marked expired. Acceptance never depends on it: it re-checks the clock itself. */
export const AMENDMENT_EXPIRY_INTERVAL_MS = 60_000;
/** A lock wait longer than this is a retryable 409 SHIFT_AMENDMENT_BUSY, never a hung request. */
export const AMENDMENT_LOCK_TIMEOUT = '5s';
/** Tolerance for a staff member's stated contact time running slightly ahead of the server clock. */
const CONTACT_TIME_SKEW_MS = 2 * 60_000;

type ShiftRow = {
  id: number;
  companyId: number;
  guardId: number | null;
  status: string;
  startMs: number;
  endMs: number;
  originalEndMs: number | null;
};

type AmendmentRow = {
  id: number;
  shiftId: number;
  companyId: number;
  guardId: number;
  sequence: number;
  status: AmendmentStatus;
  responseMethod: string | null;
  proposedByUserId: number;
  approvalRequired: boolean;
  originalEndMs: number;
  previousEndMs: number;
  proposedEndMs: number;
  proposedAtMs: number;
  expiresAtMs: number;
};

type CompanyActor = { companyId: number; userId: number; role: CompanyMembershipRole; canAmendShifts: boolean };

/** A refusal decided inside a transaction whose other writes (e.g. marking a proposal expired) must still commit. */
class DeferredRefusal {
  constructor(readonly error: Error) {}
}

const SHIFT_COLUMNS = `"id", "companyId", "guardId", "status",
  EXTRACT(EPOCH FROM "start") * 1000 AS "startMs", EXTRACT(EPOCH FROM "end") * 1000 AS "endMs",
  EXTRACT(EPOCH FROM "originalEnd") * 1000 AS "originalEndMs"`;
const AMENDMENT_COLUMNS = `"id", "shiftId", "companyId", "guardId", "sequence", "status", "responseMethod", "proposedByUserId",
  "approvalRequired",
  EXTRACT(EPOCH FROM "originalEnd") * 1000 AS "originalEndMs", EXTRACT(EPOCH FROM "previousEnd") * 1000 AS "previousEndMs",
  EXTRACT(EPOCH FROM "proposedEnd") * 1000 AS "proposedEndMs", EXTRACT(EPOCH FROM "proposedAt") * 1000 AS "proposedAtMs",
  EXTRACT(EPOCH FROM "expiresAt") * 1000 AS "expiresAtMs"`;
const CLOCK = `(statement_timestamp() AT TIME ZONE 'UTC')`;
const OPEN_SQL = `('awaiting_approval', 'pending')`;

/** What an amendment's fatigue assessment is stored as: the pure assessment plus what the company view needs. */
type StoredFatigueAssessment = FatigueAssessment & {
  /** The deciding next shift (or none) belongs to the amending company. Absent on rows stored before 23 Oct 2026. */
  restFromOwnCompany?: boolean;
  /** The Guard's scheduled hours in the 7-day window at the amending company only. */
  companySevenDayScheduledHours?: number;
};
type Audience = 'company' | 'guard';

/**
 * The company-safe version of an assessment: the rest gap only when it was decided by the company's own next shift,
 * and the company's own 7-day hours; never another company's schedule. Warnings, approval and limits are untouched.
 */
function companySafeAssessment(fa: StoredFatigueAssessment) {
  const restShown = fa.restFromOwnCompany === true;
  const own = typeof fa.companySevenDayScheduledHours === 'number' ? fa.companySevenDayScheduledHours : null;
  const { restHoursBeforeNextShift, sevenDayScheduledHours, restFromOwnCompany: _r, companySevenDayScheduledHours: _c, ...rest } = fa;
  return {
    ...rest,
    restHoursBeforeNextShift: restShown ? restHoursBeforeNextShift : null,
    restFiguresWithheld: !restShown && restHoursBeforeNextShift !== null,
    companySevenDayScheduledHours: own,
    sevenDayIncludesOtherWork: own === null ? true : sevenDayScheduledHours > own + 0.01,
  };
}

function presentFatigue(fa: StoredFatigueAssessment | null, audience: Audience) {
  if (!fa) {
    return { basis: 'scheduled_hours' as const, totalScheduledHours: null, warnings: [], restHoursBeforeNextShift: null,
      sevenDayScheduledHours: null, restFiguresWithheld: false, sevenDayIncludesOtherWork: false };
  }
  if (audience === 'guard') {
    return { basis: 'scheduled_hours' as const, totalScheduledHours: fa.totalScheduledHours ?? null, warnings: fa.warnings ?? [],
      restHoursBeforeNextShift: fa.restHoursBeforeNextShift ?? null, sevenDayScheduledHours: fa.sevenDayScheduledHours ?? null,
      restFiguresWithheld: false, sevenDayIncludesOtherWork: false };
  }
  const safe = companySafeAssessment(fa);
  return { basis: 'scheduled_hours' as const, totalScheduledHours: fa.totalScheduledHours ?? null, warnings: fa.warnings ?? [],
    restHoursBeforeNextShift: safe.restHoursBeforeNextShift, sevenDayScheduledHours: safe.companySevenDayScheduledHours,
    restFiguresWithheld: safe.restFiguresWithheld, sevenDayIncludesOtherWork: safe.sevenDayIncludesOtherWork };
}

const toShift = (r: any): ShiftRow | null =>
  r
    ? {
        id: Number(r.id),
        companyId: Number(r.companyId),
        guardId: r.guardId === null ? null : Number(r.guardId),
        status: String(r.status || '').trim().toLowerCase(),
        startMs: Number(r.startMs),
        endMs: Number(r.endMs),
        originalEndMs: r.originalEndMs === null ? null : Number(r.originalEndMs),
      }
    : null;

const toAmendment = (r: any): AmendmentRow | null =>
  r
    ? {
        id: Number(r.id),
        shiftId: Number(r.shiftId),
        companyId: Number(r.companyId),
        guardId: Number(r.guardId),
        sequence: Number(r.sequence),
        status: r.status,
        responseMethod: r.responseMethod,
        proposedByUserId: Number(r.proposedByUserId),
        approvalRequired: Boolean(r.approvalRequired),
        originalEndMs: Number(r.originalEndMs),
        previousEndMs: Number(r.previousEndMs),
        proposedEndMs: Number(r.proposedEndMs),
        proposedAtMs: Number(r.proposedAtMs),
        expiresAtMs: Number(r.expiresAtMs),
      }
    : null;

/** An instant from a request: ISO 8601 with an explicit offset (Z or ±hh:mm), never local wall time. */
function instantMs(value: string, field: string): number {
  const ms = new Date(value).getTime();
  if (!hasExplicitUtcOffset(value) || !Number.isFinite(ms)) {
    throw new BadRequestException(`${field} must be an ISO 8601 instant with an explicit UTC offset.`);
  }
  return ms;
}

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/**
 * Live Shift Amendments, Phase 1 (owner-approved 22 Oct 2026). See shift-amendment-policy.ts for the rules.
 *
 * Concurrency (the corrected Phase 0/0b strategy):
 *   - lock order, every path: Guard assignment lock (only paths that extend the Guard's commitment: propose, accept,
 *     record verbal agreement) → shift row FOR NO KEY UPDATE → Welfare sweep per-shift lock → amendment row FOR UPDATE.
 *     FOR NO KEY UPDATE, not FOR UPDATE: the sweep inserts alerts referencing the shift (FOR KEY SHARE), and FOR UPDATE
 *     plus waiting on the sweep lock is the deadlock fixed in Phase 0b. It still conflicts with Book Off (FOR UPDATE),
 *     shift edits and reconciliation, so all of them are serialised against amendments.
 *   - Book Off voids open proposals inside its own transaction (shift row first, amendment rows second).
 *   - every clock decision inside a transaction uses statement_timestamp(), never now().
 *   - eligibility reads (relationship, compliance, leave, availability, fatigue) run BEFORE the transaction; inside it
 *     only the overlap re-check runs, on the transaction's own connection (no second pooled connection is held).
 *   - SET LOCAL lock_timeout bounds every wait; a timeout is a retryable 409 SHIFT_AMENDMENT_BUSY.
 */
@Injectable()
export class ShiftAmendmentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ShiftAmendments');
  private expiryJob?: SingleFlightJob;
  private expiryInterval?: NodeJS.Timeout;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(ShiftAmendment) private readonly amendmentRepo: Repository<ShiftAmendment>,
    @InjectRepository(CompanyShiftPolicy) private readonly policyRepo: Repository<CompanyShiftPolicy>,
    private readonly membershipService: CompanyMembershipService,
    private readonly guardProfileService: GuardProfileService,
    private readonly companyGuardService: CompanyGuardService,
    private readonly complianceService: ComplianceService,
    private readonly availabilityService: AvailabilityService,
    private readonly auditLogService: AuditLogService,
    private readonly emailService: TransactionalEmailService,
    private readonly guardNotifications: GuardNotificationService,
  ) {}

  onModuleInit() {
    this.expiryJob = new SingleFlightJob(
      'shift-amendment-expiry',
      () =>
        this.expireLapsedProposals().then(
          () => undefined,
          (error) => this.logger.error(`Shift amendment expiry failed: ${error?.message || error}`),
        ),
      { overrunAfterMs: 2 * AMENDMENT_EXPIRY_INTERVAL_MS },
    );
    this.expiryInterval = setInterval(() => void this.expiryJob?.tick(), AMENDMENT_EXPIRY_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.expiryInterval) clearInterval(this.expiryInterval);
    this.expiryJob?.stop();
  }

  // ── Actors, policy, reads ─────────────────────────────────────────────────────────────────────────

  private async companyActor(user: JwtPayload, action?: AmendmentAction): Promise<CompanyActor> {
    if (user.role === UserRole.GUARD || user.role === UserRole.ADMIN) {
      throw amendmentError(HttpStatus.FORBIDDEN, E.FORBIDDEN, 'Only the company that owns the shift can do this.');
    }
    const { company, membershipRole } = await this.membershipService.resolveCompanyContext(
      user.sub,
      user.role,
      CompanyPermission.SHIFTS_VIEW,
    );
    const [membership] = (await this.dataSource.query(
      `SELECT "canAmendShifts" FROM "company_memberships" WHERE "userId" = $1 AND "companyId" = $2 AND "status" = $3`,
      [user.sub, company.id, CompanyMembershipStatus.ACTIVE],
    )) as Array<{ canAmendShifts: boolean }>;
    const actor = { companyId: company.id, userId: user.sub, role: membershipRole, canAmendShifts: Boolean(membership?.canAmendShifts) };
    if (action && !mayPerformAmendmentAction(actor.role, actor.canAmendShifts, action)) {
      throw amendmentError(HttpStatus.FORBIDDEN, E.FORBIDDEN, 'You are not authorised to do this for shift extensions.');
    }
    return actor;
  }

  private async guardActor(user: JwtPayload): Promise<{ guardId: number; userId: number }> {
    if (user.role !== UserRole.GUARD) throw amendmentError(HttpStatus.FORBIDDEN, E.FORBIDDEN, 'Only the assigned Guard can do this.');
    const guard = await this.guardProfileService.findByUserId(user.sub);
    if (!guard) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');
    return { guardId: guard.id, userId: user.sub };
  }

  async policyFor(companyId: number): Promise<ShiftPolicyValues & { source: 'default' | 'company' }> {
    const row = await this.policyRepo.findOne({ where: { companyId } });
    if (!row) return { ...DEFAULT_SHIFT_POLICY, source: 'default' };
    // Never looser than the platform safety limits, whatever the row says.
    return {
      amendmentsEnabled: row.amendmentsEnabled,
      ...withinPlatformSafety({
        fatigueWarningHours: Number(row.fatigueWarningHours),
        approvalRequiredHours: Number(row.approvalRequiredHours),
        hardLimitHours: row.hardLimitHours === null ? null : Number(row.hardLimitHours),
        minRestHours: Number(row.minRestHours),
        weeklyReviewHours: Number(row.weeklyReviewHours),
        lastMinuteWarningMinutes: row.lastMinuteWarningMinutes,
      }),
      source: 'company',
    };
  }

  private async requireEnabled(companyId: number) {
    const policy = await this.policyFor(companyId);
    if (!policy.amendmentsEnabled) {
      throw amendmentError(HttpStatus.FORBIDDEN, E.DISABLED, 'Shift extensions are not enabled for this company.');
    }
    return policy;
  }

  private async readShift(shiftId: number): Promise<ShiftRow | null> {
    const [row] = await this.dataSource.query(`SELECT ${SHIFT_COLUMNS} FROM "shifts" WHERE "id" = $1`, [shiftId]);
    return toShift(row);
  }

  private async readAmendment(id: number): Promise<AmendmentRow | null> {
    const [row] = await this.dataSource.query(`SELECT ${AMENDMENT_COLUMNS} FROM "shift_amendments" WHERE "id" = $1`, [id]);
    return toAmendment(row);
  }

  /** The Guard's eligibility for the extended window, read before any transaction (Phase 0 rule). */
  private async assertEligible(companyId: number, guardId: number, shift: ShiftRow, proposedEndMs: number) {
    try {
      await this.companyGuardService.ensureActiveRelationship(companyId, guardId);
      await this.complianceService.assertGuardAssignable(companyId, guardId);
      await this.availabilityService.assertGuardCanTakeShift(companyId, guardId, new Date(shift.startMs), new Date(proposedEndMs), shift.id);
    } catch (error: any) {
      if (error instanceof ForbiddenException || error?.status === 403) {
        const message = String(error?.message || 'The Guard cannot take the extended shift.');
        if (/overlapping/i.test(message)) throw amendmentError(HttpStatus.CONFLICT, E.CLASH, message);
        throw amendmentError(HttpStatus.FORBIDDEN, E.INELIGIBLE, message);
      }
      throw error;
    }
  }

  /**
   * Scheduled hours only (never actual attendance): the rest gap before the next shift and the rolling 7 days, over
   * the Guard's shifts at every company (that is what keeps the Guard safe). Also recorded, so the company view can
   * withhold them: whether the deciding next shift is this company's, and this company's own 7-day hours.
   */
  private async assess(shift: ShiftRow, guardId: number, proposedEndMs: number, policy: ShiftPolicyValues): Promise<StoredFatigueAssessment> {
    const [next] = (await this.dataSource.query(
      `SELECT EXTRACT(EPOCH FROM "start") * 1000 AS "ms", "companyId" FROM "shifts"
        WHERE "guardId" = $1 AND "id" <> $2 AND "start" > $3::timestamp
          AND "status" IN ('scheduled', 'offered', 'ready', 'in_progress')
        ORDER BY "start" ASC LIMIT 1`,
      [guardId, shift.id, toDbTimestamp(shift.startMs)],
    )) as Array<{ ms: string | null; companyId: number | null }>;
    const windowStart = toDbTimestamp(proposedEndMs - 7 * 24 * 3_600_000);
    const windowEnd = toDbTimestamp(proposedEndMs);
    const [week] = (await this.dataSource.query(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
                LEAST(CASE WHEN "id" = $2 THEN $4::timestamp ELSE "end" END, $4::timestamp) - GREATEST("start", $3::timestamp)
              ))), 0) / 3600 AS "hours"
         FROM "shifts"
        WHERE "guardId" = $1 AND "status" IN ('offered', 'ready', 'in_progress', 'completed')
          AND "start" < $4::timestamp AND (CASE WHEN "id" = $2 THEN $4::timestamp ELSE "end" END) > $3::timestamp`,
      [guardId, shift.id, windowStart, windowEnd],
    )) as Array<{ hours: string }>;
    const [own] = (await this.dataSource.query(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
                LEAST(CASE WHEN "id" = $2 THEN $4::timestamp ELSE "end" END, $4::timestamp) - GREATEST("start", $3::timestamp)
              ))), 0) / 3600 AS "hours"
         FROM "shifts"
        WHERE "guardId" = $1 AND "companyId" = $5 AND "status" IN ('offered', 'ready', 'in_progress', 'completed')
          AND "start" < $4::timestamp AND (CASE WHEN "id" = $2 THEN $4::timestamp ELSE "end" END) > $3::timestamp`,
      [guardId, shift.id, windowStart, windowEnd, shift.companyId],
    )) as Array<{ hours: string }>;
    return {
      ...assessFatigue({
        startMs: shift.startMs,
        currentEndMs: shift.endMs,
        proposedEndMs,
        nowMs: Date.now(),
        nextShiftStartMs: next?.ms === null || next?.ms === undefined ? null : Number(next.ms),
        sevenDayScheduledHours: Number(week?.hours ?? 0),
        policy,
      }),
      restFromOwnCompany: !next || Number(next.companyId) === shift.companyId,
      companySevenDayScheduledHours: Math.round(Number(own?.hours ?? 0) * 100) / 100,
    };
  }

  // ── Transactions ──────────────────────────────────────────────────────────────────────────────────

  private async inTransaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await this.dataSource.transaction(async (manager) => {
        await manager.query(`SET LOCAL lock_timeout = '${AMENDMENT_LOCK_TIMEOUT}'`);
        return work(manager);
      });
    } catch (error: any) {
      const code = error?.code ?? error?.driverError?.code;
      const constraint = String(error?.constraint ?? error?.driverError?.constraint ?? '');
      if (code === '55P03') {
        throw amendmentError(HttpStatus.CONFLICT, E.BUSY, 'This shift is being changed by someone else. Try again in a moment.');
      }
      if (code === '23505' && constraint === 'UQ_shift_amendments_one_open') {
        throw amendmentError(HttpStatus.CONFLICT, E.PENDING, 'This shift already has an extension waiting for a decision.');
      }
      throw error;
    }
    if (result instanceof DeferredRefusal) throw result.error;
    return result;
  }

  /** Shift row (FOR NO KEY UPDATE), then the Welfare sweep's per-shift lock, then the statement clock. */
  private async lockShift(manager: EntityManager, shiftId: number): Promise<{ shift: ShiftRow; nowMs: number }> {
    const [row] = await manager.query(`SELECT ${SHIFT_COLUMNS} FROM "shifts" WHERE "id" = $1 FOR NO KEY UPDATE`, [shiftId]);
    const shift = toShift(row);
    if (!shift) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift not found.');
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [WELFARE_SWEEP_LOCK_NAMESPACE, shiftId]);
    const [{ now }] = await manager.query(`SELECT EXTRACT(EPOCH FROM statement_timestamp()) * 1000 AS "now"`);
    return { shift, nowMs: Number(now) };
  }

  private async lockAmendment(manager: EntityManager, id: number, shiftId: number): Promise<AmendmentRow> {
    const [row] = await manager.query(`SELECT ${AMENDMENT_COLUMNS} FROM "shift_amendments" WHERE "id" = $1 FOR UPDATE`, [id]);
    const amendment = toAmendment(row);
    if (!amendment || amendment.shiftId !== shiftId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');
    return amendment;
  }

  private audit(manager: EntityManager, companyId: number, userId: number | null, action: string, entityType: string, entityId: number,
    beforeData: Record<string, unknown> | null, afterData: Record<string, unknown> | null) {
    return this.auditLogService.logInTransaction(manager, {
      company: { id: companyId },
      user: userId ? { id: userId } : null,
      action,
      entityType,
      entityId,
      beforeData,
      afterData,
    });
  }

  private async notify(manager: EntityManager, userIds: number[], companyId: number, type: NotificationType, title: string, message: string): Promise<number[]> {
    const unique = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))];
    const ids: number[] = [];
    if (!unique.length) return ids;
    // On the transaction's own connection, so the notification commits (or not) with the change it reports.
    for (const userId of unique) {
      const [row] = await manager.query(
        `INSERT INTO "notifications" ("userId", "companyId", "type", "title", "message", "status", "sentAt")
         VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING "id"`,
        [userId, companyId, type, title, message, NotificationStatus.UNREAD],
      );
      ids.push(Number(row.id));
    }
    return ids;
  }

  /**
   * The Guard-facing notice, exactly as before, plus an OS push of it to the Guard (after commit, best effort, at most
   * once per amendment and outcome). Notices to company staff are never pushed.
   */
  private async notifyGuard(
    manager: EntityManager,
    guardUser: number,
    amendment: { id: number; companyId: number; guardId: number; shiftId: number },
    type: NotificationType.SHIFT_AMENDMENT_REQUESTED | NotificationType.SHIFT_AMENDMENT_RESPONDED,
    outcome: 'requested' | 'recorded' | 'withdrawn' | 'dispute_reviewed',
    title: string,
    message: string,
  ) {
    const [notificationId] = await this.notify(manager, [guardUser], amendment.companyId, type, title, message);
    if (!notificationId) return;
    await this.guardNotifications.pushForNotice(manager, {
      type,
      companyId: amendment.companyId,
      guardId: amendment.guardId,
      shiftId: amendment.shiftId,
      amendmentId: amendment.id,
      eventKey: outcome === 'requested' ? `${type}:amendment:${amendment.id}` : `${type}:amendment:${amendment.id}:${outcome}`,
    }, notificationId);
  }

  private async guardUserId(manager: EntityManager, guardId: number): Promise<number | null> {
    const [row] = await manager.query(`SELECT "userId" FROM "guard_profiles" WHERE "id" = $1`, [guardId]);
    return row?.userId ? Number(row.userId) : null;
  }

  private async companyManagerUserIds(manager: EntityManager, companyId: number): Promise<number[]> {
    const rows = (await manager.query(
      `SELECT "userId" FROM "company_memberships" WHERE "companyId" = $1 AND "status" = 'active' AND "membershipRole" IN ('owner', 'admin')
       UNION SELECT "userId" FROM "companies" WHERE "id" = $1`,
      [companyId],
    )) as Array<{ userId: number }>;
    return rows.map((r) => Number(r.userId));
  }

  /** Marks one open proposal expired (inside the caller's locks) and records it. */
  private async expireInTx(manager: EntityManager, amendment: AmendmentRow) {
    const rows = await manager.query(
      `UPDATE "shift_amendments" SET "status" = 'expired', "expiredAt" = ${CLOCK}, "updatedAt" = now()
        WHERE "id" = $1 AND "status" IN ${OPEN_SQL} RETURNING "id"`,
      [amendment.id],
    );
    if (!this.updated(rows)) return;
    await this.audit(manager, amendment.companyId, null, 'shift_amendment.expired', 'shift_amendment', amendment.id,
      { status: amendment.status }, { status: 'expired', expiresAt: iso(amendment.expiresAtMs), shiftId: amendment.shiftId });
    await this.notify(manager, [amendment.proposedByUserId], amendment.companyId, NotificationType.SHIFT_AMENDMENT_EXPIRED,
      'Shift extension expired', `The extension request for shift ${amendment.shiftId} expired without a decision. The shift was not extended.`);
  }

  private updated(result: unknown): number {
    // TypeORM returns [rows, count] for UPDATE … RETURNING on postgres, and rows for SELECT.
    if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) return (result[0] as unknown[]).length;
    return Array.isArray(result) ? result.length : 0;
  }

  // ── Propose ───────────────────────────────────────────────────────────────────────────────────────

  async propose(user: JwtPayload, shiftId: number, dto: ProposeAmendmentDto) {
    const actor = await this.companyActor(user, 'propose');
    const policy = await this.requireEnabled(actor.companyId);
    const pre = await this.readShift(shiftId);
    if (!pre || pre.companyId !== actor.companyId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift not found.');
    if (pre.status !== 'in_progress' || !pre.guardId) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.NOT_LIVE, 'Only an in-progress shift can be extended. Change a future shift with the ordinary edit.');
    }
    const [att] = (await this.dataSource.query(
      `SELECT bool_or("type" = $2) AS "bookedOn", bool_or("type" = $3) AS "bookedOff" FROM "effective_attendance_events" WHERE "shiftId" = $1`,
      [shiftId, AttendanceEventType.CHECK_IN, AttendanceEventType.CHECK_OUT],
    )) as Array<{ bookedOn: boolean | null; bookedOff: boolean | null }>;
    if (!att?.bookedOn || att?.bookedOff) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.NOT_LIVE, 'The Guard must be booked on, and not booked off, to extend this shift.');
    }
    const proposedEndMs = instantMs(dto.proposedEnd, 'proposedEnd');
    if (proposedEndMs <= pre.endMs) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.NOT_LATER, 'The new end must be later than the current end of the shift.');
    }
    if (pre.endMs <= Date.now()) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.TOO_LATE, 'The shift has already reached its scheduled end. It can no longer be extended.');
    }
    const guardId = pre.guardId;
    await this.assertEligible(actor.companyId, guardId, pre, proposedEndMs);
    const assessment = await this.assess(pre, guardId, proposedEndMs, policy);
    if (assessment.hardLimitExceeded) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.FATIGUE_LIMIT,
        `The extended shift would be ${assessment.totalScheduledHours} scheduled hours, over the company limit of ${policy.hardLimitHours}.`,
        { assessment: companySafeAssessment(assessment) });
    }

    const id = await this.inTransaction(async (manager) => {
      await lockGuardsForAssignment(manager, [guardId]);
      const { shift, nowMs } = await this.lockShift(manager, shiftId);
      if (shift.status !== 'in_progress' || shift.guardId !== guardId) {
        throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.NOT_LIVE, 'The shift is no longer in progress.');
      }
      if (shift.endMs !== pre.endMs) {
        throw amendmentError(HttpStatus.CONFLICT, E.STALE, 'The shift end changed while the extension was being prepared. Reload and try again.');
      }
      if (shift.endMs <= nowMs) {
        throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.TOO_LATE, 'The shift has already reached its scheduled end. It can no longer be extended.');
      }
      // A lapsed open proposal no longer holds the shift's single open slot: record its expiry first.
      const lapsed = await manager.query(
        `SELECT ${AMENDMENT_COLUMNS} FROM "shift_amendments" WHERE "shiftId" = $1 AND "status" IN ${OPEN_SQL} FOR UPDATE`,
        [shiftId],
      );
      for (const row of lapsed) {
        const open = toAmendment(row)!;
        if (open.expiresAtMs <= nowMs) await this.expireInTx(manager, open);
      }
      try {
        await assertNoShiftClash(manager, guardId, new Date(shift.startMs), new Date(proposedEndMs), shift.id);
      } catch (error: any) {
        throw amendmentError(HttpStatus.CONFLICT, E.CLASH, String(error?.message || 'Guard has an overlapping shift assignment.'));
      }
      const [{ next }] = await manager.query(
        `SELECT COALESCE(max("sequence"), 0) + 1 AS "next" FROM "shift_amendments" WHERE "shiftId" = $1`,
        [shiftId],
      );
      const status: AmendmentStatus = assessment.approvalRequired ? 'awaiting_approval' : 'pending';
      const originalEndMs = shift.originalEndMs ?? shift.endMs;
      const [inserted] = await manager.query(
        `INSERT INTO "shift_amendments" ("shiftId", "companyId", "guardId", "sequence", "status", "originalEnd", "previousEnd",
            "proposedEnd", "reason", "proposedByUserId", "proposedAt", "expiresAt", "fatigueAssessment", "approvalRequired",
            "complianceReviewRequired")
         VALUES ($1, $2, $3, $4, $5, $6::timestamp, $7::timestamp, $8::timestamp, $9, $10, ${CLOCK}, $7::timestamp, $11::jsonb, $12, $13)
         RETURNING "id"`,
        [shiftId, actor.companyId, guardId, Number(next), status, toDbTimestamp(originalEndMs), toDbTimestamp(shift.endMs),
          toDbTimestamp(proposedEndMs), dto.reason.trim(), actor.userId, JSON.stringify(assessment), assessment.approvalRequired,
          assessment.complianceReviewRequired],
      );
      const newId = Number(inserted.id);
      await this.audit(manager, actor.companyId, actor.userId, 'shift_amendment.proposed', 'shift_amendment', newId, null, {
        shiftId, sequence: Number(next), status, originalEnd: iso(originalEndMs), previousEnd: iso(shift.endMs),
        proposedEnd: iso(proposedEndMs), expiresAt: iso(shift.endMs), reason: dto.reason.trim(), approvalRequired: assessment.approvalRequired,
        warnings: assessment.warnings, totalScheduledHours: assessment.totalScheduledHours, proposedByRole: actor.role,
      });
      if (status === 'pending') {
        const guardUser = await this.guardUserId(manager, guardId);
        if (guardUser) {
          await this.notifyGuard(manager, guardUser, { id: newId, companyId: actor.companyId, guardId, shiftId },
            NotificationType.SHIFT_AMENDMENT_REQUESTED, 'requested', 'Shift extension request',
            `Your company asks you to extend your shift to ${iso(proposedEndMs)}. Open S4 to accept or decline before ${iso(shift.endMs)}.`);
        }
      }
      return newId;
    });
    return { amendment: await this.view(id), warnings: assessment.warnings };
  }

  // ── Management approval ───────────────────────────────────────────────────────────────────────────

  async approve(user: JwtPayload, id: number, dto: ApproveAmendmentDto) {
    const actor = await this.companyActor(user, 'approve');
    await this.requireEnabled(actor.companyId);
    const pre = await this.readAmendment(id);
    if (!pre || pre.companyId !== actor.companyId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');
    if (pre.proposedByUserId === actor.userId && !dto.confirmSelfApproval) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.SELF_APPROVAL_CONFIRMATION,
        'You proposed this extension. Confirm that you are approving your own proposal.');
    }
    await this.inTransaction(async (manager) => {
      const { nowMs } = await this.lockShift(manager, pre.shiftId);
      const amendment = await this.lockAmendment(manager, id, pre.shiftId);
      if (amendment.status === 'pending' && amendment.approvalRequired) return null; // already approved: idempotent
      if (amendment.status !== 'awaiting_approval') {
        throw amendmentError(HttpStatus.CONFLICT, E.NOT_OPEN, `This extension is ${amendment.status.replace('_', ' ')}.`);
      }
      if (amendment.expiresAtMs <= nowMs) {
        await this.expireInTx(manager, amendment);
        return new DeferredRefusal(amendmentError(HttpStatus.CONFLICT, E.EXPIRED, 'This extension request has expired.'));
      }
      const self = amendment.proposedByUserId === actor.userId;
      await manager.query(
        `UPDATE "shift_amendments" SET "status" = 'pending', "approvedByUserId" = $2, "approvedAt" = ${CLOCK},
            "approvalStatement" = $3, "selfApproved" = $4, "updatedAt" = now()
          WHERE "id" = $1 AND "status" = 'awaiting_approval'`,
        [id, actor.userId, dto.statement.trim(), self],
      );
      await this.audit(manager, actor.companyId, actor.userId, 'shift_amendment.approved', 'shift_amendment', id,
        { status: 'awaiting_approval' }, { status: 'pending', approvalStatement: dto.statement.trim(), selfApproved: self, approverRole: actor.role });
      const guardUser = await this.guardUserId(manager, amendment.guardId);
      if (guardUser) {
        await this.notifyGuard(manager, guardUser, amendment, NotificationType.SHIFT_AMENDMENT_REQUESTED, 'requested', 'Shift extension request',
          `Your company asks you to extend your shift to ${iso(amendment.proposedEndMs)}. Open S4 to accept or decline before ${iso(amendment.expiresAtMs)}.`);
      }
      return null;
    });
    return this.view(id);
  }

  // ── Withdraw ──────────────────────────────────────────────────────────────────────────────────────

  async withdraw(user: JwtPayload, id: number, dto: WithdrawAmendmentDto) {
    const actor = await this.companyActor(user, 'withdraw');
    // No amendment state may change while the company has amendments switched off (owner rule: disabled = unusable).
    await this.requireEnabled(actor.companyId);
    const pre = await this.readAmendment(id);
    if (!pre || pre.companyId !== actor.companyId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');
    await this.inTransaction(async (manager) => {
      const { nowMs } = await this.lockShift(manager, pre.shiftId);
      const amendment = await this.lockAmendment(manager, id, pre.shiftId);
      if (amendment.status === 'withdrawn') return null;
      if (!OPEN_AMENDMENT_STATUSES.includes(amendment.status)) {
        throw amendmentError(HttpStatus.CONFLICT, amendment.status === 'accepted' ? E.ALREADY_ANSWERED : E.NOT_OPEN,
          `This extension is ${amendment.status.replace('_', ' ')} and can no longer be withdrawn.`);
      }
      if (amendment.expiresAtMs <= nowMs) {
        await this.expireInTx(manager, amendment);
        return new DeferredRefusal(amendmentError(HttpStatus.CONFLICT, E.EXPIRED, 'This extension request has already expired.'));
      }
      await manager.query(
        `UPDATE "shift_amendments" SET "status" = 'withdrawn', "withdrawnByUserId" = $2, "withdrawnAt" = ${CLOCK},
            "responseReason" = COALESCE("responseReason", $3), "updatedAt" = now()
          WHERE "id" = $1 AND "status" IN ${OPEN_SQL}`,
        [id, actor.userId, dto.reason?.trim() || null],
      );
      await this.audit(manager, actor.companyId, actor.userId, 'shift_amendment.withdrawn', 'shift_amendment', id,
        { status: amendment.status }, { status: 'withdrawn', reason: dto.reason?.trim() || null });
      if (amendment.status === 'pending') {
        const guardUser = await this.guardUserId(manager, amendment.guardId);
        if (guardUser) {
          await this.notifyGuard(manager, guardUser, amendment, NotificationType.SHIFT_AMENDMENT_RESPONDED, 'withdrawn', 'Shift extension withdrawn',
            'Your company withdrew its shift extension request. Your shift end is unchanged.');
        }
      }
      return null;
    });
    return this.view(id);
  }

  // ── Agreement: Guard in the app, or staff-recorded verbal agreement ───────────────────────────────

  async respond(user: JwtPayload, id: number, dto: RespondAmendmentDto) {
    const guard = await this.guardActor(user);
    const pre = await this.readAmendment(id);
    if (!pre || pre.guardId !== guard.guardId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');
    // No amendment state may change while the company has amendments switched off (owner rule: disabled = unusable).
    await this.requireEnabled(pre.companyId);
    const settled = this.settledAnswer(pre, dto.response);
    if (settled === 'same') return this.view(id, 'guard');
    if (settled === 'different') throw this.alreadyAnswered(pre);

    if (dto.response === 'declined') {
      await this.inTransaction(async (manager) => {
        const { nowMs } = await this.lockShift(manager, pre.shiftId);
        const amendment = await this.lockAmendment(manager, id, pre.shiftId);
        const again = this.settledAnswer(amendment, 'declined');
        if (again === 'same') return null;
        if (again === 'different') throw this.alreadyAnswered(amendment);
        if (amendment.status !== 'pending') throw this.notOpen(amendment);
        if (amendment.expiresAtMs <= nowMs) {
          await this.expireInTx(manager, amendment);
          return new DeferredRefusal(amendmentError(HttpStatus.CONFLICT, E.EXPIRED, 'This extension request has expired. Your shift end is unchanged.'));
        }
        await manager.query(
          `UPDATE "shift_amendments" SET "status" = 'declined', "responseMethod" = 'guard_app', "respondedByUserId" = $2,
              "respondedAt" = ${CLOCK}, "responseReason" = $3, "updatedAt" = now()
            WHERE "id" = $1 AND "status" = 'pending'`,
          [id, guard.userId, dto.reason?.trim() || null],
        );
        await this.audit(manager, amendment.companyId, guard.userId, 'shift_amendment.declined', 'shift_amendment', id,
          { status: 'pending' }, { status: 'declined', responseMethod: 'guard_app', reason: dto.reason?.trim() || null });
        await this.notify(manager, [amendment.proposedByUserId], amendment.companyId, NotificationType.SHIFT_AMENDMENT_RESPONDED,
          'Shift extension declined', `The Guard declined the extension of shift ${amendment.shiftId}. The shift end is unchanged.`);
        return null;
      });
      return this.view(id, 'guard');
    }

    await this.accept(pre, {
      method: 'guard_app',
      respondedByUserId: guard.userId,
      responseReason: dto.reason?.trim() || null,
      actorRole: 'guard',
    });
    return this.view(id, 'guard');
  }

  async recordVerbalAgreement(user: JwtPayload, id: number, dto: RecordVerbalAgreementDto) {
    const actor = await this.companyActor(user, 'record_agreement');
    // No amendment state may change while the company has amendments switched off (owner rule: disabled = unusable).
    await this.requireEnabled(actor.companyId);
    const pre = await this.readAmendment(id);
    if (!pre || pre.companyId !== actor.companyId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');
    if (pre.status === 'awaiting_approval') {
      throw amendmentError(HttpStatus.CONFLICT, E.APPROVAL_REQUIRED, 'This extension needs management approval before the Guard can agree to it.');
    }
    if (pre.status !== 'pending') throw this.notOpen(pre);
    if (instantMs(dto.agreedEnd, 'agreedEnd') !== pre.proposedEndMs) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.AGREED_TERMS_MISMATCH,
        'The agreed end must be exactly the proposed end. Withdraw and propose again for different terms.');
    }
    const contactMs = instantMs(dto.contactAt, 'contactAt');
    if (contactMs < pre.proposedAtMs || contactMs > Date.now() + CONTACT_TIME_SKEW_MS) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.CONTACT_TIME_INVALID,
        'The contact time must be after the extension was proposed and not in the future.');
    }
    await this.accept(pre, {
      method: 'staff_recorded_verbal',
      respondedByUserId: actor.userId,
      responseReason: dto.reason.trim(),
      actorRole: actor.role,
      verbal: { contactMethod: dto.contactMethod, contactAtMs: contactMs, confirmation: dto.confirmation.trim() },
    });
    await this.sendVerbalConfirmation(id);
    return this.view(id);
  }

  private settledAnswer(amendment: AmendmentRow, response: 'accepted' | 'declined'): 'same' | 'different' | null {
    const agreed = ['accepted', 'disputed', 'dispute_upheld', 'dispute_corrected'].includes(amendment.status);
    if (agreed) return response === 'accepted' ? 'same' : 'different';
    if (amendment.status === 'declined') return response === 'declined' ? 'same' : 'different';
    return null;
  }

  private alreadyAnswered(amendment: AmendmentRow) {
    return amendmentError(HttpStatus.CONFLICT, E.ALREADY_ANSWERED,
      amendment.responseMethod === 'staff_recorded_verbal'
        ? 'Your company recorded your agreement to this extension. If you did not agree, report it with Dispute.'
        : 'This extension has already been answered.');
  }

  private notOpen(amendment: AmendmentRow) {
    const code = amendment.status === 'expired' ? E.EXPIRED : amendment.status === 'awaiting_approval' ? E.APPROVAL_REQUIRED : E.NOT_OPEN;
    return amendmentError(HttpStatus.CONFLICT, code, `This extension is ${amendment.status.replace('_', ' ')}.`);
  }

  /**
   * The one place an extension takes effect. Re-checks everything under the approved locks: still pending, not expired
   * by the statement clock, the shift still in progress and still ending exactly where the proposal started, and no
   * overlap for the Guard's extended window. Then moves shifts.end, keeps originalEnd, syncs only a fully unlocked draft
   * timesheet, and records it — all in one transaction.
   */
  private async accept(pre: AmendmentRow, input: {
    method: 'guard_app' | 'staff_recorded_verbal';
    respondedByUserId: number;
    responseReason: string | null;
    actorRole: string;
    verbal?: { contactMethod: string; contactAtMs: number; confirmation: string };
  }) {
    if (pre.status === 'awaiting_approval') {
      throw amendmentError(HttpStatus.CONFLICT, E.APPROVAL_REQUIRED, 'This extension is waiting for management approval.');
    }
    if (pre.status !== 'pending') throw this.notOpen(pre);
    const policy = await this.requireEnabled(pre.companyId);
    const shiftPre = await this.readShift(pre.shiftId);
    if (!shiftPre || shiftPre.status !== 'in_progress') {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.NOT_LIVE, 'The shift is no longer in progress.');
    }
    await this.assertEligible(pre.companyId, pre.guardId, shiftPre, pre.proposedEndMs);
    const assessment = await this.assess(shiftPre, pre.guardId, pre.proposedEndMs, policy);
    if (assessment.hardLimitExceeded) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.FATIGUE_LIMIT,
        `The extended shift would be ${assessment.totalScheduledHours} scheduled hours, over the company limit of ${policy.hardLimitHours}.`,
        { assessment: companySafeAssessment(assessment) });
    }

    await this.inTransaction(async (manager) => {
      await lockGuardsForAssignment(manager, [pre.guardId]);
      const { shift, nowMs } = await this.lockShift(manager, pre.shiftId);
      const amendment = await this.lockAmendment(manager, pre.id, pre.shiftId);
      if (this.settledAnswer(amendment, 'accepted') === 'same') return null; // a concurrent identical answer won
      if (amendment.status === 'declined') throw this.alreadyAnswered(amendment);
      if (amendment.status !== 'pending') throw this.notOpen(amendment);
      if (amendment.expiresAtMs <= nowMs) {
        await this.expireInTx(manager, amendment);
        return new DeferredRefusal(amendmentError(HttpStatus.CONFLICT, E.EXPIRED, 'This extension request has expired. The shift end is unchanged.'));
      }
      if (shift.status !== 'in_progress' || shift.guardId !== amendment.guardId) {
        throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.NOT_LIVE, 'The shift is no longer in progress.');
      }
      if (shift.endMs !== amendment.previousEndMs) {
        throw amendmentError(HttpStatus.CONFLICT, E.STALE, 'The shift end changed since this extension was proposed.');
      }
      try {
        await assertNoShiftClash(manager, amendment.guardId, new Date(shift.startMs), new Date(amendment.proposedEndMs), shift.id);
      } catch (error: any) {
        throw amendmentError(HttpStatus.CONFLICT, E.CLASH, String(error?.message || 'Guard has an overlapping shift assignment.'));
      }

      await manager.query(
        `UPDATE "shifts" SET "end" = $2::timestamp, "originalEnd" = COALESCE("originalEnd", $3::timestamp) WHERE "id" = $1`,
        [shift.id, toDbTimestamp(amendment.proposedEndMs), toDbTimestamp(amendment.originalEndMs)],
      );

      // Draft-only timesheet sync (owner rule D2): a timesheet in ANY locked state keeps its scheduled times and the
      // amendment is flagged for authorised payroll / billing review instead.
      const synced = await manager.query(
        `UPDATE "timesheets" t SET "scheduledEndAt" = $2::timestamp
          WHERE t."shiftId" = $1 AND t."approvalStatus" = 'draft' AND t."payrollStatus" = 'unpaid'
            AND t."billingStatus" = 'uninvoiced' AND t."payrollBatchId" IS NULL AND t."invoiceBatchId" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "client_weekly_approval_lines" l WHERE l."timesheetId" = t."id")
          RETURNING t."id"`,
        [shift.id, toDbTimestamp(amendment.proposedEndMs)],
      );
      const [{ total }] = await manager.query(`SELECT count(*)::int AS "total" FROM "timesheets" WHERE "shiftId" = $1`, [shift.id]);
      const syncedCount = this.updated(synced);
      const timesheetSync = Number(total) === 0 ? 'no_timesheet' : syncedCount === Number(total) ? 'synced_draft' : 'flagged_locked';

      const verbal = input.verbal;
      await manager.query(
        `UPDATE "shift_amendments"
            SET "status" = 'accepted', "agreedEnd" = "proposedEnd", "responseMethod" = $2, "respondedByUserId" = $3,
                "respondedAt" = ${CLOCK}, "responseReason" = $4, "verbalContactMethod" = $5, "verbalContactAt" = $6::timestamp,
                "verbalConfirmation" = $7, "timesheetSync" = $8, "payrollReviewRequired" = $9,
                "complianceReviewRequired" = "complianceReviewRequired" OR $10, "updatedAt" = now()
          WHERE "id" = $1 AND "status" = 'pending'`,
        [amendment.id, input.method, input.respondedByUserId, input.responseReason, verbal?.contactMethod ?? null,
          verbal ? toDbTimestamp(verbal.contactAtMs) : null, verbal?.confirmation ?? null, timesheetSync,
          timesheetSync === 'flagged_locked', assessment.complianceReviewRequired],
      );

      await this.audit(manager, amendment.companyId, input.respondedByUserId, 'shift_amendment.accepted', 'shift_amendment', amendment.id,
        { status: 'pending' },
        {
          status: 'accepted', responseMethod: input.method, responderRole: input.actorRole, agreedEnd: iso(amendment.proposedEndMs),
          ...(verbal ? { verbalContactMethod: verbal.contactMethod, verbalContactAt: iso(verbal.contactAtMs), verbalConfirmation: verbal.confirmation,
            staffReported: true } : {}),
          reason: input.responseReason, timesheetSync, warningsAtAcceptance: assessment.warnings,
        });
      await this.audit(manager, amendment.companyId, input.respondedByUserId, 'shift.extended', 'shift', shift.id,
        { end: iso(shift.endMs), originalEnd: iso(shift.originalEndMs) },
        { end: iso(amendment.proposedEndMs), originalEnd: iso(shift.originalEndMs ?? amendment.originalEndMs), amendmentId: amendment.id,
          responseMethod: input.method, billingReviewRequired: true });

      if (input.method === 'guard_app') {
        await this.notify(manager, [amendment.proposedByUserId], amendment.companyId, NotificationType.SHIFT_AMENDMENT_RESPONDED,
          'Shift extension accepted', `The Guard accepted the extension of shift ${shift.id} to ${iso(amendment.proposedEndMs)}.`);
      } else {
        const guardUser = await this.guardUserId(manager, amendment.guardId);
        if (guardUser) {
          await this.notifyGuard(manager, guardUser, amendment, NotificationType.SHIFT_AMENDMENT_RESPONDED, 'recorded',
            'Shift extension recorded by your company',
            `Your company recorded that you agreed by ${verbal?.contactMethod?.replace('_', ' ')} to extend your shift to ${iso(amendment.proposedEndMs)}. If you did not agree, report it in S4 or contact your company.`);
        }
      }
      return null;
    });
  }

  /**
   * Confirmation email for a staff-recorded agreement (owner rule D4). Best-effort and after the agreement committed:
   * the outcome is recorded as what S4 actually knows (provider accepted, captured, not configured, failed, no
   * address) — never as "delivered".
   */
  private async sendVerbalConfirmation(id: number) {
    const [row] = (await this.dataSource.query(
      `SELECT a."id", a."companyId", a."shiftId", a."verbalContactMethod",
              EXTRACT(EPOCH FROM a."previousEnd") * 1000 AS "previousEndMs", EXTRACT(EPOCH FROM a."agreedEnd") * 1000 AS "agreedEndMs",
              u."email", s."timezone", c."name" AS "companyName"
         FROM "shift_amendments" a
         JOIN "guard_profiles" g ON g."id" = a."guardId"
         JOIN "users" u ON u."id" = g."userId"
         JOIN "shifts" sh ON sh."id" = a."shiftId"
         LEFT JOIN "sites" s ON s."id" = sh."siteId"
         JOIN "companies" c ON c."id" = a."companyId"
        WHERE a."id" = $1`,
      [id],
    )) as Array<any>;
    if (!row) return;
    const zone = row.timezone || 'Europe/London';
    const fmt = (ms: number) =>
      new Intl.DateTimeFormat('en-GB', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(Number(ms)));
    let status: ConfirmationEmailStatus;
    const email = String(row.email || '').trim();
    if (!email || !email.includes('@')) {
      status = 'no_address';
    } else {
      const transport = this.emailService.transport;
      const text =
        `${row.companyName} recorded that you agreed by ${String(row.verbalContactMethod).replace('_', ' ')} to extend your shift ` +
        `from ${fmt(row.previousEndMs)} to ${fmt(row.agreedEndMs)} (${zone}).\n\n` +
        'This is a record made by your company, not an answer you gave in the S4 app. If you did not agree, contact your company ' +
        'straight away, or report it from the shift in S4 once your app is updated.';
      let ok = false;
      try {
        ok = await this.emailService.send({
          kind: 'shift_amendment_confirmation',
          to: email,
          subject: 'S4: a shift extension was recorded for you',
          text,
          html: `<p>${text.replace(/\n\n/g, '</p><p>')}</p>`,
        });
      } catch {
        ok = false;
      }
      status = !ok ? (transport === 'disabled' ? 'not_configured' : 'failed') : transport === 'resend' ? 'provider_accepted' : 'captured_outbox';
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE "shift_amendments" SET "confirmationEmailStatus" = $2, "confirmationEmailAttemptedAt" = ${CLOCK},
            "confirmationEmailAttempts" = "confirmationEmailAttempts" + 1, "updatedAt" = now() WHERE "id" = $1`,
        [id, status],
      );
      await this.audit(manager, Number(row.companyId), null, 'shift_amendment.confirmation_email', 'shift_amendment', id, null,
        { outcome: status, shiftId: Number(row.shiftId) });
    });
  }

  // ── Disputes of staff-recorded agreements ─────────────────────────────────────────────────────────

  async dispute(user: JwtPayload, id: number, dto: DisputeAmendmentDto) {
    const guard = await this.guardActor(user);
    const pre = await this.readAmendment(id);
    if (!pre || pre.guardId !== guard.guardId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');
    // No amendment state may change while the company has amendments switched off (owner rule: disabled = unusable).
    await this.requireEnabled(pre.companyId);
    await this.inTransaction(async (manager) => {
      await this.lockShift(manager, pre.shiftId);
      const amendment = await this.lockAmendment(manager, id, pre.shiftId);
      if (amendment.status === 'disputed') return null;
      if (amendment.status !== 'accepted' || amendment.responseMethod !== 'staff_recorded_verbal') {
        throw amendmentError(HttpStatus.CONFLICT, E.NOT_DISPUTABLE, 'Only an agreement recorded by your company can be disputed.');
      }
      // The extension stays in force while the dispute is reviewed (owner rule): Welfare cover must continue.
      await manager.query(
        `UPDATE "shift_amendments" SET "status" = 'disputed', "disputedAt" = ${CLOCK}, "disputeReason" = $2,
            "payrollReviewRequired" = true, "updatedAt" = now()
          WHERE "id" = $1 AND "status" = 'accepted'`,
        [id, dto.reason.trim()],
      );
      await this.audit(manager, amendment.companyId, guard.userId, 'shift_amendment.disputed', 'shift_amendment', id,
        { status: 'accepted' }, { status: 'disputed', reason: dto.reason.trim(), extensionKept: true });
      const managers = await this.companyManagerUserIds(manager, amendment.companyId);
      await this.notify(manager, managers, amendment.companyId, NotificationType.SHIFT_AMENDMENT_DISPUTED, 'Shift extension disputed',
        `The Guard disputes the recorded agreement to extend shift ${amendment.shiftId}. The extension stays in force until an Owner or Admin reviews it.`);
      return null;
    });
    return this.view(id, 'guard');
  }

  async resolveDispute(user: JwtPayload, id: number, dto: ResolveDisputeDto) {
    const actor = await this.companyActor(user, 'resolve_dispute');
    // No amendment state may change while the company has amendments switched off (owner rule: disabled = unusable).
    await this.requireEnabled(actor.companyId);
    const pre = await this.readAmendment(id);
    if (!pre || pre.companyId !== actor.companyId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');
    await this.inTransaction(async (manager) => {
      await this.lockShift(manager, pre.shiftId);
      const amendment = await this.lockAmendment(manager, id, pre.shiftId);
      if (amendment.status !== 'disputed') {
        throw amendmentError(HttpStatus.CONFLICT, E.NOT_OPEN, 'Only a disputed extension can be resolved.');
      }
      const status = dto.resolution === 'upheld' ? 'dispute_upheld' : 'dispute_corrected';
      await manager.query(
        `UPDATE "shift_amendments" SET "status" = $2, "disputeResolution" = $3, "disputeResolutionNote" = $4,
            "disputeResolvedByUserId" = $5, "disputeResolvedAt" = ${CLOCK}, "updatedAt" = now()
          WHERE "id" = $1 AND "status" = 'disputed'`,
        [id, status, dto.resolution, dto.note.trim(), actor.userId],
      );
      // Never a silent reversal: the shift's schedule is not changed by resolving a dispute. A correction is recorded
      // here and handled through the existing timesheet / payroll review.
      await this.audit(manager, actor.companyId, actor.userId, 'shift_amendment.dispute_resolved', 'shift_amendment', id,
        { status: 'disputed' }, { status, resolution: dto.resolution, note: dto.note.trim(), shiftEndChanged: false });
      const guardUser = await this.guardUserId(manager, amendment.guardId);
      if (guardUser) {
        await this.notifyGuard(manager, guardUser, amendment, NotificationType.SHIFT_AMENDMENT_RESPONDED, 'dispute_reviewed',
          'Shift extension dispute reviewed', `Your company reviewed your dispute (${dto.resolution}): ${dto.note.trim()}`);
      }
      return null;
    });
    return this.view(id);
  }

  // ── Expiry ────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Marks every lapsed open proposal expired, with an audit entry and a notification to the proposer. Locks only
   * amendment rows (never a shift), so it can never deadlock with the amendment paths or Book Off. Acceptance does
   * not depend on this running: it re-checks the statement clock itself.
   */
  async expireLapsedProposals(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query(
        `UPDATE "shift_amendments" SET "status" = 'expired', "expiredAt" = ${CLOCK}, "updatedAt" = now()
          WHERE "status" IN ${OPEN_SQL} AND "expiresAt" <= ${CLOCK}
          RETURNING "id", "companyId", "shiftId", "proposedByUserId", EXTRACT(EPOCH FROM "expiresAt") * 1000 AS "expiresAtMs"`,
      );
      const list = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<any>;
      for (const r of list) {
        await this.audit(manager, Number(r.companyId), null, 'shift_amendment.expired', 'shift_amendment', Number(r.id),
          { status: 'open' }, { status: 'expired', expiresAt: iso(Number(r.expiresAtMs)), shiftId: Number(r.shiftId) });
        await this.notify(manager, [Number(r.proposedByUserId)], Number(r.companyId), NotificationType.SHIFT_AMENDMENT_EXPIRED,
          'Shift extension expired', `The extension request for shift ${Number(r.shiftId)} expired without a decision. The shift was not extended.`);
      }
      return list.length;
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────────────

  async view(id: number, audience: Audience = 'company') {
    const a = await this.amendmentRepo.findOne({ where: { id } });
    if (!a) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');
    return this.present(a, audience);
  }

  /**
   * The amendment as an API answer. `audience` decides the fatigue figures: the Guard sees their own (every company's
   * shifts); a company sees only figures that come from its own shifts — the rest gap only when the deciding next
   * shift is its own (rows stored before this was recorded are withheld), and its own 7-day hours. Warnings and the
   * approval requirement are the same for both.
   */
  private present(a: ShiftAmendment, audience: Audience = 'company') {
    const t = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
    const open = OPEN_AMENDMENT_STATUSES.includes(a.status);
    const lapsed = open && new Date(a.expiresAt).getTime() <= Date.now();
    return {
      id: a.id,
      shiftId: a.shiftId,
      guardId: a.guardId,
      sequence: a.sequence,
      status: a.status,
      effectiveStatus: lapsed ? 'expired' : a.status,
      originalEnd: t(a.originalEnd),
      previousEnd: t(a.previousEnd),
      proposedEnd: t(a.proposedEnd),
      agreedEnd: t(a.agreedEnd),
      additionalMinutes: Math.round((new Date(a.proposedEnd).getTime() - new Date(a.previousEnd).getTime()) / 60_000),
      reason: a.reason,
      proposedByUserId: a.proposedByUserId,
      proposedAt: t(a.proposedAt),
      expiresAt: t(a.expiresAt),
      fatigue: presentFatigue(a.fatigueAssessment as StoredFatigueAssessment | null, audience),
      approvalRequired: a.approvalRequired,
      approvedByUserId: a.approvedByUserId,
      approvedAt: t(a.approvedAt),
      selfApproved: a.selfApproved,
      responseMethod: a.responseMethod,
      staffReported: a.responseMethod === 'staff_recorded_verbal',
      respondedByUserId: a.respondedByUserId,
      respondedAt: t(a.respondedAt),
      verbalContactMethod: a.verbalContactMethod,
      verbalContactAt: t(a.verbalContactAt),
      verbalConfirmation: a.verbalConfirmation,
      confirmationEmailStatus: a.confirmationEmailStatus,
      withdrawnAt: t(a.withdrawnAt),
      voidedReason: a.voidedReason,
      voidedAt: t(a.voidedAt),
      expiredAt: t(a.expiredAt),
      disputedAt: t(a.disputedAt),
      disputeReason: a.disputeReason,
      disputeResolution: a.disputeResolution,
      disputeResolutionNote: a.disputeResolutionNote,
      disputeResolvedAt: t(a.disputeResolvedAt),
      timesheetSync: a.timesheetSync,
      payrollReviewRequired: a.payrollReviewRequired,
      billingReviewRequired: a.billingReviewRequired,
      complianceReviewRequired: a.complianceReviewRequired,
    };
  }

  async listForShift(user: JwtPayload, shiftId: number) {
    const shift = await this.readShift(shiftId);
    if (user.role === UserRole.GUARD) {
      const guard = await this.guardActor(user);
      if (!shift || shift.guardId !== guard.guardId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift not found.');
    } else {
      const actor = await this.companyActor(user);
      if (!shift || shift.companyId !== actor.companyId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift not found.');
    }
    const rows = await this.amendmentRepo.find({ where: { shiftId }, order: { sequence: 'ASC' } });
    return {
      shiftId,
      originalEnd: shift.originalEndMs === null ? iso(shift.endMs) : iso(shift.originalEndMs),
      currentEnd: iso(shift.endMs),
      extended: shift.originalEndMs !== null,
      amendments: rows.map((a) => this.present(a, user.role === UserRole.GUARD ? 'guard' : 'company')),
    };
  }

  async findOne(user: JwtPayload, id: number) {
    const a = await this.amendmentRepo.findOne({ where: { id } });
    if (!a) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');
    if (user.role === UserRole.GUARD) {
      const guard = await this.guardActor(user);
      if (a.guardId !== guard.guardId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');
    } else {
      const actor = await this.companyActor(user);
      if (a.companyId !== actor.companyId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift extension not found.');
    }
    return this.present(a, user.role === UserRole.GUARD ? 'guard' : 'company');
  }

  /** The Guard's open requests and recent decisions (last 7 days), for the 1.2.0 app. Older builds never call it. */
  async listMine(user: JwtPayload) {
    const guard = await this.guardActor(user);
    const rows = await this.amendmentRepo
      .createQueryBuilder('a')
      .where('a.guardId = :guardId', { guardId: guard.guardId })
      .andWhere(`(a.status IN ('pending') OR a.updatedAt > now() - interval '7 days')`)
      .orderBy('a.id', 'DESC')
      .getMany();
    return rows.map((a) => this.present(a, 'guard'));
  }

  // ── Assessment (dry run) ──────────────────────────────────────────────────────────────────────────

  /**
   * What `propose` would decide for this end, without proposing: the same permission, company, enabled, live-shift,
   * eligibility, overlap and fatigue checks, but nothing is locked, written, notified or audited. `propose` repeats
   * every check under lock, so this answer is advice, never a reservation.
   *
   * The rest and 7-day checks count the Guard's shifts at every company (that is what keeps the Guard safe), but the
   * figures are only returned when they come from the requesting company's own shifts: another company's schedule is
   * never disclosed — only that a warning applies.
   */
  async assessProposal(user: JwtPayload, shiftId: number, proposedEnd: string) {
    const actor = await this.companyActor(user, 'propose');
    const policy = await this.requireEnabled(actor.companyId);
    const pre = await this.readShift(shiftId);
    if (!pre || pre.companyId !== actor.companyId) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Shift not found.');
    if (pre.status !== 'in_progress' || !pre.guardId) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.NOT_LIVE, 'Only an in-progress shift can be extended. Change a future shift with the ordinary edit.');
    }
    const [att] = (await this.dataSource.query(
      `SELECT bool_or("type" = $2) AS "bookedOn", bool_or("type" = $3) AS "bookedOff" FROM "effective_attendance_events" WHERE "shiftId" = $1`,
      [shiftId, AttendanceEventType.CHECK_IN, AttendanceEventType.CHECK_OUT],
    )) as Array<{ bookedOn: boolean | null; bookedOff: boolean | null }>;
    if (!att?.bookedOn || att?.bookedOff) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.NOT_LIVE, 'The Guard must be booked on, and not booked off, to extend this shift.');
    }
    const proposedEndMs = instantMs(proposedEnd, 'proposedEnd');
    if (proposedEndMs <= pre.endMs) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.NOT_LATER, 'The new end must be later than the current end of the shift.');
    }
    if (pre.endMs <= Date.now()) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.TOO_LATE, 'The shift has already reached its scheduled end. It can no longer be extended.');
    }
    const guardId = pre.guardId;
    const blockedBy: Array<{ code: string; message: string }> = [];
    try {
      await this.assertEligible(actor.companyId, guardId, pre, proposedEndMs);
    } catch (error: any) {
      const body = typeof error?.getResponse === 'function' ? (error.getResponse() as { code?: string; message?: string }) : null;
      if (!body?.code) throw error;
      blockedBy.push({ code: body.code, message: body.message ?? 'The Guard cannot take the extended shift.' });
    }
    if (!blockedBy.some((b) => b.code === E.CLASH)) {
      try {
        await assertNoShiftClash(this.dataSource.manager, guardId, new Date(pre.startMs), new Date(proposedEndMs), pre.id);
      } catch {
        blockedBy.push({ code: E.CLASH, message: 'Guard has an overlapping shift assignment.' });
      }
    }
    const [openRow] = (await this.dataSource.query(
      `SELECT "id" FROM "shift_amendments" WHERE "shiftId" = $1 AND "status" IN ${OPEN_SQL} AND "expiresAt" > ${CLOCK}`,
      [shiftId],
    )) as Array<{ id: number }>;
    if (openRow) blockedBy.push({ code: E.PENDING, message: 'This shift already has an extension waiting for a decision.' });

    const assessment = await this.assess(pre, guardId, proposedEndMs, policy);
    if (assessment.hardLimitExceeded) {
      blockedBy.push({ code: E.FATIGUE_LIMIT,
        message: `The extended shift would be ${assessment.totalScheduledHours} scheduled hours, over the company limit of ${policy.hardLimitHours}.` });
    }

    // Only this company's figures are disclosed (the same rule as every stored amendment's company view).
    const shown = companySafeAssessment(assessment);
    const [site] = (await this.dataSource.query(
      `SELECT s."timezone" FROM "shifts" sh LEFT JOIN "sites" s ON s."id" = sh."siteId" WHERE sh."id" = $1`,
      [pre.id],
    )) as Array<{ timezone: string | null }>;
    const timeZone = site?.timezone || 'Europe/London';
    const local = (ms: number) => new Intl.DateTimeFormat('en-GB', {
      timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(ms)).replace(',', ' ·').replace(/\//g, '-');

    return {
      shiftId: pre.id,
      timeZone,
      currentEnd: iso(pre.endMs),
      proposedEnd: iso(proposedEndMs),
      currentEndLocal: local(pre.endMs),
      proposedEndLocal: local(proposedEndMs),
      additionalMinutes: Math.round((proposedEndMs - pre.endMs) / 60_000),
      basis: 'scheduled_hours' as const,
      totalScheduledHours: assessment.totalScheduledHours,
      warnings: assessment.warnings,
      approvalRequired: assessment.approvalRequired,
      approvalReasons: assessment.approvalReasons,
      hardLimitExceeded: assessment.hardLimitExceeded,
      complianceReviewRequired: assessment.complianceReviewRequired,
      // Figures from this company's shifts only; null when the deciding shift belongs to another company.
      restHoursBeforeNextShift: shown.restHoursBeforeNextShift,
      restFiguresWithheld: shown.restFiguresWithheld,
      companySevenDayScheduledHours: shown.companySevenDayScheduledHours,
      sevenDayIncludesOtherWork: shown.sevenDayIncludesOtherWork,
      thresholds: assessment.thresholds,
      blockedBy,
      canPropose: blockedBy.length === 0,
    };
  }

  // ── Staff directory ───────────────────────────────────────────────────────────────────────────────

  /**
   * The requesting company's staff who can act on amendments (Owner, Admin, Operations, Control Room), for naming
   * people in the amendment history and (Owner/Admin only) for the Control Room authorisation switch. Identifier, display name and role only: never an email, phone, credential or
   * anything about another company. A person without a name on file is shown by role.
   */
  async listStaff(user: JwtPayload) {
    const actor = await this.companyActor(user);
    const manager = actor.role === CompanyMembershipRole.OWNER || actor.role === CompanyMembershipRole.ADMIN;
    const rows = (await this.dataSource.query(
      `SELECT u."id" AS "userId", u."firstName", u."lastName", 'owner' AS "role", false AS "canAmendShifts", false AS "canManageAttendance"
         FROM "companies" c JOIN "users" u ON u."id" = c."userId"
        WHERE c."id" = $1
       UNION ALL
       SELECT u."id", u."firstName", u."lastName", m."membershipRole"::text, m."canAmendShifts", m."canManageAttendance"
         FROM "company_memberships" m JOIN "users" u ON u."id" = m."userId"
        WHERE m."companyId" = $1 AND m."status" = $2
          AND m."membershipRole"::text IN ('owner', 'admin', 'operations', 'control_room')
          AND m."userId" <> (SELECT "userId" FROM "companies" WHERE "id" = $1)
        ORDER BY 1`,
      [actor.companyId, CompanyMembershipStatus.ACTIVE],
    )) as Array<{ userId: number; firstName: string | null; lastName: string | null; role: string; canAmendShifts: boolean; canManageAttendance: boolean }>;
    const roleWord: Record<string, string> = { owner: 'Owner', admin: 'Admin', operations: 'Operations', control_room: 'Control Room' };
    return {
      canManageControlRoom: manager,
      staff: rows.map((r) => {
        const name = [r.firstName, r.lastName].map((p) => (p ?? '').trim()).filter(Boolean).join(' ');
        const role = String(r.role);
        return {
          userId: Number(r.userId),
          displayName: name || `${roleWord[role] ?? 'Staff'} (staff #${Number(r.userId)})`,
          role,
          isYou: Number(r.userId) === actor.userId,
          // Amendment authorisation is shown only to those who can change it, and only where it applies.
          ...(manager && role === CompanyMembershipRole.CONTROL_ROOM ? { canAmendShifts: Boolean(r.canAmendShifts), canManageAttendance: Boolean(r.canManageAttendance) } : {}),
        };
      }),
    };
  }

  // ── Policy and authorisation ──────────────────────────────────────────────────────────────────────

  async getPolicy(user: JwtPayload) {
    const actor = await this.companyActor(user);
    return this.policyFor(actor.companyId);
  }

  /**
   * Owner / Admin change the thresholds, only ever stricter than the platform safety limits. They cannot switch
   * amendments on or off: that stays an S4 decision (D5), and saving thresholds keeps whatever is in force.
   */
  async updatePolicy(user: JwtPayload, dto: UpdateShiftPolicyDto) {
    const actor = await this.companyActor(user, 'approve');
    const before = await this.policyFor(actor.companyId);
    const next = {
      fatigueWarningHours: dto.fatigueWarningHours ?? before.fatigueWarningHours,
      approvalRequiredHours: dto.approvalRequiredHours ?? before.approvalRequiredHours,
      hardLimitHours: dto.hardLimitHours === undefined ? before.hardLimitHours : dto.hardLimitHours,
      minRestHours: dto.minRestHours ?? before.minRestHours,
      weeklyReviewHours: dto.weeklyReviewHours ?? before.weeklyReviewHours,
      lastMinuteWarningMinutes: dto.lastMinuteWarningMinutes ?? before.lastMinuteWarningMinutes,
    };
    if (next.fatigueWarningHours > next.approvalRequiredHours || (next.hardLimitHours !== null && next.hardLimitHours < next.approvalRequiredHours)) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.FORBIDDEN,
        'Thresholds must be in order: warning ≤ approval ≤ hard limit.');
    }
    const violations = platformSafetyViolations(next);
    if (violations.length) {
      throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.POLICY_WEAKER_THAN_PLATFORM,
        `${violations.map((v) => v.message).join(' ')} A company can make these safeguards stricter, never weaker.`,
        { violations: violations.map(({ field, limit }) => ({ field, limit })) });
    }
    await this.dataSource.transaction(async (manager) => {
      // A first save writes the switch that is in force (the standard default, on) rather than leaving it to the
      // column default; a later save never touches it.
      await manager.query(
        `INSERT INTO "company_shift_policies" ("companyId", "fatigueWarningHours", "approvalRequiredHours", "hardLimitHours",
            "minRestHours", "weeklyReviewHours", "lastMinuteWarningMinutes", "updatedByUserId", "amendmentsEnabled")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT ("companyId") DO UPDATE SET "fatigueWarningHours" = EXCLUDED."fatigueWarningHours",
            "approvalRequiredHours" = EXCLUDED."approvalRequiredHours", "hardLimitHours" = EXCLUDED."hardLimitHours",
            "minRestHours" = EXCLUDED."minRestHours", "weeklyReviewHours" = EXCLUDED."weeklyReviewHours",
            "lastMinuteWarningMinutes" = EXCLUDED."lastMinuteWarningMinutes", "updatedByUserId" = EXCLUDED."updatedByUserId",
            "updatedAt" = now()`,
        [actor.companyId, next.fatigueWarningHours, next.approvalRequiredHours, next.hardLimitHours, next.minRestHours,
          next.weeklyReviewHours, next.lastMinuteWarningMinutes, actor.userId, before.amendmentsEnabled],
      );
      const { source: _s, amendmentsEnabled: _e, ...beforeThresholds } = before;
      await this.audit(manager, actor.companyId, actor.userId, 'company_shift_policy.updated', 'company', actor.companyId, beforeThresholds, next);
    });
    return this.policyFor(actor.companyId);
  }

  /** Per-person Control Room authorisation, granted or revoked by an Owner / Admin (staff.manage). */
  async setControlRoomAuthorisation(user: JwtPayload, targetUserId: number, canAmendShifts: boolean) {
    const actor = await this.companyActor(user);
    if (![CompanyMembershipRole.OWNER, CompanyMembershipRole.ADMIN].includes(actor.role)) {
      throw amendmentError(HttpStatus.FORBIDDEN, E.FORBIDDEN, 'Only an Owner or Admin can authorise Control Room staff.');
    }
    return this.dataSource.transaction(async (manager) => {
      const [membership] = await manager.query(
        `SELECT "id", "membershipRole", "canAmendShifts" FROM "company_memberships"
          WHERE "userId" = $1 AND "companyId" = $2 AND "status" = 'active' FOR UPDATE`,
        [targetUserId, actor.companyId],
      );
      if (!membership) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Staff member not found.');
      if (membership.membershipRole !== CompanyMembershipRole.CONTROL_ROOM) {
        throw amendmentError(HttpStatus.UNPROCESSABLE_ENTITY, E.FORBIDDEN, 'Per-person authorisation applies to Control Room members only.');
      }
      await manager.query(`UPDATE "company_memberships" SET "canAmendShifts" = $2, "updatedAt" = now() WHERE "id" = $1`, [membership.id, canAmendShifts]);
      await this.audit(manager, actor.companyId, actor.userId, 'company_membership.amendment_authorisation', 'company_membership',
        Number(membership.id), { canAmendShifts: Boolean(membership.canAmendShifts) }, { canAmendShifts, targetUserId });
      return { userId: targetUserId, canAmendShifts };
    });
  }

  /** S4 platform administrator only: switch Live Shift Amendments on or off for one company (owner decision D5). */
  async setCompanyEnabled(user: JwtPayload, companyId: number, enabled: boolean) {
    if (user.role !== UserRole.ADMIN) throw amendmentError(HttpStatus.FORBIDDEN, E.FORBIDDEN, 'Only S4 can activate shift extensions.');
    return this.dataSource.transaction(async (manager) => {
      const [company] = await manager.query(`SELECT "id" FROM "companies" WHERE "id" = $1`, [companyId]);
      if (!company) throw amendmentError(HttpStatus.NOT_FOUND, E.NOT_FOUND, 'Company not found.');
      const [before] = await manager.query(`SELECT "amendmentsEnabled" FROM "company_shift_policies" WHERE "companyId" = $1`, [companyId]);
      await manager.query(
        `INSERT INTO "company_shift_policies" ("companyId", "amendmentsEnabled", "updatedByUserId") VALUES ($1, $2, $3)
         ON CONFLICT ("companyId") DO UPDATE SET "amendmentsEnabled" = EXCLUDED."amendmentsEnabled",
            "updatedByUserId" = EXCLUDED."updatedByUserId", "updatedAt" = now()`,
        [companyId, enabled, user.sub],
      );
      await this.audit(manager, companyId, user.sub, 'company_shift_policy.amendments_enabled', 'company', companyId,
        // The state in force before: the company's row, or the standard default when it has none.
        { amendmentsEnabled: before ? Boolean(before.amendmentsEnabled) : DEFAULT_SHIFT_POLICY.amendmentsEnabled },
        { amendmentsEnabled: enabled, by: 'platform_admin' });
      return { companyId, amendmentsEnabled: enabled };
    });
  }
}
