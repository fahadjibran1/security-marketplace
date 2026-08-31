import { SetMetadata } from '@nestjs/common';
import { UserStatus } from '../../user/entities/user.entity';

export const ALLOWED_STATUSES_KEY = 'allowed_statuses';

export const AllowedStatuses = (...statuses: UserStatus[]) =>
  SetMetadata(ALLOWED_STATUSES_KEY, statuses);
