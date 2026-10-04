import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { EntityManager, IsNull, MoreThan, Repository } from 'typeorm';
import {
  UserVerificationToken,
  VERIFICATION_TOKEN_PURPOSES,
  VerificationTokenPurpose,
} from './entities/user-verification-token.entity';

/** 256 bits, the same as a refresh token. */
const TOKEN_BYTES = 32;

export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Per-account issuing limits, on top of the per-IP request throttle. Without them one person could fill
 * somebody else's inbox from many addresses. When a limit is reached nothing is issued and the caller's
 * response is unchanged, so the limit itself reveals nothing about whether the account exists.
 */
const MIN_REISSUE_INTERVAL_MS = 60 * 1000;
const MAX_ISSUES_PER_HOUR = 5;

export type TokenRejection = 'unknown' | 'wrong_purpose' | 'used' | 'invalidated' | 'expired';

export function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues and spends single-use emailed tokens. The plaintext token exists only in the return value of
 * issue() — it is never stored, logged, or written to the audit trail.
 */
@Injectable()
export class UserVerificationTokenService {
  constructor(
    @InjectRepository(UserVerificationToken)
    private readonly tokens: Repository<UserVerificationToken>,
  ) {}

  private repo(manager?: EntityManager) {
    return manager ? manager.getRepository(UserVerificationToken) : this.tokens;
  }

  /**
   * Whether a new token of this purpose may be issued to this user now. Counts every token issued in
   * the last hour, spent or not, so reissuing cannot be used to reset the window.
   */
  async mayIssue(userId: number, purpose: VerificationTokenPurpose, now = new Date()): Promise<boolean> {
    const recent = await this.tokens.find({
      where: { userId, purpose, createdAt: MoreThan(new Date(now.getTime() - 60 * 60 * 1000)) },
      order: { createdAt: 'DESC' },
    });
    if (recent.length >= MAX_ISSUES_PER_HOUR) return false;
    const latest = recent[0];
    return !latest || now.getTime() - latest.createdAt.getTime() >= MIN_REISSUE_INTERVAL_MS;
  }

  /**
   * Mint a token and invalidate every unspent predecessor of the same purpose for this user, so only the
   * newest link works. Returns the plaintext exactly once.
   */
  async issue(
    userId: number,
    purpose: VerificationTokenPurpose,
    ttlMs: number,
    manager?: EntityManager,
  ): Promise<{ token: string; expiresAt: Date; id: number }> {
    this.assertPurpose(purpose);
    const repo = this.repo(manager);
    await this.invalidateOutstanding(userId, purpose, manager);

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMs);
    const saved = await repo.save(
      repo.create({ userId, purpose, tokenHash: hashVerificationToken(token), expiresAt }),
    );
    return { token, expiresAt, id: saved.id };
  }

  /** Invalidate every unspent token of one purpose (or all purposes) for a user. */
  async invalidateOutstanding(
    userId: number,
    purpose: VerificationTokenPurpose | null,
    manager?: EntityManager,
  ): Promise<void> {
    await this.repo(manager).update(
      {
        userId,
        ...(purpose ? { purpose } : {}),
        usedAt: IsNull(),
        invalidatedAt: IsNull(),
      },
      { invalidatedAt: new Date() },
    );
  }

  /**
   * Spend a presented token inside the caller's transaction. The row is locked first, so two concurrent
   * attempts with the same token cannot both succeed: the second waits, then sees usedAt set.
   *
   * Returns the token row on success, or the reason it was refused. Callers must turn every refusal
   * into the same generic message — the reason is for tests and internal audit only.
   */
  async consume(
    manager: EntityManager,
    presented: unknown,
    purpose: VerificationTokenPurpose,
    now = new Date(),
  ): Promise<{ ok: true; token: UserVerificationToken } | { ok: false; reason: TokenRejection }> {
    if (typeof presented !== 'string' || presented.length < 20 || presented.length > 512) {
      return { ok: false, reason: 'unknown' };
    }
    const row = await manager
      .getRepository(UserVerificationToken)
      .createQueryBuilder('token')
      .setLock('pessimistic_write')
      .where('token.tokenHash = :tokenHash', { tokenHash: hashVerificationToken(presented) })
      .getOne();

    if (!row) return { ok: false, reason: 'unknown' };
    if (row.purpose !== purpose) return { ok: false, reason: 'wrong_purpose' };
    if (row.usedAt) return { ok: false, reason: 'used' };
    if (row.invalidatedAt) return { ok: false, reason: 'invalidated' };
    if (row.expiresAt <= now) return { ok: false, reason: 'expired' };

    row.usedAt = now;
    await manager.getRepository(UserVerificationToken).update({ id: row.id }, { usedAt: now });
    return { ok: true, token: row };
  }

  private assertPurpose(purpose: string) {
    if (!VERIFICATION_TOKEN_PURPOSES.includes(purpose)) {
      throw new Error(`Unsupported verification token purpose: ${purpose}`);
    }
  }
}
