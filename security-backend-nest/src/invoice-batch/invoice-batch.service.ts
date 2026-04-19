import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';

import { AuditLogService } from '../audit-log/audit-log.service';
import { Client } from '../client/entities/client.entity';
import { CompanyService } from '../company/company.service';
import { ContractPricingService } from '../contract-pricing/contract-pricing.service';
import {
  Timesheet,
  TimesheetBillingStatus,
  TimesheetStatus,
} from '../timesheet/entities/timesheet.entity';
import { CreateInvoiceBatchDto } from './dto/create-invoice-batch.dto';
import { InvoiceBatch, InvoiceBatchStatus } from './entities/invoice-batch.entity';

@Injectable()
export class InvoiceBatchService {
  constructor(
    @InjectRepository(InvoiceBatch) private readonly invoiceBatchRepo: Repository<InvoiceBatch>,
    @InjectRepository(Timesheet) private readonly timesheetRepo: Repository<Timesheet>,
    @InjectRepository(Client) private readonly clientRepo: Repository<Client>,
    private readonly companyService: CompanyService,
    private readonly contractPricingService: ContractPricingService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createForCompany(userId: number, dto: CreateInvoiceBatchDto) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const client = await this.clientRepo.findOne({
      where: { id: dto.clientId, company: { id: company.id } },
    });
    if (!client) {
      throw new NotFoundException('Client not found for this company.');
    }

    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      throw new BadRequestException('A valid invoice period start and end are required.');
    }

    if (periodEnd.getTime() < periodStart.getTime()) {
      throw new BadRequestException('Invoice period end must be on or after period start.');
    }

    const uniqueIds = Array.from(new Set((dto.timesheetIds || []).filter((value) => Number.isInteger(value) && value > 0)));
    if (!uniqueIds.length) {
      throw new BadRequestException('Select at least one approved timesheet to create an invoice batch.');
    }

    const timesheets = await this.timesheetRepo.find({
      where: uniqueIds.map((id) => ({ id, company: { id: company.id } })),
    });

    if (timesheets.length !== uniqueIds.length) {
      throw new NotFoundException('One or more selected timesheets were not found for this company.');
    }

    timesheets.forEach((timesheet) => this.assertTimesheetInvoiceEligible(timesheet, client.id));

    const batch = this.invoiceBatchRepo.create({
      company,
      client,
      periodStart,
      periodEnd,
      status: InvoiceBatchStatus.DRAFT,
      invoiceReference: dto.invoiceReference?.trim() ? dto.invoiceReference.trim() : null,
      notes: dto.notes?.trim() ? dto.notes.trim() : null,
      paymentTermsDays: dto.paymentTermsDays ?? 30,
      vatRate: dto.vatRate ?? 20,
      currency: 'GBP',
      createdByUserId: userId,
      finalisedAt: null,
      issuedAt: null,
      paidAt: null,
    });

