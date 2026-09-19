import { Shift } from '../shift/entities/shift.entity';
import { Site } from '../site/entities/site.entity';
import { RotaSlot } from './entities/rota-slot.entity';
import {
  computeCounts,
  isNightShift,
  toCoveragePhase,
  toCoverageState,
} from './rota-slot-coverage';
import {
  PositionSummary,
  RotaSlotDetail,
  RotaSlotSummary,
  SlotCell,
} from './rota-slot.responses';

export function toPositionSummary(shift: Shift): PositionSummary {
  return {
    shiftId: shift.id,
    guardId: shift.guard?.id ?? null,
    guardName: shift.guard?.fullName ?? null,
    status: shift.status,
  };
}

/**
 * Extracts a site reference from the slot's loaded site relation.
 * Slots must be loaded with `relations: ['site']` (Site.client is always
 * eager-loaded so it comes along automatically).
 */
function extractSite(slot: RotaSlot, siteOverride?: Site) {
  const site = siteOverride ?? slot.site;
  if (!site) return { siteName: `Site ${slot.siteId}`, clientId: null, clientName: null };
  return {
    siteName: site.name,
    clientId: site.client?.id ?? null,
    clientName: site.client?.name ?? null,
  };
}

export function toSlotSummary(
  slot: RotaSlot,
  shifts: Shift[],
  now = new Date(),
  siteOverride?: Site,
): RotaSlotSummary {
  const phase = toCoveragePhase(slot, now);
  const state = toCoverageState(slot, shifts, phase);
  const counts = computeCounts(slot, shifts);
  const { siteName, clientId, clientName } = extractSite(slot, siteOverride);

  return {
    id: slot.id,
    siteId: slot.siteId,
    siteName,
    clientId,
    clientName,
    jobId: slot.jobId ?? null,
    title: slot.title ?? null,
    startAt: slot.startAt.toISOString(),
    endAt: slot.endAt.toISOString(),
    requiredGuardCount: slot.requiredGuardCount,
    checkCallIntervalMinutes: slot.checkCallIntervalMinutes,
    instructions: slot.instructions ?? null,
    status: slot.status,
    coveragePhase: phase,
    coverageState: state,
    counts,
    createdAt: slot.createdAt.toISOString(),
    updatedAt: slot.updatedAt.toISOString(),
  };
}

export function toSlotDetail(
  slot: RotaSlot,
  shifts: Shift[],
  now = new Date(),
  siteOverride?: Site,
): RotaSlotDetail {
  return {
    ...toSlotSummary(slot, shifts, now, siteOverride),
    positions: shifts.map(toPositionSummary),
  };
}

export function toSlotCell(
  slot: RotaSlot,
  shifts: Shift[],
  now = new Date(),
  siteOverride?: Site,
): SlotCell {
  const phase = toCoveragePhase(slot, now);
  const state = toCoverageState(slot, shifts, phase);
  const counts = computeCounts(slot, shifts);

  return {
    slotId: slot.id,
    title: slot.title ?? null,
    startAt: slot.startAt.toISOString(),
    endAt: slot.endAt.toISOString(),
    isNightShift: isNightShift(slot.startAt, slot.endAt),
    coveragePhase: phase,
    coverageState: state,
    counts,
    positions: shifts.map(toPositionSummary),
  };
}
