/**
 * Platform Admin → Account deletion requests: the words and decisions the screen shows, kept pure so the certification
 * suite executes them. The backend (AccountDeletionAdminService) enforces every rule; this only explains them.
 *
 * Personal account deletion never closes a company. An owner's request stays pending until each company they own is
 * closed by a separate decision on the Company verification screen, or ownership is transferred (arranged with S4
 * support; there is no in-app transfer).
 */
import type {
  AdminDeletionCompanySummary, AdminDeletionPreview, AdminDeletionRequest, DeletionRequestAccountType, DeletionVerificationMethod,
} from '../services/api';
import { S4_SUPPORT_EMAIL } from '../constants/s4Links';

export const DELETION_ACCOUNT_TYPE_LABEL: Record<DeletionRequestAccountType, string> = {
  guard: 'Guard',
  company_owner: 'Company owner',
  company_member: 'Company team member',
  platform_admin: 'Platform Admin',
  client_user: 'Client user',
  client_portal: 'Client portal login',
};

/** How an emailed request was checked to come from the account holder, in the order offered. */
export const DELETION_VERIFICATION_METHODS: ReadonlyArray<{ value: DeletionVerificationMethod; label: string }> = [
  { value: 'request_from_registered_email', label: 'Sent from the registered email address' },
  { value: 'confirmed_in_app_by_user', label: 'Confirmed by the user in the app' },
  { value: 'other_verified', label: 'Verified another way' },
];

export const DELETION_VERIFICATION_NOTE_MAX = 200;

/** What resolves an owner's blocked request. There is no in-app ownership transfer. */
export const OWNER_RESOLUTION_GUIDANCE =
  'Deleting a personal account never closes a company. To resolve this, either close the company with a separate ' +
  'decision on the Company verification screen (it is audited there), or the owner arranges a transfer of ownership ' +
  `with S4 support at ${S4_SUPPORT_EMAIL}. There is no transfer in the app. The request stays pending until then.`;

/** Refusal codes from the API, in words. */
const CODE_MESSAGES: Record<string, string> = {
  ACCOUNT_NOT_FOUND: 'No S4 account uses that email address.',
  ACCOUNT_DELETION_NOT_REQUESTED: 'No deletion request is recorded for this account. Record the request first.',
  ACCOUNT_ALREADY_DELETED: 'This account has already been deleted.',
  ACCOUNT_DELETION_SELF: 'You cannot complete the deletion of your own account. Another Platform Admin must do it.',
  ACCOUNT_DELETION_LAST_PLATFORM_ADMIN: 'This is the last active Platform Admin account, so it cannot be deleted.',
  ACCOUNT_DELETION_OWNER_HAS_ACTIVE_COMPANY: `This account still owns a company that is not closed. ${OWNER_RESOLUTION_GUIDANCE}`,
  ACCOUNT_DELETION_COMPANY_SHIFTS_OUTSTANDING:
    'A closed company this account owns still has shifts in progress or starting in the future. The request stays pending until they have finished or been cancelled.',
  ACCOUNT_DELETION_IDENTITY_NOT_CONFIRMED: 'This request came by email. Tick the box to confirm you have verified the requester is the account holder.',
  ACCOUNT_DELETION_VERIFICATION_NOTE_REQUIRED: 'Say briefly how the request was verified.',
};

export function deletionRequestError(code: string | undefined | null, fallback: string): string {
  return (code && CODE_MESSAGES[code]) || fallback;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One owned company from the preview, as lines of facts. Counts only; nothing here is changed by the deletion. */
export function companySummaryLines(company: AdminDeletionCompanySummary): string[] {
  const status = company.verificationStatus.replace(/_/g, ' ');
  const lines = [
    `Company #${company.companyId} · ${status}${company.closed ? ' (closed)' : ' (not closed)'}`,
    `${plural(company.shiftsInProgress, 'shift')} in progress · ${plural(company.futureShifts, 'future shift')}`,
  ];
  const other: Array<[number, string]> = [
    [company.timesheetsAwaitingApproval, 'timesheets awaiting approval'],
    [company.approvedTimesheetsNotPaid, 'approved timesheets not paid'],
    [company.invoiceBatchesNotPaid, 'invoice batches not paid'],
    [company.payrollBatchesNotPaid, 'payroll batches not paid'],
    [company.clientWeeklyApprovalsOpen, 'client weekly approvals open'],
    [company.clientShiftDisputesOpen, 'client shift disputes open'],
  ];
  lines.push(`Other open items: ${other.map(([n, label]) => `${n} ${label}`).join(' · ')}`);
  return lines;
}

/** What completing this request will do, for the confirmation dialog. */
export function deletionCompletionConfirmation(
  request: Pick<AdminDeletionRequest, 'email' | 'accountType' | 'companies' | 'client' | 'requestedBy'>,
) {
  const lines: string[] = [];
  if (request.accountType === 'company_owner' && request.companies.length) {
    lines.push('The companies this account owns are already closed. They stay as they are: their records, team memberships and team access are not changed.');
  }
  if (request.accountType === 'client_portal') {
    lines.push('The client portal login is anonymised and can no longer sign in.');
    if (request.client?.companyName) lines.push(`${request.client.companyName}'s records about its client are kept.`);
  } else {
    lines.push('The account is anonymised in place: email, name and phone removed, password made unusable, every session and push device ended. Operational and audit records are kept.');
  }
  if (request.requestedBy === 'admin') lines.push('This request came by email: you must confirm the requester\'s identity first.');
  lines.push('This cannot be undone.');
  return {
    title: 'Complete account deletion?',
    message: `${request.email}\n\n${lines.join('\n')}`,
    confirmLabel: 'Delete account',
  };
}

/** Whether the confirm button may be pressed: an emailed request needs the identity box ticked. */
export function canConfirmCompletion(request: Pick<AdminDeletionRequest, 'requestedBy'>, identityConfirmed: boolean, preview?: Pick<AdminDeletionPreview, 'canComplete'> | null) {
  if (preview && !preview.canComplete) return false;
  return request.requestedBy !== 'admin' || identityConfirmed;
}

/** Basic shape check before sending an emailed request's address; the server validates it properly. */
export function recordRequestEmailError(value: string): string | null {
  const email = value.trim();
  if (!email) return 'Enter the email address the request came from.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.';
  return null;
}

/** The verification fields an emailed request must carry. */
export function recordRequestVerificationError(method: DeletionVerificationMethod | null, note: string): string | null {
  if (!method) return 'Choose how the request was verified.';
  const trimmed = note.trim();
  if (!trimmed) return 'Add a short verification note.';
  if (trimmed.length > DELETION_VERIFICATION_NOTE_MAX) return `Keep the verification note to ${DELETION_VERIFICATION_NOTE_MAX} characters.`;
  return null;
}
