/**
 * Web portal only: keeps the browser tabs of one signed-in person from fighting over the shared session.
 *
 * Every tab reads the same stored session (localStorage), so every tab holds the same refresh token. The server rotates
 * a refresh token on first use and treats any later use of the rotated token as theft (`auth.session_reuse_detected`),
 * revoking the whole session family. That control stays exactly as it is. Instead, the tabs never present a token that
 * another tab has already rotated:
 *
 *  1. Only one tab renews at a time: the Web Locks API where the browser has it, otherwise a short localStorage lease.
 *  2. A tab that waited for the lock re-reads the stored session first. If another tab already rotated it, this tab
 *     adopts the successor (and the access token that tab broadcast) instead of sending the dead token.
 *  3. Tabs hear about rotations (storage event + BroadcastChannel) and sign-outs (storage event) from each other, and
 *     remember every token they know to be spent so a late or out-of-order message can never bring one back.
 *
 * The access token is never persisted: it is handed between live tabs over a same-origin BroadcastChannel only. Nothing
 * here writes a token to a URL or a log. Native builds never install this (one process, one in-memory session).
 */
import type { RefreshCoordination } from './api';
import { parseStoredSession } from '../navigation/role-routing';

/** The parts of api.ts this wires into; passed in so the module stays loadable on its own. */
export interface CrossTabApi {
  setRefreshCoordination(coordination: RefreshCoordination | null): void;
  adoptSharedSession(session: { refreshToken: string; accessToken?: string }): void;
  clearLocalSession(): void;
  getRefreshToken(): string | null;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

interface LockLike {
  name?: string;
}

interface LocksLike {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: LockLike | null) => Promise<T>,
  ): Promise<T>;
}

export interface StorageChange {
  key: string | null;
  oldValue: string | null;
  newValue: string | null;
}

export interface CrossTabEnv {
  storage: StorageLike;
  /** navigator.locks, or null where the browser has no Web Locks (the localStorage lease is used instead). */
  locks: LocksLike | null;
  /** BroadcastChannel factory, or null where unavailable (a waiting tab then renews with the current token itself). */
  createChannel: ((name: string) => ChannelLike) | null;
  /** Subscribes to localStorage changes made by OTHER tabs; returns the unsubscribe. */
  addStorageListener(listener: (change: StorageChange) => void): () => void;
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  randomId(): string;
}

const LOCK_NAME = 's4-auth-refresh';
const CHANNEL_NAME = 's4-auth-session';
const LEASE_KEY = 's4-auth-refresh-lease';
/** Longer than a renewal can take (30 s request limit), so a live holder never loses the lease mid-renewal. */
const LEASE_TTL_MS = 40_000;
/** How long a tab waits for the lease before renewing anyway (re-reading the stored session still protects it). */
const LEASE_WAIT_MS = 45_000;
const LEASE_POLL_MS = 50;
const LEASE_SETTLE_MS = 25;
/** A handed-over access token is only taken while it is fresh; access tokens live far longer than this. */
const HANDOFF_FRESH_MS = 60_000;
/** Upper bound on any wait for another tab's word, so a renewal is never held up for long. */
const MAX_WAIT_MS = 1_500;
/** Spent tokens remembered so a late or out-of-order message can never bring one back. */
const SPENT_LIMIT = 50;

export const SIGNED_OUT_ELSEWHERE_MESSAGE = 'You were signed out in another tab. Please sign in again.';
export const OTHER_ACCOUNT_MESSAGE = 'Another account signed in in another tab. Please sign in again.';

interface Handoff {
  previous: string | null;
  refreshToken: string;
  accessToken: string;
  receivedAt: number;
}

function readStored(storage: StorageLike, key: string) {
  try {
    const raw = storage.getItem(key);
    return { ok: true as const, session: raw ? parseStoredSession(raw) : null };
  } catch {
    return { ok: false as const, session: null };
  }
}

function sessionFrom(raw: string | null) {
  return raw ? parseStoredSession(raw) : null;
}

/**
 * Installs cross-tab coordination for this tab and returns the uninstall. With `env` null (no window/localStorage) it
 * installs nothing, so the client behaves exactly as before.
 */
