import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PatrolAttentionCase } from '../../types/patrols';
import { colors, radii, spacing, typography } from '../../theme';
import type { MissedTodayRow, MissedTodayView } from './patrolOperationsPresentation';
import { formatPatrolDateTime } from './patrolPresentation';

const STATE_COLOUR: Record<MissedTodayRow['state'], string> = {
  open: colors.danger,
  acknowledged: colors.warning,
  inconsistent: colors.danger,
  resolved: colors.textSecondary,
};
const STATE_MARK: Record<MissedTodayRow['state'], string> = { open: '✕', acknowledged: '✓', inconsistent: '!', resolved: '●' };

/**
 * S3 Stage 3: Live Operations' "Missed today" — every sweep-confirmed missed patrol window of today at each site, open,
 * acknowledged and resolved, each with its state in words (never colour alone). An open window opens its investigation.
 */
export function PatrolMissedTodayList({ view, unavailable, onOpenCase }: {
  view: MissedTodayView | null;
  unavailable: boolean;
  onOpenCase: (c: PatrolAttentionCase) => void;
}) {
  if (unavailable && !view) {
    return (
      <View style={styles.panel} testID="patrol-missed-today">
        <Text style={styles.title}>Missed today</Text>
        <Text style={styles.muted}>Patrol cases are unavailable right now. The figures will return on the next refresh.</Text>
      </View>
    );
  }
  if (!view) return null;
  return (
    <View style={styles.panel} testID="patrol-missed-today">
      <Text style={styles.title}>{`Missed today: ${view.total}`}</Text>
      <Text style={styles.muted}>{`${view.open} open · ${view.resolved} resolved · each site's own date. A window that starts before midnight counts on that day.`}</Text>
      {view.openWithoutCase > 0 ? (
        <Text style={styles.note}>
          {`${view.openWithoutCase} open window${view.openWithoutCase === 1 ? ' was' : 's were'} found by outage reconciliation and ${view.openWithoutCase === 1 ? 'is' : 'are'} listed under Reconciliation required.`}
        </Text>
      ) : null}
      {view.rows.length === 0 ? <Text style={styles.muted}>No patrol windows have been missed today.</Text> : null}
      {view.rows.map((row) => {
        const zone = row.state === 'resolved' ? row.resolved.site?.timeZone : row.case.site?.timeZone;
        const content = (
          <>
            <View style={styles.rowHead}>
              <Text style={[styles.mark, { color: STATE_COLOUR[row.state] }]}>{STATE_MARK[row.state]}</Text>
              <Text style={styles.rowTitle} numberOfLines={1}>{`${formatPatrolDateTime(row.windowStart, zone)} · ${row.siteName}`}</Text>
            </View>
            <Text style={styles.rowMeta} numberOfLines={1}>{row.guardName ?? 'Site-wide patrol'}</Text>
            <Text style={[styles.state, { color: STATE_COLOUR[row.state] }]}>{row.statusLabel}</Text>
          </>
        );
        return row.state === 'resolved' ? (
          <View key={row.key} style={[styles.row, styles.rowResolved]} accessibilityLabel={`Missed patrol, ${row.siteName}, ${row.statusLabel}`}>{content}</View>
        ) : (
          <Pressable key={row.key} style={styles.row} accessibilityRole="button" accessibilityLabel={`Missed patrol, ${row.siteName}, ${row.statusLabel}. Open the investigation`}
            onPress={() => onOpenCase(row.case)}>{content}</Pressable>
        );
      })}
      {view.resolvedMore ? <Text style={styles.muted}>Older resolved windows of today are not listed; the count includes them.</Text> : null}
    </View>
  );
}

const styles = {
  panel: { backgroundColor: colors.card, borderRadius: radii.card, borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: spacing.xs, marginBottom: spacing.md },
  title: { ...typography.panelHeading, color: colors.textPrimary },
  muted: { ...typography.caption, color: colors.textSecondary },
  note: { ...typography.caption, color: colors.warning, fontWeight: '600' as const },
  row: { borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: spacing.sm, gap: 2 },
  rowResolved: { opacity: 0.85 },
  rowHead: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.xs },
  mark: { fontWeight: '700' as const, width: 16 },
  rowTitle: { ...typography.body, color: colors.textPrimary, fontWeight: '600' as const, flex: 1 },
  rowMeta: { ...typography.caption, color: colors.textSecondary },
  state: { ...typography.caption, fontWeight: '700' as const },
};
