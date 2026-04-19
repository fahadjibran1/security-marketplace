import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from './types/jwt-payload.type';
import { UserService } from '../user/user.service';
import { ClientPortalUserService } from '../client-portal-user/client-portal-user.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly userService: UserService,
    private readonly clientPortalUserService: ClientPortalUserService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'super-secret-change-me')
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    if (payload.principalType === 'client_portal') {
      const clientUser = await this.clientPortalUserService.findById(payload.sub).catch(() => null);
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

    const user = await this.userService.findById(payload.sub).catch(() => null);
    if (!user) {
      throw new UnauthorizedException('User not found');
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
