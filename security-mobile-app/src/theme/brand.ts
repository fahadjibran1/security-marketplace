/**
 * S4 Security — shared production design tokens.
 *
 * Brand colours describe S4 itself. Semantic colours describe product state.
 * Keep critical red reserved for genuine risk, failure and compliance blocking states.
 */

export const brand = {
  appName: 'S4 Security',
  guardAppName: 'S4 Guard',
  shortBrand: 'S4',
  tagline: 'Staff. Sites. Shifts. Security.',
} as const;

export const colors = {
  // Brand
  primaryNavy: '#0B1F33',
  primaryNavyStrong: '#071725',
  primaryNavySoft: '#16324A',
  accentTeal: '#16A6A1',
  accentTealStrong: '#0F817E',
  accentTealSoft: '#DDF7F5',
  supportBlue: '#2563EB',

  // Surfaces and text
  background: '#F4F7FA',
  surfaceSubtle: '#EAF0F5',
  card: '#FFFFFF',
  border: '#D7E0E8',
  fieldBorder: '#9AAABA',
  fieldPlaceholder: '#5B6B7A',
  textPrimary: '#102536',
  textSecondary: '#5B6B7A',
  textMuted: '#748392',
  textOnBrand: '#FFFFFF',
  neutralSlate: '#94A3B8',

  // Semantic status colours — never use these as decorative brand accents.
  success: '#15803D',
  successSurface: '#DCFCE7',
  warning: '#A15C07',
  warningSurface: '#FEF3C7',
  danger: '#B42318',
  dangerSurface: '#FEE4E2',
  info: '#1D4ED8',
  infoSurface: '#DBEAFE',
  pending: '#64748B',
  pendingSurface: '#E2E8F0',

  // Focus/interaction
  focusRing: '#0F817E',
  disabledSurface: '#E2E8F0',
  disabledText: '#7B8794',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

export const typography = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: '700' as const },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' as const },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '700' as const },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: '600' as const },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
} as const;

export const control = {
  minTouchTarget: 44,
  inputHeight: 52,
  buttonHeight: 52,
} as const;

export type BrandColorName = keyof typeof colors;
