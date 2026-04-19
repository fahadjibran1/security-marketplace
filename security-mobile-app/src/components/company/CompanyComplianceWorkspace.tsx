import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
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
  onVerify,
  verifyingId,
}: {
  documents: GuardDocument[];
  onVerify: (documentId: number, verified: boolean) => Promise<void>;
  verifyingId: number | null;
}) {
  if (!documents.length) {
    return <Text style={styles.helperText}>No guard documents uploaded yet.</Text>;
  }

  return (
    <View style={styles.documentList}>
      {documents.map((document) => (
        <View key={document.id} style={styles.documentRow}>
          <View style={styles.flexGrow}>
            <Text style={styles.documentTitle}>{String(document.type).replace(/_/g, ' ')}</Text>
            <Text style={styles.helperText}>Expiry: {formatDate(document.expiryDate)} | Uploaded: {formatDate(document.uploadedAt)}</Text>
            <Text style={styles.documentUrl}>{document.fileUrl}</Text>
          </View>
          <View style={styles.documentActions}>
            <View style={[styles.statusPill, document.verified ? styles.statusValid : styles.statusMissing]}>
              <Text style={styles.statusText}>{document.verified ? 'Verified' : 'Pending'}</Text>
            </View>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => onVerify(document.id, !document.verified)}
              disabled={verifyingId === document.id}
            >
              <Text style={styles.secondaryButtonText}>
                {verifyingId === document.id ? 'Saving...' : document.verified ? 'Mark unverified' : 'Verify'}
              </Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}

export function CompanyComplianceWorkspace() {
  const [companyGuards, setCompanyGuards] = React.useState<CompanyGuard[]>([]);
  const [summaries, setSummaries] = React.useState<GuardComplianceSummary[]>([]);
  const [documents, setDocuments] = React.useState<GuardDocument[]>([]);
  const [selectedGuardId, setSelectedGuardId] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<'all' | GuardComplianceStatus>('all');
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [verifyingId, setVerifyingId] = React.useState<number | null>(null);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextGuards, nextSummaries] = await Promise.all([
        listCompanyGuards(),
        listCompanyGuardComplianceStatuses(statusFilter === 'all' ? undefined : statusFilter),
      ]);
      setCompanyGuards(nextGuards);
      setSummaries(nextSummaries);

      const effectiveGuardId = selectedGuardId || (nextSummaries[0]?.guardId ? String(nextSummaries[0].guardId) : '');
      if (effectiveGuardId && effectiveGuardId !== selectedGuardId) {
        setSelectedGuardId(effectiveGuardId);
      }
      if (effectiveGuardId) {
        setDocuments(await listGuardDocuments(Number(effectiveGuardId)));
      } else {
        setDocuments([]);
      }
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load compliance records.') });
    } finally {
      setLoading(false);
    }
  }, [selectedGuardId, statusFilter]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  React.useEffect(() => {
    if (!selectedGuardId) return;
    listGuardDocuments(Number(selectedGuardId))
      .then(setDocuments)
      .catch((error) => {
        setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load guard documents.') });
      });
  }, [selectedGuardId]);

  const guardOptions = React.useMemo(
    () => [
      { value: '', label: 'Choose guard' },
      ...companyGuards
        .filter((item) => item.guard)
        .map((item) => ({ value: String(item.guard!.id), label: item.guard!.fullName })),
    ],
    [companyGuards],
  );

  const selectedSummary = React.useMemo(
    () => summaries.find((item) => String(item.guardId) === selectedGuardId) || summaries[0] || null,
    [selectedGuardId, summaries],
  );

  const updateForm = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  const saveRecord = React.useCallback(async () => {
    const guardId = Number(form.guardId || selectedGuardId);
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
  }, [form, loadData, selectedGuardId]);

  const toggleVerify = React.useCallback(async (documentId: number, verified: boolean) => {
    setVerifyingId(documentId);
    try {
      await verifyGuardDocument(documentId, verified);
      setFeedback({ tone: 'success', message: `Document ${verified ? 'verified' : 'marked unverified'}.` });
      if (selectedGuardId) {
        setDocuments(await listGuardDocuments(Number(selectedGuardId)));
      }
      await loadData();
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to update document verification.') });
    } finally {
      setVerifyingId(null);
    }
  }, [loadData, selectedGuardId]);

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
          <WebSelect value={selectedGuardId} onChange={setSelectedGuardId} options={guardOptions} />
        </View>
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Add / Update Compliance Record</Text>
        <View style={styles.formGrid}>
          <WebSelect value={form.guardId || selectedGuardId} onChange={(value: string) => updateForm({ guardId: value })} options={guardOptions} />
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

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Guard Compliance List</Text>
        {summaries.length === 0 ? <Text style={styles.helperText}>No linked guards match the current filter.</Text> : null}
        {summaries.map((summary) => (
          <Pressable
            key={summary.guardId}
            style={[styles.guardRow, selectedGuardId === String(summary.guardId) && styles.guardRowActive]}
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
            <GuardDocumentsList documents={documents} onVerify={toggleVerify} verifyingId={verifyingId} />
          </>
        ) : (
          <Text style={styles.helperText}>Choose a guard to review documents and verification status.</Text>
        )}
      </View>
    </View>
  );
}

