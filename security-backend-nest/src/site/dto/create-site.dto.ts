import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateSiteDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  clientName?: string;

  @IsString()
  address!: string;

  @IsOptional()
  @IsString()
  contactDetails?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsInt()
  @Min(15)
  welfareCheckIntervalMinutes?: number;
}
