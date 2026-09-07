export class BankDetailsGuardResponseDto {
  guardId!: number;
  bankSet!: boolean;
  accountHolderNameMasked!: string | null;
  sortCodeMasked!: string | null;
  accountNumberMasked!: string | null;
  updatedAt!: string | null;
}
