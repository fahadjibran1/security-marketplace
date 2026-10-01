import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Drawer } from '../ui/Drawer';
import {
  RESOLUTION_NOTE_MAX_LENGTH,
  requiresResolutionNote,
  resolutionOptions,
  validateResolution,
  type ResolutionFamily,
} from './alertResolution';
import { colors, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;

export type ResolveTarget = {
  /** What is being resolved, for the API call the caller will make. */
  kind: 'alert' | 'incident';
  id: number;
  family: ResolutionFamily;
  /** The heading facts, so a controller resolving at speed knows exactly what they are closing. */
  title: string;
  siteName: string;
  guardName: string;
  shiftLabel: string;
  raisedLabel: string;
};

/**
 * Resolving an operational item.
 *
 * It opens on the FACTS — what, where, who, which shift, when it was raised — because a controller
 * clearing a queue at 03:00 must be certain which item they are closing before they say why.
 *
 * The reason is a choice from this item's own family, never free text, so the record can be counted
 * later; the note is where the sentence goes. Submission is refused here by the same rule the API
 * enforces, so Control is told what is missing instead of being refused after writing it.
 */
export function CompanyResolveAlertDrawer({
  target,
  submitting,
  error,
  onCancel,
  onSubmit,
}: {
  target: ResolveTarget | null;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (resolution: { resolutionReason: string; resolutionNote?: string }) => void;
}) {
  const [reason, setReason] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  const [attempted, setAttempted] = React.useState(false);

  // A fresh dialog per item: a reason chosen for the last alert must never be pre-selected on the next.
  React.useEffect(() => {
    setReason(null);
    setNote('');
    setAttempted(false);
  }, [target?.kind, target?.id]);

  if (!target) return null;

  const options = resolutionOptions(target.family);
  const noteRequired = requiresResolutionNote(target.family, reason);
  const verdict = validateResolution(target.family, { reason, note });

  const submit = () => {
    setAttempted(true);
    if (!verdict.ok) return;
    onSubmit({ resolutionReason: reason!, resolutionNote: note.trim() || undefined });
  };

  return (
    <Drawer
      visible
      onClose={onCancel}
      title="Resolve"
      subtitle={target.title}
      width={560}
      footer={
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            style={[styles.secondaryBtn, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={onCancel}
            disabled={submitting}
          >
            <Text style={styles.secondaryBtnText}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: submitting }}
            style={[styles.primaryBtn, submitting ? styles.primaryBtnBusy : null, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={submit}
            disabled={submitting}
          >
            <Text style={styles.primaryBtnText}>{submitting ? 'Resolving…' : 'Resolve'}</Text>
          </Pressable>
        </View>
      }
    >
      {/* What is being closed. */}
      <View style={styles.facts}>
        {([
          ['Site', target.siteName],
          ['Guard', target.guardName],
          ['Shift', target.shiftLabel],
          ['Raised', target.raisedLabel],
        ] as const).map(([label, value]) => (
          <View key={label} style={styles.factRow}>
            <Text style={styles.factLabel}>{label}</Text>
            <Text style={styles.factValue} numberOfLines={2}>{value || '—'}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.sectionLabel}>Resolution reason</Text>
      <View style={styles.reasonList}>
        {options.map((option) => {
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
              {/* A glyph, not only a tint: the chosen reason has to be unmistakable. */}
              <Text style={[styles.reasonMark, selected ? styles.reasonMarkSelected : null]}>
                {selected ? '◉' : '○'}
              </Text>
              <Text style={[styles.reasonText, selected ? styles.reasonTextSelected : null]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.sectionLabel}>
        Resolution note{noteRequired ? '' : ' (optional)'}
      </Text>
      <TextInput
        style={styles.noteInput}
        multiline
        value={note}
        onChangeText={setNote}
        maxLength={RESOLUTION_NOTE_MAX_LENGTH}
        placeholder={
          noteRequired
            ? 'What did Control establish, and what was done?'
            : 'Anything worth recording (optional)'
        }
        placeholderTextColor={colors.textMuted}
        accessibilityLabel="Resolution note"
      />

      {attempted && !verdict.ok ? (
        <Text style={styles.problem}>{verdict.message}</Text>
      ) : null}
      {error ? <Text style={styles.problem}>{error}</Text> : null}

      <Text style={styles.footnote}>
        This records how the alert was resolved. It does not change attendance, Welfare evidence or the
        shift itself.
      </Text>
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
  factLabel: { width: 68, fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  factValue: { flex: 1, fontSize: 12, color: colors.textPrimary, fontWeight: '600' },

  sectionLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: spacing.sm,
  },
  reasonList: { gap: 2 },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 8,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  reasonSelected: { borderColor: colors.accentTeal, backgroundColor: colors.surfaceSubtle },
  reasonMark: { fontSize: 13, color: colors.textMuted },
  reasonMarkSelected: { color: colors.accentTeal },
  reasonText: { fontSize: 13, color: colors.textPrimary },
  reasonTextSelected: { fontWeight: '700' },

  noteInput: {
    minHeight: 92,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    padding: spacing.sm,
    fontSize: 13,
    color: colors.textPrimary,
    backgroundColor: colors.card,
    textAlignVertical: 'top',
  },
  problem: { fontSize: 12, color: colors.danger, fontWeight: '700' },
  footnote: { fontSize: 11, color: colors.textSecondary, lineHeight: 16 },

  footer: { flexDirection: 'row', gap: spacing.sm },
  secondaryBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
  },
  secondaryBtnText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  primaryBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderRadius: radii.sm,
    backgroundColor: colors.primaryNavy,
  },
  primaryBtnBusy: { opacity: 0.7 },
  primaryBtnText: { fontSize: 13, fontWeight: '800', color: colors.textOnBrand },
});
