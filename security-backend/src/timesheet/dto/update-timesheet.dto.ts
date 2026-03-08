import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateTimesheetDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  hoursWorked?: number;

  @IsOptional()
  @IsString()
  approvalStatus?: string;
}
