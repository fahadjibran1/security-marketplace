import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from './entities/job.entity';
import { JobController } from './job.controller';
import { JobService } from './job.service';
import { CompanyModule } from '../company/company.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { SiteModule } from '../site/site.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([Job]), CompanyModule, CompanyMembershipModule, SiteModule, AuditLogModule],
  controllers: [JobController],
  providers: [JobService],
  exports: [JobService, TypeOrmModule]
})
export class JobModule {}
