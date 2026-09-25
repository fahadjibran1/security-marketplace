import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { GuardApprovalStatus, GuardProfile } from './entities/guard-profile.entity';
import { CreateGuardProfileDto } from './dto/create-guard-profile.dto';
import { UserService } from '../user/user.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { isCompanyRole, UserRole, UserStatus } from '../user/entities/user.entity';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { CompanyService } from '../company/company.service';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
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
    private readonly membershipService: CompanyMembershipService,
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

    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.GUARDS_VIEW,
    );

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
      const { company } = await this.membershipService.resolveCompanyContext(
        user.sub, user.role, CompanyPermission.GUARDS_VIEW,
      );

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

  async updateByUserId(userId: number, dto: {
    fullName?: string;
    phone?: string;
    locationSharingEnabled?: boolean;
    siaLicenseNumber?: string;
    siaExpiryDate?: string | null;
    rightToWorkStatus?: string | null;
    rightToWorkExpiryDate?: string | null;
  }): Promise<GuardProfile> {
    const guard = await this.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    Object.assign(guard, dto);
    return this.guardRepo.save(guard);
  }

  /**
   * Platform-global Guard approval. Restricted to Platform Admin.
   *
   * The Company branch that used to live here was removed: it let a Company write
   * status / approvalStatus / isApproved on the shared GuardProfile, and additionally activated the
   * CompanyGuard link and the Guard's user account as side effects. Because those three columns are
   * per-Guard rather than per-relationship, one Company's click changed what every other Company saw
   * and could do. Company workforce membership belongs on the CompanyGuard relationship.
   *
   * These columns no longer gate deployment either — see ComplianceService.assertGuardAssignable.
   */
  async approveForUser(user: JwtPayload, guardId: number): Promise<GuardProfile> {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Guard approval is a platform administration action.');
    }

    const guard = await this.findOne(guardId);
    const beforeApproval = {
      status: guard.status,
      approvalStatus: guard.approvalStatus,
      isApproved: guard.isApproved,
    };

    guard.status = GuardApprovalStatus.APPROVED;
    guard.approvalStatus = GuardApprovalStatus.APPROVED;
    guard.isApproved = true;
    const saved = await this.guardRepo.save(guard);
    await this.userService.updateStatus(saved.user.id, UserStatus.ACTIVE);
    const approved = await this.findOne(saved.id);
    await this.auditLogService.log({
      company: null,
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