export function installCrossTabAuth(options: {
  api: CrossTabApi;
  env: CrossTabEnv | null;
  sessionKey: string;
  onSignedOutElsewhere(message: string): void;
}): () => void {
  const { api, sessionKey, onSignedOutElsewhere } = options;
  if (!options.env) return () => undefined;
  const env: CrossTabEnv = options.env;

  /** Rotated (a successor exists somewhere) or ended (refused by the server): never to be presented again. */
  const spent = new Map<string, 'rotated' | 'ended'>();
  const spend = (token: string | null | undefined, how: 'rotated' | 'ended') => {
    if (!token) return;
    spent.set(token, how);
    if (spent.size > SPENT_LIMIT) spent.delete(spent.keys().next().value as string);
  };
  let lastHandoff: Handoff | null = null;
  const waiters = new Set<() => void>();
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  let knownUserId: number | null = readStored(env.storage, sessionKey).session?.user.id ?? null;
  const fresh = (handoff: Handoff | null): handoff is Handoff => !!handoff && env.now() - handoff.receivedAt < HANDOFF_FRESH_MS;

  let channel: ChannelLike | null = null;
  try {
    channel = env.createChannel ? env.createChannel(CHANNEL_NAME) : null;
  } catch {
    channel = null;
  }

  function signOutHere(message: string) {
    if (!api.getRefreshToken()) return;
    api.clearLocalSession();
    onSignedOutElsewhere(message);
  }

  if (channel) {
    channel.onmessage = (event) => {
      const data = event?.data as { type?: unknown; previous?: unknown; refreshToken?: unknown; accessToken?: unknown } | null;
      if (!data || typeof data.refreshToken !== 'string' || !data.refreshToken) return;
      if (data.type === 'ended') {
        spend(data.refreshToken, 'ended');
        wake();
        return;
      }
      if (data.type !== 'rotated' || typeof data.accessToken !== 'string' || !data.accessToken) return;
      const previous = typeof data.previous === 'string' ? data.previous : null;
      spend(previous, 'rotated');
      if (!spent.has(data.refreshToken)) {
        lastHandoff = { previous, refreshToken: data.refreshToken, accessToken: data.accessToken, receivedAt: env.now() };
        // Only a tab that is signed in takes it; a signed-out tab stays signed out until someone signs in there.
        if (api.getRefreshToken()) api.adoptSharedSession({ refreshToken: data.refreshToken, accessToken: data.accessToken });
      }
      wake();
    };
  }

  const removeStorageListener = env.addStorageListener((change) => {
    if (change.key !== null && change.key !== sessionKey) return;
    const next = change.key === null ? null : sessionFrom(change.newValue);
    if (!next) {
      // Signed out (or the session was cleared) in another tab: this tab's copy is no longer the person's session.
      knownUserId = null;
      signOutHere(SIGNED_OUT_ELSEWHERE_MESSAGE);
      wake();
      return;
    }
    const previous = sessionFrom(change.oldValue);
    const previousUserId = previous?.user.id ?? knownUserId;
    knownUserId = next.user.id;
    if (previousUserId !== null && previousUserId !== next.user.id) {
      signOutHere(OTHER_ACCOUNT_MESSAGE);
      wake();
      return;
    }
    if (!next.refreshToken || spent.has(next.refreshToken)) return;
    if (previous?.refreshToken && previous.refreshToken !== next.refreshToken) spend(previous.refreshToken, 'rotated');
    // Another tab rotated (or re-established) the shared session. Take the successor so this tab never presents the
    // token it replaced; the access token this tab holds stays valid until it expires.
    const held = api.getRefreshToken();
    if (held && held !== next.refreshToken) {
      const handed = fresh(lastHandoff) && lastHandoff.refreshToken === next.refreshToken ? lastHandoff.accessToken : undefined;
      api.adoptSharedSession({ refreshToken: next.refreshToken, accessToken: handed });
    }
    wake();
  });

  const sleep = (ms: number) => new Promise<void>((resolve) => { env.setTimeout(resolve, ms); });

  /** Waits (bounded) until `check` yields a value, re-checking whenever another tab's word arrives. */
  function waitFor<T>(check: () => T | null, waitMs: number): Promise<T | null> {
    const now = check();
    const wait = Math.min(waitMs, MAX_WAIT_MS);
    if (now !== null || wait <= 0) return Promise.resolve(now);
    return new Promise<T | null>((resolve) => {
      let timer: unknown = null;
      const finish = (value: T | null) => {
        waiters.delete(onWord);
        env.clearTimeout(timer);
        resolve(value);
      };
      const onWord = () => { const value = check(); if (value !== null) finish(value); };
      waiters.add(onWord);
      timer = env.setTimeout(() => finish(check()), wait);
    });
  }

  async function withLease<T>(task: (contended: boolean) => Promise<T>): Promise<T> {
    const owner = env.randomId();
    const readLease = (): { owner?: unknown; expires?: unknown } | null => {
      try {
        const raw = env.storage.getItem(LEASE_KEY);
        return raw ? (JSON.parse(raw) as { owner?: unknown; expires?: unknown }) : null;
      } catch {
        return null;
      }
    };
    const deadline = env.now() + LEASE_WAIT_MS;
    let held = false;
    let contended = false;
    try {
      for (;;) {
        const lease = readLease();
        if (!lease || typeof lease.expires !== 'number' || lease.expires <= env.now()) {
          env.storage.setItem(LEASE_KEY, JSON.stringify({ owner, expires: env.now() + LEASE_TTL_MS }));
          await sleep(LEASE_SETTLE_MS);
          if (readLease()?.owner === owner) { held = true; break; }
          contended = true;
        } else if (env.now() >= deadline) {
          contended = true;
          break;
        } else {
          contended = true;
          await sleep(LEASE_POLL_MS + Math.floor(Math.random() * LEASE_POLL_MS));
        }
      }
    } catch {
      // Storage refused the lease (quota, privacy mode): renew without it; the re-read still protects the token.
    }
    try {
      return await task(contended);
    } finally {
      if (held) {
        try {
          if (readLease()?.owner === owner) env.storage.removeItem(LEASE_KEY);
        } catch {
          /* the lease simply expires */
        }
      }
    }
  }

  async function withWebLock<T>(locks: LocksLike, task: (contended: boolean) => Promise<T>): Promise<T> {
    let started = false;
    const run = (contended: boolean) => { started = true; return task(contended); };
    try {
      const free = { taken: false };
      // Take it straight away when nobody holds it; otherwise queue for it, knowing another tab went first.
      const result = await locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock) return undefined as unknown as T;
        free.taken = true;
        return run(false);
      });
      if (free.taken) return result;
      return await locks.request(LOCK_NAME, { mode: 'exclusive' }, () => run(true));
    } catch (error) {
      // The task's own failure is the task's; only a lock manager that refused to run it falls back to the lease.
      if (started) throw error;
      return withLease(task);
    }
  }

  const coordination: RefreshCoordination = {
    runExclusive(task) {
      return env.locks ? withWebLock(env.locks, task) : withLease(task);
    },
    readSharedRefreshToken() {
      const stored = readStored(env.storage, sessionKey);
      if (!stored.ok) return undefined;
      const token = stored.session?.refreshToken;
      if (!token) return null;
      const how = spent.get(token);
      if (how === 'ended') return null;
      if (how === 'rotated') {
        // This tab's view of the store is behind; the successor it heard about is the current one.
        return fresh(lastHandoff) && !spent.has(lastHandoff.refreshToken) ? lastHandoff.refreshToken : undefined;
      }
      return token;
    },
    isSpent(refreshToken) {
      return spent.has(refreshToken);
    },
    awaitAccessToken(refreshToken, { exclude, waitMs }) {
      return waitFor(() => {
        const handoff = lastHandoff;
        return fresh(handoff) && handoff.refreshToken === refreshToken && handoff.accessToken !== exclude ? handoff.accessToken : null;
      }, waitMs);
    },
    awaitSuccessor(refreshToken, waitMs) {
      return waitFor(() => {
        const handoff = lastHandoff;
        if (fresh(handoff) && handoff.previous === refreshToken && !spent.has(handoff.refreshToken)) {
          return { refreshToken: handoff.refreshToken, accessToken: handoff.accessToken };
        }
        return null;
      }, waitMs);
    },
    announceRotation({ previous, refreshToken, accessToken }) {
      spend(previous, 'rotated');
      try {
        channel?.postMessage({ type: 'rotated', previous, refreshToken, accessToken });
      } catch {
        /* other tabs fall back to the storage event and renew with the current token */
      }
    },
    sessionEnded(refreshToken) {
      spend(refreshToken, 'ended');
      try {
        // Only that session: never clear a newer one another tab (or a fresh sign-in) has stored since.
        if (readStored(env.storage, sessionKey).session?.refreshToken === refreshToken) env.storage.removeItem(sessionKey);
      } catch {
        /* the App's unauthorized handler clears it next */
      }
      try {
        channel?.postMessage({ type: 'ended', refreshToken });
      } catch {
        /* the storage event carries it */
      }
    },
  };

  api.setRefreshCoordination(coordination);

  return () => {
    api.setRefreshCoordination(null);
    removeStorageListener();
    waiters.clear();
    if (channel) {
      channel.onmessage = null;
      try { channel.close(); } catch { /* already closed */ }
    }
  };
}

/** The real browser environment, or null when this is not a browser with localStorage (native: never installed). */
export function browserCrossTabEnv(): CrossTabEnv | null {
  if (typeof window === 'undefined') return null;
  let storage: StorageLike | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  if (!storage) return null;
  const store = storage;
  const g = globalThis as unknown as {
    navigator?: { locks?: LocksLike };
    BroadcastChannel?: new (name: string) => ChannelLike;
  };
  const locks = g.navigator?.locks && typeof g.navigator.locks.request === 'function' ? g.navigator.locks : null;
  const Channel = typeof g.BroadcastChannel === 'function' ? g.BroadcastChannel : null;
  return {
    storage: store,
    locks,
    createChannel: Channel ? (name) => new Channel(name) : null,
    addStorageListener(listener) {
      const handler = (event: StorageEvent) => {
        if (event.storageArea && event.storageArea !== (store as unknown)) return;
        listener({ key: event.key, oldValue: event.oldValue, newValue: event.newValue });
      };
      window.addEventListener('storage', handler);
      return () => window.removeEventListener('storage', handler);
    },
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    randomId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  };
}
