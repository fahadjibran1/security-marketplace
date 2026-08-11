import { BadRequestException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import { Site } from './entities/site.entity';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { CompanyService } from '../company/company.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ClientService } from '../client/client.service';
import { ShiftService } from '../shift/shift.service';

@Injectable()
export class SiteService {
  constructor(
    @InjectRepository(Site) private readonly siteRepo: Repository<Site>,
    private readonly companyService: CompanyService,
    private readonly auditLogService: AuditLogService,
    private readonly clientService: ClientService,
    @Inject(forwardRef(() => ShiftService))
    private readonly shiftService: ShiftService,
  ) {}

  findAll(): Promise<Site[]> {
    return this.siteRepo.find({ order: { name: 'ASC' } });
  }

  async findOne(id: number): Promise<Site> {
    const site = await this.siteRepo.findOne({ where: { id } });
    if (!site) throw new NotFoundException('Site not found');
    return site;
  }

  async findVerificationConfig(id: number): Promise<Site> {
    const site = await this.siteRepo
      .createQueryBuilder('site')
      .addSelect('site.attendanceNfcTag')
      .where('site.id = :id', { id })
      .getOne();
    if (!site) throw new NotFoundException('Site not found');
    return site;
  }

  async findOneForCompanyUser(userId: number, id: number): Promise<Site> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    const site = await this.siteRepo.findOne({ where: { id, company: { id: company.id } } });
    if (!site) throw new NotFoundException('Site not found');
    return site;
  }

  async findForCompanyUser(userId: number): Promise<Site[]> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    return this.siteRepo.find({ where: { company: { id: company.id } }, order: { name: 'ASC' } });
  }

  async createForCompanyUser(userId: number, dto: CreateSiteDto): Promise<Site> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    if (!dto.clientId) throw new BadRequestException('Site creation requires a clientId');
    this.validateVerificationSettings(dto);
    const client = await this.clientService.findOneForCompanyUser(userId, dto.clientId);

    const site = new Site();
    site.company = company;
    site.client = client;
    site.name = dto.name.trim();
    site.clientName = client.name;
    site.address = dto.address.trim();
    site.contactDetails = dto.contactDetails?.trim() || undefined;
    site.status = dto.status ?? 'active';
    site.requiredGuardCount = dto.requiredGuardCount ?? 1;
    site.operatingDays = dto.operatingDays?.trim() || null;
    site.operatingStartTime = dto.operatingStartTime?.trim() || null;
    site.operatingEndTime = dto.operatingEndTime?.trim() || null;
    site.welfareCheckIntervalMinutes = dto.welfareCheckIntervalMinutes ?? 60;
    site.specialInstructions = dto.specialInstructions?.trim() || null;
    site.latitude = dto.latitude ?? null;
    site.longitude = dto.longitude ?? null;
    site.geofenceRadiusMeters = dto.geofenceRadiusMeters ?? 150;
    site.requireGpsCheckIn = dto.requireGpsCheckIn ?? false;
    site.attendanceNfcTag = dto.attendanceNfcTag?.trim() ? this.hashNfcTag(dto.attendanceNfcTag) : null;
    site.requireNfcCheckIn = dto.requireNfcCheckIn ?? false;

    const saved = await this.siteRepo.save(site);
    if (dto.initialShiftDate?.trim() && dto.initialShiftStartTime?.trim()) {
      await this.shiftService.createStarterShiftForSite({
        companyId: company.id,
        siteId: saved.id,
        createdByUserId: userId,
        date: dto.initialShiftDate.trim(),
        startTime: dto.initialShiftStartTime.trim(),
        endTime: dto.initialShiftEndTime?.trim() || saved.operatingEndTime || undefined,
        instructions: saved.specialInstructions,
      });
    }
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'site.created',
      entityType: 'site',
      entityId: saved.id,
      afterData: {
        name: saved.name,
        clientName: saved.clientName,
        clientId: saved.client?.id ?? null,
        status: saved.status,
        requiredGuardCount: saved.requiredGuardCount,
        operatingDays: saved.operatingDays,
        operatingStartTime: saved.operatingStartTime,
        operatingEndTime: saved.operatingEndTime,
        welfareCheckIntervalMinutes: saved.welfareCheckIntervalMinutes,
        requireGpsCheckIn: saved.requireGpsCheckIn,
        geofenceRadiusMeters: saved.geofenceRadiusMeters,
        requireNfcCheckIn: saved.requireNfcCheckIn,
      },
    });
    return saved;
  }

  async updateForCompanyUser(userId: number, id: number, dto: UpdateSiteDto): Promise<Site> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const site = await this.siteRepo
      .createQueryBuilder('site')
      .leftJoinAndSelect('site.client', 'client')
      .addSelect('site.attendanceNfcTag')
      .where('site.id = :id', { id })
      .andWhere('site.companyId = :companyId', { companyId: company.id })
      .getOne();
    if (!site) throw new NotFoundException('Site not found');

    const nextConfig = {
      latitude: dto.latitude !== undefined ? dto.latitude : site.latitude,
      longitude: dto.longitude !== undefined ? dto.longitude : site.longitude,
      requireGpsCheckIn: dto.requireGpsCheckIn !== undefined ? dto.requireGpsCheckIn : site.requireGpsCheckIn,
      attendanceNfcTag: dto.attendanceNfcTag !== undefined ? dto.attendanceNfcTag : site.attendanceNfcTag,
      requireNfcCheckIn: dto.requireNfcCheckIn !== undefined ? dto.requireNfcCheckIn : site.requireNfcCheckIn,
    };
    this.validateVerificationSettings(nextConfig);

    const beforeData = {
      name: site.name,
      clientName: site.clientName,
      clientId: site.client?.id ?? null,
      address: site.address,
      contactDetails: site.contactDetails,
      status: site.status,
      requiredGuardCount: site.requiredGuardCount,
      operatingDays: site.operatingDays,
      operatingStartTime: site.operatingStartTime,
      operatingEndTime: site.operatingEndTime,
      welfareCheckIntervalMinutes: site.welfareCheckIntervalMinutes,
      specialInstructions: site.specialInstructions,
      latitude: site.latitude,
      longitude: site.longitude,
      geofenceRadiusMeters: site.geofenceRadiusMeters,
      requireGpsCheckIn: site.requireGpsCheckIn,
      requireNfcCheckIn: site.requireNfcCheckIn,
    };

    const client =
      dto.clientId === undefined
        ? site.client ?? null
        : dto.clientId
          ? await this.clientService.findOneForCompanyUser(userId, dto.clientId)
          : null;

    Object.assign(site, dto);
    site.client = client;
    site.name = dto.name?.trim() ?? site.name;
    site.clientName = client?.name ?? site.clientName ?? undefined;
    site.address = dto.address?.trim() ?? site.address;
    if (dto.contactDetails !== undefined) site.contactDetails = dto.contactDetails?.trim() || undefined;
    if (dto.operatingDays !== undefined) site.operatingDays = dto.operatingDays?.trim() || null;
    if (dto.operatingStartTime !== undefined) site.operatingStartTime = dto.operatingStartTime?.trim() || null;
    if (dto.operatingEndTime !== undefined) site.operatingEndTime = dto.operatingEndTime?.trim() || null;
    if (dto.specialInstructions !== undefined) site.specialInstructions = dto.specialInstructions?.trim() || null;
    if (dto.attendanceNfcTag !== undefined) {
      site.attendanceNfcTag = dto.attendanceNfcTag?.trim() ? this.hashNfcTag(dto.attendanceNfcTag) : null;
    }

    const saved = await this.siteRepo.save(site);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'site.updated',
      entityType: 'site',
      entityId: saved.id,
      beforeData,
      afterData: {
        name: saved.name,
        clientName: saved.clientName,
        clientId: saved.client?.id ?? null,
        address: saved.address,
        contactDetails: saved.contactDetails,
        status: saved.status,
        requiredGuardCount: saved.requiredGuardCount,
        operatingDays: saved.operatingDays,
        operatingStartTime: saved.operatingStartTime,
        operatingEndTime: saved.operatingEndTime,
        welfareCheckIntervalMinutes: saved.welfareCheckIntervalMinutes,
        specialInstructions: saved.specialInstructions,
        latitude: saved.latitude,
        longitude: saved.longitude,
        geofenceRadiusMeters: saved.geofenceRadiusMeters,
        requireGpsCheckIn: saved.requireGpsCheckIn,
        requireNfcCheckIn: saved.requireNfcCheckIn,
      },
    });
    return saved;
  }

  private validateVerificationSettings(input: {
    latitude?: number | null;
    longitude?: number | null;
    requireGpsCheckIn?: boolean;
    attendanceNfcTag?: string | null;
    requireNfcCheckIn?: boolean;
  }) {
    if (input.requireGpsCheckIn && (input.latitude == null || input.longitude == null)) {
      throw new BadRequestException('GPS check-in requires site latitude and longitude');
    }
    if (input.requireNfcCheckIn && !input.attendanceNfcTag?.trim()) {
      throw new BadRequestException('NFC check-in requires an attendance NFC tag');
    }
  }

  private hashNfcTag(value: string) {
    return createHash('sha256').update(value.trim(), 'utf8').digest('hex');
  }
}
