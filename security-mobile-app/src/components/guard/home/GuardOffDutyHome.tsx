import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, control, radii, spacing } from '../../../theme';

/**
 * S4-UX-01.4 — the Off Duty Home, presentation only.
 *
 * The Guard dashboard owns every value and every handler and passes them in. Which shift is shown (the screen's
 * currentHomeShift: the next accepted shift, else an offer, else the last finished shift), its phase, its action
 * label and the action itself (Book On with its early-attendance confirmation, Review Offer, View summary) are all
 * the screen's existing decisions; nothing here re-decides them. The screen lays these out as:
 *
 *   GuardShiftCard (or GuardNoShift) → [the existing Patrol panel, in its own stable slot]
 *   → GuardUpcomingShifts → GuardRecentActivity (finished shifts only)
 *
 * No text here has a fixed width or a line limit: everything wraps at word boundaries at any text scale.
 */

export type GuardShiftCardKind = 'next' | 'offer' | 'last';

const EYEBROW: Record<GuardShiftCardKind, string> = {
  next: 'Next shift',
  offer: 'Shift offer',
  last: 'Last shift',
};

export interface GuardShiftCardAction {
  label: string;
  busy: boolean;
  busyLabel: string;
  disabled: boolean;
  /** 'primary' for the step the Guard takes next (Book On, Review Offer); 'secondary' for a look back. */
  emphasis: 'primary' | 'secondary';
  onPress: () => void;
}

export interface GuardShiftCardProps {
  kind: GuardShiftCardKind;
  siteName: string;
  dateLabel: string;
  timeRange: string;
  /** A phase line worth reading, or null when it would only repeat the date and time above it. */
  statusLine: string | null;
  statusTone: 'warning' | 'danger' | null;
  action: GuardShiftCardAction | null;
  /** Short rule text under the action (the early Book On rule), or null. */
  note: string | null;
  /** The shift's instructions exactly as the API sent them; the control only appears when there are some. */
  instructions: string | null | undefined;
}

