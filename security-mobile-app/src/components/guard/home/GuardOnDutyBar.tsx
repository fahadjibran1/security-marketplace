import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../../../theme';
import { guardColors, guardShape } from '../../../theme/guard';
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
    backgroundColor: guardColors.surface,
    borderBottomWidth: 1,
    borderBottomColor: guardColors.cardBorder,
  },
  barStacked: { flexDirection: 'column', alignItems: 'stretch', gap: spacing.sm },
  // Grow and shrink from the content's own size (flexBasis auto), never from zero. `flex: 1` sets a zero basis, which
  // in the stacked (column) bar collapsed the status to no height and hid "On duty" and the site (S4-UX-01.2a).
  status: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
  dot: { width: STATUS_DOT, height: STATUS_DOT, borderRadius: STATUS_DOT / 2, backgroundColor: colors.success },
  statusText: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: 0 },
  onDuty: { color: colors.success, fontSize: 13, lineHeight: 18, fontWeight: '800', letterSpacing: 0.3 },
  site: { color: guardColors.textPrimary, fontSize: 15, lineHeight: 20, fontWeight: '700' },
  // Stage 1: flat Emergency red, 6dp corners, no shadow or glow.
  emergency: {
    minHeight: EMERGENCY_MIN_HEIGHT,
    minWidth: 132,
    paddingHorizontal: spacing.lg,
    borderRadius: guardShape.controlRadius,
    backgroundColor: guardColors.emergency,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emergencyStacked: { minWidth: 0, alignSelf: 'stretch' },
  emergencyText: { color: colors.textOnBrand, fontSize: 16, lineHeight: 22, fontWeight: '800', textAlign: 'center' },
  pressed: { opacity: 0.85 },
});
