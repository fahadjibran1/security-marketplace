import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Client } from '../client/entities/client.entity';
import { CompanyService } from '../company/company.service';
import { Site } from '../site/entities/site.entity';
import { Timesheet, TimesheetStatus } from '../timesheet/entities/timesheet.entity';
import { ContractPricingQueryDto } from './dto/contract-pricing-query.dto';
import { CreateContractPricingRuleDto } from './dto/create-contract-pricing-rule.dto';
import { UpdateContractPricingRuleDto } from './dto/update-contract-pricing-rule.dto';
import { ContractPricingRule, ContractPricingRuleStatus } from './entities/contract-pricing-rule.entity';

export type ContractFinancialResult = {
  matchedContractRuleId: number | null;
  matchedContractRuleName: string | null;
  effectiveBillingRate: number | null;
  billableHours: number;
  revenueAmount: number | null;
  costAmount: number | null;
  marginAmount: number | null;
  marginPercent: number | null;
};

@Injectable()
export class ContractPricingService {
  constructor(
    @InjectRepository(ContractPricingRule) private readonly ruleRepo: Repository<ContractPricingRule>,
    @InjectRepository(Client) private readonly clientRepo: Repository<Client>,
    @InjectRepository(Site) private readonly siteRepo: Repository<Site>,
    @InjectRepository(Timesheet) private readonly timesheetRepo: Repository<Timesheet>,
    private readonly companyService: CompanyService,
  ) {}

  async listForCompany(userId: number, query: ContractPricingQueryDto = {}) {
    const company = await this.getCompanyForUser(userId);
    const rules = await this.ruleRepo.find({
      where: { company: { id: company.id } },
      order: { priority: 'ASC', id: 'DESC' },
    });

    return rules.filter((rule) => {
      if (query.clientId && rule.client?.id !== query.clientId) return false;
      if (query.siteId && rule.site?.id !== query.siteId) return false;
      if (query.status && String(rule.status).toLowerCase() !== String(query.status).toLowerCase()) return false;
      return true;
    });
  }

  async findOneForCompany(userId: number, id: number) {
    const company = await this.getCompanyForUser(userId);
    const rule = await this.ruleRepo.findOne({ where: { id, company: { id: company.id } } });
    if (!rule) throw new NotFoundException('Contract pricing rule not found');
    return rule;
  }

  async createForCompany(userId: number, dto: CreateContractPricingRuleDto) {
    const company = await this.getCompanyForUser(userId);
    const client = await this.getClientForCompany(company.id, dto.clientId);
    const site = dto.siteId ? await this.getSiteForCompany(company.id, dto.siteId, client.id) : null;
    const normalized = this.normalizeRuleDto(dto);

    const rule = this.ruleRepo.create({
      ...normalized,
      company,
      client,
      site,
    });

    return this.ruleRepo.save(rule);
  }

  async updateForCompany(userId: number, id: number, dto: UpdateContractPricingRuleDto) {
    const rule = await this.findOneForCompany(userId, id);
    const companyId = rule.company.id;
    const nextClient = dto.clientId ? await this.getClientForCompany(companyId, dto.clientId) : rule.client;
    const nextSite =
      dto.siteId === undefined
        ? rule.site ?? null
        : dto.siteId
          ? await this.getSiteForCompany(companyId, dto.siteId, nextClient.id)
          : null;
    const normalized = this.normalizeRuleDto(dto);

    Object.assign(rule, normalized, {
      client: nextClient,
      site: nextSite,
    });

    return this.ruleRepo.save(rule);
  }

  async deactivateForCompany(userId: number, id: number) {
    const rule = await this.findOneForCompany(userId, id);
    rule.status = ContractPricingRuleStatus.INACTIVE;
    return this.ruleRepo.save(rule);
  }

  async previewForCompany(userId: number, timesheetId: number) {
    const company = await this.getCompanyForUser(userId);
    const timesheet = await this.timesheetRepo.findOne({ where: { id: timesheetId, company: { id: company.id } } });
    if (!timesheet) throw new NotFoundException('Timesheet not found for this company.');
    const rules = await this.getActiveRulesForCompany(company.id);
    return this.deriveTimesheetFinancials(timesheet, rules);
  }

