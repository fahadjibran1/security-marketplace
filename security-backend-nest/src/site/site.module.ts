import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Site } from './entities/site.entity';
import { SiteController } from './site.controller';
import { SiteService } from './site.service';
import { CompanyModule } from '../company/company.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { ClientModule } from '../client/client.module';

@Module({
  imports: [TypeOrmModule.forFeature([Site]), CompanyModule, AuditLogModule, ClientModule],
  controllers: [SiteController],
  providers: [SiteService],
  exports: [SiteService, TypeOrmModule],
})
export class SiteModule {}
