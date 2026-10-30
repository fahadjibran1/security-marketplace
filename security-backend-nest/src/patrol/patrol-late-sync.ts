import { PATROL_REVIEW_FLAGS, PatrolErrorCode, PatrolSyncFlag } from './patrol-constants';

/**
 * Offline sync after Book Off (owner requirement, Patrols P1-B). Pure: no database, no clock.
 *
 * A patrol started during an authorised shift may sync its scans and completion after the Guard books off, and a run
 * created offline may first reach the server after Book Off, within the POST-SHIFT SYNC ACCEPTANCE WINDOW: by default
 * 24 h after the Book Off (or the shift's scheduled end when there is none), policy postShiftSyncHours (1–72). It is
 * separate from the 60-minute operational sync grace, which only decides when missing evidence is reported.
 *
 * The documented rule for a run first reaching the server after its shift ended ("post-shift creation"):
 *   REFUSE (409)       PATROL_SYNC_NOT_BOOKED_ON   the Guard had no effective Book On on that shift;
 *                      PATROL_SYNC_WINDOW_CLOSED   the acceptance window has closed — unless an Owner / Admin recovery
 *                                                  grant (issue #68) is active for this Guard and shift: then the run is
 *                                                  accepted and also flagged recovered_via_grant (needsReview).
 *   ACCEPT AND FLAG    otherwise. The run is stored provisional (its device times stand until reviewed), syncedLate,
 *                      flagged post_shift_creation, plus:
 *                        outside_on_duty_interval  its drift-adjusted device start is outside Book On → Book Off;
 *                        no_matching_window        no scheduled window contains it (for a scheduled run), or the run is
 *                                                  unscheduled and the policy does not allow unscheduled patrols;
 *                        clock_drift_suspect       |server receipt − sentAtDevice| beyond the policy threshold.
 *                      needsReview = true when any of those three is present (legitimacy only partly supported).
 *                      Every flagged acceptance is audited (patrol.late_sync_flagged).
 * The shift-assignment and tenant checks (the Guard's own shift, the company's switch) come first, in PatrolAccessService,
 * and a clientRunId already accepted is a replay that always succeeds, even after the window closes.
 *
 * Clock drift: when the app sends sentAtDevice (its clock at the moment it sent the request), drift = server receipt −
 * sentAtDevice, and device times are adjusted by it (a phone 10 minutes fast has drift −10 min, so its startedAtDevice is
 * read 10 minutes earlier). The original device times are always stored as sent; only the legitimacy check uses the
 * adjusted time.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const INT32_MAX = 2_147_483_647;

/** Server receipt − the device's own send time, or null when the app did not send one (or it is absurd). */
export function clockDriftMs(receivedAt: Date, sentAtDevice: Date | null | undefined): number | null {
  if (!sentAtDevice) return null;
  const drift = receivedAt.getTime() - sentAtDevice.getTime();
  return Number.isFinite(drift) && Math.abs(drift) <= INT32_MAX ? drift : null;
}

export function isClockDriftSuspect(driftMs: number | null, thresholdMinutes: number): boolean {
  return driftMs !== null && Math.abs(driftMs) > thresholdMinutes * MINUTE;
}

/** A device time corrected by the measured drift (unchanged without one). */
export function adjustForDrift(deviceTime: Date, driftMs: number | null): Date {
  return driftMs === null ? deviceTime : new Date(deviceTime.getTime() + driftMs);
}

/** When the post-shift sync acceptance window closes: Book Off (or the scheduled end) + postShiftSyncHours. */
export function syncAcceptanceEndsAt(bookOffAt: Date | null, shiftEnd: Date, postShiftSyncHours: number): Date {
  return new Date((bookOffAt ?? shiftEnd).getTime() + postShiftSyncHours * HOUR);
}

/** Whether a NEW write to an ended shift is still accepted at `now`. */
export function withinSyncAcceptance(now: Date, bookOffAt: Date | null, shiftEnd: Date, postShiftSyncHours: number): boolean {
  return now.getTime() <= syncAcceptanceEndsAt(bookOffAt, shiftEnd, postShiftSyncHours).getTime();
}

export type PostShiftStartInput = {
  now: Date;
  /** The Guard's effective Book On / Book Off on the shift (effective-attendance.ts), filtered to this Guard. */
  bookOnAt: Date | null;
  bookOffAt: Date | null;
  shiftEnd: Date;
  postShiftSyncHours: number;
  clockDriftThresholdMinutes: number;
  startedAtDevice: Date;
  driftMs: number | null;
  scheduled: boolean;
  /** A scheduled window of the site contains the adjusted start (windowForStart found one). */
  matchingWindow: boolean;
  allowUnscheduledPatrols: boolean;
  /**
   * Issue #68: an Owner / Admin recovery grant is active for this Guard on this shift. Consulted ONLY when the window has
   * closed: the run is then accepted, flagged recovered_via_grant (a review flag: needsReview). Book On is still required.
   */
  recoveryGrant?: boolean;
};

export type PostShiftStartDecision =
  | { accept: false; code: PatrolErrorCode.SYNC_NOT_BOOKED_ON | PatrolErrorCode.SYNC_WINDOW_CLOSED; message: string; acceptanceEndsAt: Date | null }
  | { accept: true; flags: PatrolSyncFlag[]; needsReview: boolean; adjustedStart: Date; acceptanceEndsAt: Date };

export function evaluatePostShiftStart(input: PostShiftStartInput): PostShiftStartDecision {
  if (!input.bookOnAt) {
    return {
      accept: false,
      code: PatrolErrorCode.SYNC_NOT_BOOKED_ON,
      message: 'This patrol cannot be accepted: you did not Book On to this shift.',
      acceptanceEndsAt: null,
    };
  }
  const acceptanceEndsAt = syncAcceptanceEndsAt(input.bookOffAt, input.shiftEnd, input.postShiftSyncHours);
  const windowClosed = input.now.getTime() > acceptanceEndsAt.getTime();
  if (windowClosed && !input.recoveryGrant) {
    return {
      accept: false,
      code: PatrolErrorCode.SYNC_WINDOW_CLOSED,
      message: `Patrol data for this shift could only be sent until ${acceptanceEndsAt.toISOString()} (${input.postShiftSyncHours} h after it ended).`,
      acceptanceEndsAt,
    };
  }
  const adjustedStart = adjustForDrift(input.startedAtDevice, input.driftMs);
  const dutyEnd = input.bookOffAt ?? input.shiftEnd;
  const flags: PatrolSyncFlag[] = ['post_shift_creation'];
  if (windowClosed) flags.push('recovered_via_grant');
  if (adjustedStart.getTime() < input.bookOnAt.getTime() || adjustedStart.getTime() > dutyEnd.getTime()) flags.push('outside_on_duty_interval');
  if (input.scheduled ? !input.matchingWindow : !input.allowUnscheduledPatrols) flags.push('no_matching_window');
  if (isClockDriftSuspect(input.driftMs, input.clockDriftThresholdMinutes)) flags.push('clock_drift_suspect');
  return { accept: true, flags, needsReview: flags.some((f) => PATROL_REVIEW_FLAGS.includes(f)), adjustedStart, acceptanceEndsAt };
}
