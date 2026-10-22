import { ForbiddenException } from '@nestjs/common';
import { EntityManager, In, LessThan, MoreThan, Not } from 'typeorm';

import { Shift } from '../shift/entities/shift.entity';

/** Statuses in which a shift holds its Guard's time (the same set AvailabilityService treats as a clash). */
const COMMITTED_SHIFT_STATUSES = ['scheduled', 'offered', 'ready', 'in_progress'];

/**
 * The overlap check alone, read through the caller's transaction.
 *
 * An assignment runs the full eligibility check (AvailabilityService.assertGuardCanTakeShift: relationship, leave,
 * compliance, availability and overlap) before its transaction, on ordinary connections. Inside the transaction,
 * after taking the Guard's assignment lock, it repeats only this check and then writes, all on the transaction's
 * own connection: the locked section never waits for a second pooled connection, so a burst of concurrent
 * assignments cannot starve the pool. Same refusal as the full check.
 */
export async function assertNoShiftClash(
  manager: EntityManager,
  guardId: number,
  startAt: Date,
  endAt: Date,
  excludeShiftId?: number,
): Promise<void> {
  const where: Record<string, unknown> = {
    guard: { id: guardId },
    status: In(COMMITTED_SHIFT_STATUSES),
    start: LessThan(endAt),
    end: MoreThan(startAt),
  };
  if (excludeShiftId) where.id = Not(excludeShiftId);
  if ((await manager.getRepository(Shift).count({ where })) > 0) {
    throw new ForbiddenException('Guard has an overlapping shift assignment.');
  }
}
