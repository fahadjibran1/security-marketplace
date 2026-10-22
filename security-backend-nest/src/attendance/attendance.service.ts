import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createHash, timingSafeEqual } from 'crypto';
import { AttendanceEvent, AttendanceEventType } from './entities/attendance.entity';
import { ShiftService } from '../shift/shift.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { TimesheetService } from '../timesheet/timesheet.service';
import { Assignment, AssignmentStatus } from '../assignment/entities/assignment.entity';
import { Shift } from '../shift/entities/shift.entity';
import { AssignmentService } from '../assignment/assignment.service';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { UserRole } from '../user/entities/user.entity';
import { RecordAttendanceDto } from './dto/record-attendance.dto';
import { SiteService } from '../site/site.service';
import { AuditLogService } from '../audit-log/audit-log.service';

/**
 * How long after a Shift's scheduled END a Book On is still accepted (UAT-ATT-01).
 *
 * This is NOT a late-arrival rule — a Guard arriving late, or part-way through, or shortly after the
 * scheduled end is always accepted. It exists only to stop an abandoned `ready` Shift being bookable
 * indefinitely, because no process ever marks a stale Shift `missed`. Twelve hours clears a full
 * night shift plus handover while still refusing yesterday's work.
 */
export const STALE_BOOK_ON_GRACE_HOURS = 12;

/** Book On of a shift that is offered to the Guard, including one re-offered after a material change. */
export const SHIFT_AWAITING_REACCEPTANCE_MESSAGE =
  'This shift is waiting for you to accept it. If your company changed it, review the updated shift and accept it before you Book On.';

/** Turns the start-of-work gate's refusal into words a Guard can act on. */
export function bookOnRefusalReason(message: string): string {
  const compliance = /^Guard compliance invalid: (.+)$/.exec(message);
  if (compliance) return compliance[1];
  if (/not active\/approved for this company/.test(message)) return 'you are not currently active with this company';
  if (/Guard account is not active/.test(message)) return 'your account is not active';
  return 'your company has not cleared you to work';
}

@Injectable()
export class AttendanceService {
  constructor(
    @InjectRepository(AttendanceEvent)
    private readonly attendanceRepo: Repository<AttendanceEvent>,
    private readonly shiftService: ShiftService,
    private readonly guardProfileService: GuardProfileService,
    private readonly timesheetService: TimesheetService,
    private readonly assignmentService: AssignmentService,
    private readonly membershipService: CompanyMembershipService,
    private readonly siteService: SiteService,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findMine(userId: number): Promise<AttendanceEvent[]> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return this.attendanceRepo.find({ where: { guard: { id: guard.id } }, order: { occurredAt: 'DESC' } });
  }

