import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from './entities/job.entity';
import { JobController } from './job.controller';
import { JobService } from './job.service';
import { CompanyModule } from '../company/company.module';

@Module({
  imports: [TypeOrmModule.forFeature([Job]), CompanyModule],
  controllers: [JobController],
  providers: [JobService],
  exports: [JobService, TypeOrmModule]
})
export class JobModule {}
