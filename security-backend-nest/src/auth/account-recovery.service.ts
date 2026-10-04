import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { emailVerificationEmail, passwordResetEmail } from '../email/auth-email.templates';
import { TransactionalEmailService } from '../email/transactional-email.service';
import { User } from '../user/entities/user.entity';
import { UserService } from '../user/user.service';
import { AuthSessionService } from './auth-session.service';
import { VerificationTokenPurpose } from './entities/user-verification-token.entity';
import {
  EMAIL_VERIFICATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  UserVerificationTokenService,
} from './user-verification-token.service';

/**
 * Identical whatever happened, so the response never reveals whether an account exists, is deleted,
 * is already verified, or has hit its issuing limit.
 */
export const FORGOT_PASSWORD_RESPONSE = {
  accepted: true,
  message: 'If an S4 account exists for that email address, we have sent a link to reset its password.',
} as const;

export const RESEND_VERIFICATION_RESPONSE = {
  accepted: true,
  message: 'If an S4 account for that email address still needs verifying, we have sent a new verification link.',
} as const;

/** Every refusal of a presented link — unknown, expired, used, superseded — reads the same. */
export const INVALID_RESET_LINK = 'This password reset link is invalid or has expired. Request a new one from the S4 sign-in screen.';
export const INVALID_VERIFICATION_LINK = 'This verification link is invalid or has expired. Request a new one from the S4 sign-in screen.';

/**
 * Password reset and email verification.
 *
 * Neither the plaintext token nor the link is ever logged or written to the audit trail: audit entries
 * carry only the user id and the token row id.
 */
@Injectable()
export class AccountRecoveryService {
  private readonly logger = new Logger('AccountRecovery');

  constructor(
    private readonly dataSource: DataSource,
    private readonly users: UserService,
    private readonly tokens: UserVerificationTokenService,
    private readonly sessions: AuthSessionService,
    private readonly email: TransactionalEmailService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ── password reset ────────────────────────────────────────────────────────────────────────────────

  async forgotPassword(emailInput: string) {
    try {
      const user = await this.users.findForRecovery(emailInput);
      if (user && (await this.tokens.mayIssue(user.id, VerificationTokenPurpose.PASSWORD_RESET))) {
        const issued = await this.tokens.issue(
          user.id,
          VerificationTokenPurpose.PASSWORD_RESET,
          PASSWORD_RESET_TTL_MS,
        );
        // Not awaited: delivery time must not distinguish an existing account from an unknown one.
        void this.email.send(passwordResetEmail(user.email, this.email.webAppUrl, issued.token));
        await this.auditLog.log({
          user: { id: user.id },
          action: 'auth.password_reset_requested',
          entityType: 'user',
          entityId: user.id,
          afterData: { tokenId: issued.id, expiresAt: issued.expiresAt.toISOString() },
        });
      }
    } catch (error) {
      // Still the generic answer: an internal failure must not become an enumeration oracle.
      this.logger.error(
        JSON.stringify({ event: 'password_reset_request_failed', reason: error instanceof Error ? error.name : 'unknown' }),
      );
    }
    return { ...FORGOT_PASSWORD_RESPONSE };
  }

  async resetPassword(token: string, newPassword: string) {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const spent = await this.tokens.consume(manager, token, VerificationTokenPurpose.PASSWORD_RESET);
      if (!spent.ok) return { ok: false as const, reason: spent.reason };

      const users = manager.getRepository(User);
      const user = await users.findOne({ where: { id: spent.token.userId } });
      if (!user || user.deletionCompletedAt) return { ok: false as const, reason: 'unknown' as const };

      await users.update(
        { id: user.id },
        {
          passwordHash: await bcrypt.hash(newPassword, 10),
          // The link was delivered to this exact address and used, which proves control of it.
          isEmailVerified: true,
        },
      );
      // Any other reset link still in the inbox is now pointless; a verification link too.
      await this.tokens.invalidateOutstanding(user.id, null, manager);
      // Every device signs in again. Committed together with the password, or not at all.
      await this.sessions.revokeAllForUser(user.id, 'password_change', manager);
      return { ok: true as const, userId: user.id, tokenId: spent.token.id };
    });

