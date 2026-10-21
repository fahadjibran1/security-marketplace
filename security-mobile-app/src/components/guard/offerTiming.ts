// When a Guard may accept an offered shift (owner rule, 21 Oct 2026), as the Guard app presents it:
//   before the start            → may accept
//   started, not yet ended      → may accept, and the app says plainly the shift has already started
//   at or after the end         → cannot accept: the offer has expired (Decline still works)
// The SERVER decides (backend offer-acceptance-window.ts, by its own and the database clock); this only shapes
// what the Guard sees, from the device clock, so a wrong phone clock can never let an expired offer through.

export type OfferTiming = 'upcoming' | 'started' | 'ended';

export function offerTiming(startAt: string, endAt: string, nowMs: number): OfferTiming {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  if (Number.isFinite(end) && nowMs >= end) return 'ended';
  if (Number.isFinite(start) && nowMs >= start) return 'started';
  return 'upcoming';
}

export const OFFER_STARTED_LINE = 'Already started — accept only if you can get there now.';
export const OFFER_ENDED_LINE = 'This shift has ended — it can no longer be accepted.';

/** The backend's machine-readable refusal for an expired offer (SHIFT_OFFER_EXPIRED, HTTP 409). */
export const SHIFT_OFFER_EXPIRED_CODE = 'SHIFT_OFFER_EXPIRED';
export const OFFER_EXPIRED_TITLE = 'Offer expired';
export const OFFER_EXPIRED_MESSAGE =
  'This shift has already ended, so it can no longer be accepted. Contact your control room if you are still needed.';

export function isOfferExpiredError(error: unknown): boolean {
  const body = (error as { body?: unknown } | null)?.body;
  return !!body && typeof body === 'object' && (body as { code?: unknown }).code === SHIFT_OFFER_EXPIRED_CODE;
}
