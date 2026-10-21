import { ConflictException } from '@nestjs/common';

/**
 * When a Guard may accept an offered shift (owner decision, 21 Oct 2026).
 *
 *   before the scheduled start          → may accept
 *   from the start until the end        → may accept (a late replacement; the app says the shift has started)
 *   at or after the scheduled end       → may NOT accept: the offer has expired
 *
 * Instants, not wall clocks: an overnight shift or one spanning a clock change is compared by its true start
 * and end, so neither midnight nor BST/GMT can open or close the window early. The decision is enforced on
 * the server (and, at the moment of the write, by the database clock); the device clock never decides.
 * Declining is unaffected, and nothing is deleted: an expired offer stays on record exactly as it was.
 */
export type OfferAcceptanceWindow = 'before_start' | 'started' | 'ended';

export function offerAcceptanceWindow(start: Date, end: Date, now: Date): OfferAcceptanceWindow {
  if (now.getTime() >= end.getTime()) return 'ended';
  if (now.getTime() >= start.getTime()) return 'started';
  return 'before_start';
}

/** Machine-readable, so the Guard app can show its own wording rather than parse a message. */
export const SHIFT_OFFER_EXPIRED_CODE = 'SHIFT_OFFER_EXPIRED';
export const SHIFT_OFFER_EXPIRED_MESSAGE =
  'This shift has already ended, so the offer can no longer be accepted. Contact your control room if you are still needed.';

export function shiftOfferExpiredException(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: SHIFT_OFFER_EXPIRED_CODE,
    message: SHIFT_OFFER_EXPIRED_MESSAGE,
  });
}
