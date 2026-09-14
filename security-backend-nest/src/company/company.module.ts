import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from './entities/company.entity';
import { CompanyController } from './company.controller';
import { CompanyService } from './company.service';
import { UserModule } from '../user/user.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';

@Module({
  imports: [TypeOrmModule.forFeature([Company]), UserModule, forwardRef(() => CompanyMembershipModule)],
  controllers: [CompanyController],
  providers: [CompanyService],
  exports: [CompanyService, TypeOrmModule]
})
export class CompanyModule {}
