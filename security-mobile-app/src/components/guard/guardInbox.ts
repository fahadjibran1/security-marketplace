// The Guard's notifications inbox and Guard notification pushes: what a push tap means, how the list is ordered and
// counted, where an item leads, and how a read is shown before the server confirms it.
//
// The push carries identifiers only ({ kind: 'guard_notification', notificationId, type, shiftId?, amendmentId? }).
// They are hints: the app reads the inbox and marks the item read with the Guard's own session, and the server decides
// what the Guard may see. Nothing here trusts the push for anything else. Welfare Check pushes (kind 'welfare_check')
// are not handled here; they keep their own module (welfarePush.ts).
//
// Pure: no request, no React Native. The only clock is the `nowMs` a caller passes in.

import { DEFAULT_SITE_TIME_ZONE, formatInstantTime, formatUkDate } from '../../services/siteTime';

export const GUARD_NOTIFICATION_KIND = 'guard_notification';
export const SHIFT_UPDATES_CHANNEL_ID = 'shift-updates';
export const SHIFT_UPDATES_CHANNEL_NAME = 'Shift updates';

export type GuardNotificationIntent = {
  notificationId: number;
  /** The notification type, or null when the push did not say. An unknown type is kept as given. */
  type: string | null;
  shiftId: number | null;
  amendmentId: number | null;
  /** Identifies one tap on one notification, so the cold-start read and the listener never act twice. */
  key: string;
};

const positiveInt = (value: unknown): number | null => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};

const cleanType = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value.trim()) ? value.trim() : null;

/** A notification response, or null when it is not a well-formed S4 Guard notification (Welfare pushes are null). */
export function parseGuardNotificationResponse(input: { actionIdentifier?: string | null; data?: unknown; requestId?: string | null }): GuardNotificationIntent | null {
  const data = input.data && typeof input.data === 'object' ? (input.data as Record<string, unknown>) : null;
  if (!data || data.kind !== GUARD_NOTIFICATION_KIND) return null;
  const notificationId = positiveInt(data.notificationId);
  if (!notificationId) return null;
  return {
    notificationId,
    type: cleanType(data.type),
    shiftId: positiveInt(data.shiftId),
    amendmentId: positiveInt(data.amendmentId),
    key: `${input.requestId ?? `guard-notification-${notificationId}`}:${input.actionIdentifier ?? ''}`,
  };
}

/** True for a received (not tapped) push payload that belongs to the Guard inbox. */
export function isGuardNotificationData(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as Record<string, unknown>).kind === GUARD_NOTIFICATION_KIND;
}

// ─── The list ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type InboxItem = {
  id: number;
  type: string;
  title: string;
  message: string;
  status: 'unread' | 'read';
  createdAt: string;
  readAt: string | null;
};

const timeOf = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * The server's rows, keeping only what the inbox shows (the server also returns the user and company it belongs to),
 * newest first. Malformed rows are dropped rather than crashing the screen.
 */
export function normaliseInbox(rows: unknown): InboxItem[] {
  if (!Array.isArray(rows)) return [];
  const items: InboxItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = positiveInt(r.id);
    if (!id) continue;
    items.push({
      id,
      type: typeof r.type === 'string' ? r.type : '',
      title: typeof r.title === 'string' ? r.title : '',
      message: typeof r.message === 'string' ? r.message : '',
      status: r.status === 'read' ? 'read' : 'unread',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
      readAt: typeof r.readAt === 'string' ? r.readAt : null,
    });
  }
  return sortInbox(items);
}

export function sortInbox(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt) || b.id - a.id);
}

export function unreadCount(items: InboxItem[]): number {
  return items.reduce((n, item) => (item.status === 'unread' ? n + 1 : n), 0);
}

/** Badge text: nothing at zero, and never a wall of digits. */
export function unreadBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

const FALLBACK_TITLES: Record<string, string> = {
  shift_offered: 'New shift offer',
  shift_offer_withdrawn: 'Shift offer withdrawn',
  shift_reacceptance_required: 'Shift changed: please review',
  shift_replaced: 'Shift replaced',
  shift_amendment_requested: 'Shift extension request',
  shift_amendment_responded: 'Shift extension update',
  shift_amendment_expired: 'Shift extension expired',
  shift_amendment_disputed: 'Shift extension disputed',
  timesheet_approved: 'Timesheet approved',
  timesheet_rejected: 'Timesheet returned',
  compliance_alert: 'Compliance update',
};

/**
 * What a row says. The server's own title and message always win, for every type including ones this app version has
 * never heard of; a label is only supplied when the server sent an empty title.
 */
export function notificationText(item: Pick<InboxItem, 'type' | 'title' | 'message'>): { title: string; message: string } {
  const title = item.title.trim() || FALLBACK_TITLES[item.type] || 'S4 notification';
  return { title, message: item.message.trim() };
}

/**
 * When it arrived, on the UK clock: "Just now", "12 min ago · 14:05", "Today · 09:10", "Yesterday · 21:40", else
 * "30-09-2026 · 20:34".
 */
