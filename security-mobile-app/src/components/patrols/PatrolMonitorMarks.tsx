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

/** The key to the hour cells: every symbol with its label. */
export function MonitorLegend() {
  return (
    <View style={markStyles.legend} accessibilityLabel="Key to the patrol cells">
      {LEGEND_STATES.map((s) => <MonitorStateMark key={s} state={s} />)}
      <Text style={markStyles.note}>“1/2”: 1 of the hour’s 2 patrols verified. {MONITOR_STATE_INFO.flagged.label} covers flagged and not-verified patrols.</Text>
    </View>
  );
}

const markStyles = {
  mark: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 2, alignSelf: 'flex-start' as const },
  symbol: { ...typography.caption, fontWeight: '700' as const },
  label: { ...typography.caption, fontWeight: '600' as const },
  legend: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: spacing.xs, alignItems: 'center' as const },
  note: { ...typography.caption, color: colors.textMuted },
};
