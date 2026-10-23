import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Drawer } from '../ui/Drawer';
import {
  AMENDMENT_TEXT_MAX,
  QUICK_EXTENSION_MINUTES,
  VERBAL_CONTACT_METHOD_OPTIONS,
  amendmentErrorGuidance,
  amendmentStatusLabel,
  approvalStatusText,
  buildAmendmentHistory,
  confirmationEmailText,
  disputedAmendment,
  extensionIneligibleReason,
  formatDuration,
  guardResponseText,
  openAmendment,
  policySummary,
  previewExtension,
  resolveContactTime,
  resolveProposedEnd,
  reviewFlags,
  validateApproval,
  validateDisputeResolution,
  validateProposal,
  validateVerbalAgreement,
  validateWithdrawal,
  warningText,
  type AmendmentPermissions,
  type ShiftAmendment,
  type ShiftAmendmentList,
  type ShiftPolicy,
} from './shiftAmendments';
import {
  approveShiftAmendment,
  getShiftAmendmentPolicy,
  listShiftAmendments,
  proposeShiftAmendment,
  recordShiftAmendmentVerbalAgreement,
  resolveShiftAmendmentDispute,
  withdrawShiftAmendment,
} from '../../services/api';
import { formatSiteTime, formatUkDateTime } from '../../services/siteTime';
import { colors, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;
export type AmendmentTarget = {
  shiftId: number;
  siteName: string;
  guardName: string;
  timeZone: string;
  start: string;
  end: string;
  status: string;
  checkInAt: string | null;
  checkOutAt: string | null;
};

type Mode = 'view' | 'propose' | 'withdraw' | 'approve' | 'verbal' | 'resolve';

/**
 * Live Shift Amendments (company web, Phase 2).
 *
 * Opens on the FACTS — Guard, site, original and current scheduled end, any proposal and where it stands with
 * management and the Guard — then offers only the actions this person is authorised for. Every action is confirmed
 * in place and sent to the API, which re-checks permission, company, policy and state under lock. A verbal
 * agreement is recorded as staff-reported and never shown as the Guard's electronic acceptance.
 */
export function CompanyShiftAmendmentDrawer({
  target,
  permissions,
  currentUserId,
  refreshSignal,
  onClose,
  onChanged,
}: {
  target: AmendmentTarget | null;
  permissions: AmendmentPermissions;
  currentUserId: number | null;
  /**
   * The board's own refresh tick. The Guard may answer in the app at any moment, so the drawer re-reads whenever the
   * board does — on the dashboard's one refresh cycle, never a polling loop of its own.
   */
  refreshSignal: number;
  onClose: () => void;
  /** Called after any successful change, so the board re-reads the shift. */
  onChanged: (message: string) => void;
}) {
  const [policy, setPolicy] = React.useState<ShiftPolicy | null>(null);
  const [data, setData] = React.useState<ShiftAmendmentList | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loadedAt, setLoadedAt] = React.useState<number | null>(null);
  const [mode, setMode] = React.useState<Mode>('view');
  const [confirming, setConfirming] = React.useState(false);
  const [attempted, setAttempted] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [actionError, setActionError] = React.useState<{ message: string; retryable: boolean } | null>(null);
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  // form fields
  const [quickMinutes, setQuickMinutes] = React.useState<number | null>(null);
  const [customTime, setCustomTime] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [statement, setStatement] = React.useState('');
  const [confirmSelf, setConfirmSelf] = React.useState(false);
  const [contactMethod, setContactMethod] = React.useState<string | null>(null);
  const [contactTime, setContactTime] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [termsConfirmed, setTermsConfirmed] = React.useState(false);
  const [resolution, setResolution] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');

  const shiftId = target?.shiftId ?? null;
  const tz = target?.timeZone ?? 'Europe/London';

  const load = React.useCallback(async () => {
    if (shiftId === null) return;
    try {
      const [p, list] = await Promise.all([getShiftAmendmentPolicy(), listShiftAmendments(shiftId)]);
      setPolicy(p);
      setData(list);
      setLoadError(null);
      setLoadedAt(Date.now());
    } catch (error) {
      setLoadError(amendmentErrorGuidance(error).message);
    }
  }, [shiftId]);

  const resetForms = React.useCallback(() => {
    setConfirming(false);
    setAttempted(false);
    setActionError(null);
    setQuickMinutes(null);
    setCustomTime('');
    setReason('');
    setStatement('');
    setConfirmSelf(false);
    setContactMethod(null);
    setContactTime('');
    setConfirmation('');
    setTermsConfirmed(false);
    setResolution(null);
    setNote('');
  }, []);

  // A fresh drawer per shift: nothing typed for the last shift may carry over.
  React.useEffect(() => {
    setPolicy(null);
    setData(null);
    setLoadError(null);
    setMode('view');
    resetForms();
    if (shiftId === null) return;
    void load();
  }, [shiftId, load, resetForms]);

  // Re-read on every board refresh while open (a form being typed is kept; only the facts update).
  React.useEffect(() => {
    if (shiftId === null) return;
    setNowMs(Date.now());
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  if (!target) return null;

  const amendments = data?.amendments ?? [];
  const open = openAmendment(amendments);
  const disputed = disputedAmendment(amendments);
  const currentEnd = data?.currentEnd ?? target.end;
  const originalEnd = data?.originalEnd ?? target.end;
  const enabled = !!policy?.amendmentsEnabled;
  const liveShift = { status: target.status, end: currentEnd };
  const attendance = { checkInAt: target.checkInAt, checkOutAt: target.checkOutAt };
  const ineligible = extensionIneligibleReason(liveShift, attendance, nowMs);
  const nameFor = (userId: number | null) => (userId === null ? null : userId === currentUserId ? 'You' : `Staff user #${userId}`);
  const history = buildAmendmentHistory(amendments, tz, nameFor);

  // proposed end: a quick duration, or a site-local time
  const proposed = quickMinutes !== null
    ? { ok: true as const, ms: Date.parse(currentEnd) + quickMinutes * 60_000 }
    : customTime.trim() ? resolveProposedEnd(currentEnd, customTime, tz) : null;
  const proposedEndMs = proposed && proposed.ok ? proposed.ms : null;
  const preview = policy && proposedEndMs !== null
    ? previewExtension({ startIso: target.start, currentEndIso: currentEnd, proposedEndMs, nowMs: Date.now(), policy })
    : null;

  const selfApproval = !!open && open.proposedByUserId !== null && open.proposedByUserId === currentUserId;
  const contact = contactTime.trim() ? resolveContactTime(contactTime, Date.now(), tz) : null;

  const verdict = (() => {
    switch (mode) {
      case 'propose':
        if (proposed && !proposed.ok) return { ok: false as const, message: proposed.message };
        return validateProposal({ currentEndMs: Date.parse(currentEnd), proposedEndMs, reason, nowMs: Date.now(), preview, policy });
      case 'withdraw': return validateWithdrawal({ reason });
      case 'approve': return validateApproval({ statement, selfApproval, confirmSelfApproval: confirmSelf });
      case 'verbal':
        if (contact && !contact.ok) return { ok: false as const, message: contact.message };
        return validateVerbalAgreement({
          contactMethod, contactAtMs: contact && contact.ok ? contact.ms : null, proposedAtMs: Date.parse(open?.proposedAt ?? ''),
          nowMs: Date.now(), confirmation, reason, termsConfirmed,
        });
      case 'resolve': return validateDisputeResolution({ resolution, note });
      default: return { ok: true as const };
    }
  })();

  const start = (next: Mode) => {
    resetForms();
    if (next === 'verbal' && open) setReason(open.reason);
    setMode(next);
  };
  const back = () => {
    if (confirming) setConfirming(false);
    else { resetForms(); setMode('view'); }
  };
  const review = () => {
    setAttempted(true);
    if (verdict.ok) setConfirming(true);
  };

  const send = async () => {
    if (!verdict.ok || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      let message = '';
      if (mode === 'propose' && proposedEndMs !== null) {
        const result = await proposeShiftAmendment(target.shiftId, { proposedEnd: new Date(proposedEndMs).toISOString(), reason: reason.trim() });
        message = result.amendment.status === 'awaiting_approval'
          ? 'Extension proposed. It needs management approval before the Guard can agree.'
          : 'Extension proposed. The Guard has been asked to agree in the S4 app.';
      } else if (mode === 'withdraw' && open) {
        await withdrawShiftAmendment(open.id, reason.trim() ? { reason: reason.trim() } : {});
        message = 'Extension proposal withdrawn. The shift end is unchanged.';
      } else if (mode === 'approve' && open) {
        await approveShiftAmendment(open.id, { statement: statement.trim(), ...(selfApproval ? { confirmSelfApproval: true } : {}) });
        message = 'Extension approved. The Guard can now agree to it.';
      } else if (mode === 'verbal' && open && contact && contact.ok && contactMethod) {
        const saved = await recordShiftAmendmentVerbalAgreement(open.id, {
          agreedEnd: open.proposedEnd as string, contactMethod: contactMethod as never, contactAt: contact.iso,
          confirmation: confirmation.trim(), reason: reason.trim(),
        });
        message = `Verbal agreement recorded. The shift now ends ${formatSiteTime(saved.agreedEnd, tz)}. ${confirmationEmailText(saved.confirmationEmailStatus)}.`;
      } else if (mode === 'resolve' && disputed && (resolution === 'upheld' || resolution === 'corrected')) {
        await resolveShiftAmendmentDispute(disputed.id, { resolution, note: note.trim() });
        message = resolution === 'upheld' ? 'Dispute reviewed: the recorded agreement stands.' : 'Dispute reviewed: marked for correction through timesheet and payroll review.';
      } else {
        return;
      }
      resetForms();
      setMode('view');
      await load();
      onChanged(message);
    } catch (error) {
      const guidance = amendmentErrorGuidance(error);
      setActionError({ message: guidance.message, retryable: guidance.retryable });
      setConfirming(false);
      if (guidance.reload) {
        await load();
        resetForms();
        setActionError({ message: guidance.message, retryable: false });
        setMode('view');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const actionLabel: Record<Mode, string> = {
    view: '',
    propose: 'Propose extension',
    withdraw: 'Withdraw proposal',
    approve: 'Approve extension',
    verbal: 'Record verbal agreement',
    resolve: 'Record dispute review',
  };

  const footer = mode === 'view' ? (
    <View style={styles.footer}>
      <Btn label="Close" onPress={onClose} secondary />
      <Btn label="Refresh" onPress={() => { setNowMs(Date.now()); void load(); }} secondary />
    </View>
  ) : (
    <View style={styles.footer}>
      <Btn label={confirming ? 'Back' : 'Cancel'} onPress={back} secondary disabled={submitting} />
      <Btn
        label={submitting ? 'Sending…' : confirming ? `Confirm — ${actionLabel[mode].toLowerCase()}` : actionLabel[mode]}
        onPress={confirming ? () => { void send(); } : review}
        disabled={submitting}
        tone={confirming ? 'confirm' : 'primary'}
      />
    </View>
  );

  const facts: Array<[string, string]> = [
    ['Guard', target.guardName],
    ['Site', target.siteName],
    ['Original end', formatUkDateTime(originalEnd, tz)],
    ['Current end', `${formatUkDateTime(currentEnd, tz)}${data?.extended ? ' (extended)' : ''}`],
  ];

  return (
    <Drawer visible onClose={onClose} title="Shift extension" subtitle={`Shift #${target.shiftId}`} width={600} footer={footer}>
      <View style={styles.facts}>
        {facts.map(([label, value]) => (
          <View key={label} style={styles.factRow}>
            <Text style={styles.factLabel}>{label}</Text>
            <Text style={styles.factValue}>{value}</Text>
          </View>
        ))}
      </View>

      {loadError ? (
        <Banner tone="danger" text={`${loadError}${data ? ' Showing the last details loaded.' : ''}`} />
      ) : null}
      {!data && !loadError ? <Text style={styles.muted}>Loading extension details…</Text> : null}
      {policy && !enabled ? (
        <Banner tone="info" text="Shift extensions are not enabled for this company. History is shown read-only." />
      ) : null}
      {loadedAt ? <Text style={styles.muted}>Updated {formatSiteTime(new Date(loadedAt).toISOString(), tz)} · refreshes with the board</Text> : null}

      {actionError ? <Banner tone="danger" text={`${actionError.message}${actionError.retryable ? ' You can try again.' : ''}`} /> : null}

      {mode === 'view' && data ? (
        <>
          {open ? <ProposalCard a={open} tz={tz} policy={policy} /> : null}
          {disputed ? <ProposalCard a={disputed} tz={tz} policy={policy} /> : null}

          {enabled ? (
            <View style={styles.actions}>
              {!open && permissions.canPropose ? (
                ineligible ? <Text style={styles.muted}>{ineligible}</Text> : <Btn label="Propose extension" onPress={() => start('propose')} />
              ) : null}
              {open && open.status === 'awaiting_approval' && permissions.canApprove ? <Btn label="Review and approve" onPress={() => start('approve')} /> : null}
              {open && open.status === 'pending' && permissions.canRecordAgreement ? <Btn label="Record verbal agreement" onPress={() => start('verbal')} secondary /> : null}
              {open && permissions.canWithdraw ? <Btn label="Withdraw proposal" onPress={() => start('withdraw')} secondary /> : null}
              {disputed && permissions.canResolveDispute ? <Btn label="Review dispute" onPress={() => start('resolve')} /> : null}
              {open && open.status === 'awaiting_approval' && !permissions.canApprove ? (
                <Text style={styles.muted}>An Owner or Admin must approve this extension before the Guard can agree.</Text>
              ) : null}
            </View>
          ) : null}

          {policy ? <Text style={styles.policy}>{policySummary(policy)}</Text> : null}

          <Text style={styles.sectionLabel}>Amendment history</Text>
          {history.length === 0 ? <Text style={styles.muted}>This shift has not been extended.</Text> : (
            <View style={styles.history}>
              {history.map((e, i) => (
                <View key={`${e.amendmentId}-${e.kind}-${i}`} style={styles.historyRow}>
                  <Text style={styles.historyTime}>{formatUkDateTime(e.at, tz)}</Text>
                  <View style={styles.historyBody}>
                    <Text style={styles.historyTitle}>{e.title}{e.actor ? ` · ${e.actor}` : ''}</Text>
                    {e.detail ? <Text style={styles.historyDetail}>{e.detail}</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          )}
          {amendments.filter((a) => reviewFlags(a).length > 0).map((a) => (
            <Text key={`flags-${a.id}`} style={styles.flags}>Extension #{a.sequence}: {reviewFlags(a).join(' · ')}</Text>
          ))}
        </>
      ) : null}

      {mode === 'propose' ? (
        confirming && proposedEndMs !== null && preview ? (
          <View style={styles.confirmPanel} {...({ accessibilityRole: 'alert' } as any)}>
            <Text style={styles.confirmTitle}>Propose this extension?</Text>
            <Text style={styles.confirmText}>
              New end {formatUkDateTime(new Date(proposedEndMs).toISOString(), tz)} (+{formatDuration(preview.additionalMinutes)}), {preview.totalScheduledHours} scheduled hours in total.
            </Text>
            <Text style={styles.confirmText}>
              {preview.approvalRequired
                ? 'This needs management approval before the Guard is asked.'
                : 'The Guard will be asked to agree in the S4 app. Nothing changes until they agree.'}
              {' '}The request expires at the current end, {formatSiteTime(currentEnd, tz)}. S4 also checks the Guard&apos;s rest before their next shift and 7-day hours when you send.
            </Text>
            <Text style={styles.confirmReason}>Reason: {reason.trim()}</Text>
          </View>
        ) : (
          <>
            <Text style={styles.sectionLabel}>Extend by</Text>
            <View style={styles.chips}>
              {QUICK_EXTENSION_MINUTES.map((m) => (
                <Chip key={m} label={`+${formatDuration(m)}`} selected={quickMinutes === m} onPress={() => { setQuickMinutes(m); setCustomTime(''); }} />
              ))}
            </View>
            <Text style={styles.sectionLabel}>Or new end time (site time, 24-hour)</Text>
            <TextInput
              style={styles.input}
              value={customTime}
              onChangeText={(v: string) => { setCustomTime(v); setQuickMinutes(null); }}
              placeholder={`after ${formatSiteTime(currentEnd, tz)}, e.g. 22:30`}
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="New end time"
              maxLength={5}
            />
            {preview && proposedEndMs !== null ? (
              <View style={styles.facts}>
                <Fact label="Proposed end" value={formatUkDateTime(new Date(proposedEndMs).toISOString(), tz)} />
                <Fact label="Extension" value={`+${formatDuration(preview.additionalMinutes)}`} />
                <Fact label="Total" value={`${preview.totalScheduledHours} scheduled hours`} />
                <Fact label="Approval" value={preview.approvalRequired ? 'Owner or Admin approval required' : 'Not required on length'} />
              </View>
            ) : null}
            {preview?.hardLimitExceeded ? <Banner tone="danger" text={`Not allowed: over the company limit of ${policy?.hardLimitHours} scheduled hours.`} /> : null}
            {preview?.warnings.map((w) => <Banner key={w} tone="warning" text={warningText(w, policy, { totalScheduledHours: preview.totalScheduledHours })} />)}
            <Text style={styles.sectionLabel}>Reason (required)</Text>
            <TextInput style={styles.noteInput} multiline value={reason} onChangeText={setReason} maxLength={AMENDMENT_TEXT_MAX}
              placeholder="Why the shift needs to run longer" placeholderTextColor={colors.textMuted} accessibilityLabel="Reason" />
          </>
        )
      ) : null}

      {mode === 'withdraw' && open ? (
        confirming ? (
          <View style={styles.confirmPanel} {...({ accessibilityRole: 'alert' } as any)}>
            <Text style={styles.confirmTitle}>Withdraw this proposal?</Text>
            <Text style={styles.confirmText}>The Guard will no longer be able to agree to it. The shift end stays {formatSiteTime(currentEnd, tz)}.</Text>
          </View>
        ) : (
          <>
            <ProposalCard a={open} tz={tz} policy={policy} />
            <Text style={styles.sectionLabel}>Reason (optional)</Text>
            <TextInput style={styles.noteInput} multiline value={reason} onChangeText={setReason} maxLength={AMENDMENT_TEXT_MAX}
              placeholder="Why it is no longer needed" placeholderTextColor={colors.textMuted} accessibilityLabel="Withdrawal reason" />
          </>
        )
      ) : null}

      {mode === 'approve' && open ? (
        confirming ? (
          <View style={styles.confirmPanel} {...({ accessibilityRole: 'alert' } as any)}>
            <Text style={styles.confirmTitle}>Approve this extension?</Text>
            <Text style={styles.confirmText}>The Guard will then be asked to agree. The shift does not change until they do. Your approval and statement are recorded in the audit log.</Text>
            <Text style={styles.confirmReason}>Statement: {statement.trim()}</Text>
          </View>
        ) : (
          <>
            <ProposalCard a={open} tz={tz} policy={policy} />
            <Text style={styles.sectionLabel}>Approval statement (required)</Text>
            <TextInput style={styles.noteInput} multiline value={statement} onChangeText={setStatement} maxLength={AMENDMENT_TEXT_MAX}
              placeholder="e.g. Reviewed rest and hours with the Guard; cover not otherwise available" placeholderTextColor={colors.textMuted} accessibilityLabel="Approval statement" />
            {selfApproval ? (
              <Check label="I proposed this extension and confirm I am approving my own proposal." checked={confirmSelf} onPress={() => setConfirmSelf(!confirmSelf)} />
            ) : null}
          </>
        )
      ) : null}

      {mode === 'verbal' && open ? (
        confirming ? (
          <View style={styles.confirmPanel} {...({ accessibilityRole: 'alert' } as any)}>
            <Text style={styles.confirmTitle}>Record the Guard&apos;s verbal agreement?</Text>
            <Text style={styles.confirmText}>
              The shift will end at {formatUkDateTime(open.proposedEnd, tz)}. This is recorded as reported by you — not as the Guard&apos;s
              electronic acceptance — and the Guard can dispute it. S4 will try to email the Guard a confirmation.
            </Text>
          </View>
        ) : (
          <>
            <Banner tone="info" text="Staff-reported agreement. Only record what the Guard actually agreed to; it is shown to the Guard and can be disputed." />
            <View style={styles.facts}>
              <Fact label="Agreed terms" value={`New end ${formatUkDateTime(open.proposedEnd, tz)} (+${formatDuration(open.additionalMinutes)})`} />
            </View>
            <Text style={styles.sectionLabel}>How you contacted the Guard</Text>
            <View style={styles.chips}>
              {VERBAL_CONTACT_METHOD_OPTIONS.map((o) => (
                <Chip key={o.value} label={o.label} selected={contactMethod === o.value} onPress={() => setContactMethod(o.value)} />
              ))}
            </View>
            <Text style={styles.sectionLabel}>Time of contact (site time, 24-hour)</Text>
            <TextInput style={styles.input} value={contactTime} onChangeText={setContactTime} maxLength={5}
              placeholder="e.g. 21:05" placeholderTextColor={colors.textMuted} accessibilityLabel="Time of contact" />
            <Text style={styles.sectionLabel}>What the Guard agreed (required)</Text>
            <TextInput style={styles.noteInput} multiline value={confirmation} onChangeText={setConfirmation} maxLength={AMENDMENT_TEXT_MAX}
              placeholder="e.g. Guard confirmed by phone they will stay until 22:30" placeholderTextColor={colors.textMuted} accessibilityLabel="Guard's agreement" />
            <Text style={styles.sectionLabel}>Reason (required)</Text>
            <TextInput style={styles.noteInput} multiline value={reason} onChangeText={setReason} maxLength={AMENDMENT_TEXT_MAX}
              placeholderTextColor={colors.textMuted} accessibilityLabel="Reason" />
            <Check label="I confirm the Guard agreed to exactly these terms." checked={termsConfirmed} onPress={() => setTermsConfirmed(!termsConfirmed)} />
          </>
        )
      ) : null}

      {mode === 'resolve' && disputed ? (
        confirming ? (
          <View style={styles.confirmPanel} {...({ accessibilityRole: 'alert' } as any)}>
            <Text style={styles.confirmTitle}>Record this dispute review?</Text>
            <Text style={styles.confirmText}>
              {resolution === 'upheld'
                ? 'The recorded agreement stands.'
                : 'The extension is marked for correction. The shift schedule is not changed automatically; correct hours through timesheet and payroll review.'}
            </Text>
            <Text style={styles.confirmReason}>Note: {note.trim()}</Text>
          </View>
        ) : (
          <>
            <ProposalCard a={disputed} tz={tz} policy={policy} />
            <Text style={styles.sectionLabel}>Outcome</Text>
            <View style={styles.chips}>
              <Chip label="Agreement stands" selected={resolution === 'upheld'} onPress={() => setResolution('upheld')} />
              <Chip label="Needs correction" selected={resolution === 'corrected'} onPress={() => setResolution('corrected')} />
            </View>
            <Text style={styles.sectionLabel}>What you found (required)</Text>
            <TextInput style={styles.noteInput} multiline value={note} onChangeText={setNote} maxLength={AMENDMENT_TEXT_MAX}
              placeholderTextColor={colors.textMuted} accessibilityLabel="Dispute review note" />
          </>
        )
      ) : null}

      {mode !== 'view' && attempted && !confirming && !verdict.ok ? <Text style={styles.problem}>{verdict.message}</Text> : null}
    </Drawer>
  );
}

function ProposalCard({ a, tz, policy }: { a: ShiftAmendment; tz: string; policy: ShiftPolicy | null }) {
  const verbal = a.responseMethod === 'staff_recorded_verbal';
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Extension #{a.sequence} · {amendmentStatusLabel(a)}</Text>
      <Fact label="Original end" value={formatUkDateTime(a.originalEnd, tz)} />
      <Fact label="End before" value={formatUkDateTime(a.previousEnd, tz)} />
      <Fact label="Proposed end" value={`${formatUkDateTime(a.proposedEnd, tz)} (+${formatDuration(a.additionalMinutes)})`} />
      <Fact label="Reason" value={a.reason} />
      <Fact label="Management" value={approvalStatusText(a)} />
      <Fact label="Guard" value={guardResponseText(a)} />
      {a.status === 'pending' || a.status === 'awaiting_approval' ? <Fact label="Expires" value={formatUkDateTime(a.expiresAt, tz)} /> : null}
      {verbal ? (
        <>
          <Fact label="Contact" value={`${VERBAL_CONTACT_METHOD_OPTIONS.find((o) => o.value === a.verbalContactMethod)?.label ?? '—'} at ${formatUkDateTime(a.verbalContactAt, tz)}`} />
          <Fact label="Recorded" value={a.verbalConfirmation ?? '—'} />
          <Fact label="Email" value={confirmationEmailText(a.confirmationEmailStatus)} />
        </>
      ) : null}
      {a.disputeReason ? <Fact label="Dispute" value={a.disputeReason} /> : null}
      {a.fatigue.warnings.map((w) => (
        <Banner key={w} tone={w === 'SHORT_REST' || w === 'LONG_SHIFT' ? 'warning' : 'info'} text={warningText(w, policy, a.fatigue)} />
      ))}
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.factRow}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

function Banner({ tone, text }: { tone: 'danger' | 'warning' | 'info'; text: string; key?: string | number }) {
  const palette = tone === 'danger'
    ? { borderColor: colors.dangerBorder, backgroundColor: colors.dangerSurface, color: colors.danger }
    : tone === 'warning'
      ? { borderColor: colors.warningBorder, backgroundColor: colors.warningSurface, color: colors.warning }
      : { borderColor: colors.infoBorder, backgroundColor: colors.infoSurface, color: colors.info };
  return (
    <View style={[styles.banner, { borderColor: palette.borderColor, backgroundColor: palette.backgroundColor }]} {...({ accessibilityRole: tone === 'danger' ? 'alert' : 'text' } as any)}>
      <Text style={[styles.bannerText, { color: palette.color }]}>{text}</Text>
    </View>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void; key?: string | number }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={label} onPress={onPress}
      style={[styles.chip, selected ? styles.chipSelected : null, IS_WEB ? (WEB_PTR as any) : null]}>
      <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>{label}</Text>
    </Pressable>
  );
}

function Check({ label, checked, onPress }: { label: string; checked: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel={label} onPress={onPress}
      style={[styles.check, IS_WEB ? (WEB_PTR as any) : null]}>
      <Text style={[styles.checkMark, checked ? styles.checkMarkOn : null]}>{checked ? '☑' : '☐'}</Text>
      <Text style={styles.checkText}>{label}</Text>
    </Pressable>
  );
}

function Btn({ label, onPress, secondary, disabled, tone }: {
  label: string; onPress: () => void; secondary?: boolean; disabled?: boolean; tone?: 'primary' | 'confirm';
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} onPress={onPress} disabled={disabled}
      style={[secondary ? styles.secondaryBtn : styles.primaryBtn, tone === 'confirm' ? styles.primaryBtnConfirm : null,
        disabled ? styles.primaryBtnBusy : null, IS_WEB ? (WEB_PTR as any) : null]}>
      <Text style={secondary ? styles.secondaryBtnText : styles.primaryBtnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  facts: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: colors.surfaceSubtle,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 4,
  },
  factRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  factLabel: { width: 96, fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  factValue: { flex: 1, fontSize: 12, color: colors.textPrimary, fontWeight: '600' },
  sectionLabel: {
    fontSize: 10, fontWeight: '800', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: spacing.sm,
  },
  muted: { fontSize: 12, color: colors.textSecondary },
  policy: { fontSize: 11, color: colors.textSecondary, lineHeight: 16 },
  card: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, padding: spacing.md, gap: 4, backgroundColor: colors.card,
  },
  cardTitle: { fontSize: 13, fontWeight: '800', color: colors.primaryNavyStrong, marginBottom: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  history: { gap: spacing.sm },
  historyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: spacing.sm },
  historyTime: { width: 128, fontSize: 11, color: colors.textSecondary, fontWeight: '700' },
  historyBody: { flex: 1, minWidth: 200, gap: 2 },
  historyTitle: { fontSize: 12, fontWeight: '700', color: colors.textPrimary },
  historyDetail: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  flags: { fontSize: 11, color: colors.warning, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.fieldBorder },
  chipSelected: { borderColor: colors.accentTeal, backgroundColor: colors.surfaceSubtle },
  chipText: { fontSize: 12, color: colors.textPrimary },
  chipTextSelected: { fontWeight: '800' },
  check: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', paddingVertical: 6 },
  checkMark: { fontSize: 15, color: colors.textMuted },
  checkMarkOn: { color: colors.accentTeal },
  checkText: { flex: 1, fontSize: 12, color: colors.textPrimary, lineHeight: 18 },
  input: {
    borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.sm, padding: spacing.sm, fontSize: 13,
    color: colors.textPrimary, backgroundColor: colors.card, maxWidth: 220,
  },
  noteInput: {
    minHeight: 72, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.sm, padding: spacing.sm,
    fontSize: 13, color: colors.textPrimary, backgroundColor: colors.card, textAlignVertical: 'top',
  },
  banner: { borderWidth: 1, borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  bannerText: { fontSize: 12, fontWeight: '700', lineHeight: 17 },
  confirmPanel: {
    marginTop: spacing.sm, padding: spacing.md, gap: spacing.xs, borderRadius: radii.sm, borderWidth: 1,
    borderColor: colors.warning, backgroundColor: colors.warningSurface,
  },
  confirmTitle: { fontSize: 14, fontWeight: '800', color: colors.primaryNavyStrong },
  confirmText: { fontSize: 12, color: colors.textPrimary, lineHeight: 18 },
  confirmReason: { fontSize: 12, fontWeight: '700', color: colors.textPrimary },
  problem: { fontSize: 12, color: colors.danger, fontWeight: '700' },
  footer: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  secondaryBtn: { paddingHorizontal: spacing.md, paddingVertical: 9, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.fieldBorder },
  secondaryBtnText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  primaryBtn: { paddingHorizontal: spacing.md, paddingVertical: 9, borderRadius: radii.sm, backgroundColor: colors.primaryNavy },
  primaryBtnConfirm: { backgroundColor: colors.warning },
  primaryBtnBusy: { opacity: 0.7 },
  primaryBtnText: { fontSize: 13, fontWeight: '800', color: colors.textOnBrand },
});
