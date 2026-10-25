import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExpoPushClient } from '../welfare-push/expo-push.client';
import { GuardNotificationDispatch } from './entities/guard-notification-dispatch.entity';
import { GuardNotificationService } from './guard-notification.service';

/**
 * Guard shift notifications (in-app notice + OS push). Depends only on the database and the stateless Expo client, so
 * the shift, rota and amendment modules can all import it without a cycle.
 */
@Module({
  imports: [TypeOrmModule.forFeature([GuardNotificationDispatch])],
  providers: [GuardNotificationService, ExpoPushClient],
  exports: [GuardNotificationService],
})
export class GuardNotificationModule {}
