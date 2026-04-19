import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AuditLogService } from '../audit-log/audit-log.service';
import { CompanyService } from '../company/company.service';
import { PayRuleService } from '../pay-rule/pay-rule.service';
import { CreatePayrollBatchDto } from './dto/create-payroll-batch.dto';
import { PayrollBatch, PayrollBatchStatus } from './entities/payroll-batch.entity';
import { Timesheet, TimesheetPayrollStatus, TimesheetStatus } from '../timesheet/entities/timesheet.entity';

@Injectable()
export class PayrollBatchService {
  constructor(
    @InjectRepository(PayrollBatch) private readonly payrollBatchRepo: Repository<PayrollBatch>,
    @InjectRepository(Timesheet) private readonly timesheetRepo: Repository<Timesheet>,
    private readonly companyService: CompanyService,
    private readonly auditLogService: AuditLogService,
    private readonly payRuleService: PayRuleService,
  ) {}

  async createForCompany(userId: number, dto: CreatePayrollBatchDto) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      throw new BadRequestException('A valid batch period start and end are required.');
    }

    if (periodEnd.getTime() < periodStart.getTime()) {
      throw new BadRequestException('Payroll batch period end must be on or after period start.');
    }

    const uniqueIds = Array.from(new Set((dto.timesheetIds || []).filter((value) => Number.isInteger(value) && value > 0)));
    if (!uniqueIds.length) {
      throw new BadRequestException('Select at least one approved timesheet to create a payroll batch.');
    }

    const timesheets = await this.timesheetRepo.find({
      where: uniqueIds.map((id) => ({ id, company: { id: company.id } })),
    });

    if (timesheets.length !== uniqueIds.length) {
      throw new NotFoundException('One or more selected timesheets were not found for this company.');
    }

    timesheets.forEach((timesheet) => this.assertTimesheetBatchEligible(timesheet));

    const batch = this.payrollBatchRepo.create({
      company,
      periodStart,
      periodEnd,
      status: PayrollBatchStatus.DRAFT,
      notes: dto.notes?.trim() ? dto.notes.trim() : null,
      createdByUserId: userId,
      finalisedAt: null,
      paidAt: null,
    });

    const savedBatch = await this.payrollBatchRepo.save(batch);
    const now = new Date();
    const payRuleConfig = await this.payRuleService.getConfigForCompany(company.id);
    timesheets.forEach((timesheet) => {
      timesheet.approvedHoursSnapshot = timesheet.approvedHoursSnapshot ?? this.getApprovedHours(timesheet);
      timesheet.hourlyRateSnapshot = timesheet.hourlyRateSnapshot ?? this.getTimesheetRate(timesheet);
      const pay = this.payRuleService.calculatePay(timesheet, payRuleConfig);
      timesheet.payableHoursSnapshot = timesheet.payableHoursSnapshot ?? pay.payableHours;
      timesheet.payableAmountSnapshot = timesheet.payableAmountSnapshot ?? pay.payableAmount;
      timesheet.payrollBatch = savedBatch;
      timesheet.payrollStatus = TimesheetPayrollStatus.INCLUDED;
      timesheet.payrollIncludedAt = timesheet.payrollIncludedAt ?? now;
      timesheet.payrollPaidAt = null;
    });
    await this.timesheetRepo.save(timesheets);

    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'payroll_batch.created',
      entityType: 'payroll_batch',
      entityId: savedBatch.id,
      beforeData: null,
      afterData: {
        periodStart: savedBatch.periodStart,
        periodEnd: savedBatch.periodEnd,
        status: savedBatch.status,
        timesheetIds: timesheets.map((timesheet) => timesheet.id),
      },
    });

    await Promise.all(timesheets.map((timesheet) => this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'timesheet.added_to_payroll_batch',
      entityType: 'timesheet',
      entityId: timesheet.id,
      beforeData: { payrollBatchId: null, payrollStatus: TimesheetPayrollStatus.UNPAID },
      afterData: {
        payrollBatchId: savedBatch.id,
        payrollStatus: timesheet.payrollStatus,
        approvedHoursSnapshot: timesheet.approvedHoursSnapshot,
        hourlyRateSnapshot: timesheet.hourlyRateSnapshot,
        payableHoursSnapshot: timesheet.payableHoursSnapshot,
        payableAmountSnapshot: timesheet.payableAmountSnapshot,
      },
    })));

    return this.findOneForCompany(userId, savedBatch.id);
  }

  async listForCompany(userId: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const batches = await this.payrollBatchRepo.find({
      where: { company: { id: company.id } },
      relations: {
        timesheets: true,
      },
      order: { createdAt: 'DESC' },
    });

    return Promise.all(batches.map((batch) => this.toBatchSummary(batch, false)));
  }

  async findOneForCompany(userId: number, id: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const batch = await this.payrollBatchRepo.findOne({
      where: { id, company: { id: company.id } },
      relations: {
        timesheets: true,
      },
    });

    if (!batch) {
      throw new NotFoundException('Payroll batch not found');
    }

    return this.toBatchSummary(batch, true);
  }

  async finaliseForCompany(userId: number, id: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const batch = await this.payrollBatchRepo.findOne({
      where: { id, company: { id: company.id } },
      relations: {
        timesheets: true,
      },
    });

    if (!batch) {
      throw new NotFoundException('Payroll batch not found');
    }

    if (batch.status !== PayrollBatchStatus.DRAFT) {
      throw new ForbiddenException('Only draft payroll batches can be finalised.');
    }

    if (!batch.timesheets?.length) {
      throw new BadRequestException('A payroll batch must contain at least one timesheet before it can be finalised.');
    }

    const batchTimesheets = batch.timesheets;
    const beforeData = {
      status: batch.status,
      finalisedAt: batch.finalisedAt,
      timesheetIds: batchTimesheets.map((timesheet) => timesheet.id),
    };
    const now = new Date();
    batch.status = PayrollBatchStatus.FINALISED;
    batch.finalisedAt = now;
    batchTimesheets.forEach((timesheet) => {
      timesheet.payrollStatus = TimesheetPayrollStatus.INCLUDED;
      timesheet.payrollIncludedAt = timesheet.payrollIncludedAt ?? now;
      timesheet.payrollPaidAt = null;
    });

    await this.payrollBatchRepo.save(batch);
    await this.timesheetRepo.save(batchTimesheets);

    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'payroll_batch.finalised',
      entityType: 'payroll_batch',
      entityId: batch.id,
      beforeData,
      afterData: {
        status: batch.status,
        finalisedAt: batch.finalisedAt,
      },
    });

    return this.findOneForCompany(userId, batch.id);
  }

  async payForCompany(userId: number, id: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const batch = await this.payrollBatchRepo.findOne({
      where: { id, company: { id: company.id } },
      relations: {
        timesheets: true,
      },
    });

    if (!batch) {
      throw new NotFoundException('Payroll batch not found');
    }

    if (batch.status !== PayrollBatchStatus.FINALISED) {
      throw new ForbiddenException('Only finalised payroll batches can be marked paid.');
    }

    const batchTimesheets = batch.timesheets || [];
    const beforeData = {
      status: batch.status,
      paidAt: batch.paidAt,
      timesheetIds: batchTimesheets.map((timesheet) => timesheet.id),
    };
    const now = new Date();
    batch.status = PayrollBatchStatus.PAID;
    batch.paidAt = now;
    batchTimesheets.forEach((timesheet) => {
      timesheet.payrollStatus = TimesheetPayrollStatus.PAID;
      timesheet.payrollIncludedAt = timesheet.payrollIncludedAt ?? batch.finalisedAt ?? now;
      timesheet.payrollPaidAt = now;
    });

    await this.payrollBatchRepo.save(batch);
    await this.timesheetRepo.save(batchTimesheets);

    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'payroll_batch.paid',
      entityType: 'payroll_batch',
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
      action: 'timesheet.payroll_paid',
      entityType: 'timesheet',
      entityId: timesheet.id,
      beforeData: { payrollStatus: TimesheetPayrollStatus.INCLUDED, payrollPaidAt: null },
      afterData: { payrollStatus: timesheet.payrollStatus, payrollPaidAt: timesheet.payrollPaidAt, payrollBatchId: batch.id },
    })));

    return this.findOneForCompany(userId, batch.id);
  }

  private assertTimesheetBatchEligible(timesheet: Timesheet) {
    if (String(timesheet.approvalStatus).trim().toLowerCase() !== TimesheetStatus.APPROVED) {
      throw new ForbiddenException('Only approved timesheets can be attached to a payroll batch.');
    }

    if (String(timesheet.payrollStatus).trim().toLowerCase() === TimesheetPayrollStatus.PAID) {
      throw new ForbiddenException('Paid timesheets cannot be attached to a payroll batch.');
    }

    if (timesheet.payrollBatch) {
      const batchStatus = String(timesheet.payrollBatch.status || '').trim().toLowerCase();
      if (
        batchStatus === PayrollBatchStatus.DRAFT ||
        batchStatus === PayrollBatchStatus.FINALISED ||
        batchStatus === PayrollBatchStatus.PAID
      ) {
        throw new ForbiddenException('A selected timesheet is already attached to an existing payroll batch.');
      }
    }
  }

  private getTimesheetRate(timesheet: Timesheet) {
    if (timesheet.hourlyRateSnapshot !== undefined && timesheet.hourlyRateSnapshot !== null && Number.isFinite(Number(timesheet.hourlyRateSnapshot))) {
      return Number(timesheet.hourlyRateSnapshot);
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

  private async toBatchSummary(batch: PayrollBatch, includeTimesheets: boolean) {
    const timesheets = batch.timesheets || [];
    const payRuleConfig = batch.company?.id ? await this.payRuleService.getConfigForCompany(batch.company.id) : null;
    const totals = timesheets.reduce(
      (summary, timesheet) => {
        const approvedHours = this.getApprovedHours(timesheet);
        const pay = this.getPayCalculation(timesheet, payRuleConfig);
        summary.recordsCount += 1;
        summary.approvedHours += approvedHours;
        summary.payableHours += pay.payableHours;
        if (pay.payableAmount !== null) {
          summary.approvedAmount += pay.payableAmount;
          summary.totalCostAmount += pay.payableAmount;
        } else {
          summary.missingRateCount += 1;
        }
        return summary;
      },
      { recordsCount: 0, approvedHours: 0, payableHours: 0, approvedAmount: 0, totalCostAmount: 0, missingRateCount: 0 },
    );

    return {
      id: batch.id,
      companyId: batch.company?.id,
      periodStart: batch.periodStart,
      periodEnd: batch.periodEnd,
      status: batch.status,
      notes: batch.notes ?? null,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      finalisedAt: batch.finalisedAt ?? null,
      paidAt: batch.paidAt ?? null,
      createdByUserId: batch.createdByUserId ?? null,
      totals: {
        recordsCount: totals.recordsCount,
        approvedHours: Math.round(totals.approvedHours * 100) / 100,
        payableHours: Math.round(totals.payableHours * 100) / 100,
        approvedAmount: Math.round(totals.approvedAmount * 100) / 100,
        totalCostAmount: Math.round(totals.totalCostAmount * 100) / 100,
        missingRateCount: totals.missingRateCount,
      },
      timesheets: includeTimesheets ? timesheets : undefined,
    };
  }

  private getPayCalculation(timesheet: Timesheet, config: Awaited<ReturnType<PayRuleService['getConfigForCompany']>>) {
    const snapshotHours =
      timesheet.payableHoursSnapshot !== undefined && timesheet.payableHoursSnapshot !== null && Number.isFinite(Number(timesheet.payableHoursSnapshot))
        ? Number(timesheet.payableHoursSnapshot)
        : null;
    const snapshotAmount =
      timesheet.payableAmountSnapshot !== undefined && timesheet.payableAmountSnapshot !== null && Number.isFinite(Number(timesheet.payableAmountSnapshot))
        ? Number(timesheet.payableAmountSnapshot)
        : null;
    if (snapshotHours !== null) {
      return {
        payableHours: snapshotHours,
        payableAmount: snapshotAmount,
      };
    }
    const calculation = this.payRuleService.calculatePay(timesheet, config);
    return { payableHours: calculation.payableHours, payableAmount: calculation.payableAmount };
  }
}
