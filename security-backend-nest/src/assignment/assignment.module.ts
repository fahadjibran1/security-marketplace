import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Assignment } from './entities/assignment.entity';
import { AssignmentController } from './assignment.controller';
import { AssignmentService } from './assignment.service';
import { CompanyModule } from '../company/company.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { ComplianceModule } from '../compliance/compliance.module';

@Module({
  imports: [TypeOrmModule.forFeature([Assignment]), CompanyModule, GuardProfileModule, ComplianceModule],
  controllers: [AssignmentController],
  providers: [AssignmentService],
  exports: [AssignmentService, TypeOrmModule]
})
export class AssignmentModule {}
