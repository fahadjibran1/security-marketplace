import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { ClientModule } from '../client/client.module';
import { ClientPortalUserController } from './client-portal-user.controller';
import { ClientPortalUserService } from './client-portal-user.service';
import { ClientPortalUser } from './entities/client-portal-user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ClientPortalUser]), ClientModule, AuditLogModule],
  controllers: [ClientPortalUserController],
  providers: [ClientPortalUserService],
  exports: [ClientPortalUserService, TypeOrmModule],
})
export class ClientPortalUserModule {}