export function notificationTime(iso: string, nowMs: number, timeZone: string = DEFAULT_SITE_TIME_ZONE): string {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return '';
  const clock = formatInstantTime(iso, timeZone);
  const diff = nowMs - t;
  if (diff >= 0 && diff < 60_000) return 'Just now';
  if (diff >= 0 && diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} min ago · ${clock}`;
  const day = formatUkDate(iso, timeZone);
  if (day === formatUkDate(new Date(nowMs).toISOString(), timeZone)) return `Today · ${clock}`;
  if (day === formatUkDate(new Date(nowMs - 24 * 60 * 60_000).toISOString(), timeZone)) return `Yesterday · ${clock}`;
  return `${day} · ${clock}`;
}

// ─── Where an item leads ───────────────────────────────────────────────────────────────────────────────────────────

export type InboxTarget =
  | { tab: 'offers'; shiftId: number | null }
  | { tab: 'home'; focus: 'extension'; amendmentId: number | null }
  | { tab: 'history' }
  /** Nowhere better than the inbox itself. */
  | null;

/**
 * Where to take the Guard for a notification. Inbox rows carry no shift id (the server stores none), so a row opens the
 * Offers list; a push that names its shift opens that offer when it is still on offer. Anything without a sensible
 * place, including types this version does not know, stays in the inbox.
 */
export function resolveNotificationTarget(type: string | null, refs: { shiftId?: number | null; amendmentId?: number | null } = {}): InboxTarget {
  switch (type) {
    case 'shift_offered':
    case 'shift_reacceptance_required':
      return { tab: 'offers', shiftId: refs.shiftId ?? null };
    case 'shift_amendment_requested':
      return { tab: 'home', focus: 'extension', amendmentId: refs.amendmentId ?? null };
    case 'timesheet_approved':
    case 'timesheet_rejected':
      return { tab: 'history' };
    default:
      return null;
  }
}

// ─── Read state ────────────────────────────────────────────────────────────────────────────────────────────────────

export type InboxState = {
  items: InboxItem[];
  /** Reads shown on the phone but not yet confirmed by the server: id → the row as it was before. */
  pending: Record<number, { status: InboxItem['status']; readAt: string | null }>;
};

export type InboxAction =
  | { type: 'loaded'; items: InboxItem[] }
  | { type: 'mark_read_started'; id: number; at: string }
  | { type: 'mark_read_succeeded'; id: number; readAt?: string | null }
  | { type: 'mark_read_failed'; id: number }
  | { type: 'reset' };

export const EMPTY_INBOX: InboxState = { items: [], pending: {} };

/**
 * Optimistic reads with rollback. A list that arrives while a read is in flight keeps that row read (the server may
 * not have applied it yet); a failed read puts the row back exactly as it was.
 */
export function inboxReducer(state: InboxState, action: InboxAction): InboxState {
  switch (action.type) {
    case 'loaded': {
      const items = sortInbox(action.items).map((item) =>
        state.pending[item.id] && item.status === 'unread' ? { ...item, status: 'read' as const } : item,
      );
      return { ...state, items };
    }
    case 'mark_read_started': {
      const item = state.items.find((i) => i.id === action.id);
      if (state.pending[action.id]) return state;
      if (item && item.status === 'read') return state;
      const before = item ? { status: item.status, readAt: item.readAt } : { status: 'unread' as const, readAt: null };
      return {
        items: state.items.map((i) => (i.id === action.id ? { ...i, status: 'read', readAt: action.at } : i)),
        pending: { ...state.pending, [action.id]: before },
      };
    }
    case 'mark_read_succeeded': {
      const { [action.id]: _done, ...pending } = state.pending;
      return {
        items: state.items.map((i) => (i.id === action.id ? { ...i, status: 'read', readAt: action.readAt ?? i.readAt } : i)),
        pending,
      };
    }
    case 'mark_read_failed': {
      const before = state.pending[action.id];
      if (!before) return state;
      const { [action.id]: _failed, ...pending } = state.pending;
      return {
        items: state.items.map((i) => (i.id === action.id ? { ...i, status: before.status, readAt: before.readAt } : i)),
        pending,
      };
    }
    case 'reset':
      return EMPTY_INBOX;
    default:
      return state;
  }
}

/** True when a read should be sent: an unread row, or a push-named id not loaded yet. */
export function shouldMarkRead(state: InboxState, id: number): boolean {
  if (state.pending[id]) return false;
  const item = state.items.find((i) => i.id === id);
  return !item || item.status === 'unread';
}

// ─── Loading problems ──────────────────────────────────────────────────────────────────────────────────────────────

export type InboxAvailability = 'loading' | 'ready' | 'unavailable' | 'error';

/**
 * A failed list read. A server without the inbox (404, or 403 for an older role rule) is not an error the Guard can
 * fix: the badge is hidden and a calm line shown. Anything else keeps the last list and offers a retry.
 */
export function inboxLoadProblem(error: unknown): { availability: 'unavailable' | 'error'; message: string } {
  const e = (error ?? {}) as { status?: number; name?: string };
  if (e.status === 404 || e.status === 403 || e.status === 405) {
    return { availability: 'unavailable', message: 'Notifications are not available on this S4 server yet. Your shifts, offers and Welfare Checks still work as normal.' };
  }
  if (e.name === 'NetworkError' || e.status === undefined || e.status === 503) {
    return { availability: 'error', message: 'S4 could not reach the server to load your notifications. Check your connection and pull down to try again.' };
  }
  return { availability: 'error', message: 'S4 could not load your notifications right now. Pull down to try again.' };
}

export const MARK_READ_FAILED_MESSAGE = 'Could not mark that notification as read. It will stay unread until S4 can reach the server.';
