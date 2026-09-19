import { Shift } from '../shift/entities/shift.entity';
import { RotaSlot } from './entities/rota-slot.entity';

export interface ListSlotsQuery {
  from?: string;
  to?: string;
  siteId?: number;
  clientId?: number;
  status?: string;
}

export interface SlotWithShifts {
  slot: RotaSlot;
  shifts: Shift[];
}

export interface CreateSlotInput {
  siteId: number;
  startAt: string;
  endAt: string;
  requiredGuardCount?: number;
  checkCallIntervalMinutes?: number;
  instructions?: string | null;
  title?: string | null;
  jobId?: number | null;
}

export interface ChangeRequirementResult {
  slot: RotaSlot;
  addedShiftIds: number[];
  cancelledShiftIds: number[];
}

export interface AssignPositionInput {
  shiftId: number;
  guardId: number;
}

export interface AssignMultipleResult {
  assigned: Array<{ shiftId: number; guardId: number }>;
  failed: Array<{ shiftId: number; guardId: number; reason: string }>;
}
