import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLogService } from '../audit-log/audit-log.service';
import { Client } from '../client/entities/client.entity';
import { CompanyService } from '../company/company.service';
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
      createdByUserId: userId,
      finalisedAt: null,
      issuedAt: null,
      paidAt: null,
    });

    const savedBatch = await this.invoiceBatchRepo.save(batch);
    timesheets.forEach((timesheet) => {
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
      afterData: {
        clientId: client.id,
        periodStart: savedBatch.periodStart,
        periodEnd: savedBatch.periodEnd,
        status: savedBatch.status,
        timesheetIds: timesheets.map((timesheet) => timesheet.id),
      },
    });

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

    batch.status = InvoiceBatchStatus.FINALISED;
    batch.finalisedAt = new Date();
    await this.invoiceBatchRepo.save(batch);

    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'invoice_batch.finalised',
      entityType: 'invoice_batch',
      entityId: batch.id,
      afterData: {
        status: batch.status,
        finalisedAt: batch.finalisedAt,
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
      afterData: {
        status: batch.status,
        issuedAt: batch.issuedAt,
      },
    });

    return this.findOneForCompany(userId, batch.id);
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
      afterData: {
        status: batch.status,
        paidAt: batch.paidAt,
      },
    });

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
    if (timesheet.approvedHours !== undefined && timesheet.approvedHours !== null && Number.isFinite(Number(timesheet.approvedHours))) {
      return Number(timesheet.approvedHours);
    }

    if (String(timesheet.approvalStatus).trim().toLowerCase() === TimesheetStatus.APPROVED) {
      return Number(timesheet.hoursWorked) || 0;
    }

    return 0;
  }

  private toBatchSummary(batch: InvoiceBatch, includeTimesheets: boolean) {
    const timesheets = batch.timesheets || [];
    const totals = timesheets.reduce(
      (summary, timesheet) => {
        const approvedHours = this.getApprovedHours(timesheet);
        const rate = this.getBillingRate(timesheet);
        summary.recordsCount += 1;
        summary.approvedHours += approvedHours;
        if (rate !== null) {
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
      notes: batch.notes ?? null,
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
}
