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
import { CompanyVerificationService } from '../company/verification/company-verification.service';
import { User, UserRole, UserStatus } from '../user/entities/user.entity';
import {
  AccountDeletionService,
  deletedClientPortalEmail,
  deletionCompletedAuditData,
} from './account-deletion.service';
import { AuthSessionService } from './auth-session.service';
import { DELETED_ACCOUNT_PASSWORD_SENTINEL } from './password-policy';
import { JwtPayload } from './types/jwt-payload.type';

/** Machine-readable refusals, so the admin screen can say exactly why a request cannot be completed yet. */
export const ACCOUNT_DELETION_ADMIN_CODES = {
  NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  NOT_REQUESTED: 'ACCOUNT_DELETION_NOT_REQUESTED',
  ALREADY_DELETED: 'ACCOUNT_ALREADY_DELETED',
  SELF: 'ACCOUNT_DELETION_SELF',
  LAST_PLATFORM_ADMIN: 'ACCOUNT_DELETION_LAST_PLATFORM_ADMIN',
  SHIFTS_IN_PROGRESS: 'ACCOUNT_DELETION_SHIFTS_IN_PROGRESS',
} as const;
const CODES = ACCOUNT_DELETION_ADMIN_CODES;

export type DeletionAccountType = 'guard' | 'company_owner' | 'company_member' | 'platform_admin' | 'client_user' | 'client_portal';

export interface OwnedCompanyView {
  id: number;
  name: string;
  verificationStatus: string;
  shiftsInProgress: number;
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
  /** Companies this account owns: completing the request closes each of them. */
  companies: OwnedCompanyView[];
  /** A client login's client and the security company that holds that client's records. */
  client: { id: number; name: string; companyId: number | null; companyName: string | null } | null;
  /** Why it cannot be completed right now (for the calling administrator), or null. */
  blockedCode: string | null;
  blockedReason: string | null;
}

/** What a closed company's note says to anyone who still looks at it. Shown to the company; carries no personal data. */
export const OWNER_DELETION_COMPANY_NOTE =
  'Closed by S4: the company owner asked for their S4 account to be deleted. The company\'s records are kept.';

/** What a deleted client portal login leaves behind: the company's own records about its client, and the audit trail. */
export const CLIENT_PORTAL_RETAINED_RECORDS = ['client_records_held_by_the_company', 'client_weekly_approvals', 'audit_logs'] as const;

const REQUEST_ACTIONS = ['account.deletion_requested', 'account.deletion_requested_by_admin'];

const refusal = (status: HttpStatus, code: string, message: string, details?: Record<string, unknown>) =>
  new HttpException({ statusCode: status, code, message, ...(details ? { details } : {}) }, status);

const shiftsInProgressRefusal = (companies: OwnedCompanyView[]) =>
  refusal(
    HttpStatus.CONFLICT,
    CODES.SHIFTS_IN_PROGRESS,
    'This account owns a company with shifts in progress. Wait until every in-progress shift has been booked off or closed, then complete the deletion.',
    { companies: companies.filter((c) => c.shiftsInProgress > 0).map((c) => ({ id: c.id, shiftsInProgress: c.shiftsInProgress })) },
  );

/**
 * The Platform Admin side of account deletion: a queue of recorded requests (from any account type, including ones that
 * cannot finish deletion themselves) and the action that completes one.
 *
 *   - Anonymisation is AccountDeletionService.anonymiseUserInTransaction, the routine self-service deletion uses.
 *   - An owner's companies are closed first: suspended (or, if never approved, rejected) through
 *     CompanyVerificationService so the decision is audited as company.verification_changed, and every membership of
 *     those companies is revoked and the members' sessions ended. No company, membership or operational row is deleted.
 *   - Refused while any owned company has a shift in progress.
 *   - A Platform Admin account can be completed only by a different Platform Admin, and never the last active one.
 *   - Audited as account.deletion_requested_by_admin and account.deletion_completed_by_admin, with ids only.
 */
