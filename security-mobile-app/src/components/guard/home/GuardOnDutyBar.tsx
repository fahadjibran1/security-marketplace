import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing } from '../../../theme';
import type { GuardHomeLayout } from './guardHomeLayout';

/**
 * S4-UX-01.2 — the persistent on-duty bar.
 *
 * Rendered by the Guard dashboard OUTSIDE every scrolling area, between the header and the tab content, on every
 * Guard tab while an Emergency can be raised (see `showOnDutyBar`). It is the only Emergency launcher: pressing it
 * opens the existing Emergency form (type SOS to confirm, then one online request), unchanged. Nothing is sent from
 * here.
 */
export interface GuardOnDutyBarProps {
  siteName: string | null;
  emergencyLabel: string;
  emergencyAccessibilityLabel: string;
  layout: Pick<GuardHomeLayout, 'onDutyBarStacks'>;
  onEmergency: () => void;
}

/** Emergency is larger than the 44pt minimum: it is the one control that must never be missed. */
export const EMERGENCY_MIN_HEIGHT = 48;
/** The decorative live dot is the only fixed-size element; it holds no text. */
const STATUS_DOT = 10;

export function GuardOnDutyBar({ siteName, emergencyLabel, emergencyAccessibilityLabel, layout, onEmergency }: GuardOnDutyBarProps) {
  const stacked = layout.onDutyBarStacks;
  return (
    <View style={[styles.bar, stacked && styles.barStacked]} testID="guard-on-duty-bar">
      <View style={styles.status} accessible accessibilityLabel={siteName ? `On duty at ${siteName}` : 'On duty'}>
        <View style={styles.dot} />
        <View style={styles.statusText}>
          <Text style={styles.onDuty}>On duty</Text>
          {siteName ? <Text style={styles.site}>{siteName}</Text> : null}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={emergencyAccessibilityLabel}
        accessibilityHint="Opens the Emergency form. Sending it needs a connection."
        onPress={onEmergency}
        style={({ pressed }: { pressed: boolean }) => [styles.emergency, stacked && styles.emergencyStacked, pressed && styles.pressed]}
      >
        <Text style={styles.emergencyText}>{emergencyLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  barStacked: { flexDirection: 'column', alignItems: 'stretch', gap: spacing.sm },
  status: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
  dot: { width: STATUS_DOT, height: STATUS_DOT, borderRadius: STATUS_DOT / 2, backgroundColor: colors.success },
  statusText: { flex: 1, minWidth: 0 },
  onDuty: { color: colors.success, fontSize: 13, lineHeight: 18, fontWeight: '800', letterSpacing: 0.3 },
  site: { color: colors.textPrimary, fontSize: 15, lineHeight: 20, fontWeight: '700' },
  emergency: {
    minHeight: EMERGENCY_MIN_HEIGHT,
    minWidth: 132,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emergencyStacked: { minWidth: 0, alignSelf: 'stretch' },
  emergencyText: { color: colors.textOnBrand, fontSize: 16, lineHeight: 22, fontWeight: '800', textAlign: 'center' },
  pressed: { opacity: 0.85 },
});
