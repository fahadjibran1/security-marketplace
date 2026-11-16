import { colors } from '../../../theme/brand';
import { guardColors, guardShape, guardType } from '../../../theme/guard';
import type { ProfileRequirement } from './profileCopy';

/**
 * S4 Guard Profile — design tokens (Profile Phase 2B).
 *
 * No new palette and no new UI library: the Profile reuses the Guard Home's tokens (theme/guard.ts — navy, Guard
 * teal, 8dp borderless-shadow cards, Inter type scale) so the two screens read as one product. The only additions
 * are the requirement tags, which are composed from existing brand status colours; each pairing is checked for at
 * least 4.5:1 contrast in scripts/guard-profile-foundations.spec.cjs.
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

/** Requirement tag colours: text on surface. */
export const REQUIREMENT_TAG_COLORS: Record<ProfileRequirement, { text: string; surface: string }> = {
  required: { text: colors.danger, surface: colors.dangerSurface },
  company: { text: colors.warning, surface: colors.warningSurface },
  optional: { text: colors.success, surface: colors.successSurface },
  setByCompany: { text: guardColors.textPrimary, surface: colors.pendingSurface },
};
