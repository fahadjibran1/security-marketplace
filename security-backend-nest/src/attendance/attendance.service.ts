import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttendanceEvent, AttendanceEventType } from './entities/attendance.entity';
import { ShiftService } from '../shift/shift.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { TimesheetService } from '../timesheet/timesheet.service';
import { AssignmentStatus } from '../assignment/entities/assignment.entity';
import { AssignmentService } from '../assignment/assignment.service';
import { CompanyService } from '../company/company.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { isCompanyRole, UserRole } from '../user/entities/user.entity';
import { RecordAttendanceDto } from './dto/record-attendance.dto';
import { SiteService } from '../site/site.service';

@Injectable()
export class AttendanceService {
  constructor(
    @InjectRepository(AttendanceEvent)
    private readonly attendanceRepo: Repository<AttendanceEvent>,
    private readonly shiftService: ShiftService,
    private readonly guardProfileService: GuardProfileService,
    private readonly timesheetService: TimesheetService,
    private readonly assignmentService: AssignmentService,
    private readonly companyService: CompanyService,
    private readonly siteService: SiteService,
  ) {}

  async findMine(userId: number): Promise<AttendanceEvent[]> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    return this.attendanceRepo.find({
      where: { guard: { id: guard.id } },
      order: { occurredAt: 'DESC' },
    });
  }

  async findForCompany(user: JwtPayload): Promise<AttendanceEvent[]> {
    if (user.role === UserRole.ADMIN) {
      return this.attendanceRepo.find({ order: { occurredAt: 'DESC' } });
    }

    if (!isCompanyRole(user.role)) throw new ForbiddenException('Company access is required');
    const company = await this.companyService.findByUserId(user.sub);
    if (!company) throw new NotFoundException('Company not found');

    return this.attendanceRepo.find({
      where: { shift: { company: { id: company.id } } },
      order: { occurredAt: 'DESC' },
    });
  }

  async checkIn(userId: number, dto: RecordAttendanceDto) {
    const { guard, shift } = await this.getGuardAndOwnedShift(userId, dto.shiftId);
    const normalizedStatus = this.shiftService.normalizeLifecycleStatus(shift.status);

    if (normalizedStatus !== 'ready') {
      throw new BadRequestException('Only ready shifts can be checked in');
    }

    const latest = await this.latestForShift(shift.id);
    if (latest?.type === AttendanceEventType.CHECK_IN) {
      throw new BadRequestException('Shift is already checked in');
    }

    const evidence = await this.verifyAttendanceEvidence(shift.site?.id, dto, true);
    const event = this.attendanceRepo.create({
      shift,
      guard,
      type: AttendanceEventType.CHECK_IN,
      nfcTag: dto.nfcTag?.trim() || null,
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
    const normalizedStatus = this.shiftService.normalizeLifecycleStatus(shift.status);
    const latest = await this.latestForShift(shift.id);

    if (normalizedStatus !== 'in_progress') {
      throw new BadRequestException('Only in-progress shifts can be checked out');
    }

    if (!latest || latest.type !== AttendanceEventType.CHECK_IN) {
      throw new BadRequestException('Shift must be checked in before checkout');
    }

    const evidence = await this.verifyAttendanceEvidence(shift.site?.id, dto, false);
    const event = this.attendanceRepo.create({
      shift,
      guard,
      type: AttendanceEventType.CHECK_OUT,
      nfcTag: dto.nfcTag?.trim() || null,
      nfcVerified: evidence.nfcVerified,
      latitude: dto.latitude ?? null,
      longitude: dto.longitude ?? null,
      gpsAccuracyMeters: dto.gpsAccuracyMeters ?? null,
      distanceFromSiteMeters: evidence.distanceFromSiteMeters,
      gpsVerified: evidence.gpsVerified,
      notes: dto.notes?.trim() || null,
    });

    const savedEvent = await this.attendanceRepo.save(event);
    shift.status = 'completed';
    await this.shiftService.save(shift);

    if (shift.assignment) {
      shift.assignment.status = AssignmentStatus.CHECKED_OUT;
      shift.assignment.checkedOutAt = savedEvent.occurredAt;
      await this.assignmentService.save(shift.assignment);
    }

    const hoursWorked = Math.max(
      0,
      (savedEvent.occurredAt.getTime() - latest.occurredAt.getTime()) / (1000 * 60 * 60),
    );
    await this.timesheetService.updateHoursForShift(shift.id, Number(hoursWorked.toFixed(2)));

    return savedEvent;
  }

  private async verifyAttendanceEvidence(siteId: number | undefined, dto: RecordAttendanceDto, enforceNfc: boolean) {
    if (!siteId) {
      return { gpsVerified: false, nfcVerified: false, distanceFromSiteMeters: null as number | null };
    }

    const site = await this.siteService.findVerificationConfig(siteId);
    let gpsVerified = false;
    let distanceFromSiteMeters: number | null = null;

    if (dto.latitude !== undefined && dto.longitude !== undefined && site.latitude != null && site.longitude != null) {
      distanceFromSiteMeters = this.distanceMeters(
        site.latitude,
        site.longitude,
        dto.latitude,
        dto.longitude,
      );
      const accuracyAllowance = Math.min(Math.max(dto.gpsAccuracyMeters ?? 0, 0), 50);
      gpsVerified = distanceFromSiteMeters <= site.geofenceRadiusMeters + accuracyAllowance;
    }

    if (site.requireGpsCheckIn && !gpsVerified) {
      if (dto.latitude === undefined || dto.longitude === undefined) {
        throw new ForbiddenException('GPS location is required for attendance at this site');
      }
      throw new ForbiddenException('Guard is outside the permitted site geofence');
    }

    const suppliedTag = dto.nfcTag?.trim() || '';
    const expectedTag = site.attendanceNfcTag?.trim() || '';
    const nfcVerified = Boolean(suppliedTag && expectedTag && suppliedTag === expectedTag);
    if (enforceNfc && site.requireNfcCheckIn && !nfcVerified) {
      throw new ForbiddenException('A valid site NFC tag is required for check-in');
    }

    return { gpsVerified, nfcVerified, distanceFromSiteMeters };
  }

  private async getGuardAndOwnedShift(userId: number, shiftId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    const shift = await this.shiftService.findOne(shiftId);
    const assignedGuardId = shift.guard?.id ?? shift.assignment?.guard?.id;
    if (assignedGuardId !== guard.id) {
      throw new ForbiddenException('This shift is not assigned to the current guard');
    }

    return { guard, shift };
  }

  private latestForShift(shiftId: number) {
    return this.attendanceRepo.findOne({
      where: { shift: { id: shiftId } },
      order: { occurredAt: 'DESC' },
    });
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
