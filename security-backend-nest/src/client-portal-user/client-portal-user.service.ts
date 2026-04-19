import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';

import { AuditLogService } from '../audit-log/audit-log.service';
import { ClientService } from '../client/client.service';
import { UserRole } from '../user/entities/user.entity';
import { UpsertClientPortalUserDto } from './dto/upsert-client-portal-user.dto';
import { ClientPortalUser } from './entities/client-portal-user.entity';

@Injectable()
export class ClientPortalUserService {
  constructor(
    @InjectRepository(ClientPortalUser) private readonly clientPortalUserRepo: Repository<ClientPortalUser>,
    private readonly clientService: ClientService,
    private readonly auditLogService: AuditLogService,
  ) {}

  findByEmail(email: string) {
    return this.clientPortalUserRepo.findOne({ where: { email: email.trim().toLowerCase() } });
  }

  async findById(id: number) {
    const user = await this.clientPortalUserRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Client portal user not found');
    return user;
  }

  async listForClient(companyUserId: number, clientId: number) {
    await this.clientService.findOneForCompanyUser(companyUserId, clientId);
    return this.clientPortalUserRepo.find({
      where: { client: { id: clientId } },
      order: { createdAt: 'DESC' },
    });
  }

  async upsertForCompanyUser(companyUserId: number, dto: UpsertClientPortalUserDto) {
    const client = await this.clientService.findOneForCompanyUser(companyUserId, dto.clientId);
    const email = dto.email.trim().toLowerCase();
    const existingByEmail = await this.clientPortalUserRepo.findOne({ where: { email } });

    if (dto.id) {
      const user = await this.clientPortalUserRepo.findOne({
        where: { id: dto.id, client: { id: client.id } },
      });
      if (!user) throw new NotFoundException('Client portal user not found');
      if (existingByEmail && existingByEmail.id !== user.id) {
        throw new ConflictException('Another client portal user already uses that email.');
      }

      const beforeData = {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        isActive: user.isActive,
        role: user.role,
      };

      user.email = email;
      user.firstName = dto.firstName.trim();
      user.lastName = dto.lastName.trim();
      user.isActive = dto.isActive ?? user.isActive;
      user.role = dto.role;
      if (dto.password?.trim()) {
        user.passwordHash = await bcrypt.hash(dto.password, 10);
      }
      const saved = await this.clientPortalUserRepo.save(user);
      await this.auditLogService.log({
        company: { id: client.company.id },
        user: { id: companyUserId },
        action: 'client_portal_user.updated',
        entityType: 'client_portal_user',
        entityId: saved.id,
        beforeData,
        afterData: {
          email: saved.email,
          firstName: saved.firstName,
          lastName: saved.lastName,
          isActive: saved.isActive,
          role: saved.role,
        },
      });
      return saved;
    }

    if (existingByEmail) {
      throw new ConflictException('A client portal user already uses that email.');
    }

    if (![UserRole.CLIENT_ADMIN, UserRole.CLIENT_VIEWER].includes(dto.role)) {
      throw new BadRequestException('Client portal users must use a client role.');
    }

    const created = this.clientPortalUserRepo.create({
      client,
      email,
      passwordHash: await bcrypt.hash(dto.password, 10),
      firstName: dto.firstName.trim(),
      lastName: dto.lastName.trim(),
      isActive: dto.isActive ?? true,
      role: dto.role,
    });
    const saved = await this.clientPortalUserRepo.save(created);
    await this.auditLogService.log({
      company: { id: client.company.id },
      user: { id: companyUserId },
      action: 'client_portal_user.created',
      entityType: 'client_portal_user',
      entityId: saved.id,
      afterData: {
        clientId: client.id,
        email: saved.email,
        firstName: saved.firstName,
        lastName: saved.lastName,
        isActive: saved.isActive,
        role: saved.role,
      },
    });
    return saved;
  }

  async updateLastLogin(id: number) {
    await this.clientPortalUserRepo.update(id, { lastLoginAt: new Date() });
  }
}
