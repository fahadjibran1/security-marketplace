import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from '../entities/company.entity';
import { AuditLogModule } from '../../audit-log/audit-log.module';
import { CompanyMembershipModule } from '../../company-membership/company-membership.module';
import { CompanyVerificationController, CompanyVerificationSelfController } from './company-verification.controller';
import { CompanyVerificationService } from './company-verification.service';

/** SEC-PUBLIC-03 administration. A module of its own: AuditLogModule already imports CompanyModule. */
@Module({
  imports: [TypeOrmModule.forFeature([Company]), AuditLogModule, CompanyMembershipModule],
  controllers: [CompanyVerificationController, CompanyVerificationSelfController],
  providers: [CompanyVerificationService],
  exports: [CompanyVerificationService],
})
export class CompanyVerificationModule {}
