import { OperationalWindowService } from '../operations/operational-window.service';
import type { PatrolSetupMode, PatrolWindowAnchor, ShiftPatrolRequirement } from './patrol-constants';
import { localDateOf, type PatrolScheduleLike, type PatrolWindow } from './patrol-window.service';

/**
 * Shift-based patrol windows (S4 1.3.0 B1, owner decisions 4 and 5; Migration 74).
 *
 * A site whose patrol setup is ACTIVE (patrol_policies.setupConfirmedAt set, setupMode 'every_shift' or 'per_shift') has
 * one shift-anchored schedule row (patrol_schedules.anchor = 'shift'). Its frequencyMinutes is the site's patrol
 * frequency; a frequency change is a timing change and creates a successor exactly as for a clock schedule (Migration 73,
 * patrol-schedule-versions.ts), so a window belongs to the version in force at its start.
 *
 * Windows are NOT wall-clock slots: they are the shared operational window grid (OperationalWindowService.windowsFor, the
 * engine Welfare uses — elapsed-time arithmetic, so a 60-minute window is 60 real minutes across a DST change), anchored
 * per shift:
 *   anchor            the shift's SCHEDULED start (default; windowAnchor NULL or 'scheduled_start'), or the Guard's
 *                     effective Book On when the site explicitly overrides it ('book_on'; no Book On = no windows);
 *   slot k            [anchor + k × frequency, anchor + (k + 1) × frequency), whole windows only, never past the shift's
 *                     (effective) end — a partial tail window carries no obligation;
 *   obligation        only while the Guard was on duty (OperationalWindowService.isApplicable: overlap with Book On →
 *                     Book Off or the shift end; a cancelled shift owes nothing), and only for an EFFECTIVELY REQUIRED
 *                     shift (effectiveShiftRequirement);
 *   windowKey         "s{scheduleId}:sh{shiftId}:{anchor as YYYYMMDDTHHmmZ}:{k}" — opaque to the Guard app (1.2.1 uses it
 *                     only as a list key), distinct per schedule version, shift and anchor, so a moved shift start never
 *                     reuses an earlier window's key;
 *   scope             always the shift ("sh{shiftId}"): each required shift owes its own patrols, whatever requirementScope.
 *
 * Nothing here touches the database or a clock.
 */

const operational = new OperationalWindowService();
const pad = (n: number) => String(n).padStart(2, '0');

export type ShiftAnchoredWindow = PatrolWindow & { shiftId: number; anchor: 'scheduled_start' | 'book_on' };

/** The site setup as the engine reads it (only a SITE policy row carries one). */
export type PatrolSiteSetup = {
  setupMode: PatrolSetupMode | null;
  windowAnchor: PatrolWindowAnchor;
  setupConfirmedAt: Date | null;
  setupConfirmedByUserId: number | null;
};

export function siteSetupOf(row: any | null | undefined): PatrolSiteSetup {
  return {
    setupMode: (row?.setupMode ?? null) as PatrolSetupMode | null,
    windowAnchor: row?.windowAnchor === 'book_on' ? 'book_on' : 'scheduled_start',
    setupConfirmedAt: row?.setupConfirmedAt ? new Date(row.setupConfirmedAt) : null,
    setupConfirmedByUserId: row?.setupConfirmedByUserId == null ? null : Number(row.setupConfirmedByUserId),
  };
}

/** Whether the site's shift-based patrols are in force: activated, and a mode that patrols. */
export function setupActive(setup: Pick<PatrolSiteSetup, 'setupMode' | 'setupConfirmedAt'>): boolean {
  return setup.setupConfirmedAt != null && (setup.setupMode === 'every_shift' || setup.setupMode === 'per_shift');
}

export type ShiftPatrolRequirementView = {
  /** What the shift says: 'required', 'not_required', or 'site_default' (the column is NULL). */
  value: ShiftPatrolRequirement | 'site_default';
  /** Whether this shift owes shift-based patrol windows. */
  effectiveRequired: boolean;
  /** Where the decision comes from: the shift's own value, or the site's setup. */
  source: 'site' | 'shift';
  summary: string;
};

/**
 * Owner decision 5. effectiveRequired = the shift's own value when it has one, else (setupMode === 'every_shift'); with
 * 'per_shift' a shift patrols only when it says 'required'; 'off' (or no setup, or a setup not yet activated) means no
 * shift-based patrols at all, whatever the shift says.
 */
