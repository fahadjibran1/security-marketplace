import { LARGE_TEXT_SCALE, NARROW_WIDTH, PAGE_GUTTER } from '../home/guardHomeLayout';

/**
 * S4 Guard Profile — responsive layout rules (Profile Phase 2B).
 *
 * The same principle as the Guard Home (guardHomeLayout.ts, S4-UX-01): the UI is never scaled as a whole, text
 * keeps the system's font scale, and these values only choose how rows wrap or stack, measured in
 * density-independent points AFTER the text scale. The thresholds are the Home's own (NARROW_WIDTH,
 * LARGE_TEXT_SCALE, PAGE_GUTTER), so Home and Profile turn compact at the same moment.
 *
 * Pure: executed by scripts/guard-profile-foundations.spec.cjs across small and large phones and text scales.
 */

/** Minimum touch target for every Profile control (Android 48dp is met by the 44pt minimum plus hit slop). */
export const PROFILE_MIN_TOUCH_TARGET = 44;
/** Inner padding of a Profile card or section. */
const SECTION_PADDING = 16;
/** Narrowest a label column may be, in unscaled text points, before a label/value row stacks. */
const MIN_LABEL_TEXT_WIDTH = 110;
/** Narrowest a value column may be, in unscaled text points, before a label/value row stacks. */
const MIN_VALUE_TEXT_WIDTH = 140;
/** Narrowest the two footer buttons (Cancel / Save) may each be, in unscaled text points, before they stack. */
const MIN_FOOTER_BUTTON_TEXT_WIDTH = 120;
/** A choice group with more options than this becomes a list when the layout is compact. */
const MAX_COMPACT_CHIPS = 4;

export interface ProfileLayoutInput {
  width: number;
  height: number;
  fontScale: number;
}

export interface ProfileLayout {
  width: number;
  height: number;
  fontScale: number;
  /** Narrow screen or large text (the Home's rule). */
  compact: boolean;
  /** Width available inside a section, in points. */
  contentWidth: number;
  /** Label above value instead of side by side. */
  detailRowStacks: boolean;
  /** Cancel and Save each take a full-width row, Save first. */
  footerStacks: boolean;
  /** The overview's section rows put the requirement tag under the title instead of beside it. */
  sectionRowStacksTag: boolean;
  /** Minimum touch target for every control. */
  minTouchTarget: number;
}

function safeScale(fontScale: number): number {
  return Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
}

export function profileLayout({ width, height, fontScale }: ProfileLayoutInput): ProfileLayout {
  const scale = safeScale(fontScale);
  const w = Number.isFinite(width) && width > 0 ? width : NARROW_WIDTH;
  const narrow = w < NARROW_WIDTH;
  const largeText = scale >= LARGE_TEXT_SCALE;
  const contentWidth = Math.max(0, w - PAGE_GUTTER * 2 - SECTION_PADDING * 2);
  const textWidth = contentWidth / scale;
  const compact = narrow || largeText;

  return {
    width: w,
    height,
    fontScale: scale,
    compact,
    contentWidth,
    // A compact layout always stacks; a wide one stacks only when the columns would not fit their text.
    detailRowStacks: compact || textWidth < MIN_LABEL_TEXT_WIDTH + MIN_VALUE_TEXT_WIDTH,
    footerStacks: compact || textWidth < MIN_FOOTER_BUTTON_TEXT_WIDTH * 2 + 12,
    sectionRowStacksTag: narrow || largeText,
    minTouchTarget: PROFILE_MIN_TOUCH_TARGET,
  };
}

export type ChoicePresentation = 'chips' | 'list';

/**
 * How a single-choice group is shown. Wrapping chips suit a few short options; with many options on a compact
 * layout (the 6 travel methods, 6 distances, 7 relationships at large text) a vertical list of full-width rows is
 * easier to read and to hit, and never wraps into a tall ragged block.
 */
export function choicePresentation(optionCount: number, layout: Pick<ProfileLayout, 'compact'>): ChoicePresentation {
  return layout.compact && optionCount > MAX_COMPACT_CHIPS ? 'list' : 'chips';
}
