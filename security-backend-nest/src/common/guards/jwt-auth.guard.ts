import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ALLOWED_STATUSES_KEY } from '../decorators/allowed-statuses.decorator';
import { JwtPayload } from '../../auth/types/jwt-payload.type';
import { UserStatus } from '../../user/entities/user.entity';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  handleRequest<TUser = JwtPayload>(
    err: unknown,
    user: TUser,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (err) {
      throw err;
    }

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const allowedStatuses =
      this.reflector.getAllAndOverride<UserStatus[]>(ALLOWED_STATUSES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [UserStatus.ACTIVE];

    const requestUser = user as unknown as JwtPayload;
    if (!allowedStatuses.includes(requestUser.status)) {
      throw new ForbiddenException(`Account status ${requestUser.status} is not allowed`);
    }

    return user;
  }
}
