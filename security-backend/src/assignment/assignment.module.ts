import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Assignment } from './entities/assignment.entity';
import { AssignmentController } from './assignment.controller';
import { AssignmentService } from './assignment.service';

@Module({
  imports: [TypeOrmModule.forFeature([Assignment])],
  controllers: [AssignmentController],
  providers: [AssignmentService],
  exports: [AssignmentService, TypeOrmModule]
})
export class AssignmentModule {}
