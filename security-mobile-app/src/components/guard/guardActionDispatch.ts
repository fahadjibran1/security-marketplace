// Dispatch for the Guard live-shift actions. (Phase 3A-iii; canonical write paths in Phase 3C.)
//
// WHY THE DISPATCH LIVES HERE
// On Build 11 a Guard opened Add Log, typed a note and pressed Submit once. Render's request log showed
// POST /attendance/check-in, /attendance/check-out and /auth/refresh from the same device and session,
// and NO POST /daily-logs. Nothing appeared on screen either, because a refusal was reported only through
// a screen-level strip that the open modal and the keyboard cover.
//
// The five handlers each repeated the same shape — check a precondition, write, then do side effects —
// inside a 4,000-line screen that imports react-native and therefore cannot be executed by a test. That
// is why press-to-API was never covered: there was nowhere to stand. This module is pure and
// dependency-injected, the production screen calls it, and there is no parallel copy of the routing.
//
// A REFUSAL IS NO LONGER SILENT. The outcome is returned as well as reported, so the form can state the
// reason in place, beside the button that would not work.
//
// PHASE 3C — ONE CANONICAL RECORD PER TAP
// Each action writes exactly one row, of exactly one type:
//
//   WELFARE CHECK   daily_logs.welfare_check      (not check_call, and no companion safety alert)
//   LOG BOOK        daily_logs.log_book           (not observation)
//   SITE REQUEST    safety_alerts.site_request    (medium — it is a need, not an emergency)
//   INCIDENT        incidents                     (unchanged)
//   EMERGENCY       safety_alerts.panic, critical (the wire type is unchanged for compatibility)
//
// All three daily-log and alert values have existed in the schema since Migration 59, and both DTOs
// validate with @IsEnum over the whole enum, so nothing here needed a backend change.
//
// Historical rows are untouched and still count: the backend's WELFARE_COMPLETION_LOG_TYPES recognises
// check_call AND welfare_check, so a shift worked before this change still reads as complete.

import type { GuardActionKey } from './guardActionForms';
import { guardActionForm, resolveActionSubmitState } from './guardActionForms';

/** The shift an action applies to. */
export type ActionShift = { id: number; status: string } | null | undefined;

export type GuardActionApi = {
  createDailyLog: (payload: {
    shiftId: number;
    message: string;
    logType: 'welfare_check' | 'log_book';
  }) => Promise<unknown>;
  createIncident: (payload: {
    title: string;
    notes: string;
    severity: 'medium';
    shiftId: number;
  }) => Promise<unknown>;
  createSafetyAlert: (payload: {
    shiftId: number;
    type: 'site_request' | 'panic';
    priority: 'medium' | 'critical';
    message: string;
  }) => Promise<unknown>;
};

export type GuardActionEffects = {
  /** Marks the action in flight. This is what stops a second press starting a second request. */
  setBusy: (key: GuardActionKey, busy: boolean) => void;
  /** Clears the note only after a successful write, so a failure keeps what the Guard typed. */
  clearValue: (key: GuardActionKey) => void;
  closeForm: () => void;
  reload: () => Promise<void>;
  timeline: (shiftId: number, title: string, detail: string) => void;
  feedback: (tone: 'success' | 'error' | 'info', title: string, message: string) => void;
};

export type BlockedReason =
  /** No shift, or a shift that is not in progress. The action needs a live shift either way. */
  | 'no_active_shift'
  | 'note_required'
  /** The Emergency confirmation word was absent or did not match. */
  | 'emergency_confirmation_required'
  /** A submission is already in flight. This is the double-tap guard. */
  | 'busy';

export type GuardActionOutcome =
  | { kind: 'success' }
  | { kind: 'blocked'; reason: BlockedReason; message: string }
  | { kind: 'failed'; reason: 'api_error'; message: string };

export type ActionContext = { shift: ActionShift; value: string; busy: boolean };

/** The lifecycle value every action requires, normalised the way the screen normalises it. */
export function isLiveShift(shift: ActionShift): boolean {
  return !!shift && (shift.status || '').trim().toLowerCase() === 'in_progress';
}

/**
 * Why this action cannot be submitted, or null when it can.
 *
 * Exported separately so the FORM can show the reason before the Guard presses, rather than leaving them
 * to discover it from a toast afterwards.
 */
