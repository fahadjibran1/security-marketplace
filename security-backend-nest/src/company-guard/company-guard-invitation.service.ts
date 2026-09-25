import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createHash, randomBytes } from 'node:crypto';

import {
  CompanyGuard,
  CompanyGuardRelationshipType,
  CompanyGuardStatus,
} from './entities/company-guard.entity';
import { CompanyGuardInvitation } from './entities/company-guard-invitation.entity';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CreateCompanyGuardInvitationDto } from './dto/create-company-guard-invitation.dto';
import { RedeemCompanyGuardInvitationDto } from './dto/redeem-company-guard-invitation.dto';

/** 256 bits, matching AuthSessionService. */
const TOKEN_BYTES = 32;

/**
 * Seven days. No existing invitation expiry convention exists in the codebase to inherit —
 * company_invitations has an expiresAt column but never gained a service that sets it — so this is a
 * deliberate choice: long enough for a company to hand a code over in person at the next shift
 * handover, short enough that a code found on a scrap of paper months later is worthless.
 */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The responsibility a company accepts when it brings in a guard this way. Recorded verbatim in the
 * creation audit payload so there is a durable record of what the issuing user was told, without a
 * database flag that could drift from the wording actually shown.
 */
export const COMPANY_MANAGED_RESPONSIBILITY_STATEMENT =
  'This company manages its own employment, screening and deployment compliance for ' +
  'company-managed guards unless S4 separately provides a specified screening service.';

/**
 * Deliberately identical for every failure mode — unknown, malformed, expired, already used,
 * declined, revoked, or addressed to a different licence. A caller learns only that this code is not
 * usable by them, never whether it exists or what became of it.
 */
const GENERIC_CODE_FAILURE = 'That invitation code is not valid.';

export type InvitationState = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED' | 'EXPIRED';

/** Company-facing projection. Carries no token material. */
export type CompanyInvitationView = {
  id: number;
  relationshipType: CompanyGuardRelationshipType;
  targetSiaLicenceNumber: string | null;
  state: InvitationState;
  createdAt: Date;
  expiresAt: Date;
  invitedByUserId: number;
  resolvedAt: Date | null;
};

/** Guard-facing preview. Company display name only — no internal company record. */
export type GuardInvitationPreview = {
  companyName: string;
  relationshipType: CompanyGuardRelationshipType;
  expiresAt: Date;
  alreadyInWorkforce: boolean;
};

@Injectable()
export class CompanyGuardInvitationService {
  constructor(
    @InjectRepository(CompanyGuardInvitation)
    private readonly invitations: Repository<CompanyGuardInvitation>,
    @InjectRepository(CompanyGuard)
    private readonly companyGuards: Repository<CompanyGuard>,
    private readonly membershipService: CompanyMembershipService,
    private readonly guardService: GuardProfileService,
    private readonly auditLogService: AuditLogService,
    private readonly dataSource: DataSource,
  ) {}

  // ── token handling ─────────────────────────────────────────────────────────

