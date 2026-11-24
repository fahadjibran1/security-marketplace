import { UserRole, UserStatus } from '../../user/entities/user.entity';

export interface JwtPayload {
  sub: number;
  email: string;
  role: UserRole;
  status: UserStatus | 'active';
  principalType?: 'user' | 'client_portal';
  clientId?: number;
  /** Platform Admin only: the token was issued through two-step verification (required once the admin is enrolled). */
  mfa?: true;
}
