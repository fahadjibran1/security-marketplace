import { IsArray, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateInvoiceBatchDto {
  @IsInt()
  @Min(1)
  clientId!: number;

  @IsString()
  periodStart!: string;

  @IsString()
  periodEnd!: string;

  @IsOptional()
  @IsString()
  invoiceReference?: string | null;

  @IsOptional()
  @IsString()
  notes?: string | null;

  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  timesheetIds!: number[];
}
