import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AttendanceEvent, AttendanceEventType } from '../attendance/entities/attendance.entity';
import { CompanyService } from '../company/company.service';
import { DailyLog, DailyLogType } from '../daily-log/entities/daily-log.entity';
import { Incident, IncidentSeverity } from '../incident/entities/incident.entity';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';
import { SafetyAlert, SafetyAlertType } from '../safety-alert/entities/safety-alert.entity';
import { Shift } from '../shift/entities/shift.entity';
import { AnalyticsReportQueryDto } from './dto/analytics-report-query.dto';

type IncidentRecordRow = {
  id: number;
  reportedAt: string;
  site: string;
  client: string;
  guard: string;
  category: string;
  severity: string;
  notes: string;
};

type WelfareShiftRow = {
  shiftId: number;
  shiftDate: string;
  site: string;
  client: string;
  guard: string;
  expectedCheckCalls: number;
  completedCheckCalls: number;
  missedCheckCalls: number;
  complianceRate: number;
  lateCheckIn: boolean;
  welfareAlerts: number;
  panicAlerts: number;
};

type SiteRiskRow = {
  siteId: number | null;
  site: string;
  client: string;
  incidents: number;
  highSeverityIncidents: number;
  missedCheckCalls: number;
  welfareAlerts: number;
  panicAlerts: number;
  lateCheckIns: number;
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high';
};

type IncidentAnalyticsReport = {
  totalIncidents: number;
  byCategory: Array<{ key: string; count: number }>;
  bySeverity: Array<{ key: string; count: number }>;
  bySite: Array<{ siteId: number | null; site: string; client: string; count: number; highSeverityCount: number }>;
  byClient: Array<{ clientId: number | null; client: string; count: number; highSeverityCount: number }>;
  byGuard: Array<{ guardId: number | null; guard: string; count: number; highSeverityCount: number }>;
  trends: Array<{ period: string; count: number }>;
  highRiskSites: Array<{ siteId: number | null; site: string; client: string; count: number; highSeverityCount: number }>;
  records: IncidentRecordRow[];
};

type WelfareAnalyticsReport = {
  expectedCheckCalls: number;
  completedCheckCalls: number;
  missedCheckCalls: number;
  checkCallComplianceRate: number;
  panicAlerts: number;
  welfareAlerts: number;
  lateCheckIns: number;
  bySite: Array<{ siteId: number | null; site: string; client: string; expected: number; completed: number; missed: number; complianceRate: number; lateCheckIns: number }>;
  byGuard: Array<{ guardId: number | null; guard: string; expected: number; completed: number; missed: number; complianceRate: number; lateCheckIns: number }>;
  trends: Array<{ period: string; panicAlerts: number; welfareAlerts: number; missedCheckCalls: number; lateCheckIns: number }>;
  records: WelfareShiftRow[];
};

type SiteRiskReport = {
  sites: SiteRiskRow[];
  summary: {
    lowRisk: number;
    mediumRisk: number;
    highRisk: number;
    totalIncidents: number;
    totalAlerts: number;
    totalMissedCheckCalls: number;
  };
};

type ScopedOperationalData = {
  company: Awaited<ReturnType<CompanyService['findByUserId']>>;
  incidents: Incident[];
  alerts: SafetyAlert[];
  shifts: Shift[];
  attendance: AttendanceEvent[];
  logs: DailyLog[];
};

const SEVERITY_WEIGHT: Record<string, number> = {
  [IncidentSeverity.LOW]: 1,
  [IncidentSeverity.MEDIUM]: 2,
  [IncidentSeverity.HIGH]: 4,
  [IncidentSeverity.CRITICAL]: 6,
};

@Injectable()
export class IncidentAnalyticsService {
  constructor(
    @InjectRepository(Incident) private readonly incidentRepo: Repository<Incident>,
    @InjectRepository(SafetyAlert) private readonly alertRepo: Repository<SafetyAlert>,
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(AttendanceEvent) private readonly attendanceRepo: Repository<AttendanceEvent>,
    @InjectRepository(DailyLog) private readonly dailyLogRepo: Repository<DailyLog>,
    private readonly companyService: CompanyService,
    private readonly notificationService: NotificationService,
  ) {}

