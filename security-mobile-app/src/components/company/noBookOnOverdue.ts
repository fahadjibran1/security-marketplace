// No Book On — Overdue, and the explicit Mark Missed action. (Production defect, 27 Oct 2026.)
//
// The company dashboard used to mark a Ready shift MISSED by itself: while Live Operations was open, an effect
// found every Ready shift 15 minutes past its start with no Book On and sent `status: 'missed'` under whoever
// was signed in. A shift replaced and re-accepted after its start (shift 70: accepted 14:36:39, marked missed
// 14:36:50 by an open tab) was taken away from a Guard who could no longer Book On, because `missed` cannot
// return to `ready`.
//
// Nothing in the app now changes a shift's status on its own. The same condition is only SHOWN — "No Book On —
// Overdue", with how long — and a shift manager can choose to mark it missed, with a reason, after reading what
// that does. This module is pure: it reads a shift, its attendance and an instant, and decides nothing on the
// server's behalf. The API (assertMayMarkMissed) remains the authority on whether a shift may be marked missed.

/** Matches the API's MISSED_SHIFT_GRACE_MINUTES: a shift cannot be marked missed earlier than this. */
export const NO_BOOK_ON_GRACE_MINUTES = 15;

export const NO_BOOK_ON_OVERDUE_LABEL = 'No Book On — Overdue';

export const MARK_MISSED_REASON_MIN = 5;
export const MARK_MISSED_REASON_MAX = 500;

type ShiftLike = { status?: string | null; start: string };
type AttendanceLike = { checkInAt?: string | null } | null | undefined;

/** 'accepted' is the legacy spelling of 'ready'. */
function isReady(status?: string | null): boolean {
  const normalized = (status || '').trim().toLowerCase();
  return normalized === 'ready' || normalized === 'accepted';
}

/**
 * Whole minutes since the scheduled start when a Ready shift has had no Book On for at least the grace
 * period; otherwise null. Read-only: the shift stays Ready, so the Guard can still Book On late.
 */
export function noBookOnOverdueMinutes(shift: ShiftLike, attendance: AttendanceLike, nowMs: number): number | null {
  if (!isReady(shift.status) || attendance?.checkInAt) return null;
  const startMs = Date.parse(shift.start);
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return null;
  const elapsedMs = nowMs - startMs;
  if (elapsedMs < NO_BOOK_ON_GRACE_MINUTES * 60_000) return null;
  return Math.floor(elapsedMs / 60_000);
}

/** "45 min" / "2h 05m": how long since the scheduled start. */
export function formatOverdueMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
}

/** The one sentence every surface uses for the warning. */
export function noBookOnOverdueText(minutes: number): string {
  return `${formatOverdueMinutes(minutes)} since the scheduled start and no Book On recorded. The shift stays Ready, so the Guard can still Book On.`;
}

/** What marking a shift missed does, stated before it is done. */
export const MARK_MISSED_CONSEQUENCES = [
  'The shift will be marked Missed. A missed shift cannot return to Ready, so the Guard will no longer be able to Book On to it.',
  'If the Guard is only running late, leave the shift Ready: they can still Book On late. If someone else will cover it, use Replace Guard instead (Rota Planner or Shift Offers), which keeps the shift.',
  'The status change is recorded in the audit log under your name.',
] as const;

export function validateMarkMissedReason(reason: string): { ok: true } | { ok: false; message: string } {
  const trimmed = reason.trim();
  if (trimmed.length < MARK_MISSED_REASON_MIN) {
    return { ok: false, message: 'Enter the reason this shift is being marked missed.' };
  }
  if (trimmed.length > MARK_MISSED_REASON_MAX) {
    return { ok: false, message: `Keep the reason under ${MARK_MISSED_REASON_MAX} characters.` };
  }
  return { ok: true };
}
