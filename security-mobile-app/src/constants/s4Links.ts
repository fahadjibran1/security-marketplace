/**
 * The S4 public pages and support contact, in one place. Every in-app link to them (sign-in, Guard Profile, Company
 * Account, client portal, Platform Admin) reads from here, so a change of address is made once.
 *
 * Support address: support@sfour.co.uk (owner decision: one address for support, privacy and account deletion). Keep in
 * step with S4_SUPPORT_EMAIL in security-backend-nest/src/auth/account-deletion.service.ts.
 *
 * Pure: no react-native import, so the certification suite executes it directly.
 */
export const S4_SUPPORT_EMAIL = 'support@sfour.co.uk';

export type S4LinkKey = 'privacy' | 'terms' | 'support' | 'accountDeletion';

export interface S4Link {
  key: S4LinkKey;
  label: string;
  url: string;
  /** Read by screen readers: where the link goes. */
  accessibilityHint: string;
}

export const S4_LINKS: Readonly<Record<S4LinkKey, S4Link>> = {
  privacy: {
    key: 'privacy',
    label: 'Privacy Policy',
    url: 'https://sfour.co.uk/privacy',
    accessibilityHint: 'Opens the S4 Privacy Policy in your browser',
  },
  terms: {
    key: 'terms',
    label: 'Terms and Conditions',
    url: 'https://sfour.co.uk/terms',
    accessibilityHint: 'Opens the S4 Terms and Conditions in your browser',
  },
  support: {
    key: 'support',
    label: 'Support',
    url: `mailto:${S4_SUPPORT_EMAIL}`,
    accessibilityHint: `Writes an email to S4 support at ${S4_SUPPORT_EMAIL}`,
  },
  accountDeletion: {
    key: 'accountDeletion',
    label: 'Account Deletion',
    url: 'https://sfour.co.uk/account-deletion',
    accessibilityHint: 'Opens the S4 account deletion page in your browser',
  },
};

/** The order the links are shown in, everywhere. */
export const S4_LINK_ORDER: readonly S4LinkKey[] = ['privacy', 'terms', 'support', 'accountDeletion'];

export const s4Links = (): S4Link[] => S4_LINK_ORDER.map((key) => S4_LINKS[key]);

/** "contact S4 support at support@sfour.co.uk" — for copy that used to say only "contact S4 support". */
export const S4_SUPPORT_CONTACT = `S4 support at ${S4_SUPPORT_EMAIL}`;

interface LinkingLike {
  openURL: (url: string) => Promise<unknown>;
}

/**
 * Open one of the links. Never throws: a device with no mail app (mailto:) or no browser leaves the user where they
 * are, and the caller can show the address instead. Resolves true when the system accepted the link.
 */
export async function openS4Link(key: S4LinkKey, linking: LinkingLike): Promise<boolean> {
  const link = S4_LINKS[key];
  if (!link) return false;
  try {
    await linking.openURL(link.url);
    return true;
  } catch {
    return false;
  }
}
