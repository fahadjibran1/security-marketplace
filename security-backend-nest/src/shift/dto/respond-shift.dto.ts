import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class RespondShiftDto {
  @IsString()
  @IsIn(['accepted', 'rejected'])
  response!: 'accepted' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
