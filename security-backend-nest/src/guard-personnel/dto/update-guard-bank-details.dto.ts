import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateGuardBankDetailsDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  accountHolderName?: string;

  @IsOptional()
  @IsString()
  sortCode?: string;

  @IsOptional()
  @IsString()
  accountNumber?: string;

  // Required when any bank field changes on an existing complete record.
  @IsOptional()
  @IsBoolean()
  confirmReplace?: boolean;
}
