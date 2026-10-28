import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { UserRole } from '../user/entities/user.entity';
import { PatrolErrorCode, patrolError } from './patrol-constants';

/**
 * The per-company Patrol Management switch (companies.patrolsEnabled, Migration 68). Only an S4 platform administrator
 * changes it; every change is audited against the company. Off by default, and turning it off hides every patrol route
 * again at once (company and Guard), without deleting anything.
 */
@Injectable()
export class PatrolAdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  async get(user: JwtPayload, companyId: number) {
    this.assertPlatformAdmin(user);
    const [row] = await this.dataSource.query(`SELECT "id", "patrolsEnabled" FROM "companies" WHERE "id" = $1`, [companyId]);
    if (!row) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Company not found.');
    return { companyId: Number(row.id), patrolsEnabled: row.patrolsEnabled === true };
  }

  async setEnabled(user: JwtPayload, companyId: number, patrolsEnabled: boolean) {
    this.assertPlatformAdmin(user);
    return this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(`SELECT "id", "patrolsEnabled" FROM "companies" WHERE "id" = $1 FOR UPDATE`, [companyId]);
      if (!row) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Company not found.');
      const before = row.patrolsEnabled === true;
      if (before !== patrolsEnabled) {
        await manager.query(`UPDATE "companies" SET "patrolsEnabled" = $2 WHERE "id" = $1`, [companyId, patrolsEnabled]);
        await this.auditLogService.logInTransaction(manager, {
          company: { id: companyId },
          user: { id: user.sub },
          action: 'company.patrols_enabled_changed',
          entityType: 'company',
          entityId: companyId,
          beforeData: { patrolsEnabled: before },
          afterData: { patrolsEnabled },
        });
      }
      return { companyId, patrolsEnabled };
    });
  }

  private assertPlatformAdmin(user: JwtPayload) {
    if (user.role !== UserRole.ADMIN) {
      throw patrolError(HttpStatus.FORBIDDEN, PatrolErrorCode.FORBIDDEN, 'Only an S4 platform administrator can change this.');
    }
  }
}
