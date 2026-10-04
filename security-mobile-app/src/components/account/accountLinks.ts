/**
 * Emailed account links on the S4 web app: /reset-password?token=… and /verify-email?token=…
 *
 * Pure so the certification suite executes it. The token is read once, then immediately removed from the
 * address bar (history.replaceState) so it is not kept in browser history, bookmarks, screenshots of the
 * URL, or a Referer header — the screen holds it in memory only for as long as it needs it.
 */

export type AccountLinkKind = 'reset-password' | 'verify-email';

export interface AccountLink {
  kind: AccountLinkKind;
  token: string | null;
}

/** Same rule registration applies (the backend's PASSWORD_MIN_LENGTH). */
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;

const PATHS: Record<string, AccountLinkKind> = {
  '/reset-password': 'reset-password',
  '/verify-email': 'verify-email',
};

export function parseAccountLink(pathname: string, search: string): AccountLink | null {
  const normalised = (pathname || '/').replace(/\/+$/, '') || '/';
  const kind = PATHS[normalised];
  if (!kind) return null;
  const token = new URLSearchParams(search || '').get('token');
  return { kind, token: token && token.trim() ? token.trim() : null };
}

interface LocationLike {
  pathname: string;
  search: string;
}
interface HistoryLike {
  replaceState: (data: unknown, unused: string, url?: string) => void;
}

/**
 * Read the account link from the current page and strip the token from the URL in the same step.
 * Returns null on any page that is not an account link (and on native, where there is no location).
 */
export function takeAccountLink(location: LocationLike | undefined, history: HistoryLike | undefined): AccountLink | null {
  if (!location) return null;
  const link = parseAccountLink(location.pathname, location.search);
  if (link && location.search && history) {
    try {
      history.replaceState(null, '', location.pathname);
    } catch {
      // Some embedded browsers refuse replaceState; the token is still only used once.
    }
  }
  return link;
}

/** The message to show for a new password, or null when it is acceptable. */
export function validateNewPassword(password: string, confirmation: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Your new password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Your new password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (password !== confirmation) return 'The two passwords do not match.';
  return null;
}
