import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GuardProfile } from './entities/guard-profile.entity';
import { GuardProfileController } from './guard-profile.controller';
import { GuardProfileService } from './guard-profile.service';
import { UserModule } from '../user/user.module';

@Module({
  imports: [TypeOrmModule.forFeature([GuardProfile]), UserModule],
  controllers: [GuardProfileController],
  providers: [GuardProfileService],
  exports: [GuardProfileService, TypeOrmModule]
})
export class GuardProfileModule {}
