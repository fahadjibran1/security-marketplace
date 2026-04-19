import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLogService } from '../audit-log/audit-log.service';
import { Client } from '../client/entities/client.entity';
import { ClientPortalUserService } from '../client-portal-user/client-portal-user.service';
import { DailyLog, DailyLogType } from '../daily-log/entities/daily-log.entity';
import { Incident } from '../incident/entities/incident.entity';
import { InvoiceBatch } from '../invoice-batch/entities/invoice-batch.entity';
import { InvoiceBatchService } from '../invoice-batch/invoice-batch.service';
import { SafetyAlert, SafetyAlertType } from '../safety-alert/entities/safety-alert.entity';
import { Shift } from '../shift/entities/shift.entity';
import { Site } from '../site/entities/site.entity';
import { Timesheet, TimesheetStatus } from '../timesheet/entities/timesheet.entity';
import { ClientPortalQueryDto } from './dto/client-portal-query.dto';

@Injectable()
export class ClientPortalService {
  constructor(
    @InjectRepository(Site) private readonly siteRepo: Repository<Site>,
    @InjectRepository(Timesheet) private readonly timesheetRepo: Repository<Timesheet>,
    @InjectRepository(Incident) private readonly incidentRepo: Repository<Incident>,
    @InjectRepository(InvoiceBatch) private readonly invoiceBatchRepo: Repository<InvoiceBatch>,
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(SafetyAlert) private readonly alertRepo: Repository<SafetyAlert>,
    @InjectRepository(DailyLog) private readonly dailyLogRepo: Repository<DailyLog>,
    private readonly clientPortalUserService: ClientPortalUserService,
    private readonly invoiceBatchService: InvoiceBatchService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async getDashboard(clientPortalUserId: number) {
    const client = await this.getClient(clientPortalUserId);
    const [sites, serviceRecords, incidents, invoices] = await Promise.all([
      this.listSites(clientPortalUserId),
      this.listServiceRecords(clientPortalUserId, {}),
      this.listIncidents(clientPortalUserId, {}),
      this.listInvoices(clientPortalUserId),
    ]);

    const currentMonth = new Date();
    const currentMonthKey = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}`;
    const approvedHoursThisPeriod = serviceRecords
      .filter((record) => this.getMonthKey(record.shiftDate) === currentMonthKey)
      .reduce((sum, record) => sum + record.approvedHours, 0);
    const outstandingInvoices = invoices.filter((invoice) => ['issued', 'draft', 'finalised'].includes(String(invoice.status)));

    return {
      client: {
        id: client.id,
        name: client.name,
        contactName: client.contactName ?? null,
        contactEmail: client.contactEmail ?? null,
        contactPhone: client.contactPhone ?? null,
      },
      activeSites: sites.length,
      recentIncidents: incidents.slice(0, 5),
      approvedHoursThisPeriod: Math.round(approvedHoursThisPeriod * 100) / 100,
      invoicesSummary: {
        total: invoices.length,
        outstanding: outstandingInvoices.length,
        issued: invoices.filter((invoice) => invoice.status === 'issued').length,
      },
      welfareSummary: await this.getWelfareReport(clientPortalUserId, {}),
    };
  }

  async listSites(clientPortalUserId: number) {
    const client = await this.getClient(clientPortalUserId);
    const sites = await this.siteRepo.find({
      where: { client: { id: client.id } },
      order: { name: 'ASC' },
    });
    const siteIds = sites.map((site) => site.id);
    const [incidents, shifts] = await Promise.all([
      siteIds.length ? this.incidentRepo.find({ where: siteIds.map((id) => ({ site: { id } })), order: { reportedAt: 'DESC' } }) : [],
      siteIds.length ? this.shiftRepo.find({ where: siteIds.map((id) => ({ site: { id } })), order: { start: 'DESC' } }) : [],
    ]);

    return sites.map((site) => {
      const siteIncidents = incidents.filter((incident) => incident.site?.id === site.id);
      const upcomingShifts = shifts.filter((shift) => shift.site?.id === site.id && new Date(shift.end).getTime() >= Date.now());
      return {
        id: site.id,
        name: site.name,
        address: site.address,
        status: site.status,
        requiredGuardCount: site.requiredGuardCount,
        welfareCheckIntervalMinutes: site.welfareCheckIntervalMinutes,
        recentIncidents: siteIncidents.length,
        openIncidents: siteIncidents.filter((incident) => !['resolved', 'closed'].includes(String(incident.status))).length,
        upcomingShifts: upcomingShifts.length,
      };
    });
  }

  async listServiceRecords(clientPortalUserId: number, query: ClientPortalQueryDto) {
    const client = await this.getClient(clientPortalUserId);
    const timesheets = await this.timesheetRepo.find({
      where: { company: { id: client.company.id } },
      order: { createdAt: 'DESC' },
    });
    const { startDate, endDate } = this.parseRange(query);

    return timesheets
      .filter((timesheet) => String(timesheet.approvalStatus).trim().toLowerCase() === TimesheetStatus.APPROVED)
      .filter((timesheet) => this.getTimesheetClientId(timesheet) === client.id)
      .filter((timesheet) => !query.siteId || this.getTimesheetSiteId(timesheet) === query.siteId)
      .filter((timesheet) => this.matchesDate(this.getTimesheetDate(timesheet), startDate, endDate))
      .map((timesheet) => ({
        id: timesheet.id,
        siteId: this.getTimesheetSiteId(timesheet),
        siteName: this.getTimesheetSiteName(timesheet),
        shiftDate: this.getTimesheetDate(timesheet),
        periodKey: this.getMonthKey(this.getTimesheetDate(timesheet)),
        approvedHours: this.getApprovedHours(timesheet),
        status: 'approved',
      }));
  }

  async listIncidents(clientPortalUserId: number, query: ClientPortalQueryDto) {
    const client = await this.getClient(clientPortalUserId);
    const incidents = await this.incidentRepo.find({
      where: { company: { id: client.company.id } },
      order: { reportedAt: 'DESC' },
    });
    const { startDate, endDate } = this.parseRange(query);

    return incidents
      .filter((incident) => this.getIncidentClientId(incident) === client.id)
      .filter((incident) => !query.siteId || this.getIncidentSiteId(incident) === query.siteId)
      .filter((incident) => this.matchesDate(incident.reportedAt, startDate, endDate))
      .map((incident) => ({
        id: incident.id,
        title: incident.title,
        summary: this.toClientSafeSummary(incident.notes),
        category: incident.category,
        severity: incident.severity,
        status: incident.status,
        siteName: incident.site?.name || incident.shift?.site?.name || incident.shift?.siteName || 'Site unavailable',
        reportedAt: incident.reportedAt,
      }));
  }

  async listInvoices(clientPortalUserId: number) {
    const client = await this.getClient(clientPortalUserId);
    const invoices = await this.invoiceBatchRepo.find({
      where: { client: { id: client.id } },
      order: { createdAt: 'DESC' },
    });

    return invoices.map((invoice) => ({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber ?? invoice.invoiceReference ?? `INV-${invoice.id}`,
      issueDate: invoice.issuedAt ?? invoice.finalisedAt ?? invoice.createdAt,
      dueDate: invoice.dueDate ?? null,
      amount: invoice.grossAmountSnapshot ?? invoice.netAmountSnapshot ?? 0,
      currency: invoice.currency ?? 'GBP',
      status: invoice.status,
    }));
  }

  async getInvoiceDocument(clientPortalUserId: number, invoiceBatchId: number) {
    const clientUser = await this.clientPortalUserService.findById(clientPortalUserId);
    const document = await this.invoiceBatchService.getDocumentForClient(clientUser.client.id, invoiceBatchId);
    await this.auditLogService.log({
      company: { id: clientUser.client.company.id },
      user: null,
      action: 'client_portal.invoice_document_viewed',
      entityType: 'invoice_batch',
      entityId: invoiceBatchId,
      afterData: {
        clientId: clientUser.client.id,
        clientPortalUserId,
      },
    });
    return document;
  }

  async getServiceHoursReport(clientPortalUserId: number, query: ClientPortalQueryDto) {
    const rows = await this.listServiceRecords(clientPortalUserId, query);
    const grouped = new Map<string, { site: string; period: string; approvedHours: number }>();
    rows.forEach((row) => {
      const key = `${row.siteName}|${row.periodKey}`;
      const current = grouped.get(key) || { site: row.siteName, period: row.periodKey, approvedHours: 0 };
      current.approvedHours += row.approvedHours;
      grouped.set(key, current);
    });
    return Array.from(grouped.values()).sort((left, right) => right.period.localeCompare(left.period));
  }

  async getIncidentSummaryReport(clientPortalUserId: number, query: ClientPortalQueryDto) {
    return this.listIncidents(clientPortalUserId, query);
  }

  async getWelfareReport(clientPortalUserId: number, query: ClientPortalQueryDto) {
    const client = await this.getClient(clientPortalUserId);
    const sites = await this.siteRepo.find({ where: { client: { id: client.id } } });
    const allowedSiteIds = new Set(sites.map((site) => site.id));
    const { startDate, endDate } = this.parseRange(query);
    const shifts = (await this.shiftRepo.find({
      where: { company: { id: client.company.id } },
      order: { start: 'DESC' },
    }))
      .filter((shift) => shift.site?.id && allowedSiteIds.has(shift.site.id))
      .filter((shift) => !query.siteId || shift.site?.id === query.siteId)
      .filter((shift) => this.matchesDate(shift.start, startDate, endDate));

    const shiftIds = shifts.map((shift) => shift.id);
    const [logs, alerts] = await Promise.all([
      shiftIds.length ? this.dailyLogRepo.find({ where: shiftIds.map((id) => ({ shift: { id } })) }) : [],
      shiftIds.length ? this.alertRepo.find({ where: shiftIds.map((id) => ({ shift: { id } })) }) : [],
    ]);

    return shifts.map((shift) => {
      const shiftLogs = logs.filter((log) => log.shift.id === shift.id);
      const shiftAlerts = alerts.filter((alert) => alert.shift?.id === shift.id);
      const expected = this.getExpectedCheckCalls(shift);
      const completed = shiftLogs.filter((log) => log.logType === DailyLogType.CHECK_CALL).length;
      const missed = Math.max(
        shiftAlerts.filter((alert) => alert.type === SafetyAlertType.MISSED_CHECKCALL).length,
        expected - completed,
        0,
      );
      return {
        shiftId: shift.id,
        site: shift.site?.name || shift.siteName || 'Site unavailable',
        period: this.getMonthKey(shift.start),
        expectedCheckCalls: expected,
        completedCheckCalls: completed,
        missedCheckCalls: missed,
        complianceRate: expected > 0 ? Math.round((completed / expected) * 10000) / 100 : 100,
        welfareAlerts: shiftAlerts.filter((alert) => alert.type === SafetyAlertType.WELFARE).length,
      };
    });
  }

  private async getClient(clientPortalUserId: number): Promise<Client> {
    const user = await this.clientPortalUserService.findById(clientPortalUserId);
    if (!user.isActive) throw new NotFoundException('Client portal user not found');
    return user.client;
  }

  private parseRange(query: ClientPortalQueryDto) {
    const startDate = query.startDate ? new Date(query.startDate) : null;
    const endDate = query.endDate ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(query.endDate) ? `${query.endDate}T23:59:59` : query.endDate) : null;
    return { startDate, endDate };
  }

  private matchesDate(value: Date | string | null | undefined, startDate: Date | null, endDate: Date | null) {
    if (!value) return true;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return true;
    if (startDate && date.getTime() < startDate.getTime()) return false;
    if (endDate && date.getTime() > endDate.getTime()) return false;
    return true;
  }

  private getTimesheetClientId(timesheet: Timesheet) {
    return timesheet.shift?.site?.client?.id ?? timesheet.shift?.job?.site?.client?.id ?? timesheet.shift?.assignment?.job?.site?.client?.id ?? null;
  }

  private getTimesheetSiteId(timesheet: Timesheet) {
    return timesheet.shift?.site?.id ?? timesheet.shift?.job?.site?.id ?? timesheet.shift?.assignment?.job?.site?.id ?? null;
  }

  private getTimesheetSiteName(timesheet: Timesheet) {
    return timesheet.shift?.site?.name || timesheet.shift?.siteName || timesheet.shift?.job?.site?.name || timesheet.shift?.assignment?.job?.site?.name || 'Site unavailable';
  }

  private getTimesheetDate(timesheet: Timesheet) {
    return (timesheet.scheduledStartAt ?? timesheet.shift?.start ?? timesheet.createdAt)?.toString?.() ? new Date(timesheet.scheduledStartAt ?? timesheet.shift?.start ?? timesheet.createdAt).toISOString() : timesheet.createdAt.toISOString();
  }

  private getApprovedHours(timesheet: Timesheet) {
    if (timesheet.approvedHours !== null && timesheet.approvedHours !== undefined && Number.isFinite(Number(timesheet.approvedHours))) {
      return Number(timesheet.approvedHours);
    }
    return Number(timesheet.hoursWorked) || 0;
  }

  private getIncidentClientId(incident: Incident) {
    return incident.site?.client?.id ?? incident.shift?.site?.client?.id ?? null;
  }

  private getIncidentSiteId(incident: Incident) {
    return incident.site?.id ?? incident.shift?.site?.id ?? null;
  }

  private toClientSafeSummary(notes?: string | null) {
    const text = (notes || '').trim();
    if (!text) return 'Operational update recorded.';
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  }

  private getMonthKey(value: Date | string) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'unknown';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  private getExpectedCheckCalls(shift: Shift) {
    const interval = Number(shift.checkCallIntervalMinutes || 0);
    if (!Number.isFinite(interval) || interval <= 0) return 0;
    const durationMinutes = Math.max(Math.round((shift.end.getTime() - shift.start.getTime()) / 60000), 0);
    return Math.floor(durationMinutes / interval);
  }
}
