import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TransactionalEmailService } from './transactional-email.service';

@Module({
  imports: [ConfigModule],
  providers: [TransactionalEmailService],
  exports: [TransactionalEmailService],
})
export class EmailModule {}
