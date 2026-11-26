import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { createHash, randomBytes } from 'node:crypto';

import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyMembership } from '../company-membership/entities/company-membership.entity';
import { CompanyInvitation } from '../company-membership/entities/company-invitation.entity';
import {
  CompanyMembershipRole,
  CompanyMembershipStatus,
  CompanyPermission,
} from '../company-membership/company-membership-types';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthSessionService } from '../auth/auth-session.service';
import { UserService } from '../user/user.service';
import { User, UserRole, UserStatus } from '../user/entities/user.entity';
import { TransactionalEmailService } from '../email/transactional-email.service';
import { staffInvitationEmail } from '../email/auth-email.templates';
import { isCompanyApproved } from '../company/company-verification';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { AcceptCompanyStaffInvitationDto, InviteCompanyStaffDto } from './dto/company-staff.dto';
import { grantableRoles, mayGrantRole, receivesEmergencyAlerts } from './company-staff-policy';

/** 256 bits, matching AuthSessionService and the Guard workforce invitations. */
const TOKEN_BYTES = 32;
/** Seven days, the same as a Guard workforce invitation. */
export const STAFF_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A company cannot hold more open invitations than this; each one sends an email. */
export const MAX_PENDING_STAFF_INVITATIONS = 50;

/** Identical for an unknown, malformed, expired, cancelled or already-used link, and for an unapproved company. */
export const INVALID_STAFF_INVITATION =
  'This invitation link is invalid or has expired. Ask the person who invited you to send a new invitation.';
/**
 * The smallest safe answer when the invited address already has an S4 account: this route only creates new accounts,
 * and joining an existing account to a company is not supported. Only the holder of the emailed link sees it.
 */
export const STAFF_INVITATION_ACCOUNT_EXISTS =
  'An S4 account already uses this email address, so this invitation cannot create a new one. ' +
  'Ask the person who invited you to contact S4 support at support@sfour.co.uk.';

export const ROLE_LABELS: Record<CompanyMembershipRole, string> = {
  [CompanyMembershipRole.OWNER]: 'Owner',
  [CompanyMembershipRole.ADMIN]: 'Admin',
  [CompanyMembershipRole.OPERATIONS]: 'Operations',
  [CompanyMembershipRole.CONTROL_ROOM]: 'Control Room',
  [CompanyMembershipRole.HR_COMPLIANCE]: 'HR / Compliance',
  [CompanyMembershipRole.FINANCE]: 'Finance',
  [CompanyMembershipRole.VIEWER]: 'Viewer',
};

export type StaffInvitationState = 'PENDING' | 'EXPIRED' | 'ACCEPTED' | 'CANCELLED';

/** Company-facing invitation. Never carries the token or its digest. */
export type StaffInvitationView = {
  id: number;
  email: string;
  role: CompanyMembershipRole;
  state: StaffInvitationState;
  createdAt: Date;
  expiresAt: Date;
};

export type StaffMemberView = {
  userId: number;
  name: string;
  email: string;
  role: CompanyMembershipRole;
  status: CompanyMembershipStatus;
  joinedAt: Date | null;
  isYou: boolean;
  receivesEmergencyAlerts: boolean;
  /** May the caller change this member's role or revoke their access? */
  manageable: boolean;
};

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

