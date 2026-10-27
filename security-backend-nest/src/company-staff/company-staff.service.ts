import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';

import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthSessionService } from '../auth/auth-session.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import {
  CompanyMembershipRole,
  CompanyMembershipStatus,
  CompanyPermission,
} from '../company-membership/company-membership-types';
import { CompanyInvitation } from '../company-membership/entities/company-invitation.entity';
import { CompanyMembership } from '../company-membership/entities/company-membership.entity';
import { companyStaffInvitationEmail } from '../email/company-staff-email.templates';
import { TransactionalEmailService } from '../email/transactional-email.service';
import { User, UserRole, UserStatus } from '../user/entities/user.entity';
import { UserService } from '../user/user.service';
import {
  accessChangeRefusal,
  assignableRoles,
  existingAccountRefusal,
  manageRefusal,
  normaliseStaffEmail,
  ROLE_LABELS,
  roleChangeRefusal,
  STAFF_REFUSAL_MESSAGES,
  StaffRefusal,
  StaffTarget,
  userRoleForMembership,
} from './company-staff-policy';
import { AcceptStaffInvitationDto, InviteCompanyStaffDto } from './dto/company-staff.dto';

/** 256 bits, the same as a refresh token or a password reset token. */
const TOKEN_BYTES = 32;
export const STAFF_INVITATION_TTL_DAYS = 7;
export const STAFF_INVITATION_TTL_MS = STAFF_INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;
/** Per company, per rolling hour. Stops one compromised Owner/Admin session being used to mail-bomb strangers. */
export const STAFF_INVITATIONS_PER_HOUR = 30;

/** Every refusal of a presented invitation link — unknown, expired, used, revoked — reads the same. */
export const INVALID_STAFF_INVITATION = 'This invitation link is invalid or has expired. Ask the company to send you a new invitation.';
/**
 * Every refusal because of the S4 account that already uses the address — a Guard, another company's holder or
 * member, a platform account — reads the same, so the link reveals nothing about what kind of account it is.
 */
export const STAFF_INVITATION_NOT_ACCEPTABLE =
  "This invitation can't be accepted with the S4 account that uses this email address. Ask the company to invite a different email address.";
export const STAFF_INVITATION_PASSWORD_REQUIRED = 'Choose a password for your new S4 account.';

/** Audit actions the Staff history shows: everything this module writes, and the two Control Room grants. */
export const STAFF_AUDIT_ACTIONS_EXACT = [
  'company_membership.amendment_authorisation',
  'company_membership.attendance_authorisation',
] as const;
export const STAFF_AUDIT_ACTION_PREFIXES = ['company_staff.', 'company_staff_invitation.'] as const;

/** The only audit fields the Staff history returns. Never a token, digest, password, IP or user agent. */
const AUDIT_FIELDS = [
  'role', 'previousRole', 'status', 'canAmendShifts', 'canManageAttendance', 'targetUserId', 'email',
  'invitationId', 'expiresAt', 'accountCreated', 'sessionsRevoked', 'reason', 'grantsCleared',
] as const;

export type InvitationState = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

type Actor = {
  companyId: number;
  companyName: string;
  userId: number;
  role: CompanyMembershipRole;
  primaryOwnerUserId: number;
};

type MembershipRow = {
  id: number;
  userId: number;
  membershipRole: CompanyMembershipRole;
  status: CompanyMembershipStatus;
  canAmendShifts: boolean;
  canManageAttendance: boolean;
};

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  return (error as QueryFailedError & { driverError?: { code?: string } }).driverError?.code === '23505';
}

function displayName(row: { firstName?: string | null; lastName?: string | null; email?: string | null }) {
  const name = [row.firstName, row.lastName].map((p) => (p ?? '').trim()).filter(Boolean).join(' ');
  return name || (row.email ?? '').trim() || 'Staff member';
}

/**
 * Company staff management (owner-approved 27 Oct 2026): invite staff by email, assign roles, suspend / reactivate /
 * remove, and read the history of those changes.
 *
 * Built only on what S4 already has: users (one account per email, UserService.create's bcrypt), the
 * company_memberships role/permission model and its fail-closed resolution (CompanyMembershipService), the
 * company_invitations table Migration 1720800000005 created for exactly this and that nothing used until now,
 * refresh-session revocation (AuthSessionService.revokeAllForUser) and the audit log. No migration.
 *
 * Nobody sets another person's password. A new account chooses its own on the emailed account-link page; an existing
 * account keeps its password and is only linked. The invitation token is emailed only — never returned by any route.
 */
@Injectable()
export class CompanyStaffService {
  private readonly logger = new Logger('CompanyStaff');

  constructor(
    private readonly dataSource: DataSource,
    private readonly membershipService: CompanyMembershipService,
    private readonly users: UserService,
    private readonly sessions: AuthSessionService,
    private readonly email: TransactionalEmailService,
    private readonly auditLog: AuditLogService,
  ) {}

