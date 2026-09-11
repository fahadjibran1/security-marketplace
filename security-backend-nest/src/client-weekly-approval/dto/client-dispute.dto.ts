import { IsArray, IsInt, IsNotEmpty, IsPositive, IsString, ArrayMinSize, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class DisputeItemDto {
  @IsInt()
  @IsPositive()
  timesheetId!: number;

  @IsString()
  @IsNotEmpty()
  disputeReason!: string;
}

export class ClientDisputeDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DisputeItemDto)
  disputes!: DisputeItemDto[];
}