export function GuardShiftCard({ kind, siteName, dateLabel, timeRange, statusLine, statusTone, action, note, instructions }: GuardShiftCardProps) {
  const [showInstructions, setShowInstructions] = useState(false);
  const instructionText = typeof instructions === 'string' ? instructions.trim() : '';
  return (
    <View style={styles.card} testID="guard-shift-card">
      <Text style={styles.sectionLabel}>{EYEBROW[kind]}</Text>
      <Text style={styles.site} accessibilityRole="header">{siteName}</Text>
      <View style={styles.whenRow}>
        <Text style={styles.timeRange}>{timeRange}</Text>
        <Text style={styles.dateLabel}>{dateLabel}</Text>
      </View>
      {statusLine ? (
        <Text style={[styles.statusLine, statusTone === 'danger' ? styles.toneDanger : statusTone === 'warning' ? styles.toneWarning : null]}>
          {statusLine}
        </Text>
      ) : null}
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          accessibilityState={{ disabled: action.disabled, busy: action.busy }}
          disabled={action.disabled}
          onPress={action.onPress}
          style={({ pressed }: { pressed: boolean }) => [
            action.emphasis === 'primary' ? styles.primaryButton : styles.secondaryButton,
            action.disabled && styles.disabled,
            pressed && styles.pressed,
          ]}
          testID="guard-shift-card-action"
        >
          <Text style={action.emphasis === 'primary' ? styles.primaryButtonText : styles.secondaryButtonText}>
            {action.busy ? action.busyLabel : action.label}
          </Text>
        </Pressable>
      ) : null}
      {note ? <Text style={styles.meta}>{note}</Text> : null}
      {instructionText ? (
        <View style={styles.instructions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showInstructions ? 'Hide shift instructions' : 'Show shift instructions'}
            accessibilityState={{ expanded: showInstructions }}
            onPress={() => setShowInstructions((open) => !open)}
            style={({ pressed }: { pressed: boolean }) => [styles.instructionsToggle, pressed && styles.pressed]}
            testID="guard-shift-instructions-toggle"
          >
            <Text style={styles.instructionsToggleText}>Shift instructions</Text>
            <Text style={styles.instructionsToggleHint}>{showInstructions ? 'Hide' : 'Show'}</Text>
          </Pressable>
          {showInstructions ? (
            <Text style={styles.body} testID="guard-shift-instructions">{instructionText}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export interface GuardNoShiftProps {
  onOffers: () => void;
  onHistory: () => void;
  onJobs: () => void;
}

/** Between shifts: one line and the three places a Guard goes from here (the same tabs as before). */
export function GuardNoShift({ onOffers, onHistory, onJobs }: GuardNoShiftProps) {
  const links: Array<{ label: string; onPress: () => void }> = [
    { label: 'Review shift offers', onPress: onOffers },
    { label: 'Past shifts & timesheets', onPress: onHistory },
    { label: 'Browse jobs', onPress: onJobs },
  ];
  return (
    <View style={styles.card} testID="guard-no-shift">
      <Text style={styles.site} accessibilityRole="header">No shifts booked</Text>
      <View style={styles.linkRow}>
        {links.map((link) => (
          <Pressable
            key={link.label}
            accessibilityRole="button"
            accessibilityLabel={link.label}
            onPress={link.onPress}
            style={({ pressed }: { pressed: boolean }) => [styles.link, pressed && styles.pressed]}
          >
            <Text style={styles.linkText}>{link.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export interface GuardUpcomingShiftsProps {
  /** Accepted shifts after the one the shift card shows, soonest first; the screen never passes that one. */
  shifts: Array<{ id: number; siteName: string; dateLabel: string; timeRange: string }>;
}

export const UPCOMING_SHIFTS_LIMIT = 3;

export function GuardUpcomingShifts({ shifts }: GuardUpcomingShiftsProps) {
  const shown = shifts.slice(0, UPCOMING_SHIFTS_LIMIT);
  if (shown.length === 0) return null;
  return (
    <View style={styles.card} testID="guard-upcoming-shifts">
      <Text style={styles.sectionLabel}>Upcoming</Text>
      {shown.map((shift, index) => (
        <View
          key={shift.id}
          style={[styles.upcomingRow, index > 0 && styles.upcomingDivider]}
          accessible
          accessibilityLabel={`${shift.dateLabel}, ${shift.timeRange}, ${shift.siteName}`}
        >
          <Text style={styles.upcomingDate}>{shift.dateLabel}</Text>
          <Text style={styles.meta}>{`${shift.timeRange} · ${shift.siteName}`}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // The same surface as the On Duty Home cards (GuardOnDutyHome): white, no border, 16 radius.
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  sectionLabel: { color: colors.textSecondary, fontSize: 12, lineHeight: 16, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  site: { color: colors.textPrimary, fontSize: 18, lineHeight: 24, fontWeight: '800' },
  whenRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: spacing.sm, rowGap: 2 },
  timeRange: { color: colors.textPrimary, fontSize: 18, lineHeight: 24, fontWeight: '800' },
  dateLabel: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  statusLine: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: colors.textPrimary },
  toneWarning: { color: colors.warning },
  toneDanger: { color: colors.danger },
  meta: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  body: { color: colors.textPrimary, fontSize: 15, lineHeight: 22 },
  primaryButton: {
    minHeight: control.buttonHeight,
    borderRadius: radii.md,
    // accentTealStrong, as the On Duty Home's Welfare action: white bold text needs ≥4.5:1.
    backgroundColor: colors.accentTealStrong,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  primaryButtonText: { color: colors.textOnBrand, fontSize: 16, lineHeight: 22, fontWeight: '800', textAlign: 'center' },
  secondaryButton: {
    minHeight: control.minTouchTarget,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.primaryNavy,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  secondaryButtonText: { color: colors.primaryNavy, fontSize: 15, lineHeight: 20, fontWeight: '800', textAlign: 'center' },
  disabled: { opacity: 0.6 },
  pressed: { opacity: 0.85 },
  instructions: { gap: spacing.xs, borderTopWidth: 1, borderTopColor: colors.border },
  instructionsToggle: {
    minHeight: control.minTouchTarget,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: spacing.sm,
  },
  instructionsToggleText: { color: colors.textPrimary, fontSize: 15, lineHeight: 20, fontWeight: '700' },
  instructionsToggleHint: { color: colors.accentTealStrong, fontSize: 14, lineHeight: 20, fontWeight: '800' },
  linkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  link: {
    flexGrow: 1,
    minHeight: control.minTouchTarget,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  linkText: { color: colors.primaryNavy, fontSize: 14, lineHeight: 20, fontWeight: '700', textAlign: 'center' },
  upcomingRow: { paddingVertical: spacing.xs, gap: 2 },
  upcomingDivider: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  upcomingDate: { color: colors.textPrimary, fontSize: 15, lineHeight: 20, fontWeight: '700' },
});
