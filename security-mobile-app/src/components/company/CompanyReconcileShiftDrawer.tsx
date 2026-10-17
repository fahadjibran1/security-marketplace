import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Drawer } from '../ui/Drawer';
import {
  SHIFT_RECONCILIATION_NOTE_MAX,
  SHIFT_RECONCILIATION_OPTIONS,
  validateShiftReconciliation,
} from './shiftReconciliation';
import { colors, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;

export type ReconcileTarget = {
  shiftId: number;
  siteName: string;
  guardName: string;
  /** e.g. "13-10-2026 · 20:00 – 14-10-2026 · 06:00". */
  scheduledLabel: string;
  /** The actual Book On, e.g. "13-10-2026 · 20:49". */
  bookOnLabel: string;
  /** How long since the scheduled end, e.g. "68h". */
  overdueLabel: string;
};

/**
 * Close without Book Off (S4 Live Operations Phase 4).
 *
 * Opens on the FACTS — site, Guard, schedule, the real Book On, how overdue — then a reason from a fixed
 * list and, for "Other", a mandatory explanation. Submitting asks for confirmation in place, stating what
 * will and will not happen, before anything is sent. Only a person can do this; nothing calls it
 * automatically.
 */
export function CompanyReconcileShiftDrawer({
  target,
  submitting,
  error,
  onCancel,
  onSubmit,
}: {
  target: ReconcileTarget | null;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: { reason: string; note: string | null }) => void;
}) {
  const [reason, setReason] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  const [attempted, setAttempted] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  // A fresh form per shift: a reason chosen for the last one must never be pre-selected on the next.
  React.useEffect(() => {
    setReason(null);
    setNote('');
    setAttempted(false);
    setConfirming(false);
  }, [target?.shiftId]);

  if (!target) return null;

  const verdict = validateShiftReconciliation({ reason, note });
  const noteRequired = reason === 'other';

  const review = () => {
    setAttempted(true);
    if (verdict.ok) setConfirming(true);
  };
  const confirm = () => {
    if (!verdict.ok || !reason) return;
    onSubmit({ reason, note: note.trim() || null });
  };

  return (
    <Drawer
      visible
      onClose={onCancel}
      title="Close without Book Off"
      subtitle={`Shift #${target.shiftId}`}
      width={560}
      footer={
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            style={[styles.secondaryBtn, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={confirming ? () => setConfirming(false) : onCancel}
            disabled={submitting}
          >
            <Text style={styles.secondaryBtnText}>{confirming ? 'Back' : 'Cancel'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: submitting }}
            style={[styles.primaryBtn, confirming ? styles.primaryBtnConfirm : null, submitting ? styles.primaryBtnBusy : null, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={confirming ? confirm : review}
            disabled={submitting}
          >
            <Text style={styles.primaryBtnText}>
              {submitting ? 'Closing…' : confirming ? 'Confirm — close without Book Off' : 'Close without Book Off'}
            </Text>
          </Pressable>
        </View>
      }
    >
      <View style={styles.facts}>
        {([
          ['Site', target.siteName],
          ['Guard', target.guardName],
          ['Scheduled', target.scheduledLabel],
          ['Booked On', target.bookOnLabel],
          ['Book Off', `None recorded · ${target.overdueLabel} since the scheduled end`],
        ] as const).map(([label, value]) => (
          <View key={label} style={styles.factRow}>
            <Text style={styles.factLabel}>{label}</Text>
            <Text style={styles.factValue} numberOfLines={2}>{value}</Text>
          </View>
        ))}
      </View>

      {confirming ? (
        <View style={styles.confirmPanel} {...({ accessibilityRole: 'alert' } as any)}>
          <Text style={styles.confirmTitle}>Close this shift without a Book Off?</Text>
          <Text style={styles.confirmText}>
            The shift will be marked completed and shown as "Closed by Control — No Book Off". Its open Missing
            Book Off and Welfare alerts will be closed with this reason, and the action is recorded in the audit
            log under your name.
          </Text>
          <Text style={styles.confirmText}>
            No Book Off time will be recorded, attendance is not changed, and no timesheet hours are added — any
            hours to be paid are a separate decision.
          </Text>
          <Text style={styles.confirmReason}>
            Reason: {SHIFT_RECONCILIATION_OPTIONS.find((option) => option.value === reason)?.label}
            {note.trim() ? ` — ${note.trim()}` : ''}
          </Text>
        </View>
      ) : (
        <>
          <Text style={styles.sectionLabel}>Reason</Text>
          <View style={styles.reasonList}>
            {SHIFT_RECONCILIATION_OPTIONS.map((option) => {
              const selected = reason === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={option.label}
                  style={[styles.reason, selected ? styles.reasonSelected : null, IS_WEB ? (WEB_PTR as any) : null]}
                  onPress={() => setReason(option.value)}
                >
                  <Text style={[styles.reasonMark, selected ? styles.reasonMarkSelected : null]}>{selected ? '◉' : '○'}</Text>
                  <Text style={[styles.reasonText, selected ? styles.reasonTextSelected : null]}>{option.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.sectionLabel}>Explanation{noteRequired ? '' : ' (optional)'}</Text>
          <TextInput
            style={styles.noteInput}
            multiline
            value={note}
            onChangeText={setNote}
            maxLength={SHIFT_RECONCILIATION_NOTE_MAX}
            placeholder={noteRequired ? 'What did Control establish?' : 'Anything worth recording (optional)'}
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Explanation"
          />
          {attempted && !verdict.ok ? <Text style={styles.problem}>{verdict.message}</Text> : null}
        </>
      )}

      {error ? <Text style={styles.problem}>{error}</Text> : null}
    </Drawer>
  );
}

const styles = StyleSheet.create({
  facts: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 4,
  },
  factRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  factLabel: { width: 76, fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  factValue: { flex: 1, fontSize: 12, color: colors.textPrimary, fontWeight: '600' },
  sectionLabel: {
    fontSize: 10, fontWeight: '800', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: spacing.sm,
  },
  reasonList: { gap: 2 },
  reason: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 8, paddingHorizontal: spacing.sm,
    borderRadius: radii.sm, borderWidth: 1, borderColor: 'transparent',
  },
  reasonSelected: { borderColor: colors.accentTeal, backgroundColor: colors.surfaceSubtle },
  reasonMark: { fontSize: 13, color: colors.textMuted },
  reasonMarkSelected: { color: colors.accentTeal },
  reasonText: { fontSize: 13, color: colors.textPrimary },
  reasonTextSelected: { fontWeight: '700' },
  noteInput: {
    minHeight: 92, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.sm, padding: spacing.sm,
    fontSize: 13, color: colors.textPrimary, backgroundColor: colors.card, textAlignVertical: 'top',
  },
  confirmPanel: {
    marginTop: spacing.sm, padding: spacing.md, gap: spacing.xs, borderRadius: radii.sm, borderWidth: 1,
    borderColor: colors.warning, backgroundColor: colors.warningSurface,
  },
  confirmTitle: { fontSize: 14, fontWeight: '800', color: colors.primaryNavyStrong },
  confirmText: { fontSize: 12, color: colors.textPrimary, lineHeight: 18 },
  confirmReason: { fontSize: 12, fontWeight: '700', color: colors.textPrimary },
  problem: { fontSize: 12, color: colors.danger, fontWeight: '700' },
  footer: { flexDirection: 'row', gap: spacing.sm },
  secondaryBtn: { paddingHorizontal: spacing.md, paddingVertical: 9, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.fieldBorder },
  secondaryBtnText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  primaryBtn: { paddingHorizontal: spacing.md, paddingVertical: 9, borderRadius: radii.sm, backgroundColor: colors.primaryNavy },
  primaryBtnConfirm: { backgroundColor: colors.warning },
  primaryBtnBusy: { opacity: 0.7 },
  primaryBtnText: { fontSize: 13, fontWeight: '800', color: colors.textOnBrand },
});
