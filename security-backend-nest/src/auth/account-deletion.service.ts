import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Company } from '../company/entities/company.entity';
import { CompanyMembership } from '../company-membership/entities/company-membership.entity';
import {
  CompanyMembershipRole,
  CompanyMembershipStatus,
} from '../company-membership/company-membership-types';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { ClientPortalUser } from '../client-portal-user/entities/client-portal-user.entity';
import { User, UserRole, UserStatus } from '../user/entities/user.entity';
import { AuthSessionService } from './auth-session.service';
import { DELETED_ACCOUNT_PASSWORD_SENTINEL, isUsablePasswordHash } from './password-policy';
import { UserVerificationTokenService } from './user-verification-token.service';
import { removePushDevicesForUser } from '../welfare-push/push-device-lifecycle';

/** A unique, undeliverable address on the reserved .invalid TLD (RFC 2606). */
export function deletedAccountEmail(userId: number): string {
  return `deleted-user-${userId}@deleted.invalid`;
}

/**
 * Operational and security records that account deletion deliberately leaves in place. How long each
 * is kept is an owner/legal decision that has not been made (see the Gate 2 retention register); until
 * it is, deleting any of them could destroy evidence a company, client or regulator relies on.
 * Recorded on the deletion audit entry so the decision to retain is explicit, not accidental.
 */
export const RETENTION_POLICY_CONTROLLED_RECORDS = [
  'guard_profile.fullName',
  'guard_profile.siaLicenseNumber',
  'guard_personnel_records',
  'screening_evidence',
  'attendance_and_gps_evidence',
  'shifts_and_timesheets',
  'welfare_checks',
  'log_book_and_daily_logs',
  'incidents',
  'safety_alerts',
  'audit_logs',
  'company_relationships_and_memberships',
] as const;

/**
 * The S4 contact published on https://www.sfour.co.uk/account-deletion for deletion requests. The S4 website also lists
 * support@sfour.co.uk for general help; the deletion page's address is used here because this is a deletion journey.
 * Keep in step with security-mobile-app/src/constants/s4Links.ts.
 */
export const S4_SUPPORT_EMAIL = 'info@vesoft.co.uk';

/** A unique, undeliverable address for an anonymised client-portal login (its own table, its own id space). */
export function deletedClientPortalEmail(clientPortalUserId: number): string {
  return `deleted-client-${clientPortalUserId}@deleted.invalid`;
}

export type DeletionBlocker = 'platform_admin' | 'company_owner' | 'client_portal';

export const BLOCKER_MESSAGES: Record<DeletionBlocker, string> = {
  platform_admin:
    `A Platform Admin account cannot be deleted from the app. Your request is recorded and another S4 Platform Admin completes it. Contact S4 support at ${S4_SUPPORT_EMAIL} to arrange it.`,
  company_owner:
    `This account owns a company workspace on S4, so deleting it would leave the company without an owner. Your request is recorded: S4 support closes the company workspace first and then completes the deletion. Contact S4 support at ${S4_SUPPORT_EMAIL} with any questions.`,
  client_portal:
    `Your request is recorded. S4 support completes the deletion of client portal accounts. Records the security company keeps about its client are the company's own. Contact S4 support at ${S4_SUPPORT_EMAIL} with any questions.`,
};

/** The completion audit's afterData: ids and facts only, never the former email, name or phone. */
export function deletionCompletedAuditData(role: UserRole | string, completedAt: Date) {
  return {
    role,
    status: UserStatus.INACTIVE,
    deletionCompletedAt: completedAt.toISOString(),
    sessionsRevoked: true,
    retainedRecordCategories: [...RETENTION_POLICY_CONTROLLED_RECORDS],
  };
}

