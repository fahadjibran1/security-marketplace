import * as SecureStore from 'expo-secure-store';
import { AuthSession } from '../types/models';

const SESSION_KEY = 'security-app-session';
const isWeb = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

function isValidSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<AuthSession>;
  return (
    typeof candidate.accessToken === 'string' &&
    !!candidate.accessToken &&
    !!candidate.user &&
    typeof candidate.user.id === 'number' &&
    typeof candidate.user.email === 'string' &&
    typeof candidate.user.role === 'string'
  );
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

export async function loadStoredSession(): Promise<AuthSession | null> {
  try {
    const raw = isWeb ? readWebSession() : await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (!isValidSession(parsed)) {
      throw new Error('Invalid stored session');
    }

    return parsed;
  } catch {
    if (isWeb) {
      clearWebSession();
    } else {
      await SecureStore.deleteItemAsync(SESSION_KEY);
    }

    return null;
  }
}

export async function persistSession(session: AuthSession) {
  const raw = JSON.stringify(session);

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
