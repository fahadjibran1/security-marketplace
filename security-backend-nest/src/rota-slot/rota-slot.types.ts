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
  /** S4 1.3.0 B2: written to every position created (NULL / 'site_default' = the site decides). */
  patrolRequirement?: 'required' | 'not_required' | 'site_default' | null;
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
