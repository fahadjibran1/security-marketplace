// "Today so far" — the shift of the day, counted once. (Phase 4A.3.)
//
// Nine numbers, no chart. Live Operations is a decision surface: a controller reads this to know whether
// the day is under control, and goes to Analytics for trends.
//
// IT COUNTS THE SAME ROWS THE TIMELINE DRAWS. Not a second query, not a count per metric, not one request
// per card — one pass over the array the board already has. That is the only reason the summary cannot
// say four missed Welfare Checks while the board draws three.
//
// A NOTE ON "MISSED", BECAUSE TWO HONEST NUMBERS DIFFER HERE. This counts missed Welfare WINDOWS, which is
// what the markers draw and what the export lists. The status bar above counts missed Welfare CHECK
// ALERTS — deliberately one per shift, because twenty-four missed windows are one thing to act on, not
// twenty-four. Both are right; they measure different things, so this panel says "windows" on its face.

import type { OutlookShiftInput } from './operationsOutlook';
import type { WelfareMarkerState } from './operationsTimeline';

export type TodaySoFar = {
  attendance: {
    bookedOn: number;
    /** Scheduled start has passed with nothing recorded, and the shift has not settled. */
    lateNotBookedOn: number;
    bookedOff: number;
  };
  welfare: {
    completed: number;
    overdue: number;
    missed: number;
  };
  operations: {
    openIncidents: number;
    siteRequests: number;
    emergencyAlerts: number;
  };
  /** How many rows produced these numbers, so a reader can see the scope they cover. */
  shiftCount: number;
};

const SETTLED = ['completed', 'cancelled', 'missed', 'rejected'];

const OPEN_INCIDENT_STATUSES = ['open', 'in_review'];

const EMPTY: TodaySoFar = {
  attendance: { bookedOn: 0, lateNotBookedOn: 0, bookedOff: 0 },
  welfare: { completed: 0, overdue: 0, missed: 0 },
  operations: { openIncidents: 0, siteRequests: 0, emergencyAlerts: 0 },
  shiftCount: 0,
};

/**
 * The summary for exactly the rows given.
 *
 * Pass the filtered set — the same one the timeline, Next Up and the export use — and every panel on the
 * page is describing one day, one scope and one truth.
 */
export function buildTodaySoFar(
  inputs: readonly OutlookShiftInput[],
  nowMs: number,
): TodaySoFar {
  const total: TodaySoFar = {
    attendance: { ...EMPTY.attendance },
    welfare: { ...EMPTY.welfare },
    operations: { ...EMPTY.operations },
    shiftCount: inputs.length,
  };

  for (const input of inputs) {
    const settled = SETTLED.includes((input.shift.status || '').trim().toLowerCase());
    const on = input.attendance?.checkInAt ?? null;
    const off = input.attendance?.checkOutAt ?? null;
    const startMs = Date.parse(input.shift.start);

    if (on) total.attendance.bookedOn += 1;
    if (off) total.attendance.bookedOff += 1;
    if (!on && !settled && Number.isFinite(startMs) && nowMs > startMs) {
      total.attendance.lateNotBookedOn += 1;
    }

    // The engine's own window verdicts, passed through. Nothing is recomputed, so these three numbers are
    // the markers on the bars, counted.
    for (const w of input.operations?.welfare?.windows ?? []) {
      const state = (w as { state?: WelfareMarkerState }).state;
      if (state === 'completed') total.welfare.completed += 1;
      else if (state === 'overdue') total.welfare.overdue += 1;
      else if (state === 'missed') total.welfare.missed += 1;
    }

    for (const incident of input.incidents ?? []) {
      if (OPEN_INCIDENT_STATUSES.includes((incident.status || '').trim().toLowerCase())) {
        total.operations.openIncidents += 1;
      }
    }

    for (const alert of input.alerts ?? []) {
      if ((alert.status || '').trim().toLowerCase() === 'closed') continue;
      const type = (alert.type || '').trim().toLowerCase();
      if (type === 'site_request') total.operations.siteRequests += 1;
      else if (type === 'panic') total.operations.emergencyAlerts += 1;
    }
  }

  return total;
}
