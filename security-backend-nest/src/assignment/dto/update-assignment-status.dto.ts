import { IsString } from 'class-validator';

export class UpdateAssignmentStatusDto {
  @IsString()
  status!: string;
}
