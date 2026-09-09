import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ClientWeeklyApprovalRequest, ClientWeeklyApprovalStatus } from './entities/client-weekly-approval-request.entity';
import { ClientWeeklyApprovalLine } from './entities/client-weekly-approval-line.entity';
import { ClientShiftDispute, ClientShiftDisputeStatus } from './entities/client-shift-dispute.entity';
import { Timesheet, TimesheetBillingStatus, TimesheetStatus } from '../timesheet/entities/timesheet.entity';
import { Company } from '../company/entities/company.entity';
import { Client } from '../client/entities/client.entity';
import { Site } from '../site/entities/site.entity';
import { CompanyService } from '../company/company.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CreateWeeklyApprovalDto } from './dto/create-weekly-approval.dto';
import { ResubmitApprovalDto } from './dto/resubmit-approval.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { computeWeekCommencing, computeWeekEnding } from './week-commencing.util';

@Injectable()
export class ClientWeeklyApprovalService {
  constructor(
    @InjectRepository(ClientWeeklyApprovalRequest)
    private readonly requestRepo: Repository<ClientWeeklyApprovalRequest>,
    @InjectRepository(ClientWeeklyApprovalLine)
    private readonly lineRepo: Repository<ClientWeeklyApprovalLine>,
    @InjectRepository(ClientShiftDispute)
    private readonly disputeRepo: Repository<ClientShiftDispute>,
    private readonly companyService: CompanyService,
    private readonly auditLogService: AuditLogService,
    private readonly dataSource: DataSource,
  ) {}

  async createSubmission(userId: number, dto: CreateWeeklyApprovalDto): Promise<ClientWeeklyApprovalRequest> {
    const company = await this.requireCompany(userId);
    const weekEnding = computeWeekEnding(dto.weekCommencing);

    const savedId = await this.dataSource.transaction(async (manager) => {
      const clientRepo = manager.getRepository(Client);
      const siteRepo = manager.getRepository(Site);
      const timesheetRepo = manager.getRepository(Timesheet);
      const requestRepo = manager.getRepository(ClientWeeklyApprovalRequest);
      const lineRepo = manager.getRepository(ClientWeeklyApprovalLine);

      const client = await clientRepo.findOne({ where: { id: dto.clientId, company: { id: company.id } } });
      if (!client) throw new NotFoundException('Client not found for this company.');

      const site = await siteRepo.findOne({ where: { id: dto.siteId, company: { id: company.id } } });
      if (!site) throw new NotFoundException('Site not found for this company.');
      if (!site.client || site.client.id !== client.id) {
        throw new ForbiddenException('Site does not belong to the selected client.');
      }

      // Check no active request already exists
      const existing = await requestRepo.findOne({
        where: { company: { id: company.id }, client: { id: client.id }, site: { id: site.id }, weekCommencing: dto.weekCommencing },
      });
      if (existing) {
        throw new ConflictException(
          `A weekly approval request already exists for this client/site/week (status: ${existing.status}). Resolve or resubmit it instead.`,
        );
      }

      // Row-lock timesheets
      const uniqueIds = Array.from(new Set(dto.timesheetIds.filter((id) => Number.isInteger(id) && id > 0)));
      if (!uniqueIds.length) throw new BadRequestException('No valid timesheet IDs provided.');
      await manager.query(
        `SELECT id FROM "timesheets" WHERE id = ANY($1::int[]) AND "companyId" = $2 ORDER BY id FOR UPDATE`,
        [uniqueIds, company.id],
      );

      const timesheets = await timesheetRepo.find({ where: uniqueIds.map((id) => ({ id, company: { id: company.id } })) });
      if (timesheets.length !== uniqueIds.length) {
        throw new NotFoundException('One or more timesheets not found for this company.');
      }

      // Validate each timesheet
      const validatedTimesheets = timesheets.map((ts) => this.assertTimesheetEligible(ts, site, client, dto.weekCommencing));

      // Check no active approval line for any of these timesheets
      const conflicting = await manager.query(
        `SELECT l."timesheetId" FROM "client_weekly_approval_lines" l
         WHERE l."timesheetId" = ANY($1::int[]) AND l."superseded" = FALSE`,
        [uniqueIds],
      );
      if (conflicting.length > 0) {
        const ids = conflicting.map((r: { timesheetId: number }) => r.timesheetId);
        throw new ConflictException(`Timesheets already in an active approval submission: ${ids.join(', ')}`);
      }

      const totalApprovedHours = validatedTimesheets.reduce((sum, ts) => {
        return sum + (ts.approvedHours != null ? Number(ts.approvedHours) : (Number(ts.approvedMinutes) / 60));
      }, 0);

      const request = requestRepo.create({
        company,
        client,
        site,
        weekCommencing: dto.weekCommencing,
        weekEnding,
        status: ClientWeeklyApprovalStatus.PENDING_APPROVAL,
        currentVersion: 1,
        submittedAt: new Date(),
        submittedByUserId: userId,
        totalApprovedHours: Math.round(totalApprovedHours * 100) / 100,
        companyInternalNote: dto.companyInternalNote?.trim() || null,
        clientSubmissionNote: dto.clientSubmissionNote?.trim() || null,
      });
      const savedRequest = await requestRepo.save(request);

      // Create lines
      const lines = validatedTimesheets.map((ts) => {
        const approvedHours = ts.approvedHours != null ? Number(ts.approvedHours) : Number(ts.approvedMinutes) / 60;
        return lineRepo.create({
          weeklyApprovalRequest: savedRequest,
          timesheet: ts,
          submissionVersion: 1,
          superseded: false,
          approvedHoursAtSubmission: Math.round(approvedHours * 100) / 100,
          shiftDate: this.getShiftDate(ts),
          scheduledStart: ts.scheduledStartAt ?? ts.shift?.start ?? null,
          scheduledEnd: ts.scheduledEndAt ?? ts.shift?.end ?? null,
          actualCheckIn: ts.actualCheckInAt ?? null,
          actualCheckOut: ts.actualCheckOutAt ?? null,
          verifiedMinutes: ts.verifiedMinutes ?? null,
          hasOverride: !!(ts.overrideBy),
        });
      });
      await lineRepo.save(lines);

      await this.auditLogService.log({
        company,
        user: { id: userId },
        action: 'weekly_approval.submitted',
        entityType: 'client_weekly_approval_request',
        entityId: savedRequest.id,
        beforeData: null,
        afterData: { version: 1, weekCommencing: dto.weekCommencing, clientId: client.id, siteId: site.id, timesheetIds: uniqueIds, totalApprovedHours: savedRequest.totalApprovedHours },
      });

      return savedRequest.id;
    });

    return this.findOneForCompany(userId, savedId);
  }