@Injectable()
export class AccountDeletionAdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly deletion: AccountDeletionService,
    private readonly verification: CompanyVerificationService,
    private readonly sessions: AuthSessionService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ── reads ───────────────────────────────────────────────────────────────────────────────────────────────

  private async ownedCompanies(userId: number, manager: EntityManager = this.dataSource.manager): Promise<OwnedCompanyView[]> {
    const rows: Array<{ id: number; name: string; verificationStatus: string; inProgress: string }> = await manager.query(
      `SELECT c.id, c.name, c."verificationStatus",
              (SELECT count(*) FROM shifts s WHERE s."companyId" = c.id AND s.status = 'in_progress') AS "inProgress"
         FROM companies c
        WHERE c."userId" = $1
           OR c.id IN (SELECT m."companyId" FROM company_memberships m
                        WHERE m."userId" = $1 AND m."membershipRole" = 'owner' AND m.status = 'active')
        ORDER BY c.id`,
      [userId],
    );
    return rows.map((r) => ({ id: Number(r.id), name: r.name, verificationStatus: r.verificationStatus, shiftsInProgress: Number(r.inProgress) }));
  }

  private async activePlatformAdminIds(manager: EntityManager, lock: boolean): Promise<number[]> {
    const rows: Array<{ id: number }> = await manager.query(
      `SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND "deletionCompletedAt" IS NULL ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    );
    return rows.map((r) => Number(r.id));
  }

  private async requestedByAdmin(entityType: 'user' | 'client_portal_user', id: number): Promise<boolean> {
    const rows: Array<{ n: string }> = await this.dataSource.query(
      `SELECT count(*) AS n FROM audit_logs WHERE "entityType" = $1 AND "entityId" = $2 AND action = 'account.deletion_requested_by_admin'`,
      [entityType, id],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  private accountTypeOf(user: User, companies: OwnedCompanyView[]): DeletionAccountType {
    if (user.role === UserRole.ADMIN) return 'platform_admin';
    if (companies.length) return 'company_owner';
    if (user.role === UserRole.GUARD) return 'guard';
    if (user.role === UserRole.CLIENT_ADMIN || user.role === UserRole.CLIENT_VIEWER) return 'client_user';
    return 'company_member';
  }

  private async userView(admin: JwtPayload, user: User, activeAdmins: number[]): Promise<DeletionRequestView> {
    const companies = await this.ownedCompanies(user.id);
    const accountType = this.accountTypeOf(user, companies);
    let blockedCode: string | null = null;
    let blockedReason: string | null = null;
    if (user.id === admin.sub) {
      blockedCode = CODES.SELF;
      blockedReason = 'You cannot complete the deletion of your own account. Another Platform Admin must do it.';
    } else if (accountType === 'platform_admin' && activeAdmins.filter((id) => id !== user.id).length === 0) {
      blockedCode = CODES.LAST_PLATFORM_ADMIN;
      blockedReason = 'This is the last active Platform Admin account.';
    } else if (companies.some((c) => c.shiftsInProgress > 0)) {
      blockedCode = CODES.SHIFTS_IN_PROGRESS;
      blockedReason = 'A company this account owns has shifts in progress.';
    }
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
      companies,
      client: null,
      blockedCode,
      blockedReason,
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

  // ── recording an emailed request ────────────────────────────────────────────────────────────────────────

  /**
   * Record a deletion request received by email (the public /account-deletion process) for the account that uses
   * `email`. Idempotent: an account that already has a request keeps its first one and nothing new is audited.
   */
  async recordRequestByEmail(admin: JwtPayload, rawEmail: string) {
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
            afterData: { targetUserId: user.id, requestedAt: now.toISOString(), source: 'emailed_request' },
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
        afterData: { targetClientPortalUserId: login.id, requestedAt: requestedAt.toISOString(), source: 'emailed_request' },
      });
      requestedAt = (await this.deletion.clientPortalRequestedAt(login.id)) ?? requestedAt;
    }
    return { alreadyRequested, request: await this.clientPortalView(login, requestedAt) };
  }

  // ── completing a request ────────────────────────────────────────────────────────────────────────────────

  /** Complete a recorded request for an S4 user account (any role). */
  async completeUser(admin: JwtPayload, userId: number) {
    const target = await this.dataSource.getRepository(User).findOne({ where: { id: userId } });
    if (!target) throw refusal(HttpStatus.NOT_FOUND, CODES.NOT_FOUND, 'Account not found.');
    if (userId === admin.sub) {
      throw refusal(HttpStatus.FORBIDDEN, CODES.SELF, 'You cannot complete the deletion of your own account. Another Platform Admin must do it.');
    }
    if (target.deletionCompletedAt) throw refusal(HttpStatus.CONFLICT, CODES.ALREADY_DELETED, 'This account has already been deleted.');
    if (!target.deletionRequestedAt) {
      throw refusal(HttpStatus.CONFLICT, CODES.NOT_REQUESTED, 'No deletion request is recorded for this account. Record the request first.');
    }

    // An owner's companies: refuse while any has a shift in progress, then close each one through the audited
    // verification decision. Done before the anonymising transaction because it is its own audited decision; if the
    // completion is then refused (a shift booked on in between), the company stays closed and the request stays
    // pending, which is the safe side.
    const companies = await this.ownedCompanies(userId);
    if (companies.some((c) => c.shiftsInProgress > 0)) throw shiftsInProgressRefusal(companies);
    for (const company of companies) {
      const closeTo = company.verificationStatus === CompanyVerificationStatus.APPROVED
        ? CompanyVerificationStatus.SUSPENDED
        : company.verificationStatus === CompanyVerificationStatus.PENDING_VERIFICATION
          ? CompanyVerificationStatus.REJECTED
          : null; // already suspended or rejected: closed for operations
      if (closeTo) await this.verification.decide(admin, company.id, closeTo, OWNER_DELETION_COMPANY_NOTE);
    }

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

      const now = await this.ownedCompanies(userId, manager);
      if (now.some((c) => c.shiftsInProgress > 0)) throw shiftsInProgressRefusal(now);
      const companyIds = now.map((c) => c.id);

      // End every member's access to the closed companies. Rows are kept (revoked), never deleted.
      const closedCompanies: Array<{ companyId: number; membershipsRevoked: number; memberUserIds: number[] }> = [];
      for (const companyId of companyIds) {
        const revoked: Array<{ userId: number }> = await manager.query(
          `UPDATE company_memberships
              SET status = 'revoked', "disabledAt" = now(), "disabledByUserId" = $2, "updatedAt" = now()
            WHERE "companyId" = $1 AND status IN ('active', 'suspended')
        RETURNING "userId"`,
          [companyId, admin.sub],
        ).then((rows: unknown) => (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<{ userId: number }>);
        const memberUserIds = [...new Set(revoked.map((r) => Number(r.userId)).filter((id) => id !== userId))].sort((a, b) => a - b);
        for (const memberId of memberUserIds) await this.sessions.revokeAllForUser(memberId, 'company_closed', manager);
        closedCompanies.push({ companyId, membershipsRevoked: revoked.length, memberUserIds });
      }

      const completedAt = await this.deletion.anonymiseUserInTransaction(manager, userId);
      const accountType = this.accountTypeOf(locked, now);

      for (const closed of closedCompanies) {
        await this.auditLog.logInTransaction(manager, {
          company: { id: closed.companyId },
          user: { id: admin.sub },
          action: 'company.closed_for_owner_deletion',
          entityType: 'company',
          entityId: closed.companyId,
          afterData: { ownerUserId: userId, membershipsRevoked: closed.membershipsRevoked, memberUserIds: closed.memberUserIds },
        });
      }
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
          closedCompanyIds: companyIds,
        },
      });
      return { completedAt, accountType, closedCompanyIds: companyIds };
    });

    return {
      deleted: true,
      kind: 'user' as const,
      id: userId,
      accountType: result.accountType,
      deletionCompletedAt: result.completedAt.toISOString(),
      closedCompanyIds: result.closedCompanyIds,
      status: UserStatus.INACTIVE,
    };
  }

  /** Complete a recorded request for a client portal login (client_portal_users). */
  async completeClientPortalUser(admin: JwtPayload, clientPortalUserId: number) {
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
      closedCompanyIds: [] as number[],
    };
  }
}
