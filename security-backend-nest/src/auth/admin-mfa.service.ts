import { createHmac } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { isPlatformAdminMfaRequired } from '../config/runtime-env';
import { EncryptionService } from '../guard-personnel/encryption.service';
import { User, UserRole, UserStatus } from '../user/entities/user.entity';
import { AuthSessionService } from './auth-session.service';
import { PlatformAdminMfa } from './entities/platform-admin-mfa.entity';
import { LoginAttemptLimiter } from './login-attempt-limiter';
import {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_PERIOD_SECONDS,
  generateTotpSecret,
  matchTotpStep,
  otpauthUri,
} from './totp';

/** How long the password-verified, code-pending state of a sign-in lasts. */
export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;
/** How long an enrolment token (flag on, admin not enrolled) lasts. */
export const MFA_ENROLMENT_TTL_SECONDS = 15 * 60;
/** How long a started enrolment's secret may wait for its confirming code. */
export const MFA_PENDING_TTL_MS = 15 * 60_000;

const CHALLENGE_PURPOSE = 'admin_mfa_challenge';
const ENROLMENT_PURPOSE = 'admin_mfa_enrolment';

export const MFA_CODE_INVALID = {
  code: 'MFA_CODE_INVALID',
  message: 'That authentication code is not valid. Check your authenticator app and enter the current code.',
} as const;
export const MFA_LIMITED_MESSAGE =
  'Too many unsuccessful authentication codes. Please wait 15 minutes and try again.';
export const MFA_REQUIRED_SESSION = {
  code: 'MFA_REQUIRED',
  message: 'This Platform Admin account uses two-step verification. Sign in again.',
} as const;
export const MFA_ENROLLMENT_REQUIRED_SESSION = {
  code: 'MFA_ENROLLMENT_REQUIRED',
  message: 'Platform Admin accounts must set up two-step verification. Sign in again to set it up.',
} as const;
const INVALID_CHALLENGE = { code: 'MFA_CHALLENGE_INVALID', message: 'Your sign-in has expired. Sign in again.' } as const;

/** The second-step response of POST /auth/login for an enrolled Platform Admin (no session yet). */
export interface MfaChallengeResponse {
  mfaRequired: true;
  method: 'totp';
  challengeToken: string;
  challengeExpiresAt: string;
}
/** The response of POST /auth/login for an unenrolled Platform Admin while the rollout flag is on (no session). */
export interface MfaEnrollmentRequiredResponse {
  mfaEnrollmentRequired: true;
  enrollmentToken: string;
  enrollmentExpiresAt: string;
}
type CodeStage = 'login' | 'enrolment' | 'disable';

/**
 * Platform Admin two-step verification (authenticator app, RFC 6238 TOTP). Owns the enrolment state, the short-lived
 * single-purpose tokens that stand between a correct password and a session, code checking with replay protection,
 * failed-code limiting and auditing. It never issues a session itself: AuthService does, once this service says so.
 *
 * Secrets: generated here, encrypted with EncryptionService before they reach the database, decrypted only to check a
 * code, never logged or audited, and returned to the client only once, by startEnrolment, before confirmation.
 */
@Injectable()
export class AdminMfaService {
  private readonly challengeSecret: string;
  private readonly enrolmentSecret: string;

  constructor(
    @InjectRepository(PlatformAdminMfa)
    private readonly repo: Repository<PlatformAdminMfa>,
    private readonly dataSource: DataSource,
    private readonly jwt: JwtService,
    config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly auditLog: AuditLogService,
    private readonly sessions: AuthSessionService,
    private readonly limiter: LoginAttemptLimiter,
  ) {
    // Derived, purpose-separated signing keys: a challenge or enrolment token can never verify as an access token
    // (JwtStrategy uses JWT_SECRET itself), nor as each other.
    const root = config.get<string>('JWT_SECRET', 'super-secret-change-me');
    this.challengeSecret = createHmac('sha256', root).update(`s4:${CHALLENGE_PURPOSE}:v1`).digest('hex');
    this.enrolmentSecret = createHmac('sha256', root).update(`s4:${ENROLMENT_PURPOSE}:v1`).digest('hex');
  }

  required(): boolean {
    return isPlatformAdminMfaRequired();
  }

  private findRow(userId: number) {
    return this.repo.findOne({ where: { userId } });
  }

