import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppRole } from '../types/models';
import { brand, colors, control, radii, spacing, typography } from '../theme';

interface RoleSelectionScreenProps {
  onSelectRole: (role: AppRole) => void;
}

export function RoleSelectionScreen({ onSelectRole }: RoleSelectionScreenProps) {
  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.kicker}>{brand.shortBrand}</Text>
        <Text style={styles.title}>Choose your workspace</Text>
        <Text style={styles.subtitle}>Continue to the S4 experience that matches your role.</Text>

        <Pressable style={({ pressed }) => [styles.option, styles.guardOption, pressed && styles.pressed]} onPress={() => onSelectRole('guard')}>
          <View style={styles.optionCopy}>
            <Text style={styles.guardTitle}>S4 Guard</Text>
            <Text style={styles.guardText}>Shifts, jobs, compliance and your work activity.</Text>
          </View>
          <Text style={styles.guardArrow}>→</Text>
        </Pressable>

        <Pressable style={({ pressed }) => [styles.option, pressed && styles.pressed]} onPress={() => onSelectRole('company')}>
          <View style={styles.optionCopy}>
            <Text style={styles.optionTitle}>S4 Company</Text>
            <Text style={styles.optionText}>Workforce, sites, operations and compliance.</Text>
          </View>
          <Text style={styles.arrow}>→</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
  card: { width: '100%', maxWidth: 560, alignSelf: 'center', backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl, borderWidth: 1, borderColor: colors.border, gap: spacing.md },
  kicker: { color: colors.accentTealStrong, fontSize: 22, fontWeight: '800', letterSpacing: 1 },
  title: { color: colors.textPrimary, ...typography.title },
  subtitle: { color: colors.textSecondary, ...typography.body, marginBottom: spacing.md },
  option: { minHeight: 88, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: spacing.lg, gap: spacing.md },
  guardOption: { backgroundColor: colors.primaryNavy, borderColor: colors.primaryNavy },
  optionCopy: { flex: 1, gap: spacing.xs },
  optionTitle: { color: colors.textPrimary, ...typography.heading },
  optionText: { color: colors.textSecondary, ...typography.caption },
  guardTitle: { color: colors.textOnBrand, ...typography.heading },
  guardText: { color: '#D6E2EC', ...typography.caption },
  arrow: { color: colors.accentTealStrong, fontSize: 24, minWidth: control.minTouchTarget, textAlign: 'center' },
  guardArrow: { color: colors.accentTeal, fontSize: 24, minWidth: control.minTouchTarget, textAlign: 'center' },
  pressed: { opacity: 0.84 },
});
