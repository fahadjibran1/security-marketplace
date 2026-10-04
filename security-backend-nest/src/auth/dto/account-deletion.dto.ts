import { IsString, MaxLength, MinLength } from 'class-validator';

export class ConfirmAccountDeletionDto {
  /** The current password, re-entered so an unattended or stolen session cannot delete the account. */
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;
}
