/**
 * S4 Guard Profile — the weekday picker layout for Availability & travel (UX-02 Package B).
 *
 * Pure (no React Native), so the rule is executed by scripts/guard-home-ux01.spec.cjs.
 */

/** Every weekday cell is at least this tall and wide (the Android 48dp target). */
export const WEEKDAY_MIN_TARGET = 48;
/** Gap between weekday cells. */
export const WEEKDAY_GAP = 8;
/** Width a three-letter day label needs at 1.0× text (14pt label type), plus the cell's own padding. */
const WEEKDAY_LABEL_WIDTH = 32;
const WEEKDAY_CELL_PADDING = 12;
/** Page gutter (16), card padding (12) and card border (1) on each side of the weekday grid. */
const WEEKDAY_GRID_INSET = 2 * (16 + 12 + 1);

/**
 * UX-02 Package B: the weekday picker is an equal-width grid. All seven days share one row only when every cell would
 * still be at least 48dp and wide enough for its label at the current text size; otherwise the days form a balanced
 * 4 + 3 grid (never "Sat" alone on a second row).
 */
export function weekdayColumns(windowWidth: number, fontScale: number): 7 | 4 {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const width = Math.max(0, (Number.isFinite(windowWidth) ? windowWidth : 0) - WEEKDAY_GRID_INSET);
  const cell = (width - WEEKDAY_GAP * 6) / 7;
  const needed = Math.max(WEEKDAY_MIN_TARGET, Math.ceil(WEEKDAY_LABEL_WIDTH * scale) + WEEKDAY_CELL_PADDING);
  return cell >= needed ? 7 : 4;
}

/** The weekday indexes (0 = Sunday, as the backend stores them) for each row of the grid. */
export function weekdayRows(columns: 7 | 4): number[][] {
  return columns === 7 ? [[0, 1, 2, 3, 4, 5, 6]] : [[0, 1, 2, 3], [4, 5, 6]];
}
