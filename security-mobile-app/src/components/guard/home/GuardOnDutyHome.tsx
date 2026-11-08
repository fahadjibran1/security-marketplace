import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, control, radii, spacing } from '../../../theme';
import type { GuardWelfareCard } from '../guardWelfarePresentation';

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

export function GuardWelfareSummary({ card, onRecord }: GuardWelfareSummaryProps) {
  const toneStyle = card.tone === 'danger' ? styles.toneDanger : card.tone === 'warning' ? styles.toneWarning : card.tone === 'good' ? styles.toneGood : null;
  return (
    <View style={[styles.card, card.tone === 'danger' ? styles.cardUrgent : null]} testID="guard-welfare-summary">
      {/* S4-UX-01.3b: one heading row — the name, its status word and the next due time. It wraps between those
          three at large text sizes, never inside one. */}
      <View style={styles.welfareHead}>
        <View style={styles.welfareTitle}>
          <Text style={styles.sectionLabel}>Welfare Check</Text>
          <Text style={[styles.welfareStatus, toneStyle]}>{card.label}</Text>
        </View>
        {card.nextDue ? <Text style={styles.nextDue}>{`Next due ${card.nextDue}`}</Text> : null}
      </View>
      {card.detail || card.missedSummary ? (
        <View style={styles.welfareStatusRow}>
          {card.detail ? <Text style={styles.meta}>{card.detail}</Text> : null}
          {card.missedSummary ? <Text style={[styles.body, styles.toneDanger]}>{card.missedSummary}</Text> : null}
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Record Welfare Check"
        style={({ pressed }: { pressed: boolean }) => [styles.welfareButton, card.actionUrgent ? styles.welfareButtonUrgent : null, pressed && styles.pressed]}
        onPress={onRecord}
      >
        <Text style={styles.welfareButtonText}>Record Welfare Check</Text>
      </Pressable>
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

export function GuardShiftRecords<K extends string>({ items, note, fontScale, onOpen }: GuardShiftRecordsProps<K>) {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return (
    <View style={[styles.card, styles.recordsCard]} testID="guard-shift-records">
      {/* S4-UX-01.3b: no "Shift records" heading — the tiles name themselves. The Log Book's status sits here,
          beside the Log Book tile, instead of inside the Welfare card. */}
      {note ? <Text style={styles.meta}>{note}</Text> : null}
      {/* Tiles wrap by content: each is at least RECORD_TILE_MIN_WIDTH × the text scale wide and shares the row. */}
      <View style={styles.tileRow}>
        {items.map((item) => (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityLabel={item.accessibilityLabel}
            style={({ pressed }: { pressed: boolean }) => [styles.tile, { flexBasis: RECORD_TILE_MIN_WIDTH * scale }, pressed && styles.pressed]}
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
  // White on the page's light background, no border: the same surface as the Patrol slot, which cannot carry a border
  // (it would leave a hairline when the panel renders nothing). Only an overdue Welfare Check gets an outline.
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  cardUrgent: { borderColor: colors.danger, borderWidth: 2 },
  // S4-UX-01.3b: the summary's three short lines sit closer together; the records card is a little narrower at the
  // sides so three tiles share one row on a 360dp phone.
  summaryCard: { gap: spacing.xs },
  recordsCard: { paddingHorizontal: spacing.md },
  site: { color: colors.textPrimary, fontSize: 18, lineHeight: 24, fontWeight: '800' },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.sm, rowGap: spacing.xs },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.successSurface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  livePillText: { color: colors.success, fontSize: 12, lineHeight: 16, fontWeight: '800', letterSpacing: 0.6 },
  timeRange: { color: colors.textPrimary, fontSize: 18, lineHeight: 24, fontWeight: '800' },
  dateLabel: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  meta: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  statusLine: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: colors.textPrimary },
  toneGood: { color: colors.success },
  toneWarning: { color: colors.warning },
  toneDanger: { color: colors.danger },
  sectionLabel: { color: colors.textSecondary, fontSize: 12, lineHeight: 16, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  welfareHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: spacing.sm, rowGap: spacing.xs },
  nextDue: { color: colors.textPrimary, fontSize: 14, lineHeight: 20, fontWeight: '700' },
  welfareTitle: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.sm, rowGap: 2 },
  welfareStatusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: spacing.md, rowGap: 2 },
  welfareStatus: { color: colors.textPrimary, fontSize: 15, lineHeight: 20, fontWeight: '900', letterSpacing: 0.4 },
  body: { color: colors.textPrimary, fontSize: 14, lineHeight: 20 },
  welfareButton: {
    minHeight: RECORD_TILE_MIN_HEIGHT,
    borderRadius: radii.md,
    // accentTealStrong, not accentTeal: white bold text needs ≥4.5:1 (accentTeal gives about 2.9:1).
    backgroundColor: colors.accentTealStrong,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  welfareButtonUrgent: { backgroundColor: colors.danger },
  welfareButtonText: { color: colors.textOnBrand, fontSize: 16, lineHeight: 22, fontWeight: '800', textAlign: 'center' },
  tileRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    flexGrow: 1,
    flexShrink: 0,
    minHeight: RECORD_TILE_MIN_HEIGHT,
    borderRadius: radii.md,
    backgroundColor: colors.primaryNavy,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  tileText: { color: colors.textOnBrand, fontSize: 15, lineHeight: 20, fontWeight: '800', textAlign: 'center' },
  bookOff: {
    minHeight: control.buttonHeight,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.primaryNavy,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  bookOffText: { color: colors.primaryNavy, fontSize: 16, lineHeight: 22, fontWeight: '800', textAlign: 'center' },
  disabled: { opacity: 0.6 },
  activityRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  activityTime: { color: colors.textSecondary, fontSize: 13, lineHeight: 20, fontWeight: '700', minWidth: 44 },
  activityText: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: 0 },
  activityTitle: { color: colors.textPrimary, fontSize: 14, lineHeight: 20, fontWeight: '700' },
  pressed: { opacity: 0.85 },
});
