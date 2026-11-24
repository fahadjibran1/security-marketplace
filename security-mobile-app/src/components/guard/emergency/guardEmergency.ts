// S4-EM-01 — the two-tap Emergency. Pure: no react-native import, so every rule below is executed by the specs.
//
// THE FLOW
//   1. The Guard presses the existing Emergency launcher (the on-duty bar).        → phase 'confirm'
//   2. A full-screen confirmation: one large SEND EMERGENCY button and a separate Cancel. No typing, no description,
//      nothing to scroll.
//   3. SEND EMERGENCY submits immediately.                                          → phase 'sending'
//   4. The Guard is told exactly what is true:
//        'received'   S4's server committed the alert (and the in-app notifications to the responsible people).
//        'offline' / 'failed' / 'session_ended' / 'refused'   it was NOT sent, what to do now, and Try Again.
//
// WHAT IS NEVER CLAIMED
// That the Control Room received, saw or acknowledged it. "Received" means S4 received it. A human acknowledgement is
// shown only when the alert itself says so (status acknowledged / closed, with acknowledgedAt), read back from the
// Guard's own alerts. S4 never contacts the emergency services, and every state says so with the 999 advice.
//
// DUPLICATES
// The button is inert while a send is in flight (one request per press). A second press after a lost response, or a
// second Emergency while the first is still unacknowledged, is answered by the server with the same alert (duplicate),
// and the Guard is told S4 already has it. Once the company has acknowledged or resolved it, or two minutes have
// passed, a new press raises a genuinely new Emergency.

export type EmergencyShift = { id: number; status: string } | null | undefined;

/** The standard body. Sent explicitly so an older backend that still requires a message accepts it. */
export const EMERGENCY_APP_MESSAGE = 'Emergency raised by the Guard from the S4 app.';

export const EMERGENCY_999_NOTICE =
  'S4 does not contact the emergency services. If you are in immediate danger, call 999.';

export const EMERGENCY_COPY = {
  title: 'Emergency',
  confirmLead: 'Send an Emergency alert to your company?',
  confirmDetail: 'Your company’s responsible staff will be alerted in S4 straight away.',
  send: 'SEND EMERGENCY',
  sendAccessibility: 'Send Emergency alert now',
  sendHint: 'Sends immediately. Needs a connection.',
  cancel: 'Cancel',
  cancelAccessibility: 'Cancel. Do not send an Emergency',
  sending: 'Sending your Emergency to S4…',
  close: 'Close',
  tryAgain: 'TRY AGAIN',
  tryAgainAccessibility: 'Try sending the Emergency again',
  notSentTitle: 'Emergency NOT sent',
  receivedTitle: 'S4 received your Emergency',
  duplicateTitle: 'S4 already has your Emergency',
} as const;

export type EmergencyReceipt = {
  alertId: number;
  receivedAt: string;
  duplicate: boolean;
  /** Null when an older backend did not say. */
  responsiblePeopleNotified: number | null;
  pushDevicesTargeted: number | null;
};

export type EmergencySubmitResult =
  | { kind: 'received'; receipt: EmergencyReceipt }
  | { kind: 'not_available'; message: string }
  | { kind: 'offline' }
  | { kind: 'session_ended' }
  | { kind: 'refused'; message: string }
  | { kind: 'failed' };

export type EmergencyApi = {
  createSafetyAlert: (payload: { shiftId: number; type: 'panic'; priority: 'critical'; message: string }) => Promise<unknown>;
};

export function isLiveEmergencyShift(shift: EmergencyShift): shift is { id: number; status: string } {
  return !!shift && (shift.status || '').trim().toLowerCase() === 'in_progress';
}

const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The receipt from the server's answer. An older backend returns the alert without one: still received. */
export function readEmergencyReceipt(response: unknown, now: Date = new Date()): EmergencyReceipt | null {
  const alert = response as { id?: unknown; createdAt?: unknown; emergencyReceipt?: Record<string, unknown> } | null;
  const id = asNumber(alert?.id);
  if (id == null) return null;
  const r = alert?.emergencyReceipt ?? {};
  const receivedAt = typeof r.receivedAt === 'string' ? r.receivedAt
    : typeof alert?.createdAt === 'string' ? alert.createdAt : now.toISOString();
  return {
    alertId: id,
    receivedAt,
    duplicate: r.duplicate === true,
    responsiblePeopleNotified: asNumber(r.responsiblePeopleNotified),
    pushDevicesTargeted: asNumber(r.pushDevicesTargeted),
  };
}

/**
 * What went wrong, from the API client's error. A request that never reached S4 (no status) is offline; 401 is a
 * session that ended; any other 4xx is S4 refusing it, with S4's own words; everything else is a failure.
 */
export function classifyEmergencyError(error: unknown): EmergencySubmitResult {
  const e = error as { name?: string; status?: unknown; message?: string } | null;
  const status = asNumber(e?.status);
  if (e?.name === 'NetworkError' || (status == null && (e?.name === 'TypeError' || /network|fetch|timed? ?out|offline/i.test(e?.message ?? '')))) {
    return { kind: 'offline' };
  }
  if (status === 401) return { kind: 'session_ended' };
  if (status != null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    // S4's own sentence from the response body, never the raw "400 Bad Request - {json}" of the client error.
    const body = (error as { body?: { message?: unknown } } | null)?.body;
    const raw = Array.isArray(body?.message) ? body!.message.join(' ') : body?.message;
    const message = typeof raw === 'string' ? raw.trim() : '';
    return { kind: 'refused', message: message ? (/[.!?]$/.test(message) ? message : `${message}.`) : 'S4 could not accept this Emergency.' };
  }
  if (status == null) return { kind: 'offline' };
  return { kind: 'failed' };
}

