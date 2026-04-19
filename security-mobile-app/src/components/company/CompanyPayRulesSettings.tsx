import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatApiErrorMessage, getPayRuleConfig, savePayRuleConfig } from '../../services/api';
import { PayRuleConfig, PayRuleConfigPayload } from '../../types/models';

type FormState = {
  overtimeThresholdHours: string;
  overtimeMultiplier: string;
  nightStart: string;
  nightEnd: string;
  nightMultiplier: string;
  weekendMultiplier: string;
  bankHolidayMultiplier: string;
  minimumPaidHours: string;
  unpaidBreakMinutes: string;
};

const EMPTY_FORM: FormState = {
  overtimeThresholdHours: '',
  overtimeMultiplier: '1',
  nightStart: '',
  nightEnd: '',
  nightMultiplier: '1',
  weekendMultiplier: '1',
  bankHolidayMultiplier: '1',
  minimumPaidHours: '',
  unpaidBreakMinutes: '0',
};

function toNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toForm(config: PayRuleConfig | null): FormState {
  if (!config) return EMPTY_FORM;
  return {
    overtimeThresholdHours: config.overtimeThresholdHours === null || config.overtimeThresholdHours === undefined ? '' : String(config.overtimeThresholdHours),
    overtimeMultiplier: String(config.overtimeMultiplier ?? 1),
    nightStart: config.nightStart || '',
    nightEnd: config.nightEnd || '',
    nightMultiplier: String(config.nightMultiplier ?? 1),
    weekendMultiplier: String(config.weekendMultiplier ?? 1),
    bankHolidayMultiplier: String(config.bankHolidayMultiplier ?? 1),
    minimumPaidHours: config.minimumPaidHours === null || config.minimumPaidHours === undefined ? '' : String(config.minimumPaidHours),
    unpaidBreakMinutes: String(config.unpaidBreakMinutes ?? 0),
  };
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor="#94a3b8" />
    </View>
  );
}

export function CompanyPayRulesSettings() {
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const loadConfig = React.useCallback(async () => {
    setLoading(true);
    try {
      const config = await getPayRuleConfig();
      setForm(toForm(config));
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load pay rules.') });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const updateForm = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  const buildPayload = React.useCallback((): PayRuleConfigPayload => ({
    overtimeThresholdHours: toNumber(form.overtimeThresholdHours),
    overtimeMultiplier: toNumber(form.overtimeMultiplier) ?? 1,
    nightStart: form.nightStart.trim() || null,
    nightEnd: form.nightEnd.trim() || null,
    nightMultiplier: toNumber(form.nightMultiplier) ?? 1,
    weekendMultiplier: toNumber(form.weekendMultiplier) ?? 1,
    bankHolidayMultiplier: toNumber(form.bankHolidayMultiplier) ?? 1,
    minimumPaidHours: toNumber(form.minimumPaidHours),
    unpaidBreakMinutes: Math.max(0, Math.floor(toNumber(form.unpaidBreakMinutes) ?? 0)),
  }), [form]);

  const saveConfig = React.useCallback(async () => {
    setSaving(true);
    try {
      const saved = await savePayRuleConfig(buildPayload());
      setForm(toForm(saved));
      setFeedback({ tone: 'success', message: 'Guard pay rules saved. Future payroll calculations will use these rules safely.' });
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save pay rules.') });
    } finally {
      setSaving(false);
    }
  }, [buildPayload]);

  return (
    <View style={styles.workspace}>
      <View style={styles.headerCard}>
        <View>
          <Text style={styles.eyebrow}>Payroll Controls</Text>
          <Text style={styles.title}>Guard Pay Rules</Text>
          <Text style={styles.subtitle}>
            Optional company rules for payable hours. Original claimed and approved hours are never overwritten.
          </Text>
        </View>
        <Pressable style={styles.secondaryButton} onPress={loadConfig}>
          <Text style={styles.secondaryButtonText}>{loading ? 'Loading...' : 'Refresh'}</Text>
        </Pressable>
      </View>

      {feedback ? (
        <View style={[styles.feedbackCard, feedback.tone === 'error' ? styles.feedbackError : styles.feedbackSuccess]}>
          <Text style={styles.feedbackText}>{feedback.message}</Text>
        </View>
      ) : null}

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Pay Rule Configuration</Text>
        <Text style={styles.helperText}>
          Leave fields blank to keep fallback behaviour. With no config, payroll remains approved hours x guard hourly rate.
        </Text>
        <View style={styles.formGrid}>
          <Field label="Overtime threshold hours" value={form.overtimeThresholdHours} onChange={(value) => updateForm({ overtimeThresholdHours: value })} placeholder="e.g. 8" />
          <Field label="Overtime multiplier" value={form.overtimeMultiplier} onChange={(value) => updateForm({ overtimeMultiplier: value })} placeholder="e.g. 1.5" />
          <Field label="Night start" value={form.nightStart} onChange={(value) => updateForm({ nightStart: value })} placeholder="HH:mm" />
          <Field label="Night end" value={form.nightEnd} onChange={(value) => updateForm({ nightEnd: value })} placeholder="HH:mm" />
          <Field label="Night multiplier" value={form.nightMultiplier} onChange={(value) => updateForm({ nightMultiplier: value })} placeholder="e.g. 1.25" />
          <Field label="Weekend multiplier" value={form.weekendMultiplier} onChange={(value) => updateForm({ weekendMultiplier: value })} placeholder="e.g. 1.5" />
          <Field label="Bank holiday multiplier" value={form.bankHolidayMultiplier} onChange={(value) => updateForm({ bankHolidayMultiplier: value })} placeholder="e.g. 2" />
          <Field label="Minimum paid hours" value={form.minimumPaidHours} onChange={(value) => updateForm({ minimumPaidHours: value })} placeholder="e.g. 4" />
          <Field label="Unpaid break minutes" value={form.unpaidBreakMinutes} onChange={(value) => updateForm({ unpaidBreakMinutes: value })} placeholder="e.g. 30" />
        </View>
        <Pressable style={[styles.primaryButton, saving && styles.disabledButton]} onPress={saveConfig} disabled={saving}>
          <Text style={styles.primaryButtonText}>{saving ? 'Saving...' : 'Save Pay Rules'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  workspace: {
    gap: 18,
  },
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
  eyebrow: {
    color: '#0f766e',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  title: {
    color: '#0f172a',
    fontSize: 30,
    fontWeight: '800',
  },
  subtitle: {
    color: '#64748b',
    marginTop: 6,
    fontSize: 14,
    lineHeight: 21,
  },
  panel: {
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 18,
    borderColor: '#dbe4ef',
    borderWidth: 1,
    gap: 14,
  },
  panelTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '800',
  },
  helperText: {
    color: '#64748b',
    fontSize: 13,
    lineHeight: 19,
  },
  formGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  field: {
    minWidth: 210,
    flex: 1,
    gap: 6,
  },
  label: {
    color: '#334155',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: '#ffffff',
    borderColor: '#d6dce5',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#132238',
  },
  primaryButton: {
    backgroundColor: '#0f766e',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '800',
  },
  secondaryButton: {
    backgroundColor: '#ffffff',
    borderColor: '#cbd5e1',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  secondaryButtonText: {
    color: '#0f172a',
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.45,
  },
  feedbackCard: {
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
  },
  feedbackSuccess: {
    backgroundColor: '#ecfdf5',
    borderColor: '#bbf7d0',
  },
  feedbackError: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  },
  feedbackText: {
    color: '#0f172a',
    fontWeight: '700',
  },
});
