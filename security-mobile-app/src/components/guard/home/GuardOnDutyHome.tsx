import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, control, spacing } from '../../../theme';
import { guardColors, guardFontFamily, guardShape, guardType } from '../../../theme/guard';
import type { GuardWelfareCard } from '../guardWelfarePresentation';
import { LARGE_TEXT_SCALE } from './guardHomeLayout';
import { useGuardHomeLayout } from './useGuardHomeLayout';

/**
 * S4-UX-01.3 — the On Duty Home, presentation only.
 *
 * The Guard dashboard owns every value and every handler and passes them in; nothing here decides what a shift
 * needs, in what order, or when. The screen lays these out as:
 *
 *   GuardShiftSummary → GuardWelfareSummary → [the existing Patrol panel, in its own stable slot]
 *   → Shift Records (the screen's renderHomeQuickActions) → GuardBookOff → GuardRecentActivity
 *
 * so Welfare and Patrol are adjacent near the top whenever both are showing, and neither is ranked above the other
 * by any new rule: their order is fixed. Book Off is the same control with the same handler and confirmation as
 * before, kept below the routine records so it is never the easiest thing to tap by accident.
 *
 * No text here has a fixed width or a line limit: everything wraps at word boundaries at any text scale.
 */

/** Joins a short fact's words with non-breaking spaces, so a line can only break between facts. */
export function keepTogether(fact: string): string {
  return fact.replace(/ /g, ' ');
}

export interface GuardShiftSummaryProps {
  /** Shown only when no other on-screen element already names the site (the on-duty bar does, in variant A). */
  siteName: string | null;
  dateLabel: string;
  timeRange: string;
  bookedOnLabel: string;
  durationLabel: string;
  /** A phase line worth reading (e.g. the shift is ending soon), or null when it would only repeat something. */
  statusLine: string | null;
  statusTone: 'warning' | 'danger' | null;
}

export function GuardShiftSummary({ siteName, dateLabel, timeRange, bookedOnLabel, durationLabel, statusLine, statusTone }: GuardShiftSummaryProps) {
  return (
    <View style={[styles.card, styles.summaryCard]} testID="guard-shift-summary">
      {siteName ? <Text style={styles.site} accessibilityRole="header">{siteName}</Text> : null}
      <View style={styles.summaryRow}>
        <View style={styles.livePill} accessibilityLabel="Shift live">
          <View style={styles.liveDot} />
          <Text style={styles.livePillText}>LIVE</Text>
        </View>
        <Text style={styles.timeRange}>{timeRange}</Text>
        <Text style={styles.dateLabel}>{dateLabel}</Text>
      </View>
      {/* Each fact stays whole: with large text the line breaks only at the "·" between them, never inside
          "1h 58m" (non-breaking spaces within each fact). */}
      <Text style={styles.meta}>
        {`${keepTogether(`Booked On ${bookedOnLabel}`)} · ${keepTogether(`${durationLabel} on shift`)}`}
      </Text>
      {statusLine ? (
        <Text style={[styles.statusLine, statusTone === 'danger' ? styles.toneDanger : statusTone === 'warning' ? styles.toneWarning : null]}>
          {statusLine}
        </Text>
      ) : null}
    </View>
  );
}

export interface GuardWelfareSummaryProps {
  /** The backend projection, presented unchanged (guardWelfareCard): status word, next due, detail, lapses. */
  card: GuardWelfareCard;
  onRecord: () => void;
}

/** The Welfare action's label, always in full. */
export const WELFARE_ACTION_LABEL = 'Record Welfare Check';
/** Gap between the status column and the action when they share a row. */
const WELFARE_SIDE_GAP = spacing.md;

/** A text's one-line laid-out size (0 = not measured yet). */
export interface WelfareTextSize { width: number; height: number }
/** A line that may wrap between its words: its one-line size and its longest single word's width. */
export interface WelfareLineSize extends WelfareTextSize { longestWord: number }

export interface WelfareSideBySideInput {
  /** The system text scale. Side by side is a normal-text-size arrangement only. */
  fontScale: number;
  /** The card's content width, as laid out (0 = not measured yet). */
  rowWidth: number;
  /** The action's label, on one line. */
  action: WelfareTextSize;
  /** The section name, the status word and "Next due …" (null when nothing is due). */
  name: WelfareTextSize;
  status: WelfareTextSize;
  next: WelfareTextSize | null;
  /** The detail and missed lines, when present. */
  detail: WelfareLineSize | null;
  missed: WelfareLineSize | null;
}

