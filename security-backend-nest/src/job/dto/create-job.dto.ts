import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateJobDto {
  @IsInt()
  companyId!: number;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @Min(1)
  guardsRequired!: number;

  @IsNumber()
  @Min(0)
  hourlyRate!: number;

  @IsOptional()
  @IsString()
  status?: string;
}
