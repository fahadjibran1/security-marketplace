import { DrivingTransportGuardResponseDto } from './driving-transport-guard-response.dto';

export class DrivingTransportAdminResponseDto extends DrivingTransportGuardResponseDto {
  canReveal!: boolean;
}
