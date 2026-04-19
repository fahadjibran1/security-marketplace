import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import {
  Notification,
  NotificationStatus,
  NotificationType,
} from './entities/notification.entity';
import { CompanyService } from '../company/company.service';

type NotificationInput = {
  userId: number;
  company?: { id: number } | null;
  type: NotificationType;
  title: string;
  message: string;
  sentAt?: Date | null;
};

@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    private readonly companyService: CompanyService,
  ) {}

  createForUser(input: NotificationInput): Promise<Notification> {
    const notification = this.notificationRepo.create({
      user: { id: input.userId } as Notification['user'],
      company: input.company ?? null,
      type: input.type,
      title: input.title,
      message: input.message,
      status: NotificationStatus.UNREAD,
      sentAt: input.sentAt ?? new Date(),
    });

    return this.notificationRepo.save(notification);
  }

  async createForUserUnlessRecentDuplicate(
    input: NotificationInput,
    recentMinutes = 240,
  ): Promise<Notification | null> {
    const threshold = new Date(Date.now() - recentMinutes * 60 * 1000);
    const existing = await this.notificationRepo.findOne({
      where: {
        user: { id: input.userId },
        company: input.company?.id ? { id: input.company.id } : undefined,
        type: input.type,
        title: input.title,
        message: input.message,
        createdAt: MoreThanOrEqual(threshold),
      },
      order: { createdAt: 'DESC' },
    });

    if (existing) return existing;
    return this.createForUser(input);
  }

  findMine(userId: number): Promise<Notification[]> {
    return this.notificationRepo.find({
      where: { user: { id: userId } },
      order: { createdAt: 'DESC' },
    });
  }

  async findForCompany(userId: number): Promise<Notification[]> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    return this.notificationRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async markRead(userId: number, notificationId: number): Promise<Notification> {
    const notification = await this.notificationRepo.findOne({
      where: { id: notificationId, user: { id: userId } },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    notification.status = NotificationStatus.READ;
    notification.readAt = new Date();
    return this.notificationRepo.save(notification);
  }
}