    const savedBatch = await this.invoiceBatchRepo.save(batch);
    await this.contractPricingService.applyFinancials(timesheets);
    timesheets.forEach((timesheet) => {
      timesheet.approvedHoursSnapshot = timesheet.approvedHoursSnapshot ?? this.getApprovedHours(timesheet);
      timesheet.billingRateSnapshot = timesheet.billingRateSnapshot ?? this.getBillingRate(timesheet);
      timesheet.invoiceBatch = savedBatch;
      timesheet.billingStatus = TimesheetBillingStatus.INCLUDED;
      timesheet.invoiceIssuedAt = null;
      timesheet.invoicePaidAt = null;
    });
    await this.timesheetRepo.save(timesheets);

    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'invoice_batch.created',
      entityType: 'invoice_batch',
      entityId: savedBatch.id,
      beforeData: null,
      afterData: {
        clientId: client.id,
        periodStart: savedBatch.periodStart,
        periodEnd: savedBatch.periodEnd,
        status: savedBatch.status,
        timesheetIds: timesheets.map((timesheet) => timesheet.id),
      },
    });

    await Promise.all(timesheets.map((timesheet) => this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'timesheet.added_to_invoice_batch',
      entityType: 'timesheet',
      entityId: timesheet.id,
      beforeData: { invoiceBatchId: null, billingStatus: TimesheetBillingStatus.UNINVOICED },
      afterData: {
        invoiceBatchId: savedBatch.id,
        billingStatus: timesheet.billingStatus,
        approvedHoursSnapshot: timesheet.approvedHoursSnapshot,
        billingRateSnapshot: timesheet.billingRateSnapshot,
      },
    })));

    return this.findOneForCompany(userId, savedBatch.id);
  }

  async listForCompany(userId: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const batches = await this.invoiceBatchRepo.find({
      where: { company: { id: company.id } },
      relations: { timesheets: true },
      order: { createdAt: 'DESC' },
    });

    await Promise.all(batches.map((batch) => this.hydrateBatchFinancials(batch)));
    return batches.map((batch) => this.toBatchSummary(batch, false));
  }

  async findOneForCompany(userId: number, id: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const batch = await this.invoiceBatchRepo.findOne({
      where: { id, company: { id: company.id } },
      relations: { timesheets: true },
    });

    if (!batch) {
      throw new NotFoundException('Invoice batch not found');
    }

    await this.hydrateBatchFinancials(batch);
    return this.toBatchSummary(batch, true);
  }

  async finaliseForCompany(userId: number, id: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const batch = await this.invoiceBatchRepo.findOne({
      where: { id, company: { id: company.id } },
      relations: { timesheets: true },
    });

    if (!batch) {
      throw new NotFoundException('Invoice batch not found');
    }

    if (batch.status !== InvoiceBatchStatus.DRAFT) {
      throw new ForbiddenException('Only draft invoice batches can be finalised.');
    }

    if (!batch.timesheets?.length) {
      throw new BadRequestException('An invoice batch must contain at least one timesheet before it can be finalised.');
    }

    const beforeData = {
      status: batch.status,
      finalisedAt: batch.finalisedAt,
      invoiceNumber: batch.invoiceNumber,
      timesheetIds: batch.timesheets.map((timesheet) => timesheet.id),
    };
    await this.ensureInvoiceDocumentMetadata(batch, company);
    batch.status = InvoiceBatchStatus.FINALISED;
    batch.finalisedAt = new Date();
    await this.invoiceBatchRepo.save(batch);

    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'invoice_batch.finalised',
      entityType: 'invoice_batch',
      entityId: batch.id,
      beforeData,
      afterData: {
        status: batch.status,
        finalisedAt: batch.finalisedAt,
        invoiceNumber: batch.invoiceNumber,
        netAmountSnapshot: batch.netAmountSnapshot,
        vatAmountSnapshot: batch.vatAmountSnapshot,
        grossAmountSnapshot: batch.grossAmountSnapshot,
      },
    });

    return this.findOneForCompany(userId, batch.id);
  }

  async issueForCompany(userId: number, id: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const batch = await this.invoiceBatchRepo.findOne({
      where: { id, company: { id: company.id } },
      relations: { timesheets: true },
    });

    if (!batch) {
      throw new NotFoundException('Invoice batch not found');
    }

    if (batch.status !== InvoiceBatchStatus.FINALISED) {
      throw new ForbiddenException('Only finalised invoice batches can be issued.');
    }

    const now = new Date();
    const batchTimesheets = batch.timesheets || [];
    if (!batchTimesheets.length) {
      throw new BadRequestException('An invoice batch must contain at least one timesheet before it can be issued.');
    }
    const beforeData = {
      status: batch.status,
      issuedAt: batch.issuedAt,
      invoiceNumber: batch.invoiceNumber,
      timesheetIds: batchTimesheets.map((timesheet) => timesheet.id),
    };
    await this.ensureInvoiceDocumentMetadata(batch, company);
    batch.status = InvoiceBatchStatus.ISSUED;
    batch.issuedAt = now;
    batchTimesheets.forEach((timesheet) => {
      timesheet.billingStatus = TimesheetBillingStatus.INVOICED;
      timesheet.invoiceIssuedAt = timesheet.invoiceIssuedAt ?? now;
      timesheet.invoicePaidAt = null;
    });

    await this.invoiceBatchRepo.save(batch);
    await this.timesheetRepo.save(batchTimesheets);

    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'invoice_batch.issued',
      entityType: 'invoice_batch',
      entityId: batch.id,
      beforeData,
      afterData: {
        status: batch.status,
        issuedAt: batch.issuedAt,
        invoiceNumber: batch.invoiceNumber,
        netAmountSnapshot: batch.netAmountSnapshot,
        vatAmountSnapshot: batch.vatAmountSnapshot,
        grossAmountSnapshot: batch.grossAmountSnapshot,
      },
    });

    return this.findOneForCompany(userId, batch.id);
  }

  async getDocumentForCompany(userId: number, id: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const batch = await this.invoiceBatchRepo.findOne({
      where: { id, company: { id: company.id } },
      relations: { timesheets: true },
    });

    if (!batch) {
      throw new NotFoundException('Invoice batch not found');
    }

    await this.hydrateBatchFinancials(batch);
    const totals = this.calculateDocumentTotals(batch);
    const lineItems = this.buildDocumentLineItems(batch);
    const invoiceNumber = batch.invoiceNumber ?? this.previewInvoiceNumber(batch);
    const issueDate = batch.issuedAt ?? batch.finalisedAt ?? new Date();
    const dueDate = batch.dueDate ?? this.calculateDueDate(issueDate, batch.paymentTermsDays ?? 30);

    return {
      id: batch.id,
      status: batch.status,
      invoiceNumber,
      invoiceReference: batch.invoiceReference ?? null,
      issueDate,
      dueDate,
      periodStart: batch.periodStart,
      periodEnd: batch.periodEnd,
      currency: batch.currency ?? 'GBP',
      paymentTermsDays: batch.paymentTermsDays ?? 30,
      vatRate: Number(batch.vatRate ?? 20),
      notes: batch.notes ?? null,
      company: {
        name: batch.companyNameSnapshot || batch.company?.name || 'Company',
        address: batch.companyAddressSnapshot || batch.company?.address || '',
        contactDetails: batch.company?.contactDetails || '',
      },
      client: {
        name: batch.clientNameSnapshot || batch.client?.name || 'Client',
        billingAddress: batch.billingAddressSnapshot || batch.client?.contactDetails || '',
        contactName: batch.client?.contactName ?? null,
        contactEmail: batch.client?.contactEmail ?? null,
        contactPhone: batch.client?.contactPhone ?? null,
      },
      lineItems,
      totals,
    };
  }

  async payForCompany(userId: number, id: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const batch = await this.invoiceBatchRepo.findOne({
      where: { id, company: { id: company.id } },
      relations: { timesheets: true },
    });

    if (!batch) {
      throw new NotFoundException('Invoice batch not found');
    }

    if (batch.status !== InvoiceBatchStatus.ISSUED) {
      throw new ForbiddenException('Only issued invoice batches can be marked paid.');
    }

    const now = new Date();
    const batchTimesheets = batch.timesheets || [];
    const beforeData = {
      status: batch.status,
      paidAt: batch.paidAt,
      timesheetIds: batchTimesheets.map((timesheet) => timesheet.id),
    };
    batch.status = InvoiceBatchStatus.PAID;
    batch.paidAt = now;
    batchTimesheets.forEach((timesheet) => {
      timesheet.billingStatus = TimesheetBillingStatus.INVOICED;
      timesheet.invoiceIssuedAt = timesheet.invoiceIssuedAt ?? batch.issuedAt ?? now;
      timesheet.invoicePaidAt = now;
    });

    await this.invoiceBatchRepo.save(batch);
    await this.timesheetRepo.save(batchTimesheets);

    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'invoice_batch.paid',
      entityType: 'invoice_batch',
      entityId: batch.id,
      beforeData,
      afterData: {
        status: batch.status,
        paidAt: batch.paidAt,
      },
    });

    await Promise.all(batchTimesheets.map((timesheet) => this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'timesheet.invoice_paid',
      entityType: 'timesheet',
      entityId: timesheet.id,
      beforeData: { billingStatus: TimesheetBillingStatus.INVOICED, invoicePaidAt: null },
      afterData: { billingStatus: timesheet.billingStatus, invoicePaidAt: timesheet.invoicePaidAt, invoiceBatchId: batch.id },
    })));

    return this.findOneForCompany(userId, batch.id);
  }

  private assertTimesheetInvoiceEligible(timesheet: Timesheet, clientId: number) {
    if (String(timesheet.approvalStatus).trim().toLowerCase() !== TimesheetStatus.APPROVED) {
      throw new ForbiddenException('Only approved timesheets can be attached to an invoice batch.');
    }

    if (String(timesheet.billingStatus || '').trim().toLowerCase() === TimesheetBillingStatus.INVOICED) {
      throw new ForbiddenException('Invoiced timesheets cannot be attached to a new invoice batch.');
    }

    if (timesheet.invoiceBatch) {
      throw new ForbiddenException('A selected timesheet is already attached to an existing invoice batch.');
    }

    const timesheetClient = this.getTimesheetClient(timesheet);
    if (!timesheetClient) {
      throw new ForbiddenException('A selected timesheet does not have a client and cannot be invoiced.');
    }

    if (timesheetClient.id !== clientId) {
      throw new ForbiddenException('All selected timesheets must belong to the selected client.');
    }
  }

  private getTimesheetClient(timesheet: Timesheet) {
    return timesheet.shift?.site?.client ?? timesheet.shift?.job?.site?.client ?? timesheet.shift?.assignment?.job?.site?.client ?? null;
  }

  private getBillingRate(timesheet: Timesheet) {
    if (timesheet.billingRateSnapshot !== undefined && timesheet.billingRateSnapshot !== null && Number.isFinite(Number(timesheet.billingRateSnapshot))) {
      return Number(timesheet.billingRateSnapshot);
    }
    if (timesheet.effectiveBillingRate !== undefined && timesheet.effectiveBillingRate !== null) {
      return Number(timesheet.effectiveBillingRate);
    }

    const directBillingRate = timesheet.shift?.job?.billingRate;
    if (directBillingRate !== undefined && directBillingRate !== null && Number.isFinite(Number(directBillingRate))) {
      return Number(directBillingRate);
    }

    const assignmentBillingRate = timesheet.shift?.assignment?.job?.billingRate;
    if (assignmentBillingRate !== undefined && assignmentBillingRate !== null && Number.isFinite(Number(assignmentBillingRate))) {
      return Number(assignmentBillingRate);
    }

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

  private getApprovedHours(timesheet: Timesheet) {
    if (timesheet.approvedHoursSnapshot !== undefined && timesheet.approvedHoursSnapshot !== null && Number.isFinite(Number(timesheet.approvedHoursSnapshot))) {
      return Number(timesheet.approvedHoursSnapshot);
    }
    if (timesheet.approvedHours !== undefined && timesheet.approvedHours !== null && Number.isFinite(Number(timesheet.approvedHours))) {
      return Number(timesheet.approvedHours);
    }

    if (String(timesheet.approvalStatus).trim().toLowerCase() === TimesheetStatus.APPROVED) {
      return Number(timesheet.hoursWorked) || 0;
    }

    return 0;
  }

  private getBillableHours(timesheet: Timesheet) {
    if (timesheet.billableHours !== undefined && timesheet.billableHours !== null && Number.isFinite(Number(timesheet.billableHours))) {
      return Number(timesheet.billableHours);
    }

    return this.getApprovedHours(timesheet);
  }

  private getTimesheetSiteName(timesheet: Timesheet) {
    return timesheet.shift?.site?.name || timesheet.shift?.siteName || 'Unknown site';
  }

  private getTimesheetGuardName(timesheet: Timesheet) {
    return timesheet.guard?.fullName || timesheet.shift?.guard?.fullName || timesheet.shift?.assignment?.guard?.fullName || `Guard #${timesheet.guard?.id ?? 'unknown'}`;
  }

  private getTimesheetShiftDate(timesheet: Timesheet) {
    return timesheet.scheduledStartAt ?? timesheet.shift?.start ?? timesheet.createdAt;
  }

  private roundCurrency(value: number) {
    return Math.round(value * 100) / 100;
  }

  private calculateDocumentTotals(batch: InvoiceBatch) {
    const netAmount =
      batch.netAmountSnapshot !== undefined && batch.netAmountSnapshot !== null
        ? Number(batch.netAmountSnapshot)
        : (batch.timesheets || []).reduce((sum, timesheet) => {
            if (timesheet.revenueAmount !== undefined && timesheet.revenueAmount !== null) {
              return sum + Number(timesheet.revenueAmount);
            }
            const rate = this.getBillingRate(timesheet);
            return rate === null ? sum : sum + this.getBillableHours(timesheet) * rate;
          }, 0);
    const vatRate = Number(batch.vatRate ?? 20);
    const vatAmount =
      batch.vatAmountSnapshot !== undefined && batch.vatAmountSnapshot !== null
        ? Number(batch.vatAmountSnapshot)
        : netAmount * (vatRate / 100);
    const grossAmount =
      batch.grossAmountSnapshot !== undefined && batch.grossAmountSnapshot !== null
        ? Number(batch.grossAmountSnapshot)
        : netAmount + vatAmount;

    return {
      netAmount: this.roundCurrency(netAmount),
      vatRate: this.roundCurrency(vatRate),
      vatAmount: this.roundCurrency(vatAmount),
      grossAmount: this.roundCurrency(grossAmount),
    };
  }

  private buildDocumentLineItems(batch: InvoiceBatch) {
    return [...(batch.timesheets || [])]
      .sort((left, right) => {
        const siteCompare = this.getTimesheetSiteName(left).localeCompare(this.getTimesheetSiteName(right));
        if (siteCompare !== 0) return siteCompare;
        return new Date(this.getTimesheetShiftDate(left)).getTime() - new Date(this.getTimesheetShiftDate(right)).getTime();
      })
      .map((timesheet) => {
        const billableHours = this.getBillableHours(timesheet);
        const billingRate = this.getBillingRate(timesheet);
        const amount =
          timesheet.revenueAmount !== undefined && timesheet.revenueAmount !== null
            ? Number(timesheet.revenueAmount)
            : billingRate === null
              ? 0
              : billableHours * billingRate;
        return {
          timesheetId: timesheet.id,
          site: this.getTimesheetSiteName(timesheet),
          guard: this.getTimesheetGuardName(timesheet),
          shiftDate: this.getTimesheetShiftDate(timesheet),
          approvedHours: this.roundCurrency(this.getApprovedHours(timesheet)),
          billableHours: this.roundCurrency(billableHours),
          billingRate: billingRate === null ? null : this.roundCurrency(billingRate),
          amount: this.roundCurrency(amount),
          companyNote: timesheet.companyNote ?? null,
        };
      });
  }

  private previewInvoiceNumber(batch: InvoiceBatch) {
    const year = (batch.finalisedAt ?? batch.issuedAt ?? new Date()).getFullYear();
    return `INV-${year}-${String(batch.id).padStart(4, '0')}`;
  }

  private calculateDueDate(issueDate: Date, paymentTermsDays: number) {
    const dueDate = new Date(issueDate);
    dueDate.setDate(dueDate.getDate() + paymentTermsDays);
    return dueDate;
  }

  private async generateInvoiceNumber(companyId: number, date: Date) {
    const year = date.getFullYear();
    const prefix = `INV-${year}-`;
    const existingCount = await this.invoiceBatchRepo.count({
      where: {
        company: { id: companyId },
        invoiceNumber: Like(`${prefix}%`),
      },
    });
    return `${prefix}${String(existingCount + 1).padStart(4, '0')}`;
  }

  private async ensureInvoiceDocumentMetadata(batch: InvoiceBatch, company: any) {
    if (batch.invoiceNumber && batch.companyNameSnapshot && batch.clientNameSnapshot && batch.netAmountSnapshot !== null && batch.netAmountSnapshot !== undefined) {
      return;
    }

    await this.hydrateBatchFinancials(batch);
    const now = batch.finalisedAt ?? batch.issuedAt ?? new Date();
    if (!batch.invoiceNumber) {
      batch.invoiceNumber = await this.generateInvoiceNumber(company.id, now);
    }
    batch.invoiceReference = batch.invoiceReference ?? batch.invoiceNumber;
    batch.paymentTermsDays = batch.paymentTermsDays ?? 30;
    batch.currency = batch.currency ?? 'GBP';
    batch.vatRate = batch.vatRate ?? 20;
    batch.companyNameSnapshot = batch.companyNameSnapshot || company.name || batch.company?.name || null;
    batch.companyAddressSnapshot = batch.companyAddressSnapshot || company.address || batch.company?.address || null;
    batch.clientNameSnapshot = batch.clientNameSnapshot || batch.client?.name || null;
    batch.billingAddressSnapshot = batch.billingAddressSnapshot || batch.client?.contactDetails || null;
    batch.dueDate = batch.dueDate ?? this.calculateDueDate(now, batch.paymentTermsDays);
    const totals = this.calculateDocumentTotals(batch);
    batch.netAmountSnapshot = batch.netAmountSnapshot ?? totals.netAmount;
    batch.vatAmountSnapshot = batch.vatAmountSnapshot ?? totals.vatAmount;
    batch.grossAmountSnapshot = batch.grossAmountSnapshot ?? totals.grossAmount;
  }

  private toBatchSummary(batch: InvoiceBatch, includeTimesheets: boolean) {
    const timesheets = batch.timesheets || [];
    const totals = timesheets.reduce(
      (summary, timesheet) => {
        const approvedHours = this.getApprovedHours(timesheet);
        const rate = this.getBillingRate(timesheet);
        const revenueAmount = timesheet.revenueAmount !== undefined && timesheet.revenueAmount !== null ? Number(timesheet.revenueAmount) : null;
        summary.recordsCount += 1;
        summary.approvedHours += approvedHours;
        if (revenueAmount !== null) {
          summary.invoiceAmount += revenueAmount;
          summary.totalRevenueAmount += revenueAmount;
        } else if (rate !== null) {
          summary.invoiceAmount += approvedHours * rate;
          summary.totalRevenueAmount += approvedHours * rate;
        } else {
          summary.missingRateCount += 1;
        }
        return summary;
      },
      { recordsCount: 0, approvedHours: 0, invoiceAmount: 0, totalRevenueAmount: 0, missingRateCount: 0 },
    );

    return {
      id: batch.id,
      companyId: batch.company?.id,
      clientId: batch.client?.id,
      client: batch.client,
      periodStart: batch.periodStart,
      periodEnd: batch.periodEnd,
      status: batch.status,
      invoiceReference: batch.invoiceReference ?? null,
      invoiceNumber: batch.invoiceNumber ?? null,
      notes: batch.notes ?? null,
      dueDate: batch.dueDate ?? null,
      billingAddressSnapshot: batch.billingAddressSnapshot ?? null,
      clientNameSnapshot: batch.clientNameSnapshot ?? null,
      companyNameSnapshot: batch.companyNameSnapshot ?? null,
      companyAddressSnapshot: batch.companyAddressSnapshot ?? null,
      paymentTermsDays: batch.paymentTermsDays ?? 30,
      currency: batch.currency ?? 'GBP',
      vatRate: batch.vatRate ?? 20,
      netAmountSnapshot: batch.netAmountSnapshot ?? null,
      vatAmountSnapshot: batch.vatAmountSnapshot ?? null,
      grossAmountSnapshot: batch.grossAmountSnapshot ?? null,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      finalisedAt: batch.finalisedAt ?? null,
      issuedAt: batch.issuedAt ?? null,
      paidAt: batch.paidAt ?? null,
      createdByUserId: batch.createdByUserId ?? null,
      totals: {
        recordsCount: totals.recordsCount,
        approvedHours: Math.round(totals.approvedHours * 100) / 100,
        invoiceAmount: Math.round(totals.invoiceAmount * 100) / 100,
        totalRevenueAmount: Math.round(totals.totalRevenueAmount * 100) / 100,
        missingRateCount: totals.missingRateCount,
      },
      timesheets: includeTimesheets ? timesheets : undefined,
    };
  }

  private async hydrateBatchFinancials(batch: InvoiceBatch) {
    if (batch.timesheets?.length) {
      await this.contractPricingService.applyFinancials(batch.timesheets);
    }
  }
}
