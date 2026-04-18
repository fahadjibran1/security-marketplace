import { IsArray, IsInt, IsString, Min } from 'class-validator';

export class UpdateTimesheetPayrollDto {
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids!: number[];

  @IsString()
  payrollStatus!: string;
}