  async getIncidentReport(userId: number, query: AnalyticsReportQueryDto): Promise<IncidentAnalyticsReport> {
    const scoped = await this.loadScopedData(userId, query);
    const byCategory = new Map<string, number>();
    const bySeverity = new Map<string, number>();
    const bySite = new Map<string, { siteId: number | null; site: string; client: string; count: number; highSeverityCount: number }>();
    const byClient = new Map<string, { clientId: number | null; client: string; count: number; highSeverityCount: number }>();
    const byGuard = new Map<string, { guardId: number | null; guard: string; count: number; highSeverityCount: number }>();
    const trends = new Map<string, number>();
    const records: IncidentRecordRow[] = [];

    scoped.incidents.forEach((incident) => {
      const category = String(incident.category || 'other');
      const severity = String(incident.severity || 'medium');
      const siteName = incident.site?.name || incident.shift?.site?.name || incident.shift?.siteName || 'Site unavailable';
      const siteId = incident.site?.id ?? incident.shift?.site?.id ?? null;
      const client = incident.site?.client?.name || incident.shift?.site?.client?.name || incident.site?.clientName || incident.shift?.site?.clientName || 'Client unavailable';
      const clientId = incident.site?.client?.id ?? incident.shift?.site?.client?.id ?? null;
      const guardName = incident.guard?.fullName || 'Guard unavailable';
      const guardId = incident.guard?.id ?? null;
      const period = this.getPeriodKey(incident.reportedAt);
      const highSeverity = this.isHighSeverity(incident.severity);

      byCategory.set(category, (byCategory.get(category) || 0) + 1);
      bySeverity.set(severity, (bySeverity.get(severity) || 0) + 1);
      trends.set(period, (trends.get(period) || 0) + 1);

      const siteKey = String(siteId ?? `site:${siteName}`);
      const siteEntry = bySite.get(siteKey) || { siteId, site: siteName, client, count: 0, highSeverityCount: 0 };
      siteEntry.count += 1;
      if (highSeverity) siteEntry.highSeverityCount += 1;
      bySite.set(siteKey, siteEntry);

      const clientKey = String(clientId ?? `client:${client}`);
      const clientEntry = byClient.get(clientKey) || { clientId, client, count: 0, highSeverityCount: 0 };
      clientEntry.count += 1;
      if (highSeverity) clientEntry.highSeverityCount += 1;
      byClient.set(clientKey, clientEntry);

      const guardKey = String(guardId ?? `guard:${guardName}`);
      const guardEntry = byGuard.get(guardKey) || { guardId, guard: guardName, count: 0, highSeverityCount: 0 };
      guardEntry.count += 1;
      if (highSeverity) guardEntry.highSeverityCount += 1;
      byGuard.set(guardKey, guardEntry);

      records.push({
        id: incident.id,
        reportedAt: incident.reportedAt?.toISOString?.() || String(incident.reportedAt),
        site: siteName,
        client,
        guard: guardName,
        category,
        severity,
        notes: incident.notes || '',
      });
    });

    return {
      totalIncidents: scoped.incidents.length,
      byCategory: this.sortCountMap(byCategory),
      bySeverity: this.sortCountMap(bySeverity),
      bySite: Array.from(bySite.values()).sort((left, right) => right.count - left.count),
      byClient: Array.from(byClient.values()).sort((left, right) => right.count - left.count),
      byGuard: Array.from(byGuard.values()).sort((left, right) => right.count - left.count),
      trends: Array.from(trends.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([period, count]) => ({ period, count })),
      highRiskSites: Array.from(bySite.values())
        .sort((left, right) => right.highSeverityCount - left.highSeverityCount || right.count - left.count)
        .slice(0, 8),
      records: records.sort((left, right) => right.reportedAt.localeCompare(left.reportedAt)),
    };
  }

