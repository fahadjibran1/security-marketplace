import type { ProfileSectionKey } from './profileOverview';

/**
 * S4 Guard Profile — when Profile data is read (Profile Phase 2E).
 *
 * Before 2E every dashboard refresh (start-up, each Home action, each offer response, opening Offers, pulling Offers to
 * refresh, each return to the foreground) re-read all six personnel records, whether or not Profile was ever opened,
 * and the company list was read at start-up. Now each record is read when a Profile view that shows it opens, at most
 * once per freshness window; a dashboard refresh reads only what the visible Profile view shows, and only when stale.
 *
 * This module holds no data: only, per record, when it was last read, which read is the latest, and whether a save
 * has replaced what an older read would bring back. The records stay in the screen's state as before; they are the
 * masked summaries the API returns. Revealed NINO, UTR, licence and bank values never pass through here and are never
 * cached — they live only in their reveal state, cleared on a timer, on leaving the section and when the app is
 * backgrounded.
 */

export type ProfileRecord = 'identity' | 'driving' | 'emergencyContact' | 'employments' | 'payroll' | 'bank' | 'companies';
export type ProfileView = 'overview' | ProfileSectionKey;

/** What each Profile view shows. The overview summarises six records; payroll appears only under Employment & pay. */
export const PROFILE_RECORDS_BY_VIEW: Record<ProfileView, readonly ProfileRecord[]> = {
  overview: ['emergencyContact', 'identity', 'bank', 'employments', 'driving', 'companies'],
  personal: ['emergencyContact'],
  companies: ['companies'],
  compliance: [],
  availability: ['driving'],
  employmentPay: ['employments', 'payroll', 'bank', 'identity'],
  screening: [],
  privacyAccount: [],
};

/**
 * How long a successful read stays current. Moving between sections inside this window sends nothing; opening a view
 * after it reads again. These records change only when the Guard saves them here (which updates them directly) or a
 * company administrator edits them, so a minute is fresh enough.
 */
export const PROFILE_FRESH_MS = 60_000;

export interface ProfileReadTicket {
  readonly record: ProfileRecord;
  readonly seq: number;
  readonly writeGen: number;
}

export interface ProfileReadTracker {
  /** Whether `record` should be read now: never read, or older than the window — and not already being read. */
  shouldRead(record: ProfileRecord, now: number): boolean;
  /** Starts a read. A later read of the same record makes this one stale. */
  begin(record: ProfileRecord): ProfileReadTicket;
  /** The latest read, with no save since it began, while the screen is mounted. Only such a read may change state. */
  isCurrent(ticket: ProfileReadTicket): boolean;
  /** Records a successful current read (its time starts the freshness window). Returns whether to apply it. */
  accept(ticket: ProfileReadTicket, now: number): boolean;
  /** Ends a read, success or failure. True when it was the latest read, so its loading indicator may be cleared. */
  finish(ticket: ProfileReadTicket): boolean;
  /** A save replaced the record: a read still in flight is now stale, and the saved value counts as just read. */
  wrote(record: ProfileRecord, now: number): void;
  /** Whether the record has ever loaded (a failed refresh then keeps showing the last good value). */
  hasLoaded(record: ProfileRecord): boolean;
  /** Mounted state: no read applies while the screen is unmounted. */
  setActive(active: boolean): void;
}

export function createProfileReadTracker(freshMs: number = PROFILE_FRESH_MS): ProfileReadTracker {
  const seq: Partial<Record<ProfileRecord, number>> = {};
  const writeGen: Partial<Record<ProfileRecord, number>> = {};
  const readAt: Partial<Record<ProfileRecord, number>> = {};
  const inFlight: Partial<Record<ProfileRecord, boolean>> = {};
  let active = true;
  const isCurrent = (ticket: ProfileReadTicket) =>
    active && ticket.seq === seq[ticket.record] && ticket.writeGen === (writeGen[ticket.record] ?? 0);
  return {
    shouldRead(record, now) {
      if (!active || inFlight[record]) return false;
      const at = readAt[record];
      return at === undefined || now - at >= freshMs;
    },
    begin(record) {
      const next = (seq[record] ?? 0) + 1;
      seq[record] = next;
      inFlight[record] = true;
      return { record, seq: next, writeGen: writeGen[record] ?? 0 };
    },
    isCurrent,
    accept(ticket, now) {
      if (!isCurrent(ticket)) return false;
      readAt[ticket.record] = now;
      return true;
    },
    finish(ticket) {
      const latest = ticket.seq === seq[ticket.record];
      if (latest) inFlight[ticket.record] = false;
      return latest && active;
    },
    wrote(record, now) {
      writeGen[record] = (writeGen[record] ?? 0) + 1;
      readAt[record] = now;
    },
    hasLoaded(record) {
      return readAt[record] !== undefined;
    },
    setActive(next) {
      active = next;
    },
  };
}

/** The records a view needs that are due a read. Pure, so the decision is testable without a screen. */
export function recordsToRead(tracker: ProfileReadTracker, view: ProfileView, now: number): ProfileRecord[] {
  return PROFILE_RECORDS_BY_VIEW[view].filter((record) => tracker.shouldRead(record, now));
}

/**
 * A short-lived in-memory copy of the backend summaries the overview reads (compliance status and screening), so
 * returning to the overview from a section does not read them again within the window. Owned by one mounted
 * dashboard (never persisted, never shared between sign-ins), and it holds no NINO, UTR, licence or bank value.
 */
export interface TimedValue<T> {
  readonly value: T;
  readonly at: number;
}

export function freshValue<T>(entry: TimedValue<T> | null | undefined, now: number, freshMs: number = PROFILE_FRESH_MS): T | undefined {
  return entry && now - entry.at < freshMs ? entry.value : undefined;
}
