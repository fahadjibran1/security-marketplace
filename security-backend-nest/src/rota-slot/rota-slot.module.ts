import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { AvailabilityModule } from '../availability/availability.module';
import { CompanyGuardModule } from '../company-guard/company-guard.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Shift } from '../shift/entities/shift.entity';
import { Site } from '../site/entities/site.entity';
import { RotaSlot } from './entities/rota-slot.entity';
import { RotaController } from './rota.controller';
import { RotaWeekService } from './rota-week.service';
import { RotaSlotController } from './rota-slot.controller';
import { RotaSlotService } from './rota-slot.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([RotaSlot, Shift, Site, GuardProfile]),
    CompanyMembershipModule,
    CompanyGuardModule,
    AvailabilityModule,
    AuditLogModule,
  ],
  controllers: [RotaSlotController, RotaController],
  providers: [RotaSlotService, RotaWeekService],
  exports: [RotaSlotService, RotaWeekService],
})
export class RotaSlotModule {}