/**
 * Account deletion by anonymisation in place.
 *
 * No row is physically deleted — not the user, not the guard profile, and nothing that references
 * them — because operational evidence (shifts, attendance, Welfare, Log Book, incidents, alerts,
 * audit) points at these rows and must keep pointing at something. What is removed is the ability to
 * use the account and the direct identifiers that serve no evidential purpose.
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly sessions: AuthSessionService,
    private readonly tokens: UserVerificationTokenService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Why this account cannot complete deletion by itself, or null when it can. */
  async selfServiceBlocker(userId: number, manager: EntityManager = this.dataSource.manager): Promise<DeletionBlocker | null> {
    const user = await manager.getRepository(User).findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role === UserRole.ADMIN) return 'platform_admin';
    const ownsCompany = await manager
      .getRepository(Company)
      .createQueryBuilder('company')
      .where('company.userId = :userId', { userId })
      .getExists();
    if (ownsCompany) return 'company_owner';
    const ownerMembership = await manager.getRepository(CompanyMembership).exists({
      where: { userId, membershipRole: CompanyMembershipRole.OWNER, status: CompanyMembershipStatus.ACTIVE },
    });
    return ownerMembership ? 'company_owner' : null;
  }

  async status(userId: number) {
    const user = await this.dataSource.getRepository(User).findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const blocker = await this.selfServiceBlocker(userId);
    return {
      deletionRequestedAt: user.deletionRequestedAt?.toISOString() ?? null,
      deletionCompletedAt: user.deletionCompletedAt?.toISOString() ?? null,
      selfServiceAvailable: blocker === null,
      blocker,
      blockerMessage: blocker ? BLOCKER_MESSAGES[blocker] : null,
    };
  }

  /** Step one: record the request. Idempotent — a repeated request keeps the first timestamp. */
  async requestDeletion(userId: number) {
    const repo = this.dataSource.getRepository(User);
    const user = await repo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.deletionRequestedAt && !user.deletionCompletedAt) {
      const now = new Date();
      await repo
        .createQueryBuilder()
        .update(User)
        .set({ deletionRequestedAt: now })
        .where('id = :id', { id: userId })
        .andWhere('"deletionRequestedAt" IS NULL')
        .execute();
      await this.auditLog.log({
        user: { id: userId },
        action: 'account.deletion_requested',
        entityType: 'user',
        entityId: userId,
        afterData: { deletionRequestedAt: now.toISOString() },
      });
    }
    return this.status(userId);
  }

  /**
   * Step two: the account holder confirms with their password and the account is anonymised.
   *
   * Runs in one transaction with the user row locked, so a concurrent second confirmation waits and then
   * returns the completed state instead of anonymising twice.
   */
  async completeDeletion(userId: number, password: string) {
    const result = await this.dataSource.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const user = await users
        .createQueryBuilder('user')
        .addSelect('user.passwordHash')
        .setLock('pessimistic_write')
        .where('user.id = :userId', { userId })
        .getOne();
      if (!user) throw new NotFoundException('User not found');

      // Already deleted: report the existing outcome, change nothing.
      if (user.deletionCompletedAt) {
        return { alreadyDeleted: true, completedAt: user.deletionCompletedAt, role: user.role };
      }
      if (!user.deletionRequestedAt) {
        throw new BadRequestException('Request account deletion before confirming it.');
      }
      const blocker = await this.selfServiceBlocker(userId, manager);
      if (blocker) throw new ConflictException(BLOCKER_MESSAGES[blocker]);

      const valid = isUsablePasswordHash(user.passwordHash) && (await bcrypt.compare(password, user.passwordHash));
      if (!valid) throw new BadRequestException('The password you entered is not correct.');

      const completedAt = await this.anonymiseUserInTransaction(manager, userId);
      return { alreadyDeleted: false, completedAt, role: user.role };
    });

    if (!result.alreadyDeleted) {
      await this.auditLog.log({
        user: { id: userId },
        action: 'account.deletion_completed',
        entityType: 'user',
        entityId: userId,
        // No former email, name or phone: this entry must not re-create what was just removed.
        afterData: deletionCompletedAuditData(result.role, result.completedAt),
      });
    }

    return {
      deleted: true,
      deletionCompletedAt: result.completedAt.toISOString(),
      message: 'Your S4 account has been deleted and you have been signed out.',
    };
  }

  /**
   * The anonymisation itself, shared by self-service confirmation and a Platform Admin completing a recorded request
   * (AccountDeletionAdminService). The caller holds the user row locked in `manager`'s transaction and has already
   * decided the account may be deleted. Returns the completion time it recorded.
   */
  async anonymiseUserInTransaction(manager: EntityManager, userId: number): Promise<Date> {
    const completedAt = new Date();
    await manager.getRepository(User).update(
      { id: userId },
      {
        email: deletedAccountEmail(userId),
        firstName: null,
        lastName: null,
        phone: null,
        passwordHash: DELETED_ACCOUNT_PASSWORD_SENTINEL,
        status: UserStatus.INACTIVE,
        deletionCompletedAt: completedAt,
      },
    );

    // Guard profile: the phone number is a direct contact identifier with no evidential role, and
    // location sharing must stop. The column is NOT NULL, so it is blanked rather than nulled. The
    // name and SIA licence number stay: they attribute operational evidence (shifts, Log Book,
    // incidents) and their retention is an owner/legal decision.
    await manager
      .getRepository(GuardProfile)
      .createQueryBuilder()
      .update(GuardProfile)
      .set({ phone: '', locationSharingEnabled: false })
      .where('"userId" = :userId', { userId })
      .execute();

    await this.tokens.invalidateOutstanding(userId, null, manager);
    await this.sessions.revokeAllForUser(userId, 'account_deleted', manager);
    await removePushDevicesForUser(manager, userId);
    return completedAt;
  }

  // ── client portal logins (client_portal_users) ──────────────────────────────────────────────────────────
  //
  // A client portal login lives in its own table, which has no deletion columns. Rather than add a migration, its
  // request is the audit entry itself: `account.deletion_requested` (by the user) or `account.deletion_requested_by_admin`
  // (recorded by S4 from an emailed request), entityType `client_portal_user`. Completion anonymises the row
  // (deletedClientPortalEmail), which is what marks it done.

  /** When this client portal login first asked (or was recorded as asking) for deletion, or null. */
  async clientPortalRequestedAt(clientPortalUserId: number, manager: EntityManager = this.dataSource.manager): Promise<Date | null> {
    const rows: Array<{ at: Date | null }> = await manager.query(
      `SELECT MIN("createdAt") AS at FROM audit_logs
        WHERE "entityType" = 'client_portal_user' AND "entityId" = $1
          AND action IN ('account.deletion_requested', 'account.deletion_requested_by_admin')`,
      [clientPortalUserId],
    );
    return rows[0]?.at ? new Date(rows[0].at) : null;
  }

  async clientPortalStatus(clientPortalUserId: number) {
    const login = await this.dataSource.getRepository(ClientPortalUser).findOne({ where: { id: clientPortalUserId } });
    if (!login) throw new NotFoundException('Client portal user not found');
    const requestedAt = await this.clientPortalRequestedAt(clientPortalUserId);
    return {
      deletionRequestedAt: requestedAt?.toISOString() ?? null,
      deletionCompletedAt: null,
      selfServiceAvailable: false,
      blocker: 'client_portal' as DeletionBlocker,
      blockerMessage: BLOCKER_MESSAGES.client_portal,
    };
  }

  /** A client portal user asks for deletion. Recorded once; S4 completes it from the admin queue. */
  async requestClientPortalDeletion(clientPortalUserId: number) {
    const login = await this.dataSource.getRepository(ClientPortalUser).findOne({ where: { id: clientPortalUserId } });
    if (!login) throw new NotFoundException('Client portal user not found');
    if (!(await this.clientPortalRequestedAt(clientPortalUserId))) {
      await this.auditLog.log({
        company: login.client?.company?.id ? { id: login.client.company.id } : null,
        user: null,
        action: 'account.deletion_requested',
        entityType: 'client_portal_user',
        entityId: clientPortalUserId,
        afterData: { clientId: login.client?.id ?? null, requestedAt: new Date().toISOString() },
      });
    }
    return this.clientPortalStatus(clientPortalUserId);
  }
}
