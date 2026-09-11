import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ClientWeeklyApprovalRequest, ClientWeeklyApprovalStatus } from './entities/client-weekly-approval-request.entity';
import { ClientWeeklyApprovalLine } from './entities/client-weekly-approval-line.entity';
import { ClientShiftDispute, ClientShiftDisputeStatus } from './entities/client-shift-dispute.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ClientDisputeDto } from './dto/client-dispute.dto';

@Injectable()
export class ClientPortalWeeklyApprovalService {
  constructor(
    @InjectRepository(ClientWeeklyApprovalRequest)
    private readonly requestRepo: Repository<ClientWeeklyApprovalRequest>,
    @InjectRepository(ClientWeeklyApprovalLine)
    private readonly lineRepo: Repository<ClientWeeklyApprovalLine>,
    @InjectRepository(ClientShiftDispute)
    private readonly disputeRepo: Repository<ClientShiftDispute>,
    private readonly auditLogService: AuditLogService,
    private readonly dataSource: DataSource,
  ) {}

  async listForClient(clientId: number, userId: number, query: { status?: string; siteId?: number; weekCommencing?: string }) {
    const where: Record<string, unknown> = { client: { id: clientId } };
    if (query.status) where.status = query.status;
    if (query.siteId) where.site = { id: query.siteId };
    if (query.weekCommencing) where.weekCommencing = query.weekCommencing;
    const requests = await this.requestRepo.find({ where, order: { weekCommencing: 'DESC', createdAt: 'DESC' } });
    return requests.map((r) => this.toClientSummaryDto(r));
  }

  async findOneForClient(clientId: number, userId: number, id: number) {
    const request = await this.requestRepo.findOne({ where: { id, client: { id: clientId } } });
    if (!request) throw new NotFoundException('Weekly approval request not found.');
    request.lines = await this.lineRepo.find({
      where: { weeklyApprovalRequest: { id }, superseded: false },
      order: { shiftDate: 'ASC' },
    });
    request.disputes = await this.disputeRepo.find({
      where: { weeklyApprovalRequest: { id }, submissionVersion: request.currentVersion },
    });
    return this.toClientDetailDto(request);
  }

  async approveWeek(clientId: number, userId: number, id: number) {
    const request = await this.requestRepo.findOne({ where: { id, client: { id: clientId } } });
    if (!request) throw new NotFoundException('Weekly approval request not found.');
    if (request.status !== ClientWeeklyApprovalStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Only PENDING_APPROVAL requests can be approved.');
    }

    request.status = ClientWeeklyApprovalStatus.CLIENT_APPROVED;
    request.clientRespondedAt = new Date();
    request.clientRespondedBy = userId;
    await this.requestRepo.save(request);

    await this.auditLogService.log({
      company: request.company,
      user: { id: userId },
      action: 'weekly_approval.client_approved',
      entityType: 'client_weekly_approval_request',
      entityId: id,
      beforeData: { status: ClientWeeklyApprovalStatus.PENDING_APPROVAL },
      afterData: { status: ClientWeeklyApprovalStatus.CLIENT_APPROVED, version: request.currentVersion, clientId, totalApprovedHours: request.totalApprovedHours },
    });

    return { id, status: ClientWeeklyApprovalStatus.CLIENT_APPROVED };
  }

