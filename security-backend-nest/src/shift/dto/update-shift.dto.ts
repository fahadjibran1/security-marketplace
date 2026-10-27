import { PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateShiftDto } from './create-shift.dto';

export class UpdateShiftDto extends PartialType(CreateShiftDto) {
  /**
   * Why the shift is being marked missed (owner decision, 27 Oct 2026). OPTIONAL, so a web release that sends only
   * `{ status: 'missed' }` keeps working; when given with a change to missed it is recorded in the audit
   * (`shift.marked_missed`) in the same transaction. Ignored for any other change.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
