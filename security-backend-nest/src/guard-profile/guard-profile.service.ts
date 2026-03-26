import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GuardApprovalStatus, GuardProfile } from './entities/guard-profile.entity';
import { CreateGuardProfileDto } from './dto/create-guard-profile.dto';
import { UpdateGuardProfileDto } from './dto/update-guard-profile.dto';
import { UserService } from '../user/user.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { COMPANY_ADMIN_ROLES, isCompanyRole, UserRole, UserStatus } from '../user/entities/user.entity';
import {
  CompanyGuard,
  CompanyGuardRelationshipType,
  CompanyGuardStatus,
} from '../company-guard/entities/company-guard.entity';
import { CompanyService } from '../company/company.service';

@Injectable()
export class GuardProfileService {
  constructor(
    @InjectRepository(GuardProfile) private readonly guardRepo: Repository<GuardProfile>,
    @InjectRepository(CompanyGuard)
    private readonly companyGuardRepo: Repository<CompanyGuard>,
    private readonly userService: UserService,
    private readonly companyService: CompanyService,
  ) {}

  async create(dto: CreateGuardProfileDto): Promise<GuardProfile> {
    const user = await this.userService.findById(dto.userId);
    const guard = this.guardRepo.create({
      ...dto,
      user,
      locationSharingEnabled: dto.locationSharingEnabled ?? false,
      status: dto.status ?? 'pending'
    });
    return this.guardRepo.save(guard);
  }

  findAll(): Promise<GuardProfile[]> {
    return this.guardRepo.find();
  }

  async findOne(id: number): Promise<GuardProfile> {
    const guard = await this.guardRepo.findOne({ where: { id } });
    if (!guard) throw new NotFoundException('Guard profile not found');
    return guard;
  }

  async findOneForUser(user: JwtPayload, id: number): Promise<GuardProfile> {
    const guard = await this.findOne(id);

    if (user.role === UserRole.ADMIN || isCompanyRole(user.role)) {
      return guard;
    }

    const ownGuard = await this.findByUserId(user.sub);
    if (!ownGuard || ownGuard.id !== guard.id) {
      throw new NotFoundException('Guard profile not found');
    }

    return guard;
  }

  async findByUserId(userId: number): Promise<GuardProfile | null> {
    return this.guardRepo.findOne({ where: { user: { id: userId } } });
  }

  async updateByUserId(userId: number, dto: UpdateGuardProfileDto): Promise<GuardProfile> {
    const guard = await this.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    Object.assign(guard, dto);
    return this.guardRepo.save(guard);
  }

  async approveForUser(user: JwtPayload, guardId: number): Promise<GuardProfile> {
    const guard = await this.findOne(guardId);

    if (user.role !== UserRole.ADMIN) {
      if (!COMPANY_ADMIN_ROLES.includes(user.role as (typeof COMPANY_ADMIN_ROLES)[number])) {
        throw new NotFoundException('Guard profile not found');
      }

      const company = await this.companyService.findByUserId(user.sub);
      if (!company) {
        throw new NotFoundException('Company not found');
      }

      const existingLink = await this.companyGuardRepo.findOne({
        where: { company: { id: company.id }, guard: { id: guard.id } },
      });

      const link =
        existingLink ??
        this.companyGuardRepo.create({
          company,
          guard,
          relationshipType: CompanyGuardRelationshipType.APPROVED_CONTRACTOR,
        });

      link.status = CompanyGuardStatus.ACTIVE;
      if (!link.relationshipType) {
        link.relationshipType = CompanyGuardRelationshipType.APPROVED_CONTRACTOR;
      }
      await this.companyGuardRepo.save(link);
    }

    guard.status = GuardApprovalStatus.APPROVED;
    guard.approvalStatus = GuardApprovalStatus.APPROVED;
    guard.isApproved = true;
    const saved = await this.guardRepo.save(guard);
    await this.userService.updateStatus(saved.user.id, UserStatus.ACTIVE);
    return this.findOne(saved.id);
  }
}
