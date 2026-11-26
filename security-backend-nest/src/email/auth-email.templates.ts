import { TransactionalEmail } from './transactional-email.service';

/**
 * S4 authentication email content. The product is named "S4" — never "S4 Security", "S4 Guard" or
 * "Security Marketplace".
 *
 * Links point at the S4 web app (https://app.sfour.co.uk by default) rather than an app-scheme deep
 * link, so they open on any device and do not depend on the mobile package identity.
 */

function layout(heading: string, paragraphs: string[], action: { label: string; url: string }, footer: string) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:22px;color:#102536">${p}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#F4F7FA;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FA;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #D7E0E8;border-radius:8px">
<tr><td style="background:#0B1F33;padding:16px 24px;border-radius:8px 8px 0 0;color:#FFFFFF;font-size:20px;font-weight:700">S4</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:20px;line-height:26px;color:#102536">${heading}</h1>
${body}
<p style="margin:24px 0"><a href="${action.url}" style="display:inline-block;background:#0F817E;color:#FFFFFF;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">${action.label}</a></p>
<p style="margin:0 0 16px;font-size:13px;line-height:18px;color:#5B6B7A">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all">${action.url}</span></p>
<p style="margin:0;font-size:13px;line-height:18px;color:#5B6B7A">${footer}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function passwordResetEmail(to: string, webAppUrl: string, token: string): TransactionalEmail {
  const url = `${webAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const footer = 'If you did not ask to reset your S4 password, you can ignore this email. Your password will not change.';
  return {
    kind: 'password_reset',
    to,
    subject: 'Reset your S4 password',
    text: [
      'Reset your S4 password',
      '',
      'We received a request to reset the password for your S4 account.',
      'Open this link to choose a new password. It works once and expires in 30 minutes:',
      url,
      '',
      'When you reset your password you will be signed out of S4 on every device.',
      '',
      footer,
    ].join('\n'),
    html: layout(
      'Reset your S4 password',
      [
        'We received a request to reset the password for your S4 account.',
        'Choose a new password using the button below. The link works once and expires in 30 minutes.',
        'When you reset your password you will be signed out of S4 on every device.',
      ],
      { label: 'Reset password', url },
      footer,
    ),
  };
}

/** Company names and role labels are entered by people, so they are escaped before going into the HTML part. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/**
 * An invitation to join a company's staff on S4. The link opens the S4 web app's /join-company page, where the
 * invited person sets their name and password. Seven days, single use.
 */
export function staffInvitationEmail(
  to: string,
  webAppUrl: string,
  token: string,
  companyName: string,
  roleLabel: string,
): TransactionalEmail {
  const url = `${webAppUrl}/join-company?token=${encodeURIComponent(token)}`;
  const company = (companyName || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || 'A company';
  const footer = 'If you were not expecting this invitation, you can ignore this email. No account is created unless you accept.';
  return {
    kind: 'staff_invitation',
    to,
    subject: `You have been invited to join ${company} on S4`,
    text: [
      `You have been invited to join ${company} on S4`,
      '',
      `${company} has invited you to join its team on S4 as ${roleLabel}.`,
      'Open this link to set your name and password. It works once and expires in 7 days:',
      url,
      '',
      footer,
    ].join('\n'),
    html: layout(
      'You have been invited to join a team on S4',
      [
        `${escapeHtml(company)} has invited you to join its team on S4 as ${escapeHtml(roleLabel)}.`,
        'Use the button below to set your name and password. The link works once and expires in 7 days.',
      ],
      { label: 'Accept invitation', url },
      footer,
    ),
  };
}

export function emailVerificationEmail(to: string, webAppUrl: string, token: string): TransactionalEmail {
  const url = `${webAppUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const footer = 'If you did not create an S4 account, you can ignore this email.';
  return {
    kind: 'email_verification',
    to,
    subject: 'Verify your email address for S4',
    text: [
      'Verify your email address for S4',
      '',
      'Confirm this is your email address to finish setting up your S4 account.',
      'Open this link to verify it. It works once and expires in 24 hours:',
      url,
      '',
      footer,
    ].join('\n'),
    html: layout(
      'Verify your email address',
      [
        'Confirm this is your email address to finish setting up your S4 account.',
        'The link works once and expires in 24 hours. You can sign in to S4 once your address is verified.',
      ],
      { label: 'Verify email address', url },
      footer,
    ),
  };
}
