import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Drawer } from '../ui/Drawer';
import {
  MARK_MISSED_CONSEQUENCES,
  MARK_MISSED_REASON_MAX,
  NO_BOOK_ON_OVERDUE_LABEL,
  validateMarkMissedReason,
} from './noBookOnOverdue';
import { colors, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;

export type MarkMissedTarget = {
  shiftId: number;
  siteName: string;
  guardName: string;
  /** e.g. "27-10-2026 · 14:00 – 22:00". */
  scheduledLabel: string;
  /** e.g. "22 min". */
  overdueLabel: string;
};

/**
 * Mark Missed — the ONLY way the company web dashboard marks a shift missed.
 *
 * The dashboard used to do this by itself 15 minutes after a Ready shift's start, from whichever browser tab
 * had Live Operations open. Now a shift manager opens this from a "No Book On — Overdue" warning, reads what
 * it does (the Guard can no longer Book On; Replace Guard or a late Book On may be the right answer instead),
 * gives a reason, and confirms. Cancel, Back or closing the drawer sends nothing.
 */
export function CompanyMarkMissedDrawer({
  target,
  submitting,
  error,
  onCancel,
  onSubmit,
}: {
  target: MarkMissedTarget | null;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: { reason: string }) => void;
}) {
  const [reason, setReason] = React.useState('');
  const [attempted, setAttempted] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  // A fresh form per shift: a reason typed for one shift must never carry over to the next.
  React.useEffect(() => {
    setReason('');
    setAttempted(false);
    setConfirming(false);
  }, [target?.shiftId]);

  if (!target) return null;

  const verdict = validateMarkMissedReason(reason);

  const review = () => {
    setAttempted(true);
    if (verdict.ok) setConfirming(true);
  };
  const confirm = () => {
    if (!verdict.ok || submitting) return;
    onSubmit({ reason: reason.trim() });
  };

  return (
    <Drawer
      visible
      onClose={onCancel}
      title="Mark Missed"
      subtitle={`Shift #${target.shiftId}`}
      width={560}
      footer={
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={confirming ? 'Back' : 'Cancel'}
            style={[styles.secondaryBtn, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={confirming ? () => setConfirming(false) : onCancel}
            disabled={submitting}
          >
            <Text style={styles.secondaryBtnText}>{confirming ? 'Back' : 'Cancel'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={confirming ? 'Confirm — mark missed' : 'Continue'}
            accessibilityState={{ disabled: submitting }}
            style={[styles.primaryBtn, confirming ? styles.primaryBtnConfirm : null, submitting ? styles.primaryBtnBusy : null, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={confirming ? confirm : review}
            disabled={submitting}
          >
            <Text style={styles.primaryBtnText}>
              {submitting ? 'Marking…' : confirming ? 'Confirm — mark missed' : 'Continue'}
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
          ['Book On', `${NO_BOOK_ON_OVERDUE_LABEL} · ${target.overdueLabel} since the scheduled start`],
        ] as const).map(([label, value]) => (
          <View key={label} style={styles.factRow}>
            <Text style={styles.factLabel}>{label}</Text>
            <Text style={styles.factValue} numberOfLines={2}>{value}</Text>
          </View>
        ))}
      </View>

      <View style={styles.consequences} {...({ accessibilityRole: 'alert' } as any)}>
        <Text style={styles.confirmTitle}>Before you mark this shift missed</Text>
        {MARK_MISSED_CONSEQUENCES.map((line) => (
          <Text key={line} style={styles.confirmText}>{line}</Text>
        ))}
      </View>

      {confirming ? (
        <View style={styles.confirmPanel}>
          <Text style={styles.confirmTitle}>Mark Shift #{target.shiftId} missed?</Text>
          <Text style={styles.confirmText}>{target.guardName} will no longer be able to Book On to this shift.</Text>
          <Text style={styles.confirmReason}>Reason: {reason.trim()}</Text>
        </View>
      ) : (
        <>
          <Text style={styles.sectionLabel}>Reason (required)</Text>
          <TextInput
            style={styles.noteInput}
            multiline
            value={reason}
            onChangeText={setReason}
            maxLength={MARK_MISSED_REASON_MAX}
            placeholder="e.g. Guard unreachable by phone; client confirmed no one on site"
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Reason"
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
  noteInput: {
    minHeight: 92, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.sm, padding: spacing.sm,
    fontSize: 13, color: colors.textPrimary, backgroundColor: colors.card, textAlignVertical: 'top',
  },
  consequences: {
    marginTop: spacing.sm, padding: spacing.md, gap: spacing.xs, borderRadius: radii.sm, borderWidth: 1,
    borderColor: colors.border, backgroundColor: colors.surfaceSubtle,
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
  primaryBtnConfirm: { backgroundColor: colors.danger },
  primaryBtnBusy: { opacity: 0.7 },
  primaryBtnText: { fontSize: 13, fontWeight: '800', color: colors.textOnBrand },
});
