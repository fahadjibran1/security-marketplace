import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
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
    const now = new Date();

    // Claim the presented session and write its successor in one transaction. The claim is a
    // conditional UPDATE, so of any number of concurrent rotations of the same token exactly one
    // matches the row: Postgres serialises them on the row lock, and every other one re-checks
    // `"revokedAt" IS NULL` after the winner commits and matches nothing. A read-then-write here
    // would let each racer see the row as live and mint its own successor (issue #53).
    const rotated = await this.sessions.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AuthSession);
      const claim = await repo
        .createQueryBuilder()
        .update(AuthSession)
        .set({ revokedAt: now, revokedReason: 'rotated', lastUsedAt: now })
        .where('"tokenHash" = :tokenHash', { tokenHash })
        .andWhere('"revokedAt" IS NULL')
        .andWhere('"expiresAt" > :now', { now })
        .andWhere('"absoluteExpiresAt" > :now', { now })
        .returning('"id", "userId", "familyId", "absoluteExpiresAt"')
        .execute();
      const claimed = (claim.raw as Array<{
        id: number;
        userId: number;
        familyId: string;
        absoluteExpiresAt: Date;
      }>)[0];
      if (!claimed) return null;

      const absoluteExpiresAt = new Date(claimed.absoluteExpiresAt);
      const token = this.mint();
      // The successor inherits the family's absolute ceiling; the idle window is extended but
      // clamped so a long-lived family can never outlive its 90-day limit.
      const idleTarget = new Date(now.getTime() + IDLE_SESSION_MS);
      const expiresAt = idleTarget < absoluteExpiresAt ? idleTarget : absoluteExpiresAt;

      const successor = await repo.save(
        repo.create({
          user: { id: claimed.userId } as never,
          tokenHash: this.hash(token),
          familyId: claimed.familyId,
          rotatedFromId: claimed.id,
          expiresAt,
          absoluteExpiresAt,
        }),
      );

      return { claimed, successor, token, expiresAt, absoluteExpiresAt };
    });

    if (rotated) {
      const { claimed, successor, token, expiresAt, absoluteExpiresAt } = rotated;
      await this.audit(claimed.userId, 'auth.session_rotated', {
        sessionId: successor.id,
        rotatedFromId: claimed.id,
        familyId: claimed.familyId,
        expiresAt: expiresAt.toISOString(),
      });

      return {
        userId: claimed.userId,
        issued: { refreshToken: token, expiresAt, absoluteExpiresAt },
      };
    }

    // The claim matched nothing: the token is unknown, already revoked (including by a
    // concurrent rotation that won the claim), or expired. Read it back to say which.
    const existing = await this.sessions.findOne({
      where: { tokenHash },
      relations: { user: true },
    });
    if (!existing) throw denied();

    const userId = existing.user.id;

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

    // Live and unexpired yet unclaimed cannot normally happen (only at the exact expiry instant);
    // refuse rather than retry, like any other unusable token.
    throw denied();
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

  /** Drops every device: password reset, account deletion, and a suspended account's refresh. */
  async revokeAllForUser(
    userId: number,
    reason: AuthSession['revokedReason'],
    manager?: EntityManager,
  ): Promise<void> {
    // Addressed by the FK column rather than a nested relation: TypeORM's update() does not
    // resolve `{ user: { id } }` in its criteria and would match nothing at all.
    // A caller may pass its transaction so revocation commits or rolls back with the change that
    // caused it (a password reset, an account deletion).
    await (manager ? manager.getRepository(AuthSession) : this.sessions)
      .createQueryBuilder()
      .update(AuthSession)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where('"userId" = :userId', { userId })
      .andWhere('"revokedAt" IS NULL')
      .execute();
  }
}
