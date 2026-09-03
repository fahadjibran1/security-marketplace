import { IsIn } from 'class-validator';

export class RevealFieldDto {
  @IsIn(['nino', 'utr'])
  field!: 'nino' | 'utr';
}

export class RevealResponseDto {
  field!: 'nino' | 'utr';
  maskedValue!: string | null;
  revealedValue!: string | null;
}
