import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';

import { AvailabilityService } from '../availability/availability.service';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { UserRole } from '../user/entities/user.entity';
import { Shift } from '../shift/entities/shift.entity';
import { OperationsProjectionService, ShiftOperationsView } from './operations-projection.service';
import { EarlyBookOffService } from './early-book-off.service';

type CoverageStatus = 'fully_covered' | 'partially_covered' | 'unfilled' | 'overstaffed';

export type CoverageQuery = {
  from?: string;
  to?: string;
  siteId?: string;
  clientId?: string;
  shiftId?: string;
  uncoveredOnly?: string;
};

const NON_OPERATIONAL_SHIFT_STATUSES = new Set(['cancelled', 'completed', 'missed']);
const CONFIRMED_COVER_SHIFT_STATUSES = new Set(['ready', 'in_progress']);
const COVERAGE_TIME_ZONE = 'Europe/London';

/** The most shifts one welfare monitoring request may name. A board shows a few dozen. */
export const OPERATIONS_MAX_SHIFT_IDS = 200;

/** "12,13,14" to [12, 13, 14]. Anything else, an empty list or more than the cap is refused. */
export function parseOperationsShiftIds(raw: string | undefined): number[] {
  const parts = (raw ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new BadRequestException('shiftIds is required: a comma-separated list of shift ids.');
  if (parts.length > OPERATIONS_MAX_SHIFT_IDS) {
    throw new BadRequestException(`At most ${OPERATIONS_MAX_SHIFT_IDS} shift ids per request.`);
  }
  const ids = parts.map((part) => (/^[1-9]\d{0,9}$/.test(part) ? Number(part) : NaN));
  if (ids.some((id) => !Number.isSafeInteger(id) || id > 2_147_483_647)) {
    throw new BadRequestException('shiftIds must be positive whole numbers.');
  }
  return [...new Set(ids)];
}

/**
 * Exactly the relations a coverage row and the operations projection read: the site and its client
 * (names, required guards, timezone, Welfare and Log Book intervals), the job (guards required) and the
 * guard (id, name). Performance P2: without this the shift's eager graph also joined its company and that
 * company's user, the assignment with its own job, company, guard and application, the application's job
 * and guard, the guard's user, the site's company and the client's company, on every coverage request.
 */
const COVERAGE_SHIFT_READ = {
  relations: { site: { client: true }, job: true, guard: true },
  loadEagerRelations: false,
} as const;

function ukDateParts(value: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: COVERAGE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

function timeZoneOffsetMs(value: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: COVERAGE_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
    - Math.floor(value.getTime() / 1000) * 1000;
}

function ukMidnight(year: number, month: number, day: number) {
  const guess = Date.UTC(year, month - 1, day);
  let result = new Date(guess - timeZoneOffsetMs(new Date(guess)));
  result = new Date(guess - timeZoneOffsetMs(result));
  return result;
}

export function coverageCalendarBoundary(date: string | undefined, end: boolean, now = new Date()) {
  const parsed = date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const base = parsed
    ? { year: Number(parsed[1]), month: Number(parsed[2]), day: Number(parsed[3]) }
    : ukDateParts(now);
  const dayOffset = end ? 1 : 0;
  const normalized = new Date(Date.UTC(base.year, base.month - 1, base.day + dayOffset));
  const boundary = ukMidnight(normalized.getUTCFullYear(), normalized.getUTCMonth() + 1, normalized.getUTCDate());
  return end ? new Date(boundary.getTime() - 1) : boundary;
}

export function isOperationalCoverageShift(shift: Pick<Shift, 'status'>): boolean {
  return !NON_OPERATIONAL_SHIFT_STATUSES.has((shift.status || '').trim().toLowerCase());
}

export function hasConfirmedShiftCover(shift: Pick<Shift, 'status' | 'guard'>): boolean {
  return Boolean(
    shift.guard && CONFIRMED_COVER_SHIFT_STATUSES.has((shift.status || '').trim().toLowerCase()),
  );
}

export function isUncoveredOperationalShift(shift: Pick<Shift, 'status' | 'guard'>): boolean {
  return isOperationalCoverageShift(shift) && !hasConfirmedShiftCover(shift);
}

@Injectable()
export class CoverageService {
  constructor(
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    private readonly membershipService: CompanyMembershipService,
    private readonly availabilityService: AvailabilityService,
    private readonly operationsProjection: OperationsProjectionService,
    // Optional so a caller built without it (older specs) gets the projection exactly as before.
    @Optional() private readonly earlyBookOffService?: EarlyBookOffService,
  ) {}

  async listShiftCoverage(userId: number, userRole: UserRole, query: CoverageQuery) {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.SITES_VIEW);
    const now = new Date();
    const from = coverageCalendarBoundary(query.from, false, now);
    const to = query.to
      ? coverageCalendarBoundary(query.to, true, now)
      : coverageCalendarBoundary(undefined, true, new Date(now.getTime() + 14 * 86400000));
    const shifts = await this.shiftRepo.find({
      where: { company: { id: company.id }, start: Between(from, to) },
      order: { start: 'ASC' },
      ...COVERAGE_SHIFT_READ,
    });
    const visible = shifts
      .filter((shift) => isOperationalCoverageShift(shift))
      .filter((shift) => !query.siteId || String(shift.site?.id) === query.siteId)
      .filter((shift) => !query.clientId || String(shift.site?.client?.id) === query.clientId)
      .filter((shift) => !query.shiftId || String(shift.id) === query.shiftId)
      .filter((shift) => query.uncoveredOnly !== 'true' || isUncoveredOperationalShift(shift));

    // The window maths is the backend's job: the board presents these values and never recomputes them.
    const operations = await this.operationsProjection.projectForShifts(visible, now);
    return visible.map((shift) => ({
      ...this.toCoverageRow(shift),
      operations: operations.get(shift.id) ?? null,
    }));
  }

  /**
   * Welfare and Log Book monitoring for the shifts Live Operations is showing, whatever their status.
   *
   * The board used to read this from the coverage list, which only covers shifts STARTING on the requested
   * UK day that are still operational — so a live overnight shift lost its welfare windows at midnight, a
   * booked-off or reconciled shift lost them on completion, and a historical day had none. The board knows
   * exactly which shifts it can show, so it names them.
   *
   * Tenant isolation is the query itself: only this company's shifts are read, and an id belonging to
   * another company is simply absent from the answer — never an error that would confirm it exists.
   * Same permission as coverage. The projection is the same one coverage uses, plus each window's miss
   * and alert history (one more bounded read).
   */
  async listShiftOperations(userId: number, userRole: UserRole, shiftIdsParam: string | undefined, now = new Date()) {
    const ids = parseOperationsShiftIds(shiftIdsParam);
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.SITES_VIEW);
    const shifts = await this.shiftRepo.find({
      where: { id: In(ids), company: { id: company.id } },
      order: { start: 'ASC' },
      ...COVERAGE_SHIFT_READ,
    });
    const operations = await this.operationsProjection.projectForShifts(shifts, now, { welfareHistory: true });
    // Welfare Phase 4: an early Book Off, and whether another Guard covered the rest of the shift.
    if (this.earlyBookOffService) {
      const bookOffBy = new Map(shifts.map((shift) => {
        const off = operations.get(shift.id)?.bookOffAt;
        return [shift.id, off ? new Date(off) : null] as const;
      }));
      const early = await this.earlyBookOffService.assess(company.id, shifts, bookOffBy, now);
      for (const shift of shifts) {
        const view = operations.get(shift.id);
        if (view) view.earlyBookOff = early.get(shift.id) ?? null;
      }
    }
    return shifts.map((shift) => ({ shiftId: shift.id, operations: operations.get(shift.id) ?? null }));
  }

  async listSiteCoverage(userId: number, userRole: UserRole, query: CoverageQuery) {
    const rows = await this.listShiftCoverage(userId, userRole, query);
    const map = new Map<string, any>();
    rows.forEach((row) => {
      const key = String(row.siteId || 'unknown');
      const current = map.get(key) || {
        siteId: row.siteId,
        siteName: row.siteName,
        clientName: row.clientName,
        shifts: 0,
        requiredGuards: 0,
        assignedGuards: 0,
        coverageGap: 0,
        unfilled: 0,
        partiallyCovered: 0,
      };
      current.shifts += 1;
      current.requiredGuards += row.requiredGuardCount;
      current.assignedGuards += row.assignedGuardCount;
      current.coverageGap += row.coverageGap;
      if (row.coverageStatus === 'unfilled') current.unfilled += 1;
      if (row.coverageStatus === 'partially_covered') current.partiallyCovered += 1;
      map.set(key, current);
    });
    return Array.from(map.values());
  }

  async eligibleGuardsForShift(userId: number, userRole: UserRole, shiftId: number) {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.SHIFTS_VIEW);
    const shift = await this.shiftRepo.findOne({ where: { id: shiftId, company: { id: company.id } } });
    if (!shift) throw new NotFoundException('Shift not found');
    return this.availabilityService.eligibleGuardsForShift(shift);
  }

  private toCoverageRow(shift: Shift) {
    const requiredGuardCount = Number(shift.job?.guardsRequired ?? shift.site?.requiredGuardCount ?? 1) || 1;
    const assignedGuardCount = hasConfirmedShiftCover(shift) ? 1 : 0;
    const coverageGap = Math.max(requiredGuardCount - assignedGuardCount, 0);
    let coverageStatus: CoverageStatus = 'fully_covered';
    if (assignedGuardCount === 0) coverageStatus = 'unfilled';
    else if (assignedGuardCount < requiredGuardCount) coverageStatus = 'partially_covered';
    else if (assignedGuardCount > requiredGuardCount) coverageStatus = 'overstaffed';
    return {
      shiftId: shift.id,
      siteId: shift.site?.id ?? null,
      siteName: shift.site?.name || shift.siteName,
      clientId: shift.site?.client?.id ?? null,
      clientName: shift.site?.client?.name || 'No client',
      start: shift.start,
      end: shift.end,
      requiredGuardCount,
      assignedGuardCount,
      coverageGap,
      coverageStatus,
      guardId: shift.guard?.id ?? null,
      guardName: shift.guard?.fullName ?? null,
      coverageState: isUncoveredOperationalShift(shift)
        ? shift.guard
          ? 'waiting_response'
          : 'uncovered'
        : 'confirmed',
    };
  }
}
