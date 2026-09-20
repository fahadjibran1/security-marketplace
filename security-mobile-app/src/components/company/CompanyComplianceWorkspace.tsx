import * as React from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  accessGuardDocument,
  formatApiErrorMessage,
  listCompanyGuardComplianceStatuses,
  listCompanyGuards,
  listGuardDocuments,
  saveComplianceRecord,
  verifyGuardDocument,
} from '../../services/api';
import {
  CompanyGuard,
  ComplianceRecordPayload,
  ComplianceRecordType,
  GuardComplianceStatus,
  GuardComplianceSummary,
  GuardDocument,
} from '../../types/models';
import { colors } from '../../theme';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import {
  buildVerificationDialog,
  createRequestGate,
  documentBelongsToGuard,
  documentsForGuard,
  documentTypeLabel,
  DocumentsState,
  findActiveSummary,
  getDocumentPresentation,
  resolveActiveGuardId,
} from './compliance-selection';

type FormState = {
  guardId: string;
  type: ComplianceRecordType;
  documentName: string;
  documentNumber: string;
  issueDate: string;
  expiryDate: string;
};

const EMPTY_FORM: FormState = {
  guardId: '',
  type: 'SIA',
  documentName: '',
  documentNumber: '',
  issueDate: '',
  expiryDate: '',
};

const TYPES: ComplianceRecordType[] = ['SIA', 'RIGHT_TO_WORK', 'TRAINING', 'OTHER'];
const FILTERS: Array<{ value: 'all' | GuardComplianceStatus; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'valid', label: 'Valid' },
  { value: 'expiring', label: 'Expiring' },
  { value: 'expired', label: 'Expired' },
  { value: 'invalid', label: 'Invalid' },
];

function formatDate(value?: string | null) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB');
}

function typeLabel(type?: string | null) {
  if (type === 'RIGHT_TO_WORK') return 'Right to work';
  return (type || 'Other').replace(/_/g, ' ');
}

function getStatusTone(status?: string | null) {
  if (status === 'invalid') return styles.statusInvalid;
  if (status === 'expired') return styles.statusExpired;
  if (status === 'expiring') return styles.statusExpiring;
  return styles.statusValid;
}

function WebSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(typeof document !== 'undefined'), []);
  if (ready) {
    const SelectTag: any = 'select';
    const OptionTag: any = 'option';
    return (
      <SelectTag value={value} onChange={(event: any) => onChange(event.target.value)} style={webSelectStyle}>
        {options.map((option) => (
          <OptionTag key={option.value} value={option.value}>
            {option.label}
          </OptionTag>
        ))}
      </SelectTag>
    );
  }
  return <TextInput value={value} onChangeText={onChange} style={styles.input} />;
}

