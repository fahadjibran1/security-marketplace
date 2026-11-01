// S4 1.3.0 B2: the plain-English wording of the guided site patrol setup and of a shift's patrol requirement, shared by
// Patrol Management (Setup) and the Rota Planner. Display only: the server decides (GET /patrols/sites/:id/setup).

import type {
  PatrolEvidenceMode,
  PatrolSetupChecklistItem,
  PatrolSetupMode,
  PatrolSiteSetup,
  PatrolWindowAnchor,
  RotaSlotPatrolRequirement,
} from '../../types/patrols';

export const SETUP_MODE_OPTIONS: Array<{ value: PatrolSetupMode; label: string; help: string }> = [
  { value: 'every_shift', label: 'Every shift', help: 'Every shift at this site patrols, unless a shift is marked "Not Required".' },
  { value: 'per_shift', label: 'Only shifts marked Required', help: 'Only shifts marked "Required" in the Rota Planner patrol.' },
  { value: 'off', label: 'No patrols', help: 'Shifts at this site do not patrol.' },
];

/** Evidence method: QR only / Photos only / QR + Photos. There is deliberately no photo-count setting. */
export const EVIDENCE_MODE_OPTIONS: Array<{ value: PatrolEvidenceMode; label: string; help: string }> = [
  { value: 'qr', label: 'QR only', help: 'Guards scan the printed checkpoint labels.' },
  { value: 'photo', label: 'Photos only', help: 'Guards take a photo during each patrol. No checkpoint labels are needed.' },
  { value: 'qr_photo', label: 'QR + Photos', help: 'Guards scan the checkpoint labels and take a photo during each patrol.' },
];

export const ANCHOR_OPTIONS: Array<{ value: PatrolWindowAnchor; label: string; help: string }> = [
  { value: 'scheduled_start', label: 'From the scheduled start', help: 'Patrol times count from the shift\'s scheduled start (recommended).' },
  { value: 'book_on', label: 'From Book On', help: 'Patrol times count from when the Guard books on.' },
];

export const FREQUENCY_PRESETS = [30, 60, 120, 180, 240];
export const FREQUENCY_MIN = 15;
export const FREQUENCY_MAX = 1440;

