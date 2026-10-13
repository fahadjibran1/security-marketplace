import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from './types/jwt-payload.type';
import { ClientPortalUserService } from '../client-portal-user/client-portal-user.service';
import { UserStatus } from '../user/entities/user.entity';
import { AccountRecoveryService } from './account-recovery.service';
import { mustVerifyEmail } from './auth.service';

/**
 * Only "this account does not exist" means the token's subject is gone. Any other failure — a
 * database or connection-pool timeout above all — is NOT an authentication result and must not be
 * reported as 401: the web and mobile clients treat 401 as an expired session, try to renew it and
 * then sign the person out. Rethrown, it surfaces as a server error and the session survives.
 */
function absentIfNotFound(error: unknown): null {
  if (error instanceof NotFoundException) return null;
  throw error;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly clientPortalUserService: ClientPortalUserService,
    private readonly accountRecoveryService: AccountRecoveryService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'super-secret-change-me')
    });
  }

  async validate(payload: JwtPayload & { iat?: number }): Promise<JwtPayload> {
    if (payload.principalType === 'client_portal') {
      const clientUser = await this.clientPortalUserService.findById(payload.sub).catch(absentIfNotFound);
      if (!clientUser || !clientUser.isActive) {
        throw new UnauthorizedException('Client portal user not found');
      }

      return {
        sub: clientUser.id,
        email: clientUser.email,
        role: clientUser.role,
        status: 'active',
        principalType: 'client_portal',
        clientId: clientUser.client.id,
      };
    }

    // The account and its last password reset in one round trip (see findSessionSubject).
    const { user, lastPasswordResetAt: resetAt } = await this.accountRecoveryService.findSessionSubject(payload.sub);
    if (!user || user.status !== UserStatus.ACTIVE || user.deletionCompletedAt || mustVerifyEmail(user)) {
      throw new UnauthorizedException('User not found');
    }

    // A password reset ends every session, including web sessions that hold only an access token: a
    // token signed before the reset is no longer honoured. Compared at whole-second precision because
    // that is all iat carries, so a token signed in the same second as the reset is still accepted.
    if (resetAt && typeof payload.iat === 'number' && payload.iat < Math.floor(resetAt.getTime() / 1000)) {
      throw new UnauthorizedException('Session is no longer valid');
    }

    return {
      sub: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      principalType: 'user',
    };
  }
}
