import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  formatApiErrorMessage,
  listCompanyGuards,
  listComplianceRecords,
  saveComplianceRecord,
} from '../../services/api';
import { CompanyGuard, ComplianceRecord, ComplianceRecordPayload, ComplianceRecordType } from '../../types/models';

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

function formatDate(value?: string | null) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB');
}

function typeLabel(type?: string | null) {
  if (type === 'RIGHT_TO_WORK') return 'Right to work';
  return (type || 'Other').replace(/_/g, ' ');
}

function getRecordTone(record?: ComplianceRecord | null) {
  if (!record) return styles.statusMissing;
  if (record.status === 'expired') return styles.statusExpired;
  if (record.status === 'expiring') return styles.statusExpiring;
  return styles.statusValid;
}

function getRecord(records: ComplianceRecord[], guardId: number, type: ComplianceRecordType) {
  return records.find((record) => record.guard?.id === guardId && record.type === type) || null;
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

export function CompanyComplianceWorkspace() {
  const [companyGuards, setCompanyGuards] = React.useState<CompanyGuard[]>([]);
  const [records, setRecords] = React.useState<ComplianceRecord[]>([]);
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextGuards, nextRecords] = await Promise.all([listCompanyGuards(), listComplianceRecords()]);
      setCompanyGuards(nextGuards);
      setRecords(nextRecords);
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load compliance records.') });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const guardOptions = React.useMemo(
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
    const guardId = Number(form.guardId);
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
  }, [form, loadData]);

  return (
    <View style={styles.workspace}>
      <View style={styles.headerCard}>
        <View>
          <Text style={styles.eyebrow}>Compliance</Text>
          <Text style={styles.title}>Licence Management</Text>
          <Text style={styles.subtitle}>Track critical expiry dates and prevent unsafe guard assignment.</Text>
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
        <Text style={styles.panelTitle}>Add / Update Compliance Record</Text>
        <View style={styles.formGrid}>
          <WebSelect value={form.guardId} onChange={(value) => updateForm({ guardId: value })} options={guardOptions} />
          <WebSelect value={form.type} onChange={(value) => updateForm({ type: value as ComplianceRecordType })} options={TYPES.map((type) => ({ value: type, label: typeLabel(type) }))} />
          <TextInput style={styles.input} value={form.documentName} onChangeText={(value) => updateForm({ documentName: value })} placeholder="Document name" />
          <TextInput style={styles.input} value={form.documentNumber} onChangeText={(value) => updateForm({ documentNumber: value })} placeholder="Document number optional" />
          <TextInput style={styles.input} value={form.issueDate} onChangeText={(value) => updateForm({ issueDate: value })} placeholder="Issue date YYYY-MM-DD" />
          <TextInput style={styles.input} value={form.expiryDate} onChangeText={(value) => updateForm({ expiryDate: value })} placeholder="Expiry date YYYY-MM-DD" />
        </View>
        <Pressable style={[styles.primaryButton, saving && styles.disabledButton]} onPress={saveRecord} disabled={saving}>
          <Text style={styles.primaryButtonText}>{saving ? 'Saving...' : 'Save Compliance Record'}</Text>
        </Pressable>
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Guard Compliance Overview</Text>
        {companyGuards.length === 0 ? <Text style={styles.helperText}>No linked guards yet.</Text> : null}
        {companyGuards.filter((item) => item.guard).map((item) => {
          const guard = item.guard!;
          const sia = getRecord(records, guard.id, 'SIA');
          const rightToWork = getRecord(records, guard.id, 'RIGHT_TO_WORK');
          const training = getRecord(records, guard.id, 'TRAINING');
          return (
            <View key={guard.id} style={styles.guardRow}>
              <View style={styles.guardCopy}>
                <Text style={styles.guardName}>{guard.fullName}</Text>
                <Text style={styles.helperText}>{guard.siaLicenseNumber || 'No SIA number on profile'}</Text>
              </View>
              {[
                ['SIA', sia],
                ['Right to work', rightToWork],
                ['Training', training],
              ].map(([label, record]) => (
                <View key={String(label)} style={[styles.statusPill, getRecordTone(record as ComplianceRecord | null)]}>
                  <Text style={styles.statusText}>{label}</Text>
                  <Text style={styles.statusText}>{record ? `${formatDate((record as ComplianceRecord).expiryDate)} / ${(record as ComplianceRecord).status}` : 'Missing'}</Text>
                </View>
              ))}
            </View>
          );
        })}
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
    flexWrap: 'wrap',
  },
  guardCopy: { flex: 1, minWidth: 180 },
  guardName: { color: '#0f172a', fontWeight: '800' },
  statusPill: { borderRadius: 14, padding: 10, borderWidth: 1, minWidth: 145, gap: 3 },
  statusValid: { backgroundColor: '#ecfdf5', borderColor: '#bbf7d0' },
  statusExpiring: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  statusExpired: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  statusMissing: { backgroundColor: '#f8fafc', borderColor: '#cbd5e1' },
  statusText: { color: '#0f172a', fontSize: 12, fontWeight: '800' },
});
