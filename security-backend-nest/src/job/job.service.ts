import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from './entities/job.entity';
import { CreateJobDto } from './dto/create-job.dto';
import { CompanyService } from '../company/company.service';
import { SiteService } from '../site/site.service';

@Injectable()
export class JobService {
  constructor(
    @InjectRepository(Job) private readonly jobRepo: Repository<Job>,
    private readonly companyService: CompanyService,
    private readonly siteService: SiteService,
  ) {}

  async create(dto: CreateJobDto): Promise<Job> {
    const company = await this.companyService.findOne(dto.companyId);
    const site = dto.siteId ? await this.siteService.findOne(dto.siteId) : null;
    const job = this.jobRepo.create({
      company,
      site,
      title: dto.title,
      description: dto.description,
      guardsRequired: dto.guardsRequired,
      hourlyRate: dto.hourlyRate,
      status: dto.status ?? 'open'
    });
    return this.jobRepo.save(job);
  }

  findAll(): Promise<Job[]> {
    return this.jobRepo.find();
  }

  async findOne(id: number): Promise<Job> {
    const job = await this.jobRepo.findOne({ where: { id } });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }
}
