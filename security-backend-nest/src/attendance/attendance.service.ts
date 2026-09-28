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

/**
 * How long after a Shift's scheduled END a Book On is still accepted (UAT-ATT-01).
 *
 * This is NOT a late-arrival rule — a Guard arriving late, or part-way through, or shortly after the
 * scheduled end is always accepted. It exists only to stop an abandoned `ready` Shift being bookable
 * indefinitely, because no process ever marks a stale Shift `missed`. Twelve hours clears a full
 * night shift plus handover while still refusing yesterday's work.
 */
export const STALE_BOOK_ON_GRACE_HOURS = 12;

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

    const evidence = await this.verifyAttendanceEvidence(shift.site?.id, dto, { enforceGps: true, enforceNfc: true });
    const event = this.attendanceRepo.create({
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
    });

    const savedEvent = await this.attendanceRepo.save(event);
    shift.status = 'in_progress';
    await this.shiftService.save(shift);

    if (shift.assignment) {
      shift.assignment.status = AssignmentStatus.CHECKED_IN;
      shift.assignment.acceptedAt = shift.assignment.acceptedAt ?? savedEvent.occurredAt;
      shift.assignment.checkedInAt = savedEvent.occurredAt;
      await this.assignmentService.save(shift.assignment);
    }
    return savedEvent;
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
