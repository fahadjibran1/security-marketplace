import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Site } from './entities/site.entity';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { CompanyService } from '../company/company.service';

@Injectable()
export class SiteService {
  constructor(
    @InjectRepository(Site) private readonly siteRepo: Repository<Site>,
    private readonly companyService: CompanyService,
  ) {}

  findAll(): Promise<Site[]> {
    return this.siteRepo.find({ order: { name: 'ASC' } });
  }

  async findOne(id: number): Promise<Site> {
    const site = await this.siteRepo.findOne({ where: { id } });
    if (!site) throw new NotFoundException('Site not found');
    return site;
  }

  async findForCompanyUser(userId: number): Promise<Site[]> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    return this.siteRepo.find({
      where: { company: { id: company.id } },
      order: { name: 'ASC' },
    });
  }

  async createForCompanyUser(userId: number, dto: CreateSiteDto): Promise<Site> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const site = this.siteRepo.create({
      company,
      name: dto.name,
      clientName: dto.clientName,
      address: dto.address,
      contactDetails: dto.contactDetails,
      status: dto.status ?? 'active',
      welfareCheckIntervalMinutes: dto.welfareCheckIntervalMinutes ?? 60,
    });

    return this.siteRepo.save(site);
  }

  async updateForCompanyUser(userId: number, id: number, dto: UpdateSiteDto): Promise<Site> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const site = await this.siteRepo.findOne({
      where: { id, company: { id: company.id } },
    });
    if (!site) throw new NotFoundException('Site not found');

    Object.assign(site, dto);
    return this.siteRepo.save(site);
  }
}
