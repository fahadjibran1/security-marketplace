import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttendanceEvent, AttendanceEventType } from './entities/attendance.entity';
import { ShiftService } from '../shift/shift.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { TimesheetService } from '../timesheet/timesheet.service';
import { AssignmentStatus } from '../assignment/entities/assignment.entity';
import { AssignmentService } from '../assignment/assignment.service';

@Injectable()
export class AttendanceService {
  constructor(
    @InjectRepository(AttendanceEvent)
    private readonly attendanceRepo: Repository<AttendanceEvent>,
    private readonly shiftService: ShiftService,
    private readonly guardProfileService: GuardProfileService,
    private readonly timesheetService: TimesheetService,
    private readonly assignmentService: AssignmentService,
  ) {}

  async findMine(userId: number): Promise<AttendanceEvent[]> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    return this.attendanceRepo.find({
      where: { guard: { id: guard.id } },
      order: { occurredAt: 'DESC' },
    });
  }

  async checkIn(userId: number, shiftId: number, nfcTag?: string, notes?: string) {
    const { guard, shift } = await this.getGuardAndOwnedShift(userId, shiftId);

    if (shift.status === 'completed') {
      throw new BadRequestException('Completed shifts cannot be checked in again');
    }

    const latest = await this.latestForShift(shift.id);
    if (latest?.type === AttendanceEventType.CHECK_IN) {
      throw new BadRequestException('Shift is already checked in');
    }

    const event = this.attendanceRepo.create({
      shift,
      guard,
      type: AttendanceEventType.CHECK_IN,
      nfcTag: nfcTag || null,
      notes: notes || null,
    });

    shift.status = 'in_progress';
    await this.shiftService.save(shift);

    if (shift.assignment) {
      shift.assignment.status = AssignmentStatus.CHECKED_IN;
      shift.assignment.acceptedAt = shift.assignment.acceptedAt ?? new Date();
      shift.assignment.checkedInAt = new Date();
      await this.assignmentService.save(shift.assignment);
    }

    return this.attendanceRepo.save(event);
  }

  async checkOut(userId: number, shiftId: number, notes?: string) {
    const { guard, shift } = await this.getGuardAndOwnedShift(userId, shiftId);
    const latest = await this.latestForShift(shift.id);

    if (!latest || latest.type !== AttendanceEventType.CHECK_IN) {
      throw new BadRequestException('Shift must be checked in before checkout');
    }

    const event = this.attendanceRepo.create({
      shift,
      guard,
      type: AttendanceEventType.CHECK_OUT,
      notes: notes || null,
    });

    shift.status = 'completed';
    await this.shiftService.save(shift);

    const savedEvent = await this.attendanceRepo.save(event);

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

  private async getGuardAndOwnedShift(userId: number, shiftId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    const shift = await this.shiftService.findOne(shiftId);
    const assignedGuardId = shift.guard?.id ?? shift.assignment?.guard?.id;
    if (assignedGuardId !== guard.id) {
      throw new BadRequestException('This shift is not assigned to the current guard');
    }

    return { guard, shift };
  }

  private latestForShift(shiftId: number) {
    return this.attendanceRepo.findOne({
      where: { shift: { id: shiftId } },
      order: { occurredAt: 'DESC' },
    });
  }
}
