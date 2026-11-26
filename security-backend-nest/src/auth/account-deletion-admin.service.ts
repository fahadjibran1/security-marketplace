import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ClientPortalUser } from '../client-portal-user/entities/client-portal-user.entity';
import { CompanyVerificationStatus } from '../company/company-verification';
import { User, UserRole, UserStatus } from '../user/entities/user.entity';
import {
  AccountDeletionService,
  deletedClientPortalEmail,
  deletionCompletedAuditData,
  S4_SUPPORT_EMAIL,
} from './account-deletion.service';
import { DELETED_ACCOUNT_PASSWORD_SENTINEL } from './password-policy';
import { JwtPayload } from './types/jwt-payload.type';

/** Machine-readable refusals, so the admin screen can say exactly why a request cannot be completed yet. */
export const ACCOUNT_DELETION_ADMIN_CODES = {
  NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  NOT_REQUESTED: 'ACCOUNT_DELETION_NOT_REQUESTED',
  ALREADY_DELETED: 'ACCOUNT_ALREADY_DELETED',
  SELF: 'ACCOUNT_DELETION_SELF',
  LAST_PLATFORM_ADMIN: 'ACCOUNT_DELETION_LAST_PLATFORM_ADMIN',
  /** The owner still owns a company that is not closed (approved or pending verification). */
  OWNER_HAS_ACTIVE_COMPANY: 'ACCOUNT_DELETION_OWNER_HAS_ACTIVE_COMPANY',
  /** A closed company the owner owns still has shifts in progress or scheduled to start in the future. */
  COMPANY_SHIFTS_OUTSTANDING: 'ACCOUNT_DELETION_COMPANY_SHIFTS_OUTSTANDING',
  /** An admin-recorded (emailed) request needs identityConfirmed: true to complete. */
  IDENTITY_NOT_CONFIRMED: 'ACCOUNT_DELETION_IDENTITY_NOT_CONFIRMED',
  VERIFICATION_NOTE_REQUIRED: 'ACCOUNT_DELETION_VERIFICATION_NOTE_REQUIRED',
} as const;
const CODES = ACCOUNT_DELETION_ADMIN_CODES;

/** How an administrator checked that an emailed request really came from the account holder. */
export const DELETION_VERIFICATION_METHODS = ['request_from_registered_email', 'confirmed_in_app_by_user', 'other_verified'] as const;
export type DeletionVerificationMethod = (typeof DELETION_VERIFICATION_METHODS)[number];
export const DELETION_VERIFICATION_NOTE_MAX = 200;

/** A company counts as closed for operations only when suspended or rejected (decided through Company verification). */
export const CLOSED_COMPANY_STATUSES: readonly string[] = [CompanyVerificationStatus.SUSPENDED, CompanyVerificationStatus.REJECTED];

/** Shift statuses that will never run again; any other shift starting in the future is an obligation. */
const FINISHED_SHIFT_STATUSES = ['completed', 'cancelled', 'rejected', 'missed'];

export type DeletionAccountType = 'guard' | 'company_owner' | 'company_member' | 'platform_admin' | 'client_user' | 'client_portal';
export type DeletionRequestedVia = 'in_app' | 'admin_recorded';

/**
 * One owned company's open obligations: ids and counts only. Informational, except closure and shifts, which block.
 * Each count is a table that exists in the schema.
 */
export interface OwnedCompanySummary {
  companyId: number;
  verificationStatus: string;
  /** Suspended or rejected. */
  closed: boolean;
  shiftsInProgress: number;
  /** Not finished, not in progress, and starting after now. */
  futureShifts: number;
  /** timesheets.approvalStatus = submitted. */
  timesheetsAwaitingApproval: number;
  /** Approved timesheets whose payrollStatus is not paid. */
  approvedTimesheetsNotPaid: number;
  /** invoice_batches not yet paid (draft, finalised, issued). */
  invoiceBatchesNotPaid: number;
  /** payroll_batches not yet paid (draft, finalised). */
  payrollBatchesNotPaid: number;
  /** client_weekly_approval_requests pending approval or disputed. */
  clientWeeklyApprovalsOpen: number;
  /** client_shift_disputes still open. */
  clientShiftDisputesOpen: number;
}

