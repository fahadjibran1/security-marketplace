import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, control, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';
import {
  REPLACE_GUARD_FATIGUE_ACK_CODE,
  REPLACE_GUARD_REASON_CATEGORIES,
  replacementCandidatesFor,
  type ReplaceGuardInput,
  type ReplaceGuardReasonCategory,
  type ReplacementGuardOption,
} from './replaceGuard';

/**
 * Replace Guard form — the ONE implementation used by both company entry points: the Shift Offers drawer (which puts
 * `footer` in its drawer footer) and the Rota Planner's Guard positions (ReplaceGuardPanel, inline). Both send the
 * same input to the same onReplaceGuard (CompanyDashboardScreen.handleReplaceShiftGuard → POST /shifts/:id/replace-guard).
 *
 * The shift becomes a fresh offer to the chosen Guard; it is not confirmed cover until they accept. The outgoing Guard
 * is shown only the neutral reason category; the details go to the audit log. Replace never cancels anything.
 */

export type ReplaceGuardTarget = {
  shiftId: number;
  guardId: number | null;
  guardName: string;
  /** An accepted shift that has started: the user must confirm the no-show, and the request says so. */
  noShow: boolean;
};

type FormOptions = {
  /** Null while no replacement is being prepared; a new shiftId starts the form afresh. */
  target: ReplaceGuardTarget | null;
  replacementGuards: ReadonlyArray<ReplacementGuardOption>;
  /** Rejects with the server's refusal (message says why; `code` names it). */
  onReplaceGuard: (shiftId: number, input: ReplaceGuardInput) => Promise<void>;
  /** Leaves the form without replacing. */
  onBack: () => void;
  /** After the server accepted the replacement. */
  onReplaced: (replacementName: string) => void;
  /** The drawer footer uses md buttons; inline panels use sm. */
  buttonSize?: 'sm' | 'md';
};

