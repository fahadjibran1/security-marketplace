export class RevealFieldDto {
  field!: 'nino' | 'utr';
}

export class RevealResponseDto {
  field!: 'nino' | 'utr';
  maskedValue!: string | null;
  revealedValue!: string | null;
}
