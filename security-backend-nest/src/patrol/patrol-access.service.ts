import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyMembershipRole, CompanyPermission, hasPermission } from '../company-membership/company-membership-types';
import { UserRole } from '../user/entities/user.entity';
import { PATROL_LOCATION_FIELDS, PatrolErrorCode, patrolError } from './patrol-constants';

export type PatrolCompanyActor = { companyId: number; userId: number; role: CompanyMembershipRole };
export type PatrolGuardActor = { guardId: number; userId: number };
export type PatrolGuardShift = {
  id: number;
  companyId: number;
  siteId: number | null;
  guardId: number;
  status: string;
  start: Date;
  end: Date;
};

/**
 * Who may touch Patrols, decided in one place.
 *
 * Company routes: the caller's company comes ONLY from resolveCompanyContext (never from a request field). With the
 * company's patrolsEnabled switch off every company route answers 404 PATROLS_NOT_ENABLED, whatever the caller's role,
 * so the feature is invisible; with it on, the route's patrols.* permission decides (403 PATROL_FORBIDDEN). Any id that
 * is not the caller's company's is 404, exactly like an id that does not exist.
 *
 * Guard routes: the Guard acts only on their OWN shift (shifts.guardId = their guard profile); anyone else's shift is
 * 404. The shift's company must have the switch on (404 PATROLS_NOT_ENABLED otherwise).
 */
@Injectable()
export class PatrolAccessService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly membershipService: CompanyMembershipService,
  ) {}

  async companyActor(user: JwtPayload, permission: CompanyPermission): Promise<PatrolCompanyActor> {
    if (user.role === UserRole.GUARD || user.role === UserRole.ADMIN) {
      throw patrolError(HttpStatus.FORBIDDEN, PatrolErrorCode.FORBIDDEN, 'Patrol Management is for company staff.');
    }
    const { company, membershipRole } = await this.membershipService.resolveCompanyContext(user.sub, user.role);
    if (!(await this.isEnabled(company.id))) {
      throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_ENABLED, 'Patrol Management is not available for this company.');
    }
    if (!hasPermission(membershipRole, permission)) {
      throw patrolError(HttpStatus.FORBIDDEN, PatrolErrorCode.FORBIDDEN, 'Insufficient permissions.');
    }
    return { companyId: company.id, userId: user.sub, role: membershipRole };
  }

  /** Whether the actor's role also holds another patrol permission (e.g. evidence metadata in a run's detail). */
  holds(actor: PatrolCompanyActor, permission: CompanyPermission): boolean {
    return hasPermission(actor.role, permission);
  }

  async isEnabled(companyId: number, manager?: EntityManager): Promise<boolean> {
    const [row] = await (manager ?? this.dataSource).query(`SELECT "patrolsEnabled" FROM "companies" WHERE "id" = $1`, [companyId]);
    return row?.patrolsEnabled === true;
  }

  async guardActor(user: JwtPayload): Promise<PatrolGuardActor> {
    if (user.role !== UserRole.GUARD) {
      throw patrolError(HttpStatus.FORBIDDEN, PatrolErrorCode.FORBIDDEN, 'Only the Guard on the shift can do this.');
    }
    const [row] = await this.dataSource.query(`SELECT "id" FROM "guard_profiles" WHERE "userId" = $1`, [user.sub]);
    if (!row) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.SHIFT_NOT_FOUND, 'Shift not found.');
    return { guardId: Number(row.id), userId: user.sub };
  }

  /** The Guard's own shift, with the company switch on. Another Guard's (or company's) shift is indistinguishable from none. */
  async guardShift(actor: PatrolGuardActor, shiftId: number): Promise<PatrolGuardShift> {
    const [row] = await this.dataSource.query(
      `SELECT s."id", s."companyId", s."siteId", s."guardId", s."status", s."start", s."end", c."patrolsEnabled"
         FROM "shifts" s JOIN "companies" c ON c."id" = s."companyId"
        WHERE s."id" = $1`,
      [shiftId],
    );
    if (!row || Number(row.guardId) !== actor.guardId) {
      throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.SHIFT_NOT_FOUND, 'Shift not found.');
    }
    if (row.patrolsEnabled !== true) {
      throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_ENABLED, 'Patrol Management is not available for this company.');
    }
    return {
      id: Number(row.id),
      companyId: Number(row.companyId),
      siteId: row.siteId == null ? null : Number(row.siteId),
      guardId: Number(row.guardId),
      status: String(row.status),
      start: row.start,
      end: row.end,
    };
  }

  assertShiftInProgress(shift: PatrolGuardShift): void {
    if (shift.status !== 'in_progress') {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.SHIFT_NOT_IN_PROGRESS, 'Patrols can only be recorded during your shift, after Book On.', {
        shiftStatus: shift.status,
      });
    }
  }

  /**
   * Location-based verification is DISABLED until the privacy assessment. A request carrying any location field is
   * refused (400 PATROL_LOCATION_VERIFICATION_DISABLED), never silently stored or dropped, so no client collects one.
   */
  rejectLocation(body: object | null | undefined): void {
    if (!body) return;
    const sent = PATROL_LOCATION_FIELDS.filter((field) => (body as Record<string, unknown>)[field] !== undefined);
    if (sent.length) {
      throw patrolError(
        HttpStatus.BAD_REQUEST,
        PatrolErrorCode.LOCATION_VERIFICATION_DISABLED,
        'Location-based patrol verification is disabled. Do not send a location with patrol data.',
        { fields: sent },
      );
    }
  }
}