  async getWelfareReport(userId: number, query: AnalyticsReportQueryDto): Promise<WelfareAnalyticsReport> {
    const scoped = await this.loadScopedData(userId, query);
    const shiftRows = this.buildWelfareRows(scoped);
    const bySite = new Map<string, { siteId: number | null; site: string; client: string; expected: number; completed: number; missed: number; complianceRate: number; lateCheckIns: number }>();
    const byGuard = new Map<string, { guardId: number | null; guard: string; expected: number; completed: number; missed: number; complianceRate: number; lateCheckIns: number }>();
    const trends = new Map<string, { panicAlerts: number; welfareAlerts: number; missedCheckCalls: number; lateCheckIns: number }>();

    let expectedCheckCalls = 0;
    let completedCheckCalls = 0;
    let missedCheckCalls = 0;
    let panicAlerts = 0;
    let welfareAlerts = 0;
    let lateCheckIns = 0;

    shiftRows.forEach((row) => {
      expectedCheckCalls += row.expectedCheckCalls;
      completedCheckCalls += row.completedCheckCalls;
      missedCheckCalls += row.missedCheckCalls;
      panicAlerts += row.panicAlerts;
      welfareAlerts += row.welfareAlerts;
      lateCheckIns += row.lateCheckIn ? 1 : 0;

      const siteKey = `${row.site}|${row.client}`;
      const siteEntry = bySite.get(siteKey) || {
        siteId: scoped.shifts.find((shift) => shift.id === row.shiftId)?.site?.id ?? null,
        site: row.site,
        client: row.client,
        expected: 0,
        completed: 0,
        missed: 0,
        complianceRate: 0,
        lateCheckIns: 0,
      };
      siteEntry.expected += row.expectedCheckCalls;
      siteEntry.completed += row.completedCheckCalls;
      siteEntry.missed += row.missedCheckCalls;
      siteEntry.lateCheckIns += row.lateCheckIn ? 1 : 0;
      bySite.set(siteKey, siteEntry);

      const guardKey = row.guard;
      const guardEntry = byGuard.get(guardKey) || {
        guardId: scoped.shifts.find((shift) => shift.id === row.shiftId)?.guard?.id ?? null,
        guard: row.guard,
        expected: 0,
        completed: 0,
        missed: 0,
        complianceRate: 0,
        lateCheckIns: 0,
      };
      guardEntry.expected += row.expectedCheckCalls;
      guardEntry.completed += row.completedCheckCalls;
      guardEntry.missed += row.missedCheckCalls;
      guardEntry.lateCheckIns += row.lateCheckIn ? 1 : 0;
      byGuard.set(guardKey, guardEntry);

      const period = this.getPeriodKey(row.shiftDate);
      const trendEntry = trends.get(period) || { panicAlerts: 0, welfareAlerts: 0, missedCheckCalls: 0, lateCheckIns: 0 };
      trendEntry.panicAlerts += row.panicAlerts;
      trendEntry.welfareAlerts += row.welfareAlerts;
      trendEntry.missedCheckCalls += row.missedCheckCalls;
      trendEntry.lateCheckIns += row.lateCheckIn ? 1 : 0;
      trends.set(period, trendEntry);
    });

    const normalizeCompliance = (expected: number, completed: number) =>
      expected > 0 ? this.roundPercent((completed / expected) * 100) : 100;

    Array.from(bySite.values()).forEach((entry) => {
      entry.complianceRate = normalizeCompliance(entry.expected, entry.completed);
    });

    Array.from(byGuard.values()).forEach((entry) => {
      entry.complianceRate = normalizeCompliance(entry.expected, entry.completed);
    });

    await this.emitThresholdNotifications(scoped.company!.user?.id ?? null, scoped.company?.id ?? null, {
      highestRiskSite: null,
      totalMissedCheckCalls: missedCheckCalls,
    });

    return {
      expectedCheckCalls,
      completedCheckCalls,
      missedCheckCalls,
      checkCallComplianceRate: normalizeCompliance(expectedCheckCalls, completedCheckCalls),
      panicAlerts,
      welfareAlerts,
      lateCheckIns,
      bySite: Array.from(bySite.values()).sort((left, right) => right.missed - left.missed || left.complianceRate - right.complianceRate),
      byGuard: Array.from(byGuard.values()).sort((left, right) => right.missed - left.missed || left.complianceRate - right.complianceRate),
      trends: Array.from(trends.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([period, entry]) => ({ period, ...entry })),
      records: shiftRows.sort((left, right) => right.shiftDate.localeCompare(left.shiftDate)),
    };
  }

