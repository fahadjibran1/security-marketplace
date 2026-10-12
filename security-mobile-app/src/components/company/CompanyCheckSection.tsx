import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type {
  CompanyCheckSummary,
  ComplianceCheck,
  ComplianceCheckKind,
  GuardComplianceSummary,
  GuardDocument,
  RecordComplianceCheckPayload,
} from '../../types/models';
import { colors, radii, spacing } from '../../theme';
import { StatusBadge } from '../StatusBadge';
import { Button } from '../ui/Button';
import { FieldInput, FormField } from '../ui/FormField';
import {
  CheckForm,
  correctionForm,
  describeCheck,
  excusesForMethod,
  expiryFieldFor,
  initialCheckForm,
  methodsFor,
  validateCheckForm,
  workRestrictionNotice,
} from './compliance-checks';
import { daysUntil, rightToWorkIndicator, siaIndicator } from './compliance-model';
import { documentTypeLabel } from './compliance-selection';
import { formatUkDate, UK_DATE_PLACEHOLDER } from './ukDate';

const IS_WEB = typeof document !== 'undefined';

export type CheckFormMode = 'new' | 'correction';

export type CompanyCheckSectionProps = {
  kind: ComplianceCheckKind;
  guardId: number;
  summary: GuardComplianceSummary;
  canManage: boolean;
  /** Which form is open for this section, if any (owned by the drawer so a blocker can open it). */
  formMode: CheckFormMode | null;
  onOpenForm: (mode: CheckFormMode) => void;
  onCloseForm: () => void;
  /** Resolves to an error message, or null on success. */
  onSubmit: (payload: RecordComplianceCheckPayload) => Promise<string | null>;
  onLoadHistory: () => Promise<ComplianceCheck[]>;
};

