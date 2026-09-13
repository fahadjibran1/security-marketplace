import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from './entities/client.entity';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { UserRole } from '../user/entities/user.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class ClientService {
  constructor(
    @InjectRepository(Client) private readonly clientRepo: Repository<Client>,
    private readonly membershipService: CompanyMembershipService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAllForCompanyUser(userId: number, userRole: UserRole): Promise<Client[]> {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.CLIENTS_VIEW);

    return this.clientRepo.find({
      where: { company: { id: company.id } },
      order: { name: 'ASC' },
    });
  }

  async findOneForCompanyUser(userId: number, userRole: UserRole, id: number): Promise<Client> {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.CLIENTS_VIEW);

    const client = await this.clientRepo.findOne({
      where: { id, company: { id: company.id } },
    });
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    return client;
  }

  async createForCompanyUser(userId: number, userRole: UserRole, dto: CreateClientDto): Promise<Client> {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.CLIENTS_MANAGE);

    const normalizedName = dto.name.trim();
    if (!normalizedName) {
      throw new BadRequestException('Client name is required');
    }

    const existing = await this.clientRepo
      .createQueryBuilder('client')
      .where('client.companyId = :companyId', { companyId: company.id })
      .andWhere('LOWER(client.name) = LOWER(:name)', { name: normalizedName })
      .getOne();
    if (existing) {
      throw new ConflictException('Client already exists for this company');
    }

    const client = this.clientRepo.create({
      company,
      name: normalizedName,
      contactName: dto.contactName?.trim() || null,
      contactEmail: dto.contactEmail?.trim().toLowerCase() || null,
      contactPhone: dto.contactPhone?.trim() || null,
      contactDetails: dto.contactDetails?.trim() || null,
      status: dto.status ?? 'active',
    });

    const saved = await this.clientRepo.save(client);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'client.created',
      entityType: 'client',
      entityId: saved.id,
      afterData: {
        name: saved.name,
        contactName: saved.contactName,
        contactEmail: saved.contactEmail,
        contactPhone: saved.contactPhone,
        status: saved.status,
      },
    });
    return saved;
  }

  async updateForCompanyUser(userId: number, userRole: UserRole, id: number, dto: UpdateClientDto): Promise<Client> {
    const client = await this.findOneForCompanyUser(userId, userRole, id);
    const company = client.company;
    const nextName = dto.name?.trim();

    if (nextName) {
      const duplicate = await this.clientRepo
        .createQueryBuilder('client')
        .where('client.companyId = :companyId', { companyId: company.id })
        .andWhere('client.id != :id', { id })
        .andWhere('LOWER(client.name) = LOWER(:name)', { name: nextName })
        .getOne();
      if (duplicate) {
        throw new ConflictException('Another client already uses that name');
      }
    }

    const beforeData = {
      name: client.name,
      contactName: client.contactName,
      contactEmail: client.contactEmail,
      contactPhone: client.contactPhone,
      contactDetails: client.contactDetails,
      status: client.status,
    };

    Object.assign(client, dto);
    if (nextName) {
      client.name = nextName;
    }
    if (dto.contactName !== undefined) {
      client.contactName = dto.contactName?.trim() || null;
    }
    if (dto.contactEmail !== undefined) {
      client.contactEmail = dto.contactEmail?.trim().toLowerCase() || null;
    }
    if (dto.contactPhone !== undefined) {
      client.contactPhone = dto.contactPhone?.trim() || null;
    }
    if (dto.contactDetails !== undefined) {
      client.contactDetails = dto.contactDetails?.trim() || null;
    }
    const saved = await this.clientRepo.save(client);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'client.updated',
      entityType: 'client',
      entityId: saved.id,
      beforeData,
      afterData: {
        name: saved.name,
        contactName: saved.contactName,
        contactEmail: saved.contactEmail,
        contactPhone: saved.contactPhone,
        contactDetails: saved.contactDetails,
        status: saved.status,
      },
    });
    return saved;
  }
}
