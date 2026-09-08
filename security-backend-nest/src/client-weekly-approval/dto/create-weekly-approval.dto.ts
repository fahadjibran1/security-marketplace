import { IsArray, IsDateString, IsInt, IsOptional, IsPositive, IsString, ArrayMinSize } from 'class-validator';

export class CreateWeeklyApprovalDto {
  @IsInt()
  @IsPositive()
  clientId!: number;

  @IsInt()
  @IsPositive()
  siteId!: number;

  @IsDateString()
  weekCommencing!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  timesheetIds!: number[];

  @IsOptional()
  @IsString()
  companyInternalNote?: string;

  @IsOptional()
  @IsString()
  clientSubmissionNote?: string;
}
