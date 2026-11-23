import * as React from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';
import { StatusBadge } from '../StatusBadge';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { FilterBar } from '../ui/FilterBar';
import { FieldTextarea, FormField } from '../ui/FormField';
import {
  ApiError, decideCompanyVerification, formatApiErrorMessage, getCompanyVerificationHistory, listCompanyVerification,
} from '../../services/api';
import {
  VERIFICATION_LIST_FILTERS, VERIFICATION_REASON_MAX, VERIFICATION_STATUS_LABEL, VERIFICATION_STATUS_TONE,
  countByVerificationStatus, filterVerificationCompanies, verificationActionsFor, verificationConfirmation,
  verificationDecisionError, verificationHistoryTitle, verificationReasonError,
  type AdminVerificationCompany, type VerificationAction, type VerificationHistoryEntry, type VerificationListFilter,
} from '../../navigation/company-verification';

const when = (value?: string | null) => (value ? new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not recorded');
const textOr = (value: unknown, fallback = 'Not provided') => (value === null || value === undefined || String(value).trim() === '' ? fallback : String(value));

/**
 * S4-CV-01 Platform Admin: Company Verification. Lists companies by verification state, shows each company's
 * registration details and verification history (from the audit log), and records Approve / Reject / Suspend /
 * Reinstate decisions through PUT /admin/companies/:id/verification. The backend enforces the transitions, the
 * mandatory reasons and the compare-and-set; this screen only offers what it would accept and confirms each decision.
 */
export function CompanyVerificationPanel() {
  const wide = useWindowDimensions().width >= 1100;
  const [rows, setRows] = React.useState<AdminVerificationCompany[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<VerificationListFilter>('pending_verification');
  const [query, setQuery] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [history, setHistory] = React.useState<VerificationHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<VerificationAction | null>(null);
  const [reason, setReason] = React.useState('');
  const [reasonError, setReasonError] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true); setLoadError(null);
    try { setRows(await listCompanyVerification()); }
    catch (error) { setLoadError(formatApiErrorMessage(error, 'Unable to load company verification. Retry or check service health.')); }
    finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const loadHistory = React.useCallback(async (companyId: number) => {
    setHistory(null); setHistoryError(null);
    try { setHistory(await getCompanyVerificationHistory(companyId)); }
    catch (error) { setHistoryError(formatApiErrorMessage(error, 'The verification history could not be loaded.')); }
  }, []);

  const counts = React.useMemo(() => countByVerificationStatus(rows), [rows]);
  const visible = React.useMemo(() => filterVerificationCompanies(rows, filter, query), [rows, filter, query]);
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const actions = verificationActionsFor(selected?.verificationStatus);

  const resetDecision = () => { setPending(null); setReason(''); setReasonError(null); setConfirming(false); };
  const open = (row: AdminVerificationCompany) => { setSelectedId(row.id); setFeedback(null); resetDecision(); void loadHistory(row.id); };
  const close = () => { setSelectedId(null); setHistory(null); setFeedback(null); resetDecision(); };

  const begin = (action: VerificationAction) => {
    setFeedback(null); setReasonError(null); setReason('');
    setPending(action);
    // Approve and Reinstate need no reason: straight to the confirmation.
    if (!action.reasonRequired) setConfirming(true);
  };
  const continueWithReason = () => {
    if (!pending) return;
    const problem = verificationReasonError(pending, reason);
    setReasonError(problem);
    if (!problem) setConfirming(true);
  };
  const submit = async () => {
    if (!selected || !pending) return;
    setSaving(true);
    const decided = pending;
    try {
      const updated = await decideCompanyVerification(selected.id, decided.target, decided.reasonRequired ? reason : undefined);
      setRows((current) => current.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)));
      setFeedback({ tone: 'success', message: `${updated.name} is now ${VERIFICATION_STATUS_LABEL[updated.verificationStatus].toLocaleLowerCase()}. The decision is recorded in the audit history.` });
      resetDecision();
      void loadHistory(updated.id);
    } catch (error) {
      const body = error instanceof ApiError ? (error.body as { code?: string } | null) : null;
      const status = error instanceof ApiError ? error.status : undefined;
      setFeedback({ tone: 'error', message: verificationDecisionError(status, body?.code ?? undefined, formatApiErrorMessage(error, 'The decision was not saved. Try again.')) });
      resetDecision();
      // A conflict means someone else decided first: show the company as it now is.
      if (status === 409) { void load(); void loadHistory(selected.id); }
    } finally { setSaving(false); }
  };

  const confirmation = pending && selected ? verificationConfirmation(pending, selected.name) : null;

  const list = (
    <View style={styles.listColumn}>
      <View style={styles.counts}>
        {(['pending_verification', 'approved', 'rejected', 'suspended'] as const).map((status) => (
          <Pressable key={status} accessibilityRole="button" accessibilityLabel={`${VERIFICATION_STATUS_LABEL[status]}: ${counts[status]} companies`}
            onPress={() => { setFilter(status); close(); }} style={[styles.countCard, filter === status && styles.countCardActive]}>
            <Text style={styles.countLabel}>{VERIFICATION_STATUS_LABEL[status]}</Text>
            <Text style={styles.countValue}>{loading && !rows.length ? '—' : counts[status]}</Text>
          </Pressable>
        ))}
      </View>
      <FilterBar
        searchValue={query}
        onSearchChange={setQuery}
        searchPlaceholder="Search name, company number, owner email or address"
        filters={VERIFICATION_LIST_FILTERS.map((option) => ({ id: option.key, label: option.label, active: filter === option.key, onToggle: () => { setFilter(option.key); close(); } }))}
      />
      {loadError ? <View style={styles.errorBox}><Text style={styles.errorText}>{loadError}</Text><Button label="Retry" variant="secondary" size="sm" onPress={() => void load()} /></View> : null}
      {loading && !rows.length ? <Text style={styles.muted}>Loading companies…</Text> : null}
      {!loading && !loadError && !visible.length ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{query ? 'No matching companies' : filter === 'pending_verification' ? 'No companies are waiting for verification' : `No ${filter === 'all' ? '' : VERIFICATION_STATUS_LABEL[filter].toLocaleLowerCase() + ' '}companies`}</Text>
          <Text style={styles.muted}>{query ? 'Clear or change the search.' : 'Newly registered companies appear under Pending.'}</Text>
        </View>
      ) : null}
      {visible.map((row) => (
        <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={`Open ${row.name} verification`} accessibilityState={{ selected: row.id === selectedId }}
          onPress={() => open(row)} style={[styles.row, row.id === selectedId && styles.rowActive]}>
          <View style={styles.rowCopy}>
            <Text style={styles.rowTitle}>{row.name}</Text>
            <Text style={styles.muted}>Company no. {textOr(row.companyNumber)} · {textOr(row.owner?.email, 'No owner email')}</Text>
            <Text style={styles.muted}>{row.verificationStatus === 'pending_verification' ? `Registered ${when(row.registeredAt)}` : `Decided ${when(row.verificationDecidedAt)}`}</Text>
          </View>
          <StatusBadge label={VERIFICATION_STATUS_LABEL[row.verificationStatus]} tone={VERIFICATION_STATUS_TONE[row.verificationStatus]} />
        </Pressable>
      ))}
    </View>
  );

  const detail = selected ? (
    <View style={styles.detail} accessibilityLabel={`${selected.name} verification detail`}>
      <View style={styles.detailHead}>
        <View style={styles.rowCopy}>
          <Text style={styles.detailTitle}>{selected.name}</Text>
          <Text style={styles.muted}>Company #{selected.id}</Text>
        </View>
        <StatusBadge label={VERIFICATION_STATUS_LABEL[selected.verificationStatus]} tone={VERIFICATION_STATUS_TONE[selected.verificationStatus]} />
      </View>

      <Text style={styles.sectionLabel}>REGISTRATION DETAILS</Text>
      {([
        ['Company name', selected.name],
        ['Company number', selected.companyNumber],
        ['Registered address', selected.address],
        ['Contact details', selected.contactDetails],
        ['Owner email', selected.owner?.email],
        ['Owner phone', selected.owner?.phone],
        ['Registered', when(selected.registeredAt)],
      ] as Array<[string, unknown]>).map(([label, value]) => (
        <View key={label} style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><Text style={styles.fieldValue}>{textOr(value)}</Text></View>
      ))}

      {selected.verificationNote ? (
        <View style={styles.noteBox}>
          <Text style={styles.fieldLabel}>{selected.verificationStatus === 'suspended' ? 'Suspension reason (shown to the company)' : selected.verificationStatus === 'rejected' ? 'Rejection reason (shown to the company)' : 'Note shown to the company'}</Text>
          <Text style={styles.fieldValue}>{selected.verificationNote}</Text>
          <Text style={styles.muted}>Decided {when(selected.verificationDecidedAt)}</Text>
        </View>
      ) : null}

      {feedback ? (
        <View accessibilityLiveRegion="polite" style={feedback.tone === 'success' ? styles.successBox : styles.errorBox}>
          <Text style={feedback.tone === 'success' ? styles.successText : styles.errorText}>{feedback.message}</Text>
        </View>
      ) : null}

      <Text style={styles.sectionLabel}>DECISION</Text>
      {actions.length ? (
        <View style={styles.actions}>
          {actions.map((action) => (
            <View key={action.key}>
              <Button label={action.label} variant={action.danger ? 'danger' : 'primary'} size="md"
                disabled={saving || (pending?.key === action.key && action.reasonRequired)} onPress={() => begin(action)} />
            </View>
          ))}
        </View>
      ) : <Text style={styles.muted}>No decision is available for this state.</Text>}
      {selected.verificationStatus === 'rejected' ? <Text style={styles.muted}>A rejected company can correct its details and ask S4 to reconsider; it then returns to Pending.</Text> : null}

      {pending?.reasonRequired ? (
        <View style={styles.reasonBox}>
          <FormField label={pending.key === 'reject' ? 'Reason for rejection' : 'Reason for suspension'} required
            helperText="The company is shown this reason. Be specific about what is wrong and what it can do."
            error={reasonError ?? undefined}>
            <FieldTextarea accessibilityLabel={pending.key === 'reject' ? 'Reason for rejection' : 'Reason for suspension'}
              value={reason} onChangeText={(value: string) => { setReason(value); if (reasonError) setReasonError(null); }}
              maxLength={VERIFICATION_REASON_MAX} hasError={!!reasonError} minLines={3}
              placeholder={pending.key === 'reject' ? 'e.g. The company number does not match the registered name.' : 'e.g. Insurance certificate has expired.'} />
          </FormField>
          <Text style={styles.muted}>{reason.trim().length}/{VERIFICATION_REASON_MAX}</Text>
          <View style={styles.actions}>
            <Button label="Cancel" variant="secondary" size="md" onPress={resetDecision} disabled={saving} />
            <Button label={`Continue to ${pending.label.toLocaleLowerCase()}`} variant="danger" size="md" onPress={continueWithReason} disabled={saving} />
          </View>
        </View>
      ) : null}

      <Text style={styles.sectionLabel}>VERIFICATION HISTORY</Text>
      {historyError ? <Text style={styles.errorText}>{historyError}</Text> : null}
      {!history && !historyError ? <Text style={styles.muted}>Loading history…</Text> : null}
      {history && !history.length ? <Text style={styles.muted}>{selected.verificationStatus === 'approved' && !selected.verificationDecidedAt ? 'No decisions recorded. This company existed before verification was introduced and was approved automatically.' : 'No verification decisions yet.'}</Text> : null}
      {history?.map((entry) => (
        <View key={entry.id} style={styles.historyRow}>
          <Text style={styles.rowTitle}>{verificationHistoryTitle(entry)}</Text>
          <Text style={styles.muted}>{when(entry.at)} · {entry.actor ? `${entry.actor.email} (${entry.actor.role === 'admin' ? 'S4 Platform Admin' : 'company'})` : 'System'}</Text>
          {entry.note ? <Text style={styles.fieldValue}>“{entry.note}”</Text> : null}
        </View>
      ))}

      <Pressable accessibilityRole="button" onPress={close}><Text style={styles.link}>Close</Text></Pressable>
    </View>
  ) : null;

  return (
    <View style={styles.root}>
      <View style={styles.headerRow}>
        <Text style={styles.intro}>Approve new companies before they can publish jobs, invite Guards or create shifts. Rejection and suspension reasons are shown to the company. Every decision is recorded in the audit history.</Text>
        <Button label={loading ? 'Loading…' : 'Refresh'} variant="secondary" size="sm" onPress={() => { void load(); if (selectedId) void loadHistory(selectedId); }} disabled={loading} />
      </View>
      <View style={[styles.layout, wide && styles.layoutWide]}>
        <View style={wide ? styles.half : null}>{list}</View>
        {detail ? <View style={wide ? styles.half : null}>{detail}</View> : null}
      </View>
      {confirmation ? (
        <ConfirmationDialog
          visible={confirming}
          onClose={() => { if (!saving) { setConfirming(false); if (!pending?.reasonRequired) setPending(null); } }}
          onConfirm={() => void submit()}
          title={confirmation.title}
          message={pending?.reasonRequired ? `${confirmation.message}\n\nReason: “${reason.trim()}”` : confirmation.message}
          confirmLabel={confirmation.confirmLabel}
          variant={pending?.danger ? 'danger' : 'standard'}
          loading={saving}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.lg },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.lg, flexWrap: 'wrap' },
  intro: { ...typography.body, color: colors.textSecondary, flex: 1, minWidth: 260 },
  layout: { gap: spacing.lg },
  layoutWide: { flexDirection: 'row', alignItems: 'flex-start' },
  half: { flex: 1, minWidth: 0 },
  listColumn: { gap: spacing.md },
  counts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  countCard: { flexGrow: 1, minWidth: 120, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  countCardActive: { borderColor: colors.primaryNavy, borderWidth: 2 },
  countLabel: { ...typography.label, color: colors.textSecondary },
  countValue: { fontSize: 26, lineHeight: 30, fontWeight: '700', color: colors.textPrimary },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  rowActive: { borderColor: colors.primaryNavy, borderWidth: 2 },
  rowCopy: { flex: 1, gap: 2, minWidth: 0 },
  rowTitle: { ...typography.bodyStrong, color: colors.textPrimary },
  muted: { ...typography.caption, color: colors.textSecondary },
  empty: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: spacing.xl, alignItems: 'center', gap: spacing.xs },
  emptyTitle: { ...typography.bodyStrong, color: colors.textPrimary, textAlign: 'center' },
  detail: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.sm },
  detailHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  detailTitle: { ...typography.heading, color: colors.textPrimary },
  sectionLabel: { ...typography.label, color: colors.textSecondary, letterSpacing: 0.5, marginTop: spacing.md },
  field: { gap: 2, paddingVertical: spacing.xs, borderBottomColor: colors.border, borderBottomWidth: 1 },
  fieldLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  fieldValue: { ...typography.body, color: colors.textPrimary },
  noteBox: { backgroundColor: colors.warningSurface, borderColor: colors.warningBorder, borderWidth: 1, borderRadius: radii.md, padding: spacing.md, gap: 4, marginTop: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  reasonBox: { backgroundColor: colors.surfaceSubtle, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  historyRow: { borderLeftColor: colors.accentTeal, borderLeftWidth: 3, paddingLeft: spacing.md, paddingVertical: spacing.xs, gap: 2 },
  successBox: { backgroundColor: colors.successSurface, borderColor: colors.successBorder, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  successText: { ...typography.body, color: colors.success },
  errorBox: { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder, borderWidth: 1, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  errorText: { ...typography.body, color: colors.danger },
  link: { ...typography.label, color: colors.primaryNavy, paddingVertical: spacing.sm },
});
