import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateRotaSlotMetadataDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string | null;

  @IsOptional()
  @IsString()
  instructions?: string | null;
}