function stateOf(invitation: CompanyInvitation, now = new Date()): StaffInvitationState {
  if (invitation.revokedAt) return 'CANCELLED';
  if (invitation.usedAt) return 'ACCEPTED';
  if (invitation.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'PENDING';
}

function normaliseEmail(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

@Injectable()
export class CompanyStaffService {
  private readonly logger = new Logger('CompanyStaff');

  constructor(
    private readonly dataSource: DataSource,
    private readonly membershipService: CompanyMembershipService,
    private readonly auditLogService: AuditLogService,
    private readonly authSessionService: AuthSessionService,
    private readonly usersService: UserService,
    private readonly emailService: TransactionalEmailService,
  ) {}

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** The caller's company and role. Owner, or a member holding staff.manage; anyone else is refused (403). */
  private async actor(user: JwtPayload) {
    const { company, membershipRole } = await this.membershipService.resolveCompanyContext(
      user.sub,
      user.role,
      CompanyPermission.STAFF_MANAGE,
    );
    return { company, role: membershipRole, userId: user.sub };
  }

  private toInvitationView(row: CompanyInvitation): StaffInvitationView {
    return {
      id: row.id,
      email: row.email,
      role: row.intendedMembershipRole,
      state: stateOf(row),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────────────

  async list(user: JwtPayload) {
    const actor = await this.actor(user);
    const companyId = actor.company.id;
    const rows = (await this.dataSource.query(
      `SELECT u."id" AS "userId", u."firstName", u."lastName", u."email", 'owner' AS "role", 'active' AS "status",
              u."createdAt" AS "joinedAt"
         FROM "companies" c JOIN "users" u ON u."id" = c."userId"
        WHERE c."id" = $1
       UNION ALL
       SELECT u."id", u."firstName", u."lastName", u."email", m."membershipRole"::text, m."status"::text, m."acceptedAt"
         FROM "company_memberships" m JOIN "users" u ON u."id" = m."userId"
        WHERE m."companyId" = $1
          AND m."userId" <> (SELECT "userId" FROM "companies" WHERE "id" = $1)
          AND u."deletionCompletedAt" IS NULL
        ORDER BY 1`,
      [companyId],
    )) as Array<{ userId: number; firstName: string | null; lastName: string | null; email: string; role: string; status: string; joinedAt: Date | null }>;

    const members: StaffMemberView[] = rows.map((r) => {
      const role = r.role as CompanyMembershipRole;
      const status = r.status as CompanyMembershipStatus;
      const userId = Number(r.userId);
      const name = [r.firstName, r.lastName].map((p) => (p ?? '').trim()).filter(Boolean).join(' ');
      const isYou = userId === actor.userId;
      return {
        userId,
        name: name || ROLE_LABELS[role] || 'Staff member',
        email: r.email,
        role,
        status,
        joinedAt: r.joinedAt ?? null,
        isYou,
        receivesEmergencyAlerts: status === CompanyMembershipStatus.ACTIVE && receivesEmergencyAlerts(role),
        manageable: !isYou && role !== CompanyMembershipRole.OWNER && mayGrantRole(actor.role, role),
      };
    });

    const invitations = await this.dataSource.getRepository(CompanyInvitation).find({
      where: { companyId },
      order: { createdAt: 'DESC' },
    });

    return {
      yourRole: actor.role,
      grantableRoles: grantableRoles(actor.role),
      members,
      // Open invitations only: pending, or expired and not yet cleared away.
      invitations: invitations
        .filter((row) => !row.usedAt && !row.revokedAt)
        .map((row) => this.toInvitationView(row)),
    };
  }

  // ── invite / cancel ──────────────────────────────────────────────────────────────────────────────────

  async invite(user: JwtPayload, dto: InviteCompanyStaffDto, meta?: RequestMeta) {
    const actor = await this.actor(user);
    if (!mayGrantRole(actor.role, dto.role)) {
      throw new ForbiddenException('You cannot invite someone with that role.');
    }
    const email = normaliseEmail(dto.email);
    const companyId = actor.company.id;
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + STAFF_INVITATION_TTL_MS);

    const saved = await this.dataSource.transaction(async (manager) => {
      // One invitation decision per company at a time, so the duplicate and limit checks below cannot race.
      await manager.query(`SELECT "id" FROM "companies" WHERE "id" = $1 FOR UPDATE`, [companyId]);

      const [{ members }] = await manager.query(
        `SELECT count(*)::int AS "members"
           FROM "users" u
          WHERE lower(u."email") = $2
            AND (u."id" = (SELECT "userId" FROM "companies" WHERE "id" = $1)
                 OR EXISTS (SELECT 1 FROM "company_memberships" m WHERE m."userId" = u."id" AND m."companyId" = $1))`,
        [companyId, email],
      );
      if (Number(members) > 0) throw new ConflictException('This person is already on your team.');

      const open = await manager.query(
        `SELECT lower("email") AS "email" FROM "company_invitations"
          WHERE "companyId" = $1 AND "usedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt" > now()`,
        [companyId],
      );
      if (open.some((row: { email: string }) => row.email === email)) {
        throw new ConflictException('An invitation for this email address is already waiting. Cancel it before sending another.');
      }
      if (open.length >= MAX_PENDING_STAFF_INVITATIONS) {
        throw new ConflictException('Your company has too many invitations waiting. Cancel some before sending more.');
      }

      const repo = manager.getRepository(CompanyInvitation);
      const row = await repo.save(
        repo.create({
          companyId,
          email,
          intendedMembershipRole: dto.role,
          tokenDigest: this.digest(token),
          expiresAt,
          usedAt: null,
          revokedAt: null,
          revokedByUserId: null,
          invitedByUserId: actor.userId,
        }),
      );
      await this.auditLogService.logInTransaction(manager, {
        company: { id: companyId },
        user: { id: actor.userId },
        action: 'company.staff.invited',
        entityType: 'company_invitation',
        entityId: row.id,
        // No token, no digest.
        afterData: { email, role: dto.role, expiresAt: expiresAt.toISOString() },
        ipAddress: meta?.ipAddress ?? null,
        userAgent: meta?.userAgent ?? null,
      });
      return row;
    });

    // After the commit: the email carries the only copy of the token. A failed send is reported to the inviter, who
    // can cancel the invitation and send another; the token itself is never returned or logged.
    let emailSent = false;
    try {
      emailSent = await this.emailService.send(
        staffInvitationEmail(email, this.emailService.webAppUrl, token, actor.company.name, ROLE_LABELS[dto.role]),
      );
    } catch {
      emailSent = false;
    }
    if (!emailSent) {
      this.logger.warn(JSON.stringify({ event: 'company_staff_invitation_email_not_sent', invitationId: saved.id }));
    }

    return { invitation: this.toInvitationView(saved), emailSent };
  }

  async cancelInvitation(user: JwtPayload, invitationId: number, meta?: RequestMeta) {
    const actor = await this.actor(user);
    const companyId = actor.company.id;
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CompanyInvitation);
      const row = await repo
        .createQueryBuilder('i')
        .setLock('pessimistic_write')
        .where('i.id = :id AND i."companyId" = :companyId', { id: invitationId, companyId })
        .getOne();
      // Another company's invitation is indistinguishable from one that does not exist.
      if (!row) throw new NotFoundException('Invitation not found.');
      if (!mayGrantRole(actor.role, row.intendedMembershipRole)) {
        throw new ForbiddenException('You cannot cancel an invitation for that role.');
      }
      const before = stateOf(row);
      if (before !== 'PENDING' && before !== 'EXPIRED') {
        throw new ConflictException(`This invitation is already ${before.toLowerCase()}.`);
      }
      row.revokedAt = new Date();
      row.revokedByUserId = actor.userId;
      const saved = await repo.save(row);
      await this.auditLogService.logInTransaction(manager, {
        company: { id: companyId },
        user: { id: actor.userId },
        action: 'company.staff.invitation_cancelled',
        entityType: 'company_invitation',
        entityId: saved.id,
        beforeData: { state: before },
        afterData: { state: 'CANCELLED', email: saved.email, role: saved.intendedMembershipRole },
        ipAddress: meta?.ipAddress ?? null,
        userAgent: meta?.userAgent ?? null,
      });
      return this.toInvitationView(saved);
    });
  }

  // ── members ──────────────────────────────────────────────────────────────────────────────────────────

  /** The member row to act on, locked, after every authority check. */
  private async lockManageableMember(
    manager: EntityManager,
    actor: Awaited<ReturnType<CompanyStaffService['actor']>>,
    targetUserId: number,
  ) {
    if (targetUserId === actor.userId) throw new ForbiddenException('You cannot change your own access.');
    const [ownerRow] = await manager.query(`SELECT "userId" FROM "companies" WHERE "id" = $1`, [actor.company.id]);
    if (Number(ownerRow?.userId) === targetUserId) throw new ForbiddenException('The company owner cannot be changed.');
    const membership = await manager
      .getRepository(CompanyMembership)
      .createQueryBuilder('m')
      .setLock('pessimistic_write')
      .where('m."userId" = :userId AND m."companyId" = :companyId', { userId: targetUserId, companyId: actor.company.id })
      .getOne();
    // Tenant isolation: a member of another company does not exist here.
    if (!membership) throw new NotFoundException('Team member not found.');
    if (membership.membershipRole === CompanyMembershipRole.OWNER) throw new ForbiddenException('The company owner cannot be changed.');
    if (!mayGrantRole(actor.role, membership.membershipRole)) {
      throw new ForbiddenException('You cannot change a team member with that role.');
    }
    return membership;
  }

  async changeRole(user: JwtPayload, targetUserId: number, role: CompanyMembershipRole, meta?: RequestMeta) {
    const actor = await this.actor(user);
    if (!mayGrantRole(actor.role, role)) throw new ForbiddenException('You cannot give someone that role.');
    return this.dataSource.transaction(async (manager) => {
      const membership = await this.lockManageableMember(manager, actor, targetUserId);
      if (membership.status !== CompanyMembershipStatus.ACTIVE) {
        throw new ConflictException('This person no longer has access. Invite them again instead.');
      }
      const before = {
        role: membership.membershipRole,
        canAmendShifts: membership.canAmendShifts,
        canManageAttendance: membership.canManageAttendance,
      };
      if (membership.membershipRole === role) throw new ConflictException('This person already has that role.');
      membership.membershipRole = role;
      // The per-person Control Room authorisations belong to the old role; they never carry over silently.
      membership.canAmendShifts = false;
      membership.canManageAttendance = false;
      await manager.getRepository(CompanyMembership).save(membership);
      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.company.id },
        user: { id: actor.userId },
        action: 'company.staff.role_changed',
        entityType: 'company_membership',
        entityId: membership.id,
        beforeData: before,
        afterData: { userId: targetUserId, role, canAmendShifts: false, canManageAttendance: false },
        ipAddress: meta?.ipAddress ?? null,
        userAgent: meta?.userAgent ?? null,
      });
      return { userId: targetUserId, role, status: membership.status };
    });
  }

  /**
   * Revoke a member's access: the membership becomes SUSPENDED (the existing status that fails closed in
   * resolveCompanyContext and removes them from Emergency recipients) and every renewable session they hold is ended,
   * in the same transaction. An access token already issued stops working for company data at once, because every
   * company route re-resolves the membership.
   */
  async revokeAccess(user: JwtPayload, targetUserId: number, meta?: RequestMeta) {
    const actor = await this.actor(user);
    return this.dataSource.transaction(async (manager) => {
      const membership = await this.lockManageableMember(manager, actor, targetUserId);
      if (membership.status !== CompanyMembershipStatus.ACTIVE) {
        throw new ConflictException('This person no longer has access.');
      }
      const before = { status: membership.status, role: membership.membershipRole };
      membership.status = CompanyMembershipStatus.SUSPENDED;
      membership.disabledAt = new Date();
      membership.disabledByUserId = actor.userId;
      membership.canAmendShifts = false;
      membership.canManageAttendance = false;
      await manager.getRepository(CompanyMembership).save(membership);
      // Access to THIS company ends now regardless of sessions (every company route re-resolves the membership).
      // Sessions are ended only for a company-staff account with no other active membership, so a person who also
      // works for another company, or holds any other kind of S4 account, keeps that independent access.
      const [other] = await manager.query(
        `SELECT u.role,
                EXISTS (SELECT 1 FROM company_memberships o
                         WHERE o."userId" = u.id AND o.status = 'active' AND o."companyId" <> $2) AS "otherActive"
           FROM users u WHERE u.id = $1`,
        [targetUserId, actor.company.id],
      );
      const sessionsRevoked = other?.role === 'company_staff' && !other?.otherActive;
      if (sessionsRevoked) {
        await this.authSessionService.revokeAllForUser(targetUserId, 'company_access_revoked', manager);
      }
      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.company.id },
        user: { id: actor.userId },
        action: 'company.staff.access_revoked',
        entityType: 'company_membership',
        entityId: membership.id,
        beforeData: before,
        afterData: { userId: targetUserId, status: membership.status, sessionsRevoked },
        ipAddress: meta?.ipAddress ?? null,
        userAgent: meta?.userAgent ?? null,
      });
      return { userId: targetUserId, role: membership.membershipRole, status: membership.status };
    });
  }

  // ── accept (public) ──────────────────────────────────────────────────────────────────────────────────

  /**
   * A new person accepts: a company_staff account (email proven by the emailed link) and an ACTIVE membership with the
   * invited role, and the invitation is spent — all or nothing. The invitation row is locked and re-validated inside
   * the transaction, so two concurrent acceptances cannot both succeed.
   */
  async accept(dto: AcceptCompanyStaffInvitationDto, meta?: RequestMeta) {
    const token = String(dto.token ?? '').trim();
    const firstName = String(dto.firstName ?? '').trim();
    const lastName = String(dto.lastName ?? '').trim();
    if (!firstName || !lastName) throw new BadRequestException('Enter your first and last name.');

    const failure = async (reason: string, invitation: CompanyInvitation | null) => {
      // The reason only: never the token or any part of its digest.
      await this.auditLogService.log({
        company: invitation ? { id: invitation.companyId } : null,
        user: null,
        action: 'company.staff.invitation_accept_failed',
        entityType: 'company_invitation',
        entityId: invitation?.id ?? null,
        afterData: { reason },
        ipAddress: meta?.ipAddress ?? null,
        userAgent: meta?.userAgent ?? null,
      });
    };

    const tokenDigest = token ? this.digest(token) : null;
    const found = tokenDigest
      ? await this.dataSource.getRepository(CompanyInvitation).findOne({ where: { tokenDigest }, relations: ['company'] })
      : null;
    if (!found || stateOf(found) !== 'PENDING' || !isCompanyApproved(found.company)) {
      await failure(!found ? 'unknown' : stateOf(found) !== 'PENDING' ? stateOf(found).toLowerCase() : 'company_not_approved', found);
      throw new BadRequestException(INVALID_STAFF_INVITATION);
    }

    let result: { userId: number; membershipId: number; companyId: number; invitationId: number; role: CompanyMembershipRole; email: string };
    try {
      result = await this.dataSource.transaction(async (manager) => {
        const locked = await manager
          .getRepository(CompanyInvitation)
          .createQueryBuilder('i')
          .setLock('pessimistic_write')
          .where('i.id = :id', { id: found.id })
          .getOne();
        if (!locked || stateOf(locked) !== 'PENDING') throw new BadRequestException(INVALID_STAFF_INVITATION);

        const [existing] = await manager.query(`SELECT 1 FROM "users" WHERE lower("email") = lower($1) LIMIT 1`, [locked.email]);
        if (existing) throw new ConflictException({ code: 'STAFF_INVITATION_ACCOUNT_EXISTS', message: STAFF_INVITATION_ACCOUNT_EXISTS });

        const created = await this.usersService.create(
          { email: locked.email, password: dto.password, role: UserRole.COMPANY_STAFF, status: UserStatus.ACTIVE },
          manager,
        );
        // The link reached this address, so the address is verified.
        await manager.getRepository(User).update(created.id, { firstName, lastName, isEmailVerified: true });

        const membershipRepo = manager.getRepository(CompanyMembership);
        const membership = await membershipRepo.save(
          membershipRepo.create({
            userId: created.id,
            companyId: locked.companyId,
            membershipRole: locked.intendedMembershipRole,
            status: CompanyMembershipStatus.ACTIVE,
            invitedByUserId: locked.invitedByUserId,
            acceptedAt: new Date(),
          }),
        );

        locked.usedAt = new Date();
        await manager.getRepository(CompanyInvitation).save(locked);

        await this.auditLogService.logInTransaction(manager, {
          company: { id: locked.companyId },
          user: { id: created.id },
          action: 'company.staff.invitation_accepted',
          entityType: 'company_invitation',
          entityId: locked.id,
          afterData: { userId: created.id, membershipId: membership.id, role: locked.intendedMembershipRole, email: locked.email },
          ipAddress: meta?.ipAddress ?? null,
          userAgent: meta?.userAgent ?? null,
        });
        return {
          userId: created.id,
          membershipId: membership.id,
          companyId: locked.companyId,
          invitationId: locked.id,
          role: locked.intendedMembershipRole,
          email: locked.email,
        };
      });
    } catch (error) {
      if (error instanceof ConflictException) await failure('account_exists', found);
      else if (error instanceof BadRequestException) await failure('no_longer_pending', found);
      // The users.email unique constraint is the final word if two different invitations race for one address.
      else if ((error as { driverError?: { code?: string } })?.driverError?.code === '23505') {
        await failure('account_exists', found);
        throw new ConflictException({ code: 'STAFF_INVITATION_ACCOUNT_EXISTS', message: STAFF_INVITATION_ACCOUNT_EXISTS });
      }
      throw error;
    }

    return {
      accepted: true,
      email: result.email,
      companyName: found.company.name,
      role: result.role,
      message: `You have joined ${found.company.name} on S4. Sign in with ${result.email} and the password you just chose.`,
    };
  }
}
