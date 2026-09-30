// How a shift's Welfare Check interval is decided. (Extracted in Phase 3D.)
//
// WHERE THE VALUE ACTUALLY COMES FROM
// `shifts.checkCallIntervalMinutes` is `integer NOT NULL DEFAULT 60`, and migration 1719040000000
// backfilled it from each site's own interval when the column was added. It is therefore not an
// "override that may be absent" — it is a MATERIALISED copy of the effective interval, resolved when the
// shift is written.
//
// That has a consequence worth stating, because it looks like a bug and is not. The window engine reads
// the interval as `shift ?? site ?? 60` (locked in Phase 3A-ii), and the shift term is never null, so the
// site term there is unreachable. It is unreachable because this function has already consulted the site.
// Resolving it at write time is what makes a shift's interval stable: changing a site's default does not
// silently re-time Welfare Checks on shifts already planned and briefed.
//
// The rule was written out three times in ShiftService — on create, on the rota-slot create path, and on
// update — which is three chances for them to drift apart. It is one function now, and it is executed.

/** The system-wide default, used when neither the caller nor the site expresses a preference. */
export const DEFAULT_WELFARE_INTERVAL_MINUTES = 60;

/**
 * The interval to store on a shift.
 *
 * An explicit request wins, then the site's configured default, then the system default. A non-positive
 * or non-finite request is not an instruction, so it falls through rather than being stored — a zero
 * interval would mean a Welfare Check owed continuously.
 */
export function resolveShiftWelfareInterval(
  requested: number | null | undefined,
  siteInterval: number | null | undefined,
): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return requested;
  }
  if (typeof siteInterval === 'number' && Number.isFinite(siteInterval) && siteInterval > 0) {
    return siteInterval;
  }
  return DEFAULT_WELFARE_INTERVAL_MINUTES;
}
