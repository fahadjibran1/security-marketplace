/**
 * Platform Admin → Account deletion requests: the words and decisions the screen shows, kept pure so the certification
 * suite executes them. The backend (AccountDeletionAdminService) enforces every rule; this only explains them.
 */
import type { AdminDeletionRequest, DeletionRequestAccountType } from '../services/api';

export const DELETION_ACCOUNT_TYPE_LABEL: Record<DeletionRequestAccountType, string> = {
  guard: 'Guard',
  company_owner: 'Company owner',
  company_member: 'Company team member',
  platform_admin: 'Platform Admin',
  client_user: 'Client user',
  client_portal: 'Client portal login',
};

/** Refusal codes from the API, in words. */
const CODE_MESSAGES: Record<string, string> = {
  ACCOUNT_NOT_FOUND: 'No S4 account uses that email address.',
  ACCOUNT_DELETION_NOT_REQUESTED: 'No deletion request is recorded for this account. Record the request first.',
  ACCOUNT_ALREADY_DELETED: 'This account has already been deleted.',
  ACCOUNT_DELETION_SELF: 'You cannot complete the deletion of your own account. Another Platform Admin must do it.',
  ACCOUNT_DELETION_LAST_PLATFORM_ADMIN: 'This is the last active Platform Admin account, so it cannot be deleted.',
  ACCOUNT_DELETION_SHIFTS_IN_PROGRESS: 'A company this account owns has shifts in progress. Wait until they are booked off or closed, then try again.',
};

export function deletionRequestError(code: string | undefined | null, fallback: string): string {
  return (code && CODE_MESSAGES[code]) || fallback;
}

/** What completing this request will do, for the confirmation dialog. */
export function deletionCompletionConfirmation(request: Pick<AdminDeletionRequest, 'email' | 'accountType' | 'companies' | 'client'>) {
  const lines: string[] = [];
  if (request.accountType === 'company_owner' && request.companies.length) {
    const names = request.companies.map((c) => c.name).join(', ');
    lines.push(`${names} will be closed: suspended (or rejected if never approved) with a note, and every team member's access to it ended.`);
    lines.push('The company\'s operational, employment, compliance and audit records are kept.');
  }
  if (request.accountType === 'client_portal') {
    lines.push('The client portal login is anonymised and can no longer sign in.');
    if (request.client?.companyName) lines.push(`${request.client.companyName}'s records about its client are kept.`);
  } else {
    lines.push('The account is anonymised in place: email, name and phone removed, password made unusable, every session and push device ended. Operational and audit records are kept.');
  }
  lines.push('This cannot be undone.');
  return {
    title: 'Complete account deletion?',
    message: `${request.email}\n\n${lines.join('\n')}`,
    confirmLabel: 'Delete account',
  };
}

/** Basic shape check before sending an emailed request's address; the server validates it properly. */
export function recordRequestEmailError(value: string): string | null {
  const email = value.trim();
  if (!email) return 'Enter the email address the request came from.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.';
  return null;
}
