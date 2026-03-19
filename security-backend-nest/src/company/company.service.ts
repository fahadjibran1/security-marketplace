import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Company } from './entities/company.entity';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { UserService } from '../user/user.service';

@Injectable()
export class CompanyService {
  constructor(
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    private readonly userService: UserService
  ) {}

  async create(dto: CreateCompanyDto): Promise<Company> {
    const user = await this.userService.findById(dto.userId);
    const company = this.companyRepo.create({ ...dto, user });
    return this.companyRepo.save(company);
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