  async getSiteRiskReport(userId: number, query: AnalyticsReportQueryDto): Promise<SiteRiskReport> {
    const scoped = await this.loadScopedData(userId, query);
    const welfareRows = this.buildWelfareRows(scoped);
    const riskMap = new Map<string, SiteRiskRow>();

    scoped.incidents.forEach((incident) => {
      const siteId = incident.site?.id ?? incident.shift?.site?.id ?? null;
      const site = incident.site?.name || incident.shift?.site?.name || incident.shift?.siteName || 'Site unavailable';
      const client = incident.site?.client?.name || incident.shift?.site?.client?.name || incident.site?.clientName || incident.shift?.site?.clientName || 'Client unavailable';
      const key = String(siteId ?? site);
      const row = riskMap.get(key) || {
        siteId,
        site,
        client,
        incidents: 0,
        highSeverityIncidents: 0,
        missedCheckCalls: 0,
        welfareAlerts: 0,
        panicAlerts: 0,
        lateCheckIns: 0,
        riskScore: 0,
        riskLevel: 'low',
      };
      row.incidents += 1;
      if (this.isHighSeverity(incident.severity)) row.highSeverityIncidents += 1;
      row.riskScore += SEVERITY_WEIGHT[String(incident.severity || IncidentSeverity.MEDIUM)] || 1;
      riskMap.set(key, row);
    });

    welfareRows.forEach((row) => {
      const shift = scoped.shifts.find((entry) => entry.id === row.shiftId);
      const siteId = shift?.site?.id ?? null;
      const key = String(siteId ?? row.site);
      const entry = riskMap.get(key) || {
        siteId,
        site: row.site,
        client: row.client,
        incidents: 0,
        highSeverityIncidents: 0,
        missedCheckCalls: 0,
        welfareAlerts: 0,
        panicAlerts: 0,
        lateCheckIns: 0,
        riskScore: 0,
        riskLevel: 'low',
      };

      entry.missedCheckCalls += row.missedCheckCalls;
      entry.welfareAlerts += row.welfareAlerts;
      entry.panicAlerts += row.panicAlerts;
      entry.lateCheckIns += row.lateCheckIn ? 1 : 0;
      entry.riskScore += row.missedCheckCalls * 3 + row.welfareAlerts * 2 + row.panicAlerts * 5 + (row.lateCheckIn ? 2 : 0);
      riskMap.set(key, entry);
    });

    const sites = Array.from(riskMap.values())
      .map((row) => ({
        ...row,
        riskScore: Math.round(row.riskScore * 100) / 100,
        riskLevel: this.getRiskLevel(row.riskScore),
      }))
      .sort((left, right) => right.riskScore - left.riskScore || right.incidents - left.incidents);

    await this.emitThresholdNotifications(scoped.company!.user?.id ?? null, scoped.company?.id ?? null, {
      highestRiskSite: sites[0] && sites[0].riskLevel === 'high' ? sites[0] : null,
      totalMissedCheckCalls: sites.reduce((sum, site) => sum + site.missedCheckCalls, 0),
    });

    return {
      sites,
      summary: {
        lowRisk: sites.filter((site) => site.riskLevel === 'low').length,
        mediumRisk: sites.filter((site) => site.riskLevel === 'medium').length,
        highRisk: sites.filter((site) => site.riskLevel === 'high').length,
        totalIncidents: sites.reduce((sum, site) => sum + site.incidents, 0),
        totalAlerts: sites.reduce((sum, site) => sum + site.welfareAlerts + site.panicAlerts + site.lateCheckIns, 0),
        totalMissedCheckCalls: sites.reduce((sum, site) => sum + site.missedCheckCalls, 0),
      },
    };
  }

  private async loadScopedData(userId: number, query: AnalyticsReportQueryDto): Promise<ScopedOperationalData> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const startDate = this.parseOptionalDate(query.startDate, false);
    const endDate = this.parseOptionalDate(query.endDate, true);

