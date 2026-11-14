// S4-UX-01 — responsive layout decisions for the Guard Home, header and on-duty bar. Pure, so every viewport and
// text scale can be executed in a spec. The UI is never scaled as a whole: these values only choose how flexible
// rows wrap and how many tile columns fit, in density-independent points, after the system text scale.

/** Below this width (points) the screen counts as narrow. (The header no longer uses it: it wraps by content.) */
export const NARROW_WIDTH = 375;
/** At or above this system text scale the text counts as large. */
export const LARGE_TEXT_SCALE = 1.3;
/** Horizontal page gutter used by the Guard screen (styles.content paddingHorizontal). */
export const PAGE_GUTTER = 16;
/** Inner padding of a Home card. */
const CARD_PADDING = 16;
/** Gap between grid tiles. */
const TILE_GAP = 10;
/** The narrowest a tile may be, measured in unscaled text points, before tiles go to one column. */
const MIN_TILE_TEXT_WIDTH = 120;
/** The narrowest the on-duty bar's status + Emergency row may be, in unscaled text points, before it stacks. */
const MIN_BAR_ROW_TEXT_WIDTH = 300;

export interface GuardHomeLayoutInput {
  width: number;
  height: number;
  fontScale: number;
}

export interface GuardHomeLayout {
  width: number;
  height: number;
  fontScale: number;
  /** Narrow screen or large text: anything laid out in one row should be allowed to wrap. */
  compact: boolean;
  /** The on-duty bar puts Emergency on its own full-width row under the status. */
  onDutyBarStacks: boolean;
  /** Columns for the Home action tiles. */
  tileColumns: 1 | 2;
}

function safeScale(fontScale: number): number {
  return Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
}

export function guardHomeLayout({ width, height, fontScale }: GuardHomeLayoutInput): GuardHomeLayout {
  const scale = safeScale(fontScale);
  const w = Number.isFinite(width) && width > 0 ? width : NARROW_WIDTH;
  const narrow = w < NARROW_WIDTH;
  const largeText = scale >= LARGE_TEXT_SCALE;

  const rowWidth = w - PAGE_GUTTER * 2;
  const tileWidth = (rowWidth - CARD_PADDING * 2 - TILE_GAP) / 2;

  return {
    width: w,
    height,
    fontScale: scale,
    compact: narrow || largeText,
    onDutyBarStacks: rowWidth / scale < MIN_BAR_ROW_TEXT_WIDTH,
    tileColumns: tileWidth / scale >= MIN_TILE_TEXT_WIDTH ? 2 : 1,
  };
}
