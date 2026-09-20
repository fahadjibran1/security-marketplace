import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, MoreThan, Repository } from 'typeorm';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { Shift } from '../shift/entities/shift.entity';
import { Site } from '../site/entities/site.entity';
import { RotaSlot } from './entities/rota-slot.entity';
import {
  computeCounts,
  isNightShift,
  toCoveragePhase,
  toCoverageState,
} from './rota-slot-coverage';
import { toSlotCell } from './rota-slot.mapper';
import {
  DayCells,
  SiteWeekRow,
  SlotCell,
  WeekResponse,
  WeekSnapshot,
} from './rota-slot.responses';

const DAY_NAMES = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
] as const;
type DayName = (typeof DAY_NAMES)[number];

function toMondayFirstDayIndex(utcDay: number): number {
  // UTC: 0=Sun, 1=Mon, ..., 6=Sat → 0=Mon, ..., 6=Sun
  return (utcDay + 6) % 7;
}

function parseWeekCommencing(weekCommencing: string): { weekStart: Date; weekEnd: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekCommencing)) {
    throw new BadRequestException('weekCommencing must be YYYY-MM-DD');
  }
  const d = new Date(weekCommencing + 'T00:00:00Z');
  if (isNaN(d.getTime())) {
    throw new BadRequestException('weekCommencing is not a valid date');
  }
  if (d.getUTCDay() !== 1) {
    throw new BadRequestException(
      `weekCommencing must be a Monday — ${weekCommencing} is a ${
        ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()]
      }`,
    );
  }
  return {
    weekStart: d,
    weekEnd: new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000),
  };
}

function emptyDays(): SiteWeekRow['days'] {
  const empty: DayCells = { slots: [] };
  return {
    monday: { slots: [] },
    tuesday: { slots: [] },
    wednesday: { slots: [] },
    thursday: { slots: [] },
    friday: { slots: [] },
    saturday: { slots: [] },
    sunday: { slots: [] },
  };
}

@Injectable()
export class RotaWeekService {
  constructor(
    @InjectRepository(RotaSlot) private readonly slotRepo: Repository<RotaSlot>,
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(Site) private readonly siteRepo: Repository<Site>,
    private readonly membershipService: CompanyMembershipService,
  ) {}