/**
 * Send one Emergency. Never throws. Exactly one request, and only for the Guard's live shift (the same availability
 * rule as before: the server enforces it too).
 */
export async function sendGuardEmergency(shift: EmergencyShift, api: EmergencyApi, now: () => Date = () => new Date()): Promise<EmergencySubmitResult> {
  if (!isLiveEmergencyShift(shift)) {
    return { kind: 'not_available', message: 'Emergency is only available while you are booked on to a shift.' };
  }
  try {
    const response = await api.createSafetyAlert({ shiftId: shift.id, type: 'panic', priority: 'critical', message: EMERGENCY_APP_MESSAGE });
    const receipt = readEmergencyReceipt(response, now());
    // A 2xx without an alert id is not proof S4 recorded it: say so rather than claim it.
    return receipt ? { kind: 'received', receipt } : { kind: 'failed' };
  } catch (error) {
    return classifyEmergencyError(error);
  }
}

/** The words for a failure. Every one says it was NOT sent, what to do now, and the 999 advice. */
export function emergencyFailureView(result: Exclude<EmergencySubmitResult, { kind: 'received' }>): { title: string; message: string; canRetry: boolean } {
  const call = 'If you are in immediate danger, call 999 now. Then phone your control room.';
  switch (result.kind) {
    case 'offline':
      return { title: EMERGENCY_COPY.notSentTitle, message: `Your phone could not reach S4. ${call} Try again when you have signal.`, canRetry: true };
    case 'session_ended':
      return { title: EMERGENCY_COPY.notSentTitle, message: `Your S4 session has ended. ${call} Then sign in again and press Emergency.`, canRetry: false };
    case 'refused':
      return { title: EMERGENCY_COPY.notSentTitle, message: `${result.message} ${call}`, canRetry: false };
    case 'not_available':
      return { title: EMERGENCY_COPY.notSentTitle, message: `${result.message} ${call}`, canRetry: false };
    default:
      return { title: EMERGENCY_COPY.notSentTitle, message: `S4 could not record your Emergency. ${call} Then try again.`, canRetry: true };
  }
}

/** The Guard's view of their alert as S4 currently has it. Only the alert's own status ever says a person acted. */
export type EmergencyFollowUp =
  | { state: 'waiting' }
  | { state: 'acknowledged'; at: string | null }
  | { state: 'resolved'; at: string | null };

export function emergencyFollowUp(alert: { status?: string | null; acknowledgedAt?: string | null; closedAt?: string | null } | null | undefined): EmergencyFollowUp {
  const status = (alert?.status ?? '').toLowerCase();
  if (status === 'closed') return { state: 'resolved', at: alert?.closedAt ?? null };
  if (status === 'acknowledged' && alert?.acknowledgedAt) return { state: 'acknowledged', at: alert.acknowledgedAt };
  return { state: 'waiting' };
}

const people = (n: number) => `${n} responsible ${n === 1 ? 'person' : 'people'}`;

/**
 * The received screen's lines. `time` formats an instant as the Guard's local clock (the screen supplies the site's
 * zone). Nothing here says the Control Room has seen it unless followUp says a person acknowledged it.
 */
export function emergencyReceivedView(receipt: EmergencyReceipt, followUp: EmergencyFollowUp, time: (iso: string) => string) {
  const at = time(receipt.receivedAt);
  const title = receipt.duplicate ? EMERGENCY_COPY.duplicateTitle : EMERGENCY_COPY.receivedTitle;
  const lines: string[] = [];
  lines.push(receipt.duplicate
    ? `S4 received it at ${at}. It has not been sent twice.`
    : `Received by S4 at ${at}.`);
  if (followUp.state === 'acknowledged') {
    lines.push(`Your company acknowledged your Emergency${followUp.at ? ` at ${time(followUp.at)}` : ''}.`);
  } else if (followUp.state === 'resolved') {
    lines.push(`Your company has resolved this Emergency${followUp.at ? ` at ${time(followUp.at)}` : ''}.`);
  } else {
    if (receipt.responsiblePeopleNotified != null && receipt.responsiblePeopleNotified > 0 && !receipt.duplicate) {
      lines.push(`S4 is alerting ${people(receipt.responsiblePeopleNotified)} at your company.`);
    } else if (!receipt.duplicate) {
      lines.push('S4 is alerting your company.');
    }
    lines.push('Nobody has confirmed they have seen it yet.');
  }
  return { title, lines, notice: EMERGENCY_999_NOTICE, acknowledged: followUp.state !== 'waiting' };
}

/**
 * The confirmation's layout, from the window. Everything fits without scrolling: the SEND button takes the space that
 * is left, never less than a large thumb target, and text is capped at 1.6× so a large accessibility size cannot push
 * Cancel off a small phone.
 */
export const EMERGENCY_MIN_SEND_HEIGHT = 96;
export const EMERGENCY_CANCEL_HEIGHT = 56;
export const EMERGENCY_MAX_FONT_MULTIPLIER = 1.6;

export function emergencyScreenLayout(window: { width: number; height: number }) {
  const compact = window.height < 640;
  return {
    compact,
    sendMinHeight: Math.max(EMERGENCY_MIN_SEND_HEIGHT, Math.round(window.height * (compact ? 0.24 : 0.3))),
    cancelHeight: EMERGENCY_CANCEL_HEIGHT,
    titleSize: compact ? 26 : 32,
    sendTextSize: compact ? 26 : 30,
    gutter: window.width < 360 ? 16 : 24,
  };
}
