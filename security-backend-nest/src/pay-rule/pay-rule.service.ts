import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CompanyService } from '../company/company.service';
import { Timesheet, TimesheetStatus } from '../timesheet/entities/timesheet.entity';
import { UpsertPayRuleConfigDto } from './dto/upsert-pay-rule-config.dto';
import { PayRuleConfig } from './entities/pay-rule-config.entity';

export type PayBreakdown = {
  hourlyRate: number | null;
  baseHours: number;
  unpaidBreakHours: number;
  minimumPaidHoursApplied: number | null;
  regularHours: number;
  overtimeHours: number;
  nightHours: number;
  weekendHours: number;
  bankHolidayHours: number;
  regularAmount: number | null;
  overtimeAmount: number | null;
  nightPremiumAmount: number | null;
  weekendPremiumAmount: number | null;
  bankHolidayPremiumAmount: number | null;
  source: 'rule' | 'fallback';
};

export type PayCalculationResult = {
  baseHours: number;
  overtimeHours: number;
  nightHours: number;
  weekendHours: number;
  payableHours: number;
  payableAmount: number | null;
  breakdown: PayBreakdown;
};

@Injectable()
export class PayRuleService {
  constructor(
    @InjectRepository(PayRuleConfig) private readonly configRepo: Repository<PayRuleConfig>,
    private readonly companyService: CompanyService,
  ) {}

  async findForCompanyUser(userId: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    return this.configRepo.findOne({ where: { company: { id: company.id } } });
  }