  async findForCompany(user: JwtPayload): Promise<AttendanceEvent[]> {
    if (user.role === UserRole.ADMIN) return this.attendanceRepo.find({ order: { occurredAt: 'DESC' } });
    const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role, CompanyPermission.ATTENDANCE_VIEW);
    return this.attendanceRepo.find({
      where: { shift: { company: { id: company.id } } },
      order: { occurredAt: 'DESC' },
    });
  }

  async checkIn(userId: number, dto: RecordAttendanceDto) {
    const { guard, shift } = await this.getGuardAndOwnedShift(userId, dto.shiftId);
    const normalizedStatus = this.shiftService.normalizeLifecycleStatus(shift.status);
    const latest = await this.latestForShift(shift.id);

    // Retry-safe Book On: if the first request committed but its response was lost,
    // return the existing check-in rather than creating a duplicate or failing the guard.
    //
    // DELIBERATELY BEFORE the staleness check below: a Guard who genuinely booked on must keep getting
    // their event back even if the retry arrives after the stale boundary, otherwise a lost response
    // near the boundary would turn a successful Book On into an error.
    if (normalizedStatus === 'in_progress' && latest?.type === AttendanceEventType.CHECK_IN && latest.guard?.id === guard.id) {
      return latest;
    }

    // A shift waiting for the Guard's (re-)acceptance is not theirs to start yet.
    if (normalizedStatus === 'offered') throw new BadRequestException(SHIFT_AWAITING_REACCEPTANCE_MESSAGE);
    if (normalizedStatus !== 'ready') throw new BadRequestException('Only ready shifts can be checked in');
    if (latest?.type === AttendanceEventType.CHECK_IN) throw new BadRequestException('Shift is already checked in');

    // UAT-ATT-01. There is deliberately NO early cutoff and NO ordinary late cutoff: an assigned Guard
    // may Book On hours before a scheduled start at a site manager's request, and a late Guard must
    // still be able to record attendance. S4 records reality rather than preventing the record.
    //
    // The one exception is an abandoned shift. Nothing in the system ever transitions a stale `ready`
    // Shift to `missed`, so without this a Shift scheduled weeks ago would stay bookable forever and a
    // mis-tap could start it. This boundary is long enough that it can never catch an operational
    // delay — half a day past the scheduled END, not past the start.
    const staleAfterMs = new Date(shift.end).getTime() + STALE_BOOK_ON_GRACE_HOURS * 3_600_000;
    if (Number.isFinite(staleAfterMs) && Date.now() > staleAfterMs) {
      throw new BadRequestException('This shift is too old to Book On. Contact Control.');
    }

    // Fresh company compliance gate (see ShiftService.assertGuardMayStartWork). Before the location check,
    // so a Guard who may not work is told why regardless of where they are standing.
    await this.assertMayBookOn(userId, guard.id, shift);

    const evidence = await this.verifyAttendanceEvidence(shift.site?.id, dto, { enforceGps: true, enforceNfc: true });

    // Book On is ONE transaction under the shift row lock, and only starts the shift the Guard accepted: still
    // 'ready', still theirs, and still at the start, end and site checked above. A company change that re-offered
    // the shift (material-change re-acceptance), or another Book On, cannot interleave between the checks and the
    // write, and the shift's other columns are never written back from the copy read before the lock.
    const result = await this.dataSource.transaction(async (manager) => {
      const [locked] = (await manager.query(
        'SELECT "status", "guardId", "start", "end", "siteId" FROM "shifts" WHERE "id" = $1 FOR UPDATE',
        [shift.id],
      )) as Array<{ status: string; guardId: number | null; start: Date; end: Date; siteId: number | null }>;
      if (!locked || Number(locked.guardId) !== guard.id) throw new NotFoundException('Shift not found');
      const lockedStatus = this.shiftService.normalizeLifecycleStatus(locked.status);
      const attendanceRepo = manager.getRepository(AttendanceEvent);

      if (lockedStatus === 'in_progress') {
        // A concurrent Book On of this Guard committed first: the retry-safe answer, exactly as above.
        const existing = await attendanceRepo.findOne({
          where: { shift: { id: shift.id } },
          order: { occurredAt: 'DESC', id: 'DESC' },
        });
        if (existing?.type === AttendanceEventType.CHECK_IN && existing.guard?.id === guard.id) {
          return { event: existing, created: false };
        }
      }
      const termsChanged =
        new Date(locked.start).getTime() !== new Date(shift.start).getTime() ||
        new Date(locked.end).getTime() !== new Date(shift.end).getTime() ||
        (locked.siteId ?? null) !== (shift.site?.id ?? null);
      if (lockedStatus === 'offered' || (lockedStatus === 'ready' && termsChanged)) {
        throw new BadRequestException(SHIFT_AWAITING_REACCEPTANCE_MESSAGE);
      }
      if (lockedStatus !== 'ready') throw new BadRequestException('Only ready shifts can be checked in');

      const savedEvent = await attendanceRepo.save(
        attendanceRepo.create({
          shift,
          guard,
          type: AttendanceEventType.CHECK_IN,
          nfcTag: null,
          nfcVerified: evidence.nfcVerified,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          gpsAccuracyMeters: dto.gpsAccuracyMeters ?? null,
          distanceFromSiteMeters: evidence.distanceFromSiteMeters,
          gpsVerified: evidence.gpsVerified,
          notes: dto.notes?.trim() || null,
        }),
      );
      await manager.getRepository(Shift).update({ id: shift.id }, { status: 'in_progress' });

      if (shift.assignment) {
        await manager.getRepository(Assignment).update(
          { id: shift.assignment.id },
          {
            status: AssignmentStatus.CHECKED_IN,
            acceptedAt: shift.assignment.acceptedAt ?? savedEvent.occurredAt,
            checkedInAt: savedEvent.occurredAt,
          },
        );
      }
      return { event: savedEvent, created: true };
    });

    if (result.created) shift.status = 'in_progress';
    return result.event;
  }

  async checkOut(userId: number, dto: RecordAttendanceDto) {
    const { guard, shift } = await this.getGuardAndOwnedShift(userId, dto.shiftId);

    // Book Off is ONE transaction: the check-out event, the Shift → completed transition, the Assignment stamp and the
    // Timesheet (created if the Shift never had one, then stamped with the attendance-verified actuals) commit together
    // or not at all. Locking the Shift row first serialises concurrent / retried requests: the second one waits, then
    // sees a completed Shift and takes the idempotent branch below instead of writing a second check-out.
    return this.dataSource.transaction(async (manager) => {
      const [locked] = (await manager.query('SELECT "status" FROM "shifts" WHERE "id" = $1 FOR UPDATE', [shift.id])) as Array<{
        status: string;
      }>;
      if (!locked) throw new NotFoundException('Shift not found');
      const normalizedStatus = this.shiftService.normalizeLifecycleStatus(locked.status);
      const attendanceRepo = manager.getRepository(AttendanceEvent);
      const latest = await attendanceRepo.findOne({ where: { shift: { id: shift.id } }, order: { occurredAt: 'DESC', id: 'DESC' } });

      // Retry-safe Book Off for the network-timeout scenario (first request committed, response lost): return the
      // existing check-out, and make sure the Timesheet exists (heals a Shift completed before the Timesheet fix).
      if (normalizedStatus === 'completed' && latest?.type === AttendanceEventType.CHECK_OUT && latest.guard?.id === guard.id) {
        const checkIn = await attendanceRepo.findOne({
          where: { shift: { id: shift.id }, type: AttendanceEventType.CHECK_IN },
          order: { occurredAt: 'DESC', id: 'DESC' },
        });
        if (checkIn) {
          await this.timesheetService.recordAttendanceActuals(manager, shift.id, {
            checkInAt: checkIn.occurredAt,
            checkOutAt: latest.occurredAt,
          });
        }
        return latest;
      }

      if (normalizedStatus !== 'in_progress') throw new BadRequestException('Only in-progress shifts can be checked out');
      if (!latest || latest.type !== AttendanceEventType.CHECK_IN) {
        throw new BadRequestException('Shift must be checked in before checkout');
      }

      // Checkout records any supplied evidence, but site policy named requireGpsCheckIn /
      // requireNfcCheckIn must not block a guard from ending a shift.
      const evidence = await this.verifyAttendanceEvidence(shift.site?.id, dto, { enforceGps: false, enforceNfc: false });
      const savedEvent = await attendanceRepo.save(
        attendanceRepo.create({
          shift,
          guard,
          type: AttendanceEventType.CHECK_OUT,
          nfcTag: null,
          nfcVerified: evidence.nfcVerified,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          gpsAccuracyMeters: dto.gpsAccuracyMeters ?? null,
          distanceFromSiteMeters: evidence.distanceFromSiteMeters,
          gpsVerified: evidence.gpsVerified,
          notes: dto.notes?.trim() || null,
        }),
      );
      await manager.getRepository(Shift).update({ id: shift.id }, { status: 'completed' });

      // Live Shift Amendments: a Book Off ends the shift, so any extension still awaiting approval or the Guard's answer
      // is voided here, in the same transaction and after the shift row lock (the approved lock order: shift row, then
      // amendment rows). The Book Off itself is never changed by an amendment.
      const voided = (await manager.query(
        `UPDATE "shift_amendments" SET "status" = 'voided', "voidedReason" = 'booked_off',
            "voidedAt" = (statement_timestamp() AT TIME ZONE 'UTC'), "updatedAt" = now()
          WHERE "shiftId" = $1 AND "status" IN ('awaiting_approval', 'pending')
          RETURNING "id", "companyId", "status"`,
        [shift.id],
      )) as unknown;
      const voidedRows = (Array.isArray(voided) && Array.isArray(voided[0]) ? voided[0] : voided) as Array<{ id: number; companyId: number }>;
      for (const row of voidedRows) {
        await this.auditLogService.logInTransaction(manager, {
          company: { id: Number(row.companyId) },
          user: { id: userId },
          action: 'shift_amendment.voided',
          entityType: 'shift_amendment',
          entityId: Number(row.id),
          beforeData: { status: 'open' },
          afterData: { status: 'voided', reason: 'booked_off', shiftId: shift.id, bookOffEventId: savedEvent.id },
        });
      }

      if (shift.assignment) {
        await manager
          .getRepository(Assignment)
          .update(
            { id: shift.assignment.id },
            { status: AssignmentStatus.CHECKED_OUT, checkedOutAt: savedEvent.occurredAt },
          );
      }

      // RB-007: verifiedMinutes is the attendance-verified duration — the elapsed time between the two
      // server-timestamped attendance events. This becomes the payroll default; hoursWorked/workedMinutes remain the
      // guard-facing claimed values. The Timesheet also stores those two events as its authoritative actual
      // check-in / check-out (Rota Shifts have no Assignment to copy them from).
      await this.timesheetService.recordAttendanceActuals(manager, shift.id, {
        checkInAt: latest.occurredAt,
        checkOutAt: savedEvent.occurredAt,
      });
      return savedEvent;
    });
  }

  private async verifyAttendanceEvidence(
    siteId: number | undefined,
    dto: RecordAttendanceDto,
    policy: { enforceGps: boolean; enforceNfc: boolean },
  ) {
    if (!siteId) {
      return { gpsVerified: false, nfcVerified: false, distanceFromSiteMeters: null as number | null };
    }

    const site = await this.siteService.findVerificationConfig(siteId);
    let gpsVerified = false;
    let distanceFromSiteMeters: number | null = null;

    if (dto.latitude !== undefined && dto.longitude !== undefined && site.latitude != null && site.longitude != null) {
      distanceFromSiteMeters = this.distanceMeters(site.latitude, site.longitude, dto.latitude, dto.longitude);
      const accuracyAllowance = Math.min(Math.max(dto.gpsAccuracyMeters ?? 0, 0), 50);
      gpsVerified = distanceFromSiteMeters <= site.geofenceRadiusMeters + accuracyAllowance;
    }

    if (policy.enforceGps && site.requireGpsCheckIn && !gpsVerified) {
      // A site that demands GPS but has no point to measure against is misconfigured, and that is not
      // the Guard's fault. Previously this fell through to "GPS location is required", which blamed the
      // Guard for a setting only the Company can fix and sent them round a loop no location fix could
      // satisfy. 422 rather than 403 is deliberate: the Guard's request is well formed, and the client's
      // GPS retry transport only reacts to the 403, so it will not pointlessly re-acquire a position.
      if (!this.hasSiteCoordinates(site)) {
        throw new UnprocessableEntityException(
          'GPS verification is not configured correctly for this site. Contact Control.',
        );
      }
      if (dto.latitude === undefined || dto.longitude === undefined) {
        throw new ForbiddenException('GPS location is required for attendance at this site');
      }
      throw new ForbiddenException('Guard is outside the permitted site geofence');
    }

    const suppliedTag = dto.nfcTag?.trim() || '';
    const expectedHash = site.attendanceNfcTag?.trim() || '';
    const suppliedHash = suppliedTag ? this.hashNfcTag(suppliedTag) : '';
    const nfcVerified = this.safeHashEquals(suppliedHash, expectedHash);
    if (policy.enforceNfc && site.requireNfcCheckIn && !nfcVerified) {
      throw new ForbiddenException('A valid site NFC tag is required for check-in');
    }

    return { gpsVerified, nfcVerified, distanceFromSiteMeters };
  }

  /** A usable geofence centre: both values present and finite. Null/NaN cannot be measured against. */
  private hasSiteCoordinates(site: { latitude?: number | null; longitude?: number | null }): boolean {
    return (
      site.latitude != null &&
      site.longitude != null &&
      Number.isFinite(Number(site.latitude)) &&
      Number.isFinite(Number(site.longitude))
    );
  }

  /**
   * Refuses a Book On the company's assessment does not allow, with a reason the Guard can act on, and
   * keeps an audit record of the refusal. The reason is the assessment's own wording (for example
   * "Right to work permission expired"); it never contains evidence, references or document details.
   * No attendance event is written and the shift stays ready.
   */
  private async assertMayBookOn(userId: number, guardId: number, shift: Shift) {
    try {
      await this.shiftService.assertGuardMayStartWork(shift.company.id, guardId);
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      const reason = bookOnRefusalReason(error.message);
      await this.auditLogService.log({
        company: { id: shift.company.id },
        user: { id: userId },
        action: 'attendance.book_on_refused',
        entityType: 'shift',
        entityId: shift.id,
        afterData: { guardId, reason },
      });
      throw new ForbiddenException(
        `You cannot Book On for this shift: ${reason}. Contact ${shift.company.name || 'your company'} to resolve it.`,
      );
    }
  }

  private async getGuardAndOwnedShift(userId: number, shiftId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    const shift = await this.shiftService.findOne(shiftId);
    const assignedGuardId = shift.guard?.id ?? shift.assignment?.guard?.id;
    if (assignedGuardId !== guard.id) throw new ForbiddenException('This shift is not assigned to the current guard');
    return { guard, shift };
  }

  private latestForShift(shiftId: number) {
    return this.attendanceRepo.findOne({ where: { shift: { id: shiftId } }, order: { occurredAt: 'DESC' } });
  }

  private hashNfcTag(value: string) {
    return createHash('sha256').update(value.trim(), 'utf8').digest('hex');
  }

  private safeHashEquals(left: string, right: string) {
    if (!left || !right || left.length !== right.length) return false;
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  }

  private distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
    const earthRadiusMeters = 6371000;
    const toRadians = (value: number) => (value * Math.PI) / 180;
    const deltaLat = toRadians(lat2 - lat1);
    const deltaLon = toRadians(lon2 - lon1);
    const a =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2;
    return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
