import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserRole } from '../user/entities/user.entity';
import { AdminMfaService } from './admin-mfa.service';
import { JwtPayload } from './types/jwt-payload.type';

type MfaRequest = { body?: { challengeToken?: unknown }; headers?: Record<string, unknown>; user?: JwtPayload & { mfaStage?: string } };

function bearer(req: MfaRequest): string | null {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * POST /auth/mfa/verify: the body's challenge token (issued by a correct password, valid for 5 minutes, signed with
 * its own derived key) authenticates the request as that Platform Admin for this one route. Anything else is 401.
 */
@Injectable()
export class AdminMfaChallengeGuard implements CanActivate {
  constructor(private readonly mfa: AdminMfaService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<MfaRequest>();
    const userId = this.mfa.verifyChallengeToken(req.body?.challengeToken);
    req.user = { sub: userId, email: '', role: UserRole.ADMIN, status: 'active', principalType: 'user', mfaStage: 'challenge' };
    return true;
  }
}

/**
 * The enrolment routes: an ordinary access token (an admin setting up two-step verification voluntarily), or the
 * enrolment token a password sign-in returns while PLATFORM_ADMIN_MFA_REQUIRED is on and the admin is not enrolled.
 * The enrolment token is accepted by these routes only; JwtStrategy cannot verify it (different key), so it reaches
 * nothing else. Role is still enforced by RolesGuard after this guard.
 */
@Injectable()
export class AdminMfaEnrolmentGuard extends JwtAuthGuard {
  constructor(reflector: Reflector, private readonly mfa: AdminMfaService) {
    super(reflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<MfaRequest>();
    const token = bearer(req);
    const enrolmentUserId = token ? this.mfa.verifyEnrolmentToken(token) : null;
    if (enrolmentUserId !== null) {
      req.user = { sub: enrolmentUserId, email: '', role: UserRole.ADMIN, status: 'active', principalType: 'user', mfaStage: 'enrolment' };
      return true;
    }
    return (await super.canActivate(context)) as boolean;
  }
}