export function everyText(minutes: number | null | undefined): string {
  if (minutes == null) return 'no frequency set';
  if (minutes % 60 === 0) return minutes === 60 ? 'every hour' : `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

export function frequencyLabel(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

export function evidenceModeLabel(mode: PatrolEvidenceMode | null | undefined): string {
  return EVIDENCE_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? 'Not set';
}

export function setupModeLabel(mode: PatrolSetupMode | null | undefined): string {
  return SETUP_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? 'Not set up';
}

/** The site default in one line — the same wording the server uses for the Rota Planner (siteDefaultSummary). */
export function siteDefaultSummary(setupMode: PatrolSetupMode | null | undefined, active: boolean, frequencyMinutes: number | null | undefined, windowAnchor: PatrolWindowAnchor | null | undefined): string {
  if (!setupMode || setupMode === 'off') return 'Site default: no patrols (patrols are not set up for this site).';
  const from = windowAnchor === 'book_on' ? 'from Book On' : 'from the scheduled start';
  const which = setupMode === 'every_shift' ? 'every shift patrols' : 'only shifts marked "Required" patrol';
  const timing = `${everyText(frequencyMinutes ?? null)}, ${from}`;
  return active
    ? `Site default: ${which}, ${timing}.`
    : `Site default: ${which}, ${timing} - not active yet (the site's patrol setup has not been activated).`;
}

export function siteDefaultFromSetup(setup: Pick<PatrolSiteSetup, 'setupMode' | 'active' | 'frequencyMinutes' | 'windowAnchor'> | null | undefined): string {
  if (!setup) return siteDefaultSummary(null, false, null, null);
  return siteDefaultSummary(setup.setupMode, setup.active, setup.frequencyMinutes, setup.windowAnchor);
}

// ─── the Rota Planner's Patrol Requirement ─────────────────────────────────────────────────────────────────────────

export type RotaPatrolChoice = 'site_default' | 'required' | 'not_required';

export const ROTA_PATROL_OPTIONS: Array<{ value: RotaPatrolChoice; label: string }> = [
  { value: 'site_default', label: 'Use Site Default' },
  { value: 'required', label: 'Required' },
  { value: 'not_required', label: 'Not Required' },
];

export function rotaPatrolValueLabel(value: RotaSlotPatrolRequirement['value'] | null | undefined): string {
  if (value === 'mixed') return 'Mixed (set on individual shifts)';
  return ROTA_PATROL_OPTIONS.find((o) => o.value === value)?.label ?? 'Use Site Default';
}

/** What the slot will do, in one line: the server's own summary, or (before it answers) the choice's meaning. */
export function rotaPatrolEffectLine(view: RotaSlotPatrolRequirement | null | undefined): string | null {
  if (!view) return null;
  return view.summary;
}

// ─── the guided setup ──────────────────────────────────────────────────────────────────────────────────────────────

export type SetupDraft = {
  setupMode: PatrolSetupMode | null;
  evidenceMode: PatrolEvidenceMode | null;
  frequency: string;
  windowAnchor: PatrolWindowAnchor;
  /** null: every confirmed checkpoint (the automatic route). */
  routeId: number | null;
};

export function draftFromSetup(setup: PatrolSiteSetup): SetupDraft {
  return {
    setupMode: setup.setupMode,
    evidenceMode: setup.evidenceMode ?? null,
    frequency: setup.frequencyMinutes != null ? String(setup.frequencyMinutes) : '',
    windowAnchor: setup.windowAnchor ?? 'scheduled_start',
    routeId: setup.route?.mode === 'custom' ? setup.route.currentVersion?.id ?? null : null,
  };
}

/** Field problems, in plain English, keyed by step. Empty when the draft can be saved. */
export function setupDraftProblems(draft: SetupDraft): Partial<Record<'setupMode' | 'evidenceMode' | 'frequency', string>> {
  const problems: Partial<Record<'setupMode' | 'evidenceMode' | 'frequency', string>> = {};
  if (!draft.setupMode) problems.setupMode = 'Choose which shifts patrol at this site.';
  if (!draft.evidenceMode) problems.evidenceMode = 'Choose how Guards prove a patrol: QR only, Photos only, or QR + Photos.';
  const text = draft.frequency.trim();
  const n = Number(text);
  if (draft.setupMode !== 'off') {
    if (!text) problems.frequency = 'Choose how often a patrol is due.';
    else if (!/^\d+$/.test(text) || !Number.isInteger(n)) problems.frequency = 'Enter the frequency as a whole number of minutes.';
    else if (n < FREQUENCY_MIN) problems.frequency = `A patrol can be due at most every ${FREQUENCY_MIN} minutes.`;
    else if (n > FREQUENCY_MAX) problems.frequency = 'A patrol must be due at least once a day (1440 minutes).';
  } else if (text && (!/^\d+$/.test(text) || n < FREQUENCY_MIN || n > FREQUENCY_MAX)) {
    problems.frequency = `Enter a frequency between ${FREQUENCY_MIN} and ${FREQUENCY_MAX} minutes.`;
  }
  return problems;
}

/** Whether the draft differs from what the server holds (the checklist and activation read the SAVED setup). */
export function setupDraftChanged(draft: SetupDraft, setup: PatrolSiteSetup): boolean {
  const saved = draftFromSetup(setup);
  return draft.setupMode !== saved.setupMode
    || draft.evidenceMode !== saved.evidenceMode
    || draft.frequency.trim() !== saved.frequency
    || draft.windowAnchor !== saved.windowAnchor
    || (draft.evidenceMode !== 'photo' && draft.routeId !== saved.routeId);
}

export type ChecklistRow = { code: string; ok: boolean; text: string };

/**
 * The checklist on screen: the server's items (what activation checks) in plain English, plus "save your changes"
 * while the form differs from the saved setup. Activate is enabled only when every row is ok.
 */
export function setupChecklist(setup: PatrolSiteSetup, draftChanged: boolean): ChecklistRow[] {
  const rows: ChecklistRow[] = (setup.checklist ?? []).map((item: PatrolSetupChecklistItem) => ({
    code: item.code,
    ok: Boolean(item.ok),
    text: item.ok ? checklistDoneText(item, setup) : item.text,
  }));
  rows.push({ code: 'saved', ok: !draftChanged, text: draftChanged ? 'Save your changes before activating.' : 'All changes are saved.' });
  return rows;
}

function checklistDoneText(item: PatrolSetupChecklistItem, setup: PatrolSiteSetup): string {
  switch (item.code) {
    case 'setup_mode': return `Which shifts patrol: ${setupModeLabel(setup.setupMode).toLowerCase()}.`;
    case 'frequency': return `How often: ${everyText(setup.frequencyMinutes)}.`;
    case 'confirmed_checkpoints': {
      const n = setup.checkpoints.filter((c) => c.confirmed && c.active).length;
      return `${n} checkpoint${n === 1 ? '' : 's'} test-scanned and ready.`;
    }
    case 'route_checkpoints': return 'The chosen route has a required checkpoint.';
    default: return item.text;
  }
}

export function canActivate(rows: ChecklistRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.ok);
}