export interface OwnedCompanyView {
  id: number;
  name: string;
  verificationStatus: string;
  closed: boolean;
  shiftsInProgress: number;
  futureShifts: number;
}

/** One pending request in the Platform Admin queue. */
export interface DeletionRequestView {
  kind: 'user' | 'client_portal_user';
  id: number;
  email: string;
  name: string | null;
  role: string;
  accountType: DeletionAccountType;
  requestedAt: string;
  requestedBy: 'self' | 'admin';
  /** Companies this account owns. Deletion never closes them: each must be closed (or transferred) first. */
  companies: OwnedCompanyView[];
  /** A client login's client and the security company that holds that client's records. */
  client: { id: number; name: string; companyId: number | null; companyName: string | null } | null;
  /** Why it cannot be completed right now (for the calling administrator), or null. */
  blockedCode: string | null;
  blockedReason: string | null;
}

/** The pre-completion summary for an S4 user account: ids and counts only. */
export interface DeletionPreview {
  kind: 'user';
  userId: number;
  accountType: DeletionAccountType;
  requestedVia: DeletionRequestedVia;
  /** Completing needs identityConfirmed: true (an admin-recorded request). */
  identityConfirmationRequired: boolean;
  companies: OwnedCompanySummary[];
  blockedCode: string | null;
  canComplete: boolean;
}

/** What a deleted client portal login leaves behind: the company's own records about its client, and the audit trail. */
export const CLIENT_PORTAL_RETAINED_RECORDS = ['client_records_held_by_the_company', 'client_weekly_approvals', 'audit_logs'] as const;

const REQUEST_ACTIONS = ['account.deletion_requested', 'account.deletion_requested_by_admin'];

const refusal = (status: HttpStatus, code: string, message: string, details?: Record<string, unknown>) =>
  new HttpException({ statusCode: status, code, message, ...(details ? { details } : {}) }, status);

export const OWNER_HAS_ACTIVE_COMPANY_MESSAGE =
  'This account still owns a company that is not closed. Deleting a personal account never closes a company. ' +
  'The request stays pending until one of these happens: (a) S4 makes a separate, authorised decision to close the ' +
  'company on the Company verification screen (suspend or reject), which is audited there on its own; or (b) the owner ' +
  `arranges a transfer of ownership with S4 support at ${S4_SUPPORT_EMAIL}.`;

export const COMPANY_SHIFTS_OUTSTANDING_MESSAGE =
  'A closed company this account owns still has shifts in progress or scheduled to start in the future. The request ' +
  'stays pending until each of those shifts has finished or been cancelled.';

/** Why an owner's request cannot be completed yet, from the company summaries; null when nothing blocks it. */
function ownerBlock(companies: OwnedCompanySummary[]): HttpException | null {
  const open = companies.filter((c) => !c.closed);
  if (open.length) {
    return refusal(HttpStatus.CONFLICT, CODES.OWNER_HAS_ACTIVE_COMPANY, OWNER_HAS_ACTIVE_COMPANY_MESSAGE, {
      companies: open.map((c) => ({ id: c.companyId, verificationStatus: c.verificationStatus })),
    });
  }
  const busy = companies.filter((c) => c.shiftsInProgress > 0 || c.futureShifts > 0);
  if (busy.length) {
    return refusal(HttpStatus.CONFLICT, CODES.COMPANY_SHIFTS_OUTSTANDING, COMPANY_SHIFTS_OUTSTANDING_MESSAGE, {
      companies: busy.map((c) => ({ id: c.companyId, shiftsInProgress: c.shiftsInProgress, futureShifts: c.futureShifts })),
    });
  }
  return null;
}

const responseOf = (error: HttpException) => error.getResponse() as { code: string; message: string };

/**
 * The Platform Admin side of account deletion: a queue of recorded requests (from any account type, including ones that
 * cannot finish deletion themselves), a pre-completion summary, and the action that completes one.
 *
 *   - Anonymisation is AccountDeletionService.anonymiseUserInTransaction, the routine self-service deletion uses.
 *   - Personal deletion never closes a company and never touches its memberships or its members' sessions. An owner's
 *     request is refused while any owned company is not closed (approved or pending): closing is a separate, authorised
 *     Company verification decision, audited there; a transfer of ownership is arranged with S4 support.
 *   - A closed company with shifts in progress or starting in the future also blocks completion.
 *   - No row is deleted and nothing is purged.
 *   - An admin-recorded (emailed) request records how identity was verified, and completing it needs identityConfirmed.
 *   - A Platform Admin account can be completed only by a different Platform Admin, and never the last active one.
 *   - Audited as account.deletion_requested_by_admin and account.deletion_completed_by_admin, with ids only.
 */