    if (!outcome.ok) {
      this.logger.warn(JSON.stringify({ event: 'password_reset_refused', reason: outcome.reason }));
      throw new BadRequestException(INVALID_RESET_LINK);
    }

    await this.auditLog.log({
      user: { id: outcome.userId },
      action: 'auth.password_reset_completed',
      entityType: 'user',
      entityId: outcome.userId,
      afterData: { tokenId: outcome.tokenId, sessionsRevoked: true, revokedReason: 'password_change' },
    });
    return { passwordReset: true, message: 'Your S4 password has been changed. Sign in with your new password.' };
  }

  /**
   * When this account's password was last reset, or null. An access token issued before that instant
   * is no longer honoured, so a reset ends web sessions (which hold only an access token) as well as
   * mobile refresh sessions.
   */
  async lastPasswordResetAt(userId: number): Promise<Date | null> {
    const row = await this.dataSource.query(
      `SELECT MAX("usedAt") AS "at" FROM "user_verification_tokens"
        WHERE "userId" = $1 AND "purpose" = $2 AND "usedAt" IS NOT NULL`,
      [userId, VerificationTokenPurpose.PASSWORD_RESET],
    );
    const at = row?.[0]?.at;
    return at ? new Date(at) : null;
  }

  // ── email verification ────────────────────────────────────────────────────────────────────────────

  /** Issue (or reissue) a verification link for an account that still needs one. */
  async sendVerification(user: Pick<User, 'id' | 'email'>) {
    const issued = await this.tokens.issue(
      user.id,
      VerificationTokenPurpose.EMAIL_VERIFICATION,
      EMAIL_VERIFICATION_TTL_MS,
    );
    void this.email.send(emailVerificationEmail(user.email, this.email.webAppUrl, issued.token));
    await this.auditLog.log({
      user: { id: user.id },
      action: 'auth.email_verification_sent',
      entityType: 'user',
      entityId: user.id,
      afterData: { tokenId: issued.id, expiresAt: issued.expiresAt.toISOString() },
    });
  }

  async resendVerification(emailInput: string) {
    try {
      const user = await this.users.findForRecovery(emailInput);
      if (
        user &&
        user.emailVerificationRequired &&
        !user.isEmailVerified &&
        (await this.tokens.mayIssue(user.id, VerificationTokenPurpose.EMAIL_VERIFICATION))
      ) {
        await this.sendVerification(user);
      }
    } catch (error) {
      this.logger.error(
        JSON.stringify({ event: 'verification_resend_failed', reason: error instanceof Error ? error.name : 'unknown' }),
      );
    }
    return { ...RESEND_VERIFICATION_RESPONSE };
  }

  async verifyEmail(token: string) {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const spent = await this.tokens.consume(manager, token, VerificationTokenPurpose.EMAIL_VERIFICATION);
      if (!spent.ok) return { ok: false as const, reason: spent.reason };

      const users = manager.getRepository(User);
      const user = await users.findOne({ where: { id: spent.token.userId } });
      if (!user || user.deletionCompletedAt) return { ok: false as const, reason: 'unknown' as const };

      await users.update({ id: user.id }, { isEmailVerified: true });
      await this.tokens.invalidateOutstanding(user.id, VerificationTokenPurpose.EMAIL_VERIFICATION, manager);
      return { ok: true as const, userId: user.id, tokenId: spent.token.id };
    });

    if (!outcome.ok) {
      this.logger.warn(JSON.stringify({ event: 'email_verification_refused', reason: outcome.reason }));
      throw new BadRequestException(INVALID_VERIFICATION_LINK);
    }

    await this.auditLog.log({
      user: { id: outcome.userId },
      action: 'auth.email_verified',
      entityType: 'user',
      entityId: outcome.userId,
      afterData: { tokenId: outcome.tokenId },
    });
    return { emailVerified: true, message: 'Your email address is verified. You can now sign in to S4.' };
  }
}
