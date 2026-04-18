import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CompanyModule } from '../company/company.module';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';

@Module({
  imports: [TypeOrmModule.forFeature([Timesheet]), CompanyModule],
  controllers: [ReportController],
  providers: [ReportService],
})
export class ReportModule {}
