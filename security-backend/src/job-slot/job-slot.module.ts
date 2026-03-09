import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobSlot } from './entities/job-slot.entity';
import { JobSlotService } from './job-slot.service';
import { JobSlotController } from './job-slot.controller';

@Module({
  imports: [TypeOrmModule.forFeature([JobSlot])],
  providers: [JobSlotService],
  controllers: [JobSlotController],
  exports: [JobSlotService, TypeOrmModule],
})
export class JobSlotModule {}
