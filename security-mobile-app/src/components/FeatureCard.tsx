import { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, control, radii, spacing, typography } from '../theme';

type FeatureCardProps = PropsWithChildren<{
  title: string;
  subtitle: string;
  ctaLabel?: string;
  onPress?: () => void;
  style?: any;
}>;

export function FeatureCard({ title, subtitle, ctaLabel, onPress, children, style }: FeatureCardProps) {
  return (
    <View style={[styles.card, style]}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
      {children}
      {ctaLabel && onPress ? (
        <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
          <Text style={styles.buttonText}>{ctaLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
    shadowColor: colors.primaryNavy,
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2,
  },
  header: { gap: spacing.xs },
  title: { color: colors.textPrimary, ...typography.heading, flexShrink: 1 },
  subtitle: { color: colors.textSecondary, ...typography.caption, flexShrink: 1 },
  button: {
    minHeight: control.minTouchTarget,
    backgroundColor: colors.primaryNavy,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  buttonPressed: { backgroundColor: colors.primaryNavySoft },
  buttonText: { color: colors.textOnBrand, ...typography.label },
});
