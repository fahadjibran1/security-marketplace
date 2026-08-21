import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
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
import { AuditLogService } from '../audit-log/audit-log.service';
import { User } from '../user/entities/user.entity';

@Injectable()
export class GuardProfileService {
  constructor(
    @InjectRepository(GuardProfile) private readonly guardRepo: Repository<GuardProfile>,
    @InjectRepository(CompanyGuard)
    private readonly companyGuardRepo: Repository<CompanyGuard>,
    private readonly userService: UserService,
    private readonly companyService: CompanyService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateGuardProfileDto, manager?: EntityManager): Promise<GuardProfile> {
    const repo = manager?.getRepository(GuardProfile) ?? this.guardRepo;
    const user = manager
      ? await manager.getRepository(User).findOne({ where: { id: dto.userId } })
      : await this.userService.findById(dto.userId);
    if (!user) throw new NotFoundException('User not found');
    const guard = repo.create({
      ...dto,
      user,
      locationSharingEnabled: dto.locationSharingEnabled ?? false,
      status: dto.status ?? 'pending'
    });
    return repo.save(guard);
  }

  findBySiaLicenseNumber(siaLicenseNumber: string, manager?: EntityManager): Promise<GuardProfile | null> {
    const repo = manager?.getRepository(GuardProfile) ?? this.guardRepo;
    return repo.findOne({ where: { siaLicenseNumber } });
  }

  findAll(): Promise<GuardProfile[]> {
    return this.guardRepo.find();
  }

  async findAllForUser(user: JwtPayload): Promise<GuardProfile[]> {
    if (user.role === UserRole.ADMIN) {
      return this.findAll();
    }

    if (!isCompanyRole(user.role)) {
      throw new NotFoundException('Guard profiles not found');
    }

    const company = await this.companyService.findByUserId(user.sub);
    if (!company) {
      throw new NotFoundException('Company not found');
    }

    const links = await this.companyGuardRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });

    return links.map((link) => link.guard);
  }

  async findOne(id: number): Promise<GuardProfile> {
    const guard = await this.guardRepo.findOne({ where: { id } });
    if (!guard) throw new NotFoundException('Guard profile not found');
    return guard;
  }

  async findOneForUser(user: JwtPayload, id: number): Promise<GuardProfile> {
    const guard = await this.findOne(id);

    if (user.role === UserRole.ADMIN) {
      return guard;
    }

    if (isCompanyRole(user.role)) {
      const company = await this.companyService.findByUserId(user.sub);
      if (!company) {
        throw new NotFoundException('Guard profile not found');
      }

      const link = await this.companyGuardRepo.findOne({
        where: { company: { id: company.id }, guard: { id: guard.id } },
      });
      if (!link) {
        throw new NotFoundException('Guard profile not found');
      }
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
    const beforeApproval = {
      status: guard.status,
      approvalStatus: guard.approvalStatus,
      isApproved: guard.isApproved,
    };
    let auditCompany: { id: number } | null = null;

    if (user.role !== UserRole.ADMIN) {
      if (!COMPANY_ADMIN_ROLES.includes(user.role as (typeof COMPANY_ADMIN_ROLES)[number])) {
        throw new NotFoundException('Guard profile not found');
      }

      const company = await this.companyService.findByUserId(user.sub);
      if (!company) {
        throw new NotFoundException('Company not found');
      }
      auditCompany = { id: company.id };

      const existingLink = await this.companyGuardRepo.findOne({
        where: { company: { id: company.id }, guard: { id: guard.id } },
      });

      if (!existingLink) {
        throw new ForbiddenException('Guard approval requires an existing server-established company relationship');
      }
      const link = existingLink;

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
    const approved = await this.findOne(saved.id);
    await this.auditLogService.log({
      company: auditCompany,
      user: { id: user.sub },
      action: 'guard.approved',
      entityType: 'guard_profile',
      entityId: approved.id,
      beforeData: beforeApproval,
      afterData: {
        status: approved.status,
        approvalStatus: approved.approvalStatus,
        isApproved: approved.isApproved,
      },
    });
    return approved;
  }
}
