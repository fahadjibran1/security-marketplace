import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompanyMembership } from './entities/company-membership.entity';
import { CompanyInvitation } from './entities/company-invitation.entity';
import { CompanyMembershipService } from './company-membership.service';
import { CompanyModule } from '../company/company.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CompanyMembership, CompanyInvitation]),
    forwardRef(() => CompanyModule),
  ],
  providers: [CompanyMembershipService],
  exports: [CompanyMembershipService],
})
export class CompanyMembershipModule {}