/** A part not laid out yet (a measurement, not a style): not a positive size, so welfareSideBySide keeps the stacked arrangement. */
const WELFARE_UNMEASURED: WelfareTextSize = Object.freeze({ width: Number.NaN, height: Number.NaN });

const measuredSize = (s: WelfareTextSize | null) => s === null || (s.width > 0 && s.height > 0);
/** Lines a text takes at a width (an estimate from its one-line width: wrapping happens only between words). */
const linesAt = (s: WelfareTextSize, width: number) => Math.max(1, Math.ceil((s.width + RECORD_TILE_WORD_SLACK) / width));
/** The detail and missed lines' row (styles.welfareStatusRow): side by side when both fit, else one under the other. */
function welfareStatusRowHeight(detail: WelfareLineSize | null, missed: WelfareLineSize | null, width: number): number {
  if (detail && missed) {
    if (detail.width + spacing.md + missed.width + RECORD_TILE_WORD_SLACK <= width) return Math.max(detail.height, missed.height);
    return detail.height * linesAt(detail, width) + 2 + missed.height * linesAt(missed, width);
  }
  const only = detail ?? missed;
  return only ? only.height * linesAt(only, width) : 0;
}

/**
 * S4-UX-04B-S2 — whether the Welfare status and its action share one row. Only at the normal text size; only when the
 * full action (its one-line label plus the button's padding) and a status column wide enough for every part (no word
 * broken) fit side by side; and only when that is actually shorter than the stacked card. Otherwise — larger text, a
 * narrower phone, or a status with more lines (OVERDUE and MISSED carry the overrun and missed counts) — the action
 * stays below the status, full width, exactly as before. False until everything has been measured.
 */
export function welfareSideBySide({ fontScale, rowWidth, action, name, status, next, detail, missed }: WelfareSideBySideInput): boolean {
  if (!(fontScale < LARGE_TEXT_SCALE) || !(rowWidth > 0)) return false;
  if (![action, name, status, next, detail, missed].every(measuredSize)) return false;
  if ((detail && !(detail.longestWord > 0)) || (missed && !(missed.longestWord > 0))) return false;
  const slack = RECORD_TILE_WORD_SLACK;
  const actionWidth = action.width + spacing.lg * 2 + slack;
  const actionHeight = Math.max(RECORD_TILE_MIN_HEIGHT, action.height + spacing.sm * 2);
  const column = rowWidth - actionWidth - WELFARE_SIDE_GAP;
  const widestPart = Math.max(name.width, status.width, next?.width ?? 0, detail?.longestWord ?? 0, missed?.longestWord ?? 0);
  if (widestPart + slack > column) return false;

  const titleWidth = name.width + spacing.sm + status.width;
  const titleHeight = (width: number) => (titleWidth + slack <= width ? Math.max(name.height, status.height) : name.height + 2 + status.height);
  const statusRow = detail || missed ? welfareStatusRowHeight(detail, missed, column) : 0;
  const side = Math.max(
    actionHeight,
    titleHeight(column) + (next ? spacing.xs + next.height : 0) + (detail || missed ? spacing.xs + statusRow : 0),
  );
  // Stacked (styles.welfareHead, the status row, then the full-width action, 8dp apart).
  const head = next && titleWidth + spacing.sm + next.width + slack > rowWidth
    ? titleHeight(rowWidth) + spacing.xs + next.height
    : Math.max(titleHeight(rowWidth), next?.height ?? 0);
  const stacked = head + (detail || missed ? spacing.sm + welfareStatusRowHeight(detail, missed, rowWidth) : 0) + spacing.sm + actionHeight;
  return side < stacked;
}

