import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { StatusBadge } from '../StatusBadge';
import { Button } from '../ui/Button';
import {
  GUARD_DELIVERY_NOTE,
  GUARD_DISPUTE_MAX,
  buildGuardHistory,
  canAnswer,
  formatExtraTime,
  guardApprovalText,
  guardRequestExplanation,
  guardRequestTitle,
  guardStatusTone,
  guardWarningText,
  validateGuardDispute,
} from './guardShiftAmendments';
import { formatInstantTime, formatUkDateTime } from '../../services/siteTime';
import type { ShiftAmendment } from '../../types/models';
import { colors, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;

/**
 * Live Shift Amendments — the Guard's extension request on the Home tab (Phase 3).
 *
 * Shows what the company asked, why, the original and current end, management approval and the backend's own
 * fatigue warnings, then Accept / Decline behind a confirmation. The shift end shown is always the server's: nothing
 * changes on the device until the server has confirmed. A staff-recorded verbal agreement is said to be exactly
 * that, with a Dispute action.
 */
export function GuardShiftExtensionCard({
  request,
  shiftHistory,
  originalEnd,
  currentEnd,
  timeZone,
  nowMs,
  submitting,
  problem,
  refreshedAt,
  onAnswer,
  onDispute,
  onRefresh,
}: {
  request: ShiftAmendment;
  /** Every request of this shift (for the history), oldest first or any order. */
  shiftHistory: ShiftAmendment[];
  originalEnd: string | null;
  currentEnd: string;
  timeZone?: string | null;
  nowMs: number;
  submitting: boolean;
  problem: { message: string; retryable: boolean } | null;
  refreshedAt: number | null;
  onAnswer: (response: 'accepted' | 'declined') => void;
  onDispute: (reason: string) => void;
  onRefresh: () => void;
  key?: string | number;
}) {
  const [confirming, setConfirming] = React.useState<'accepted' | 'declined' | null>(null);
  const [disputing, setDisputing] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [attempted, setAttempted] = React.useState(false);
  const [showHistory, setShowHistory] = React.useState(false);

  // A different request (or a new state of it) starts clean: no half-made decision carries over.
  React.useEffect(() => {
    setConfirming(null);
    setDisputing(false);
    setReason('');
    setAttempted(false);
  }, [request.id, request.status]);

  const t = (iso: string | null | undefined) => formatInstantTime(iso, timeZone);
  const answerable = canAnswer(request, nowMs);
  const disputable = request.status === 'accepted' && request.responseMethod === 'staff_recorded_verbal';
  const verdict = validateGuardDispute(reason);
  const history = buildGuardHistory(shiftHistory, timeZone);
  const approval = guardApprovalText(request);

  return (
    <View style={styles.card} {...({ accessibilityRole: 'summary', 'aria-label': 'Shift extension request' } as any)}>
      <View style={styles.header}>
        <Text style={styles.title}>{guardRequestTitle(request)}</Text>
        <StatusBadge label={request.effectiveStatus === 'expired' ? 'Expired' : labelFor(request)} tone={guardStatusTone(request)} size="small" />
      </View>

      <View style={styles.facts}>
        <Fact label="Originally due to end" value={formatUkDateTime(originalEnd ?? request.originalEnd, timeZone)} />
        <Fact label="Current end" value={formatUkDateTime(currentEnd, timeZone)} />
        <Fact label="Asked to stay until" value={`${formatUkDateTime(request.proposedEnd, timeZone)} (+${formatExtraTime(request.additionalMinutes)})`} />
        <Fact label="Reason" value={request.reason} />
        {approval ? <Fact label="Management" value={approval} /> : null}
        {request.status === 'pending' || request.status === 'awaiting_approval' ? <Fact label="Answer by" value={t(request.expiresAt)} /> : null}
      </View>

      {request.fatigue.warnings.map((w) => (
        <View key={w} style={styles.warning}>
          <Text style={styles.warningText}>{guardWarningText(w, request.fatigue)}</Text>
        </View>
      ))}

      <Text style={styles.explain}>{guardRequestExplanation(request, timeZone)}</Text>

      {answerable && !confirming ? (
        <View style={styles.actions}>
          <Button label="Accept extension" onPress={() => setConfirming('accepted')} disabled={submitting} />
          <Button label="Decline" variant="secondary" onPress={() => setConfirming('declined')} disabled={submitting} />
        </View>
      ) : null}

      {answerable && confirming ? (
        <View style={styles.confirm} {...({ accessibilityRole: 'alert' } as any)}>
          <Text style={styles.confirmTitle}>
            {confirming === 'accepted'
              ? `Stay until ${t(request.proposedEnd)}?`
              : `Decline and finish at ${t(request.previousEnd)}?`}
          </Text>
          <Text style={styles.confirmText}>
            {confirming === 'accepted'
              ? 'Your shift end changes only once S4 confirms your answer.'
              : 'Your shift end stays as it is. Your company will see that you declined.'}
          </Text>
          <View style={styles.actions}>
            <Button
              label={submitting ? 'Sending…' : confirming === 'accepted' ? 'Yes, accept' : 'Yes, decline'}
              variant={confirming === 'accepted' ? 'primary' : 'danger'}
              loading={submitting}
              disabled={submitting}
              onPress={() => onAnswer(confirming)}
            />
            <Button label="Back" variant="tertiary" onPress={() => setConfirming(null)} disabled={submitting} />
          </View>
        </View>
      ) : null}

      {disputable && !disputing ? (
        <View style={styles.actions}>
          <Button label="I did not agree — dispute" variant="secondary" onPress={() => setDisputing(true)} disabled={submitting} />
        </View>
      ) : null}

      {disputable && disputing ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmTitle}>Dispute the recorded agreement</Text>
          <Text style={styles.confirmText}>Say what you did agree to. The extension stays in place until your company reviews it.</Text>
          <TextInput
            style={styles.input}
            multiline
            value={reason}
            onChangeText={setReason}
            maxLength={GUARD_DISPUTE_MAX}
            placeholder="e.g. I agreed to 30 minutes, not an hour"
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Dispute reason"
          />
          {attempted && !verdict.ok ? <Text style={styles.problem}>{verdict.message}</Text> : null}
          <View style={styles.actions}>
            <Button
              label={submitting ? 'Sending…' : 'Send dispute'}
              variant="danger"
              loading={submitting}
              disabled={submitting}
              onPress={() => { setAttempted(true); if (verdict.ok) onDispute(reason.trim()); }}
            />
            <Button label="Back" variant="tertiary" onPress={() => setDisputing(false)} disabled={submitting} />
          </View>
        </View>
      ) : null}

      {problem ? (
        <View style={styles.problemBox} {...({ accessibilityRole: 'alert' } as any)}>
          <Text style={styles.problem}>{problem.message}</Text>
          {problem.retryable ? <Button label="Check again" size="sm" variant="secondary" onPress={onRefresh} /> : null}
        </View>
      ) : null}

      <Pressable accessibilityRole="button" onPress={() => setShowHistory(!showHistory)} style={[styles.historyToggle, IS_WEB ? (WEB_PTR as any) : null]}>
        <Text style={styles.historyToggleText}>{showHistory ? 'Hide history' : `History (${history.length})`}</Text>
      </Pressable>
      {showHistory ? (
        <View style={styles.history}>
          {history.map((e, i) => (
            <View key={`${e.at}-${i}`} style={styles.historyRow}>
              <Text style={styles.historyTime}>{formatUkDateTime(e.at, timeZone)}</Text>
              <Text style={styles.historyTitle}>{e.title}</Text>
              {e.detail ? <Text style={styles.historyDetail}>{e.detail}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}

      <Text style={styles.note}>
        {refreshedAt ? `Checked ${formatInstantTime(new Date(refreshedAt).toISOString(), timeZone)}. ` : ''}{GUARD_DELIVERY_NOTE}
      </Text>
    </View>
  );
}

/** The badge. A staff-recorded agreement is never badged as though the Guard agreed in the app. */
function labelFor(request: ShiftAmendment): string {
  switch (request.status) {
    case 'awaiting_approval': return 'Awaiting approval';
    case 'pending': return 'Answer needed';
    case 'accepted': return request.responseMethod === 'staff_recorded_verbal' ? 'Recorded by company' : 'Accepted';
    case 'declined': return 'Declined';
    case 'withdrawn': return 'Withdrawn';
    case 'expired': return 'Expired';
    case 'voided': return 'Cancelled';
    case 'disputed': return 'Disputed';
    case 'dispute_upheld': return 'Reviewed';
    case 'dispute_corrected': return 'To be corrected';
    default: return String(request.status);
  }
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.factRow}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1, borderColor: colors.warningBorder, backgroundColor: colors.card, borderRadius: radii.md,
    padding: spacing.md, gap: spacing.sm,
  },
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  title: { flexShrink: 1, fontSize: 16, fontWeight: '800', color: colors.primaryNavyStrong },
  facts: { backgroundColor: colors.surfaceSubtle, borderRadius: radii.sm, padding: spacing.sm, gap: 4 },
  factRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  factLabel: { width: 132, fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  factValue: { flex: 1, minWidth: 140, fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  warning: { borderWidth: 1, borderColor: colors.warningBorder, backgroundColor: colors.warningSurface, borderRadius: radii.sm, padding: spacing.sm },
  warningText: { fontSize: 12, fontWeight: '700', color: colors.warning, lineHeight: 17 },
  explain: { fontSize: 13, color: colors.textPrimary, lineHeight: 19 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  confirm: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, padding: spacing.sm, gap: spacing.xs, backgroundColor: colors.surfaceSubtle },
  confirmTitle: { fontSize: 14, fontWeight: '800', color: colors.primaryNavyStrong },
  confirmText: { fontSize: 12, color: colors.textPrimary, lineHeight: 18 },
  input: {
    minHeight: 72, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.sm, padding: spacing.sm,
    fontSize: 14, color: colors.textPrimary, backgroundColor: colors.card, textAlignVertical: 'top',
  },
  problemBox: { gap: spacing.xs },
  problem: { fontSize: 12, fontWeight: '700', color: colors.danger },
  historyToggle: { paddingVertical: 6, alignSelf: 'flex-start' },
  historyToggleText: { fontSize: 13, fontWeight: '700', color: colors.accentTeal },
  history: { gap: spacing.xs },
  historyRow: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: spacing.sm, gap: 2 },
  historyTime: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  historyTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  historyDetail: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  note: { fontSize: 11, color: colors.textSecondary, lineHeight: 16 },
});
