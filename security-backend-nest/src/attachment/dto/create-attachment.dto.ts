import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  IsUrl,
} from 'class-validator';
import { AttachmentEntityType } from '../entities/attachment.entity';

export class CreateAttachmentDto {
  @IsEnum(AttachmentEntityType)
  entityType!: AttachmentEntityType;

  @IsInt()
  @IsPositive()
  entityId!: number;

  @IsString()
  @IsNotEmpty()
  fileName!: string;

  @IsUrl()
  fileUrl!: string;

  @IsString()
  @IsNotEmpty()
  mimeType!: string;

  @IsInt()
  @IsPositive()
  sizeBytes!: number;
}
