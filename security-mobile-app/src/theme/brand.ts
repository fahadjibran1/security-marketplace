/**
 * S4 Security — shared brand strings and color tokens.
 * Use this module when migrating screens from ad-hoc hex values.
 */

export const brand = {
  appName: 'S4 Security',
  shortBrand: 'S4',
  tagline: 'Staff. Sites. Shifts. Security.',
} as const;

/** Pilot palette — semantic names map to brand spec. */
export const colors = {
  primaryNavy: '#0B1B2B',
  accentTeal: '#1FA3A3',
  supportBlue: '#2D6CDF',
  neutralSlate: '#9AA3AF',
  background: '#F1F5F9',
  card: '#FFFFFF',
  border: '#E2E8F0',
  textPrimary: '#0B1B2B',
  textSecondary: '#64748B',
} as const;

export type BrandColorName = keyof typeof colors;
