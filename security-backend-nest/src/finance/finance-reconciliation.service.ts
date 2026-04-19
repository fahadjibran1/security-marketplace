import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CompanyService } from '../company/company.service';
import { ContractPricingService } from '../contract-pricing/contract-pricing.service';
import { InvoiceBatch } from '../invoice-batch/entities/invoice-batch.entity';
import { PayRuleService } from '../pay-rule/pay-rule.service';
import { Timesheet, TimesheetPayrollStatus, TimesheetStatus } from '../timesheet/entities/timesheet.entity';
import { FinanceQueryDto } from './dto/finance-query.dto';

type ReconciliationRow = {
  invoiceBatchId: number;
  invoiceNumber: string | null;
  invoiceReference: string | null;
  clientId: number | null;
  clientName: string;
  siteNames: string[];
  issuedDate: Date | null;
  dueDate: Date | null;
  amount: number;
  paid: number;
  outstanding: number;
  paymentStatus: 'unpaid' | 'partially_paid' | 'paid';
  ageDays: number;
  ageBucket: '0-30' | '31-60' | '61-90' | '90+';
  payments: Array<{
    id: number;
    amount: number;
    paymentDate: Date;
    method: string;
    reference: string | null;
    notes: string | null;
  }>;
};

function isReconciliationRow(row: ReconciliationRow | null): row is ReconciliationRow {
  return row !== null;
}

@Injectable()
export class FinanceReconciliationService {
  constructor(
    @InjectRepository(InvoiceBatch) private readonly invoiceBatchRepo: Repository<InvoiceBatch>,
    @InjectRepository(Timesheet) private readonly timesheetRepo: Repository<Timesheet>,
    private readonly companyService: CompanyService,
    private readonly contractPricingService: ContractPricingService,
    private readonly payRuleService: PayRuleService,
  ) {}

  async getSummary(userId: number, query: FinanceQueryDto) {
    const scope = await this.buildScopedDataset(userId, query);
    return {
      filters: this.serializeFilters(query),
      revenueSummary: {
        totalRevenue: this.roundCurrency(scope.totalApprovedRevenue),
        totalInvoiced: this.roundCurrency(scope.totalInvoicedRevenue),
        totalPaid: this.roundCurrency(scope.totalPaidRevenue),
        outstandingRevenue: this.roundCurrency(scope.totalOutstandingRevenue),
      },
      costSummary: {
        totalCost: this.roundCurrency(scope.totalApprovedCost),
        totalPaidToGuards: this.roundCurrency(scope.totalPaidToGuards),
        pendingPayroll: this.roundCurrency(scope.pendingPayroll),
      },
      profitSummary: {
        totalProfit: this.roundCurrency(scope.totalApprovedRevenue - scope.totalApprovedCost),
        realisedProfit: this.roundCurrency(scope.totalPaidRevenue - scope.totalPaidToGuards),
        unrealisedProfit: this.roundCurrency(
          scope.totalApprovedRevenue - scope.totalApprovedCost - (scope.totalPaidRevenue - scope.totalPaidToGuards),
        ),
      },
      monthly: scope.monthly,
    };
  }

  async getReceivables(userId: number, query: FinanceQueryDto) {
    const scope = await this.buildScopedDataset(userId, query);
    const buckets = scope.reconciliationRows.reduce(
      (summary, row) => {
        summary[row.ageBucket] += row.outstanding;
        return summary;
      },
      { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 },
    );

    return {
      filters: this.serializeFilters(query),
      totals: {
        invoiced: this.roundCurrency(scope.totalInvoicedRevenue),
        paid: this.roundCurrency(scope.totalPaidRevenue),
        outstanding: this.roundCurrency(scope.totalOutstandingRevenue),
      },
      buckets: {
        '0-30': this.roundCurrency(buckets['0-30']),
        '31-60': this.roundCurrency(buckets['31-60']),
        '61-90': this.roundCurrency(buckets['61-90']),
        '90+': this.roundCurrency(buckets['90+']),
      },
      rows: scope.reconciliationRows,
    };
  }

  async getReconciliation(userId: number, query: FinanceQueryDto) {
    const scope = await this.buildScopedDataset(userId, query);
    return {
      filters: this.serializeFilters(query),
      rows: scope.reconciliationRows,
    };
  }

  private async buildScopedDataset(userId: number, query: FinanceQueryDto) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const timesheets = await this.timesheetRepo.find({
      where: { company: { id: company.id } },
      relations: {
        shift: {
          site: { client: true },
          job: { site: { client: true } },
          assignment: { job: { site: { client: true } }, guard: true },
          guard: true,
        },
        guard: true,
        invoiceBatch: { client: true, paymentRecords: true },
        payrollBatch: true,
      },
      order: { createdAt: 'DESC' },
    });

    const approvedTimesheets = timesheets.filter(
      (timesheet) => String(timesheet.approvalStatus || '').trim().toLowerCase() === TimesheetStatus.APPROVED,
    );
    await this.contractPricingService.applyFinancials(approvedTimesheets);
    await this.payRuleService.applyPayCalculations(approvedTimesheets);

