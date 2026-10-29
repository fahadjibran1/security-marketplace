/**
 * Patrol metadata retention, by category (owner-approved 28 Oct 2026). P1-A recorded the rules and the columns they
 * need. P1-C implements the photo rule: PatrolEvidenceMaintenanceService moves expired photos through the deletion state
 * machine (PatrolEvidenceLifecycleService) — shipped "report only" (PATROL_EVIDENCE_RETENTION_MODE=report) — and never
 * touches anything under an active hold (patrol_evidence_holds). The other categories are not purged by Phase 1.
 *
 *   photos (the image object)          30 days from cloud receipt (receivedAt, set when the server first finds the
 *                                      uploaded object); 90 where the site policy says so
 *                                      (patrol_evidence.retentionDays / expiresAt, set at verification)
 *   precise coordinates                30 days, then nulled (coordinatesPurgedAt) — none are collected while
 *                                      location verification is disabled
 *   checkpoint visits                  12 months
 *   patrol runs                        24 months
 *   evidence hashes / tombstones       kept with their run (the row outlives the photo: retentionStatus 'tombstone')
 *   audit entries                      24 months
 *   evidence holds                     6 years after release
 *   export records                     24 months
 */
export const PATROL_RETENTION = Object.freeze({
  photoDefaultDays: 30,
  photoExtendedDays: 90,
  preciseCoordinatesDays: 30,
  visitMonths: 12,
  runMonths: 24,
  /** Evidence rows (hashes, times, actor ids — never the image) are kept as long as their run. */
  evidenceTombstoneFollowsRun: true,
  auditMonths: 24,
  holdYearsAfterRelease: 6,
  exportRecordMonths: 24,
} as const);

export type PatrolRetentionCategory =
  | 'photo'
  | 'precise_coordinates'
  | 'visit'
  | 'run'
  | 'evidence_tombstone'
  | 'audit'
  | 'hold'
  | 'export_record';

/** Adds whole calendar months in UTC (clamped to the month's last day). */
export function addUtcMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** Photo expiry: expiresAt = cloud receipt (receivedAt) + retentionDays. P1-C never shortens an existing one (a restore only extends). */
export function photoExpiresAt(receivedAt: Date, retentionDays: number): Date {
  return new Date(receivedAt.getTime() + retentionDays * 86_400_000);
}
