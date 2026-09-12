import { IsISO8601, IsInt, IsNotEmpty, IsPositive, IsString } from 'class-validator';

export class ReviseApprovedTimeDto {
  @IsInt()
  @IsPositive()
  timesheetId!: number;

  @IsISO8601()
  @IsNotEmpty()
  newBillingStartAt!: string;

  @IsISO8601()
  @IsNotEmpty()
  newBillingEndAt!: string;

  @IsString()
  @IsNotEmpty()
  clientCorrectionReason!: string;
}