  /** Returned to the issuing company exactly once. Never persisted, never logged. */
  private mint(): string {
    return randomBytes(TOKEN_BYTES).toString('base64url');
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private static normaliseSiaLicence(raw?: string | null): string | null {
    if (raw === undefined || raw === null) return null;
    const digits = raw.replace(/\s/g, '');
    if (digits === '') return null;
    if (!/^\d{16}$/.test(digits)) {
      throw new BadRequestException('SIA licence number must be exactly 16 numeric digits.');
    }
    return digits;
  }

  static stateOf(invitation: CompanyGuardInvitation, now = new Date()): InvitationState {
    if (invitation.revokedAt) return 'REVOKED';
    if (invitation.declinedAt) return 'DECLINED';
    if (invitation.usedAt) return 'ACCEPTED';
    if (invitation.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
    return 'PENDING';
  }

  private toCompanyView(invitation: CompanyGuardInvitation): CompanyInvitationView {
    return {
      id: invitation.id,
      relationshipType: invitation.relationshipType,
      targetSiaLicenceNumber: invitation.targetSiaLicenceNumber,
      state: CompanyGuardInvitationService.stateOf(invitation),
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      invitedByUserId: invitation.invitedByUserId,
      resolvedAt: invitation.usedAt ?? invitation.declinedAt ?? invitation.revokedAt ?? null,
    };
  }

  // ── company side ───────────────────────────────────────────────────────────

  /**
   * Issue a one-time code. Returns the plaintext once; only its digest is stored.
   *
   * No screening, approval or compliance check runs here or anywhere else in this workflow: bringing
   * a guard into a workforce is a membership decision, and S4 screening is an optional trust service.
   */
  async createForCompanyUser(user: JwtPayload, dto: CreateCompanyGuardInvitationDto) {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.GUARDS_MANAGE,
    );

    const targetSiaLicenceNumber = CompanyGuardInvitationService.normaliseSiaLicence(
      dto.targetSiaLicenceNumber,
    );
    const relationshipType = dto.relationshipType ?? CompanyGuardRelationshipType.APPROVED_CONTRACTOR;

    const token = this.mint();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const saved = await this.invitations.save(
      this.invitations.create({
        companyId: company.id,
        relationshipType,
        targetSiaLicenceNumber,
        tokenDigest: this.digest(token),
        expiresAt,
        usedAt: null,
        declinedAt: null,
        revokedAt: null,
        revokedByUserId: null,
        invitedByUserId: user.sub,
      }),
    );

    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'company_guard_invitation.created',
      entityType: 'company_guard_invitation',
      entityId: saved.id,
      // No token, no digest. The statement is recorded so the company's acceptance of
      // responsibility is evidenced by what it was actually shown.
      afterData: {
        companyId: company.id,
        relationshipType,
        targetSiaLicenceNumber,
        expiresAt: expiresAt.toISOString(),
        responsibilityStatement: COMPANY_MANAGED_RESPONSIBILITY_STATEMENT,
      },
    });

