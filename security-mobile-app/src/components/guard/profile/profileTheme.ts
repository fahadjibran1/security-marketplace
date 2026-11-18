import { colors } from '../../../theme/brand';
import { guardColors, guardFontFamily, guardShape, guardType } from '../../../theme/guard';

/**
 * S4 Guard Profile — design tokens (Profile Phase 2B).
 *
 * No new palette and no new UI library: the Profile reuses the Guard Home's tokens (theme/guard.ts — navy, Guard
 * teal, 8dp borderless-shadow cards, Inter type scale) so the two screens read as one product. The only additions
 * were the requirement tags (removed in UX-02A, see below). Requirement levels stay neutral (approved decision 2C-3): a requirement level is not a
 * problem, so warning and danger colours are kept for real problems (an expired SIA licence, a deployment blocker).
 * Each pairing is checked for at least 4.5:1 contrast in scripts/guard-profile-foundations.spec.cjs.
 */
export const profileTokens = {
  colors: {
    canvas: guardColors.canvas,
    surface: guardColors.surface,
    textPrimary: guardColors.textPrimary,
    textSecondary: colors.textSecondary,
    border: guardColors.cardBorder,
    accent: guardColors.teal,
    onAccent: '#FFFFFF',
    danger: colors.danger,
  },
  shape: {
    cardRadius: guardShape.cardRadius,
    cardBorderWidth: guardShape.cardBorderWidth,
    controlRadius: guardShape.controlRadius,
    tagRadius: guardShape.statusRadius,
  },
  type: {
    sectionTitle: guardType.siteTime,
    sectionLabel: guardType.sectionLabel,
    body: guardType.meta,
    value: guardType.date,
    button: guardType.button,
    /** UX-02A: the requirement text (overview rows, section caption): 13/18, regular, secondary colour. */
    requirement: { fontFamily: guardFontFamily.regular, fontSize: 13, lineHeight: 18 },
  },
  spacing: { gutter: 16, sectionPadding: 16, rowGap: 12 },
} as const;

/**
 * UX-02A: the requirement levels are plain secondary text (RequirementText), no longer neutral grey pills, so there are
 * no requirement colours. The words still carry the distinction (Required / Company may ask / Optional / By invitation).
 */

/** Status colours, used only for facts that are good news or a real problem (never for a requirement level). */
export const PROFILE_TONE_COLORS = {
  success: { text: colors.success, surface: colors.successSurface },
  warning: { text: colors.warning, surface: colors.warningSurface },
  danger: { text: colors.danger, surface: colors.dangerSurface },
  neutral: { text: guardColors.textPrimary, surface: colors.pendingSurface },
} as const;
