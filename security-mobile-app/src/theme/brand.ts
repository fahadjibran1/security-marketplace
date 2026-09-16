/**
 * S4 — shared production design tokens.
 *
 * Brand colours describe S4 itself. Semantic colours describe product state.
 * Keep critical red reserved for genuine risk, failure and compliance blocking states.
 * Teal is a BRAND/PRIMARY ACTION colour — never use it as an operational success colour.
 * Green means operational success.
 */

export const brand = {
  appName: 'S4',
  guardAppName: 'S4 Guard',
  shortBrand: 'S4',
  tagline: 'Sites • Shifts • Staff • Security',
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
  successBorder: '#86EFAC',
  warning: '#A15C07',
  warningSurface: '#FEF3C7',
  warningBorder: '#FCD34D',
  danger: '#B42318',
  dangerSurface: '#FEE4E2',
  dangerBorder: '#FECACA',
  info: '#1D4ED8',
  infoSurface: '#DBEAFE',
  infoBorder: '#BFDBFE',
  pending: '#64748B',
  pendingSurface: '#E2E8F0',
  pendingBorder: '#CBD5E1',

  // Focus/interaction
  focusRing: '#0F817E',
  disabledSurface: '#E2E8F0',
  disabledText: '#7B8794',
} as const;

/**
 * 8px-oriented spacing scale.
 * Operational UI should primarily use sm–xl (8–24).
 * section–xxxl reserved for major page regions.
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  section: 40,
  xxxl: 48,
} as const;

/**
 * Border radii.
 * sm   — controls (buttons, inputs, chips): 8px
 * card — cards and content panels: 10px
 * drawer — drawers, modals: 12px
 * md/lg/xl — legacy; prefer the semantic names above for new work.
 */
export const radii = {
  sm: 8,
  card: 10,
  drawer: 12,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

/**
 * Typography scale.
 * Use semantic names (pageTitle, sectionTitle, etc.) in new components.
 * Legacy names (display, title, heading, body, label, caption) remain for backward compatibility.
 */
export const typography = {
  // Semantic scale (new components should use these)
  pageTitle:    { fontSize: 28, lineHeight: 34, fontWeight: '700' as const },
  sectionTitle: { fontSize: 18, lineHeight: 24, fontWeight: '600' as const },
  panelHeading: { fontSize: 15, lineHeight: 20, fontWeight: '600' as const },
  tableRow:     { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  kpi:          { fontSize: 28, lineHeight: 32, fontWeight: '700' as const },

  // Legacy names — preserved for backward compatibility
  display:      { fontSize: 32, lineHeight: 38, fontWeight: '700' as const },
  title:        { fontSize: 24, lineHeight: 30, fontWeight: '700' as const },
  heading:      { fontSize: 18, lineHeight: 24, fontWeight: '700' as const },
  body:         { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  bodyStrong:   { fontSize: 16, lineHeight: 24, fontWeight: '600' as const },
  label:        { fontSize: 14, lineHeight: 20, fontWeight: '600' as const },
  caption:      { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
} as const;

/**
 * Control dimensions.
 * Minimum touch targets are preserved for accessibility.
 */
export const control = {
  minTouchTarget: 44,
  inputHeight: 52,
  buttonHeight: 52,    // lg button
  buttonHeightMd: 44,  // md button (= min touch target)
  buttonHeightSm: 36,  // sm button (compact, not primary CTA)
} as const;

/**
 * Shadow presets.
 * card     — subtle lift for content panels
 * raised   — moderate elevation for overlapping UI
 * elevated — maximum elevation for drawers and modals
 */
export const shadows = {
  card: {
    shadowColor: '#0B1F33',
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  raised: {
    shadowColor: '#0B1F33',
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  elevated: {
    shadowColor: '#0B1F33',
    shadowOpacity: 0.09,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
} as const;

/**
 * Semantic surface aliases.
 * Prefer these over raw colors.card / colors.background in new components.
 */
export const surfaces = {
  app:     colors.background,
  panel:   colors.card,
  raised:  colors.card,
  subtle:  colors.surfaceSubtle,
  inverse: colors.primaryNavy,
} as const;

/** Semantic text colour aliases. */
export const text = {
  primary:   colors.textPrimary,
  secondary: colors.textSecondary,
  muted:     colors.textMuted,
  inverse:   colors.textOnBrand,
  link:      colors.accentTeal,
} as const;

/** Semantic border colour aliases. */
export const borders = {
  default: colors.border,
  strong:  colors.fieldBorder,
  focus:   colors.focusRing,
  subtle:  colors.surfaceSubtle,
} as const;

/**
 * Semantic status colour aliases.
 * These map directly onto the operational status palette.
 * Domain badge labels (Active, Expiring, etc.) should map onto these variants.
 */
export const status = {
  success:           colors.success,
  successBackground: colors.successSurface,
  warning:           colors.warning,
  warningBackground: colors.warningSurface,
  danger:            colors.danger,
  dangerBackground:  colors.dangerSurface,
  info:              colors.info,
  infoBackground:    colors.infoSurface,
  neutral:           colors.textSecondary,
  neutralBackground: colors.surfaceSubtle,
} as const;

/** Interaction state colour tokens. */
export const interaction = {
  focus:       colors.focusRing,
  disabled:    colors.disabledSurface,
  disabledText: colors.disabledText,
} as const;

/**
 * Responsive breakpoints (logical px).
 *
 * mobile  < 768   single-column, full-width UI
 * tablet  768–1023
 * laptop  1024–1279
 * wide    1280–1439
 * desktop >= 1440 full multi-column layout
 */
export const breakpoints = {
  mobile:  768,
  tablet:  1024,
  laptop:  1280,
  wide:    1440,
} as const;

export type BrandColorName = keyof typeof colors;
