import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { CompanyModule } from '../company/company.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';

@Module({
  imports: [TypeOrmModule.forFeature([Notification]), CompanyModule, CompanyMembershipModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
