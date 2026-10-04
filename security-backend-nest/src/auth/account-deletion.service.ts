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
import { User, UserRole, UserStatus } from '../user/entities/user.entity';
import { AuthSessionService } from './auth-session.service';
import { DELETED_ACCOUNT_PASSWORD_SENTINEL, isUsablePasswordHash } from './password-policy';
import { UserVerificationTokenService } from './user-verification-token.service';

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

export type DeletionBlocker = 'platform_admin' | 'company_owner';

const BLOCKER_MESSAGES: Record<DeletionBlocker, string> = {
  platform_admin:
    'A Platform Admin account cannot be deleted from the app. Contact S4 support to arrange it.',
  company_owner:
    'This account owns a company workspace on S4, so deleting it would leave the company without an owner. Contact S4 support so the workspace can be transferred or closed first.',
};

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

      const completedAt = new Date();
      await users.update(
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
      return { alreadyDeleted: false, completedAt, role: user.role };
    });

    if (!result.alreadyDeleted) {
      await this.auditLog.log({
        user: { id: userId },
        action: 'account.deletion_completed',
        entityType: 'user',
        entityId: userId,
        // No former email, name or phone: this entry must not re-create what was just removed.
        afterData: {
          role: result.role,
          status: UserStatus.INACTIVE,
          deletionCompletedAt: result.completedAt.toISOString(),
          sessionsRevoked: true,
          retainedRecordCategories: [...RETENTION_POLICY_CONTROLLED_RECORDS],
        },
      });
    }

    return {
      deleted: true,
      deletionCompletedAt: result.completedAt.toISOString(),
      message: 'Your S4 account has been deleted and you have been signed out.',
    };
  }
}
