import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { GuardDrivingProfile } from './entities/guard-driving-profile.entity';
import { GuardEmergencyContact } from './entities/guard-emergency-contact.entity';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { User } from '../user/entities/user.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EncryptionService } from './encryption.service';
import { GuardPersonnelService } from './guard-personnel.service';
import { DrivingTransportService } from './driving-transport.service';
import { EmergencyContactService } from './emergency-contact.service';
import { GuardPersonnelController } from './guard-personnel.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([GuardProfile, GuardDrivingProfile, GuardEmergencyContact, CompanyGuard, User]),
    AuditLogModule,
  ],
  controllers: [GuardPersonnelController],
  providers: [EncryptionService, GuardPersonnelService, DrivingTransportService, EmergencyContactService],
  exports: [EncryptionService],
})
export class GuardPersonnelModule {}