function GuardDocumentsList({
  documents,
  canManageCompliance,
  onVerify,
  onView,
  verifyingId,
  viewingId,
}: {
  documents: GuardDocument[];
  canManageCompliance: boolean;
  onVerify: (document: GuardDocument, verified: boolean) => void;
  onView: (document: GuardDocument) => void;
  verifyingId: number | null;
  viewingId: number | null;
}) {
  if (!documents.length) {
    return <Text style={styles.helperText}>No guard documents uploaded yet.</Text>;
  }

  return (
    <View style={styles.documentList}>
      {documents.map((document) => {
        const view = getDocumentPresentation(document, canManageCompliance);
        return (
          <View key={document.id} style={styles.documentRow}>
            <View style={styles.flexGrow}>
              <Text style={styles.documentTitle}>{documentTypeLabel(String(document.type))}</Text>
              <Text style={styles.helperText}>Expiry: {formatDate(document.expiryDate)} | Uploaded: {formatDate(document.uploadedAt)}</Text>
              <Text style={styles.documentUrl}>{document.originalFileName || 'Private evidence'}</Text>
              {!view.uploadComplete ? (
                <Text style={styles.helperText}>The upload was not completed, so this evidence cannot be viewed or verified.</Text>
              ) : null}
              {view.evidenceRestricted ? (
                <Text style={styles.helperText}>Evidence files are restricted to compliance managers.</Text>
              ) : null}
            </View>
            <View style={styles.documentActions}>
              <View style={[styles.statusPill, document.verified && view.uploadComplete ? styles.statusValid : styles.statusMissing]}>
                <Text style={styles.statusText}>{view.statusLabel}</Text>
              </View>
              {view.expired ? (
                <View style={[styles.statusPill, styles.statusExpired]}>
                  <Text style={styles.statusText}>Expired</Text>
                </View>
              ) : null}
              {view.canView ? (
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => onView(document)}
                  disabled={viewingId === document.id}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${documentTypeLabel(String(document.type))} document`}
                >
                  <Text style={styles.secondaryButtonText}>{viewingId === document.id ? 'Opening...' : 'View document'}</Text>
                </Pressable>
              ) : null}
              {view.canToggleVerification ? (
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => onVerify(document, !document.verified)}
                  disabled={verifyingId === document.id}
                >
                  <Text style={styles.secondaryButtonText}>
                    {verifyingId === document.id ? 'Saving...' : document.verified ? 'Mark unverified' : 'Verify'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

type PendingVerification = {
  document: GuardDocument;
  verified: boolean;
  guardId: number;
  guardName: string;
};

/**
 * Open a signed, short-lived evidence URL. On web the tab is opened synchronously (inside the click) and
 * navigated once the URL arrives, so pop-up blockers do not swallow it and the evidence page gets no
 * `window.opener`. Returns a handle used to finish or abandon the navigation.
 */
function beginOpenEvidence(): { ok: boolean; finish: (url: string) => void; abandon: () => void } {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const tab = window.open('', '_blank');
    if (!tab) return { ok: false, finish: () => undefined, abandon: () => undefined };
    try {
      tab.opener = null;
    } catch {
      // Best effort: the tab is same-origin about:blank until navigated.
    }
    return {
      ok: true,
      finish: (url: string) => {
        tab.location.href = url;
      },
      abandon: () => tab.close(),
    };
  }
  return {
    ok: true,
    finish: (url: string) => {
      Linking.openURL(url).catch(() => undefined);
    },
    abandon: () => undefined,
  };
}

export function CompanyComplianceWorkspace({ canManageCompliance = false }: { canManageCompliance?: boolean } = {}) {
  const [companyGuards, setCompanyGuards] = React.useState<CompanyGuard[]>([]);
  const [summaries, setSummaries] = React.useState<GuardComplianceSummary[]>([]);
  const [documentsState, setDocumentsState] = React.useState<DocumentsState<GuardDocument>>({ guardId: null, items: [] });
  const [documentsLoading, setDocumentsLoading] = React.useState(false);
  const [documentsError, setDocumentsError] = React.useState<string | null>(null);
  // The Guard the manager last picked. The Guard the document panel is bound to is DERIVED from this and the
  // currently visible summaries (see activeGuardId) so the panel and its actions can never diverge.
  const [selectedGuardId, setSelectedGuardId] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<'all' | GuardComplianceStatus>('all');
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [verifyingId, setVerifyingId] = React.useState<number | null>(null);
  const [viewingId, setViewingId] = React.useState<number | null>(null);
  const [pendingVerification, setPendingVerification] = React.useState<PendingVerification | null>(null);
  const documentGate = React.useRef(createRequestGate());

  const activeGuardId = React.useMemo(
    () => resolveActiveGuardId(summaries, selectedGuardId),
    [summaries, selectedGuardId],
  );
  const selectedSummary = React.useMemo(
    () => findActiveSummary(summaries, activeGuardId),
    [summaries, activeGuardId],
  );

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextGuards, nextSummaries] = await Promise.all([
        listCompanyGuards(),
        listCompanyGuardComplianceStatuses(statusFilter === 'all' ? undefined : statusFilter),
      ]);
      setCompanyGuards(nextGuards);
      setSummaries(nextSummaries);
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load compliance records.') });
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  // Documents are fetched for the ACTIVE Guard only. Each request takes a token; a late response for a
  // previously active Guard is dropped, so it can never overwrite the panel of the Guard now selected.
  const loadDocuments = React.useCallback(async (guardIdValue: string) => {
    if (!guardIdValue) {
      documentGate.current.invalidate();
      setDocumentsState({ guardId: null, items: [] });
      setDocumentsError(null);
      setDocumentsLoading(false);
      return;
    }
    const guardId = Number(guardIdValue);
    const token = documentGate.current.next();
    setDocumentsLoading(true);
    setDocumentsError(null);
    try {
      const items = await listGuardDocuments(guardId);
      if (!documentGate.current.isCurrent(token)) return;
      setDocumentsState({ guardId, items });
    } catch (error) {
      if (!documentGate.current.isCurrent(token)) return;
      setDocumentsState({ guardId, items: [] });
      setDocumentsError(formatApiErrorMessage(error, 'Unable to load guard documents.'));
    } finally {
      if (documentGate.current.isCurrent(token)) setDocumentsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadDocuments(activeGuardId);
  }, [activeGuardId, loadDocuments]);

  // A confirmation belongs to the Guard it was opened for; drop it if the panel moves to another Guard.
  React.useEffect(() => {
    setPendingVerification((current) => (current && String(current.guardId) !== activeGuardId ? null : current));
  }, [activeGuardId]);

  const visibleDocuments = React.useMemo(
    () => documentsForGuard(documentsState, activeGuardId),
    [documentsState, activeGuardId],
  );

  // Selector for the document panel lists only Guards that are visible under the current filter.
  const viewerGuardOptions = React.useMemo(
    () => [
      { value: '', label: 'Choose guard' },
      ...summaries.map((summary) => ({ value: String(summary.guardId), label: summary.fullName })),
    ],
    [summaries],
  );

  const formGuardOptions = React.useMemo(
    () => [
      { value: '', label: 'Choose guard' },
      ...companyGuards
        .filter((item) => item.guard)
        .map((item) => ({ value: String(item.guard!.id), label: item.guard!.fullName })),
    ],
    [companyGuards],
  );

  const updateForm = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  const saveRecord = React.useCallback(async () => {
    const guardId = Number(form.guardId || activeGuardId);
    if (!guardId || !form.documentName.trim() || !form.expiryDate.trim()) {
      setFeedback({ tone: 'error', message: 'Choose a guard, document name, and expiry date before saving.' });
      return;
    }
    const payload: ComplianceRecordPayload = {
      guardId,
      type: form.type,
      documentName: form.documentName.trim(),
      documentNumber: form.documentNumber.trim() || null,
      issueDate: form.issueDate.trim() || null,
      expiryDate: form.expiryDate.trim(),
    };
    setSaving(true);
    try {
      await saveComplianceRecord(payload);
      setForm(EMPTY_FORM);
      setFeedback({ tone: 'success', message: 'Compliance record saved.' });
      await loadData();
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save compliance record.') });
    } finally {
      setSaving(false);
    }
  }, [form, loadData, activeGuardId]);

  const viewDocument = React.useCallback(async (document: GuardDocument) => {
    if (!selectedSummary || !documentBelongsToGuard(document, selectedSummary.guardId)) {
      setFeedback({ tone: 'error', message: 'This document does not belong to the selected guard. Reselect the guard and try again.' });
      return;
    }
    const target = beginOpenEvidence();
    if (!target.ok) {
      setFeedback({ tone: 'error', message: 'Your browser blocked the new tab. Allow pop-ups for this site, then choose View document again.' });
      return;
    }
    setViewingId(document.id);
    try {
      // Short-lived signed URL; the permanent storage location is never exposed to the browser.
      const access = await accessGuardDocument(document.id);
      target.finish(access.url);
      setFeedback({ tone: 'success', message: 'Document opened in a new tab. The secure link expires after a few minutes — choose View document again if it stops working.' });
    } catch (error) {
      target.abandon();
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to open this document. It may be unavailable or you may not have permission to view it.') });
    } finally {
      setViewingId(null);
    }
  }, [selectedSummary]);

  const requestVerification = React.useCallback((document: GuardDocument, verified: boolean) => {
    if (!selectedSummary || !documentBelongsToGuard(document, selectedSummary.guardId)) {
      setFeedback({ tone: 'error', message: 'This document does not belong to the selected guard. Reselect the guard and try again.' });
      return;
    }
    setPendingVerification({ document, verified, guardId: selectedSummary.guardId, guardName: selectedSummary.fullName });
  }, [selectedSummary]);

  const confirmVerification = React.useCallback(async () => {
    const pending = pendingVerification;
    if (!pending) return;
    // The action must still target the Guard it was opened for.
    if (String(pending.guardId) !== activeGuardId) {
      setPendingVerification(null);
      setFeedback({ tone: 'error', message: 'The selected guard changed. Nothing was updated — review the document again.' });
      return;
    }
    setVerifyingId(pending.document.id);
    try {
      await verifyGuardDocument(pending.document.id, pending.verified);
      setPendingVerification(null);
      setFeedback({ tone: 'success', message: `Document ${pending.verified ? 'verified' : 'marked unverified'}.` });
      await Promise.all([loadDocuments(String(pending.guardId)), loadData()]);
    } catch (error) {
      setPendingVerification(null);
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to update document verification.') });
    } finally {
      setVerifyingId(null);
    }
  }, [activeGuardId, loadData, loadDocuments, pendingVerification]);

  const verificationDialog = pendingVerification
    ? buildVerificationDialog({
        guardName: pendingVerification.guardName,
        document: pendingVerification.document,
        verified: pendingVerification.verified,
      })
    : null;

  return (
    <View style={styles.workspace}>
      <View style={styles.headerCard}>
        <View>
          <Text style={styles.eyebrow}>Compliance</Text>
          <Text style={styles.title}>Licence Management</Text>
          <Text style={styles.subtitle}>Track legal eligibility, document expiry, and verification before assignment.</Text>
        </View>
        <Pressable style={styles.secondaryButton} onPress={loadData}>
          <Text style={styles.secondaryButtonText}>{loading ? 'Loading...' : 'Refresh'}</Text>
        </Pressable>
      </View>

      {feedback ? (
        <View style={[styles.feedbackCard, feedback.tone === 'error' ? styles.feedbackError : styles.feedbackSuccess]}>
          <Text style={styles.feedbackText}>{feedback.message}</Text>
        </View>
      ) : null}

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Filters</Text>
        <View style={styles.formGrid}>
          <WebSelect value={statusFilter} onChange={(value: string) => setStatusFilter(value as 'all' | GuardComplianceStatus)} options={FILTERS} />
          <WebSelect value={activeGuardId} onChange={setSelectedGuardId} options={viewerGuardOptions} />
        </View>
      </View>

      {canManageCompliance ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Add / Update Compliance Record</Text>
          <View style={styles.formGrid}>
            <WebSelect value={form.guardId || activeGuardId} onChange={(value: string) => updateForm({ guardId: value })} options={formGuardOptions} />
            <WebSelect value={form.type} onChange={(value: string) => updateForm({ type: value as ComplianceRecordType })} options={TYPES.map((type) => ({ value: type, label: typeLabel(type) }))} />
            <TextInput style={styles.input} value={form.documentName} onChangeText={(value: string) => updateForm({ documentName: value })} placeholder="Document name" />
            <TextInput style={styles.input} value={form.documentNumber} onChangeText={(value: string) => updateForm({ documentNumber: value })} placeholder="Document number optional" />
            <TextInput style={styles.input} value={form.issueDate} onChangeText={(value: string) => updateForm({ issueDate: value })} placeholder="Issue date YYYY-MM-DD" />
            <TextInput style={styles.input} value={form.expiryDate} onChangeText={(value: string) => updateForm({ expiryDate: value })} placeholder="Expiry date YYYY-MM-DD" />
          </View>
          <Pressable style={[styles.primaryButton, saving && styles.disabledButton]} onPress={saveRecord} disabled={saving}>
            <Text style={styles.primaryButtonText}>{saving ? 'Saving...' : 'Save Compliance Record'}</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Guard Compliance List</Text>
        {summaries.length === 0 ? <Text style={styles.helperText}>No linked guards match the current filter.</Text> : null}
        {summaries.map((summary) => (
          <Pressable
            key={summary.guardId}
            style={[styles.guardRow, activeGuardId === String(summary.guardId) && styles.guardRowActive]}
            onPress={() => setSelectedGuardId(String(summary.guardId))}
          >
            <View style={styles.guardCopy}>
              <Text style={styles.guardName}>{summary.fullName}</Text>
              <Text style={styles.helperText}>
                SIA: {summary.siaLicenceNumber || 'Missing'} | Expires: {formatDate(summary.siaExpiryDate)}
              </Text>
              <Text style={styles.helperText}>
                Right to work: {summary.rightToWorkStatus || 'Missing'} | Expires: {formatDate(summary.rightToWorkExpiryDate)}
              </Text>
              {summary.blockingReasons.length ? (
                <Text style={styles.blockingText}>{summary.blockingReasons[0]}</Text>
              ) : summary.expiringReasons.length ? (
                <Text style={styles.expiringText}>{summary.expiringReasons[0]}</Text>
              ) : null}
            </View>
            <View style={[styles.statusPill, getStatusTone(summary.complianceStatus)]}>
              <Text style={styles.statusText}>{summary.complianceStatus}</Text>
            </View>
          </Pressable>
        ))}
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Selected Guard Documents</Text>
        {selectedSummary ? (
          <>
            <Text style={styles.guardName}>{selectedSummary.fullName}</Text>
            {selectedSummary.missingDocuments.length ? (
              <Text style={styles.blockingText}>Missing: {selectedSummary.missingDocuments.join(', ')}</Text>
            ) : null}
            {documentsLoading ? <Text style={styles.helperText}>Loading documents...</Text> : null}
            {documentsError ? <Text style={styles.blockingText}>{documentsError}</Text> : null}
            {!documentsLoading && !documentsError ? (
              <GuardDocumentsList
                documents={visibleDocuments}
                canManageCompliance={canManageCompliance}
                onVerify={requestVerification}
                onView={viewDocument}
                verifyingId={verifyingId}
                viewingId={viewingId}
              />
            ) : null}
          </>
        ) : (
          <Text style={styles.helperText}>Choose a guard to review documents and verification status.</Text>
        )}
      </View>

      <ConfirmationDialog
        visible={Boolean(pendingVerification && verificationDialog)}
        onClose={() => setPendingVerification(null)}
        onConfirm={confirmVerification}
        title={verificationDialog?.title ?? ''}
        message={verificationDialog?.message ?? ''}
        confirmLabel={verificationDialog?.confirmLabel}
        variant={verificationDialog?.variant}
        loading={verifyingId !== null}
      />
    </View>
  );
}

const webSelectStyle = {
  minWidth: 190,
  flex: 1,
  border: '1px solid #d6dce5',
  borderRadius: 14,
  padding: '12px 14px',
  color: colors.primaryNavyStrong,
  background: colors.card,
};

const styles = StyleSheet.create({
  workspace: { gap: 18 },
  headerCard: {
    backgroundColor: colors.card,
    borderRadius: 22,
    padding: 22,
    borderWidth: 1,
    borderColor: colors.surfaceSubtle,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
  },
  eyebrow: { color: colors.accentTealStrong, fontSize: 12, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  title: { color: colors.primaryNavy, fontSize: 30, fontWeight: '800' },
  subtitle: { color: colors.textSecondary, marginTop: 6, fontSize: 14, lineHeight: 21 },
  panel: { backgroundColor: colors.card, borderRadius: 22, padding: 18, borderColor: colors.surfaceSubtle, borderWidth: 1, gap: 14 },
  panelTitle: { color: colors.primaryNavy, fontSize: 18, fontWeight: '800' },
  helperText: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  blockingText: { color: colors.danger, fontWeight: '700' },
  expiringText: { color: colors.warning, fontWeight: '700' },
  formGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  input: {
    minWidth: 190,
    flex: 1,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.primaryNavyStrong,
  },
  primaryButton: { backgroundColor: colors.accentTealStrong, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center', alignSelf: 'flex-start' },
  primaryButtonText: { color: colors.card, fontWeight: '800' },
  secondaryButton: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, alignItems: 'center', alignSelf: 'flex-start' },
  secondaryButtonText: { color: colors.primaryNavy, fontWeight: '700' },
  disabledButton: { opacity: 0.45 },
  feedbackCard: { borderRadius: 16, padding: 14, borderWidth: 1 },
  feedbackSuccess: { backgroundColor: colors.successSurface, borderColor: colors.successBorder },
  feedbackError: { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder },
  feedbackText: { color: colors.primaryNavy, fontWeight: '700' },
  guardRow: {
    borderColor: colors.pendingSurface,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  guardRowActive: {
    borderColor: colors.accentTealStrong,
    backgroundColor: colors.accentTealSoft,
  },
  guardCopy: { flex: 1, gap: 4 },
  guardName: { color: colors.primaryNavy, fontWeight: '800' },
  statusPill: { borderRadius: 14, padding: 10, borderWidth: 1, minWidth: 110, gap: 3, alignItems: 'center' },
  statusValid: { backgroundColor: colors.successSurface, borderColor: colors.successBorder },
  statusExpiring: { backgroundColor: colors.warningSurface, borderColor: colors.warningBorder },
  statusExpired: { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder },
  statusInvalid: { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder },
  statusMissing: { backgroundColor: colors.background, borderColor: colors.border },
  statusText: { color: colors.primaryNavy, fontSize: 12, fontWeight: '800', textTransform: 'capitalize' },
  documentList: { gap: 10 },
  documentRow: { borderColor: colors.pendingSurface, borderWidth: 1, borderRadius: 16, padding: 14, flexDirection: 'row', gap: 12, alignItems: 'center' },
  documentTitle: { color: colors.primaryNavy, fontWeight: '800', textTransform: 'capitalize' },
  documentUrl: { color: colors.info, fontSize: 12, marginTop: 4 },
  documentActions: { gap: 8, alignItems: 'flex-end' },
  flexGrow: { flex: 1 },
});
