import { colors } from '../../../theme/brand';
import { guardColors, guardShape, guardType } from '../../../theme/guard';
import type { ProfileRequirement } from './profileCopy';

/**
 * S4 Guard Profile — design tokens (Profile Phase 2B).
 *
 * No new palette and no new UI library: the Profile reuses the Guard Home's tokens (theme/guard.ts — navy, Guard
 * teal, 8dp borderless-shadow cards, Inter type scale) so the two screens read as one product. The only additions
 * are the requirement tags. They are deliberately neutral (approved decision 2C-3): a requirement level is not a
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
  },
  spacing: { gutter: 16, sectionPadding: 16, rowGap: 12 },
} as const;

/** Requirement tag colours: text on surface. Neutral for every level; the label carries the meaning. */
const NEUTRAL_TAG = { text: guardColors.textPrimary, surface: colors.pendingSurface } as const;
export const REQUIREMENT_TAG_COLORS: Record<ProfileRequirement, { text: string; surface: string }> = {
  required: NEUTRAL_TAG,
  company: NEUTRAL_TAG,
  optional: NEUTRAL_TAG,
  setByCompany: NEUTRAL_TAG,
  invitation: NEUTRAL_TAG,
};

/** Status colours, used only for facts that are good news or a real problem (never for a requirement level). */
export const PROFILE_TONE_COLORS = {
  success: { text: colors.success, surface: colors.successSurface },
  warning: { text: colors.warning, surface: colors.warningSurface },
  danger: { text: colors.danger, surface: colors.dangerSurface },
  neutral: { text: guardColors.textPrimary, surface: colors.pendingSurface },
} as const;