  async applyFinancials<T extends Timesheet | Timesheet[]>(timesheetOrTimesheets: T): Promise<T> {
    const rows = Array.isArray(timesheetOrTimesheets) ? timesheetOrTimesheets : [timesheetOrTimesheets];
    const companyIds = Array.from(new Set(rows.map((timesheet) => timesheet.company?.id).filter((id): id is number => Boolean(id))));
    const rulesByCompany = new Map<number, ContractPricingRule[]>();

    await Promise.all(
      companyIds.map(async (companyId) => {
        rulesByCompany.set(companyId, await this.getActiveRulesForCompany(companyId));
      }),
    );

    rows.forEach((timesheet) => {
      const rules = timesheet.company?.id ? rulesByCompany.get(timesheet.company.id) || [] : [];
      this.attachFinancials(timesheet, rules);
    });

    return timesheetOrTimesheets;
  }

  deriveTimesheetFinancials(timesheet: Timesheet, rules: ContractPricingRule[] = []): ContractFinancialResult {
    if (String(timesheet.approvalStatus).trim().toLowerCase() !== TimesheetStatus.APPROVED) {
      return {
        matchedContractRuleId: null,
        matchedContractRuleName: null,
        effectiveBillingRate: null,
        billableHours: 0,
        revenueAmount: null,
        costAmount: null,
        marginAmount: null,
        marginPercent: null,
      };
    }

    const approvedHours = this.getApprovedHours(timesheet);
    const costRate = this.getHourlyRate(timesheet);
    const matchedRule = this.findMatchingRule(timesheet, rules);
    const fallbackBillingRate = this.getFallbackBillingRate(timesheet);
    // Revenue fallback is explicit and ordered: matched contract rule, then job billingRate, then guard hourlyRate.
    const effectiveBillingRate = matchedRule?.billingRate !== undefined && matchedRule?.billingRate !== null
      ? Number(matchedRule.billingRate)
      : fallbackBillingRate;
    const billableHours = this.getBillableHours(approvedHours, matchedRule);
    const flatFee = this.toNumber(matchedRule?.flatCallOutFee) ?? 0;
    const costAmount = costRate === null ? null : this.roundCurrency(approvedHours * costRate);
    const revenueAmount = effectiveBillingRate === null ? null : this.roundCurrency(billableHours * effectiveBillingRate + flatFee);
    const marginAmount = costAmount === null || revenueAmount === null ? null : this.roundCurrency(revenueAmount - costAmount);
    const marginPercent =
      marginAmount === null || revenueAmount === null || Math.abs(revenueAmount) < 0.0001
        ? null
        : Math.round((marginAmount / revenueAmount) * 10000) / 100;

    return {
      matchedContractRuleId: matchedRule?.id ?? null,
      matchedContractRuleName: matchedRule?.name ?? null,
      effectiveBillingRate,
      billableHours,
      revenueAmount,
      costAmount,
      marginAmount,
      marginPercent,
    };
  }

  private attachFinancials(timesheet: Timesheet, rules: ContractPricingRule[]) {
    const financials = this.deriveTimesheetFinancials(timesheet, rules);
    timesheet.billingRate = financials.effectiveBillingRate;
    timesheet.effectiveBillingRate = financials.effectiveBillingRate;
    timesheet.billableHours = financials.billableHours;
    timesheet.revenueAmount = financials.revenueAmount;
    timesheet.costAmount = financials.costAmount;
    timesheet.marginAmount = financials.marginAmount;
    timesheet.marginPercent = financials.marginPercent;
    timesheet.matchedContractRuleId = financials.matchedContractRuleId;
    timesheet.matchedContractRuleName = financials.matchedContractRuleName;
  }

  private findMatchingRule(timesheet: Timesheet, rules: ContractPricingRule[]) {
    const client = this.getTimesheetClient(timesheet);
    if (!client) return null;
    const site = this.getTimesheetSite(timesheet);
    const shiftStart = this.getShiftStart(timesheet);

    return rules
      .filter((rule) => rule.client?.id === client.id)
      .filter((rule) => !rule.site || (site?.id && rule.site.id === site.id))
      .filter((rule) => this.ruleMatchesDate(rule, shiftStart))
      .filter((rule) => this.ruleMatchesDay(rule, shiftStart))
      .filter((rule) => this.ruleMatchesTime(rule, shiftStart))
      .filter((rule) => this.ruleMatchesWeekend(rule, shiftStart))
      .filter((rule) => this.ruleMatchesOvernight(rule, timesheet))
      .sort((left, right) => {
        const siteSpecific = Number(Boolean(right.site)) - Number(Boolean(left.site));
        if (siteSpecific !== 0) return siteSpecific;
        const priority = Number(left.priority || 100) - Number(right.priority || 100);
        if (priority !== 0) return priority;
        return right.id - left.id;
      })[0] || null;
  }

