import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing } from '../theme';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'pending' | 'neutral';
export type StatusBadgeSize = 'small' | 'standard';

const palettes: Record<StatusTone, { backgroundColor: string; color: string }> = {
  success: { backgroundColor: colors.successSurface, color: colors.success  },
  warning: { backgroundColor: colors.warningSurface, color: colors.warning  },
  danger:  { backgroundColor: colors.dangerSurface,  color: colors.danger   },
  info:    { backgroundColor: colors.infoSurface,    color: colors.info     },
  pending: { backgroundColor: colors.pendingSurface, color: colors.pending  },
  neutral: { backgroundColor: colors.surfaceSubtle,  color: colors.textSecondary },
};

export function inferStatusTone(value?: string | null): StatusTone {
  const s = (value || '').trim().toLowerCase().replace(/[_-]/g, ' ');
  // Check explicit negatives before positive substring matches to prevent false positives.
  if (['unavailable', 'ineligible', 'unverified', 'unaccepted'].some((w) => s.includes(w))) return 'danger';
  if (['approved', 'active', 'complete', 'completed', 'eligible', 'verified', 'accepted', 'available', 'ready'].some((w) => s.includes(w)) && !s.includes('not ')) return 'success';
  if (['expired', 'rejected', 'failed', 'blocked', 'critical', 'missed', 'not eligible'].some((w) => s.includes(w))) return 'danger';
  if (['action required', 'returned', 'due', 'warning', 'expiring'].some((w) => s.includes(w))) return 'warning';
  if (['submitted', 'offered', 'in progress', 'live'].some((w) => s.includes(w))) return 'info';
  if (['pending', 'awaiting', 'review', 'draft', 'unverified'].some((w) => s.includes(w))) return 'pending';
  return 'neutral';
}

type StatusBadgeProps = {
  label: string;
  tone?: StatusTone;
  size?: StatusBadgeSize;
};

export function StatusBadge({ label, tone, size = 'standard' }: StatusBadgeProps) {
  const palette = palettes[tone || inferStatusTone(label)];
  return (
    <View
      accessibilityRole="text"
      style={[
        styles.badge,
        size === 'small' ? styles.badgeSmall : styles.badgeStandard,
        { backgroundColor: palette.backgroundColor },
      ]}
    >
      <Text
        style={[
          styles.label,
          size === 'small' ? styles.labelSmall : styles.labelStandard,
          { color: palette.color },
        ]}
      >
        {label.replace(/_/g, ' ')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radii.pill,
  },
  badgeStandard: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  badgeSmall: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  label: {
    textTransform: 'capitalize',
    fontWeight: '700',
  },
  labelStandard: {
    fontSize: 12,
    lineHeight: 18,
  },
  labelSmall: {
    fontSize: 11,
    lineHeight: 16,
  },
});