@Injectable()
export class AccountDeletionAdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly deletion: AccountDeletionService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ── reads ───────────────────────────────────────────────────────────────────────────────────────────────

  /** Every company the user owns (as companies.userId or as an active owner membership), with its open obligations. */
  private async ownedCompanySummaries(
    userId: number,
    manager: EntityManager = this.dataSource.manager,
    lock = false,
  ): Promise<Array<OwnedCompanySummary & { name: string }>> {
    // With lock, the owned companies are share-locked so a verification decision (e.g. reinstating one) cannot slip in
    // between the check and the anonymisation. Never writes.
    const ids: Array<{ id: number }> = await manager.query(
      `SELECT c.id FROM companies c
        WHERE c."userId" = $1
           OR c.id IN (SELECT m."companyId" FROM company_memberships m
                        WHERE m."userId" = $1 AND m."membershipRole" = 'owner' AND m.status = 'active')
        ORDER BY c.id${lock ? ' FOR SHARE OF c' : ''}`,
      [userId],
    );
    if (!ids.length) return [];
    const rows: Array<Record<string, string | number>> = await manager.query(
      `SELECT c.id, c.name, c."verificationStatus"::text AS "verificationStatus",
              (SELECT count(*) FROM shifts s WHERE s."companyId" = c.id AND s.status = 'in_progress') AS "shiftsInProgress",
              (SELECT count(*) FROM shifts s WHERE s."companyId" = c.id AND s.start > now()
                  AND s.status <> 'in_progress' AND NOT (s.status = ANY($2::text[]))) AS "futureShifts",
              (SELECT count(*) FROM timesheets t WHERE t."companyId" = c.id AND t."approvalStatus"::text = 'submitted') AS "timesheetsAwaitingApproval",
              (SELECT count(*) FROM timesheets t WHERE t."companyId" = c.id AND t."approvalStatus"::text = 'approved'
                  AND t."payrollStatus"::text <> 'paid') AS "approvedTimesheetsNotPaid",
              (SELECT count(*) FROM invoice_batches i WHERE i."companyId" = c.id AND i.status::text <> 'paid') AS "invoiceBatchesNotPaid",
              (SELECT count(*) FROM payroll_batches p WHERE p."companyId" = c.id AND p.status::text <> 'paid') AS "payrollBatchesNotPaid",
              (SELECT count(*) FROM client_weekly_approval_requests w WHERE w."companyId" = c.id
                  AND w.status::text IN ('pending_approval', 'disputed')) AS "clientWeeklyApprovalsOpen",
              (SELECT count(*) FROM client_shift_disputes d
                 JOIN client_weekly_approval_requests w ON w.id = d."weeklyApprovalRequestId"
                WHERE w."companyId" = c.id AND d.status::text = 'open') AS "clientShiftDisputesOpen"
         FROM companies c
        WHERE c.id = ANY($1::int[])
        ORDER BY c.id`,
      [ids.map((r) => Number(r.id)), FINISHED_SHIFT_STATUSES],
    );
    return rows.map((r) => ({
      companyId: Number(r.id),
      name: String(r.name),
      verificationStatus: String(r.verificationStatus),
      closed: CLOSED_COMPANY_STATUSES.includes(String(r.verificationStatus)),
      shiftsInProgress: Number(r.shiftsInProgress),
      futureShifts: Number(r.futureShifts),
      timesheetsAwaitingApproval: Number(r.timesheetsAwaitingApproval),
      approvedTimesheetsNotPaid: Number(r.approvedTimesheetsNotPaid),
      invoiceBatchesNotPaid: Number(r.invoiceBatchesNotPaid),
      payrollBatchesNotPaid: Number(r.payrollBatchesNotPaid),
      clientWeeklyApprovalsOpen: Number(r.clientWeeklyApprovalsOpen),
      clientShiftDisputesOpen: Number(r.clientShiftDisputesOpen),
    }));
  }

  private async activePlatformAdminIds(manager: EntityManager, lock: boolean): Promise<number[]> {
    const rows: Array<{ id: number }> = await manager.query(
      `SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND "deletionCompletedAt" IS NULL ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    );
    return rows.map((r) => Number(r.id));
  }

  private async requestedByAdmin(
    entityType: 'user' | 'client_portal_user',
    id: number,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<boolean> {
    const rows: Array<{ n: string }> = await manager.query(
      `SELECT count(*) AS n FROM audit_logs WHERE "entityType" = $1 AND "entityId" = $2 AND action = 'account.deletion_requested_by_admin'`,
      [entityType, id],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  private accountTypeOf(user: User, ownsCompany: boolean): DeletionAccountType {
    if (user.role === UserRole.ADMIN) return 'platform_admin';
    if (ownsCompany) return 'company_owner';
    if (user.role === UserRole.GUARD) return 'guard';
    if (user.role === UserRole.CLIENT_ADMIN || user.role === UserRole.CLIENT_VIEWER) return 'client_user';
    return 'company_member';
  }

  /** Why the calling admin cannot complete this user's request now (self, last admin, an owned company), or null. */
  private blockFor(
    admin: JwtPayload,
    user: User,
    accountType: DeletionAccountType,
    companies: OwnedCompanySummary[],
    activeAdmins: number[],
  ): { code: string; reason: string } | null {
    if (user.id === admin.sub) {
      return { code: CODES.SELF, reason: 'You cannot complete the deletion of your own account. Another Platform Admin must do it.' };
    }
    if (accountType === 'platform_admin' && activeAdmins.filter((id) => id !== user.id).length === 0) {
      return { code: CODES.LAST_PLATFORM_ADMIN, reason: 'This is the last active Platform Admin account.' };
    }
    const owner = ownerBlock(companies);
    return owner ? { code: responseOf(owner).code, reason: responseOf(owner).message } : null;
  }

  private async userView(admin: JwtPayload, user: User, activeAdmins: number[]): Promise<DeletionRequestView> {
    const summaries = await this.ownedCompanySummaries(user.id);
    const accountType = this.accountTypeOf(user, summaries.length > 0);
    const block = this.blockFor(admin, user, accountType, summaries, activeAdmins);
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    return {
      kind: 'user',
      id: user.id,
      email: user.email,
      name: name || null,
      role: user.role,
      accountType,
      requestedAt: user.deletionRequestedAt!.toISOString(),
      requestedBy: (await this.requestedByAdmin('user', user.id)) ? 'admin' : 'self',
      companies: summaries.map((c) => ({
        id: c.companyId,
        name: c.name,
        verificationStatus: c.verificationStatus,
        closed: c.closed,
        shiftsInProgress: c.shiftsInProgress,
        futureShifts: c.futureShifts,
      })),
      client: null,
      blockedCode: block?.code ?? null,
      blockedReason: block?.reason ?? null,
    };
  }

  private async clientPortalView(login: ClientPortalUser, requestedAt: Date): Promise<DeletionRequestView> {
    const name = [login.firstName, login.lastName].filter(Boolean).join(' ').trim();
    return {
      kind: 'client_portal_user',
      id: login.id,
      email: login.email,
      name: name || null,
      role: login.role,
      accountType: 'client_portal',
      requestedAt: requestedAt.toISOString(),
      requestedBy: (await this.requestedByAdmin('client_portal_user', login.id)) ? 'admin' : 'self',
      companies: [],
      client: login.client
        ? { id: login.client.id, name: login.client.name, companyId: login.client.company?.id ?? null, companyName: login.client.company?.name ?? null }
        : null,
      blockedCode: null,
      blockedReason: null,
    };
  }

  /** Every recorded request that has not been completed, oldest first. */
  async listPending(admin: JwtPayload): Promise<DeletionRequestView[]> {
    const activeAdmins = await this.activePlatformAdminIds(this.dataSource.manager, false);
    const users = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('user')
      .where('user.deletionRequestedAt IS NOT NULL')
      .andWhere('user.deletionCompletedAt IS NULL')
      .orderBy('user.deletionRequestedAt', 'ASC')
      .addOrderBy('user.id', 'ASC')
      .getMany();
    const views: DeletionRequestView[] = [];
    for (const user of users) views.push(await this.userView(admin, user, activeAdmins));

    const pendingLogins: Array<{ id: number; at: Date }> = await this.dataSource.query(
      `SELECT cpu.id, MIN(a."createdAt") AS at
         FROM audit_logs a JOIN client_portal_users cpu ON cpu.id = a."entityId"
        WHERE a."entityType" = 'client_portal_user' AND a.action = ANY($1)
          AND cpu.email NOT LIKE 'deleted-client-%@deleted.invalid'
        GROUP BY cpu.id`,
      [REQUEST_ACTIONS],
    );
    for (const row of pendingLogins) {
      const login = await this.dataSource.getRepository(ClientPortalUser).findOne({ where: { id: Number(row.id) } });
      if (login) views.push(await this.clientPortalView(login, new Date(row.at)));
    }
    return views.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  /**
   * What completing this user's request would meet: each owned company's verification status, shifts and other open
   * obligations, as ids and counts only. Read-only; informational except for the blocking code.
   */
  async previewUser(admin: JwtPayload, userId: number): Promise<DeletionPreview> {
    const user = await this.dataSource.getRepository(User).findOne({ where: { id: userId } });
    if (!user) throw refusal(HttpStatus.NOT_FOUND, CODES.NOT_FOUND, 'Account not found.');
    const summaries = await this.ownedCompanySummaries(userId);
    const accountType = this.accountTypeOf(user, summaries.length > 0);
    let blockedCode: string | null;
    if (user.deletionCompletedAt) blockedCode = CODES.ALREADY_DELETED;
    else if (!user.deletionRequestedAt) blockedCode = CODES.NOT_REQUESTED;
    else {
      const activeAdmins = await this.activePlatformAdminIds(this.dataSource.manager, false);
      blockedCode = this.blockFor(admin, user, accountType, summaries, activeAdmins)?.code ?? null;
    }
    const byAdmin = await this.requestedByAdmin('user', userId);
    return {
      kind: 'user',
      userId,
      accountType,
      requestedVia: byAdmin ? 'admin_recorded' : 'in_app',
      identityConfirmationRequired: byAdmin,
      companies: summaries.map(({ name: _name, ...counts }) => counts),
      blockedCode,
      canComplete: blockedCode === null,
    };
  }

  // ── recording an emailed request ────────────────────────────────────────────────────────────────────────

  /**
   * Record a deletion request received by email (the public /account-deletion process) for the account that uses
   * `email`, with how the administrator verified that it came from the account holder. Idempotent: an account that
   * already has a request keeps its first one and nothing new is audited.
   */
  async recordRequestByEmail(admin: JwtPayload, rawEmail: string, verificationMethod: DeletionVerificationMethod, rawNote: string) {
    const verificationNote = (rawNote ?? '').trim();
    if (!verificationNote) {
      throw refusal(HttpStatus.BAD_REQUEST, CODES.VERIFICATION_NOTE_REQUIRED, 'Say briefly how the request was verified.');
    }
    const verification = { requestedVia: 'admin_recorded' as const, source: 'emailed_request', verificationMethod, verificationNote };
    const email = rawEmail.trim().toLowerCase();
    const user = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('user')
      .where('LOWER(user.email) = :email', { email })
      .getOne();
    if (user) {
      if (user.deletionCompletedAt) {
        throw refusal(HttpStatus.CONFLICT, CODES.ALREADY_DELETED, 'This account has already been deleted.');
      }
      let alreadyRequested = true;
      if (!user.deletionRequestedAt) {
        const now = new Date();
        const result = await this.dataSource
          .getRepository(User)
          .createQueryBuilder()
          .update(User)
          .set({ deletionRequestedAt: now })
          .where('id = :id AND "deletionRequestedAt" IS NULL AND "deletionCompletedAt" IS NULL', { id: user.id })
          .execute();
        if (result.affected) {
          alreadyRequested = false;
          await this.auditLog.log({
            user: { id: admin.sub },
            action: 'account.deletion_requested_by_admin',
            entityType: 'user',
            entityId: user.id,
            afterData: { targetUserId: user.id, requestedAt: now.toISOString(), ...verification },
          });
        }
      }
      const fresh = await this.dataSource.getRepository(User).findOneOrFail({ where: { id: user.id } });
      return { alreadyRequested, request: await this.userView(admin, fresh, await this.activePlatformAdminIds(this.dataSource.manager, false)) };
    }

    const login = await this.dataSource
      .getRepository(ClientPortalUser)
      .createQueryBuilder('cpu')
      .leftJoinAndSelect('cpu.client', 'client')
      .leftJoinAndSelect('client.company', 'company')
      .where('LOWER(cpu.email) = :email', { email })
      .getOne();
    if (!login) {
      throw refusal(HttpStatus.NOT_FOUND, CODES.NOT_FOUND, 'No S4 account uses that email address.');
    }
    let requestedAt = await this.deletion.clientPortalRequestedAt(login.id);
    const alreadyRequested = !!requestedAt;
    if (!requestedAt) {
      requestedAt = new Date();
      await this.auditLog.log({
        company: login.client?.company?.id ? { id: login.client.company.id } : null,
        user: { id: admin.sub },
        action: 'account.deletion_requested_by_admin',
        entityType: 'client_portal_user',
        entityId: login.id,
        afterData: { targetClientPortalUserId: login.id, requestedAt: requestedAt.toISOString(), ...verification },
      });
      requestedAt = (await this.deletion.clientPortalRequestedAt(login.id)) ?? requestedAt;
    }
    return { alreadyRequested, request: await this.clientPortalView(login, requestedAt) };
  }

  // ── completing a request ────────────────────────────────────────────────────────────────────────────────

  /** An admin-recorded request completes only when the administrator confirms the requester's identity. */
  private async identityCheck(
    entityType: 'user' | 'client_portal_user',
    id: number,
    identityConfirmed: boolean | undefined,
    manager?: EntityManager,
  ): Promise<{ requestedVia: DeletionRequestedVia; identityConfirmed: boolean | null }> {
    const byAdmin = await this.requestedByAdmin(entityType, id, manager);
    if (byAdmin && identityConfirmed !== true) {
      throw refusal(
        HttpStatus.BAD_REQUEST,
        CODES.IDENTITY_NOT_CONFIRMED,
        'This request was recorded from an email. Confirm you have verified that the requester is the account holder (identityConfirmed) before completing it.',
      );
    }
    return { requestedVia: byAdmin ? 'admin_recorded' : 'in_app', identityConfirmed: byAdmin ? true : null };
  }

  /** Complete a recorded request for an S4 user account (any role). Never closes a company or deletes a row. */
  async completeUser(admin: JwtPayload, userId: number, identityConfirmed?: boolean) {
    const target = await this.dataSource.getRepository(User).findOne({ where: { id: userId } });
    if (!target) throw refusal(HttpStatus.NOT_FOUND, CODES.NOT_FOUND, 'Account not found.');
    if (userId === admin.sub) {
      throw refusal(HttpStatus.FORBIDDEN, CODES.SELF, 'You cannot complete the deletion of your own account. Another Platform Admin must do it.');
    }
    if (target.deletionCompletedAt) throw refusal(HttpStatus.CONFLICT, CODES.ALREADY_DELETED, 'This account has already been deleted.');
    if (!target.deletionRequestedAt) {
      throw refusal(HttpStatus.CONFLICT, CODES.NOT_REQUESTED, 'No deletion request is recorded for this account. Record the request first.');
    }
    const identity = await this.identityCheck('user', userId, identityConfirmed);

    const result = await this.dataSource.transaction(async (manager) => {
      // Platform Admin rows first, locked, so two administrators cannot remove each other (or the last one) at once.
      if (target.role === UserRole.ADMIN) {
        const active = await this.activePlatformAdminIds(manager, true);
        if (active.filter((id) => id !== userId).length === 0) {
          throw refusal(HttpStatus.CONFLICT, CODES.LAST_PLATFORM_ADMIN, 'This is the last active Platform Admin account, so it cannot be deleted.');
        }
        if (!active.includes(admin.sub)) {
          throw new ForbiddenException('Your Platform Admin account is no longer active.');
        }
      }
      const locked = await manager
        .getRepository(User)
        .createQueryBuilder('user')
        .setLock('pessimistic_write')
        .where('user.id = :userId', { userId })
        .getOne();
      if (!locked) throw new NotFoundException('Account not found.');
      if (locked.deletionCompletedAt) throw refusal(HttpStatus.CONFLICT, CODES.ALREADY_DELETED, 'This account has already been deleted.');

      // Nothing about a company, its memberships or its members' sessions is changed by a personal deletion.
      const companies = await this.ownedCompanySummaries(userId, manager, true);
      const block = ownerBlock(companies);
      if (block) throw block;

      const completedAt = await this.deletion.anonymiseUserInTransaction(manager, userId);
      const accountType = this.accountTypeOf(locked, companies.length > 0);

      await this.auditLog.logInTransaction(manager, {
        user: { id: admin.sub },
        action: 'account.deletion_completed_by_admin',
        entityType: 'user',
        entityId: userId,
        afterData: {
          targetUserId: userId,
          accountType,
          ...deletionCompletedAuditData(locked.role, completedAt),
          deletionRequestedAt: locked.deletionRequestedAt?.toISOString() ?? null,
          requestedVia: identity.requestedVia,
          identityConfirmed: identity.identityConfirmed,
          ownedCompanies: companies.map((c) => ({ id: c.companyId, verificationStatus: c.verificationStatus })),
        },
      });
      return { completedAt, accountType, ownedCompanyIds: companies.map((c) => c.companyId) };
    });

    return {
      deleted: true,
      kind: 'user' as const,
      id: userId,
      accountType: result.accountType,
      deletionCompletedAt: result.completedAt.toISOString(),
      ownedCompanyIds: result.ownedCompanyIds,
      status: UserStatus.INACTIVE,
    };
  }

  /** Complete a recorded request for a client portal login (client_portal_users). */
  async completeClientPortalUser(admin: JwtPayload, clientPortalUserId: number, identityConfirmed?: boolean) {
    const result = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ClientPortalUser);
      const locked = await repo
        .createQueryBuilder('cpu')
        .setLock('pessimistic_write', undefined, ['cpu'])
        .leftJoinAndSelect('cpu.client', 'client')
        .leftJoinAndSelect('client.company', 'company')
        .where('cpu.id = :id', { id: clientPortalUserId })
        .getOne();
      if (!locked) throw refusal(HttpStatus.NOT_FOUND, CODES.NOT_FOUND, 'Account not found.');
      if (locked.email === deletedClientPortalEmail(locked.id)) {
        throw refusal(HttpStatus.CONFLICT, CODES.ALREADY_DELETED, 'This account has already been deleted.');
      }
      const requestedAt = await this.deletion.clientPortalRequestedAt(locked.id, manager);
      if (!requestedAt) {
        throw refusal(HttpStatus.CONFLICT, CODES.NOT_REQUESTED, 'No deletion request is recorded for this account. Record the request first.');
      }
      const identity = await this.identityCheck('client_portal_user', locked.id, identityConfirmed, manager);
      const completedAt = new Date();
      await repo.update(
        { id: locked.id },
        {
          email: deletedClientPortalEmail(locked.id),
          firstName: '',
          lastName: '',
          passwordHash: DELETED_ACCOUNT_PASSWORD_SENTINEL,
          isActive: false,
          lastLoginAt: null,
        },
      );
      await this.auditLog.logInTransaction(manager, {
        company: locked.client?.company?.id ? { id: locked.client.company.id } : null,
        user: { id: admin.sub },
        action: 'account.deletion_completed_by_admin',
        entityType: 'client_portal_user',
        entityId: locked.id,
        afterData: {
          targetClientPortalUserId: locked.id,
          accountType: 'client_portal',
          clientId: locked.client?.id ?? null,
          role: locked.role,
          isActive: false,
          deletionRequestedAt: requestedAt.toISOString(),
          deletionCompletedAt: completedAt.toISOString(),
          requestedVia: identity.requestedVia,
          identityConfirmed: identity.identityConfirmed,
          retainedRecordCategories: [...CLIENT_PORTAL_RETAINED_RECORDS],
        },
      });
      return { completedAt };
    });
    return {
      deleted: true,
      kind: 'client_portal_user' as const,
      id: clientPortalUserId,
      accountType: 'client_portal' as const,
      deletionCompletedAt: result.completedAt.toISOString(),
      ownedCompanyIds: [] as number[],
    };
  }
}
