import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GuardProfile } from './entities/guard-profile.entity';
import { CreateGuardProfileDto } from './dto/create-guard-profile.dto';
import { UpdateGuardProfileDto } from './dto/update-guard-profile.dto';
import { UserService } from '../user/user.service';

@Injectable()
export class GuardProfileService {
  constructor(
    @InjectRepository(GuardProfile) private readonly guardRepo: Repository<GuardProfile>,
    private readonly userService: UserService
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

  async findByUserId(userId: number): Promise<GuardProfile | null> {
    return this.guardRepo.findOne({ where: { user: { id: userId } } });
  }

  async updateByUserId(userId: number, dto: UpdateGuardProfileDto): Promise<GuardProfile> {
    const guard = await this.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    Object.assign(guard, dto);
    return this.guardRepo.save(guard);
  }
}
