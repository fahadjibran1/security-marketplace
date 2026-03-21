import { IsDateString, IsInt, IsOptional, IsString } from 'class-validator';

export class CreateShiftDto {
  @IsInt()
  assignmentId!: number;

  @IsOptional()
  @IsInt()
  siteId?: number;

  @IsOptional()
  @IsString()
  siteName?: string;

  @IsDateString()
  start!: string;

  @IsDateString()
  end!: string;

  @IsOptional()
  @IsString()
  status?: string;
}
