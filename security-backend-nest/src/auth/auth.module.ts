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
import { CompanyMembership } from '../company-membership/entities/company-membership.entity';
import { AuthSession } from './entities/auth-session.entity';
import { AuthSessionService } from './auth-session.service';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 6 }]),
    ConfigModule,
    UserModule,
    CompanyModule,
    GuardProfileModule,
    ClientPortalUserModule,
    AuditLogModule,
    PassportModule,
    TypeOrmModule.forFeature([CompanyMembership, AuthSession]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'super-secret-change-me'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '1d') }
      })
    })
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthSessionService, JwtStrategy, AuthThrottlerGuard],
  exports: [AuthService, AuthSessionService]
})
export class AuthModule {}
