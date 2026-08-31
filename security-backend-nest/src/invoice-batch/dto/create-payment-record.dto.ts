import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

import { PaymentMethod } from '../../payment-record/entities/payment-record.entity';

export class CreatePaymentRecordDto {
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsString()
  paymentDate!: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsOptional()
  @IsString()
  reference?: string | null;

  @IsOptional()
  @IsString()
  notes?: string | null;
}
