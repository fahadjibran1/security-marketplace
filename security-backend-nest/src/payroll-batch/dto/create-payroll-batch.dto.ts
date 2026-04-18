import { IsArray, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreatePayrollBatchDto {
  @IsString()
  periodStart!: string;

  @IsString()
  periodEnd!: string;

  @IsOptional()
  @IsString()
  notes?: string | null;

  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  timesheetIds!: number[];
}