  async disputeShifts(clientId: number, userId: number, id: number, dto: ClientDisputeDto) {
    return this.dataSource.transaction(async (manager) => {
      const requestRepo = manager.getRepository(ClientWeeklyApprovalRequest);
      const lineRepo = manager.getRepository(ClientWeeklyApprovalLine);
      const disputeRepo = manager.getRepository(ClientShiftDispute);

      const request = await requestRepo.findOne({ where: { id, client: { id: clientId } } });
      if (!request) throw new NotFoundException('Weekly approval request not found.');
      if (request.status !== ClientWeeklyApprovalStatus.PENDING_APPROVAL) {
        throw new BadRequestException('Only PENDING_APPROVAL requests can be disputed.');
      }

      const activeLines = await lineRepo.find({
        where: { weeklyApprovalRequest: { id }, superseded: false },
        relations: ['timesheet'],
      });
      const activeTimesheetIds = new Set(activeLines.map((l) => l.timesheet.id));

      const disputes: ClientShiftDispute[] = [];
      for (const item of dto.disputes) {
        if (!activeTimesheetIds.has(item.timesheetId)) {
          throw new BadRequestException(`Timesheet #${item.timesheetId} is not in this approval request.`);
        }
        const line = activeLines.find((l) => l.timesheet.id === item.timesheetId)!;
        disputes.push(disputeRepo.create({
          weeklyApprovalRequest: request,
          line,
          timesheet: { id: item.timesheetId } as Timesheet,
          submissionVersion: request.currentVersion,
          disputeReason: item.disputeReason.trim(),
          disputedByUserId: userId,
          disputedAt: new Date(),
          status: ClientShiftDisputeStatus.OPEN,
        }));
      }
      await disputeRepo.save(disputes);

      request.status = ClientWeeklyApprovalStatus.DISPUTED;
      request.clientRespondedAt = new Date();
      request.clientRespondedBy = userId;
      await requestRepo.save(request);

      await this.auditLogService.log({
        company: request.company,
        user: { id: userId },
        action: 'weekly_approval.disputed',
        entityType: 'client_weekly_approval_request',
        entityId: id,
        beforeData: { status: ClientWeeklyApprovalStatus.PENDING_APPROVAL },
        afterData: {
          status: ClientWeeklyApprovalStatus.DISPUTED,
          version: request.currentVersion,
          clientId,
          disputes: dto.disputes.map((d) => ({ timesheetId: d.timesheetId, disputeReason: d.disputeReason })),
        },
      });

      return { id, status: ClientWeeklyApprovalStatus.DISPUTED, disputesCreated: disputes.length };
    });
  }

  // Client-safe DTO mappers — NEVER expose sensitive company/payroll data
  private toClientSummaryDto(r: ClientWeeklyApprovalRequest) {
    return {
      id: r.id,
      siteId: r.site?.id,
      siteName: r.site?.name,
      weekCommencing: r.weekCommencing,
      weekEnding: r.weekEnding,
      status: r.status,
      totalApprovedHours: r.totalApprovedHours,
      clientSubmissionNote: r.clientSubmissionNote,
      submittedAt: r.submittedAt,
      clientRespondedAt: r.clientRespondedAt,
      currentVersion: r.currentVersion,
    };
  }

  private toClientDetailDto(r: ClientWeeklyApprovalRequest) {
    const lines = (r.lines ?? []).map((line) => ({
      id: line.id,
      timesheetId: line.timesheet?.id,
      guardName: line.timesheet?.guard?.fullName ?? line.timesheet?.shift?.guard?.fullName ?? null,
      shiftDate: line.shiftDate,
      scheduledStart: line.scheduledStart,
      scheduledEnd: line.scheduledEnd,
      actualCheckIn: line.actualCheckIn,
      actualCheckOut: line.actualCheckOut,
      verifiedMinutes: line.verifiedMinutes,
      verifiedHours: line.verifiedMinutes != null ? Math.round(line.verifiedMinutes / 60 * 100) / 100 : null,
      approvedHoursAtSubmission: line.approvedHoursAtSubmission,
      hasOverride: line.hasOverride,
      companyApprovedStart: line.companyApprovedStartAtSubmission ?? null,
      companyApprovedEnd: line.companyApprovedEndAtSubmission ?? null,
      // NEVER: hourlyRate, payableAmount, overrideReason, payroll fields, bank details, margin
    }));

    const disputes = (r.disputes ?? []).map((d) => ({
      id: d.id,
      timesheetId: d.timesheet?.id,
      disputeReason: d.disputeReason,
      status: d.status,
      resolutionMessage: d.resolutionMessage,
      disputedAt: d.disputedAt,
      resolvedAt: d.resolvedAt,
    }));

    return {
      id: r.id,
      siteId: r.site?.id,
      siteName: r.site?.name,
      weekCommencing: r.weekCommencing,
      weekEnding: r.weekEnding,
      status: r.status,
      currentVersion: r.currentVersion,
      totalApprovedHours: r.totalApprovedHours,
      clientSubmissionNote: r.clientSubmissionNote,
      submittedAt: r.submittedAt,
      clientRespondedAt: r.clientRespondedAt,
      lines,
      disputes,
      weekTotalApprovedHours: lines.reduce((s, l) => s + Number(l.approvedHoursAtSubmission ?? 0), 0),
    };
  }
}
