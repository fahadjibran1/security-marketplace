import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GuardProfile } from './entities/guard-profile.entity';
import { GuardProfileController } from './guard-profile.controller';
import { GuardProfileService } from './guard-profile.service';
import { UserModule } from '../user/user.module';
import { CompanyModule } from '../company/company.module';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';

@Module({
  imports: [TypeOrmModule.forFeature([GuardProfile, CompanyGuard]), UserModule, CompanyModule],
  controllers: [GuardProfileController],
  providers: [GuardProfileService],
  exports: [GuardProfileService, TypeOrmModule]
})
export class GuardProfileModule {}
