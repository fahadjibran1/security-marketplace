import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { AvailabilityService } from '../availability/availability.service';
import { CompanyService } from '../company/company.service';
import { Shift } from '../shift/entities/shift.entity';

type CoverageStatus = 'fully_covered' | 'partially_covered' | 'unfilled' | 'overstaffed';

@Injectable()
export class CoverageService {
  constructor(
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    private readonly companyService: CompanyService,
    private readonly availabilityService: AvailabilityService,
  ) {}

  async listShiftCoverage(userId: number, query: { from?: string; to?: string; siteId?: string; clientId?: string }) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    const from = query.from ? new Date(`${query.from}T00:00:00`) : new Date();
    const to = query.to ? new Date(`${query.to}T23:59:59`) : new Date(Date.now() + 14 * 86400000);
    const shifts = await this.shiftRepo.find({
      where: { company: { id: company.id }, start: Between(from, to) },
      order: { start: 'ASC' },
    });
    return shifts
      .filter((shift) => !query.siteId || String(shift.site?.id) === query.siteId)
      .filter((shift) => !query.clientId || String(shift.site?.client?.id) === query.clientId)
      .map((shift) => this.toCoverageRow(shift));
  }

  async listSiteCoverage(userId: number, query: { from?: string; to?: string }) {
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
    const assignedGuardCount = shift.guard ? 1 : 0;
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
    };
  }
}
