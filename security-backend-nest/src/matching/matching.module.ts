import { Module } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { JobMatchModule } from '../job-match/job-match.module';

@Module({
  imports: [JobMatchModule],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
