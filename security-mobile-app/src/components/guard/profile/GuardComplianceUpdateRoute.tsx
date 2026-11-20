import { Pressable, StyleSheet, Text, View } from 'react-native';
import { COMPLIANCE_COPY } from './profileCopy';
import { profileTokens } from './profileTheme';

/**
 * S4 Guard Profile — how a Guard updates their SIA licence or right to work (Profile Phase 2C).
 *
 * The backend's only Guard-side write for those fields is the optional S4 screening file (PUT /screening/mine/
 * compliance); PATCH /guards/me does not accept them. So the action is shown for exactly what it is — an update in
 * the optional screening file — and is never presented as a plain compliance action. No endpoint is invented.
 */
export function GuardComplianceUpdateRoute({ onOpenScreening }: { onOpenScreening: () => void }) {
  return (
    <View style={styles.card} testID="guard-compliance-update-route">
      <Text style={styles.title}>{COMPLIANCE_COPY.updateTitle}</Text>
      <Text style={styles.body}>{COMPLIANCE_COPY.updateBody}</Text>
      <Text style={styles.body}>{COMPLIANCE_COPY.updateUnderReview}</Text>
      <Text style={styles.body}>{COMPLIANCE_COPY.companyChecks}</Text>
      <Pressable
        onPress={onOpenScreening}
        style={({ pressed }: { pressed: boolean }) => [styles.button, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={COMPLIANCE_COPY.updateActionAccessibilityLabel}
        testID="guard-compliance-update-in-screening"
      >
        <Text style={styles.buttonText}>{COMPLIANCE_COPY.updateAction}</Text>
      </Pressable>
    </View>
  );
}

const t = profileTokens;
const styles = StyleSheet.create({
  card: {
    gap: 8,
    padding: t.spacing.sectionPadding,
    borderRadius: t.shape.cardRadius,
    borderWidth: t.shape.cardBorderWidth,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  title: { ...t.type.value, fontFamily: t.type.button.fontFamily, color: t.colors.textPrimary },
  body: { ...t.type.body, color: t.colors.textSecondary },
  button: {
    minHeight: 48,
    marginTop: 4,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: t.shape.controlRadius,
    borderWidth: 1.5,
    borderColor: t.colors.accent,
  },
  buttonText: { ...t.type.button, color: t.colors.accent },
  pressed: { opacity: 0.7 },
});