  static stateOf(invitation: Pick<CompanyInvitation, 'usedAt' | 'revokedAt' | 'expiresAt'>, now = new Date()): InvitationState {
    if (invitation.revokedAt) return 'REVOKED';
    if (invitation.usedAt) return 'ACCEPTED';
    if (invitation.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
    return 'PENDING';
  }

  // ── who is asking ─────────────────────────────────────────────────────────────────────────────────

  /** An Owner or Admin of a company (staff.manage). Guards, platform administrators and client accounts never. */
  private async actor(user: JwtPayload): Promise<Actor> {
    if (user.principalType === 'client_portal' || user.role === UserRole.GUARD || user.role === UserRole.ADMIN) {
      throw new ForbiddenException(STAFF_REFUSAL_MESSAGES.not_a_manager);
    }
    const { company, membershipRole } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.STAFF_MANAGE,
    );
    const [row] = await this.dataSource.query(`SELECT "userId" FROM "companies" WHERE "id" = $1`, [company.id]);
    return {
      companyId: company.id,
      companyName: company.name,
      userId: user.sub,
      role: membershipRole,
      primaryOwnerUserId: Number(row?.userId),
    };
  }

  private refuse(refusal: StaffRefusal): never {
    const message = STAFF_REFUSAL_MESSAGES[refusal];
    if (refusal === 'last_owner') throw new ConflictException(message);
    throw new ForbiddenException(message);
  }

  /** This company's membership row for a person, locked. Another company's staff is indistinguishable from nobody. */
  private async lockMembership(manager: EntityManager, companyId: number, userId: number): Promise<MembershipRow> {
    const [row] = await manager.query(
      `SELECT "id", "userId", "membershipRole", "status", "canAmendShifts", "canManageAttendance"
         FROM "company_memberships" WHERE "companyId" = $1 AND "userId" = $2 FOR UPDATE`,
      [companyId, userId],
    );
    if (!row) throw new NotFoundException('Staff member not found.');
    return { ...row, id: Number(row.id), userId: Number(row.userId) };
  }

  /**
   * Active Owners other than the target, counting the company's account holder (who has no membership row on
   * companies created after Migration 1720800000005 and is always an active Owner). The Owner rows are locked, so
   * two Owners demoting each other at once cannot both succeed.
   */
  private async otherActiveOwners(manager: EntityManager, actor: Actor, targetUserId: number): Promise<number> {
    const rows = await manager.query(
      `SELECT "userId" FROM "company_memberships"
        WHERE "companyId" = $1 AND "membershipRole" = 'owner' AND "status" = 'active' FOR UPDATE`,
      [actor.companyId],
    );
    const owners = new Set<number>(rows.map((r: { userId: number }) => Number(r.userId)));
    owners.add(actor.primaryOwnerUserId);
    owners.delete(targetUserId);
    return owners.size;
  }

  private target(actor: Actor, membership: MembershipRow): StaffTarget {
    return {
      userId: membership.userId,
      role: membership.membershipRole,
      isPrimaryOwner: membership.userId === actor.primaryOwnerUserId,
    };
  }

  private assertNotPrimaryOwner(actor: Actor, targetUserId: number) {
    if (targetUserId === actor.primaryOwnerUserId) this.refuse('primary_owner');
  }

  private audit(manager: EntityManager, actor: Actor, action: string, entityType: string, entityId: number | null,
    beforeData: Record<string, unknown> | null, afterData: Record<string, unknown>) {
    return this.auditLog.logInTransaction(manager, {
      company: { id: actor.companyId },
      user: { id: actor.userId },
      action,
      entityType,
      entityId,
      beforeData,
      afterData,
    });
  }

  // ── list ──────────────────────────────────────────────────────────────────────────────────────────

