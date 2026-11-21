import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from '../entities/company.entity';
import { AuditLogModule } from '../../audit-log/audit-log.module';
import { CompanyVerificationController } from './company-verification.controller';
import { CompanyVerificationService } from './company-verification.service';

/** SEC-PUBLIC-03 administration. A module of its own: AuditLogModule already imports CompanyModule. */
@Module({
  imports: [TypeOrmModule.forFeature([Company]), AuditLogModule],
  controllers: [CompanyVerificationController],
  providers: [CompanyVerificationService],
  exports: [CompanyVerificationService],
})
export class CompanyVerificationModule {}
