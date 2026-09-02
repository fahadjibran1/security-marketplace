import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EncryptionService } from './encryption.service';
import { GuardPersonnelService } from './guard-personnel.service';
import { GuardPersonnelController } from './guard-personnel.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([GuardProfile]),
    AuditLogModule,
  ],
  controllers: [GuardPersonnelController],
  providers: [EncryptionService, GuardPersonnelService],
  // Export EncryptionService so future modules (P1E bank details, P1D licence)
  // can import this module and reuse the same key-versioned cipher.
  exports: [EncryptionService],
})
export class GuardPersonnelModule {}