  private async getActiveRulesForCompany(companyId: number) {
    return this.ruleRepo.find({
      where: { company: { id: companyId }, status: ContractPricingRuleStatus.ACTIVE },
      order: { priority: 'ASC', id: 'DESC' },
    });
  }

  private async getCompanyForUser(userId: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private async getClientForCompany(companyId: number, clientId: number) {
    const client = await this.clientRepo.findOne({ where: { id: clientId, company: { id: companyId } } });
    if (!client) throw new NotFoundException('Client not found for this company.');
    return client;
  }

  private async getSiteForCompany(companyId: number, siteId: number, clientId: number) {
    const site = await this.siteRepo.findOne({ where: { id: siteId, company: { id: companyId } } });
    if (!site) throw new NotFoundException('Site not found for this company.');
    if (site.client?.id && site.client.id !== clientId) {
      throw new ForbiddenException('Site does not belong to the selected client.');
    }
    return site;
  }

  private normalizeRuleDto(dto: UpdateContractPricingRuleDto) {
    const status = dto.status ? String(dto.status).trim().toLowerCase() : undefined;
    if (status && status !== ContractPricingRuleStatus.ACTIVE && status !== ContractPricingRuleStatus.INACTIVE) {
      throw new BadRequestException('Contract pricing rule status must be active or inactive.');
    }

    return {
      name: dto.name?.trim(),
      status,
      priority: dto.priority,
      effectiveFrom: dto.effectiveFrom === undefined ? undefined : this.parseNullableDate(dto.effectiveFrom),
      effectiveTo: dto.effectiveTo === undefined ? undefined : this.parseNullableDate(dto.effectiveTo),
      billingRate: dto.billingRate === undefined ? undefined : dto.billingRate,
      minimumBillableHours: dto.minimumBillableHours === undefined ? undefined : dto.minimumBillableHours,
      roundUpToMinutes: dto.roundUpToMinutes === undefined ? undefined : dto.roundUpToMinutes,
      graceMinutes: dto.graceMinutes === undefined ? undefined : dto.graceMinutes,
      appliesOnMonday: dto.appliesOnMonday,
      appliesOnTuesday: dto.appliesOnTuesday,
      appliesOnWednesday: dto.appliesOnWednesday,
      appliesOnThursday: dto.appliesOnThursday,
      appliesOnFriday: dto.appliesOnFriday,
      appliesOnSaturday: dto.appliesOnSaturday,
      appliesOnSunday: dto.appliesOnSunday,
      startTime: dto.startTime === undefined ? undefined : dto.startTime?.trim() || null,
      endTime: dto.endTime === undefined ? undefined : dto.endTime?.trim() || null,
      appliesOnBankHoliday: dto.appliesOnBankHoliday,
      appliesOnWeekendOnly: dto.appliesOnWeekendOnly,
      appliesOnOvernightShift: dto.appliesOnOvernightShift,
      flatCallOutFee: dto.flatCallOutFee === undefined ? undefined : dto.flatCallOutFee,
      deductionHoursBeforeBilling:
        dto.deductionHoursBeforeBilling === undefined ? undefined : dto.deductionHoursBeforeBilling,
      notes: dto.notes === undefined ? undefined : dto.notes?.trim() || null,
    };
  }

  private parseNullableDate(value?: string | null) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Effective dates must be valid date strings.');
    }
    return date;
  }

  private ruleMatchesDate(rule: ContractPricingRule, value: Date | null) {
    if (!value) return true;
    if (rule.effectiveFrom && value.getTime() < new Date(rule.effectiveFrom).getTime()) return false;
    if (rule.effectiveTo && value.getTime() > new Date(rule.effectiveTo).getTime()) return false;
    return true;
  }

  private ruleMatchesDay(rule: ContractPricingRule, value: Date | null) {
    if (!value) return true;
    const day = value.getDay();
    const dayFlags = [
      rule.appliesOnSunday,
      rule.appliesOnMonday,
      rule.appliesOnTuesday,
      rule.appliesOnWednesday,
      rule.appliesOnThursday,
      rule.appliesOnFriday,
      rule.appliesOnSaturday,
    ];
    return Boolean(dayFlags[day]);
  }

  private ruleMatchesWeekend(rule: ContractPricingRule, value: Date | null) {
    if (!rule.appliesOnWeekendOnly) return true;
    if (!value) return true;
    return value.getDay() === 0 || value.getDay() === 6;
  }

  private ruleMatchesTime(rule: ContractPricingRule, value: Date | null) {
    if (!rule.startTime && !rule.endTime) return true;
    if (!value) return true;
    const currentMinutes = value.getHours() * 60 + value.getMinutes();
    const startMinutes = this.parseTimeToMinutes(rule.startTime);
    const endMinutes = this.parseTimeToMinutes(rule.endTime);
    if (startMinutes === null && endMinutes === null) return true;
    if (startMinutes !== null && endMinutes === null) return currentMinutes >= startMinutes;
    if (startMinutes === null && endMinutes !== null) return currentMinutes <= endMinutes;
    if (startMinutes !== null && endMinutes !== null && endMinutes < startMinutes) {
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }
    return startMinutes !== null && endMinutes !== null && currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  private ruleMatchesOvernight(rule: ContractPricingRule, timesheet: Timesheet) {
    if (rule.appliesOnOvernightShift === null || rule.appliesOnOvernightShift === undefined) return true;
    return this.isOvernight(timesheet) === rule.appliesOnOvernightShift;
  }

  private isOvernight(timesheet: Timesheet) {
    const start = this.getShiftStart(timesheet);
    const endValue = timesheet.scheduledEndAt ?? timesheet.shift?.end ?? null;
    const end = endValue ? new Date(endValue) : null;
    if (!start || !end || Number.isNaN(end.getTime())) return false;
    return start.toDateString() !== end.toDateString() || end.getTime() <= start.getTime();
  }

  private parseTimeToMinutes(value?: string | null) {
    if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
    const [hours, minutes] = value.split(':').map(Number);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  private getBillableHours(approvedHours: number, rule: ContractPricingRule | null) {
    const deduction = this.toNumber(rule?.deductionHoursBeforeBilling) ?? 0;
    let billableHours = Math.max(0, approvedHours - deduction);
    const roundToMinutes = this.toNumber(rule?.roundUpToMinutes);
    if (roundToMinutes && roundToMinutes > 0) {
      const rawMinutes = billableHours * 60;
      const roundedMinutes = Math.ceil(rawMinutes / roundToMinutes) * roundToMinutes;
      const graceMinutes = this.toNumber(rule?.graceMinutes) ?? 0;
      billableHours = roundedMinutes - rawMinutes <= graceMinutes ? rawMinutes / 60 : roundedMinutes / 60;
    }
    const minimum = this.toNumber(rule?.minimumBillableHours);
    if (minimum !== null) {
      billableHours = Math.max(billableHours, minimum);
    }
    return Math.round(billableHours * 100) / 100;
  }

  private getApprovedHours(timesheet: Timesheet) {
    if (timesheet.approvedHours !== undefined && timesheet.approvedHours !== null && Number.isFinite(Number(timesheet.approvedHours))) {
      return Number(timesheet.approvedHours);
    }
    return Number(timesheet.hoursWorked) || 0;
  }

  private getHourlyRate(timesheet: Timesheet) {
    const directJobRate = this.toNumber(timesheet.shift?.job?.hourlyRate);
    if (directJobRate !== null) return directJobRate;
    const assignmentJobRate = this.toNumber(timesheet.shift?.assignment?.job?.hourlyRate);
    if (assignmentJobRate !== null) return assignmentJobRate;
    return null;
  }

  private getFallbackBillingRate(timesheet: Timesheet) {
    const directBillingRate = this.toNumber(timesheet.shift?.job?.billingRate);
    if (directBillingRate !== null) return directBillingRate;
    const assignmentBillingRate = this.toNumber(timesheet.shift?.assignment?.job?.billingRate);
    if (assignmentBillingRate !== null) return assignmentBillingRate;
    return this.getHourlyRate(timesheet);
  }

  private getTimesheetClient(timesheet: Timesheet) {
    return timesheet.shift?.site?.client ?? timesheet.shift?.job?.site?.client ?? timesheet.shift?.assignment?.job?.site?.client ?? null;
  }

  private getTimesheetSite(timesheet: Timesheet) {
    return timesheet.shift?.site ?? timesheet.shift?.job?.site ?? timesheet.shift?.assignment?.job?.site ?? null;
  }

  private getShiftStart(timesheet: Timesheet) {
    const value = timesheet.scheduledStartAt ?? timesheet.shift?.start ?? timesheet.createdAt;
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  private toNumber(value?: string | number | null) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private roundCurrency(value: number) {
    return Math.round(value * 100) / 100;
  }
}
