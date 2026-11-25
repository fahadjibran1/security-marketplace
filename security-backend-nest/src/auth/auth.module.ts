import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UserModule } from '../user/user.module';
import { JwtStrategy } from './jwt.strategy';
import { CompanyModule } from '../company/company.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { ClientPortalUserModule } from '../client-portal-user/client-portal-user.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthThrottlerGuard } from './auth-throttler.guard';
import { LoginAttemptLimiter } from './login-attempt-limiter';
import { ClientIpDiagnosticsController } from '../common/http/client-ip-diagnostics.controller';
import { CompanyMembership } from '../company-membership/entities/company-membership.entity';
import { AuthSession } from './entities/auth-session.entity';
import { AuthSessionService } from './auth-session.service';
import { UserVerificationToken } from './entities/user-verification-token.entity';
import { UserVerificationTokenService } from './user-verification-token.service';
import { AccountRecoveryService } from './account-recovery.service';
import { AccountDeletionService } from './account-deletion.service';
import { AccountRecoveryController } from './account-recovery.controller';
import { AccountController } from './account.controller';
import { EmailModule } from '../email/email.module';
import { AUTH_THROTTLERS } from './auth-throttler.guard';
import { PlatformAdminMfa } from './entities/platform-admin-mfa.entity';
import { AdminMfaService } from './admin-mfa.service';
import { AdminMfaController } from './admin-mfa.controller';
import { AdminMfaChallengeGuard, AdminMfaEnrolmentGuard } from './admin-mfa.guards';
import { EncryptionService } from '../guard-personnel/encryption.service';

@Module({
  imports: [
    ThrottlerModule.forRoot(AUTH_THROTTLERS),
    ConfigModule,
    UserModule,
    CompanyModule,
    GuardProfileModule,
    ClientPortalUserModule,
    AuditLogModule,
    EmailModule,
    PassportModule,
    TypeOrmModule.forFeature([CompanyMembership, AuthSession, UserVerificationToken, PlatformAdminMfa]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'super-secret-change-me'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '1d') }
      })
    })
  ],
  controllers: [AuthController, AccountRecoveryController, AccountController, ClientIpDiagnosticsController, AdminMfaController],
  providers: [
    AuthService,
    AuthSessionService,
    UserVerificationTokenService,
    AccountRecoveryService,
    AccountDeletionService,
    JwtStrategy,
    AuthThrottlerGuard,
    LoginAttemptLimiter,
    // Platform Admin two-step verification. EncryptionService is the personnel-data AES-256-GCM helper
    // (GUARD_DATA_ENCRYPTION_KEY), which GuardPersonnelModule already requires at boot.
    AdminMfaService,
    AdminMfaChallengeGuard,
    AdminMfaEnrolmentGuard,
    EncryptionService,
  ],
  // ThrottlerModule and the proxy-aware guard are exported so other modules can rate-limit their own
  // bearer-secret endpoints against the same configuration instead of registering a second throttler
  // with separate storage.
  exports: [AuthService, AuthSessionService, ThrottlerModule, AuthThrottlerGuard, LoginAttemptLimiter]
})
export class AuthModule {}