  async getWeek(user: JwtPayload, query: {
    weekCommencing: string;
    clientId?: number;
    siteIds?: string;
    status?: string;
  }): Promise<WeekResponse> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_VIEW,
    );

    const { weekStart, weekEnd } = parseWeekCommencing(query.weekCommencing);
    const now = new Date();

    // Query 1: All active Sites for this company (filtered by clientId/siteIds if supplied)
    const siteWhere: any = { company: { id: company.id }, status: 'active' };
    const requestedSiteIds = query.siteIds
      ? query.siteIds.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
      : null;

    const allSites = await this.siteRepo.find({
      where: siteWhere,
      order: { name: 'ASC' },
    });

    // Post-filter by clientId (site.client is eager-loaded)
    const sites = allSites
      .filter((s) => !query.clientId || s.client?.id === query.clientId)
      .filter((s) => !requestedSiteIds || requestedSiteIds.includes(s.id));

    const siteIds = sites.map((s) => s.id);
    const siteMap = new Map(sites.map((s) => [s.id, s]));

    // Query 2: All RotaSlots overlapping the week window for these sites
    const slotWhere: any = {
      companyId: company.id,
      startAt: LessThan(weekEnd),
      endAt: MoreThan(weekStart),
    };
    if (requestedSiteIds) slotWhere.siteId = In(siteIds);
    if (query.status) slotWhere.status = query.status;

    const slots = await this.slotRepo.find({
      where: slotWhere,
      order: { startAt: 'ASC' },
    });

    // Filter to requested sites if clientId/siteIds filter applied
    const filteredSlots = siteIds.length > 0
      ? slots.filter((sl) => siteIds.includes(sl.siteId))
      : slots;

    // Query 3: All Shifts for the loaded RotaSlots
    const slotIdList = filteredSlots.map((s) => s.id);
    const allShifts = slotIdList.length > 0
      ? await this.shiftRepo.find({ where: { rotaSlotId: In(slotIdList) } })
      : [];

    const shiftsBySlotId = new Map<number, Shift[]>();
    for (const shift of allShifts) {
      if (shift.rotaSlotId == null) continue;
      const arr = shiftsBySlotId.get(shift.rotaSlotId) ?? [];
      arr.push(shift);
      shiftsBySlotId.set(shift.rotaSlotId, arr);
    }

    // Build site rows (all active sites, even those with no slots)
    const siteRowMap = new Map<number, SiteWeekRow>();
    for (const site of sites) {
      siteRowMap.set(site.id, {
        siteId: site.id,
        siteName: site.name,
        clientId: site.client?.id ?? null,
        clientName: site.client?.name ?? null,
        days: emptyDays(),
      });
    }

    // Place slots into day cells
    for (const slot of filteredSlots) {
      const site = siteMap.get(slot.siteId);
      const shifts = shiftsBySlotId.get(slot.id) ?? [];
      const cell = toSlotCell(slot, shifts, now, site);

      // Determine which day(s) the slot belongs to.
      // A slot belongs to the day its startAt falls on within the week.
      const slotDayIdx = toMondayFirstDayIndex(slot.startAt.getUTCDay());
      const dayName = DAY_NAMES[slotDayIdx];

      let row = siteRowMap.get(slot.siteId);
      if (!row) {
        // Site not in the initial site list (shouldn't happen after filtering, but be safe)
        row = {
          siteId: slot.siteId,
          siteName: site?.name ?? `Site ${slot.siteId}`,
          clientId: site?.client?.id ?? null,
          clientName: site?.client?.name ?? null,
          days: emptyDays(),
        };
        siteRowMap.set(slot.siteId, row);
      }

      row.days[dayName].slots.push(cell);
    }

    // Build snapshot
    const snapshot = this.buildSnapshot(filteredSlots, shiftsBySlotId, sites, siteRowMap, now);

    return {
      weekCommencing: weekStart.toISOString().slice(0, 10),
      weekEnding: new Date(weekEnd.getTime() - 1).toISOString().slice(0, 10),
      snapshot,
      sites: Array.from(siteRowMap.values()),
    };
  }

  private buildSnapshot(
    slots: RotaSlot[],
    shiftsBySlotId: Map<number, Shift[]>,
    sites: Site[],
    siteRowMap: Map<number, SiteWeekRow>,
    now: Date,
  ): WeekSnapshot {
    let totalPositions = 0;
    let futureConfirmed = 0;
    let offeredPending = 0;
    let openPositions = 0;
    let onShiftNow = 0;
    let completedPositions = 0;
    let missedPositions = 0;
    let problems = 0;
    let nightSlots = 0;

    const sitesWithProblems = new Set<number>();

    for (const slot of slots) {
      const shifts = shiftsBySlotId.get(slot.id) ?? [];
      const phase = toCoveragePhase(slot, now);
      const counts = computeCounts(slot, shifts);

      const state = toCoverageState(slot, shifts, phase);
      // A slot has an active operational problem only when its coverage state is
      // degraded — historical rejected/missed records on a slot that already has
      // replacement cover must not permanently mark it as problematic.
      const hasActiveProblem = [
        'has_problems', 'live_has_problems',
        'outcome_shortfall', 'outcome_failed', 'outcome_has_problems',
      ].includes(state);

      totalPositions += counts.required;
      onShiftNow += counts.onShift;
      completedPositions += counts.completed;
      missedPositions += shifts.filter((s) => s.status === 'missed').length;
      problems += hasActiveProblem ? counts.problem : 0;

      if (phase === 'future') {
        futureConfirmed += counts.confirmed;
        offeredPending += counts.offered;
        openPositions += counts.open;
      } else if (phase === 'live') {
        openPositions += counts.open + counts.offered; // pending check-in counts as open in live context
      }

      if (isNightShift(slot.startAt, slot.endAt)) nightSlots++;

      if (counts.open > 0 || hasActiveProblem) {
        sitesWithProblems.add(slot.siteId);
      }
    }

    const sitesWithSlots = new Set(slots.map((s) => s.siteId));
    // Sites with no slots at all also need attention (no cover planned)
    for (const site of sites) {
      if (!sitesWithSlots.has(site.id)) {
        sitesWithProblems.add(site.id);
      }
    }

    const sitesFullyCovered = sites.filter((s) => !sitesWithProblems.has(s.id)).length;
    const sitesNeedAttention = sitesWithProblems.size;

    return {
      totalSlots: slots.length,
      totalPositions,
      futureConfirmed,
      offeredPending,
      openPositions,
      onShiftNow,
      completedPositions,
      missedPositions,
      problems,
      sitesFullyCovered,
      sitesNeedAttention,
      nightSlots,
    };
  }
}
