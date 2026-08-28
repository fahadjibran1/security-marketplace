import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, control, radii, spacing, typography } from '../theme';

type StateTone = 'empty' | 'error' | 'success' | 'info';

type Props = {
  title: string;
  message?: string;
  tone?: StateTone;
  loading?: boolean;
  actionLabel?: string;
  onAction?: () => void;
};

const backgrounds: Record<StateTone, string> = {
  empty: colors.background,
  error: colors.dangerSurface,
  success: colors.successSurface,
  info: colors.infoSurface,
};

export function StatePanel({ title, message, tone = 'empty', loading, actionLabel, onAction }: Props) {
  return (
    <View style={[styles.panel, { backgroundColor: backgrounds[tone] }]}>
      {loading ? <ActivityIndicator color={colors.accentTealStrong} /> : null}
      <View style={styles.copy}>
        <Text style={styles.title}>{title}</Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>
      {actionLabel && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} style={({ pressed }: { pressed: boolean }) => [styles.action, pressed && styles.pressed]}>
          <Text style={styles.actionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.md, alignItems: 'flex-start' },
  copy: { gap: spacing.xs },
  title: { color: colors.textPrimary, ...typography.bodyStrong },
  message: { color: colors.textSecondary, ...typography.caption },
  action: { minHeight: control.minTouchTarget, justifyContent: 'center', borderRadius: radii.md, backgroundColor: colors.primaryNavy, paddingHorizontal: spacing.lg },
  actionText: { color: colors.textOnBrand, ...typography.label },
  pressed: { opacity: 0.84 },
});
