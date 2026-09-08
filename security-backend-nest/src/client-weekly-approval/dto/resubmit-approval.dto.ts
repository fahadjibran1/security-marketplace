import { IsArray, IsInt, IsOptional, IsPositive, IsString, ArrayMinSize } from 'class-validator';

export class ResubmitApprovalDto {
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
