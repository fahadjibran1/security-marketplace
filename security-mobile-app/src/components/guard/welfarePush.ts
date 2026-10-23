// Welfare Check notifications on the Guard's phone: what a tap means, and how each server answer reads.
//
// The notification carries identifiers only (shift, reminder, window). It authorises nothing: the app sends them as
// hints with the Guard's own session, and the server decides whether a Welfare Check is due, for whom, and records it.
// Nothing here records anything locally, and nothing here reads the phone's clock to decide whether a check counts.
//
//   I'm Safe     with a live session the tap itself is the confirmation, so it is submitted straight away and the
//                result shown; signed out (or the session ended), nothing is sent — after signing in the Guard sees
//                the confirmation screen and taps I'm Safe there.
//   Need Help    always one review step ("Request help now") before the alert is raised: a pocket tap must not
//                summon the Control Room, and the Guard is told plainly that S4 does not call the emergency services.
//   (the body)   opens the confirmation screen.
//
// Pure: no request, no React Native, no clock.

import type { WelfareConfirmResult, WelfareHelpResult } from '../../types/models';

export const WELFARE_NOTIFICATION_KIND = 'welfare_check';
export const WELFARE_CATEGORY_ID = 'welfare_check';
export const WELFARE_CHANNEL_ID = 'welfare-checks';
export const ACTION_IM_SAFE = 'im_safe';
export const ACTION_NEED_HELP = 'need_help';

export type WelfareIntent = {
  kind: 'safe' | 'help' | 'open';
  shiftId: number;
  reminderId: number | null;
  /** Identifies one tap on one notification, so the cold-start read and the listener never act twice. */
  key: string;
};

const positiveInt = (value: unknown): number | null => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};

/** A notification response, or null when it is not a well-formed S4 Welfare Check notification. */
export function parseWelfareResponse(input: { actionIdentifier?: string | null; data?: unknown; requestId?: string | null }): WelfareIntent | null {
  const data = input.data && typeof input.data === 'object' ? (input.data as Record<string, unknown>) : null;
  if (!data || data.kind !== WELFARE_NOTIFICATION_KIND) return null;
  const shiftId = positiveInt(data.shiftId);
  if (!shiftId) return null;
  const reminderId = positiveInt(data.reminderId);
  const action = input.actionIdentifier ?? '';
  const kind = action === ACTION_IM_SAFE ? 'safe' : action === ACTION_NEED_HELP ? 'help' : 'open';
  return { kind, shiftId, reminderId, key: `${input.requestId ?? `shift-${shiftId}-reminder-${reminderId ?? 'none'}`}:${action}` };
}

export type WelfarePromptStep =
  | { step: 'confirm_safe'; notice: string | null }
  | { step: 'confirm_help' }
  | { step: 'submitting'; what: 'safe' | 'help' }
  | { step: 'done'; tone: 'success' | 'info' | 'error'; title: string; message: string; retry: 'safe' | 'help' | null; offerCurrentCheck: boolean };

/**
 * Where a tap lands. `sessionLive` is false when the Guard was signed out when the tap arrived or had to sign in
 * again since: then nothing is submitted until the Guard confirms on the screen.
 */
export function firstStep(intent: WelfareIntent, sessionLive: boolean): WelfarePromptStep {
  if (intent.kind === 'help') return { step: 'confirm_help' };
  if (intent.kind === 'safe' && sessionLive) return { step: 'submitting', what: 'safe' };
  return {
    step: 'confirm_safe',
    notice: intent.kind === 'safe' ? 'Nothing has been recorded yet. Tap I\'m Safe to record your Welfare Check.' : null,
  };
}

const clock = (iso: string | null | undefined) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function safeOutcome(result: WelfareConfirmResult): WelfarePromptStep {
  const at = clock(result.recordedAt);
  if (result.result === 'recorded') {
    return { step: 'done', tone: 'success', title: 'Welfare Check recorded', message: `You confirmed you are safe and on duty${at ? ` at ${at}` : ''}.`, retry: null, offerCurrentCheck: false };
  }
  return { step: 'done', tone: 'info', title: 'Already recorded', message: `Your Welfare Check for this period was already recorded${at ? ` at ${at}` : ''}. Nothing more is needed.`, retry: null, offerCurrentCheck: false };
}

export function helpOutcome(result: WelfareHelpResult): WelfarePromptStep {
  const already = result.result === 'already_raised';
  return {
    step: 'done',
    tone: 'info',
    title: already ? 'Help already requested' : 'Help requested',
    message: `${already ? 'Your Control Room was already alerted a moment ago.' : 'Your Control Room has been alerted.'} S4 has not contacted the emergency services. If you are in immediate danger, call 999.`,
    retry: null,
    offerCurrentCheck: false,
  };
}

type ErrorLike = { name?: string; status?: number; body?: unknown; message?: string };

const serverMessage = (error: ErrorLike): string | null => {
  const body = error.body && typeof error.body === 'object' ? (error.body as Record<string, unknown>) : null;
  const message = body?.message;
  return typeof message === 'string' && message.trim() ? message : null;
};
const serverCode = (error: ErrorLike): string | null => {
  const body = error.body && typeof error.body === 'object' ? (error.body as Record<string, unknown>) : null;
  return typeof body?.code === 'string' ? body.code : null;
};
const unreachable = (error: ErrorLike) => error.name === 'NetworkError' || error.status === 503 || error.status === undefined;

/** A failed I'm Safe. Every branch says plainly that nothing was recorded. */
export function safeErrorOutcome(error: ErrorLike): WelfarePromptStep {
  const base = { step: 'done' as const, tone: 'error' as const, retry: null, offerCurrentCheck: false };
  if (error.status === 401) {
    return { ...base, title: 'Sign in to confirm', message: 'Your session has ended. Sign in, then confirm your Welfare Check. Nothing has been recorded.' };
  }
  if (error.status === 409 && serverCode(error) === 'reminder_expired') {
    return { ...base, tone: 'info', title: 'This reminder has expired', message: 'That Welfare Check period has closed. You can confirm your current Welfare Check now.', offerCurrentCheck: true };
  }
  if (error.status === 409 || error.status === 400 || error.status === 404 || error.status === 403) {
    return { ...base, title: 'Not recorded', message: `${serverMessage(error) ?? 'S4 could not record this Welfare Check.'} Nothing has been recorded.` };
  }
  if (unreachable(error)) {
    return { ...base, title: 'Not sent', message: 'S4 could not reach the server, so your Welfare Check has NOT been recorded. Check your connection and try again.', retry: 'safe' };
  }
  return { ...base, title: 'Not recorded', message: 'Something went wrong, so your Welfare Check has NOT been recorded. Try again, or record it from your S4 dashboard.', retry: 'safe' };
}

/** A failed Need Help. Never implies anyone was alerted. */
export function helpErrorOutcome(error: ErrorLike): WelfarePromptStep {
  const call = 'If you are in danger, call 999 and phone your Control Room.';
  const base = { step: 'done' as const, tone: 'error' as const, retry: null, offerCurrentCheck: false };
  if (error.status === 401) return { ...base, title: 'Help request NOT sent', message: `Your session has ended. Sign in and use Emergency in S4. ${call}` };
  if (unreachable(error)) return { ...base, title: 'Help request NOT sent', message: `S4 could not reach the server. ${call}`, retry: 'help' };
  return { ...base, title: 'Help request NOT sent', message: `${serverMessage(error) ?? 'S4 could not raise the alert.'} ${call}` };
}