/** The final summary shown before Activate: what will happen, in plain English. */
export function activationSummary(setup: PatrolSiteSetup): string[] {
  const site = setup.siteName ?? 'this site';
  const lines: string[] = [];
  if (setup.setupMode === 'every_shift') lines.push(`Every shift at ${site} will patrol, unless a shift is marked "Not Required" in the Rota Planner.`);
  else if (setup.setupMode === 'per_shift') lines.push(`Only shifts at ${site} marked "Required" in the Rota Planner will patrol.`);
  else lines.push(`Shifts at ${site} will not patrol.`);
  if (setup.setupMode && setup.setupMode !== 'off') {
    lines.push(`A patrol is due ${everyText(setup.frequencyMinutes)}, counted ${setup.windowAnchor === 'book_on' ? 'from Book On' : 'from the shift\'s scheduled start'}.`);
  }
  if (setup.evidenceMode === 'photo') lines.push('Evidence: a photo during each patrol. No checkpoint labels are used.');
  else {
    const route = setup.route?.currentVersion;
    const names = (route?.checkpoints ?? []).map((c) => c.label);
    const scans = setup.route?.mode === 'custom'
      ? `the checkpoints of the route "${route?.name ?? ''}"`
      : `${names.length} test-scanned checkpoint${names.length === 1 ? '' : 's'}`;
    lines.push(`Evidence: QR scans of ${scans}${names.length ? ` (${names.join(', ')})` : ''}${setup.evidenceMode === 'qr_photo' ? ', plus a photo during each patrol' : ''}.`);
  }
  lines.push('The change applies to patrol times from now on; patrols already recorded keep the rules they were checked against.');
  return lines;
}

/** The server's refusals of a setup write, read for the screen (422 PATROL_SETUP_INCOMPLETE lists what is missing). */
export function setupFailureText(error: unknown, fallback: string): string {
  const body = (error as { body?: any })?.body;
  if (body && typeof body === 'object' && body.code === 'PATROL_SETUP_INCOMPLETE') {
    const missing: string[] = Array.isArray(body.details?.checklist)
      ? body.details.checklist.filter((c: any) => c && !c.ok && typeof c.text === 'string').map((c: any) => c.text)
      : [];
    return missing.length
      ? `Not activated yet. Still to do: ${missing.join(' ')}`
      : 'Not activated yet: the site setup is not complete.';
  }
  if (body && typeof body === 'object' && body.code === 'PATROL_CHECKPOINT_TEST_SCAN_INVALID') {
    return typeof body.message === 'string' && body.message.trim()
      ? `That scan was not accepted: ${body.message}`
      : 'That scan was not accepted. Scan the label printed for this checkpoint.';
  }
  const message = body && typeof body === 'object' ? body.message : null;
  if (typeof message === 'string' && message.trim()) return message;
  if (Array.isArray(message) && message.length) return message.join(' ');
  if ((error as { status?: number })?.status === 403) return 'You do not have permission to change the patrol setup.';
  return fallback;
}
