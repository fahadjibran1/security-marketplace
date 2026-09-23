import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuthSession } from './entities/auth-session.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

/** 30-day idle window, extended on every successful refresh. */
export const IDLE_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
/** 90-day hard ceiling set at login; refresh can never push a family past it. */
export const ABSOLUTE_SESSION_MS = 90 * 24 * 60 * 60 * 1000;
/** 256 bits. */
const TOKEN_BYTES = 32;

export interface IssuedSession {
  refreshToken: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

@Injectable()
export class AuthSessionService {
  constructor(
    @InjectRepository(AuthSession)
    private readonly sessions: Repository<AuthSession>,
    private readonly auditLogService: AuditLogService,
  ) {}

  /** The raw token is returned to the caller once and never persisted or logged. */
  private mint() {
    return randomBytes(TOKEN_BYTES).toString('base64url');
  }

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async audit(userId: number, action: string, after: Record<string, unknown>) {
    await this.auditLogService.log({
      user: { id: userId },
      action,
      entityType: 'auth_session',
      entityId: typeof after.sessionId === 'number' ? after.sessionId : undefined,
      // Never the raw token — only its session id and family.
      afterData: after,
    });
  }

  /** Establish a new renewable session at login. */
  async create(userId: number): Promise<IssuedSession> {
    const now = Date.now();
    const token = this.mint();
    const absoluteExpiresAt = new Date(now + ABSOLUTE_SESSION_MS);
    const expiresAt = new Date(now + IDLE_SESSION_MS);

    const saved = await this.sessions.save(
      this.sessions.create({
        user: { id: userId } as never,
        tokenHash: this.hash(token),
        familyId: randomUUID(),
        expiresAt,
        absoluteExpiresAt,
      }),
    );

    await this.audit(userId, 'auth.session_created', {
      sessionId: saved.id,
      familyId: saved.familyId,
      expiresAt: expiresAt.toISOString(),
      absoluteExpiresAt: absoluteExpiresAt.toISOString(),
    });

    return { refreshToken: token, expiresAt, absoluteExpiresAt };
  }

  /**
   * Validate and rotate. Returns the owning userId plus a freshly minted successor token.
   *
   * Every failure path is a generic 401 so a caller cannot distinguish "unknown token" from
   * "expired" from "revoked".
   */
  async rotate(presentedToken: string): Promise<{ userId: number; issued: IssuedSession }> {
    const denied = () => new UnauthorizedException('Session is no longer valid');
    if (typeof presentedToken !== 'string' || presentedToken.length < 20) throw denied();

    const tokenHash = this.hash(presentedToken);
    const existing = await this.sessions.findOne({
      where: { tokenHash },
      relations: { user: true },
    });
    if (!existing) throw denied();

    const userId = existing.user.id;
    const now = new Date();

    if (existing.revokedAt) {
      // A rotated token is revoked the moment its successor is issued, so presenting one again
      // means it was captured. Burn the whole family rather than just this row.
      await this.revokeFamily(existing.familyId, 'reuse_detected');
      await this.audit(userId, 'auth.session_reuse_detected', {
        sessionId: existing.id,
        familyId: existing.familyId,
        previouslyRevokedReason: existing.revokedReason,
      });
      throw denied();
    }

    if (existing.expiresAt <= now || existing.absoluteExpiresAt <= now) {
      await this.sessions.update(
        { id: existing.id },
        { revokedAt: now, revokedReason: 'rotated' },
      );
      throw denied();
    }

    const token = this.mint();
    // The successor inherits the family's absolute ceiling; the idle window is extended but
    // clamped so a long-lived family can never outlive its 90-day limit.
    const idleTarget = new Date(now.getTime() + IDLE_SESSION_MS);
    const expiresAt =
      idleTarget < existing.absoluteExpiresAt ? idleTarget : existing.absoluteExpiresAt;

    const successor = await this.sessions.save(
      this.sessions.create({
        user: { id: userId } as never,
        tokenHash: this.hash(token),
        familyId: existing.familyId,
        rotatedFromId: existing.id,
        expiresAt,
        absoluteExpiresAt: existing.absoluteExpiresAt,
      }),
    );

    await this.sessions.update(
      { id: existing.id },
      { revokedAt: now, revokedReason: 'rotated', lastUsedAt: now },
    );

    await this.audit(userId, 'auth.session_rotated', {
      sessionId: successor.id,
      rotatedFromId: existing.id,
      familyId: existing.familyId,
      expiresAt: expiresAt.toISOString(),
    });

    return {
      userId,
      issued: { refreshToken: token, expiresAt, absoluteExpiresAt: existing.absoluteExpiresAt },
    };
  }

  /** Explicit logout. Idempotent, and never reveals whether the token was real. */
  async revoke(presentedToken: string, userId: number): Promise<void> {
    if (typeof presentedToken !== 'string' || !presentedToken) return;
    const existing = await this.sessions.findOne({
      where: { tokenHash: this.hash(presentedToken) },
      relations: { user: true },
    });
    // Only the owner may revoke, so a stolen token cannot be used to log someone else out.
    if (!existing || existing.user.id !== userId || existing.revokedAt) return;

    await this.revokeFamily(existing.familyId, 'logout');
    await this.audit(userId, 'auth.session_logout', {
      sessionId: existing.id,
      familyId: existing.familyId,
    });
  }

  async revokeFamily(familyId: string, reason: AuthSession['revokedReason']): Promise<void> {
    await this.sessions.update(
      { familyId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );
  }

  /** Used by a future password change/reset to drop every device. */
  async revokeAllForUser(userId: number, reason: AuthSession['revokedReason']): Promise<void> {
    // Addressed by the FK column rather than a nested relation: TypeORM's update() does not
    // resolve `{ user: { id } }` in its criteria and would match nothing at all.
    await this.sessions
      .createQueryBuilder()
      .update(AuthSession)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where('"userId" = :userId', { userId })
      .andWhere('"revokedAt" IS NULL')
      .execute();
  }
}
