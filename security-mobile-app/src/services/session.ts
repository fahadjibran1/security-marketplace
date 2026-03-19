import * as SecureStore from 'expo-secure-store';
import { AuthSession } from '../types/models';

const SESSION_KEY = 'security-app-session';

export async function loadStoredSession(): Promise<AuthSession | null> {
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as AuthSession;
  } catch {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return null;
  }
}

export function persistSession(session: AuthSession) {
  return SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

export function clearStoredSession() {
  return SecureStore.deleteItemAsync(SESSION_KEY);
}
