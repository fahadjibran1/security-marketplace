import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PROFILE_TONE_COLORS, profileTokens } from './profileTheme';
import { profileDate } from './profileOverview';

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
});