export function GuardWelfareSummary({ card, onRecord }: GuardWelfareSummaryProps) {
  const toneStyle = card.tone === 'danger' ? styles.toneDanger : card.tone === 'warning' ? styles.toneWarning : card.tone === 'good' ? styles.toneGood : null;
  const { fontScale } = useGuardHomeLayout();
  const [rowWidth, setRowWidth] = useState(0);
  const [measured, setMeasured] = useState<Record<string, WelfareTextSize>>({});
  const nextDueText = card.nextDue ? `Next due ${card.nextDue}` : null;
  // Everything the arrangement depends on, each laid out once, invisibly, in its own style at the current text scale:
  // the whole lines (for their one-line size) and the detail and missed lines' single words (for their narrowest fit).
  const lineParts = (key: string, line: string | null, style: unknown) =>
    line ? [{ key, text: line, style }, ...recordLabelWords(line).map((word, j) => ({ key: `${key}-w${j}`, text: word, style }))] : [];
  const parts: Array<{ key: string; text: string; style: unknown }> = [
    { key: 'name', text: 'Welfare Check', style: styles.sectionLabel },
    { key: 'status', text: card.label, style: styles.welfareStatus },
    ...(nextDueText ? [{ key: 'next', text: nextDueText, style: styles.nextDue }] : []),
    ...lineParts('detail', card.detail, styles.meta),
    ...lineParts('missed', card.missedSummary, styles.body),
    { key: 'action', text: WELFARE_ACTION_LABEL, style: styles.welfareButtonText },
  ];
  const size = (key: string): WelfareTextSize => {
    const part = parts.find((p) => p.key === key);
    return (part && measured[`${part.key}:${part.text}`]) || WELFARE_UNMEASURED;
  };
  const line = (key: string): WelfareLineSize => ({
    ...size(key),
    longestWord: Math.max(0, ...parts.filter((p) => p.key.startsWith(`${key}-w`)).map((p) => size(p.key).width)),
  });
  const sideBySide = welfareSideBySide({
    fontScale,
    rowWidth,
    action: size('action'),
    name: size('name'),
    status: size('status'),
    next: nextDueText ? size('next') : null,
    detail: card.detail ? line('detail') : null,
    missed: card.missedSummary ? line('missed') : null,
  });

  const status = (
    <>
      {card.detail || card.missedSummary ? (
        <View style={styles.welfareStatusRow}>
          {card.detail ? <Text style={styles.meta}>{card.detail}</Text> : null}
          {card.missedSummary ? <Text style={[styles.body, styles.toneDanger]}>{card.missedSummary}</Text> : null}
        </View>
      ) : null}
    </>
  );
  const action = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={WELFARE_ACTION_LABEL}
      style={({ pressed }: { pressed: boolean }) => [styles.welfareButton, sideBySide && styles.welfareButtonSide, card.actionUrgent ? styles.welfareButtonUrgent : null, pressed && styles.pressed]}
      onPress={onRecord}
      testID="guard-welfare-action"
    >
      <Text style={styles.welfareButtonText}>{WELFARE_ACTION_LABEL}</Text>
    </Pressable>
  );

  return (
    <View style={[styles.card, card.tone === 'danger' ? styles.cardUrgent : null]} testID="guard-welfare-summary">
      {/* S4-UX-04B-S2: each part laid out once, invisibly, so the arrangement follows the real Inter widths on this
          device. Hidden from touch and from screen readers, and it takes no space. */}
      <View style={styles.wordMeasure} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden aria-hidden testID="guard-welfare-measure">
        {parts.map((part) => (
          <Text
            key={part.key}
            style={[part.style, styles.wordMeasureText]}
            onLayout={(e: LayoutEvent) => {
              const id = `${part.key}:${part.text}`;
              const { width, height } = e.nativeEvent.layout;
              setMeasured((current) => (current[id]?.width === width && current[id]?.height === height ? current : { ...current, [id]: { width, height } }));
            }}
          >
            {part.text}
          </Text>
        ))}
      </View>
      <View onLayout={(e: LayoutEvent) => setRowWidth(e.nativeEvent.layout.width)} style={sideBySide ? styles.welfareSide : styles.welfareStacked} testID="guard-welfare-layout">
        {sideBySide ? (
          <>
            {/* Side by side (normal text, when it fits): the name and status word, the next due time, then the detail
                and missed lines, beside the full-label action. */}
            <View style={styles.welfareInfo}>
              <View style={styles.welfareTitle}>
                <Text style={styles.sectionLabel}>Welfare Check</Text>
                <Text style={[styles.welfareStatus, toneStyle]}>{card.label}</Text>
              </View>
              {nextDueText ? <Text style={styles.nextDue}>{nextDueText}</Text> : null}
              {status}
            </View>
            {action}
          </>
        ) : (
          <>
            {/* S4-UX-01.3b: one heading row — the name, its status word and the next due time. It wraps between those
                three at large text sizes, never inside one. The action below, full width. */}
            <View style={styles.welfareHead}>
              <View style={styles.welfareTitle}>
                <Text style={styles.sectionLabel}>Welfare Check</Text>
                <Text style={[styles.welfareStatus, toneStyle]}>{card.label}</Text>
              </View>
              {nextDueText ? <Text style={styles.nextDue}>{nextDueText}</Text> : null}
            </View>
            {status}
            {action}
          </>
        )}
      </View>
    </View>
  );
}