export function effectiveShiftRequirement(
  setting: string | null | undefined,
  setup: Pick<PatrolSiteSetup, 'setupMode' | 'setupConfirmedAt'>,
): ShiftPatrolRequirementView {
  const value: ShiftPatrolRequirementView['value'] = setting === 'required' || setting === 'not_required' ? setting : 'site_default';
  const source: 'site' | 'shift' = value === 'site_default' ? 'site' : 'shift';
  if (setup.setupMode == null || setup.setupMode === 'off') {
    return { value, effectiveRequired: false, source, summary: 'No patrols: patrols are not set up for this site.' };
  }
  if (setup.setupConfirmedAt == null) {
    return { value, effectiveRequired: false, source, summary: 'No patrols yet: the site\'s patrol setup has not been activated.' };
  }
  if (value === 'required') return { value, effectiveRequired: true, source, summary: 'Patrols required (set on this shift).' };
  if (value === 'not_required') return { value, effectiveRequired: false, source, summary: 'No patrols (set on this shift).' };
  return setup.setupMode === 'every_shift'
    ? { value, effectiveRequired: true, source, summary: 'Patrols required (site default: every shift).' }
    : { value, effectiveRequired: false, source, summary: 'No patrols (site default: only shifts marked as requiring patrols).' };
}

/** "YYYYMMDDTHHmmZ" of an instant (UTC). */
export function anchorTag(anchor: Date): string {
  return `${anchor.getUTCFullYear()}${pad(anchor.getUTCMonth() + 1)}${pad(anchor.getUTCDate())}T${pad(anchor.getUTCHours())}${pad(anchor.getUTCMinutes())}Z`;
}

export function shiftPatrolWindowKey(scheduleId: number, shiftId: number, anchor: Date, slotIndex: number): string {
  return `s${scheduleId}:sh${shiftId}:${anchorTag(anchor)}:${slotIndex}`;
}

/** The scope a shift-anchored window is owed by. */
export function shiftScopeKey(shiftId: number): string {
  return `sh${shiftId}`;
}

/**
 * The windows of one shift for one shift-anchored schedule version (all of them, applicable or not — the caller applies
 * on-duty applicability and the requirement). Version bounds (effectiveFrom / effectiveUntil) decide by window START.
 */
export function shiftAnchoredWindows(
  schedule: PatrolScheduleLike,
  shift: { id: number; start: Date | string; end: Date | string },
  anchorMode: PatrolWindowAnchor,
  bookOnAt: Date | null,
  timeZone: string,
): ShiftAnchoredWindow[] {
  const frequency = Number(schedule.frequencyMinutes);
  if (!(frequency >= 15)) return [];
  const anchor = anchorMode === 'book_on' ? bookOnAt : new Date(shift.start);
  if (!anchor || Number.isNaN(anchor.getTime())) return [];
  const notAfter = new Date(shift.end);
  const length = Math.min(Math.max(1, Number(schedule.windowMinutes) || frequency), frequency);
  const effectiveFrom = schedule.effectiveFrom ? new Date(schedule.effectiveFrom).getTime() : null;
  const effectiveUntil = schedule.effectiveUntil ? new Date(schedule.effectiveUntil).getTime() : null;
  const out: ShiftAnchoredWindow[] = [];
  for (const w of operational.windowsFor({ anchor, notAfter, intervalMinutes: frequency })) {
    const start = w.start.getTime();
    if (effectiveFrom !== null && start < effectiveFrom) continue;
    if (effectiveUntil !== null && start >= effectiveUntil) continue;
    out.push({
      scheduleId: Number(schedule.id),
      windowKey: shiftPatrolWindowKey(Number(schedule.id), Number(shift.id), anchor, w.index),
      localDate: localDateOf(w.start, timeZone),
      slotIndex: w.index,
      start: new Date(start),
      end: new Date(Math.min(start + length * 60_000, w.end.getTime())),
      shiftId: Number(shift.id),
      anchor: anchorMode,
    });
  }
  return out;
}

/**
 * The window a run started at `at` is for (as windowForStart does for clock windows): the window containing `at`, else
 * the latest that ended within the start grace (a late start). Null when neither exists.
 */
export function shiftWindowForStart(
  windows: readonly ShiftAnchoredWindow[],
  at: Date,
  startGraceMinutes: number,
): { window: ShiftAnchoredWindow; lateStart: boolean } | null {
  const t = at.getTime();
  const graceMs = Math.max(0, startGraceMinutes) * 60_000;
  const containing = windows.find((w) => w.start.getTime() <= t && t < w.end.getTime());
  if (containing) return { window: containing, lateStart: false };
  const late = windows.filter((w) => w.end.getTime() <= t && t < w.end.getTime() + graceMs);
  return late.length ? { window: late[late.length - 1], lateStart: true } : null;
}

/** The audit action written when a shift's patrol requirement changes (the sweep's "future windows only" floor). */
export const SHIFT_PATROL_REQUIREMENT_CHANGED_ACTION = 'shift.patrol_requirement_changed';
/** The audit action of a site setup save; afterData.requirementChanged marks a change to who patrols or how windows anchor. */
export const PATROL_SETUP_UPDATED_ACTION = 'patrol.setup.updated';
