import { IsBoolean } from 'class-validator';

export class VerifyGuardDocumentDto {
  @IsBoolean()
  verified!: boolean;
}
