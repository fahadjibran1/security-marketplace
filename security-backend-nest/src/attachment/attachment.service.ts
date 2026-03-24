import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Attachment } from './entities/attachment.entity';
import { CreateAttachmentDto } from './dto/create-attachment.dto';
import { UserService } from '../user/user.service';
import { CompanyService } from '../company/company.service';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';

@Injectable()
export class AttachmentService {
  constructor(
    @InjectRepository(Attachment)
    private readonly attachmentRepo: Repository<Attachment>,
    private readonly userService: UserService,
    private readonly companyService: CompanyService,
  ) {}

  async createForUser(userId: number, dto: CreateAttachmentDto): Promise<Attachment> {
    const user = await this.userService.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    const company =
      user.role === UserRole.ADMIN ? null : await this.companyService.findByUserId(userId);

    const attachment = this.attachmentRepo.create({
      entityType: dto.entityType,
      entityId: dto.entityId,
      fileName: dto.fileName,
      fileUrl: dto.fileUrl,
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
      uploadedBy: user,
      company: company ?? null,
    });

    return this.attachmentRepo.save(attachment);
  }

  async findMine(userId: number): Promise<Attachment[]> {
    return this.attachmentRepo.find({
      where: { uploadedBy: { id: userId } },
      order: { createdAt: 'DESC' },
    });
  }

  async findForCompany(userId: number): Promise<Attachment[]> {
    const user = await this.userService.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    if (user.role === UserRole.ADMIN) {
      return this.attachmentRepo.find({ order: { createdAt: 'DESC' } });
    }

    if (!COMPANY_VIEW_ROLES.some((role) => role === user.role)) {
      throw new NotFoundException('Company access is not available for this user');
    }

    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    return this.attachmentRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
  }
}
