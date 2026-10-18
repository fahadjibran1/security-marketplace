import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, MoreThan, Not, Repository } from 'typeorm';

import { AttendanceEvent, AttendanceEventType } from '../attendance/entities/attendance.entity';
import {
  CoverageAssessment,
  OtherShiftEvidence,
  assessCoverage,
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
    const times = (shiftId: number, type: AttendanceEventType) =>
      attendance.filter((a) => a.shift?.id === shiftId && a.type === type).map((a) => a.occurredAt.getTime());
    const evidence = (s: Shift): OtherShiftEvidence => {
      const ons = times(s.id, AttendanceEventType.CHECK_IN);
      const offs = times(s.id, AttendanceEventType.CHECK_OUT);
      return {
        shiftId: s.id,
        status: s.status,
        start: new Date(s.start),
        end: new Date(s.end),
        hasGuard: Boolean(s.guard?.id),
        bookOnAt: ons.length ? new Date(Math.min(...ons)) : null,
        bookOffAt: offs.length ? new Date(Math.max(...offs)) : null,
      };
    };

    for (const e of early) {
      const siteId = e.shift.site?.id;
      const sameSite = candidates.filter((s) => s.id !== e.shift.id && siteId !== undefined && s.site?.id === siteId);
      const assessment = assessCoverage(e.bookOffAt, new Date(e.shift.end), sameSite.map(evidence), now);
      result.set(e.shift.id, {
        bookOffAt: e.bookOffAt.toISOString(),
        scheduledEnd: new Date(e.shift.end).toISOString(),
        minutesEarly: e.facts.minutesEarly,
        remainingMinutes: e.facts.remainingMinutes,
        coverage: {
          ...assessment,
          segments: assessment.segments.map((s) => ({ from: s.from.toISOString(), to: s.to.toISOString(), kind: s.kind, shiftIds: s.shiftIds })),
        },
      });
    }
    return result;
  }
}
