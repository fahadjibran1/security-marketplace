import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CompanyGuard, CompanyGuardStatus } from './entities/company-guard.entity';
import { CreateCompanyGuardDto } from './dto/create-company-guard.dto';
import { CompanyService } from '../company/company.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { UserRole } from '../user/entities/user.entity';

@Injectable()
export class CompanyGuardService {
  constructor(
    @InjectRepository(CompanyGuard) private readonly companyGuardRepo: Repository<CompanyGuard>,
    private readonly companyService: CompanyService,
    private readonly guardService: GuardProfileService,
  ) {}

  findAll(): Promise<CompanyGuard[]> {
    return this.companyGuardRepo.find();
  }

  async findAllForUser(user: JwtPayload): Promise<CompanyGuard[]> {
    if (user.role === UserRole.ADMIN) {
      return this.findAll();
    }

    const company = await this.companyService.findByUserId(user.sub);
    if (!company) {
      throw new NotFoundException('Company not found');
    }

    return this.companyGuardRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async create(dto: CreateCompanyGuardDto): Promise<CompanyGuard> {
    const company = await this.companyService.findOne(dto.companyId);
    const guard = await this.guardService.findOne(dto.guardId);

    const exists = await this.companyGuardRepo.findOne({ where: { company: { id: company.id }, guard: { id: guard.id } } });
    if (exists) throw new ConflictException('Company-guard relationship already exists');

    const row = this.companyGuardRepo.create({
      company,
      guard,
      status: dto.status ?? CompanyGuardStatus.ACTIVE,
      relationshipType: dto.relationshipType,
    });

    return this.companyGuardRepo.save(row);
  }

  async ensureActiveRelationship(companyId: number, guardId: number): Promise<CompanyGuard> {
    const relation = await this.companyGuardRepo.findOne({
      where: { company: { id: companyId }, guard: { id: guardId }, status: CompanyGuardStatus.ACTIVE },
    });

    if (!relation) {
      throw new ConflictException('Guard is not active/approved for this company');
    }

    return relation;
  }
}