export interface GuardShiftRecordsProps<K extends string> {
  items: Array<{ key: K; title: string; accessibilityLabel: string }>;
  /** The Log Book line from guardLogBookCard (status and when it is due), or null: shown beside its own tile. */
  note?: string | null;
  /** The system text scale, so a tile's minimum width follows the size of its label. */
  fontScale: number;
  onOpen: (key: K) => void;
}

/**
 * The narrowest a record tile may be, in unscaled points. Three tiles (3 × 88 + 2 gaps of 8 = 280) fit inside the
 * records card on a 360dp phone (360 − 2 × 16 page − 2 × 12 card = 304) at the default text size; larger text
 * widens every tile, and they wrap to further rows rather than shrink.
 */
export const RECORD_TILE_MIN_WIDTH = 88;
export const RECORD_TILE_MIN_HEIGHT = 48;
/** S4-UX-04B-S1: the near-square tiles' minimum height when every record shares one row. */
export const RECORD_TILE_COMPACT_MIN_HEIGHT = 64;
/** Gap between tiles, across and down (styles.tileRow). */
const RECORD_TILE_GAP = spacing.sm;
/** A tile's side padding: tighter when the tiles share one row, so a label's longest word has more room. */
const RECORD_TILE_PADDING_COMPACT = spacing.xs;
const RECORD_TILE_PADDING = spacing.sm;
/** Room kept beside a label's longest word, so sub-pixel rounding can never push it onto a broken second line. */
const RECORD_TILE_WORD_SLACK = 2;

// The project's react-native type shim (src/types/react-shims.d.ts) does not export event types; these are the only
// fields read here.
type LayoutEvent = { nativeEvent: { layout: { width: number; height: number } } };

/** The words a label may wrap between. A label only ever breaks at its spaces, never inside a word. */
export function recordLabelWords(title: string): string[] {
  return title.split(/\s+/).filter(Boolean);
}

export interface RecordTileColumnsInput {
  /** Width of the tiles' row, in points, as laid out (0 = not measured yet). */
  rowWidth: number;
  /** For each tile, the laid-out width of its label's longest word at the current text scale (0 = not measured yet). */
  longestWords: number[];
}

/**
 * S4-UX-04B-S1 — how many tiles share a row. Every record on one row when each label's longest word fits its tile;
 * otherwise two columns (2 + 1: the last tile takes the full width), otherwise one column. Labels still wrap between
 * their words, so "Site Request" may take two lines, but no word is ever broken and no text is made smaller: larger
 * text simply means fewer columns. Four tiles (Welfare Check included) go 2 + 2 rather than 3 + 1.
 * Returns null until the row and every label have been measured; the caller then keeps the previous wrapping rule.
 */
export function recordTileColumns({ rowWidth, longestWords }: RecordTileColumnsInput): number | null {
  const count = longestWords.length;
  if (count === 0 || !(rowWidth > 0) || longestWords.some((w) => !(w > 0))) return null;
  const widest = Math.max(...longestWords);
  const candidates = [3, 2].filter((n) => n <= count && !(count === 4 && n === 3));
  for (const columns of candidates) {
    const tileWidth = (rowWidth - RECORD_TILE_GAP * (columns - 1)) / columns;
    const padding = columns === count ? RECORD_TILE_PADDING_COMPACT : RECORD_TILE_PADDING;
    if (widest <= tileWidth - padding * 2 - RECORD_TILE_WORD_SLACK) return columns;
  }
  return 1;
}

