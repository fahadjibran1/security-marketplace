import { Type } from 'class-transformer';
import { IsInt } from 'class-validator';

export class CreateJobApplicationDto {
  @Type(() => Number)
  @IsInt()
  jobId!: number;
}
