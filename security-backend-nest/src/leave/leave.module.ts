import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { CompanyModule } from '../company/company.module';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { GuardLeave } from './entities/guard-leave.entity';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([GuardLeave, CompanyGuard]),
    CompanyModule,
    GuardProfileModule,
    AuditLogModule,
  ],
  controllers: [LeaveController],
  providers: [LeaveService],
  exports: [LeaveService, TypeOrmModule],
})
export class LeaveModule {}
