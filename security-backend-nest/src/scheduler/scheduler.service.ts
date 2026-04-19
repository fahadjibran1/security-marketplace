import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';

import { Company } from '../company/entities/company.entity';
import { InvoiceBatch, InvoiceBatchStatus } from '../invoice-batch/entities/invoice-batch.entity';
import { InvoiceBatchService } from '../invoice-batch/invoice-batch.service';
import { Notification, NotificationStatus, NotificationType } from '../notification/entities/notification.entity';
import { PayRuleService } from '../pay-rule/pay-rule.service';
import { PayrollBatch, PayrollBatchStatus } from '../payroll-batch/entities/payroll-batch.entity';
import { PayrollBatchService } from '../payroll-batch/payroll-batch.service';
import {
  Timesheet,
  TimesheetBillingStatus,
  TimesheetPayrollStatus,
  TimesheetStatus,
} from '../timesheet/entities/timesheet.entity';

type Suggestion = {
  companyId: number;
  companyName: string;
  periodStart: string;
  periodEnd: string;
  timesheetIds: number[];
  totalHours: number;
  totalCost?: number;
  totalRevenue?: number;
  clientId?: number;
  clientName?: string;
};

@Injectable()
export class AutomationSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutomationSchedulerService.name);
  private dailyInterval?: NodeJS.Timeout;
  private weeklyInterval?: NodeJS.Timeout;

  constructor(
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    @InjectRepository(Timesheet) private readonly timesheetRepo: Repository<Timesheet>,
    @InjectRepository(PayrollBatch) private readonly payrollBatchRepo: Repository<PayrollBatch>,
    @InjectRepository(InvoiceBatch) private readonly invoiceBatchRepo: Repository<InvoiceBatch>,
    @InjectRepository(Notification) private readonly notificationRepo: Repository<Notification>,
    private readonly payrollBatchService: PayrollBatchService,
    private readonly invoiceBatchService: InvoiceBatchService,
    private readonly payRuleService: PayRuleService,
  ) {}

  onModuleInit() {
    this.dailyInterval = setInterval(() => {
      this.runReminders().catch((error) => this.logger.error(`Reminder job failed: ${error?.message || error}`));
    }, 24 * 60 * 60 * 1000);
    this.weeklyInterval = setInterval(() => {
      this.runAutomationSuggestions().catch((error) => this.logger.error(`Suggestion job failed: ${error?.message || error}`));
    }, 7 * 24 * 60 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.dailyInterval) clearInterval(this.dailyInterval);
    if (this.weeklyInterval) clearInterval(this.weeklyInterval);
  }

  async getPayrollSuggestionsForCompany(userId: number) {
    const company = await this.companyRepo.findOne({ where: { user: { id: userId } } });
    if (!company) return [];
    return this.buildPayrollSuggestions(company.id);
  }

  async getInvoiceSuggestionsForCompany(userId: number) {
    const company = await this.companyRepo.findOne({ where: { user: { id: userId } } });
    if (!company) return [];
    return this.buildInvoiceSuggestions(company.id);
  }

  async runPayrollSuggestions() {
    const companies = await this.companyRepo.find();
    const summaries = await Promise.all(companies.map(async (company) => {
      const suggestions = await this.buildPayrollSuggestions(company.id);
      if (suggestions.length && company.user?.id) {
        await this.createReminderIfMissing({
          userId: company.user.id,
          company,
          type: NotificationType.PAYROLL_SUGGESTION,
          title: 'Suggested payroll batches ready',
          message: `${suggestions.length} suggested payroll batch(es) are ready for review.`,
        });
      }

      if (company.autoCreatePayrollBatch) {
        for (const suggestion of suggestions) {
          await this.payrollBatchService.createForCompany(company.user.id, {
            periodStart: suggestion.periodStart,
            periodEnd: suggestion.periodEnd,
            notes: 'Auto-created draft from scheduler suggestion.',
            timesheetIds: suggestion.timesheetIds,
          });
        }
      }
      return { companyId: company.id, suggestions: suggestions.length };
    }));
    return { companiesChecked: companies.length, summaries };
  }

  async runInvoiceSuggestions() {
    const companies = await this.companyRepo.find();
    const summaries = await Promise.all(companies.map(async (company) => {
      const suggestions = await this.buildInvoiceSuggestions(company.id);
      if (suggestions.length && company.user?.id) {
        await this.createReminderIfMissing({
          userId: company.user.id,
          company,
          type: NotificationType.INVOICE_SUGGESTION,
          title: 'Suggested invoice batches ready',
          message: `${suggestions.length} suggested invoice batch(es) are ready for review.`,
        });
      }

      if (company.autoCreateInvoiceBatch) {
        for (const suggestion of suggestions) {
          if (!suggestion.clientId) continue;
          await this.invoiceBatchService.createForCompany(company.user.id, {
            clientId: suggestion.clientId,
            periodStart: suggestion.periodStart,
            periodEnd: suggestion.periodEnd,
            notes: 'Auto-created draft from scheduler suggestion.',
            timesheetIds: suggestion.timesheetIds,
          });
        }
      }
      return { companyId: company.id, suggestions: suggestions.length };
    }));
    return { companiesChecked: companies.length, summaries };
  }

  async runReminders() {
    const now = new Date();
    const submittedCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const financeCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const companies = await this.companyRepo.find();
    const summaries = [];

    for (const company of companies) {
      if (!company.user?.id) continue;
      const submitted = await this.timesheetRepo.count({
        where: { company: { id: company.id }, approvalStatus: TimesheetStatus.SUBMITTED, submittedAt: LessThan(submittedCutoff) },
      });
      const unpaid = await this.timesheetRepo.count({
        where: {
          company: { id: company.id },
          approvalStatus: TimesheetStatus.APPROVED,
          payrollStatus: TimesheetPayrollStatus.UNPAID,
          payrollBatch: IsNull(),
          updatedAt: LessThan(financeCutoff),
        },
      });
      const uninvoiced = await this.timesheetRepo.count({
        where: {
          company: { id: company.id },
          approvalStatus: TimesheetStatus.APPROVED,
          billingStatus: TimesheetBillingStatus.UNINVOICED,
          invoiceBatch: IsNull(),
          updatedAt: LessThan(financeCutoff),
        },
      });
      const draftPayroll = await this.payrollBatchRepo.count({ where: { company: { id: company.id }, status: PayrollBatchStatus.DRAFT } });
      const draftInvoices = await this.invoiceBatchRepo.count({ where: { company: { id: company.id }, status: InvoiceBatchStatus.DRAFT } });

      if (submitted) {
        await this.createReminderIfMissing({
          userId: company.user.id,
          company,
          type: NotificationType.FINANCIAL_REMINDER,
          title: 'Timesheets need review',
          message: `${submitted} submitted timesheet(s) have been waiting more than 24 hours.`,
        });
      }
      if (unpaid) {
        await this.createReminderIfMissing({
          userId: company.user.id,
          company,
          type: NotificationType.FINANCIAL_REMINDER,
          title: 'Approved work is unpaid',
          message: `${unpaid} approved timesheet(s) are unpaid and not in a payroll batch.`,
        });
      }
      if (uninvoiced) {
        await this.createReminderIfMissing({
          userId: company.user.id,
          company,
          type: NotificationType.FINANCIAL_REMINDER,
          title: 'Approved work is uninvoiced',
          message: `${uninvoiced} approved timesheet(s) are uninvoiced and not in an invoice batch.`,
        });
      }
      if (draftPayroll || draftInvoices) {
        await this.createReminderIfMissing({
          userId: company.user.id,
          company,
          type: NotificationType.FINANCIAL_REMINDER,
          title: 'Draft batches need action',
          message: `${draftPayroll} payroll draft(s) and ${draftInvoices} invoice draft(s) are awaiting final action.`,
        });
      }
      summaries.push({ companyId: company.id, submitted, unpaid, uninvoiced, draftPayroll, draftInvoices });
    }

    return { companiesChecked: companies.length, summaries };
  }

  private async runAutomationSuggestions() {
    const [payroll, invoices] = await Promise.all([this.runPayrollSuggestions(), this.runInvoiceSuggestions()]);
    return { payroll, invoices };
  }

  private async buildPayrollSuggestions(companyId: number): Promise<Suggestion[]> {
    const timesheets = await this.timesheetRepo.find({
      where: {
        company: { id: companyId },
        approvalStatus: TimesheetStatus.APPROVED,
        payrollStatus: TimesheetPayrollStatus.UNPAID,
        payrollBatch: IsNull(),
      },
      order: { scheduledStartAt: 'ASC', createdAt: 'ASC' },
    });

    const map = new Map<string, Suggestion>();
    const payRuleConfig = await this.payRuleService.getConfigForCompany(companyId);
    timesheets.forEach((timesheet) => {
      const period = this.getWeekPeriod(this.getTimesheetDate(timesheet));
      const key = `${companyId}-${period.periodStart}`;
      const suggestion = map.get(key) || {
        companyId,
        companyName: timesheet.company?.name || `Company #${companyId}`,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        timesheetIds: [],
        totalHours: 0,
        totalCost: 0,
      };
      const pay = this.payRuleService.calculatePay(timesheet, payRuleConfig);
      suggestion.timesheetIds.push(timesheet.id);
      suggestion.totalHours += pay.payableHours;
      suggestion.totalCost = (suggestion.totalCost || 0) + (pay.payableAmount ?? 0);
      map.set(key, suggestion);
    });

    return Array.from(map.values()).map((suggestion) => ({
      ...suggestion,
      totalHours: this.round(suggestion.totalHours),
      totalCost: this.round(suggestion.totalCost || 0),
    }));
  }

  private async buildInvoiceSuggestions(companyId: number): Promise<Suggestion[]> {
    const timesheets = await this.timesheetRepo.find({
      where: {
        company: { id: companyId },
        approvalStatus: TimesheetStatus.APPROVED,
        billingStatus: TimesheetBillingStatus.UNINVOICED,
        invoiceBatch: IsNull(),
      },
      order: { scheduledStartAt: 'ASC', createdAt: 'ASC' },
    });

    const map = new Map<string, Suggestion>();
    timesheets.forEach((timesheet) => {
      const client = this.getTimesheetClient(timesheet);
      if (!client?.id) return;
      const period = this.getWeekPeriod(this.getTimesheetDate(timesheet));
      const key = `${companyId}-${client.id}-${period.periodStart}`;
      const suggestion = map.get(key) || {
        companyId,
        companyName: timesheet.company?.name || `Company #${companyId}`,
        clientId: client.id,
        clientName: client.name,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        timesheetIds: [],
        totalHours: 0,
        totalRevenue: 0,
      };
      const hours = this.getApprovedHours(timesheet);
      const rate = this.getBillingRate(timesheet);
      suggestion.timesheetIds.push(timesheet.id);
      suggestion.totalHours += hours;
      suggestion.totalRevenue = (suggestion.totalRevenue || 0) + (rate === null ? 0 : hours * rate);
      map.set(key, suggestion);
    });

    return Array.from(map.values()).map((suggestion) => ({
      ...suggestion,
      totalHours: this.round(suggestion.totalHours),
      totalRevenue: this.round(suggestion.totalRevenue || 0),
    }));
  }

  private async createReminderIfMissing(input: { userId: number; company: Company; type: NotificationType; title: string; message: string }) {
    const existing = await this.notificationRepo.findOne({
      where: {
        user: { id: input.userId },
        company: { id: input.company.id },
        status: NotificationStatus.UNREAD,
        title: input.title,
        message: input.message,
      },
    });
    if (existing) return existing;

    const notification = this.notificationRepo.create({
      user: { id: input.userId } as Notification['user'],
      company: input.company,
      type: input.type,
      title: input.title,
      message: input.message,
      status: NotificationStatus.UNREAD,
      sentAt: new Date(),
    });
    return this.notificationRepo.save(notification);
  }

  private getTimesheetDate(timesheet: Timesheet) {
    return timesheet.scheduledStartAt ?? timesheet.shift?.start ?? timesheet.createdAt ?? new Date();
  }

  private getWeekPeriod(value: Date) {
    const start = new Date(value);
    const day = start.getDay() || 7;
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - day + 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
  }

  private getApprovedHours(timesheet: Timesheet) {
    return Number(timesheet.approvedHoursSnapshot ?? timesheet.approvedHours ?? timesheet.hoursWorked ?? 0) || 0;
  }

  private getBillingRate(timesheet: Timesheet) {
    const rate =
      timesheet.billingRateSnapshot ??
      timesheet.effectiveBillingRate ??
      timesheet.billingRate ??
      timesheet.shift?.job?.billingRate ??
      timesheet.shift?.assignment?.job?.billingRate ??
      timesheet.shift?.job?.hourlyRate ??
      timesheet.shift?.assignment?.job?.hourlyRate;
    return rate === undefined || rate === null || !Number.isFinite(Number(rate)) ? null : Number(rate);
  }

  private getTimesheetClient(timesheet: Timesheet) {
    return timesheet.shift?.site?.client ?? timesheet.shift?.job?.site?.client ?? timesheet.shift?.assignment?.job?.site?.client ?? null;
  }

  private round(value: number) {
    return Math.round(value * 100) / 100;
  }
}
