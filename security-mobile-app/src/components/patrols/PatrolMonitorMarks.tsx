import * as React from 'react';
import { Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';
import { MONITOR_STATE_INFO, monitorStateInfo, type MonitorTone } from './patrolMonitorPresentation';

/** The status palette (the S4 theme's semantic colours) for a Monitor tone; blank draws nothing but a hairline. */
export function monitorPalette(tone: MonitorTone): { bg: string; border: string; fg: string } {
  switch (tone) {
    case 'success': return { bg: colors.successSurface, border: colors.successBorder, fg: colors.success };
    case 'warning': return { bg: colors.warningSurface, border: colors.warningBorder, fg: colors.warning };
    case 'danger': return { bg: colors.dangerSurface, border: colors.dangerBorder, fg: colors.danger };
    case 'info': return { bg: colors.infoSurface, border: colors.infoBorder, fg: colors.info };
    case 'pending':
    case 'neutral': return { bg: colors.pendingSurface, border: colors.pendingBorder, fg: colors.pending };
    default: return { bg: colors.card, border: colors.surfaceSubtle, fg: colors.textMuted };
  }
}

/** A state as symbol + text label on its colour: never colour alone. */
export function MonitorStateMark({ state, compact }: { state: string; compact?: boolean; key?: string }) {
  const info = monitorStateInfo(state);
  const p = monitorPalette(info.tone);
  return (
    <View style={[markStyles.mark, { backgroundColor: p.bg, borderColor: p.border }]} accessibilityLabel={info.label}>
      {info.symbol ? <Text style={[markStyles.symbol, { color: p.fg }]}>{info.symbol}</Text> : null}
      {compact ? null : <Text style={[markStyles.label, { color: p.fg }]}>{info.label}</Text>}
    </View>
  );
}

const LEGEND_STATES = ['verified', 'late_verified', 'awaiting_verification', 'incomplete', 'flagged', 'overdue', 'awaiting_check', 'missed', 'in_progress', 'due', 'future', 'not_on_duty'] as const;

/** The Status guide: every symbol, its label and what it means, compactly; with how the counts read. */
export function MonitorLegend() {
  return (
    <View style={markStyles.guide} accessibilityLabel="Key to the patrol cells" testID="patrol-monitor-status-guide">
      {LEGEND_STATES.map((s) => (
        <View key={s} style={markStyles.guideRow}>
          <MonitorStateMark state={s} />
          <Text style={markStyles.guideText}>{MONITOR_STATE_INFO[s].description}</Text>
        </View>
      ))}
      <View style={markStyles.guideRow}>
        <View style={markStyles.extraMark}><Text style={markStyles.extraText}>◇ Additional</Text></View>
        <Text style={markStyles.guideText}>A patrol not linked to a scheduled window: shown, never counted.</Text>
      </View>
      <Text style={markStyles.note}>“0/1 +1”: none of the 1 patrol due so far verified, 1 more later. {MONITOR_STATE_INFO.flagged.label} covers flagged and not-verified patrols.</Text>
    </View>
  );
}

const markStyles = {
  mark: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 2, alignSelf: 'flex-start' as const },
  symbol: { ...typography.caption, fontWeight: '700' as const },
  label: { ...typography.caption, fontWeight: '600' as const },
  guide: { gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, padding: spacing.sm, backgroundColor: colors.card },
  guideRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm, flexWrap: 'wrap' as const },
  guideText: { ...typography.caption, color: colors.textSecondary, flexShrink: 1, minWidth: 160 },
  extraMark: { borderWidth: 1, borderStyle: 'dashed' as const, borderColor: colors.infoBorder, backgroundColor: colors.infoSurface, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  extraText: { ...typography.caption, fontWeight: '600' as const, color: colors.info },
  note: { ...typography.caption, color: colors.textMuted },
};
