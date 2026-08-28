import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../theme';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'pending' | 'neutral';

const palettes: Record<StatusTone, { backgroundColor: string; color: string }> = {
  success: { backgroundColor: colors.successSurface, color: colors.success },
  warning: { backgroundColor: colors.warningSurface, color: colors.warning },
  danger: { backgroundColor: colors.dangerSurface, color: colors.danger },
  info: { backgroundColor: colors.infoSurface, color: colors.info },
  pending: { backgroundColor: colors.pendingSurface, color: colors.pending },
  neutral: { backgroundColor: colors.surfaceSubtle, color: colors.textSecondary },
};

export function inferStatusTone(value?: string | null): StatusTone {
  const status = (value || '').trim().toLowerCase().replace(/[_-]/g, ' ');
  // Check explicit negatives before positive substring matches to prevent false positives
  // e.g. 'unavailable' contains 'available', 'ineligible' contains 'eligible'
  if (['unavailable', 'ineligible', 'unverified', 'unaccepted'].some((word) => status.includes(word))) return 'danger';
  if (['approved', 'active', 'complete', 'completed', 'eligible', 'verified', 'accepted', 'available', 'ready'].some((word) => status.includes(word)) && !status.includes('not ')) return 'success';
  if (['expired', 'rejected', 'failed', 'blocked', 'critical', 'missed', 'not eligible'].some((word) => status.includes(word))) return 'danger';
  if (['action required', 'returned', 'due', 'warning', 'expiring'].some((word) => status.includes(word))) return 'warning';
  if (['submitted', 'offered', 'in progress', 'live'].some((word) => status.includes(word))) return 'info';
  if (['pending', 'awaiting', 'review', 'draft', 'unverified'].some((word) => status.includes(word))) return 'pending';
  return 'neutral';
}

export function StatusBadge({ label, tone }: { label: string; tone?: StatusTone }) {
  const palette = palettes[tone || inferStatusTone(label)];
  return (
    <View accessibilityRole="text" style={[styles.badge, { backgroundColor: palette.backgroundColor }]}>
      <Text style={[styles.label, { color: palette.color }]}>{label.replace(/_/g, ' ')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignSelf: 'flex-start', borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  label: { ...typography.caption, fontWeight: '700', textTransform: 'capitalize' },
});
