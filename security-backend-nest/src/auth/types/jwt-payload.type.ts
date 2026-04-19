import { UserRole, UserStatus } from '../../user/entities/user.entity';

export interface JwtPayload {
  sub: number;
  email: string;
  role: UserRole;
  status: UserStatus | 'active';
  principalType?: 'user' | 'client_portal';
  clientId?: number;
}