const webSelectStyle = {
  minWidth: 190,
  flex: 1,
  border: '1px solid #d6dce5',
  borderRadius: 14,
  padding: '12px 14px',
  color: '#132238',
  background: '#ffffff',
};

const styles = StyleSheet.create({
  workspace: { gap: 18 },
  headerCard: {
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 22,
    borderWidth: 1,
    borderColor: '#dbe4ef',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
  },
  eyebrow: { color: '#0f766e', fontSize: 12, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  title: { color: '#0f172a', fontSize: 30, fontWeight: '800' },
  subtitle: { color: '#64748b', marginTop: 6, fontSize: 14, lineHeight: 21 },
  panel: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1, gap: 14 },
  panelTitle: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  helperText: { color: '#64748b', fontSize: 13, lineHeight: 19 },
  blockingText: { color: '#B91C1C', fontWeight: '700' },
  expiringText: { color: '#B45309', fontWeight: '700' },
  formGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  input: {
    minWidth: 190,
    flex: 1,
    backgroundColor: '#ffffff',
    borderColor: '#d6dce5',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#132238',
  },
  primaryButton: { backgroundColor: '#0f766e', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center', alignSelf: 'flex-start' },
  primaryButtonText: { color: '#ffffff', fontWeight: '800' },
  secondaryButton: { backgroundColor: '#ffffff', borderColor: '#cbd5e1', borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, alignItems: 'center', alignSelf: 'flex-start' },
  secondaryButtonText: { color: '#0f172a', fontWeight: '700' },
  disabledButton: { opacity: 0.45 },
  feedbackCard: { borderRadius: 16, padding: 14, borderWidth: 1 },
  feedbackSuccess: { backgroundColor: '#ecfdf5', borderColor: '#bbf7d0' },
  feedbackError: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  feedbackText: { color: '#0f172a', fontWeight: '700' },
  guardRow: {
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  guardRowActive: {
    borderColor: '#0f766e',
    backgroundColor: '#f0fdfa',
  },
  guardCopy: { flex: 1, gap: 4 },
  guardName: { color: '#0f172a', fontWeight: '800' },
  statusPill: { borderRadius: 14, padding: 10, borderWidth: 1, minWidth: 110, gap: 3, alignItems: 'center' },
  statusValid: { backgroundColor: '#ecfdf5', borderColor: '#bbf7d0' },
  statusExpiring: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  statusExpired: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  statusInvalid: { backgroundColor: '#fee2e2', borderColor: '#fca5a5' },
  statusMissing: { backgroundColor: '#f8fafc', borderColor: '#cbd5e1' },
  statusText: { color: '#0f172a', fontSize: 12, fontWeight: '800', textTransform: 'capitalize' },
  documentList: { gap: 10 },
  documentRow: { borderColor: '#e2e8f0', borderWidth: 1, borderRadius: 16, padding: 14, flexDirection: 'row', gap: 12, alignItems: 'center' },
  documentTitle: { color: '#0f172a', fontWeight: '800', textTransform: 'capitalize' },
  documentUrl: { color: '#2563EB', fontSize: 12, marginTop: 4 },
  documentActions: { gap: 8, alignItems: 'flex-end' },
  flexGrow: { flex: 1 },
});
