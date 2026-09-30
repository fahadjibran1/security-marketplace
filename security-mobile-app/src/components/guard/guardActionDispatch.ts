// Dispatch for the Guard live-shift actions. (Phase 3A-iii.)
//
// WHAT THE EVIDENCE SAYS
// On Build 11 a Guard opened Add Log, typed a note and pressed Submit once. Render's request log shows
// POST /attendance/check-in, /attendance/check-out and /auth/refresh from the same device and session,
// and NO POST /daily-logs. Production daily_logs, incidents and safety_alerts have never held a row.
//
// Executing the real modal with the real Button proves the press reaches the router, and the fetch
// interceptor passes every request through untouched. So the press was fine and the transport was fine:
// the handler returned early at its own precondition, and said so only through a transient toast that on
// a small screen appears behind the keyboard. From the Guard's side, nothing happened at all.
//
// WHY THE DISPATCH LIVES HERE NOW
// The five handlers each repeated the same shape — check a precondition, write, then do side effects —
// inside a 4,000-line screen that imports react-native and therefore cannot be executed by a test. That
// is why press-to-API was never covered: there was nowhere to stand. This module is pure and
// dependency-injected, the production screen calls it, and there is no parallel copy of the routing.
//
// A REFUSAL IS NO LONGER SILENT. The outcome is returned as well as reported, so the form can state the
// reason in place, beside the button that would not work.

import type { GuardActionKey } from './guardActionForms';
import { guardActionForm, resolveActionSubmitState } from './guardActionForms';

/** The shift an action applies to. */
export type ActionShift = { id: number; status: string } | null | undefined;

export type GuardActionApi = {
  createDailyLog: (payload: {
    shiftId: number;
    message: string;
    logType: 'observation' | 'check_call';
  }) => Promise<unknown>;
  createIncident: (payload: {
    title: string;
    notes: string;
    severity: 'medium';
    shiftId: number;
  }) => Promise<unknown>;
  createSafetyAlert: (payload: {
    shiftId: number;
    type: 'welfare' | 'panic';
    priority: 'high' | 'critical';
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
  | 'panic_confirmation_required'
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

  if (!ctx.shift) {
    return { reason: 'no_active_shift', message: `${form.title} is only available during an active shift.` };
  }
  if (!isLiveShift(ctx.shift)) {
    return { reason: 'no_active_shift', message: `${form.title} is only available during an active shift.` };
  }

  const submit = resolveActionSubmitState(form, { value: ctx.value, busy: ctx.busy });
  if (!submit.disabled) return null;

  if (submit.blockedReason === 'busy') {
    return { reason: 'busy', message: 'Still sending your last submission.' };
  }
  if (submit.blockedReason === 'confirmation') {
    return { reason: 'panic_confirmation_required', message: `Type ${form.confirmWord} to confirm.` };
  }
  return { reason: 'note_required', message: 'Enter a note before submitting.' };
}

const SUCCESS: Record<GuardActionKey, { title: string; message: string }> = {
  log: { title: 'Log added', message: 'Your log entry was saved.' },
  checkCall: { title: 'Check call recorded', message: 'Your check call was recorded.' },
  incident: { title: 'Incident reported', message: 'The company can now see this incident.' },
  welfare: { title: 'Welfare update sent', message: 'Your welfare update was recorded.' },
  panic: { title: 'Panic alert sent', message: 'Emergency alert sent to control room.' },
};

/**
 * Runs one Guard action end to end: precondition, API write, side effects.
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

    if (key === 'log') {
      await api.createDailyLog({ shiftId, message: text, logType: 'observation' });
      fx.timeline(shiftId, 'Log added', text);
    } else if (key === 'checkCall') {
      await api.createDailyLog({ shiftId, message: text, logType: 'check_call' });
      fx.timeline(shiftId, 'Check call recorded', text);
    } else if (key === 'incident') {
      await api.createIncident({ title: 'Guard incident', notes: text, severity: 'medium', shiftId });
      fx.timeline(shiftId, 'Incident raised', text);
    } else if (key === 'welfare') {
      await api.createSafetyAlert({ shiftId, type: 'welfare', priority: 'high', message: text });
      fx.timeline(shiftId, 'Welfare update recorded', text);
    } else {
      // The typed value is the confirmation word, never the alert body.
      await api.createSafetyAlert({
        shiftId,
        type: 'panic',
        priority: 'critical',
        message: 'Emergency alert raised by guard from the mobile app.',
      });
      fx.timeline(shiftId, 'Panic alert sent', 'Emergency alert sent to control room.');
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
