import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CompanyService } from '../company/company.service';
import { ContractPricingService } from '../contract-pricing/contract-pricing.service';
import { Timesheet, TimesheetStatus } from '../timesheet/entities/timesheet.entity';
import { MarginReportQueryDto } from './dto/margin-report-query.dto';

type MarginSummary = {
  totalCost: number;
  totalRevenue: number;
  totalMargin: number;
  marginPercent: number | null;
  breakdown: Array<{
    clientId: number | null;
    clientName: string;
    siteId: number | null;
    siteName: string;
    contractRuleId: number | null;
    contractRuleName: string;
    approvedHours: number;
    billableHours: number;
    cost: number;
    revenue: number;
    margin: number;
    marginPercent: number | null;
  }>;
};

@Injectable()
export class ReportService {
  constructor(
    @InjectRepository(Timesheet) private readonly timesheetRepo: Repository<Timesheet>,
    private readonly companyService: CompanyService,
    private readonly contractPricingService: ContractPricingService,
  ) {}

  async getCompanyMarginReport(userId: number, query: MarginReportQueryDto): Promise<MarginSummary> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const startDate = this.parseOptionalDate(query.startDate, false);
    const endDate = this.parseOptionalDate(query.endDate, true);
    if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
      throw new BadRequestException('Report end date must be on or after start date.');
    }

    const timesheets = await this.contractPricingService.applyFinancials(await this.timesheetRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    }));

    const breakdown = new Map<string, {
      clientId: number | null;
      clientName: string;
      siteId: number | null;
      siteName: string;
      contractRuleId: number | null;
      contractRuleName: string;
      approvedHours: number;
      billableHours: number;
      cost: number;
      revenue: number;
      margin: number;
    }>();
    let totalCost = 0;
    let totalRevenue = 0;

    timesheets.forEach((timesheet) => {
      if (String(timesheet.approvalStatus).trim().toLowerCase() !== TimesheetStatus.APPROVED) return;

      const shiftDate = this.getTimesheetDate(timesheet);
      if (startDate && shiftDate && shiftDate.getTime() < startDate.getTime()) return;
      if (endDate && shiftDate && shiftDate.getTime() > endDate.getTime()) return;

      const client = this.getTimesheetClient(timesheet);
      const site = timesheet.shift?.site ?? timesheet.shift?.job?.site ?? timesheet.shift?.assignment?.job?.site ?? null;
      if (query.clientId && client?.id !== query.clientId) return;
      if (query.siteId && site?.id !== query.siteId) return;

      const approvedHours = this.getApprovedHours(timesheet);
      const billableHours = Number(timesheet.billableHours) || approvedHours;
      const cost = Number(timesheet.costAmount) || 0;
      const revenue = Number(timesheet.revenueAmount) || 0;
      const margin = revenue - cost;
      const key = [
        client?.id ?? 'unassigned',
        site?.id ?? 'no-site',
        timesheet.matchedContractRuleId ?? 'fallback',
      ].join('|');
      const current =
        breakdown.get(key) ||
        {
          clientId: client?.id ?? null,
          clientName: client?.name || site?.clientName || 'Client unavailable',
          siteId: site?.id ?? null,
          siteName: site?.name || timesheet.shift?.siteName || 'Site unavailable',
          contractRuleId: timesheet.matchedContractRuleId ?? null,
          contractRuleName: timesheet.matchedContractRuleName || 'Fallback rate',
          approvedHours: 0,
          billableHours: 0,
          cost: 0,
          revenue: 0,
          margin: 0,
        };

      current.approvedHours += approvedHours;
      current.billableHours += billableHours;
      current.cost += cost;
      current.revenue += revenue;
      current.margin += margin;
      breakdown.set(key, current);
      totalCost += cost;
      totalRevenue += revenue;
    });

    const totalMargin = totalRevenue - totalCost;
    return {
      totalCost: this.roundCurrency(totalCost),
      totalRevenue: this.roundCurrency(totalRevenue),
      totalMargin: this.roundCurrency(totalMargin),
      marginPercent: this.getMarginPercent(totalMargin, totalRevenue),
      breakdown: Array.from(breakdown.values())
        .map((entry) => ({
          clientId: entry.clientId,
          clientName: entry.clientName,
          siteId: entry.siteId,
          siteName: entry.siteName,
          contractRuleId: entry.contractRuleId,
          contractRuleName: entry.contractRuleName,
          approvedHours: Math.round(entry.approvedHours * 100) / 100,
          billableHours: Math.round(entry.billableHours * 100) / 100,
          cost: this.roundCurrency(entry.cost),
          revenue: this.roundCurrency(entry.revenue),
          margin: this.roundCurrency(entry.margin),
          marginPercent: this.getMarginPercent(entry.margin, entry.revenue),
        }))
        .sort((left, right) => right.revenue - left.revenue),
    };
  }

  async getFinancialConsistency(userId: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const timesheets = await this.contractPricingService.applyFinancials(await this.timesheetRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    }));

    let totalPayrollCost = 0;
    let totalInvoiceRevenue = 0;
    let totalMargin = 0;
    const warnings: string[] = [];

    timesheets.forEach((timesheet) => {
      if (String(timesheet.approvalStatus).trim().toLowerCase() !== TimesheetStatus.APPROVED) return;
      const cost = Number(timesheet.costAmount ?? 0);
      const revenue = Number(timesheet.revenueAmount ?? 0);
      if (!Number.isFinite(cost)) warnings.push(`Timesheet #${timesheet.id} has invalid cost.`);
      if (!Number.isFinite(revenue)) warnings.push(`Timesheet #${timesheet.id} has invalid revenue.`);
      totalPayrollCost += Number.isFinite(cost) ? cost : 0;
      totalInvoiceRevenue += Number.isFinite(revenue) ? revenue : 0;
      totalMargin += (Number.isFinite(revenue) ? revenue : 0) - (Number.isFinite(cost) ? cost : 0);
      if (timesheet.payrollBatch?.status === 'paid' && !timesheet.hourlyRateSnapshot) {
        warnings.push(`Paid payroll timesheet #${timesheet.id} is missing hourly rate snapshot.`);
      }
      if (['issued', 'paid'].includes(String(timesheet.invoiceBatch?.status || '')) && !timesheet.billingRateSnapshot) {
        warnings.push(`Issued invoice timesheet #${timesheet.id} is missing billing rate snapshot.`);
      }
    });

    return {
      totalPayrollCost: this.roundCurrency(totalPayrollCost),
      totalInvoiceRevenue: this.roundCurrency(totalInvoiceRevenue),
      totalMargin: this.roundCurrency(totalMargin),
      warnings,
    };
  }

  private parseOptionalDate(value: string | undefined, endOfDay: boolean) {
    if (!value) return null;
    const date = new Date(endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59` : value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Report dates must be valid date strings.');
    }
    return date;
  }

  private getTimesheetDate(timesheet: Timesheet) {
    const value = timesheet.scheduledStartAt ?? timesheet.shift?.start ?? timesheet.createdAt;
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  private getTimesheetClient(timesheet: Timesheet) {
    return timesheet.shift?.site?.client ?? timesheet.shift?.job?.site?.client ?? timesheet.shift?.assignment?.job?.site?.client ?? null;
  }

  private getApprovedHours(timesheet: Timesheet) {
    if (timesheet.approvedHours !== undefined && timesheet.approvedHours !== null && Number.isFinite(Number(timesheet.approvedHours))) {
      return Number(timesheet.approvedHours);
    }
    return Number(timesheet.hoursWorked) || 0;
  }

  private getHourlyRate(timesheet: Timesheet) {
    const directJobRate = timesheet.shift?.job?.hourlyRate;
    if (directJobRate !== undefined && directJobRate !== null && Number.isFinite(Number(directJobRate))) {
      return Number(directJobRate);
    }

    const assignmentJobRate = timesheet.shift?.assignment?.job?.hourlyRate;
    if (assignmentJobRate !== undefined && assignmentJobRate !== null && Number.isFinite(Number(assignmentJobRate))) {
      return Number(assignmentJobRate);
    }

    return null;
  }

  private getBillingRate(timesheet: Timesheet) {
    const directBillingRate = timesheet.shift?.job?.billingRate;
    if (directBillingRate !== undefined && directBillingRate !== null && Number.isFinite(Number(directBillingRate))) {
      return Number(directBillingRate);
    }

    const assignmentBillingRate = timesheet.shift?.assignment?.job?.billingRate;
    if (assignmentBillingRate !== undefined && assignmentBillingRate !== null && Number.isFinite(Number(assignmentBillingRate))) {
      return Number(assignmentBillingRate);
    }

    return this.getHourlyRate(timesheet);
  }

  private getMarginPercent(margin: number, revenue: number) {
    if (!Number.isFinite(revenue) || Math.abs(revenue) < 0.0001) return null;
    return Math.round((margin / revenue) * 10000) / 100;
  }

  private roundCurrency(value: number) {
    return Math.round(value * 100) / 100;
  }
}
