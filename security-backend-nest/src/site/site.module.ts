import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Site } from './entities/site.entity';
import { SiteController } from './site.controller';
import { SiteService } from './site.service';
import { CompanyModule } from '../company/company.module';

@Module({
  imports: [TypeOrmModule.forFeature([Site]), CompanyModule],
  controllers: [SiteController],
  providers: [SiteService],
  exports: [SiteService, TypeOrmModule],
})
export class SiteModule {}