    const [incidents, alerts, shifts, attendance, logs] = await Promise.all([
      this.incidentRepo.find({ where: { company: { id: company.id } }, order: { reportedAt: 'DESC' } }),
      this.alertRepo.find({ where: { company: { id: company.id } }, order: { createdAt: 'DESC' } }),
      this.shiftRepo.find({ where: { company: { id: company.id } }, order: { start: 'DESC' } }),
      this.attendanceRepo.find({ where: { shift: { company: { id: company.id } } }, order: { occurredAt: 'DESC' } }),
      this.dailyLogRepo.find({ where: { company: { id: company.id } }, order: { createdAt: 'DESC' } }),
    ]);

    const shiftMatches = (shift: Shift | null | undefined) => {
      if (!shift) return false;
      if (startDate && shift.end.getTime() < startDate.getTime()) return false;
      if (endDate && shift.start.getTime() > endDate.getTime()) return false;
      if (query.siteId && shift.site?.id !== query.siteId) return false;
      if (query.clientId && shift.site?.client?.id !== query.clientId) return false;
      if (query.guardId && shift.guard?.id !== query.guardId && shift.assignment?.guard?.id !== query.guardId) return false;
      return true;
    };

    const filteredShifts = shifts.filter((shift) => shiftMatches(shift));
    const allowedShiftIds = new Set(filteredShifts.map((shift) => shift.id));

    const filteredIncidents = incidents.filter((incident) => {
      const incidentDate = incident.reportedAt ? new Date(incident.reportedAt) : null;
      if (startDate && incidentDate && incidentDate.getTime() < startDate.getTime()) return false;
      if (endDate && incidentDate && incidentDate.getTime() > endDate.getTime()) return false;
      if (query.siteId && incident.site?.id !== query.siteId && incident.shift?.site?.id !== query.siteId) return false;
      if (query.clientId && incident.site?.client?.id !== query.clientId && incident.shift?.site?.client?.id !== query.clientId) return false;
      if (query.guardId && incident.guard?.id !== query.guardId) return false;
      if (incident.shift?.id && allowedShiftIds.size > 0 && !allowedShiftIds.has(incident.shift.id)) return false;
      return true;
    });

    const filteredAlerts = alerts.filter((alert) => {
      const alertDate = alert.createdAt ? new Date(alert.createdAt) : null;
      if (startDate && alertDate && alertDate.getTime() < startDate.getTime()) return false;
      if (endDate && alertDate && alertDate.getTime() > endDate.getTime()) return false;
      if (query.siteId && alert.shift?.site?.id !== query.siteId) return false;
      if (query.clientId && alert.shift?.site?.client?.id !== query.clientId) return false;
      if (query.guardId && alert.guard?.id !== query.guardId) return false;
      if (alert.shift?.id && allowedShiftIds.size > 0 && !allowedShiftIds.has(alert.shift.id)) return false;
      return true;
    });

    const filteredAttendance = attendance.filter((event) => allowedShiftIds.has(event.shift.id));
    const filteredLogs = logs.filter((log) => allowedShiftIds.has(log.shift.id));