export function useReplaceGuardForm({ target, replacementGuards, onReplaceGuard, onBack, onReplaced, buttonSize = 'sm' }: FormOptions) {
  const [replacementId, setReplacementId] = React.useState<number | null>(null);
  const [category, setCategory] = React.useState<ReplaceGuardReasonCategory | null>(null);
  const [reason, setReason] = React.useState('');
  const [noShowConfirmed, setNoShowConfirmed] = React.useState(false);
  const [needsFatigueAck, setNeedsFatigueAck] = React.useState(false);
  const [replacing, setReplacing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const shiftId = target?.shiftId ?? null;
  // A different (or closed) target starts the form afresh.
  React.useEffect(() => {
    setReplacementId(null);
    setCategory(null);
    setReason('');
    setNoShowConfirmed(false);
    setNeedsFatigueAck(false);
    setError(null);
  }, [shiftId]);
  // A different Guard needs their own fatigue assessment.
  React.useEffect(() => { setNeedsFatigueAck(false); }, [replacementId]);

  const candidates = React.useMemo(
    () => replacementCandidatesFor(replacementGuards, target?.guardId ?? null),
    [replacementGuards, target?.guardId],
  );

  const canSubmit = Boolean(
    target && replacementId && category && reason.trim() && (!target.noShow || noShowConfirmed) && !replacing,
  );

  const submit = React.useCallback(async () => {
    if (!target || !replacementId || !category || !reason.trim()) return;
    if (target.noShow && !noShowConfirmed) return;
    const replacementName = candidates.find((g) => g.id === replacementId)?.name ?? 'the replacement Guard';
    let replaced = false;
    try {
      setReplacing(true);
      setError(null);
      await onReplaceGuard(target.shiftId, {
        replacementGuardId: replacementId,
        reasonCategory: category,
        reason: reason.trim(),
        ...(target.noShow ? { noShow: true } : {}),
        ...(needsFatigueAck ? { fatigueAcknowledged: true } : {}),
      });
      replaced = true;
    } catch (err) {
      if ((err as { code?: string })?.code === REPLACE_GUARD_FATIGUE_ACK_CODE) setNeedsFatigueAck(true);
      setError(err instanceof Error && err.message ? err.message : 'Unable to replace the Guard right now.');
    } finally {
      setReplacing(false);
    }
    if (replaced) onReplaced(replacementName);
  }, [target, replacementId, category, reason, noShowConfirmed, needsFatigueAck, candidates, onReplaceGuard, onReplaced]);

  if (!target) return { body: null, footer: null, replacing };

  const guardName = target.guardName || 'The current Guard';

  const body = (
    <View style={styles.block}>
      <Text style={styles.sectionTitle}>Replace Guard</Text>
      <Text style={styles.meta}>
        The shift becomes a new offer to the Guard you choose; it is not confirmed cover until they accept it.
        {' '}{guardName} is told their shift assignment has changed, with the reason you pick below (never the details).
      </Text>
      <View style={styles.list}>
        {candidates.length === 0 ? (
          <Text style={styles.meta}>No other active Guards in your company.</Text>
        ) : (
          candidates.map((g) => (
            <Pressable
              key={g.id}
              accessibilityRole="radio"
              accessibilityLabel={`Replacement Guard ${g.name}`}
              accessibilityState={{ selected: replacementId === g.id }}
              onPress={() => setReplacementId(g.id)}
              style={[styles.option, replacementId === g.id ? styles.optionActive : null]}
            >
              <Text style={styles.optionText}>{g.name}</Text>
            </Pressable>
          ))
        )}
      </View>
      <Text style={styles.sectionTitle}>Reason shown to {guardName}</Text>
      <View style={styles.list}>
        {REPLACE_GUARD_REASON_CATEGORIES.map((c) => (
          <Pressable
            key={c.key}
            accessibilityRole="radio"
            accessibilityLabel={`Reason ${c.label}`}
            accessibilityState={{ selected: category === c.key }}
            onPress={() => setCategory(c.key)}
            style={[styles.option, category === c.key ? styles.optionActive : null]}
          >
            <Text style={styles.optionText}>{c.label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={styles.input}
        value={reason}
        onChangeText={setReason}
        accessibilityLabel="Replacement details"
        placeholder="Details (audit log only; never shown to a Guard)"
        placeholderTextColor={colors.fieldPlaceholder}
        maxLength={500}
      />
      {target.noShow ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel="Confirm no-show"
          accessibilityState={{ checked: noShowConfirmed }}
          onPress={() => setNoShowConfirmed((v) => !v)}
          style={[styles.option, noShowConfirmed ? styles.optionActive : null, styles.confirm]}
        >
          <Text style={styles.optionText}>
            {noShowConfirmed ? '☑' : '☐'} This shift has started and {guardName} has not booked on (no-show).
          </Text>
        </Pressable>
      ) : null}
      {error ? <Text style={[styles.meta, styles.error]}>{error}</Text> : null}
    </View>
  );

  const footer = (
    <View style={styles.footer}>
      <Button label="Back" accessibilityLabel="Back without replacing" variant="secondary" size={buttonSize} onPress={onBack} disabled={replacing} />
      <Button
        label={needsFatigueAck ? 'Acknowledge and replace' : 'Replace Guard'}
        accessibilityLabel={needsFatigueAck ? 'Acknowledge and replace' : 'Confirm Replace Guard'}
        variant="primary"
        size={buttonSize}
        onPress={submit}
        loading={replacing}
        disabled={!canSubmit}
      />
    </View>
  );

  return { body, footer, replacing };
}

/** The form inline (Rota Planner): body then its own action row. */
export function ReplaceGuardPanel(props: FormOptions & { target: ReplaceGuardTarget; key?: string | number }) {
  const { body, footer } = useReplaceGuardForm(props);
  return (
    <View style={styles.panel}>
      {body}
      {footer}
    </View>
  );
}

/** The one-line reason shown beside a disabled Replace Guard. */
export function ReplaceGuardUnavailableNote({ reason }: { reason: string }) {
  return (
    <Text style={styles.unavailable} accessibilityLabel={`Replace Guard unavailable: ${reason}`}>
      {`Replace Guard unavailable: ${reason}`}
    </Text>
  );
}

const styles = StyleSheet.create({
  block: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  panel: {
    marginTop: spacing.xs,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceSubtle,
  },
  sectionTitle: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  meta: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  error: {
    color: colors.danger,
    marginTop: spacing.xs,
  },
  list: {
    gap: spacing.xs,
    marginVertical: spacing.sm,
  },
  option: {
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
  },
  optionActive: {
    borderColor: colors.info,
    backgroundColor: colors.infoSurface,
  },
  optionText: {
    ...typography.caption,
    color: colors.textPrimary,
    lineHeight: 20,
  },
  confirm: {
    marginTop: spacing.sm,
  },
  input: {
    height: control.buttonHeightSm,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
    color: colors.textPrimary,
    ...typography.caption,
  },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'flex-end',
  },
  unavailable: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
});