export function guardActionBlockedReason(
  key: GuardActionKey,
  ctx: ActionContext,
): { reason: BlockedReason; message: string } | null {
  const form = guardActionForm(key);

  if (!ctx.shift || !isLiveShift(ctx.shift)) {
    return { reason: 'no_active_shift', message: `${form.title} is only available during an active shift.` };
  }

  const submit = resolveActionSubmitState(form, { value: ctx.value, busy: ctx.busy });
  if (!submit.disabled) return null;

  if (submit.blockedReason === 'busy') {
    return { reason: 'busy', message: 'Still sending your last submission.' };
  }
  if (submit.blockedReason === 'confirmation') {
    return {
      reason: 'emergency_confirmation_required',
      message: `Type ${form.confirmWord} to confirm.`,
    };
  }
  return { reason: 'note_required', message: 'Enter a note before submitting.' };
}

const SUCCESS: Record<GuardActionKey, { title: string; message: string }> = {
  welfareCheck: { title: 'Welfare Check recorded', message: 'Your Welfare Check was recorded.' },
  logBook: { title: 'Log Book entry saved', message: 'Your Log Book entry was saved.' },
  siteRequest: { title: 'Site Request sent', message: 'The company can now see what the site needs.' },
  incident: { title: 'Incident reported', message: 'The company can now see this incident.' },
  emergency: { title: 'Emergency alert sent', message: 'Emergency alert sent to control room.' },
};

/** What goes on the Guard's own timeline for each action. */
const TIMELINE_TITLE: Record<GuardActionKey, string> = {
  welfareCheck: 'Welfare Check recorded',
  logBook: 'Log Book entry added',
  siteRequest: 'Site Request sent',
  incident: 'Incident raised',
  emergency: 'Emergency alert sent',
};

/**
 * Runs one Guard action end to end: precondition, ONE API write, side effects.
 *
 * Never throws. A transport failure comes back as `failed` and the form stays open with the Guard's text
 * intact, because a submission they cannot retry is worse than the defect this replaces.
 */
export async function dispatchGuardAction(
  key: GuardActionKey,
  ctx: ActionContext,
  api: GuardActionApi,
  fx: GuardActionEffects,
): Promise<GuardActionOutcome> {
  const form = guardActionForm(key);

  const blocked = guardActionBlockedReason(key, ctx);
  if (blocked) {
    fx.feedback(blocked.reason === 'busy' ? 'info' : 'error', form.title, blocked.message);
    return { kind: 'blocked', reason: blocked.reason, message: blocked.message };
  }

  const shiftId = ctx.shift!.id;
  const text = ctx.value.trim();

  try {
    fx.setBusy(key, true);

    // Exactly one call per branch. No branch writes twice, and no branch writes a second record of a
    // different kind for the same tap: one tap, one canonical row.
    if (key === 'welfareCheck') {
      await api.createDailyLog({ shiftId, message: text, logType: 'welfare_check' });
      fx.timeline(shiftId, TIMELINE_TITLE[key], text);
    } else if (key === 'logBook') {
      await api.createDailyLog({ shiftId, message: text, logType: 'log_book' });
      fx.timeline(shiftId, TIMELINE_TITLE[key], text);
    } else if (key === 'siteRequest') {
      await api.createSafetyAlert({ shiftId, type: 'site_request', priority: 'medium', message: text });
      fx.timeline(shiftId, TIMELINE_TITLE[key], text);
    } else if (key === 'incident') {
      await api.createIncident({ title: 'Guard incident', notes: text, severity: 'medium', shiftId });
      fx.timeline(shiftId, TIMELINE_TITLE[key], text);
    } else {
      // The typed value is the confirmation word, never the alert body.
      await api.createSafetyAlert({
        shiftId,
        type: 'panic',
        priority: 'critical',
        message: 'Emergency alert raised by guard from the mobile app.',
      });
      fx.timeline(shiftId, TIMELINE_TITLE[key], 'Emergency alert sent to control room.');
    }

    fx.clearValue(key);
    fx.closeForm();
    await fx.reload();
    fx.feedback('success', SUCCESS[key].title, SUCCESS[key].message);
    return { kind: 'success' };
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : `Unable to send this ${form.title.toLowerCase()}.`;
    fx.feedback('error', `${form.title} failed`, message);
    return { kind: 'failed', reason: 'api_error', message };
  } finally {
    fx.setBusy(key, false);
  }
}
