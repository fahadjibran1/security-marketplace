import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { EntityManager, Repository } from 'typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import { User, UserStatus } from './entities/user.entity';

@Injectable()
export class UserService {
  constructor(@InjectRepository(User) private readonly usersRepo: Repository<User>) {}

  async create(dto: CreateUserDto, manager?: EntityManager): Promise<User> {
    const repo = manager?.getRepository(User) ?? this.usersRepo;
    const existing = await repo.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = repo.create({
      email: dto.email,
      passwordHash,
      role: dto.role,
      status: dto.status ?? UserStatus.PENDING,
    });
    return repo.save(user);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email })
      .getOne();
  }

  async findById(id: number): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateLastLogin(id: number): Promise<void> {
    await this.usersRepo.update(id, {
      lastLoginAt: new Date(),
    });
  }

  /**
   * The account a recovery request (password reset, verification resend) refers to. An exact match
   * wins; otherwise a case-insensitive match is used only when it is unambiguous. Deleted accounts are
   * never returned — their address has already been replaced, but this makes it explicit.
   */
  async findForRecovery(email: string): Promise<User | null> {
    const trimmed = email.trim();
    if (!trimmed) return null;
    const exact = await this.usersRepo.findOne({ where: { email: trimmed } });
    if (exact) return exact.deletionCompletedAt ? null : exact;
    const folded = await this.usersRepo
      .createQueryBuilder('user')
      .where('LOWER(user.email) = LOWER(:email)', { email: trimmed })
      .andWhere('user.deletionCompletedAt IS NULL')
      .limit(2)
      .getMany();
    return folded.length === 1 ? folded[0] : null;
  }

  async updateStatus(id: number, status: UserStatus): Promise<void> {
    // A deleted account is anonymised for good: no path may re-activate it.
    await this.usersRepo
      .createQueryBuilder()
      .update(User)
      .set({ status })
      .where('id = :id', { id })
      .andWhere('"deletionCompletedAt" IS NULL')
      .execute();
  }
}