  async listForCompany(userId: number, query: { status?: string; clientId?: number; siteId?: number; weekCommencing?: string }) {
    const company = await this.requireCompany(userId);
    const where: Record<string, unknown> = { company: { id: company.id } };
    if (query.status) where.status = query.status;
    if (query.clientId) where.client = { id: query.clientId };
    if (query.siteId) where.site = { id: query.siteId };
    if (query.weekCommencing) where.weekCommencing = query.weekCommencing;
    return this.requestRepo.find({ where, order: { weekCommencing: 'DESC', createdAt: 'DESC' } });
  }

  async findOneForCompany(userId: number, id: number): Promise<ClientWeeklyApprovalRequest> {
    const company = await this.requireCompany(userId);
    const request = await this.requestRepo.findOne({ where: { id, company: { id: company.id } } });
    if (!request) throw new NotFoundException('Weekly approval request not found.');
    request.lines = await this.lineRepo.find({
      where: { weeklyApprovalRequest: { id }, superseded: false },
      order: { shiftDate: 'ASC' },
    });
    request.disputes = await this.disputeRepo.find({
      where: { weeklyApprovalRequest: { id }, submissionVersion: request.currentVersion },
    });
    return request;
  }

  async resolveDispute(userId: number, requestId: number, disputeId: number, dto: ResolveDisputeDto): Promise<ClientShiftDispute> {
    const company = await this.requireCompany(userId);
    const request = await this.requestRepo.findOne({ where: { id: requestId, company: { id: company.id } } });
    if (!request) throw new NotFoundException('Weekly approval request not found.');
    if (request.status !== ClientWeeklyApprovalStatus.DISPUTED) {
      throw new BadRequestException('Disputes can only be resolved when request is in DISPUTED status.');
    }

    const dispute = await this.disputeRepo.findOne({
      where: { id: disputeId, weeklyApprovalRequest: { id: requestId } },
      relations: ['weeklyApprovalRequest', 'line'],
    });
    if (!dispute) throw new NotFoundException('Dispute not found.');
    if (dispute.status !== ClientShiftDisputeStatus.OPEN) {
      throw new BadRequestException('Only OPEN disputes can be resolved.');
    }

    dispute.status = ClientShiftDisputeStatus.RESOLVED;
    dispute.resolutionMessage = dto.resolutionMessage.trim();
    dispute.resolvedByUserId = userId;
    dispute.resolvedAt = new Date();
    await this.disputeRepo.save(dispute);

    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'weekly_approval.dispute_resolved',
      entityType: 'client_shift_dispute',
      entityId: dispute.id,
      beforeData: { status: ClientShiftDisputeStatus.OPEN },
      afterData: { status: ClientShiftDisputeStatus.RESOLVED, resolutionMessage: dispute.resolutionMessage, requestId, version: request.currentVersion },
    });

    // Check if all current-version disputes are now resolved
    const openDisputes = await this.disputeRepo.count({
      where: { weeklyApprovalRequest: { id: requestId }, submissionVersion: request.currentVersion, status: ClientShiftDisputeStatus.OPEN },
    });
    if (openDisputes === 0) {
      request.status = ClientWeeklyApprovalStatus.RESOLVED;
      await this.requestRepo.save(request);
    }

    return dispute;
  }

  async resubmit(userId: number, requestId: number, dto: ResubmitApprovalDto): Promise<ClientWeeklyApprovalRequest> {
    const company = await this.requireCompany(userId);

    await this.dataSource.transaction(async (manager) => {
      const requestRepo = manager.getRepository(ClientWeeklyApprovalRequest);
      const lineRepo = manager.getRepository(ClientWeeklyApprovalLine);
      const timesheetRepo = manager.getRepository(Timesheet);
      const siteRepo = manager.getRepository(Site);

      const request = await requestRepo.findOne({ where: { id: requestId, company: { id: company.id } } });
      if (!request) throw new NotFoundException('Weekly approval request not found.');
      if (request.status !== ClientWeeklyApprovalStatus.RESOLVED) {
        throw new BadRequestException('Only RESOLVED requests can be resubmitted.');
      }

      const site = request.site;
      const client = request.client;
      const newVersion = request.currentVersion + 1;

      const uniqueIds = Array.from(new Set(dto.timesheetIds.filter((id) => Number.isInteger(id) && id > 0)));
      if (!uniqueIds.length) throw new BadRequestException('No valid timesheet IDs provided.');

      // Row-lock timesheets
      await manager.query(
        `SELECT id FROM "timesheets" WHERE id = ANY($1::int[]) AND "companyId" = $2 ORDER BY id FOR UPDATE`,
        [uniqueIds, company.id],
      );

      const timesheets = await timesheetRepo.find({ where: uniqueIds.map((id) => ({ id, company: { id: company.id } })) });
      if (timesheets.length !== uniqueIds.length) {
        throw new NotFoundException('One or more timesheets not found for this company.');
      }

      // Full site object needed for eligibility check
      const fullSite = await siteRepo.findOne({ where: { id: site.id } });
      if (!fullSite) throw new NotFoundException('Site not found.');

      const validatedTimesheets = timesheets.map((ts) => this.assertTimesheetEligible(ts, fullSite, client, request.weekCommencing));

      // Check active lines from OTHER requests (not this one) — this request's active lines will be superseded
      const conflicting = await manager.query(
        `SELECT l."timesheetId" FROM "client_weekly_approval_lines" l
         JOIN "client_weekly_approval_requests" r ON r.id = l."weeklyApprovalRequestId"
         WHERE l."timesheetId" = ANY($1::int[]) AND l."superseded" = FALSE AND r.id != $2`,
        [uniqueIds, requestId],
      );
      if (conflicting.length > 0) {
        const ids = conflicting.map((r: { timesheetId: number }) => r.timesheetId);
        throw new ConflictException(`Timesheets in another active submission: ${ids.join(', ')}`);
      }

      // Supersede current active lines
      await manager.query(
        `UPDATE "client_weekly_approval_lines" SET "superseded" = TRUE WHERE "weeklyApprovalRequestId" = $1 AND "superseded" = FALSE`,
        [requestId],
      );

      const totalApprovedHours = validatedTimesheets.reduce((sum, ts) => {
        return sum + (ts.approvedHours != null ? Number(ts.approvedHours) : Number(ts.approvedMinutes) / 60);
      }, 0);

      // Create new version lines
      const newLines = validatedTimesheets.map((ts) => {
        const approvedHours = ts.approvedHours != null ? Number(ts.approvedHours) : Number(ts.approvedMinutes) / 60;
        return lineRepo.create({
          weeklyApprovalRequest: request,
          timesheet: ts,
          submissionVersion: newVersion,
          superseded: false,
          approvedHoursAtSubmission: Math.round(approvedHours * 100) / 100,
          shiftDate: this.getShiftDate(ts),
          scheduledStart: ts.scheduledStartAt ?? ts.shift?.start ?? null,
          scheduledEnd: ts.scheduledEndAt ?? ts.shift?.end ?? null,
          actualCheckIn: ts.actualCheckInAt ?? null,
          actualCheckOut: ts.actualCheckOutAt ?? null,
          verifiedMinutes: ts.verifiedMinutes ?? null,
          hasOverride: !!(ts.overrideBy),
        });
      });
      await lineRepo.save(newLines);

      request.currentVersion = newVersion;
      request.status = ClientWeeklyApprovalStatus.PENDING_APPROVAL;
      request.clientRespondedAt = null;
      request.clientRespondedBy = null;
      request.totalApprovedHours = Math.round(totalApprovedHours * 100) / 100;
      request.submittedAt = new Date();
      request.submittedByUserId = userId;
      request.companyInternalNote = dto.companyInternalNote !== undefined ? (dto.companyInternalNote?.trim() || null) : request.companyInternalNote;
      request.clientSubmissionNote = dto.clientSubmissionNote !== undefined ? (dto.clientSubmissionNote?.trim() || null) : request.clientSubmissionNote;
      await requestRepo.save(request);

      await this.auditLogService.log({
        company,
        user: { id: userId },
        action: 'weekly_approval.resubmitted',
        entityType: 'client_weekly_approval_request',
        entityId: requestId,
        beforeData: { version: newVersion - 1, status: ClientWeeklyApprovalStatus.RESOLVED },
        afterData: { version: newVersion, status: ClientWeeklyApprovalStatus.PENDING_APPROVAL, timesheetIds: uniqueIds, totalApprovedHours: request.totalApprovedHours },
      });
    });

    return this.findOneForCompany(userId, requestId);
  }

  private assertTimesheetEligible(ts: Timesheet, site: Site, client: Client, weekCommencing: string): Timesheet {
    if (String(ts.approvalStatus).trim().toLowerCase() !== TimesheetStatus.APPROVED) {
      throw new BadRequestException(`Timesheet #${ts.id} is not approved.`);
    }
    if (String(ts.billingStatus ?? '').trim().toLowerCase() !== TimesheetBillingStatus.UNINVOICED || ts.invoiceBatch) {
      throw new BadRequestException(`Timesheet #${ts.id} is already invoiced.`);
    }
    if (!ts.approvedHours && !ts.approvedMinutes) {
      throw new BadRequestException(`Timesheet #${ts.id} has no approved duration.`);
    }
    const shiftSiteId = ts.shift?.site?.id;
    if (shiftSiteId !== site.id) {
      throw new ForbiddenException(`Timesheet #${ts.id} does not belong to site ${site.id}.`);
    }
    const shiftClientId = ts.shift?.site?.client?.id;
    if (shiftClientId !== client.id) {
      throw new ForbiddenException(`Timesheet #${ts.id} does not belong to client ${client.id}.`);
    }
    const shiftStart = ts.scheduledStartAt ?? ts.shift?.start;
    if (!shiftStart) {
      throw new BadRequestException(`Timesheet #${ts.id} has no shift start time.`);
    }
    const computedWeek = computeWeekCommencing(new Date(shiftStart), site.timezone || 'Europe/London');
    if (computedWeek !== weekCommencing) {
      throw new BadRequestException(
        `Timesheet #${ts.id} belongs to week ${computedWeek}, not ${weekCommencing}.`,
      );
    }
    return ts;
  }

  private getShiftDate(ts: Timesheet): string {
    const d = ts.scheduledStartAt ?? ts.shift?.start ?? ts.createdAt;
    const date = new Date(d);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  private async requireCompany(userId: number): Promise<Company> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found.');
    return company;
  }
}
