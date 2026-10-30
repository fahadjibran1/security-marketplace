// Stale temporary patrol camera files (S4 1.2.0, Patrols P1-E hardening). PURE: the device is a port, so
// scripts/guard-patrols.spec.cjs executes exactly this decision.
//
// A patrol photo passes through two temporary files in the app's CACHE before it is queued: the camera's capture
// (expo-camera writes `<cache>/Camera/<uuid>.jpg`) and the re-encoded JPEG (expo-image-manipulator writes
// `<cache>/ImageManipulator/<uuid>.jpg`). processCapturedPhoto removes both in a `finally`, but an app killed mid-photo
// (or a crash in the native module) leaves them behind. They can hold an un-stripped capture (EXIF), so they are swept:
//
//   * only files directly inside those two cache folders are ever considered (ports.isTempLocation);
//   * NEVER anything under patrol-evidence/ — the queued evidence is not temporary, whatever a port says;
//   * NEVER a file any outbox row (of any Guard on this phone) still references;
//   * only files last modified more than PATROL_TEMP_MAX_AGE_MS ago (a photo being processed right now is young);
//   * a file whose age cannot be read is kept, and if the outbox cannot be read nothing at all is removed — a doubt never
//     deletes anything.

export const PATROL_TEMP_MAX_AGE_MS = 60 * 60_000;
/** The sweep runs when a Guard's patrol queue starts and then at most this often, before a sync pass. */
export const PATROL_TEMP_SWEEP_INTERVAL_MS = 10 * 60_000;

export type PatrolTempFile = { uri: string; modifiedAtMs: number | null };

export interface PatrolTempCleanupPorts {
  /** The files directly inside the camera's and the image manipulator's cache output folders. */
  listTempFiles(): Promise<PatrolTempFile[]>;
  /** Every file location any outbox row still references, whoever it belongs to. */
  referencedPaths(): Promise<string[]>;
  /** Whether the location is directly inside one of those two cache folders. */
  isTempLocation(uri: string): boolean;
  deleteFile(uri: string): Promise<void>;
}

export type PatrolTempCleanupReport = { removed: string[]; kept: number; failed: number; skipped: 'outbox_unreadable' | null };

const normalise = (uri: string): string => uri.replace(/^file:\/\//, '').replace(/\/+$/, '');

/** Whether a location is (or is inside) the patrol evidence folder: never a temporary file. */
export function isPatrolEvidenceLocation(uri: string): boolean {
  return /(^|\/)patrol-evidence(\/|$)/.test(normalise(uri));
}

export async function cleanStalePatrolTempFiles(
  ports: PatrolTempCleanupPorts,
  nowMs: number,
  maxAgeMs: number = PATROL_TEMP_MAX_AGE_MS,
): Promise<PatrolTempCleanupReport> {
  let referenced: Set<string>;
  try {
    referenced = new Set((await ports.referencedPaths()).filter((p) => typeof p === 'string').map(normalise));
  } catch {
    return { removed: [], kept: 0, failed: 0, skipped: 'outbox_unreadable' };
  }
  let files: PatrolTempFile[];
  try {
    files = await ports.listTempFiles();
  } catch {
    files = [];
  }
  const report: PatrolTempCleanupReport = { removed: [], kept: 0, failed: 0, skipped: null };
  for (const file of files) {
    const uri = typeof file?.uri === 'string' ? file.uri : '';
    const age = typeof file?.modifiedAtMs === 'number' && Number.isFinite(file.modifiedAtMs) ? nowMs - file.modifiedAtMs : null;
    const stale = age != null && age >= maxAgeMs;
    if (!uri || uri.includes('..') || !ports.isTempLocation(uri) || isPatrolEvidenceLocation(uri) || referenced.has(normalise(uri)) || !stale) {
      report.kept += 1;
      continue;
    }
    try {
      await ports.deleteFile(uri);
      report.removed.push(uri);
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