    const filteredTimesheets = approvedTimesheets.filter((timesheet) => this.matchesTimesheetFilters(timesheet, query));
    const monthlyMap = new Map<string, { month: string; revenue: number; cost: number; profit: number }>();
    let totalApprovedRevenue = 0;
    let totalApprovedCost = 0;
    let totalPaidToGuards = 0;
    let pendingPayroll = 0;

    filteredTimesheets.forEach((timesheet) => {
      const revenue = this.getTimesheetRevenue(timesheet);
      const cost = this.getTimesheetCost(timesheet);
      totalApprovedRevenue += revenue;
      totalApprovedCost += cost;

      if (String(timesheet.payrollStatus || '').trim().toLowerCase() === TimesheetPayrollStatus.PAID) {
        totalPaidToGuards += cost;
      } else {
        pendingPayroll += cost;
      }

      const monthKey = this.getMonthKey(this.getTimesheetReferenceDate(timesheet));
      const current = monthlyMap.get(monthKey) || { month: monthKey, revenue: 0, cost: 0, profit: 0 };
      current.revenue += revenue;
      current.cost += cost;
      current.profit += revenue - cost;
      monthlyMap.set(monthKey, current);
    });

    const invoiceBatchIds = Array.from(
      new Set(filteredTimesheets.map((timesheet) => timesheet.invoiceBatch?.id).filter((id): id is number => Boolean(id))),
    );

    const invoiceBatches = invoiceBatchIds.length
      ? await this.invoiceBatchRepo.find({
          where: invoiceBatchIds.map((id) => ({ id, company: { id: company.id } })),
          relations: { client: true, timesheets: true, paymentRecords: true },
          order: { createdAt: 'DESC' },
        })
      : [];

    await Promise.all(invoiceBatches.map((batch) => this.contractPricingService.applyFinancials(batch.timesheets || [])));

    const reconciliationRows: ReconciliationRow[] = [];
    invoiceBatches.forEach((batch) => {
      const row = this.buildReconciliationRow(batch, filteredTimesheets, query.siteId);
      if (isReconciliationRow(row)) {
        reconciliationRows.push(row);
      }
    });
    reconciliationRows.sort((left, right) => {
      const leftTime = left.issuedDate ? new Date(left.issuedDate).getTime() : 0;
      const rightTime = right.issuedDate ? new Date(right.issuedDate).getTime() : 0;
      return rightTime - leftTime;
    });