    return {
      company,
      incidents: filteredIncidents,
      alerts: filteredAlerts,
      shifts: filteredShifts,
      attendance: filteredAttendance,
      logs: filteredLogs,
    };
  }

  private buildWelfareRows(scoped: ScopedOperationalData): WelfareShiftRow[] {
    const attendanceByShift = new Map<number, AttendanceEvent[]>();
    const logsByShift = new Map<number, DailyLog[]>();
    const alertsByShift = new Map<number, SafetyAlert[]>();

    scoped.attendance.forEach((event) => {
      const rows = attendanceByShift.get(event.shift.id) || [];
      rows.push(event);
      attendanceByShift.set(event.shift.id, rows);
    });

    scoped.logs.forEach((log) => {
      const rows = logsByShift.get(log.shift.id) || [];
      rows.push(log);
      logsByShift.set(log.shift.id, rows);
    });

    scoped.alerts.forEach((alert) => {
      if (!alert.shift?.id) return;
      const rows = alertsByShift.get(alert.shift.id) || [];
      rows.push(alert);
      alertsByShift.set(alert.shift.id, rows);
    });

    return scoped.shifts.map((shift) => {
      const logs = logsByShift.get(shift.id) || [];
      const alerts = alertsByShift.get(shift.id) || [];
      const attendance = (attendanceByShift.get(shift.id) || []).slice().sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
      const checkCallLogs = logs.filter((log) => log.logType === DailyLogType.CHECK_CALL).length;
      const missedCheckCallAlerts = alerts.filter((alert) => alert.type === SafetyAlertType.MISSED_CHECKCALL).length;
      const welfareAlerts = alerts.filter((alert) => alert.type === SafetyAlertType.WELFARE).length;
      const panicAlerts = alerts.filter((alert) => alert.type === SafetyAlertType.PANIC).length;
      const lateAlerts = alerts.filter((alert) => alert.type === SafetyAlertType.LATE_CHECKIN).length;
      const expectedCheckCalls = this.getExpectedCheckCalls(shift);
      const missedFromGap = Math.max(expectedCheckCalls - checkCallLogs, 0);
      const missedCheckCalls = Math.max(missedFromGap, missedCheckCallAlerts);
      const firstCheckIn = attendance.find((event) => event.type === AttendanceEventType.CHECK_IN);
      const lateCheckIn = !!firstCheckIn
        ? firstCheckIn.occurredAt.getTime() - shift.start.getTime() > 10 * 60 * 1000
        : lateAlerts > 0;

      return {
        shiftId: shift.id,
        shiftDate: shift.start.toISOString(),
        site: shift.site?.name || shift.siteName || 'Site unavailable',
        client: shift.site?.client?.name || shift.site?.clientName || 'Client unavailable',
        guard: shift.guard?.fullName || shift.assignment?.guard?.fullName || 'Unassigned',
        expectedCheckCalls,
        completedCheckCalls: checkCallLogs,
        missedCheckCalls,
        complianceRate: expectedCheckCalls > 0 ? this.roundPercent((checkCallLogs / expectedCheckCalls) * 100) : 100,
        lateCheckIn,
        welfareAlerts,
        panicAlerts,
      };
    });
  }

  private getExpectedCheckCalls(shift: Shift) {
    const interval = Number(shift.checkCallIntervalMinutes || 0);
    if (!Number.isFinite(interval) || interval <= 0) return 0;
    const durationMinutes = Math.max(Math.round((shift.end.getTime() - shift.start.getTime()) / 60000), 0);
    return Math.floor(durationMinutes / interval);
  }

  private getPeriodKey(value: Date | string) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'unknown';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  private isHighSeverity(severity?: string | null) {
    const normalized = String(severity || '').toLowerCase();
    return normalized === IncidentSeverity.HIGH || normalized === IncidentSeverity.CRITICAL;
  }

  private getRiskLevel(score: number): 'low' | 'medium' | 'high' {
    if (score >= 20) return 'high';
    if (score >= 8) return 'medium';
    return 'low';
  }

  private roundPercent(value: number) {
    return Math.round(value * 100) / 100;
  }

  private sortCountMap(map: Map<string, number>) {
    return Array.from(map.entries())
      .sort(([, left], [, right]) => right - left)
      .map(([key, count]) => ({ key, count }));
  }

  private parseOptionalDate(value: string | undefined, endOfDay: boolean) {
    if (!value) return null;
    const date = new Date(endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59` : value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date;
  }

  private async emitThresholdNotifications(
    userId: number | null,
    companyId: number | null,
    input: {
      highestRiskSite: SiteRiskRow | null;
      totalMissedCheckCalls: number;
    },
  ) {
    if (!userId || !companyId) return;

    if (input.highestRiskSite) {
      await this.notificationService.createForUserUnlessRecentDuplicate({
        userId,
        company: { id: companyId },
        type: NotificationType.ALERT_RAISED,
        title: 'High-risk site detected',
        message: `${input.highestRiskSite.site} is currently high risk with score ${input.highestRiskSite.riskScore}.`,
      });
    }

    if (input.totalMissedCheckCalls >= 3) {
      await this.notificationService.createForUserUnlessRecentDuplicate({
        userId,
        company: { id: companyId },
        type: NotificationType.CHECK_CALL_MISSED,
        title: 'Missed check-calls need review',
        message: `${input.totalMissedCheckCalls} missed check-calls were detected in the current reporting window.`,
      });
    }
  }
}
