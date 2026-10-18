import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Drawer } from '../ui/Drawer';
import { NativeDateInput } from './NativeDateInput';
import { colors, radii, spacing } from '../../theme';
import {
  REPORT_MAX_DAYS,
  REPORT_TITLE,
  reportRange,
  ukDay,
  type ReportKind,
  type ReportPeriod,
} from './operationsExports';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = { cursor: 'pointer' };

export type ReportRequest = {
  kind: ReportKind;
  from: string;
  to: string;
  siteId: number | null;
  format: 'csv' | 'xlsx';
};

/**
 * Shift Attendance and Welfare Monitoring reports (S4 Welfare Phase 3).
 *
 * The controller picks a report, a period and a format; the report itself is built by the backend from
 * S4's records — not from the rows this screen happens to show — and downloaded as a file. Feedback is
 * always explicit: preparing, the file that was saved and how many rows it has, or what went wrong.
 */
export function CompanyReportExportDialog({
  visible,
  initialKind,
  initialDate,
  siteOptions,
  onClose,
  onGenerate,
}: {
  visible: boolean;
  initialKind: ReportKind;
  /** YYYY-MM-DD: the board's selected day, or today. */
  initialDate: string;
  siteOptions: ReadonlyArray<{ value: string; label: string }>;
  onClose: () => void;
  /** Fetches and downloads; resolves with what to tell the controller, rejects with a readable error. */
  onGenerate: (request: ReportRequest) => Promise<string>;
}) {
  const [kind, setKind] = React.useState<ReportKind>(initialKind);
  const [period, setPeriod] = React.useState<ReportPeriod>('day');
  const [date, setDate] = React.useState(initialDate);
  const [customTo, setCustomTo] = React.useState(initialDate);
  const [siteId, setSiteId] = React.useState('');
  const [format, setFormat] = React.useState<'csv' | 'xlsx'>('xlsx');
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  React.useEffect(() => {
    if (!visible) return;
    setKind(initialKind);
    setDate(initialDate);
    setCustomTo(initialDate);
    setFeedback(null);
  }, [visible, initialKind, initialDate]);

  const range = reportRange(period, date, customTo);
  const rangeError = 'error' in range ? range.error : null;

  const submit = async () => {
    if ('error' in range) return;
    setBusy(true);
    setFeedback(null);
    try {
      const message = await onGenerate({ kind, from: range.from, to: range.to, siteId: siteId ? Number(siteId) : null, format });
      setFeedback({ tone: 'success', message });
    } catch (error) {
      setFeedback({ tone: 'error', message: (error as Error)?.message || 'The report could not be generated.' });
    } finally {
      setBusy(false);
    }
  };

  const choice = <T extends string>(value: T, current: T, label: string, set: (v: T) => void) => (
    <Pressable
      key={value}
      accessibilityRole="button"
      accessibilityState={{ selected: value === current }}
      onPress={() => set(value)}
      style={[styles.choice, value === current ? styles.choiceActive : null, IS_WEB ? (WEB_PTR as any) : null]}
    >
      <Text style={[styles.choiceText, value === current ? styles.choiceTextActive : null]}>{label}</Text>
    </Pressable>
  );

  return (
    <Drawer visible={visible} onClose={onClose} title="Download report" subtitle="Built from S4's records, not from the screen">
      <View style={styles.body}>
        <Text style={styles.label}>Report</Text>
        <View style={styles.row}>
          {choice<ReportKind>('shift-attendance', kind, REPORT_TITLE['shift-attendance'], setKind)}
          {choice<ReportKind>('welfare-monitoring', kind, REPORT_TITLE['welfare-monitoring'], setKind)}
        </View>
        <Text style={styles.hint}>
          {kind === 'shift-attendance'
            ? 'One row per shift: scheduled and actual Book On / Book Off, early or missing Book Off, reconciliation and timesheet status.'
            : 'One row per welfare window: its status, the recorded check time, any missed-window record, and the alert it raised with who acknowledged and resolved it.'}
        </Text>

        <Text style={styles.label}>Period</Text>
        <View style={styles.row}>
          {choice<ReportPeriod>('day', period, 'Day', setPeriod)}
          {choice<ReportPeriod>('week', period, 'Week', setPeriod)}
          {choice<ReportPeriod>('month', period, 'Month', setPeriod)}
          {choice<ReportPeriod>('custom', period, 'Custom', setPeriod)}
        </View>
        <View style={styles.row}>
          <View style={styles.field}>
            <Text style={styles.small}>{period === 'custom' ? 'From' : period === 'day' ? 'Day' : 'Any day in the ' + period}</Text>
            <NativeDateInput value={date} onChange={setDate} accessibilityLabel="Report date" />
          </View>
          {period === 'custom' ? (
            <View style={styles.field}>
              <Text style={styles.small}>To (at most {REPORT_MAX_DAYS} days)</Text>
              <NativeDateInput value={customTo} onChange={setCustomTo} accessibilityLabel="Report end date" />
            </View>
          ) : null}
        </View>
        <Text style={[styles.hint, rangeError ? styles.error : null]}>
          {rangeError ?? ('from' in range ? `${ukDay(range.from)} to ${ukDay(range.to)} · ${range.days} day${range.days === 1 ? '' : 's'}` : '')}
        </Text>

        <Text style={styles.label}>Site</Text>
        <View style={styles.row}>
          {choice('', siteId, 'All sites', setSiteId)}
          {siteOptions.map((option) => choice(option.value, siteId, option.label, setSiteId))}
        </View>

        <Text style={styles.label}>Format</Text>
        <View style={styles.row}>
          {choice<'csv' | 'xlsx'>('xlsx', format, 'Excel (.xlsx)', setFormat)}
          {choice<'csv' | 'xlsx'>('csv', format, 'CSV (.csv)', setFormat)}
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={busy || Boolean(rangeError)}
          onPress={submit}
          style={[styles.primary, busy || rangeError ? styles.primaryDisabled : null, IS_WEB ? (WEB_PTR as any) : null]}
        >
          <Text style={styles.primaryText}>{busy ? 'Preparing…' : 'Download'}</Text>
        </Pressable>
        {feedback ? (
          <Text accessibilityLiveRegion="polite" style={[styles.feedback, feedback.tone === 'error' ? styles.error : styles.success]}>
            {feedback.message}
          </Text>
        ) : null}
      </View>
    </Drawer>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.sm, paddingBottom: spacing.lg },
  label: { fontSize: 11, fontWeight: '800', color: colors.textSecondary, letterSpacing: 0.6, marginTop: spacing.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  field: { gap: 4, minWidth: 150 },
  small: { fontSize: 11, color: colors.textSecondary },
  hint: { fontSize: 12, color: colors.textSecondary },
  choice: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
  },
  choiceActive: { borderColor: colors.accentTealStrong, backgroundColor: `${colors.accentTealStrong}14` },
  choiceText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  choiceTextActive: { color: colors.accentTealStrong },
  primary: { marginTop: spacing.md, alignSelf: 'flex-start', paddingHorizontal: 16, paddingVertical: 10, borderRadius: radii.md, backgroundColor: colors.accentTealStrong },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { color: colors.textOnBrand, fontWeight: '700' },
  feedback: { fontSize: 12, fontWeight: '600' },
  error: { color: colors.danger },
  success: { color: colors.success },
});
