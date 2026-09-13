import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AvailabilityModule } from '../availability/availability.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { Shift } from '../shift/entities/shift.entity';
import { CoverageController } from './coverage.controller';
import { CoverageService } from './coverage.service';

@Module({
  imports: [TypeOrmModule.forFeature([Shift]), CompanyMembershipModule, AvailabilityModule],
  controllers: [CoverageController],
  providers: [CoverageService],
  exports: [CoverageService],
})
export class CoverageModule {}
