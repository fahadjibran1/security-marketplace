import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Company } from './entities/company.entity';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { UserService } from '../user/user.service';
import { User } from '../user/entities/user.entity';

@Injectable()
export class CompanyService {
  constructor(
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    private readonly userService: UserService
  ) {}

  async create(dto: CreateCompanyDto, manager?: EntityManager): Promise<Company> {
    const repo = manager?.getRepository(Company) ?? this.companyRepo;
    const user = manager
      ? await manager.getRepository(User).findOne({ where: { id: dto.userId } })
      : await this.userService.findById(dto.userId);
    if (!user) throw new NotFoundException('User not found');
    const company = repo.create({ ...dto, user });
    return repo.save(company);
  }

  findAll(): Promise<Company[]> {
    return this.companyRepo.find();
  }

  async findOne(id: number): Promise<Company> {
    const company = await this.companyRepo.findOne({ where: { id } });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  async findByUserId(userId: number): Promise<Company | null> {
    return this.companyRepo.findOne({ where: { user: { id: userId } } });
  }

  async updateByUserId(userId: number, dto: UpdateCompanyDto): Promise<Company> {
    const company = await this.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    Object.assign(company, dto);
    return this.companyRepo.save(company);
  }
}
