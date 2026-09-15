import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';
import { CompanyModule } from '../company/company.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog]), CompanyModule, CompanyMembershipModule],
  controllers: [AuditLogController],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
