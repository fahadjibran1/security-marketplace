// S4-EM-01 — the two-tap Emergency. Pure: no react-native import, so every rule below is executed by the specs.
//
// THE FLOW
//   1. The Guard presses the existing Emergency launcher (the on-duty bar).        → phase 'confirm'
//   2. A full-screen confirmation: one large SEND EMERGENCY button and a separate Cancel. No typing, no description,
//      nothing to scroll.
//   3. SEND EMERGENCY submits immediately.                                          → phase 'sending'
//   4. The Guard is told exactly what is true:
//        'received'   S4's server committed the alert (and the in-app notifications to the responsible people).
//        'uncertain'  S4 did not answer (no connection, timeout, a dropped response, a server or gateway error): the
//                     request may or may not have arrived. The Guard is told it is NOT CONFIRMED — never "not sent" —
//                     with the 999 advice and TRY AGAIN, and the screen keeps checking the Guard's own alerts: an active
//                     Emergency on this shift turns it into 'received'. A retry is safe: S4 will not raise it twice.
//        'session_ended' / 'refused' / 'failed'   S4 answered and did NOT record it: it was NOT sent, what to do now.
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
  notConfirmedTitle: 'Emergency NOT confirmed',
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
  | { kind: 'uncertain' }
  | { kind: 'session_ended' }
  | { kind: 'refused'; message: string }
  | { kind: 'failed' };

export type EmergencyApi = {
  createSafetyAlert: (payload: { shiftId: number; type: 'panic'; priority: 'critical'; message: string }, requestKey?: string) => Promise<unknown>;
};

/**
 * One key per Emergency: made when the Emergency screen opens and reused by every TRY AGAIN on it, so S4 answers a retry
 * with the Emergency it already has (even after an acknowledgement); opening the screen again makes a new key, a new
 * Emergency. Uniqueness per Guard is all it needs (it is not a secret). 16–64 of [A-Za-z0-9_-], as the server expects.
 */
export function newEmergencyRequestKey(now: () => number = Date.now, random: () => number = Math.random): string {
  let tail = '';
  while (tail.length < 16) tail += Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
  return `em-${now().toString(36)}-${tail.slice(0, 16)}`;
}

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
 * What went wrong, from the API client's error. Only an answer FROM S4 proves it was not recorded: 401 (the session
 * ended), another 4xx (S4 refused it, in S4's own words) or 429 (S4 turned it away). No answer at all — no connection,
 * a timeout, a dropped response — and 408 / 5xx (a gateway or the server failing, possibly after the commit) leave the
 * outcome unknown: 'uncertain', never "not sent".
 */
export function classifyEmergencyError(error: unknown): EmergencySubmitResult {
  const e = error as { name?: string; status?: unknown; message?: string } | null;
  const status = asNumber(e?.status);
  if (status == null || e?.name === 'NetworkError') return { kind: 'uncertain' };
  if (status === 401) return { kind: 'session_ended' };
  if (status === 429) return { kind: 'failed' };
  if (status != null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    // S4's own sentence from the response body, never the raw "400 Bad Request - {json}" of the client error.
    const body = (error as { body?: { message?: unknown } } | null)?.body;
    const raw = Array.isArray(body?.message) ? body!.message.join(' ') : body?.message;
    const message = typeof raw === 'string' ? raw.trim() : '';
    return { kind: 'refused', message: message ? (/[.!?]$/.test(message) ? message : `${message}.`) : 'S4 could not accept this Emergency.' };
  }
  return { kind: 'uncertain' };
}

/**
 * Send one Emergency. Never throws. Exactly one request, and only for the Guard's live shift (the same availability
 * rule as before: the server enforces it too).
 */
export async function sendGuardEmergency(
  shift: EmergencyShift,
  api: EmergencyApi,
  now: () => Date = () => new Date(),
  requestKey?: string,
): Promise<EmergencySubmitResult> {
  if (!isLiveEmergencyShift(shift)) {
    return { kind: 'not_available', message: 'Emergency is only available while you are booked on to a shift.' };
  }
  try {
    const payload = { shiftId: shift.id, type: 'panic' as const, priority: 'critical' as const, message: EMERGENCY_APP_MESSAGE };
    const response = await (requestKey ? api.createSafetyAlert(payload, requestKey) : api.createSafetyAlert(payload));
    const receipt = readEmergencyReceipt(response, now());
    // A 2xx without an alert id is not proof S4 recorded it, nor proof it did not: unknown.
    return receipt ? { kind: 'received', receipt } : { kind: 'uncertain' };
  } catch (error) {
    return classifyEmergencyError(error);
  }
}

/**
 * The words when S4 has not confirmed it. 'uncertain' says NOT CONFIRMED (it may have arrived); every other case is an
 * answer from S4 that it was not recorded, and says NOT SENT. Every one says what to do now, with the 999 advice.
 */
export function emergencyFailureView(result: Exclude<EmergencySubmitResult, { kind: 'received' }>): { title: string; badge: 'NOT SENT' | 'NOT CONFIRMED'; message: string; canRetry: boolean } {
  const call = 'If you are in immediate danger, call 999 now. Then phone your control room.';
  const notSent = { title: EMERGENCY_COPY.notSentTitle, badge: 'NOT SENT' as const };
  switch (result.kind) {
    case 'uncertain':
      return {
        title: EMERGENCY_COPY.notConfirmedTitle,
        badge: 'NOT CONFIRMED',
        message: `S4 has not confirmed it received your Emergency. It may not have been sent. ${call} Press TRY AGAIN: if S4 already has it, it will not be sent twice.`,
        canRetry: true,
      };
    case 'session_ended':
      return { ...notSent, message: `Your S4 session has ended. ${call} Then sign in again and press Emergency.`, canRetry: false };
    case 'refused':
      return { ...notSent, message: `${result.message} ${call}`, canRetry: false };
    case 'not_available':
      return { ...notSent, message: `${result.message} ${call}`, canRetry: false };
    default:
      return { ...notSent, message: `S4 could not accept your Emergency just now. ${call} Then try again.`, canRetry: true };
  }
}

/**
 * After an uncertain outcome: does S4 already hold an active Emergency from this Guard on this shift? Read from the
 * Guard's own alerts. If so, that is the receipt — S4 has it — without claiming anything about who was alerted.
 */
export function activeEmergencyReceipt(
  mine: Array<{ id: number; type?: string | null; status?: string | null; createdAt?: string | null; shift?: { id?: number | null } | null }>,
  shiftId: number | null | undefined,
): EmergencyReceipt | null {
  if (shiftId == null) return null;
  const alert = mine.find((a) => a.type === 'panic' && (a.status ?? '').toLowerCase() !== 'closed' && a.shift?.id === shiftId && typeof a.createdAt === 'string');
  if (!alert || typeof alert.createdAt !== 'string') return null;
  return { alertId: alert.id, receivedAt: alert.createdAt, duplicate: false, responsiblePeopleNotified: null, pushDevicesTargeted: null };
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
 * The confirmation's layout, from the window. At the phone's standard text size everything fits without scrolling: the
 * SEND button takes the space that is left, never less than a large thumb target. Instructions (the question, the 999
 * notice, every result line) follow the phone's text size with NO cap, so they stay readable at any accessibility size;
 * if very large text no longer fits, the screen scrolls rather than cutting anything off. Only the already-large title
 * and button labels (26–32pt) are capped, at EMERGENCY_MAX_FONT_MULTIPLIER, so SEND stays one big target.
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
