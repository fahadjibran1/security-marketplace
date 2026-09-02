export class GuardIdentityGuardResponseDto {
  guardId!: number;
  ninoSet!: boolean;
  ninoMasked!: string | null;
  utrSet!: boolean;
  utrMasked!: string | null;
}
