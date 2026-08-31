import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobMatch } from './entities/job-match.entity';
import { JobMatchService } from './job-match.service';
import { JobSlotModule } from '../job-slot/job-slot.module';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { AvailabilityModule } from '../availability/availability.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([JobMatch, CompanyGuard, GuardProfile]),
    forwardRef(() => JobSlotModule),
    AvailabilityModule,
  ],
  providers: [JobMatchService],
  exports: [JobMatchService, TypeOrmModule],
})
export class JobMatchModule {}
