import { CoveragePhase, CoverageState, PositionCounts } from './rota-slot-coverage';

// ── Slot responses ────────────────────────────────────────────────────────────

export interface PositionSummary {
  shiftId: number;
  guardId: number | null;
  guardName: string | null;
  status: string;
}

export interface RotaSlotSummary {
  id: number;
  siteId: number;
  siteName: string;
  clientId: number | null;
  clientName: string | null;
  jobId: number | null;
  title: string | null;
  startAt: string;
  endAt: string;
  requiredGuardCount: number;
  checkCallIntervalMinutes: number;
  instructions: string | null;
  status: string;
  coveragePhase: CoveragePhase;
  coverageState: CoverageState;
  counts: PositionCounts;
  createdAt: string;
  updatedAt: string;
}

export interface RotaSlotDetail extends RotaSlotSummary {
  positions: PositionSummary[];
}

export interface ChangeRequirementResponse {
  slot: RotaSlotSummary;
  addedShiftIds: number[];
  cancelledShiftIds: number[];
}

// ── Week response ─────────────────────────────────────────────────────────────

export interface SlotCell {
  slotId: number;
  title: string | null;
  startAt: string;
  endAt: string;
  isNightShift: boolean;
  coveragePhase: CoveragePhase;
  coverageState: CoverageState;
  counts: PositionCounts;
  positions: PositionSummary[];
}

export interface DayCells {
  slots: SlotCell[];
}

export interface SiteWeekRow {
  siteId: number;
  siteName: string;
  clientId: number | null;
  clientName: string | null;
  days: {
    monday: DayCells;
    tuesday: DayCells;
    wednesday: DayCells;
    thursday: DayCells;
    friday: DayCells;
    saturday: DayCells;
    sunday: DayCells;
  };
}

export interface WeekSnapshot {
  totalSlots: number;
  totalPositions: number;
  futureConfirmed: number;
  offeredPending: number;
  openPositions: number;
  onShiftNow: number;
  completedPositions: number;
  missedPositions: number;
  problems: number;
  sitesFullyCovered: number;
  sitesNeedAttention: number;
  nightSlots: number;
}

export interface WeekResponse {
  weekCommencing: string;
  weekEnding: string;
  snapshot: WeekSnapshot;
  sites: SiteWeekRow[];
}