  async upsertForCompanyUser(userId: number, dto: UpsertPayRuleConfigDto) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    const existing = await this.configRepo.findOne({ where: { company: { id: company.id } } });
    const normalized = this.normalizeDto(dto);
    const config = existing
      ? Object.assign(existing, normalized)
      : this.configRepo.create({ ...normalized, company });
    return this.configRepo.save(config);
  }

  async getConfigForCompany(companyId: number) {
    return this.configRepo.findOne({ where: { company: { id: companyId } } });
  }

  async applyPayCalculations<T extends Timesheet | Timesheet[]>(timesheetOrTimesheets: T): Promise<T> {
    const rows = Array.isArray(timesheetOrTimesheets) ? timesheetOrTimesheets : [timesheetOrTimesheets];
    const companyIds = Array.from(new Set(rows.map((timesheet) => timesheet.company?.id).filter((id): id is number => Boolean(id))));
    const configsByCompany = new Map<number, PayRuleConfig | null>();

    await Promise.all(
      companyIds.map(async (companyId) => {
        configsByCompany.set(companyId, await this.getConfigForCompany(companyId));
      }),
    );

    rows.forEach((timesheet) => {
      const config = timesheet.company?.id ? configsByCompany.get(timesheet.company.id) || null : null;
      const calculation = this.calculatePay(timesheet, config);
      timesheet.payableHours = calculation.payableHours;
      timesheet.payableAmount = calculation.payableAmount;
      timesheet.payBreakdown = calculation.breakdown;
    });

    return timesheetOrTimesheets;
  }

  calculatePay(timesheet: Timesheet, config?: PayRuleConfig | null): PayCalculationResult {
    const hourlyRate = this.getHourlyRate(timesheet);
    const approvedBaseHours = this.getApprovedHours(timesheet);
    const normalizedConfig = config ?? null;
    const baseHours = this.roundHours(approvedBaseHours);

    if (!normalizedConfig) {
      const amount = hourlyRate === null ? null : this.roundCurrency(baseHours * hourlyRate);
      return this.result({
        hourlyRate,
        baseHours,
        payableHours: baseHours,
        overtimeHours: 0,
        nightHours: 0,
        weekendHours: 0,
        unpaidBreakHours: 0,
        minimumPaidHoursApplied: null,
        payableAmount: amount,
        regularAmount: amount,
        overtimeAmount: 0,
        nightPremiumAmount: 0,
        weekendPremiumAmount: 0,
        bankHolidayPremiumAmount: 0,
        source: 'fallback',
      });
    }

    const unpaidBreakHours = Math.min(baseHours, Math.max(0, Number(normalizedConfig.unpaidBreakMinutes || 0) / 60));
    let payableHours = Math.max(0, baseHours - unpaidBreakHours);
    const minimumPaidHours = this.toNumber(normalizedConfig.minimumPaidHours);
    const minimumPaidHoursApplied = minimumPaidHours !== null && payableHours < minimumPaidHours ? minimumPaidHours : null;
    if (minimumPaidHoursApplied !== null) {
      payableHours = minimumPaidHoursApplied;
    }
    payableHours = this.roundHours(payableHours);

    const threshold = this.toNumber(normalizedConfig.overtimeThresholdHours);
    const overtimeHours = threshold !== null && payableHours > threshold ? this.roundHours(payableHours - threshold) : 0;
    const regularHours = this.roundHours(payableHours - overtimeHours);
    const nightHours = this.getNightHours(timesheet, normalizedConfig, payableHours);
    const weekendHours = this.isWeekend(timesheet) ? payableHours : 0;
    const bankHolidayHours = 0;

    const overtimeMultiplier = this.multiplier(normalizedConfig.overtimeMultiplier);
    const nightMultiplier = this.multiplier(normalizedConfig.nightMultiplier);
    const weekendMultiplier = this.multiplier(normalizedConfig.weekendMultiplier);
    const bankHolidayMultiplier = this.multiplier(normalizedConfig.bankHolidayMultiplier);

    const regularAmount = hourlyRate === null ? null : regularHours * hourlyRate;
    const overtimeAmount = hourlyRate === null ? null : overtimeHours * hourlyRate * overtimeMultiplier;
    const nightPremiumAmount = hourlyRate === null ? null : nightHours * hourlyRate * Math.max(0, nightMultiplier - 1);
    const weekendPremiumAmount = hourlyRate === null ? null : weekendHours * hourlyRate * Math.max(0, weekendMultiplier - 1);
    const bankHolidayPremiumAmount = hourlyRate === null ? null : bankHolidayHours * hourlyRate * Math.max(0, bankHolidayMultiplier - 1);
    const payableAmount =
      hourlyRate === null
        ? null
        : this.roundCurrency(
            (regularAmount || 0) +
              (overtimeAmount || 0) +
              (nightPremiumAmount || 0) +
              (weekendPremiumAmount || 0) +
              (bankHolidayPremiumAmount || 0),
          );

    return this.result({
      hourlyRate,
      baseHours,
      payableHours,
      overtimeHours,
      nightHours,
      weekendHours,
      unpaidBreakHours,
      minimumPaidHoursApplied,
      payableAmount,
      regularAmount,
      overtimeAmount,
      nightPremiumAmount,
      weekendPremiumAmount,
      bankHolidayPremiumAmount,
      source: 'rule',
    });
  }

  private normalizeDto(dto: UpsertPayRuleConfigDto) {
    return {
      overtimeThresholdHours: this.nullableNumber(dto.overtimeThresholdHours),
      overtimeMultiplier: this.defaultNumber(dto.overtimeMultiplier, 1),
      nightStart: dto.nightStart?.trim() || null,
      nightEnd: dto.nightEnd?.trim() || null,
      nightMultiplier: this.defaultNumber(dto.nightMultiplier, 1),
      weekendMultiplier: this.defaultNumber(dto.weekendMultiplier, 1),
      bankHolidayMultiplier: this.defaultNumber(dto.bankHolidayMultiplier, 1),
      minimumPaidHours: this.nullableNumber(dto.minimumPaidHours),
      unpaidBreakMinutes: Math.max(0, Math.floor(Number(dto.unpaidBreakMinutes ?? 0) || 0)),
    };
  }

  private result(input: {
    hourlyRate: number | null;
    baseHours: number;
    payableHours: number;
    overtimeHours: number;
    nightHours: number;
    weekendHours: number;
    unpaidBreakHours: number;
    minimumPaidHoursApplied: number | null;
    payableAmount: number | null;
    regularAmount: number | null;
    overtimeAmount: number | null;
    nightPremiumAmount: number | null;
    weekendPremiumAmount: number | null;
    bankHolidayPremiumAmount: number | null;
    source: 'rule' | 'fallback';
  }): PayCalculationResult {
    return {
      baseHours: this.roundHours(input.baseHours),
      overtimeHours: this.roundHours(input.overtimeHours),
      nightHours: this.roundHours(input.nightHours),
      weekendHours: this.roundHours(input.weekendHours),
      payableHours: this.roundHours(input.payableHours),
      payableAmount: input.payableAmount,
      breakdown: {
        hourlyRate: input.hourlyRate,
        baseHours: this.roundHours(input.baseHours),
        unpaidBreakHours: this.roundHours(input.unpaidBreakHours),
        minimumPaidHoursApplied: input.minimumPaidHoursApplied === null ? null : this.roundHours(input.minimumPaidHoursApplied),
        regularHours: this.roundHours(input.payableHours - input.overtimeHours),
        overtimeHours: this.roundHours(input.overtimeHours),
        nightHours: this.roundHours(input.nightHours),
        weekendHours: this.roundHours(input.weekendHours),
        bankHolidayHours: 0,
        regularAmount: this.nullableCurrency(input.regularAmount),
        overtimeAmount: this.nullableCurrency(input.overtimeAmount),
        nightPremiumAmount: this.nullableCurrency(input.nightPremiumAmount),
        weekendPremiumAmount: this.nullableCurrency(input.weekendPremiumAmount),
        bankHolidayPremiumAmount: this.nullableCurrency(input.bankHolidayPremiumAmount),
        source: input.source,
      },
    };
  }

  private getApprovedHours(timesheet: Timesheet) {
    const snapshot = this.toNumber(timesheet.approvedHoursSnapshot);
    if (snapshot !== null) return snapshot;
    const approved = this.toNumber(timesheet.approvedHours);
    if (approved !== null) return approved;
    if (String(timesheet.approvalStatus).trim().toLowerCase() === TimesheetStatus.APPROVED) {
      return this.toNumber(timesheet.hoursWorked) ?? 0;
    }
    return this.toNumber(timesheet.hoursWorked) ?? 0;
  }

  private getHourlyRate(timesheet: Timesheet) {
    return (
      this.toNumber(timesheet.hourlyRateSnapshot) ??
      this.toNumber(timesheet.shift?.job?.hourlyRate) ??
      this.toNumber(timesheet.shift?.assignment?.job?.hourlyRate)
    );
  }

  private getNightHours(timesheet: Timesheet, config: PayRuleConfig, payableHours: number) {
    if (!config.nightStart || !config.nightEnd || payableHours <= 0) return 0;
    const shiftStart = this.getShiftStart(timesheet);
    const shiftEnd = this.getShiftEnd(timesheet);
    if (!shiftStart || !shiftEnd || shiftEnd.getTime() <= shiftStart.getTime()) return 0;

    const windowStartMinutes = this.parseTime(config.nightStart);
    const windowEndMinutes = this.parseTime(config.nightEnd);
    if (windowStartMinutes === null || windowEndMinutes === null) return 0;

    const totalShiftHours = Math.max(0, (shiftEnd.getTime() - shiftStart.getTime()) / 36e5);
    if (totalShiftHours <= 0) return 0;

    let overlapMs = 0;
    const cursor = new Date(shiftStart);
    cursor.setHours(0, 0, 0, 0);
    cursor.setDate(cursor.getDate() - 1);
    for (let day = 0; day < 4; day += 1) {
      const dayStart = new Date(cursor);
      dayStart.setDate(cursor.getDate() + day);
      const firstStart = this.withMinutes(dayStart, windowStartMinutes);
      const firstEnd =
        windowEndMinutes <= windowStartMinutes
          ? this.withMinutes(new Date(dayStart.getTime() + 24 * 60 * 60 * 1000), windowEndMinutes)
          : this.withMinutes(dayStart, windowEndMinutes);
      overlapMs += this.overlapMs(shiftStart, shiftEnd, firstStart, firstEnd);
    }

    const overlapHours = overlapMs / 36e5;
    return this.roundHours(Math.min(payableHours, (overlapHours / totalShiftHours) * payableHours));
  }

  private isWeekend(timesheet: Timesheet) {
    const shiftStart = this.getShiftStart(timesheet);
    if (!shiftStart) return false;
    const day = shiftStart.getDay();
    return day === 0 || day === 6;
  }

  private getShiftStart(timesheet: Timesheet) {
    const value = timesheet.scheduledStartAt ?? timesheet.shift?.start ?? timesheet.createdAt;
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  private getShiftEnd(timesheet: Timesheet) {
    const value = timesheet.scheduledEndAt ?? timesheet.shift?.end;
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  private withMinutes(day: Date, minutes: number) {
    const date = new Date(day);
    date.setHours(0, minutes, 0, 0);
    return date;
  }

  private overlapMs(leftStart: Date, leftEnd: Date, rightStart: Date, rightEnd: Date) {
    return Math.max(0, Math.min(leftEnd.getTime(), rightEnd.getTime()) - Math.max(leftStart.getTime(), rightStart.getTime()));
  }

  private parseTime(value: string) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  private multiplier(value: unknown) {
    const parsed = this.toNumber(value);
    return parsed === null ? 1 : Math.max(0, parsed);
  }

  private nullableNumber(value: unknown) {
    const parsed = this.toNumber(value);
    return parsed === null ? null : Math.max(0, parsed);
  }

  private defaultNumber(value: unknown, fallback: number) {
    const parsed = this.toNumber(value);
    return parsed === null ? fallback : Math.max(0, parsed);
  }

  private toNumber(value: unknown) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private roundHours(value: number) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  private roundCurrency(value: number) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  private nullableCurrency(value: number | null) {
    return value === null ? null : this.roundCurrency(value);
  }
}
