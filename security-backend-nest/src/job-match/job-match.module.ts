import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobMatch } from './entities/job-match.entity';
import { JobMatchService } from './job-match.service';
import { JobSlotModule } from '../job-slot/job-slot.module';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Shift } from '../shift/entities/shift.entity';

@Module({
  imports: [TypeOrmModule.forFeature([JobMatch, CompanyGuard, GuardProfile, Shift]), forwardRef(() => JobSlotModule)],
  providers: [JobMatchService],
  exports: [JobMatchService, TypeOrmModule],
})
export class JobMatchModule {}
