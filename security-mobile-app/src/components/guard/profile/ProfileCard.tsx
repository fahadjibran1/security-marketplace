import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PROFILE_TONE_COLORS, profileTokens } from './profileTheme';
import { profileDate } from './profileOverview';
import { summaryLineText, type SummaryLine } from './profileEmployment';

export { profileDate };

/**
 * S4 Guard Profile — the shared building blocks every section uses (Profile Phase 2D).
 *
 * One card style for all seven sections, matching the overview and the Guard Home: flat, 1px border, 8dp radius,
 * sentence-case title, no shadow. Before 2D the moved cards kept the older FeatureCard look (22dp radius, shadow,
 * title-case headings) and every read-only value was a stacked label/value pair. Presentation only: no data, no
 * calls, no decisions live here.
 */
export function ProfileCard({ title, subtitle, children, testID }: { title?: string; subtitle?: string; children?: ReactNode; testID?: string }) {
  return (
    <View style={styles.card} testID={testID}>
      {title || subtitle ? (
        <View style={styles.header}>
          {title ? <Text style={styles.title} accessibilityRole="header">{title}</Text> : null}
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/**
 * A read-only label and value. Side by side on a standard phone; label above value when the layout is compact
 * (narrow screen or large text), so neither column is ever squeezed into a tall ragged block.
 */
export function ProfileField({ label, value, stacked, testID }: { label: string; value: string; stacked: boolean; testID?: string }) {
  return (
    <View style={stacked ? styles.fieldStacked : styles.fieldRow} accessible accessibilityLabel={`${label}: ${value}`} testID={testID}>
      <Text style={[styles.fieldLabel, !stacked && styles.fieldLabelColumn]}>{label}</Text>
      <Text style={[styles.fieldValue, !stacked && styles.fieldValueColumn]}>{value}</Text>
    </View>
  );
}

/** A group of fields for one record (one company's employment, one payment arrangement), divided from the next. */
// `key` is listed only because this project's React type shim does not add it to component props.
export function ProfileFieldGroup({ children, first, testID }: { children: ReactNode; first: boolean; testID?: string; key?: string | number }) {
  return <View style={[styles.group, !first && styles.groupDivider]} testID={testID}>{children}</View>;
}

/** A privacy or explanatory note: always visible (transparency), plain caption type rather than italics. */
export function ProfileNote({ children, testID, tone = 'secondary' }: { children: ReactNode; testID?: string; tone?: 'secondary' | 'warning' }) {
  return <Text style={[styles.note, tone === 'warning' && styles.noteWarning]} testID={testID}>{children}</Text>;
}

/** Minimum height of every Profile button (UX-02 Package B): the Android 48dp target, without relying on hit slop. */
export const PROFILE_BUTTON_MIN_HEIGHT = 48;

type ProfileButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  /**
   * Spoken name when it differs from the visible label (for example "Save emergency contact" for "Save"). Named
   * spokenLabel / nativeTestID rather than accessibilityLabel / testID so they exist only on the Pressable that
   * receives them, which is what screen readers, UI tests and the specs look for.
   */
  spokenLabel?: string;
  nativeTestID?: string;
};

/**
 * The one primary action style for every Profile section (UX-02 Package B; replaces the navy shadowed Save, the
 * half-width teal Save and the title-case Join button): Guard teal fill, white text, full width, at least 48dp, no shadow.
 */
export function ProfilePrimaryButton({ label, onPress, disabled = false, busy = false, spokenLabel, nativeTestID }: ProfileButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={spokenLabel ?? label}
      accessibilityState={{ disabled, busy }}
      testID={nativeTestID}
      style={[styles.primary, disabled && styles.disabled]}
    >
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

/**
 * A secondary or inline action (Show, Edit, Cancel, Remove): outlined, at least 48dp tall, as wide as its label and
 * wrapping to the next line at large text rather than breaking a word. `tone="danger"` is kept for actions that remove data.
 */
export function ProfileSecondaryButton({ label, onPress, disabled = false, busy = false, spokenLabel, nativeTestID, tone = 'neutral' }: ProfileButtonProps & { tone?: 'neutral' | 'danger' }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={spokenLabel ?? label}
      accessibilityState={{ disabled, busy }}
      testID={nativeTestID}
      style={[styles.secondary, tone === 'danger' && styles.secondaryDanger, disabled && styles.disabled]}
    >
      <Text style={[styles.secondaryText, tone === 'danger' && styles.secondaryDangerText]}>{label}</Text>
    </Pressable>
  );
}

/** A row of inline actions that wraps at large text instead of squeezing its buttons below 48dp. */
export function ProfileActionRow({ children, testID }: { children: ReactNode; testID?: string }) {
  return <View style={styles.actionRow} testID={testID}>{children}</View>;
}

/** A plain row divided from what is above it by a hairline (UX-02 Package B: replaces boxed sub-cards inside a card). */
export function ProfileDividedRow({ children, testID }: { children: ReactNode; testID?: string; key?: string | number }) {
  return <View style={styles.dividedRow} testID={testID}>{children}</View>;
}

/**
 * A compact read-only summary of one record (a company's employment or pay arrangement): the name, then one or two
 * lines of "a · b · c" facts. Spoken as one item. Never used for a sensitive value (bank, NINO, UTR, licence number).
 */
export function ProfileSummaryRow({ title, lines, first, testID }: { title: string; lines: SummaryLine[]; first: boolean; testID?: string; key?: string | number }) {
  const shown = lines.filter((line) => line.parts.length > 0);
  return (
    <View style={[styles.summaryRow, !first && styles.groupDivider]} accessible accessibilityLabel={[title, ...shown.map(summaryLineText)].join('. ')} testID={testID}>
      <Text style={styles.summaryTitle}>{title}</Text>
      {shown.map((line) => (
        // Each fact is its own text run (wrapping between facts, never inside a word), separated by " · ".
        <Text key={summaryLineText(line)} style={styles.summaryLine}>
          {line.lead ? <Text>{`${line.lead} `}</Text> : null}
          {line.parts.map((part, i) => (
            <Text key={`${i}-${part}`}>{i > 0 ? <Text>{' · '}</Text> : null}<Text>{part}</Text></Text>
          ))}
        </Text>
      ))}
    </View>
  );
}

const t = profileTokens;
const styles = StyleSheet.create({
  card: {
    backgroundColor: t.colors.surface,
    borderColor: t.colors.border,
    borderWidth: t.shape.cardBorderWidth,
    borderRadius: t.shape.cardRadius,
    padding: 12,
    gap: 10,
    width: '100%',
  },
  header: { gap: 2 },
  title: { ...t.type.button, color: t.colors.textPrimary },
  subtitle: { ...t.type.body, color: t.colors.textSecondary },
  fieldRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 2 },
  fieldStacked: { gap: 0, paddingVertical: 2 },
  fieldLabel: { ...t.type.body, color: t.colors.textSecondary },
  fieldLabelColumn: { flexBasis: '42%', flexShrink: 0, flexGrow: 0 },
  fieldValue: { ...t.type.value, color: t.colors.textPrimary },
  fieldValueColumn: { flex: 1, minWidth: 0 },
  group: { gap: 2 },
  groupDivider: { borderTopWidth: 1, borderTopColor: t.colors.border, paddingTop: 8 },
  note: { fontSize: 13, lineHeight: 18, color: t.colors.textSecondary },
  noteWarning: { color: PROFILE_TONE_COLORS.warning.text },
  primary: {
    alignSelf: 'stretch',
    minHeight: PROFILE_BUTTON_MIN_HEIGHT,
    borderRadius: t.shape.controlRadius,
    backgroundColor: t.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  primaryText: { ...t.type.button, color: t.colors.onAccent, textAlign: 'center' },
  secondary: {
    minHeight: PROFILE_BUTTON_MIN_HEIGHT,
    minWidth: PROFILE_BUTTON_MIN_HEIGHT,
    flexGrow: 1,
    flexShrink: 0,
    flexBasis: 'auto',
    maxWidth: '100%',
    borderRadius: t.shape.controlRadius,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  secondaryText: { ...t.type.button, color: t.colors.textPrimary, textAlign: 'center' },
  secondaryDanger: { borderColor: t.colors.danger },
  secondaryDangerText: { color: t.colors.danger },
  disabled: { opacity: 0.45 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dividedRow: { borderTopWidth: 1, borderTopColor: t.colors.border, paddingTop: 10, gap: 4 },
  summaryRow: { gap: 2 },
  summaryTitle: { ...t.type.value, fontFamily: t.type.button.fontFamily, color: t.colors.textPrimary },
  summaryLine: { ...t.type.body, color: t.colors.textSecondary },
});