    return {
      totalApprovedRevenue,
      totalApprovedCost,
      totalPaidToGuards,
      pendingPayroll,
      totalInvoicedRevenue: reconciliationRows.reduce((sum, row) => sum + row.amount, 0),
      totalPaidRevenue: reconciliationRows.reduce((sum, row) => sum + row.paid, 0),
      totalOutstandingRevenue: reconciliationRows.reduce((sum, row) => sum + row.outstanding, 0),
      reconciliationRows,
      monthly: Array.from(monthlyMap.values())
        .map((row) => ({
          month: row.month,
          revenue: this.roundCurrency(row.revenue),
          cost: this.roundCurrency(row.cost),
          profit: this.roundCurrency(row.profit),
        }))
        .sort((left, right) => left.month.localeCompare(right.month)),
    };
  }

  private matchesTimesheetFilters(timesheet: Timesheet, query: FinanceQueryDto) {
    const referenceDate = this.getTimesheetReferenceDate(timesheet);
    const startDate = query.startDate ? new Date(`${query.startDate}T00:00:00`) : null;
    const endDate = query.endDate ? new Date(`${query.endDate}T23:59:59`) : null;

    if (startDate && referenceDate.getTime() < startDate.getTime()) return false;
    if (endDate && referenceDate.getTime() > endDate.getTime()) return false;
    if (query.clientId && this.getClientId(timesheet) !== query.clientId) return false;
    if (query.siteId && this.getSiteId(timesheet) !== query.siteId) return false;
    return true;
  }

  private buildReconciliationRow(batch: InvoiceBatch, filteredTimesheets: Timesheet[], scopedSiteId?: number): ReconciliationRow | null {
    const scopedTimesheets = (batch.timesheets || []).filter((timesheet) =>
      filteredTimesheets.some((candidate) => candidate.id === timesheet.id),
    );

    if (!scopedTimesheets.length) {
      return null;
    }

    const fullBatchRevenue = (batch.timesheets || []).reduce((sum, timesheet) => sum + this.getTimesheetRevenue(timesheet), 0);
    const scopedRevenue = scopedTimesheets.reduce((sum, timesheet) => sum + this.getTimesheetRevenue(timesheet), 0);
    const proportion =
      scopedSiteId && fullBatchRevenue > 0 ? Math.min(1, Math.max(0, scopedRevenue / fullBatchRevenue)) : 1;
    const amount = this.roundCurrency(this.getInvoiceBatchAmount(batch) * proportion);
    const paid = this.roundCurrency(this.getInvoiceBatchPaidAmount(batch) * proportion);
    const outstanding = this.roundCurrency(Math.max(0, amount - paid));
    const issueDate = batch.issuedAt ?? batch.finalisedAt ?? batch.createdAt;
    const ageDays = this.getAgeDays(batch.dueDate ?? issueDate);

    const paymentStatus: ReconciliationRow['paymentStatus'] = outstanding <= 0.009 ? 'paid' : paid > 0 ? 'partially_paid' : 'unpaid';

    return {
      invoiceBatchId: batch.id,
      invoiceNumber: batch.invoiceNumber ?? null,
      invoiceReference: batch.invoiceReference ?? null,
      clientId: batch.client?.id ?? null,
      clientName: batch.client?.name || `Client #${batch.client?.id ?? 'unknown'}`,
      siteNames: Array.from(new Set(scopedTimesheets.map((timesheet) => this.getSiteName(timesheet)))).sort(),
      issuedDate: issueDate,
      dueDate: batch.dueDate ?? null,
      amount,
      paid,
      outstanding,
      paymentStatus,
      ageDays,
      ageBucket: this.getAgeBucket(ageDays),
      payments: (batch.paymentRecords || []).map((record) => ({
        id: record.id,
        amount: this.roundCurrency((this.toNumber(record.amount) ?? 0) * proportion),
        paymentDate: record.paymentDate,
        method: record.method,
        reference: record.reference ?? null,
        notes: record.notes ?? null,
      })),
    };
  }

  private getTimesheetCost(timesheet: Timesheet) {
    return this.toNumber(timesheet.payableAmountSnapshot) ?? this.toNumber(timesheet.payableAmount) ?? this.toNumber(timesheet.costAmount) ?? 0;
  }

  private getTimesheetRevenue(timesheet: Timesheet) {
    const revenueAmount = this.toNumber(timesheet.revenueAmount);
    if (revenueAmount !== null) return revenueAmount;

    const billableHours = this.toNumber(timesheet.billableHours) ?? this.toNumber(timesheet.approvedHoursSnapshot) ?? this.toNumber(timesheet.approvedHours) ?? this.toNumber(timesheet.hoursWorked) ?? 0;
    const rate =
      this.toNumber(timesheet.billingRateSnapshot) ??
      this.toNumber(timesheet.effectiveBillingRate) ??
      this.toNumber(timesheet.billingRate);

    return rate === null ? 0 : this.roundCurrency(billableHours * rate);
  }

  private getInvoiceBatchAmount(batch: InvoiceBatch) {
    const snapshot = this.toNumber(batch.netAmountSnapshot);
    if (snapshot !== null) return snapshot;
    return (batch.timesheets || []).reduce((sum, timesheet) => sum + this.getTimesheetRevenue(timesheet), 0);
  }

  private getInvoiceBatchPaidAmount(batch: InvoiceBatch) {
    return (batch.paymentRecords || []).reduce((sum, record) => sum + (this.toNumber(record.amount) ?? 0), 0);
  }

  private getTimesheetReferenceDate(timesheet: Timesheet) {
    const value = timesheet.scheduledStartAt ?? timesheet.shift?.start ?? timesheet.createdAt;
    const date = value ? new Date(value) : new Date(timesheet.createdAt);
    return Number.isNaN(date.getTime()) ? new Date(timesheet.createdAt) : date;
  }

  private getClientId(timesheet: Timesheet) {
    return timesheet.shift?.site?.client?.id ?? timesheet.shift?.job?.site?.client?.id ?? timesheet.shift?.assignment?.job?.site?.client?.id ?? null;
  }

  private getSiteId(timesheet: Timesheet) {
    return timesheet.shift?.site?.id ?? timesheet.shift?.job?.site?.id ?? timesheet.shift?.assignment?.job?.site?.id ?? null;
  }

  private getSiteName(timesheet: Timesheet) {
    return timesheet.shift?.site?.name || timesheet.shift?.siteName || timesheet.shift?.job?.site?.name || 'Unknown site';
  }

  private getMonthKey(date: Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  private getAgeDays(date: Date | null) {
    if (!date) return 0;
    const now = new Date();
    const reference = new Date(date);
    return Math.max(0, Math.floor((now.getTime() - reference.getTime()) / 86400000));
  }

  private getAgeBucket(ageDays: number): '0-30' | '31-60' | '61-90' | '90+' {
    if (ageDays <= 30) return '0-30';
    if (ageDays <= 60) return '31-60';
    if (ageDays <= 90) return '61-90';
    return '90+';
  }

  private serializeFilters(query: FinanceQueryDto) {
    return {
      startDate: query.startDate ?? null,
      endDate: query.endDate ?? null,
      clientId: query.clientId ?? null,
      siteId: query.siteId ?? null,
    };
  }

  private toNumber(value: unknown) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private roundCurrency(value: number) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }
}
