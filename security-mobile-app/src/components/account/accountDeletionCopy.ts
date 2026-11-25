/**
 * The words S4 uses about account deletion, in one place so the in-app journey and the certification
 * suite read the same text.
 *
 * Deliberately factual and deliberately NOT a promise that everything is erased: operational and security
 * records (shifts, attendance, Welfare Checks, Log Book entries, incidents, alerts, audit history) may
 * have to be kept for legal, contractual, regulatory, safety or evidential reasons. This is product copy,
 * not legal advice.
 */
export const ACCOUNT_DELETION_COPY = {
  entryTitle: 'Delete account',
  entryCaption: 'Remove your access to S4 and delete or anonymise your account details.',
  explainTitle: 'Delete your S4 account',
  explainPoints: [
    'Your access to S4 will be removed and you will be signed out on every device.',
    'Your account and profile identifiers — such as your email address and phone number — will be deleted or anonymised where appropriate.',
    'Certain operational and security records, such as shift, attendance, Welfare Check, Log Book, incident and audit records, may be retained where required for legal, contractual, regulatory, safety or evidential purposes. Where your name forms part of those records it may remain on them.',
    'You cannot undo this. To use S4 again you would need a new account.',
  ],
  explainContinue: 'Continue',
  confirmTitle: 'Confirm account deletion',
  confirmBody: 'Enter your password to confirm. Your account will be deleted straight away and you will be signed out.',
  confirmButton: 'Delete my account',
  cancel: 'Cancel',
  deletedNotice: 'Your S4 account has been deleted and you have been signed out.',
} as const;

/**
 * A client portal login cannot delete itself: it asks, and S4 support completes the request from the Platform Admin
 * queue. Records the security company holds about its client (sites, service records, approvals) are the company's.
 */
export const CLIENT_ACCOUNT_DELETION_COPY = {
  entryTitle: 'Request account deletion',
  entryCaption: 'Ask S4 to delete your client portal login.',
  explainTitle: 'Request deletion of your client portal login',
  explainPoints: [
    'S4 support will delete your client portal login. Once it is done you will no longer be able to sign in.',
    'Your name and email address will be removed from the login.',
    'Records the security company keeps about your organisation — sites, service records, reports, approvals and invoices — belong to that company and are not deleted.',
  ],
  explainContinue: 'Send request',
  cancel: 'Cancel',
  requestedTitle: 'We have recorded your request',
} as const;
