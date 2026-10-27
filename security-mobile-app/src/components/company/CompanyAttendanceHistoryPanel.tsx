import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AttendanceEventView, AttendanceHistory } from '../../types/models';
import { attendanceHistoryRows, manualAttendanceErrorGuidance, type AttendanceBadge } from './manualAttendance';
import { colors, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;

const BADGE_TONE: Record<AttendanceBadge, { fg: string; bg: string }> = {
  'Guard app': { fg: colors.textSecondary, bg: colors.surfaceSubtle },
  Manual: { fg: colors.warning, bg: colors.warningSurface },
  Correction: { fg: colors.warning, bg: colors.warningSurface },
  Corrected: { fg: colors.warning, bg: colors.warningSurface },
  Superseded: { fg: colors.textMuted, bg: colors.surfaceSubtle },
  Effective: { fg: colors.success, bg: colors.successSurface },
};

/**
 * Attendance history (S4 Part B): every Book On / Book Off entry of the shift, oldest first, including the originals a
 * correction superseded — nothing is ever hidden or rewritten. Each entry says whether the Guard recorded it in the app
 * or staff recorded it manually (who, how it was verified, why). Only the effective entry of each type offers
 * "Correct time", and only to staff who may manage attendance on a backend that supports it.
 *
 * Reads only: the one request here is `loadHistory` (GET /attendance/shifts/:id/history, injected by the dashboard so
 * this component and the Live Operations workspace stay free of the API module). Corrections go through the confirmed
 * form.
 */
export function CompanyAttendanceHistoryPanel({
  shiftId,
  timeZone,
  refreshSignal,
  loadHistory,
  onCorrect,
}: {
  shiftId: number;
  /** GET /attendance/shifts/:id/history. */
  loadHistory: (shiftId: number) => Promise<AttendanceHistory>;
  timeZone: string;
  /** Changes after any attendance change, so the panel re-reads. */
  refreshSignal: number;
  /** Present only when the user may correct attendance and the backend supports it. */
  onCorrect?: (event: AttendanceEventView, history: AttendanceHistory) => void;
}) {
  const [history, setHistory] = React.useState<AttendanceHistory | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    loadHistory(shiftId)
      .then((result) => { if (!cancelled) setHistory(result); })
      .catch((error) => { if (!cancelled) setLoadError(manualAttendanceErrorGuidance(error).message); });
    return () => { cancelled = true; };
  }, [shiftId, refreshSignal, loadHistory]);

  const rows = attendanceHistoryRows(history, timeZone);

  return (
    <View style={styles.card} accessibilityLabel="Attendance history">
      <Text style={styles.title}>Attendance history</Text>
      {loadError ? <Text style={styles.problem}>{loadError}</Text> : null}
      {!history && !loadError ? <Text style={styles.muted}>Loading attendance history…</Text> : null}
      {history && rows.length === 0 ? <Text style={styles.muted}>No Book On or Book Off has been recorded for this shift.</Text> : null}
      {rows.map((row) => (
        <View key={row.id} style={[styles.row, row.badges.includes('Superseded') ? styles.rowSuperseded : null]}>
          <View style={styles.rowHead}>
            <Text style={styles.rowTitle}>{row.title} · {row.time}</Text>
            <View style={styles.badges}>
              {row.badges.map((badge) => (
                <Text key={badge} style={[styles.badge, { color: BADGE_TONE[badge].fg, backgroundColor: BADGE_TONE[badge].bg }]}>{badge}</Text>
              ))}
            </View>
          </View>
          {row.detail.map((line, index) => <Text key={index} style={styles.detail}>{line}</Text>)}
          {onCorrect && history && row.correctable ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Correct ${row.type === 'check-in' ? 'Book On' : 'Book Off'} time`}
              style={[styles.correctBtn, IS_WEB ? (WEB_PTR as any) : null]}
              onPress={() => onCorrect(row.event, history)}
            >
              <Text style={styles.correctBtnText}>Correct time</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: colors.card,
    padding: spacing.md, gap: spacing.xs,
  },
  title: { fontSize: 13, fontWeight: '800', color: colors.primaryNavyStrong },
  muted: { fontSize: 12, color: colors.textSecondary },
  problem: { fontSize: 12, color: colors.danger, fontWeight: '700' },
  row: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.xs, gap: 2 },
  rowSuperseded: { opacity: 0.75 },
  rowHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs, justifyContent: 'space-between' },
  rowTitle: { fontSize: 12, fontWeight: '700', color: colors.textPrimary },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  badge: { fontSize: 10, fontWeight: '800', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radii.sm, overflow: 'hidden' },
  detail: { fontSize: 11, color: colors.textSecondary, lineHeight: 16 },
  correctBtn: {
    alignSelf: 'flex-start', marginTop: 2, paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: radii.sm,
    borderWidth: 1, borderColor: colors.fieldBorder,
  },
  correctBtnText: { fontSize: 12, fontWeight: '700', color: colors.primaryNavy },
});
