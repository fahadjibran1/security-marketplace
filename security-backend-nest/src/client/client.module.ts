import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client } from './entities/client.entity';
import { ClientService } from './client.service';
import { ClientController } from './client.controller';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([Client]), CompanyMembershipModule, AuditLogModule],
  providers: [ClientService],
  controllers: [ClientController],
  exports: [ClientService, TypeOrmModule],
})
export class ClientModule {}