export function GuardShiftRecords<K extends string>({ items, note, fontScale, onOpen }: GuardShiftRecordsProps<K>) {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const [rowWidth, setRowWidth] = useState(0);
  const [wordWidths, setWordWidths] = useState<Record<string, number>>({});
  const words = Array.from(new Set(items.flatMap((item) => recordLabelWords(item.title))));
  const columns = recordTileColumns({
    rowWidth,
    longestWords: items.map((item) => Math.max(0, ...recordLabelWords(item.title).map((word) => wordWidths[word] ?? 0))),
  });
  const oneRow = columns !== null && columns === items.length;
  // Until measured: the previous rule (each tile at least RECORD_TILE_MIN_WIDTH × the text scale, wrapping by size).
  const basis = columns === null ? RECORD_TILE_MIN_WIDTH * scale : (rowWidth - RECORD_TILE_GAP * (columns - 1)) / columns - 0.5;
  const tileSize = {
    flexBasis: basis,
    minHeight: oneRow ? RECORD_TILE_COMPACT_MIN_HEIGHT : RECORD_TILE_MIN_HEIGHT,
    paddingHorizontal: oneRow ? RECORD_TILE_PADDING_COMPACT : RECORD_TILE_PADDING,
  };
  return (
    <View style={[styles.card, styles.recordsCard]} testID="guard-shift-records">
      {/* S4-UX-01.3b: no "Shift records" heading — the tiles name themselves. The Log Book's status sits here,
          beside the Log Book tile, instead of inside the Welfare card. */}
      {note ? <Text style={styles.meta}>{note}</Text> : null}
      {/* S4-UX-04B-S1: each label word laid out once, invisibly and at the tiles' own style and text scale, so the
          column count follows the real Inter widths on this device. Hidden from touch and from screen readers. */}
      <View style={styles.wordMeasure} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden aria-hidden testID="guard-shift-records-measure">
        {words.map((word) => (
          <Text
            key={word}
            style={[styles.tileText, styles.wordMeasureText]}
            onLayout={(e: LayoutEvent) => {
              const width = e.nativeEvent.layout.width;
              setWordWidths((current) => (current[word] === width ? current : { ...current, [word]: width }));
            }}
          >
            {word}
          </Text>
        ))}
      </View>
      {/* One row of near-square tiles when every label fits; 2 + 1 or one column with larger text (recordTileColumns). */}
      <View style={styles.tileRow} onLayout={(e: LayoutEvent) => setRowWidth(e.nativeEvent.layout.width)} testID="guard-shift-records-tiles">
        {items.map((item) => (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityLabel={item.accessibilityLabel}
            style={({ pressed }: { pressed: boolean }) => [styles.tile, tileSize, pressed && styles.pressed]}
            onPress={() => onOpen(item.key)}
          >
            <Text style={styles.tileText}>{item.title}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export interface GuardBookOffProps {
  label: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}

/** The shift's own Book Off: the screen's existing primary handler, which always confirms first. */
export function GuardBookOff({ label, busy, disabled, onPress }: GuardBookOffProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => [styles.bookOff, disabled && styles.disabled, pressed && styles.pressed]}
      testID="guard-book-off"
    >
      <Text style={styles.bookOffText}>{busy ? 'Ending...' : label}</Text>
    </Pressable>
  );
}

export interface GuardRecentActivityProps {
  entries: Array<{ id: string; title: string; message: string; time: string }>;
}

export const RECENT_ACTIVITY_LIMIT = 3;

export function GuardRecentActivity({ entries }: GuardRecentActivityProps) {
  const shown = entries.slice(0, RECENT_ACTIVITY_LIMIT);
  return (
    <View style={styles.card} testID="guard-recent-activity">
      <Text style={styles.sectionLabel}>Recent activity</Text>
      {shown.length === 0 ? (
        <Text style={styles.meta}>Nothing recorded yet.</Text>
      ) : (
        shown.map((entry) => (
          <View key={entry.id} style={styles.activityRow}>
            <Text style={styles.activityTime}>{entry.time}</Text>
            <View style={styles.activityText}>
              <Text style={styles.activityTitle}>{entry.title}</Text>
              {entry.message && entry.message !== entry.title ? <Text style={styles.meta}>{entry.message}</Text> : null}
            </View>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // S4-UX Stage 1: white, 8dp corners, a 1dp border and no shadow — the same frame the Patrol slot draws around the
  // panel. Each padding is 1dp less than before, so the border takes no space: the content box (and so every wrap,
  // card height and the Book Off position) is unchanged. Only an overdue Welfare Check gets the heavier outline.
  card: {
    backgroundColor: guardColors.surface,
    borderRadius: guardShape.cardRadius,
    borderWidth: guardShape.cardBorderWidth,
    borderColor: guardColors.cardBorder,
    paddingHorizontal: spacing.lg - guardShape.cardBorderWidth,
    paddingVertical: spacing.md - guardShape.cardBorderWidth,
    gap: spacing.sm,
  },
  cardUrgent: { borderColor: guardColors.emergency, borderWidth: 2 },
  // S4-UX-01.3b: the summary's three short lines sit closer together; the records card is a little narrower at the
  // sides so three tiles share one row on a 360dp phone. Stage 1: the summary only renders On Duty, so its green edge
  // marks a live shift; its left padding gives back the edge's width, keeping the text where it was.
  summaryCard: {
    gap: spacing.xs,
    borderLeftWidth: guardShape.liveEdgeWidth,
    borderLeftColor: guardColors.liveEdge,
    paddingLeft: spacing.lg - guardShape.liveEdgeWidth,
  },
  recordsCard: { paddingHorizontal: spacing.md - guardShape.cardBorderWidth },
  site: { color: guardColors.textPrimary, ...guardType.siteTime },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.sm, rowGap: spacing.xs },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.successSurface,
    borderRadius: guardShape.statusRadius,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  livePillText: { color: colors.success, fontFamily: guardFontFamily.bold, fontSize: 12, lineHeight: 16, letterSpacing: 0.6 },
  timeRange: { color: guardColors.textPrimary, ...guardType.siteTime },
  dateLabel: { color: colors.textSecondary, ...guardType.date },
  meta: { color: colors.textSecondary, ...guardType.meta },
  statusLine: { fontFamily: guardFontFamily.bold, fontSize: 15, lineHeight: 20, color: guardColors.textPrimary },
  toneGood: { color: colors.success },
  toneWarning: { color: colors.warning },
  toneDanger: { color: guardColors.emergency },
  // Stage 1: section headings in secondary navy (10:1 on white) for a stronger hierarchy than the grey meta text.
  sectionLabel: { color: guardColors.navySecondary, ...guardType.sectionLabel, letterSpacing: 0.8, textTransform: 'uppercase' },
  welfareHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: spacing.sm, rowGap: spacing.xs },
  nextDue: { color: guardColors.textPrimary, ...guardType.status },
  welfareTitle: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.sm, rowGap: 2 },
  welfareStatusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: spacing.md, rowGap: 2 },
  welfareStatus: { color: guardColors.textPrimary, ...guardType.status, letterSpacing: 0.4 },
  body: { color: guardColors.textPrimary, ...guardType.meta },
  welfareButton: {
    minHeight: RECORD_TILE_MIN_HEIGHT,
    borderRadius: guardShape.controlRadius,
    // White bold text on the Guard teal is 4.75:1 (≥4.5).
    backgroundColor: guardColors.teal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  welfareButtonUrgent: { backgroundColor: guardColors.emergency },
  // S4-UX-04B-S2: the card's content, stacked (as before: the card's own 8dp gap) or side by side.
  welfareStacked: { gap: spacing.sm },
  welfareSide: { flexDirection: 'row', alignItems: 'center', columnGap: WELFARE_SIDE_GAP },
  welfareInfo: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: 0, gap: spacing.xs },
  // Beside the status: sized by its one-line label, never squeezed.
  welfareButtonSide: { flexShrink: 0 },
  welfareButtonText: { color: colors.textOnBrand, ...guardType.button, textAlign: 'center' },
  tileRow: { flexDirection: 'row', flexWrap: 'wrap', gap: RECORD_TILE_GAP },
  // Off-screen-equivalent: absolutely placed (no effect on the card's size), fully transparent, sized by its words.
  wordMeasure: { position: 'absolute', top: 0, left: 0, opacity: 0, alignItems: 'flex-start' },
  wordMeasureText: { alignSelf: 'flex-start' },
  tile: {
    flexGrow: 1,
    flexShrink: 0,
    minHeight: RECORD_TILE_MIN_HEIGHT,
    borderRadius: guardShape.controlRadius,
    backgroundColor: guardColors.navy,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  tileText: { color: colors.textOnBrand, ...guardType.tile, textAlign: 'center' },
  bookOff: {
    minHeight: control.buttonHeight,
    borderRadius: guardShape.controlRadius,
    borderWidth: guardShape.outlineWidth,
    borderColor: guardColors.navy,
    backgroundColor: guardColors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  bookOffText: { color: guardColors.navy, ...guardType.button, textAlign: 'center' },
  disabled: { opacity: 0.6 },
  activityRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  activityTime: { color: colors.textSecondary, fontFamily: guardFontFamily.bold, fontSize: 13, lineHeight: 20, minWidth: 44 },
  activityText: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: 0 },
  activityTitle: { color: guardColors.textPrimary, fontFamily: guardFontFamily.bold, fontSize: 14, lineHeight: 20 },
  pressed: { opacity: 0.85 },
});
