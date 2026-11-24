import * as SecureStore from 'expo-secure-store';
import { StoredSession } from '../types/models';
import { parseStoredSession, serializeStoredSession } from '../navigation/role-routing';

export const SESSION_KEY = 'security-app-session';
const isWeb = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

/**
 * Web: true while the stored session still carries `refreshToken`. Browser tabs share this store, so another tab may
 * have rotated (or ended) the session since this tab read it; a write based on the older token must then be skipped,
 * or it would put a dead token back where every tab reads it. Native has one process, so it is always current there.
 */
export function isStoredRefreshToken(refreshToken: string): boolean {
  if (!isWeb) return true;
  try {
    const raw = readWebSession();
    return !!raw && parseStoredSession(raw)?.refreshToken === refreshToken;
  } catch {
    return false;
  }
}

function readWebSession() {
  if (!isWeb) {
    return null;
  }

  return window.localStorage.getItem(SESSION_KEY);
}

function writeWebSession(value: string) {
  if (!isWeb) {
    return;
  }

  window.localStorage.setItem(SESSION_KEY, value);
}

function clearWebSession() {
  if (!isWeb) {
    return;
  }

  window.localStorage.removeItem(SESSION_KEY);
}

export async function loadStoredSession(): Promise<StoredSession | null> {
  try {
    const raw = isWeb ? readWebSession() : await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return null;

    const session = parseStoredSession(raw);
    if (!session) {
      throw new Error('Invalid stored session');
    }
    return session;
  } catch {
    if (isWeb) {
      clearWebSession();
    } else {
      await SecureStore.deleteItemAsync(SESSION_KEY);
    }

    return null;
  }
}

export async function persistSession(session: StoredSession) {
  const raw = serializeStoredSession(session);

  if (isWeb) {
    writeWebSession(raw);
    return;
  }

  return SecureStore.setItemAsync(SESSION_KEY, raw);
}

export async function clearStoredSession() {
  if (isWeb) {
    clearWebSession();
    return;
  }

  return SecureStore.deleteItemAsync(SESSION_KEY);
}