    return {
      invitation: this.toCompanyView(saved),
      // Shown once. Not recoverable afterwards.
      code: token,
      responsibilityStatement: COMPANY_MANAGED_RESPONSIBILITY_STATEMENT,
    };
  }

  /** Read-only listing. guards.view is the narrowest existing permission that fits a read. */
  async listForCompanyUser(user: JwtPayload): Promise<CompanyInvitationView[]> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.GUARDS_VIEW,
    );
    const rows = await this.invitations.find({
      where: { companyId: company.id },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => this.toCompanyView(row));
  }

  /** Only a PENDING invitation can be revoked, and only by its own company. */
  async revokeForCompanyUser(user: JwtPayload, invitationId: number): Promise<CompanyInvitationView> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.GUARDS_MANAGE,
    );

    const invitation = await this.invitations.findOne({
      where: { id: invitationId, companyId: company.id },
    });
    // Another company's invitation is indistinguishable from one that does not exist.
    if (!invitation) throw new NotFoundException('Invitation not found.');

    const state = CompanyGuardInvitationService.stateOf(invitation);
    if (state !== 'PENDING' && state !== 'EXPIRED') {
      throw new BadRequestException(`This invitation is already ${state.toLowerCase()}.`);
    }

    invitation.revokedAt = new Date();
    invitation.revokedByUserId = user.sub;
    const saved = await this.invitations.save(invitation);

    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'company_guard_invitation.revoked',
      entityType: 'company_guard_invitation',
      entityId: saved.id,
      beforeData: { state },
      afterData: { state: 'REVOKED', revokedAt: saved.revokedAt?.toISOString() },
    });

    return this.toCompanyView(saved);
  }

  // ── guard side ─────────────────────────────────────────────────────────────

  private async requireGuard(user: JwtPayload) {
    const guard = await this.guardService.findByUserId(user.sub);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return guard;
  }

  /**
   * Resolve a code for the authenticated guard, or fail generically.
   *
   * Every rejection raises the same message, so the endpoint cannot be used to discover which codes
   * exist or what happened to them. The attempt is audited by digest, never by plaintext.
   */
  private async resolveClaimable(
    user: JwtPayload,
    code: string,
    guardId: number,
    guardSiaLicenceNumber: string,
    action: string,
    meta?: { ipAddress?: string | null; userAgent?: string | null },
  ): Promise<CompanyGuardInvitation> {
    const trimmed = (code ?? '').trim();
    const tokenDigest = trimmed === '' ? null : this.digest(trimmed);

    const invitation = tokenDigest
      ? await this.invitations.findOne({ where: { tokenDigest }, relations: ['company'] })
      : null;

    const state = invitation ? CompanyGuardInvitationService.stateOf(invitation) : null;
    const licenceMismatch =
      !!invitation &&
      !!invitation.targetSiaLicenceNumber &&
      invitation.targetSiaLicenceNumber.trim() !== guardSiaLicenceNumber.trim();

    if (!invitation || state !== 'PENDING' || licenceMismatch) {
      await this.auditLogService.log({
        company: invitation ? { id: invitation.companyId } : null,
        user: { id: user.sub },
        action: `${action}_failed`,
        entityType: 'company_guard_invitation',
        entityId: invitation?.id ?? null,
        // Digest only — the plaintext code never reaches the audit trail.
        afterData: {
          guardId,
          reason: !invitation
            ? 'unknown'
            : licenceMismatch
              ? 'licence_mismatch'
              : (state ?? 'unknown').toLowerCase(),
          tokenDigestPrefix: tokenDigest ? tokenDigest.slice(0, 8) : null,
        },
        ipAddress: meta?.ipAddress ?? null,
        userAgent: meta?.userAgent ?? null,
      });
      throw new NotFoundException(GENERIC_CODE_FAILURE);
    }

    return invitation;
  }

  /** Enough for informed consent, and nothing more. */
  async previewForGuardUser(
    user: JwtPayload,
    dto: RedeemCompanyGuardInvitationDto,
    meta?: { ipAddress?: string | null; userAgent?: string | null },
  ): Promise<GuardInvitationPreview> {
    const guard = await this.requireGuard(user);
    const invitation = await this.resolveClaimable(
      user, dto.code, guard.id, guard.siaLicenseNumber, 'company_guard_invitation.preview', meta,
    );

    const existing = await this.companyGuards.findOne({
      where: { company: { id: invitation.companyId }, guard: { id: guard.id } },
    });

    return {
      companyName: invitation.company.name,
      relationshipType: invitation.relationshipType,
      expiresAt: invitation.expiresAt,
      alreadyInWorkforce: existing?.status === CompanyGuardStatus.ACTIVE,
    };
  }

  /**
   * Accept: consent recorded, relationship ACTIVE, code consumed — all or nothing.
   *
   * The invitation row is locked FOR UPDATE and re-validated inside the transaction, so two
   * concurrent acceptances cannot both consume it: the second waits, then sees usedAt set and fails.
   *
   * No screening gate, no assertGuardAssignable, no approval flag. Deployment is gated separately at
   * shift assignment; this is workforce membership.
   */
  async acceptForGuardUser(
    user: JwtPayload,
    dto: RedeemCompanyGuardInvitationDto,
    meta?: { ipAddress?: string | null; userAgent?: string | null },
  ) {
    const guard = await this.requireGuard(user);
    const preliminary = await this.resolveClaimable(
      user, dto.code, guard.id, guard.siaLicenseNumber, 'company_guard_invitation.accept', meta,
    );

    const result = await this.dataSource.transaction(async (manager) => {
      const invitationRepo = manager.getRepository(CompanyGuardInvitation);
      const relationRepo = manager.getRepository(CompanyGuard);

      const locked = await invitationRepo
        .createQueryBuilder('invitation')
        .setLock('pessimistic_write')
        .where('invitation.id = :id', { id: preliminary.id })
        .getOne();
      if (!locked) throw new NotFoundException(GENERIC_CODE_FAILURE);

      // Re-checked under the lock: the state may have changed while we waited for it.
      if (CompanyGuardInvitationService.stateOf(locked) !== 'PENDING') {
        throw new NotFoundException(GENERIC_CODE_FAILURE);
      }

      const existing = await relationRepo.findOne({
        where: { company: { id: locked.companyId }, guard: { id: guard.id } },
      });

      // A company that has blocked this guard must unblock them deliberately. Acceptance fails and
      // the code is left unconsumed, so the guard can retry once the company acts.
      if (existing?.status === CompanyGuardStatus.BLOCKED) {
        throw new ForbiddenException(
          'This company has blocked your account. Contact the company directly; they must remove the block before you can join.',
        );
      }

      // Captured before any mutation: reusing the existing entity below aliases it, so reading
      // existing.status afterwards would report the new value and the audit trail would claim the
      // relationship was already ACTIVE when it was not.
      const previousStatus = existing?.status ?? null;
      const alreadyActive = previousStatus === CompanyGuardStatus.ACTIVE;

      const relation = existing ?? relationRepo.create({
        company: { id: locked.companyId } as never,
        guard: { id: guard.id } as never,
      });

      // The unique (company, guard) constraint stays authoritative — an existing row is reused and
      // reactivated, never duplicated.
      relation.status = CompanyGuardStatus.ACTIVE;
      relation.relationshipType = locked.relationshipType;
      relation.acceptedAt = relation.acceptedAt ?? new Date();
      relation.invitationId = relation.invitationId ?? locked.id;
      const savedRelation = await relationRepo.save(relation);

      locked.usedAt = new Date();
      await invitationRepo.save(locked);

      return {
        relationshipId: savedRelation.id,
        companyId: locked.companyId,
        invitationId: locked.id,
        relationshipType: locked.relationshipType,
        acceptedAt: savedRelation.acceptedAt,
        previousStatus,
        alreadyActive,
      };
    });

    await this.auditLogService.log({
      company: { id: result.companyId },
      user: { id: user.sub },
      action: 'company_guard_invitation.accepted',
      entityType: 'company_guard_invitation',
      entityId: result.invitationId,
      beforeData: { relationshipStatus: result.previousStatus },
      afterData: {
        guardId: guard.id,
        companyId: result.companyId,
        companyGuardId: result.relationshipId,
        relationshipType: result.relationshipType,
        acceptedAt: result.acceptedAt?.toISOString() ?? null,
        reactivated: result.previousStatus === CompanyGuardStatus.INACTIVE,
      },
      ipAddress: meta?.ipAddress ?? null,
      userAgent: meta?.userAgent ?? null,
    });

    return {
      companyGuardId: result.relationshipId,
      status: CompanyGuardStatus.ACTIVE,
      relationshipType: result.relationshipType,
      acceptedAt: result.acceptedAt,
      alreadyInWorkforce: result.alreadyActive,
    };
  }

  /**
   * Decline: the code is spent and can never be accepted, recorded distinctly from acceptance so the
   * company is not shown a refusal as though the guard had joined. No relationship is created or
   * changed, and the guard's identity is not added to the company-facing projection.
   */
  async declineForGuardUser(
    user: JwtPayload,
    dto: RedeemCompanyGuardInvitationDto,
    meta?: { ipAddress?: string | null; userAgent?: string | null },
  ) {
    const guard = await this.requireGuard(user);
    const preliminary = await this.resolveClaimable(
      user, dto.code, guard.id, guard.siaLicenseNumber, 'company_guard_invitation.decline', meta,
    );

    const declined = await this.dataSource.transaction(async (manager) => {
      const invitationRepo = manager.getRepository(CompanyGuardInvitation);
      const locked = await invitationRepo
        .createQueryBuilder('invitation')
        .setLock('pessimistic_write')
        .where('invitation.id = :id', { id: preliminary.id })
        .getOne();
      if (!locked || CompanyGuardInvitationService.stateOf(locked) !== 'PENDING') {
        throw new NotFoundException(GENERIC_CODE_FAILURE);
      }
      locked.declinedAt = new Date();
      return invitationRepo.save(locked);
    });

    await this.auditLogService.log({
      company: { id: declined.companyId },
      user: { id: user.sub },
      action: 'company_guard_invitation.declined',
      entityType: 'company_guard_invitation',
      entityId: declined.id,
      beforeData: { state: 'PENDING' },
      afterData: {
        companyId: declined.companyId,
        guardId: guard.id,
        declinedAt: declined.declinedAt?.toISOString() ?? null,
      },
      ipAddress: meta?.ipAddress ?? null,
      userAgent: meta?.userAgent ?? null,
    });

    return { declined: true, declinedAt: declined.declinedAt };
  }
}
