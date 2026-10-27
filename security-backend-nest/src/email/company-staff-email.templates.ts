import { layout } from './auth-email.templates';
import { TransactionalEmail } from './transactional-email.service';

/** Company names and role labels are company-entered text: escaped before they reach the HTML body. */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The staff invitation. The link opens the S4 web app's account-link page (/accept-invitation), the same page that
 * serves /reset-password and /verify-email, so it works in any browser without the mobile app. The token is
 * single-use; only its SHA-256 is stored, and it is never logged or written to the audit trail.
 */
export function companyStaffInvitationEmail(
  to: string,
  webAppUrl: string,
  token: string,
  companyName: string,
  roleLabel: string,
  expiresInDays: number,
): TransactionalEmail {
  const url = `${webAppUrl}/accept-invitation?token=${encodeURIComponent(token)}`;
  const footer = 'If you were not expecting this invitation, you can ignore this email. Nothing changes unless you accept it.';
  const name = companyName.trim() || 'A company';
  return {
    kind: 'company_staff_invitation',
    to,
    subject: `You have been invited to join ${name} on S4`,
    text: [
      `You have been invited to join ${name} on S4`,
      '',
      `${name} has invited you to join their team on S4 as ${roleLabel}.`,
      `Open this link to accept. It works once and expires in ${expiresInDays} days:`,
      url,
      '',
      'If you are new to S4 you will choose your own password. If you already have an S4 account with this email address, you will keep your existing password.',
      '',
      footer,
    ].join('\n'),
    html: layout(
      `Join ${escapeHtml(name)} on S4`,
      [
        `${escapeHtml(name)} has invited you to join their team on S4 as <strong>${escapeHtml(roleLabel)}</strong>.`,
        `The link works once and expires in ${expiresInDays} days.`,
        'If you are new to S4 you will choose your own password. If you already have an S4 account with this email address, you will keep your existing password.',
      ],
      { label: 'Accept invitation', url },
      footer,
    ),
  };
}