  async isEnrolled(userId: number): Promise<boolean> {
    const row = await this.repo.findOne({ where: { userId }, select: { userId: true, enabledAt: true } });
    return !!row?.enabledAt;
  }

  // ── sign-in ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Called by AuthService.login after the password and account checks pass, for Platform Admins only. Null: issue the
   * session as before (not enrolled, flag off). Otherwise the response that replaces the session.
   */
  async loginGate(user: Pick<User, 'id' | 'role'>): Promise<MfaChallengeResponse | MfaEnrollmentRequiredResponse | null> {
    if (user.role !== UserRole.ADMIN) return null;
    if (await this.isEnrolled(user.id)) {
      return {
        mfaRequired: true,
        method: 'totp',
        challengeToken: this.jwt.sign({ sub: user.id, purpose: CHALLENGE_PURPOSE }, { secret: this.challengeSecret, expiresIn: MFA_CHALLENGE_TTL_SECONDS }),
        challengeExpiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000).toISOString(),
      };
    }
    if (this.required()) {
      return {
        mfaEnrollmentRequired: true,
        enrollmentToken: this.jwt.sign({ sub: user.id, purpose: ENROLMENT_PURPOSE }, { secret: this.enrolmentSecret, expiresIn: MFA_ENROLMENT_TTL_SECONDS }),
        enrollmentExpiresAt: new Date(Date.now() + MFA_ENROLMENT_TTL_SECONDS * 1000).toISOString(),
      };
    }
    return null;
  }

  private verifyPurposeToken(token: unknown, secret: string, purpose: string): number | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 2048) return null;
    try {
      const payload = this.jwt.verify<{ sub?: unknown; purpose?: unknown }>(token, { secret });
      return payload.purpose === purpose && typeof payload.sub === 'number' ? payload.sub : null;
    } catch {
      return null;
    }
  }

  /** The admin a challenge token was issued to; 401 when it is missing, forged, of another purpose or expired. */
  verifyChallengeToken(token: unknown): number {
    const userId = this.verifyPurposeToken(token, this.challengeSecret, CHALLENGE_PURPOSE);
    if (userId === null) throw new UnauthorizedException(INVALID_CHALLENGE);
    return userId;
  }

  /** The admin an enrolment token was issued to, or null (the caller then falls back to an ordinary session). */
  verifyEnrolmentToken(token: unknown): number | null {
    return this.verifyPurposeToken(token, this.enrolmentSecret, ENROLMENT_PURPOSE);
  }

  /**
   * JwtStrategy, for every request carrying a Platform Admin access token. An enrolled admin's token must have been
   * issued through two-step verification (the `mfa` claim); with the rollout flag on, an unenrolled admin's tokens are
   * no longer accepted anywhere (they sign in again and are sent to enrolment).
   */
  async assertSessionAllowed(user: Pick<User, 'id' | 'role'>, payload: { mfa?: unknown }): Promise<void> {
    if (user.role !== UserRole.ADMIN) return;
    if (await this.isEnrolled(user.id)) {
      if (payload.mfa !== true) throw new UnauthorizedException(MFA_REQUIRED_SESSION);
      return;
    }
    if (this.required()) throw new UnauthorizedException(MFA_ENROLLMENT_REQUIRED_SESSION);
  }

  /**
   * AuthService.refresh, for a Platform Admin. The claims a renewed access token carries, or a refusal when the admin
   * may no longer hold a session without enrolling. Refresh sessions that predate enrolment were revoked by it, so a
   * live refresh session of an enrolled admin was created by a two-step sign-in.
   */
  async refreshClaims(user: Pick<User, 'id' | 'role'>): Promise<{ mfa?: true }> {
    if (user.role !== UserRole.ADMIN) return {};
    if (await this.isEnrolled(user.id)) return { mfa: true };
    if (this.required()) throw new UnauthorizedException(MFA_ENROLLMENT_REQUIRED_SESSION);
    return {};
  }

  /** Check the second step of a sign-in. Throws 401 (wrong / replayed code) or 429 (too many). */
  async verifyLoginCode(userId: number, code: unknown, source: string | null): Promise<void> {
    const row = await this.findRow(userId);
    if (!row?.enabledAt || !row.totpSecretEncrypted) {
      // Enrolment was removed (operator recovery) after the challenge was issued: the challenge is void.
      throw new UnauthorizedException(INVALID_CHALLENGE);
    }
    await this.consumeCode(row, row.totpSecretEncrypted, code, source, 'login');
    await this.audit(userId, 'platform_admin.mfa.sign_in_verified', source, {});
  }

  // ── enrolment ─────────────────────────────────────────────────────────────────────────────────────────

  async status(userId: number) {
    const row = await this.findRow(userId);
    return {
      enrolled: !!row?.enabledAt,
      enabledAt: row?.enabledAt ? row.enabledAt.toISOString() : null,
      pending: !row?.enabledAt && !!row?.pendingSecretEncrypted && !this.pendingExpired(row),
      required: this.required(),
      method: 'totp' as const,
    };
  }

  private pendingExpired(row: PlatformAdminMfa): boolean {
    return !row.pendingCreatedAt || Date.now() - row.pendingCreatedAt.getTime() > MFA_PENDING_TTL_MS;
  }

  private async activeAdmin(userId: number): Promise<User> {
    const user = await this.dataSource.getRepository(User).findOne({ where: { id: userId } });
    if (!user || user.role !== UserRole.ADMIN || user.status !== UserStatus.ACTIVE || user.deletionCompletedAt) {
      throw new UnauthorizedException(INVALID_CHALLENGE);
    }
    return user;
  }

  /**
   * Start (or restart) enrolment: a new secret, held encrypted as pending until a code from it is confirmed. The
   * secret and its otpauth:// URI are returned this once so the admin can add it to an authenticator app.
   */
  async startEnrolment(userId: number, source: string | null) {
    const user = await this.activeAdmin(userId);
    const existing = await this.findRow(userId);
    if (existing?.enabledAt) {
      throw new ConflictException({ code: 'MFA_ALREADY_ENROLLED', message: 'Two-step verification is already set up for this account.' });
    }
    const secret = generateTotpSecret();
    const now = new Date(Date.now());
    await this.repo.upsert(
      { userId, pendingSecretEncrypted: this.encryption.encrypt(secret), pendingCreatedAt: now, updatedAt: now },
      ['userId'],
    );
    await this.audit(userId, 'platform_admin.mfa.enrolment_started', source, {});
    return {
      method: 'totp' as const,
      issuer: TOTP_ISSUER,
      accountName: user.email,
      secret,
      otpauthUri: otpauthUri(secret, user.email),
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      algorithm: TOTP_ALGORITHM,
      expiresAt: new Date(now.getTime() + MFA_PENDING_TTL_MS).toISOString(),
    };
  }

  /**
   * Confirm enrolment with a code from the pending secret. Activates two-step verification and revokes every renewable
   * session the admin holds, so no session created by a password alone outlives enrolment. The caller then issues
   * a fresh two-step session.
   */
  async confirmEnrolment(userId: number, code: unknown, source: string | null): Promise<void> {
    await this.activeAdmin(userId);
    const row = await this.findRow(userId);
    if (row?.enabledAt) {
      throw new ConflictException({ code: 'MFA_ALREADY_ENROLLED', message: 'Two-step verification is already set up for this account.' });
    }
    if (!row?.pendingSecretEncrypted || this.pendingExpired(row)) {
      throw new BadRequestException({ code: 'MFA_ENROLMENT_NOT_STARTED', message: 'Start setting up two-step verification again.' });
    }
    this.assertNotLimited(userId, source);
    const step = matchTotpStep(this.encryption.decrypt(row.pendingSecretEncrypted), code, Date.now());
    if (step === null) return this.refuse(userId, source, 'enrolment', 'wrong_code');

    const pending = row.pendingSecretEncrypted;
    const activated = await this.dataSource.transaction(async (manager) => {
      const result = await manager.query(
        `UPDATE "platform_admin_mfa"
            SET "totpSecretEncrypted" = "pendingSecretEncrypted", "enabledAt" = now(), "lastUsedStep" = $2,
                "pendingSecretEncrypted" = NULL, "pendingCreatedAt" = NULL, "updatedAt" = now()
          WHERE "userId" = $1 AND "enabledAt" IS NULL AND "pendingSecretEncrypted" = $3
          RETURNING "userId"`,
        [userId, step, pending],
      );
      if (!rowCount(result)) return false;
      await this.sessions.revokeAllForUser(userId, 'mfa_enabled', manager);
      await this.auditLog.logInTransaction(manager, this.auditEntry(userId, 'platform_admin.mfa.enabled', source, {}));
      return true;
    });
    if (!activated) {
      // Another request confirmed or restarted enrolment first.
      throw new ConflictException({ code: 'MFA_ENROLMENT_CHANGED', message: 'Two-step verification setup changed. Check its status and try again.' });
    }
    this.limiter.recordSuccess('mfa', limiterKey(userId), source ?? 'unknown-client');
  }

  /**
   * Turn two-step verification off with a current code. Refused while the rollout flag requires it: a lost device is
   * then an operator recovery (admin-operator recover), which resets it.
   */
  async disable(userId: number, code: unknown, source: string | null): Promise<void> {
    if (this.required()) {
      throw new ForbiddenException({ code: 'MFA_REQUIRED_BY_POLICY', message: 'Two-step verification is required for Platform Admin accounts and cannot be turned off.' });
    }
    const row = await this.findRow(userId);
    if (!row?.enabledAt || !row.totpSecretEncrypted) {
      throw new ConflictException({ code: 'MFA_NOT_ENROLLED', message: 'Two-step verification is not set up for this account.' });
    }
    await this.consumeCode(row, row.totpSecretEncrypted, code, source, 'disable');
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`DELETE FROM "platform_admin_mfa" WHERE "userId" = $1`, [userId]);
      await this.auditLog.logInTransaction(manager, this.auditEntry(userId, 'platform_admin.mfa.disabled', source, {}));
    });
  }

  // ── codes ─────────────────────────────────────────────────────────────────────────────────────────────

  private assertNotLimited(userId: number, source: string | null) {
    if (this.limiter.isLimited('mfa', limiterKey(userId), source ?? 'unknown-client')) {
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', message: MFA_LIMITED_MESSAGE },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Accept a code for the active secret exactly once: its time step must be later than the last accepted one, and the
   * advance is a compare-and-set, so two concurrent requests with the same code cannot both succeed.
   */
  private async consumeCode(row: PlatformAdminMfa, encrypted: string, code: unknown, source: string | null, stage: CodeStage) {
    const userId = row.userId;
    this.assertNotLimited(userId, source);
    const step = matchTotpStep(this.encryption.decrypt(encrypted), code, Date.now());
    if (step === null) return this.refuse(userId, source, stage, 'wrong_code');
    const result = await this.dataSource.query(
      `UPDATE "platform_admin_mfa" SET "lastUsedStep" = $2, "updatedAt" = now()
        WHERE "userId" = $1 AND "enabledAt" IS NOT NULL AND ("lastUsedStep" IS NULL OR "lastUsedStep" < $2)
        RETURNING "userId"`,
      [userId, step],
    );
    if (!rowCount(result)) return this.refuse(userId, source, stage, 'replayed_code');
    this.limiter.recordSuccess('mfa', limiterKey(userId), source ?? 'unknown-client');
  }

  private async refuse(userId: number, source: string | null, stage: CodeStage, reason: 'wrong_code' | 'replayed_code'): Promise<never> {
    this.limiter.recordFailure('mfa', limiterKey(userId), source ?? 'unknown-client');
    await this.audit(userId, 'platform_admin.mfa.code_rejected', source, { stage, reason });
    // At sign-in there is no session yet, so 401. Inside a session (enrolment, disable) a wrong code must not read as
    // an expired session (clients sign out on 401), so it is 403.
    if (stage === 'login') throw new UnauthorizedException(MFA_CODE_INVALID);
    throw new ForbiddenException(MFA_CODE_INVALID);
  }

  // ── audit ─────────────────────────────────────────────────────────────────────────────────────────────

  private auditEntry(userId: number, action: string, source: string | null, detail: Record<string, unknown>) {
    // Never the secret, the code or any token: who, what, how and from where.
    return {
      company: null,
      user: { id: userId },
      action,
      entityType: 'user',
      entityId: userId,
      afterData: { adminUserId: userId, method: 'totp', ...detail },
      ipAddress: source,
    };
  }

  audit(userId: number, action: string, source: string | null, detail: Record<string, unknown>) {
    return this.auditLog.log(this.auditEntry(userId, action, source, detail));
  }
}

const limiterKey = (userId: number) => `platform-admin:${userId}`;

/** pg returns [rows, count] for UPDATE ... RETURNING through TypeORM's query(); tolerate both shapes. */
function rowCount(result: unknown): number {
  if (Array.isArray(result)) {
    if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[1];
    return result.length;
  }
  return 0;
}