function Row({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValue}>{children}</View>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

/**
 * One company check (SIA licence, or right to work) in the Company Compliance drawer: the company's
 * current check, the Guard's own declaration for reference, Record / Update / Correct, and the history.
 *
 * The declaration is shown but never copied into the form and never counts: only a check the company
 * records here satisfies the requirement.
 */
export function CompanyCheckSection(props: CompanyCheckSectionProps) {
  const { kind, guardId, summary, canManage, formMode } = props;
  const current: CompanyCheckSummary | null =
    (kind === 'sia' ? summary.companyChecks?.sia : summary.companyChecks?.rightToWork) ?? null;
  const indicator = kind === 'sia' ? siaIndicator(summary) : rightToWorkIndicator(summary);
  const title = kind === 'sia' ? 'SIA licence' : 'Right to work';
  const evidenceType = kind === 'sia' ? 'sia_licence' : 'right_to_work';
  const linkable = (summary.documents ?? []).filter(
    (document: GuardDocument) => document.type === evidenceType && document.uploadCompletedAt,
  );

  const [form, setForm] = React.useState<CheckForm>(() => initialCheckForm(kind, current));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<ComplianceCheck[] | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string | null>(null);

  // A new mode resets the form. A correction starts from the record as it stands; its evidence reference
  // is only available to managers through the history, so it is filled in from there when it loads.
  React.useEffect(() => {
    if (!formMode) return;
    setError(null);
    if (formMode === 'correction' && current) {
      setForm(correctionForm(kind, current));
      props.onLoadHistory().then((rows) => {
        const row = rows.find((item) => item.id === current.id);
        if (row) setForm((previous) => ({ ...previous, evidenceReference: row.evidenceReference ?? '', evidenceDocumentId: row.evidenceDocumentId ?? null }));
      }).catch(() => undefined);
    } else {
      setForm(initialCheckForm(kind, current));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formMode, current?.id]);

  const update = (patch: Partial<CheckForm>) => {
    setForm((previous) => ({ ...previous, ...patch }));
    if (error) setError(null);
  };

  const chooseMethod = (method: string) => {
    const allowed = excusesForMethod(method).map((option) => option.value);
    update({ method, excuse: allowed.includes(form.excuse) ? form.excuse : allowed.length === 1 ? allowed[0] : '' });
  };

  const submit = async () => {
    const result = validateCheckForm(kind, guardId, form, current);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await props.onSubmit(result.payload);
    setBusy(false);
    if (failure) setError(failure);
    else {
      setHistory(null);
      setHistoryOpen(false);
      props.onCloseForm();
    }
  };

  const toggleHistory = async () => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    setHistoryError(null);
    try {
      setHistory(await props.onLoadHistory());
    } catch {
      setHistoryError('The check history could not be loaded. Try again.');
    }
  };

  const expiry = expiryFieldFor(kind, form);
  const isEcs = kind === 'right_to_work' && form.method === 'employer_checking_service';
  const methods = methodsFor(kind);
  const selectedMethod = methods.find((option) => option.value === form.method);
  const declared = kind === 'sia'
    ? [summary.siaLicenceNumber ? `number ${summary.siaLicenceNumber}` : 'no number', summary.siaExpiryDate ? `expiry ${formatUkDate(summary.siaExpiryDate)}` : 'no expiry date']
    : [summary.rightToWorkStatus ? `status ${summary.rightToWorkStatus}` : 'no status', summary.rightToWorkExpiryDate ? `expiry ${formatUkDate(summary.rightToWorkExpiryDate)}` : 'no expiry date'];
  const noun = kind === 'sia' ? 'SIA licence check' : 'right to work check';

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Row label="Your check">
        <StatusBadge label={indicator.label} tone={indicator.tone} size="small" />
      </Row>

      {current ? (
        <View style={styles.card}>
          <Text style={styles.cardText}>{describeCheck(kind, current)}</Text>
          {kind === 'sia' && current.licenceNumber ? <Text style={styles.meta}>Licence {current.licenceNumber}</Text> : null}
          {kind === 'right_to_work' && current.outcome === 'confirmed' && current.rightToWorkExcuse !== 'continuous' && current.expiryDate ? (
            <Text style={styles.meta}>
              {(daysUntil(current.expiryDate) ?? 0) < 0
                ? `The permission ended on ${formatUkDate(current.expiryDate)}. A follow-up check is needed before this Guard can work.`
                : `Follow-up check due by ${formatUkDate(current.expiryDate)}.`}
            </Text>
          ) : null}
          {kind === 'right_to_work' && workRestrictionNotice(summary) ? (
            <View style={styles.warning} accessibilityRole="alert">
              <Text style={styles.warningText}>{workRestrictionNotice(summary)}</Text>
            </View>
          ) : null}
          <Text style={styles.meta}>Checked by {current.checkedByName}</Text>
        </View>
      ) : (
        <Text style={styles.hint}>
          Your company has not recorded a {kind === 'sia' ? 'SIA licence' : 'right to work'} check for this Guard. It is needed before they can be put on the rota.
        </Text>
      )}

      <Text style={styles.declared}>Declared by the Guard, for reference only: {declared.join(', ')}. This does not count as your check.</Text>

      {canManage && !formMode ? (
        <View style={styles.actions}>
          <Button
            label={current ? `Update ${kind === 'sia' ? 'SIA' : 'right to work'} check` : `Record ${kind === 'sia' ? 'SIA' : 'right to work'} check`}
            variant={current ? 'secondary' : 'primary'}
            size="sm"
            onPress={() => props.onOpenForm('new')}
          />
          {current ? <Button label="Correct this record" variant="tertiary" size="sm" onPress={() => props.onOpenForm('correction')} /> : null}
          <Button label={historyOpen ? 'Hide history' : 'History'} variant="tertiary" size="sm" onPress={toggleHistory} />
        </View>
      ) : null}
      {!canManage ? (
        <View style={styles.actions}>
          <Button label={historyOpen ? 'Hide history' : 'History'} variant="tertiary" size="sm" onPress={toggleHistory} />
        </View>
      ) : null}

      {historyOpen ? (
        <View style={styles.history}>
          {historyError ? <Text style={styles.error}>{historyError}</Text> : null}
          {!historyError && history === null ? <Text style={styles.hint}>Loading history…</Text> : null}
          {history && history.filter((row) => row.kind === kind).length === 0 ? <Text style={styles.hint}>No checks recorded yet.</Text> : null}
          {(history ?? []).filter((row) => row.kind === kind).map((row) => (
            <View key={row.id} style={styles.historyRow}>
              <View style={styles.historyHead}>
                <Text style={styles.historyText}>{describeCheck(kind, row)}</Text>
                <StatusBadge label={row.supersededAt ? 'Replaced' : 'Current'} tone={row.supersededAt ? 'neutral' : 'info'} size="small" />
              </View>
              <Text style={styles.meta}>
                {row.changeType === 'correction' ? 'Correction' : 'Check'} recorded {formatUkDate(String(row.createdAt).slice(0, 10))} · checked by {row.checkedByName}
              </Text>
              {row.changeReason ? <Text style={styles.meta}>Reason: {row.changeReason}</Text> : null}
              {row.evidenceReference ? <Text style={styles.meta}>Evidence: {row.evidenceReference}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}

      {canManage && formMode ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>
            {formMode === 'correction' ? `Correct ${noun}` : current ? `Update ${noun}` : `Record ${noun}`}
          </Text>
          <Text style={styles.hint}>
            {formMode === 'correction'
              ? 'Use this only if the current record was entered wrongly. The original stays in the history.'
              : current
                ? 'Record a new check, for example a follow-up check or a renewed licence. The previous check stays in the history.'
                : 'Record the check your company carried out. Only your company can see it, and it does not change the Guard’s own details.'}
          </Text>

          <FormField label="Result" required>
            <View style={styles.chips}>
              <Chip label={kind === 'sia' ? 'Active licence confirmed' : 'Right to work confirmed'} active={form.outcome === 'confirmed'} onPress={() => update({ outcome: 'confirmed' })} />
              <Chip label="Not confirmed" active={form.outcome === 'not_confirmed'} onPress={() => update({ outcome: 'not_confirmed' })} />
            </View>
          </FormField>

          <FormField label="How it was checked" required helperText={selectedMethod?.help}>
            <View style={styles.chips}>
              {methods.map((option) => (
                <View key={option.value}>
                  <Chip label={option.label} active={form.method === option.value} onPress={() => chooseMethod(option.value)} />
                </View>
              ))}
            </View>
          </FormField>

          {kind === 'right_to_work' && form.outcome === 'confirmed' ? (
            <FormField
              label="Type of right to work"
              required
              helperText={excusesForMethod(form.method).find((option) => option.value === form.excuse)?.help}
            >
              <View style={styles.chips}>
                {excusesForMethod(form.method).map((option) => (
                  <View key={option.value}>
                    <Chip
                      label={option.label}
                      active={form.excuse === option.value}
                      onPress={() => update({ excuse: option.value, expiryDate: option.value === 'continuous' ? '' : form.expiryDate })}
                    />
                  </View>
                ))}
              </View>
            </FormField>
          ) : null}

          {kind === 'sia' ? (
            <FormField label="SIA licence number checked" required helperText="The 16-digit number you checked.">
              <FieldInput value={form.licenceNumber} onChangeText={(next: string) => update({ licenceNumber: next })} keyboardType="number-pad" autoCapitalize="none" />
            </FormField>
          ) : null}

          <FormField label={isEcs ? 'Date of the Positive Verification Notice' : 'Date of the check'} required helperText={`Use ${UK_DATE_PLACEHOLDER}.`}>
            <FieldInput value={form.checkDate} onChangeText={(next: string) => update({ checkDate: next })} placeholder={UK_DATE_PLACEHOLDER} autoCapitalize="none" keyboardType="numbers-and-punctuation" />
          </FormField>

          {expiry.show ? (
            <FormField label={expiry.label} required={expiry.required} helperText={`Use ${UK_DATE_PLACEHOLDER}.`}>
              <FieldInput value={form.expiryDate} onChangeText={(next: string) => update({ expiryDate: next })} placeholder={UK_DATE_PLACEHOLDER} autoCapitalize="none" keyboardType="numbers-and-punctuation" />
            </FormField>
          ) : null}

          {kind === 'right_to_work' ? (
            <FormField
              label="Work restrictions (optional)"
              helperText="Any condition shown by this check, for example limited hours in term time. Recording it does not approve any shift: S4 does not check rotas against it."
            >
              <FieldInput value={form.workRestrictions} onChangeText={(next: string) => update({ workRestrictions: next })} />
            </FormField>
          ) : null}

          <FormField label="Checked by" required helperText="The person who carried out the check.">
            <FieldInput value={form.checkedByName} onChangeText={(next: string) => update({ checkedByName: next })} />
          </FormField>

          <FormField
            label={form.evidenceDocumentId ? 'Evidence reference (optional)' : 'Evidence reference'}
            required={!form.evidenceDocumentId}
            helperText="Where your copy of the evidence is kept, for example an HR file reference. Do not enter share codes, passport or visa numbers."
          >
            <FieldInput value={form.evidenceReference} onChangeText={(next: string) => update({ evidenceReference: next })} />
          </FormField>

          {linkable.length ? (
            <FormField label="Link an uploaded document (optional)" helperText="Linking does not verify the document. Verify it separately under Documents.">
              <View style={styles.chips}>
                <Chip label="None" active={form.evidenceDocumentId === null} onPress={() => update({ evidenceDocumentId: null })} />
                {linkable.map((document) => (
                  <View key={document.id}>
                    <Chip
                      label={`${documentTypeLabel(String(document.type))}: ${document.originalFileName || `#${document.id}`}`}
                      active={form.evidenceDocumentId === document.id}
                      onPress={() => update({ evidenceDocumentId: document.id })}
                    />
                  </View>
                ))}
              </View>
            </FormField>
          ) : null}

          {formMode === 'correction' ? (
            <FormField label="Reason for the correction" required>
              <FieldInput value={form.changeReason} onChangeText={(next: string) => update({ changeReason: next })} />
            </FormField>
          ) : null}

          {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
          <View style={styles.actions}>
            <Button label="Save check" onPress={submit} loading={busy} size="sm" />
            <Button label="Cancel" variant="tertiary" size="sm" onPress={props.onCloseForm} disabled={busy} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.xs, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, gap: spacing.md },
  rowLabel: { fontSize: 13, color: colors.textSecondary },
  rowValue: { flexShrink: 1, alignItems: 'flex-end' },
  card: { gap: 3, padding: spacing.sm, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  cardText: { fontSize: 13, color: colors.textPrimary, fontWeight: '600', lineHeight: 18 },
  hint: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  declared: { fontSize: 12, color: colors.textSecondary, lineHeight: 17, fontStyle: 'italic' },
  meta: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  error: { fontSize: 13, color: colors.danger, fontWeight: '600' },
  warning: { padding: spacing.sm, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.surfaceSubtle, marginTop: 2 },
  warningText: { fontSize: 12, color: colors.textPrimary, lineHeight: 17, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  history: { gap: spacing.xs, marginTop: spacing.xs },
  historyRow: { gap: 2, padding: spacing.sm, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSubtle },
  historyHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.sm, flexWrap: 'wrap' },
  historyText: { flex: 1, minWidth: 160, fontSize: 12, color: colors.textPrimary, fontWeight: '600', lineHeight: 17 },
  panel: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.accentTeal,
    backgroundColor: colors.card,
    marginTop: spacing.xs,
  },
  panelTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    ...(IS_WEB ? ({ cursor: 'pointer' } as any) : {}),
  },
  chipActive: { backgroundColor: colors.primaryNavy, borderColor: colors.primaryNavy },
  chipText: { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: '#FFFFFF' },
});
