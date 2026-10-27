import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, MoreThan, Not, Repository } from 'typeorm';
import { RotaSlot } from '../rota-slot/entities/rota-slot.entity';

import { AttendanceEvent } from '../attendance/entities/attendance.entity';
import { effectiveAttendance, groupAttendanceByShift } from '../attendance/effective-attendance';
import {
  CoverageAssessment,
  OtherShiftEvidence,
  StaffingAssessment,
  assessCoverage,
  assessStaffing,
  earlyBookOff,
} from '../operations/early-book-off';
import { Shift } from '../shift/entities/shift.entity';

/** What Live Operations and the attendance report say about one early Book Off. */
export type EarlyBookOffView = {
  bookOffAt: string;
  scheduledEnd: string;
  minutesEarly: number;
  remainingMinutes: number;
  coverage: Omit<CoverageAssessment, 'segments'> & {
    segments: Array<{ from: string; to: string; kind: CoverageAssessment['segments'][number]['kind']; shiftIds: number[] }>;
  };
  /**
   * Welfare Phase 5: against the Rota Planner slot's required Guards. Null when the shift has no rota slot —
   * no genuine requirement is stored for it, so none is assumed.
   */
  staffing: (StaffingAssessment & { rotaSlotId: number }) | null;
};

/**
 * Early Book Off and the coverage that remained (Welfare Phase 4). See operations/early-book-off.ts for the
 * rules. Read-only; nothing here closes, alerts, reconciles or records anything.
 *
 * Costs nothing when no shift booked off early. Otherwise two bounded reads: the OTHER shifts at the same
 * sites that overlap any of the gaps — scoped to the same company — and their attendance.
 */
@Injectable()
export class EarlyBookOffService {
  constructor(
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(AttendanceEvent) private readonly attendanceRepo: Repository<AttendanceEvent>,
    // Optional so a caller built without it gets coverage only (staffing null), exactly as Phase 4.
    @Optional() @InjectRepository(RotaSlot) private readonly rotaSlotRepo?: Repository<RotaSlot>,
  ) {}

  /**
   * `shifts` must all belong to `companyId`; `bookOffBy` is each shift's latest recorded Book Off (the
   * caller already read attendance). Returns one view per shift that booked off early.
   */
  async assess(
    companyId: number,
    shifts: readonly Shift[],
    bookOffBy: ReadonlyMap<number, Date | null>,
    now = new Date(),
  ): Promise<Map<number, EarlyBookOffView>> {
    const early = shifts
      .map((shift) => {
        const bookOffAt = bookOffBy.get(shift.id) ?? null;
        const facts = earlyBookOff(new Date(shift.end), bookOffAt);
        return facts && bookOffAt ? { shift, bookOffAt, facts } : null;
      })
      .filter((x): x is { shift: Shift; bookOffAt: Date; facts: NonNullable<ReturnType<typeof earlyBookOff>> } => x !== null);
    const result = new Map<number, EarlyBookOffView>();
    if (!early.length) return result;

    const siteIds = [...new Set(early.map((e) => e.shift.site?.id).filter((id): id is number => typeof id === 'number'))];
    const from = new Date(Math.min(...early.map((e) => e.bookOffAt.getTime())));
    const to = new Date(Math.max(...early.map((e) => new Date(e.shift.end).getTime())));
    const others = siteIds.length
      ? await this.shiftRepo.find({
          where: {
            company: { id: companyId },
            site: { id: In(siteIds) },
            start: LessThan(to),
            end: MoreThan(from),
            id: Not(In(early.map((e) => e.shift.id))),
          },
          relations: { site: true, guard: true },
          loadEagerRelations: false,
        })
      : [];
    // The early shifts themselves can cover each other's gaps (two Guards, one leaves at 02:00, one at 04:00).
    const candidates = [...others, ...early.map((e) => e.shift)];
    const attendance = candidates.length
      ? await this.attendanceRepo.find({
          where: { shift: { id: In(candidates.map((s) => s.id)) } },
          relations: { shift: true },
          loadEagerRelations: false,
        })
      : [];
    // Effective attendance (Migration 67): each other shift's Book On / Book Off is its chain's tip.
    const attendanceByShift = groupAttendanceByShift(attendance);
    const evidence = (s: Shift): OtherShiftEvidence => {
      const effective = effectiveAttendance(attendanceByShift.get(s.id) ?? []);
      return {
        shiftId: s.id,
        status: s.status,
        start: new Date(s.start),
        end: new Date(s.end),
        hasGuard: Boolean(s.guard?.id),
        bookOnAt: effective.bookOnAt,
        bookOffAt: effective.bookOffAt,
      };
    };

    // The genuine staffing requirement: the rota slot each early shift belongs to (one bounded read).
    const slotIds = [...new Set(early.map((e) => e.shift.rotaSlotId).filter((id): id is number => typeof id === 'number'))];
    const slots = this.rotaSlotRepo && slotIds.length
      ? await this.rotaSlotRepo.find({ where: { id: In(slotIds) }, select: { id: true, requiredGuardCount: true }, loadEagerRelations: false })
      : [];
    const requiredBySlot = new Map(slots.map((slot) => [slot.id, slot.requiredGuardCount]));

    for (const e of early) {
      const siteId = e.shift.site?.id;
      const sameSite = candidates.filter((s) => s.id !== e.shift.id && siteId !== undefined && s.site?.id === siteId);
      const assessment = assessCoverage(e.bookOffAt, new Date(e.shift.end), sameSite.map(evidence), now);
      const slotId = e.shift.rotaSlotId ?? null;
      const required = slotId !== null ? requiredBySlot.get(slotId) : undefined;
      const staffing = slotId !== null && typeof required === 'number' && required >= 1
        ? {
            rotaSlotId: slotId,
            ...assessStaffing(
              e.bookOffAt,
              new Date(e.shift.end),
              // Same slot, or ad hoc (no slot): another slot's shifts carry their own requirement.
              sameSite.filter((s) => s.rotaSlotId === slotId || s.rotaSlotId == null).map(evidence),
              now,
              required,
            ),
          }
        : null;
      result.set(e.shift.id, {
        bookOffAt: e.bookOffAt.toISOString(),
        scheduledEnd: new Date(e.shift.end).toISOString(),
        minutesEarly: e.facts.minutesEarly,
        remainingMinutes: e.facts.remainingMinutes,
        coverage: {
          ...assessment,
          segments: assessment.segments.map((s) => ({ from: s.from.toISOString(), to: s.to.toISOString(), kind: s.kind, shiftIds: s.shiftIds })),
        },
        staffing,
      });
    }
    return result;
  }
}