  async list(user: JwtPayload) {
    const actor = await this.actor(user);
    const rows = (await this.dataSource.query(
      `SELECT u."id" AS "userId", u."email", u."firstName", u."lastName", u."lastLoginAt",
              m."id" AS "membershipId", m."membershipRole"::text AS "role", m."status"::text AS "status",
              m."canAmendShifts", m."canManageAttendance", m."acceptedAt", m."disabledAt"
         FROM "company_memberships" m JOIN "users" u ON u."id" = m."userId"
        WHERE m."companyId" = $1
        ORDER BY m."id" ASC`,
      [actor.companyId],
    )) as Array<Record<string, any>>;
    const [owner] = (await this.dataSource.query(
      `SELECT u."id" AS "userId", u."email", u."firstName", u."lastName", u."lastLoginAt"
         FROM "companies" c JOIN "users" u ON u."id" = c."userId" WHERE c."id" = $1`,
      [actor.companyId],
    )) as Array<Record<string, any>>;

    const byUser = new Map<number, Record<string, any>>();
    if (owner) {
      byUser.set(Number(owner.userId), {
        ...owner, membershipId: null, role: CompanyMembershipRole.OWNER, status: CompanyMembershipStatus.ACTIVE,
        canAmendShifts: false, canManageAttendance: false, acceptedAt: null, disabledAt: null,
      });
    }
    for (const row of rows) {
      const id = Number(row.userId);
      // The account holder is always shown as the active Owner, whatever a backfilled row says.
      if (id === actor.primaryOwnerUserId) {
        byUser.set(id, { ...byUser.get(id), membershipId: Number(row.membershipId), acceptedAt: row.acceptedAt });
        continue;
      }
      byUser.set(id, row);
    }

    const members = [...byUser.values()].map((row) => {
      const userId = Number(row.userId);
      const role = row.role as CompanyMembershipRole;
      const status = row.status as CompanyMembershipStatus;
      const target: StaffTarget = { userId, role, isPrimaryOwner: userId === actor.primaryOwnerUserId };
      const manageable = !manageRefusal(actor, target);
      const isControlRoom = role === CompanyMembershipRole.CONTROL_ROOM;
      return {
        userId,
        membershipId: row.membershipId === null || row.membershipId === undefined ? null : Number(row.membershipId),
        displayName: displayName(row),
        email: row.email,
        role,
        roleLabel: ROLE_LABELS[role] ?? role,
        status,
        isPrimaryOwner: target.isPrimaryOwner,
        isYou: userId === actor.userId,
        canAmendShifts: isControlRoom ? Boolean(row.canAmendShifts) : false,
        canManageAttendance: isControlRoom ? Boolean(row.canManageAttendance) : false,
        lastLoginAt: row.lastLoginAt ?? null,
        joinedAt: row.acceptedAt ?? null,
        disabledAt: row.disabledAt ?? null,
        // What this viewer may do to this member. Display only: every route re-checks under lock.
        actions: {
          changeRole: manageable && status !== CompanyMembershipStatus.REVOKED,
          suspend: manageable && status === CompanyMembershipStatus.ACTIVE,
          reactivate: manageable && status === CompanyMembershipStatus.SUSPENDED,
          remove: manageable && status !== CompanyMembershipStatus.REVOKED,
          grants: isControlRoom && status === CompanyMembershipStatus.ACTIVE,
        },
      };
    });
    const statusOrder = { active: 0, suspended: 1, revoked: 2 } as Record<string, number>;
    members.sort((a, b) =>
      Number(b.isPrimaryOwner) - Number(a.isPrimaryOwner) ||
      (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3) ||
      a.displayName.localeCompare(b.displayName));

    const invitations = await this.dataSource.getRepository(CompanyInvitation).find({
      where: { companyId: actor.companyId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: 100,
    });

    return {
      you: { userId: actor.userId, role: actor.role, isPrimaryOwner: actor.userId === actor.primaryOwnerUserId },
      assignableRoles: assignableRoles(actor.role).map((role) => ({ role, label: ROLE_LABELS[role] })),
      members,
      invitations: invitations
        .map((invitation) => this.invitationView(invitation, actor))
        .filter((view) => view.state === 'PENDING' || view.state === 'EXPIRED'),
    };
  }

  private invitationView(invitation: CompanyInvitation, actor: Actor) {
    const state = CompanyStaffService.stateOf(invitation);
    const role = invitation.intendedMembershipRole;
    return {
      id: invitation.id,
      email: invitation.email,
      role,
      roleLabel: ROLE_LABELS[role] ?? role,
      state,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      invitedByUserId: invitation.invitedByUserId,
      // Only an Owner may re-send or withdraw an Owner or Admin invitation.
      canManage: assignableRoles(actor.role).includes(role),
    };
  }

  // ── invitations (company side) ────────────────────────────────────────────────────────────────────

  /**
   * Invite someone by email. The response is the same whether or not the address already has an S4 account, and
   * whatever kind of account it is: whether they can join is decided when they accept, and an unsuitable account is
   * refused then, generically. The only address refused here is one already on this company's own staff.
   */
  async invite(user: JwtPayload, dto: InviteCompanyStaffDto) {
    const actor = await this.actor(user);
    const email = normaliseStaffEmail(dto.email);
    if (!assignableRoles(actor.role).includes(dto.role)) this.refuse('role_not_assignable');

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const invitation = await this.dataSource.transaction(async (manager) => {
      // Serialise this company's invitations so the hourly cap and the "already a member" check hold under races.
      // FOR NO KEY UPDATE: does not block other transactions inserting rows that reference the company.
      await manager.query(`SELECT "id" FROM "companies" WHERE "id" = $1 FOR NO KEY UPDATE`, [actor.companyId]);
      const repo = manager.getRepository(CompanyInvitation);
      const recent = await repo
        .createQueryBuilder('i')
        .where('i.companyId = :companyId', { companyId: actor.companyId })
        // createdAt is written by the database clock, so it is compared against the database clock.
        .andWhere(`i.createdAt > now() - interval '1 hour'`)
        .getCount();
      if (recent >= STAFF_INVITATIONS_PER_HOUR) {
        throw new HttpException('Too many invitations have been sent in the last hour. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
      }

      // Already on this company's staff (the account holder, or an active / suspended member): this company's own
      // information, so it can be said plainly. Nothing about any other company is consulted.
      const [member] = await manager.query(
        `SELECT u."id" FROM "users" u
          WHERE LOWER(u."email") = $2
            AND (u."id" = (SELECT "userId" FROM "companies" WHERE "id" = $1)
                 OR EXISTS (SELECT 1 FROM "company_memberships" m
                             WHERE m."userId" = u."id" AND m."companyId" = $1 AND m."status" IN ('active', 'suspended')))
          LIMIT 1`,
        [actor.companyId, email],
      );
      if (member) throw new ConflictException('This person is already a member of your company.');

      // A new invitation supersedes any earlier one to the same address, so only the newest link works.
      const earlier = await repo
        .createQueryBuilder('i')
        .setLock('pessimistic_write')
        .where('i.companyId = :companyId', { companyId: actor.companyId })
        .andWhere('LOWER(i.email) = :email', { email })
        .andWhere('i.usedAt IS NULL AND i.revokedAt IS NULL')
        .getMany();
      for (const old of earlier) {
        await repo.update({ id: old.id }, { revokedAt: new Date(), revokedByUserId: actor.userId });
        await this.audit(manager, actor, 'company_staff_invitation.revoked', 'company_invitation', old.id,
          { state: CompanyStaffService.stateOf(old) },
          { invitationId: old.id, email: old.email, role: old.intendedMembershipRole, reason: 'superseded' });
      }

      const saved = await repo.save(repo.create({
        companyId: actor.companyId,
        email,
        intendedMembershipRole: dto.role,
        tokenDigest: digest(token),
        expiresAt: new Date(Date.now() + STAFF_INVITATION_TTL_MS),
        usedAt: null,
        revokedAt: null,
        revokedByUserId: null,
        invitedByUserId: actor.userId,
      }));
      // No token, no digest.
      await this.audit(manager, actor, 'company_staff_invitation.created', 'company_invitation', saved.id, null,
        { invitationId: saved.id, email, role: dto.role, expiresAt: saved.expiresAt.toISOString() });
      return saved;
    });

    const emailSent = await this.sendInvitation(email, token, actor.companyName, invitation.intendedMembershipRole);
    return { invitation: this.invitationView(invitation, actor), emailSent };
  }

  private sendInvitation(to: string, token: string, companyName: string, role: CompanyMembershipRole) {
    return this.email.send(
      companyStaffInvitationEmail(to, this.email.webAppUrl, token, companyName, ROLE_LABELS[role] ?? role, STAFF_INVITATION_TTL_DAYS),
    );
  }

  private async lockInvitation(manager: EntityManager, actor: Actor, invitationId: number) {
    const invitation = await manager
      .getRepository(CompanyInvitation)
      .createQueryBuilder('i')
      .setLock('pessimistic_write')
      .where('i.id = :id AND i.companyId = :companyId', { id: invitationId, companyId: actor.companyId })
      .getOne();
    // Another company's invitation is indistinguishable from one that does not exist.
    if (!invitation) throw new NotFoundException('Invitation not found.');
    if (!assignableRoles(actor.role).includes(invitation.intendedMembershipRole)) this.refuse('role_not_assignable');
    const state = CompanyStaffService.stateOf(invitation);
    if (state !== 'PENDING' && state !== 'EXPIRED') {
      throw new ConflictException(`This invitation has already been ${state === 'ACCEPTED' ? 'accepted' : 'withdrawn'}.`);
    }
    return { invitation, state };
  }

  /** A fresh link (and a fresh 7 days) for a pending or expired invitation. The previous link stops working. */
  async resendInvitation(user: JwtPayload, invitationId: number) {
    const actor = await this.actor(user);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const invitation = await this.dataSource.transaction(async (manager) => {
      const { invitation: locked, state } = await this.lockInvitation(manager, actor, invitationId);
      locked.tokenDigest = digest(token);
      locked.expiresAt = new Date(Date.now() + STAFF_INVITATION_TTL_MS);
      const saved = await manager.getRepository(CompanyInvitation).save(locked);
      await this.audit(manager, actor, 'company_staff_invitation.resent', 'company_invitation', saved.id, { state },
        { invitationId: saved.id, email: saved.email, role: saved.intendedMembershipRole, expiresAt: saved.expiresAt.toISOString() });
      return saved;
    });
    const emailSent = await this.sendInvitation(invitation.email, token, actor.companyName, invitation.intendedMembershipRole);
    return { invitation: this.invitationView(invitation, actor), emailSent };
  }

  async revokeInvitation(user: JwtPayload, invitationId: number) {
    const actor = await this.actor(user);
    const invitation = await this.dataSource.transaction(async (manager) => {
      const { invitation: locked, state } = await this.lockInvitation(manager, actor, invitationId);
      locked.revokedAt = new Date();
      locked.revokedByUserId = actor.userId;
      const saved = await manager.getRepository(CompanyInvitation).save(locked);
      await this.audit(manager, actor, 'company_staff_invitation.revoked', 'company_invitation', saved.id, { state },
        { invitationId: saved.id, email: saved.email, role: saved.intendedMembershipRole, reason: 'withdrawn' });
      return saved;
    });
    return { invitation: this.invitationView(invitation, actor) };
  }

  // ── members ───────────────────────────────────────────────────────────────────────────────────────

  async changeRole(user: JwtPayload, targetUserId: number, nextRole: CompanyMembershipRole) {
    const actor = await this.actor(user);
    this.assertNotPrimaryOwner(actor, targetUserId);
    return this.dataSource.transaction(async (manager) => {
      const membership = await this.lockMembership(manager, actor.companyId, targetUserId);
      if (membership.status === CompanyMembershipStatus.REVOKED) {
        throw new ConflictException('This person has been removed. Invite them again to restore their access.');
      }
      const others = await this.otherActiveOwners(manager, actor, targetUserId);
      const refusal = roleChangeRefusal(actor, this.target(actor, membership), nextRole, others);
      if (refusal) this.refuse(refusal);
      if (membership.membershipRole === nextRole) return { userId: targetUserId, role: nextRole, changed: false };

      // A Control Room grant means nothing in any other role; cleared so it cannot silently return with the role.
      const clearGrants = nextRole !== CompanyMembershipRole.CONTROL_ROOM;
      await manager.query(
        `UPDATE "company_memberships"
            SET "membershipRole" = $2,
                "canAmendShifts" = CASE WHEN $3 THEN false ELSE "canAmendShifts" END,
                "canManageAttendance" = CASE WHEN $3 THEN false ELSE "canManageAttendance" END,
                "updatedAt" = now()
          WHERE "id" = $1`,
        [membership.id, nextRole, clearGrants],
      );
      await this.syncUserRole(manager, targetUserId, nextRole);
      await this.audit(manager, actor, 'company_staff.role_changed', 'company_membership', membership.id,
        { role: membership.membershipRole, canAmendShifts: Boolean(membership.canAmendShifts), canManageAttendance: Boolean(membership.canManageAttendance) },
        {
          targetUserId, role: nextRole, previousRole: membership.membershipRole,
          canAmendShifts: clearGrants ? false : Boolean(membership.canAmendShifts),
          canManageAttendance: clearGrants ? false : Boolean(membership.canManageAttendance),
          grantsCleared: clearGrants && (Boolean(membership.canAmendShifts) || Boolean(membership.canManageAttendance)),
        });
      return { userId: targetUserId, role: nextRole, changed: true };
    });
  }

  /**
   * Keep the account role in step with the membership (see userRoleForMembership). Only ever a company account: the
   * WHERE clause cannot touch a Guard, platform or client account even if one somehow had a membership row.
   */
  private async syncUserRole(manager: EntityManager, userId: number, role: CompanyMembershipRole) {
    await manager.query(
      `UPDATE "users" SET "role" = $2, "updatedAt" = now()
        WHERE "id" = $1 AND "role" IN ('company_staff', 'company_admin', 'company') AND "role" <> $2`,
      [userId, userRoleForMembership(role)],
    );
  }

  /**
   * Suspend: the member keeps their place but loses access at once. CompanyMembershipService fails closed on a
   * SUSPENDED row for every company route from the next request, and every refresh session is revoked in the same
   * transaction, so a mobile app cannot renew its way back in.
   */
  async suspend(user: JwtPayload, targetUserId: number) {
    const actor = await this.actor(user);
    this.assertNotPrimaryOwner(actor, targetUserId);
    return this.dataSource.transaction(async (manager) => {
      const membership = await this.lockMembership(manager, actor.companyId, targetUserId);
      if (membership.status !== CompanyMembershipStatus.ACTIVE) {
        throw new ConflictException(membership.status === CompanyMembershipStatus.SUSPENDED
          ? 'This person is already suspended.'
          : 'This person has been removed.');
      }
      const refusal = accessChangeRefusal(actor, this.target(actor, membership), await this.otherActiveOwners(manager, actor, targetUserId));
      if (refusal) this.refuse(refusal);
      await manager.query(
        `UPDATE "company_memberships" SET "status" = 'suspended', "disabledAt" = $2, "disabledByUserId" = $3, "updatedAt" = now()
          WHERE "id" = $1`,
        [membership.id, new Date(), actor.userId],
      );
      await this.sessions.revokeAllForUser(targetUserId, 'membership_suspended', manager);
      await this.audit(manager, actor, 'company_staff.suspended', 'company_membership', membership.id,
        { status: membership.status }, { targetUserId, status: CompanyMembershipStatus.SUSPENDED, role: membership.membershipRole, sessionsRevoked: true });
      return { userId: targetUserId, status: CompanyMembershipStatus.SUSPENDED };
    });
  }

  async reactivate(user: JwtPayload, targetUserId: number) {
    const actor = await this.actor(user);
    this.assertNotPrimaryOwner(actor, targetUserId);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const membership = await this.lockMembership(manager, actor.companyId, targetUserId);
        if (membership.status !== CompanyMembershipStatus.SUSPENDED) {
          throw new ConflictException(membership.status === CompanyMembershipStatus.ACTIVE
            ? 'This person is already active.'
            : 'This person has been removed. Invite them again to restore their access.');
        }
        const refusal = manageRefusal(actor, this.target(actor, membership));
        if (refusal) this.refuse(refusal);
        await manager.query(
          `UPDATE "company_memberships" SET "status" = 'active', "disabledAt" = NULL, "disabledByUserId" = NULL, "updatedAt" = now()
            WHERE "id" = $1`,
          [membership.id],
        );
        await this.audit(manager, actor, 'company_staff.reactivated', 'company_membership', membership.id,
          { status: membership.status }, { targetUserId, status: CompanyMembershipStatus.ACTIVE, role: membership.membershipRole });
        return { userId: targetUserId, status: CompanyMembershipStatus.ACTIVE };
      });
    } catch (error) {
      // uq_one_active_membership_per_user: cannot happen while SUSPENDED binds the person here, but never a 500.
      if (isUniqueViolation(error)) throw new ConflictException('This person cannot be reactivated.');
      throw error;
    }
  }

  /**
   * Remove: the membership is REVOKED (kept, never deleted, so the history and evidence stay intact), the Control Room
   * grants are cleared, and every refresh session is revoked. The account itself is untouched; a removed person can
   * only come back through a new invitation they accept.
   */
  async remove(user: JwtPayload, targetUserId: number) {
    const actor = await this.actor(user);
    this.assertNotPrimaryOwner(actor, targetUserId);
    return this.dataSource.transaction(async (manager) => {
      const membership = await this.lockMembership(manager, actor.companyId, targetUserId);
      if (membership.status === CompanyMembershipStatus.REVOKED) throw new ConflictException('This person has already been removed.');
      const refusal = accessChangeRefusal(actor, this.target(actor, membership), await this.otherActiveOwners(manager, actor, targetUserId));
      if (refusal) this.refuse(refusal);
      await manager.query(
        `UPDATE "company_memberships"
            SET "status" = 'revoked', "disabledAt" = $2, "disabledByUserId" = $3,
                "canAmendShifts" = false, "canManageAttendance" = false, "updatedAt" = now()
          WHERE "id" = $1`,
        [membership.id, new Date(), actor.userId],
      );
      await this.sessions.revokeAllForUser(targetUserId, 'membership_removed', manager);
      await this.audit(manager, actor, 'company_staff.removed', 'company_membership', membership.id,
        { status: membership.status, role: membership.membershipRole, canAmendShifts: Boolean(membership.canAmendShifts), canManageAttendance: Boolean(membership.canManageAttendance) },
        { targetUserId, status: CompanyMembershipStatus.REVOKED, role: membership.membershipRole, sessionsRevoked: true, canAmendShifts: false, canManageAttendance: false });
      return { userId: targetUserId, status: CompanyMembershipStatus.REVOKED };
    });
  }

  // ── history ───────────────────────────────────────────────────────────────────────────────────────

  /**
   * This company's staff and permission changes, newest first: ids, actions, who did it, to whom, and when. Only
   * the fields in AUDIT_FIELDS leave the server; names are resolved only for people who are or were on this
   * company's staff.
   */
  async auditHistory(user: JwtPayload, limit = 200) {
    const actor = await this.actor(user);
    const rows = (await this.dataSource.query(
      `SELECT a."id", a."action", a."entityType", a."entityId", a."beforeData", a."afterData", a."createdAt",
              a."userId" AS "actorUserId"
         FROM "audit_logs" a
        WHERE a."companyId" = $1
          AND (a."action" LIKE 'company\\_staff.%' OR a."action" LIKE 'company\\_staff\\_invitation.%' OR a."action" = ANY($2))
        ORDER BY a."createdAt" DESC, a."id" DESC
        LIMIT $3`,
      [actor.companyId, [...STAFF_AUDIT_ACTIONS_EXACT], Math.min(Math.max(Number(limit) || 200, 1), 500)],
    )) as Array<Record<string, any>>;

    const pick = (data: unknown) => {
      if (!data || typeof data !== 'object') return null;
      const out: Record<string, unknown> = {};
      for (const key of AUDIT_FIELDS) {
        if (key in (data as Record<string, unknown>)) out[key] = (data as Record<string, unknown>)[key];
      }
      return Object.keys(out).length ? out : null;
    };
    const parse = (value: unknown) => {
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); } catch { return null; }
    };

    const entries = rows.map((row) => {
      const before = pick(parse(row.beforeData));
      const after = pick(parse(row.afterData));
      const target = after?.targetUserId ?? before?.targetUserId;
      return {
        id: Number(row.id),
        action: String(row.action),
        entityType: String(row.entityType),
        entityId: row.entityId === null ? null : Number(row.entityId),
        actorUserId: row.actorUserId === null ? null : Number(row.actorUserId),
        targetUserId: typeof target === 'number' ? target : target ? Number(target) : null,
        before,
        after,
        createdAt: row.createdAt,
      };
    });

    const ids = [...new Set(entries.flatMap((e) => [e.actorUserId, e.targetUserId]).filter((id): id is number => Number.isFinite(id as number)))];
    const people = ids.length
      ? ((await this.dataSource.query(
        `SELECT u."id", u."firstName", u."lastName", u."email" FROM "users" u
          WHERE u."id" = ANY($2)
            AND (u."id" = (SELECT "userId" FROM "companies" WHERE "id" = $1)
                 OR EXISTS (SELECT 1 FROM "company_memberships" m WHERE m."userId" = u."id" AND m."companyId" = $1))`,
        [actor.companyId, ids],
      )) as Array<Record<string, any>>)
      : [];
    const names = new Map(people.map((p) => [Number(p.id), displayName(p)]));
    return {
      entries: entries.map((e) => ({
        ...e,
        actorName: e.actorUserId === null ? null : names.get(e.actorUserId) ?? `User #${e.actorUserId}`,
        targetName: e.targetUserId === null ? null : names.get(e.targetUserId) ?? `User #${e.targetUserId}`,
      })),
    };
  }

  // ── invitations (invitee side, unauthenticated) ───────────────────────────────────────────────────

  /** The existing S4 account(s) using this address, case-insensitively. Deleted accounts no longer carry it. */
  private async accountsFor(manager: EntityManager, email: string, lock: boolean) {
    return (await manager.query(
      `SELECT u."id", u."role", u."status", u."deletionCompletedAt", u."isEmailVerified",
              EXISTS (SELECT 1 FROM "companies" c WHERE c."userId" = u."id") AS "ownsCompany"
         FROM "users" u WHERE LOWER(u."email") = $1 ORDER BY u."id" ${lock ? 'FOR UPDATE OF u' : ''}`,
      [email],
    )) as Array<{ id: number; role: UserRole; status: string; deletionCompletedAt: Date | null; isEmailVerified: boolean; ownsCompany: boolean }>;
  }

  private async accountRefusal(accounts: Awaited<ReturnType<CompanyStaffService['accountsFor']>>): Promise<string | null> {
    if (accounts.length > 1) return 'ambiguous_email';
    const [account] = accounts;
    if (!account) return null;
    const binding = await this.membershipService.canAcceptInvitation(Number(account.id));
    return existingAccountRefusal({
      role: account.role,
      status: account.status,
      deleted: Boolean(account.deletionCompletedAt),
      ownsCompany: Boolean(account.ownsCompany),
      boundToCompany: !binding.allowed,
    });
  }

  private async findPending(token: string) {
    const invitation = await this.dataSource.getRepository(CompanyInvitation).findOne({
      where: { tokenDigest: digest(token) },
      relations: ['company'],
    });
    if (!invitation || CompanyStaffService.stateOf(invitation) !== 'PENDING') return null;
    return invitation;
  }

  /**
   * What the emailed link is for: company, role, the invited address, and whether that address already has an S4
   * account (so the page asks a new person for a password and tells an existing one to keep theirs). The caller holds
   * a link only that inbox received. Writes nothing.
   */
  async preview(token: string) {
    const invitation = await this.findPending(token);
    if (!invitation) throw new BadRequestException(INVALID_STAFF_INVITATION);
    const accounts = await this.accountsFor(this.dataSource.manager, normaliseStaffEmail(invitation.email), false);
    if (await this.accountRefusal(accounts)) throw new ForbiddenException(STAFF_INVITATION_NOT_ACCEPTABLE);
    const role = invitation.intendedMembershipRole;
    return {
      companyName: invitation.company?.name ?? 'Your company',
      role,
      roleLabel: ROLE_LABELS[role] ?? role,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
      accountExists: accounts.length === 1,
    };
  }

  /**
   * Accept, all or nothing: the invitation is locked and re-validated, the account is created (new address) or linked
   * (existing, eligible account), the membership is created or a removed one restored, and the invitation is spent.
   *
   * A new account's password is the one its owner types on the account-link page, hashed by UserService.create exactly
   * as registration does; possession of the emailed link proves the address, as it does for a password reset. An
   * existing account's password, sessions and verification are never changed by anyone else — it is only linked, and
   * signs in as it always has.
   */
  async accept(dto: AcceptStaffInvitationDto, meta?: { ipAddress?: string | null; userAgent?: string | null }) {
    type Outcome =
      | { ok: true; userId: number; companyId: number; companyName: string; role: CompanyMembershipRole; accountCreated: boolean; invitationId: number }
      | { ok: false; reason: string; invitationId: number | null; notAcceptable: boolean };

    let outcome: Outcome;
    try {
      outcome = await this.dataSource.transaction(async (manager): Promise<Outcome> => {
        const invitations = manager.getRepository(CompanyInvitation);
        const invitation = await invitations
          .createQueryBuilder('i')
          .setLock('pessimistic_write')
          .where('i.tokenDigest = :tokenDigest', { tokenDigest: digest(String(dto.token ?? '')) })
          .getOne();
        if (!invitation) return { ok: false, reason: 'unknown', invitationId: null, notAcceptable: false };
        const state = CompanyStaffService.stateOf(invitation);
        if (state !== 'PENDING') return { ok: false, reason: state.toLowerCase(), invitationId: invitation.id, notAcceptable: false };

        const email = normaliseStaffEmail(invitation.email);
        const accounts = await this.accountsFor(manager, email, true);
        const refusal = await this.accountRefusal(accounts);
        if (refusal) return { ok: false, reason: refusal, invitationId: invitation.id, notAcceptable: true };

        const role = invitation.intendedMembershipRole;
        let userId: number;
        let accountCreated = false;
        if (accounts.length === 1) {
          userId = Number(accounts[0].id);
          await this.syncUserRole(manager, userId, role);
          // The link reached this inbox and was used: the same proof a password reset accepts. Nothing else changes.
          if (!accounts[0].isEmailVerified) await manager.query(`UPDATE "users" SET "isEmailVerified" = true WHERE "id" = $1`, [userId]);
        } else {
          if (!dto.newPassword) throw new BadRequestException(STAFF_INVITATION_PASSWORD_REQUIRED);
          const created = await this.users.create(
            { email, password: dto.newPassword, role: userRoleForMembership(role), status: UserStatus.ACTIVE },
            manager,
          );
          await manager.getRepository(User).update({ id: created.id }, {
            isEmailVerified: true,
            firstName: dto.firstName?.trim() || null,
            lastName: dto.lastName?.trim() || null,
          });
          userId = created.id;
          accountCreated = true;
        }

        // One row per person and company (uq_cm_user_company): a removed member's row is restored, never duplicated.
        const [existing] = await manager.query(
          `SELECT "id" FROM "company_memberships" WHERE "userId" = $1 AND "companyId" = $2 FOR UPDATE`,
          [userId, invitation.companyId],
        );
        if (existing) {
          await manager.query(
            `UPDATE "company_memberships"
                SET "membershipRole" = $2, "status" = 'active', "invitedByUserId" = $3, "acceptedAt" = $4,
                    "disabledAt" = NULL, "disabledByUserId" = NULL, "canAmendShifts" = false, "canManageAttendance" = false,
                    "updatedAt" = now()
              WHERE "id" = $1`,
            [existing.id, role, invitation.invitedByUserId, new Date()],
          );
        } else {
          const memberships = manager.getRepository(CompanyMembership);
          await memberships.save(memberships.create({
            userId,
            companyId: invitation.companyId,
            membershipRole: role,
            status: CompanyMembershipStatus.ACTIVE,
            invitedByUserId: invitation.invitedByUserId,
            acceptedAt: new Date(),
            canAmendShifts: false,
            canManageAttendance: false,
          }));
        }

        await invitations.update({ id: invitation.id }, { usedAt: new Date() });
        const [company] = await manager.query(`SELECT "name" FROM "companies" WHERE "id" = $1`, [invitation.companyId]);
        await this.auditLog.logInTransaction(manager, {
          company: { id: invitation.companyId },
          user: { id: userId },
          action: 'company_staff_invitation.accepted',
          entityType: 'company_invitation',
          entityId: invitation.id,
          beforeData: { state },
          afterData: { invitationId: invitation.id, targetUserId: userId, role, email, accountCreated },
          ipAddress: meta?.ipAddress ?? null,
          userAgent: meta?.userAgent ?? null,
        });
        return { ok: true, userId, companyId: invitation.companyId, companyName: company?.name ?? 'your company', role, accountCreated, invitationId: invitation.id };
      });
    } catch (error) {
      // A concurrent registration of the same address, or a membership elsewhere created in the meantime.
      if (isUniqueViolation(error)) {
        outcome = { ok: false, reason: 'concurrent_conflict', invitationId: null, notAcceptable: true };
      } else {
        throw error;
      }
    }

    if (!outcome.ok) {
      // Platform-only record (no company): the reason may describe the account behind the address, which the
      // inviting company must never learn. Digest-free, token-free.
      await this.auditLog.log({
        company: null,
        user: null,
        action: 'company_staff_invitation.accept_refused',
        entityType: 'company_invitation',
        entityId: outcome.invitationId,
        afterData: { reason: outcome.reason },
        ipAddress: meta?.ipAddress ?? null,
        userAgent: meta?.userAgent ?? null,
      });
      this.logger.warn(JSON.stringify({ event: 'staff_invitation_accept_refused', reason: outcome.reason }));
      if (outcome.notAcceptable) throw new ForbiddenException(STAFF_INVITATION_NOT_ACCEPTABLE);
      throw new BadRequestException(INVALID_STAFF_INVITATION);
    }

    return {
      accepted: true,
      accountCreated: outcome.accountCreated,
      companyName: outcome.companyName,
      role: outcome.role,
      roleLabel: ROLE_LABELS[outcome.role] ?? outcome.role,
      message: outcome.accountCreated
        ? `Your S4 account has been created and you have joined ${outcome.companyName}. Sign in with this email address and the password you chose.`
        : `You have joined ${outcome.companyName}. Sign in to S4 with your existing password.`,
    };
  }
}
