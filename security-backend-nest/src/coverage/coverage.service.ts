import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { AvailabilityService } from '../availability/availability.service';
import { CompanyService } from '../company/company.service';
import { Shift } from '../shift/entities/shift.entity';

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
    private readonly companyService: CompanyService,
    private readonly availabilityService: AvailabilityService,
  ) {}

  async listShiftCoverage(userId: number, query: CoverageQuery) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    const now = new Date();
    const from = coverageCalendarBoundary(query.from, false, now);
    const to = query.to
      ? coverageCalendarBoundary(query.to, true, now)
      : coverageCalendarBoundary(undefined, true, new Date(now.getTime() + 14 * 86400000));
    const shifts = await this.shiftRepo.find({
      where: { company: { id: company.id }, start: Between(from, to) },
      order: { start: 'ASC' },
    });
    return shifts
      .filter((shift) => isOperationalCoverageShift(shift))
      .filter((shift) => !query.siteId || String(shift.site?.id) === query.siteId)
      .filter((shift) => !query.clientId || String(shift.site?.client?.id) === query.clientId)
      .filter((shift) => !query.shiftId || String(shift.id) === query.shiftId)
      .filter((shift) => query.uncoveredOnly !== 'true' || isUncoveredOperationalShift(shift))
      .map((shift) => this.toCoverageRow(shift));
  }

  async listSiteCoverage(userId: number, query: CoverageQuery) {
    const rows = await this.listShiftCoverage(userId, query);
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

  async eligibleGuardsForShift(userId: number, shiftId: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
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
