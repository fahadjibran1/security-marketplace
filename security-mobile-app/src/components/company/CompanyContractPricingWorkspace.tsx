import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  createContractPricingRule,
  deactivateContractPricingRule,
  formatApiErrorMessage,
  listClients,
  listContractPricingRules,
  listSites,
  updateContractPricingRule,
} from '../../services/api';
import { Client, ContractPricingRule, ContractPricingRulePayload, Site } from '../../types/models';

type RuleFormState = {
  id?: number;
  clientId: string;
  siteId: string;
  name: string;
  status: string;
  priority: string;
  effectiveFrom: string;
  effectiveTo: string;
  billingRate: string;
  minimumBillableHours: string;
  roundUpToMinutes: string;
  graceMinutes: string;
  startTime: string;
  endTime: string;
  appliesOnWeekendOnly: boolean;
  appliesOnOvernightShift: string;
  flatCallOutFee: string;
  deductionHoursBeforeBilling: string;
  notes: string;
};

const EMPTY_FORM: RuleFormState = {
  clientId: '',
  siteId: '',
  name: '',
  status: 'active',
  priority: '100',
  effectiveFrom: '',
  effectiveTo: '',
  billingRate: '',
  minimumBillableHours: '',
  roundUpToMinutes: '',
  graceMinutes: '',
  startTime: '',
  endTime: '',
  appliesOnWeekendOnly: false,
  appliesOnOvernightShift: '',
  flatCallOutFee: '',
  deductionHoursBeforeBilling: '',
  notes: '',
};

function toNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value?: string | number | null) {
  if (value === undefined || value === null || value === '') return 'Fallback rate';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'Fallback rate';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(parsed);
}

function formatDate(value?: string | null) {
  if (!value) return 'No limit';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB');
}

function statusLabel(value?: string | null) {
  return value === 'inactive' ? 'Inactive' : 'Active';
}

function WebSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const [isBrowserReady, setIsBrowserReady] = React.useState(false);

  React.useEffect(() => {
    setIsBrowserReady(typeof document !== 'undefined');
  }, []);

  if (isBrowserReady) {
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

export function CompanyContractPricingWorkspace() {
  const [rules, setRules] = React.useState<ContractPricingRule[]>([]);
  const [clients, setClients] = React.useState<Client[]>([]);
  const [sites, setSites] = React.useState<Site[]>([]);
  const [form, setForm] = React.useState<RuleFormState>(EMPTY_FORM);
  const [clientFilter, setClientFilter] = React.useState('all');
  const [siteFilter, setSiteFilter] = React.useState('all');
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextRules, nextClients, nextSites] = await Promise.all([
        listContractPricingRules(),
        listClients(),
        listSites(),
      ]);
      setRules(nextRules);
      setClients(nextClients);
      setSites(nextSites);
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load contract pricing rules.') });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const clientOptions = React.useMemo(
    () => [{ value: '', label: 'Choose client' }, ...clients.map((client) => ({ value: String(client.id), label: client.name }))],
    [clients],
  );
  const siteOptions = React.useMemo(() => {
    const clientId = toNumber(form.clientId);
    const filteredSites = clientId ? sites.filter((site) => site.client?.id === clientId || site.clientId === clientId) : sites;
    return [{ value: '', label: 'Client-wide rule' }, ...filteredSites.map((site) => ({ value: String(site.id), label: site.name }))];
  }, [form.clientId, sites]);

  const filteredRules = React.useMemo(() => {
    return rules.filter((rule) => {
      if (clientFilter !== 'all' && String(rule.client?.id) !== clientFilter) return false;
      if (siteFilter !== 'all' && String(rule.site?.id || '') !== siteFilter) return false;
      if (statusFilter !== 'all' && rule.status !== statusFilter) return false;
      return true;
    });
  }, [clientFilter, rules, siteFilter, statusFilter]);

  const updateForm = (patch: Partial<RuleFormState>) => setForm((current) => ({ ...current, ...patch }));

  const buildPayload = React.useCallback((): ContractPricingRulePayload | null => {
    const clientId = toNumber(form.clientId);
    if (!clientId || !form.name.trim()) return null;
    return {
      clientId,
      siteId: toNumber(form.siteId),
      name: form.name.trim(),
      status: form.status,
      priority: toNumber(form.priority) ?? 100,
      effectiveFrom: form.effectiveFrom.trim() || null,
      effectiveTo: form.effectiveTo.trim() || null,
      billingRate: toNumber(form.billingRate),
      minimumBillableHours: toNumber(form.minimumBillableHours),
      roundUpToMinutes: toNumber(form.roundUpToMinutes),
      graceMinutes: toNumber(form.graceMinutes),
      startTime: form.startTime.trim() || null,
      endTime: form.endTime.trim() || null,
      appliesOnWeekendOnly: form.appliesOnWeekendOnly,
      appliesOnOvernightShift:
        form.appliesOnOvernightShift === 'true' ? true : form.appliesOnOvernightShift === 'false' ? false : null,
      flatCallOutFee: toNumber(form.flatCallOutFee),
      deductionHoursBeforeBilling: toNumber(form.deductionHoursBeforeBilling),
      notes: form.notes.trim() || null,
    };
  }, [form]);

  const saveRule = React.useCallback(async () => {
    const payload = buildPayload();
    if (!payload) {
      setFeedback({ tone: 'error', message: 'Choose a client and enter a rule name before saving.' });
      return;
    }

    setSaving(true);
    try {
      const saved = form.id ? await updateContractPricingRule(form.id, payload) : await createContractPricingRule(payload);
      setFeedback({ tone: 'success', message: `${saved.name} saved.` });
      setForm(EMPTY_FORM);
      await loadData();
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save contract pricing rule.') });
    } finally {
      setSaving(false);
    }
  }, [buildPayload, form.id, loadData]);

  const editRule = (rule: ContractPricingRule) => {
    setForm({
      id: rule.id,
      clientId: String(rule.client?.id || ''),
      siteId: String(rule.site?.id || ''),
      name: rule.name,
      status: String(rule.status || 'active'),
      priority: String(rule.priority || 100),
      effectiveFrom: rule.effectiveFrom ? String(rule.effectiveFrom).slice(0, 10) : '',
      effectiveTo: rule.effectiveTo ? String(rule.effectiveTo).slice(0, 10) : '',
      billingRate: rule.billingRate === null || rule.billingRate === undefined ? '' : String(rule.billingRate),
      minimumBillableHours: rule.minimumBillableHours === null || rule.minimumBillableHours === undefined ? '' : String(rule.minimumBillableHours),
      roundUpToMinutes: rule.roundUpToMinutes === null || rule.roundUpToMinutes === undefined ? '' : String(rule.roundUpToMinutes),
      graceMinutes: rule.graceMinutes === null || rule.graceMinutes === undefined ? '' : String(rule.graceMinutes),
      startTime: rule.startTime || '',
      endTime: rule.endTime || '',
      appliesOnWeekendOnly: Boolean(rule.appliesOnWeekendOnly),
      appliesOnOvernightShift:
        rule.appliesOnOvernightShift === null || rule.appliesOnOvernightShift === undefined ? '' : String(rule.appliesOnOvernightShift),
      flatCallOutFee: rule.flatCallOutFee === null || rule.flatCallOutFee === undefined ? '' : String(rule.flatCallOutFee),
      deductionHoursBeforeBilling:
        rule.deductionHoursBeforeBilling === null || rule.deductionHoursBeforeBilling === undefined ? '' : String(rule.deductionHoursBeforeBilling),
      notes: rule.notes || '',
    });
  };

  const deactivateRule = React.useCallback(async (rule: ContractPricingRule) => {
    setSaving(true);
    try {
      await deactivateContractPricingRule(rule.id);
      setFeedback({ tone: 'success', message: `${rule.name} deactivated.` });
      await loadData();
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to deactivate contract pricing rule.') });
    } finally {
      setSaving(false);
    }
  }, [loadData]);

  return (
    <View style={styles.workspace}>
      <View style={styles.headerCard}>
        <View>
          <Text style={styles.eyebrow}>Commercial Rules</Text>
          <Text style={styles.title}>Contract Pricing</Text>
          <Text style={styles.subtitle}>Client and site pricing rules decide revenue. Payroll cost remains driven by guard hourly rate.</Text>
        </View>
        <Pressable style={styles.secondaryButton} onPress={loadData} disabled={loading || saving}>
          <Text style={styles.secondaryButtonText}>{loading ? 'Refreshing...' : 'Refresh'}</Text>
        </Pressable>
      </View>

      {feedback ? (
        <View style={[styles.feedbackCard, feedback.tone === 'error' ? styles.feedbackError : styles.feedbackSuccess]}>
          <Text style={styles.feedbackText}>{feedback.message}</Text>
        </View>
      ) : null}

      <View style={styles.splitLayout}>
        <View style={styles.mainColumn}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Pricing Rules</Text>
            <View style={styles.filterGrid}>
              <WebSelect
                value={clientFilter}
                onChange={setClientFilter}
                options={[{ value: 'all', label: 'All clients' }, ...clients.map((client) => ({ value: String(client.id), label: client.name }))]}
              />
              <WebSelect
                value={siteFilter}
                onChange={setSiteFilter}
                options={[{ value: 'all', label: 'All sites' }, { value: '', label: 'Client-wide only' }, ...sites.map((site) => ({ value: String(site.id), label: site.name }))]}
              />
              <WebSelect
                value={statusFilter}
                onChange={setStatusFilter}
                options={[
                  { value: 'all', label: 'All statuses' },
                  { value: 'active', label: 'Active' },
                  { value: 'inactive', label: 'Inactive' },
                ]}
              />
            </View>

            {filteredRules.length === 0 ? (
              <Text style={styles.helperText}>No contract pricing rules match these filters.</Text>
            ) : (
              filteredRules.map((rule) => (
                <View key={rule.id} style={styles.ruleCard}>
                  <View style={styles.ruleHeader}>
                    <View>
                      <Text style={styles.ruleTitle}>{rule.name}</Text>
                      <Text style={styles.ruleMeta}>
                        {rule.client?.name || 'Client'} / {rule.site?.name || 'Client-wide'} / Priority {rule.priority}
                      </Text>
                    </View>
                    <View style={[styles.statusBadge, rule.status === 'active' ? styles.activeBadge : styles.inactiveBadge]}>
                      <Text style={styles.statusBadgeText}>{statusLabel(rule.status)}</Text>
                    </View>
                  </View>
                  <View style={styles.ruleFacts}>
                    <Text style={styles.factText}>Rate: {formatMoney(rule.billingRate)}</Text>
                    <Text style={styles.factText}>Min hours: {rule.minimumBillableHours ?? 'None'}</Text>
                    <Text style={styles.factText}>Round up: {rule.roundUpToMinutes ? `${rule.roundUpToMinutes} min` : 'None'}</Text>
                    <Text style={styles.factText}>Flat fee: {formatMoney(rule.flatCallOutFee)}</Text>
                    <Text style={styles.factText}>Dates: {formatDate(rule.effectiveFrom)} - {formatDate(rule.effectiveTo)}</Text>
                    <Text style={styles.factText}>Time: {rule.startTime || 'Any'} - {rule.endTime || 'Any'}</Text>
                    <Text style={styles.factText}>Weekend only: {rule.appliesOnWeekendOnly ? 'Yes' : 'No'}</Text>
                  </View>
                  <Text style={styles.helperText}>{rule.notes || 'No notes.'}</Text>
                  <View style={styles.rowActions}>
                    <Pressable style={styles.secondaryButton} onPress={() => editRule(rule)}>
                      <Text style={styles.secondaryButtonText}>Edit</Text>
                    </Pressable>
                    {rule.status === 'active' ? (
                      <Pressable style={styles.secondaryButton} onPress={() => deactivateRule(rule)} disabled={saving}>
                        <Text style={styles.secondaryButtonText}>Deactivate</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              ))
            )}
          </View>
        </View>

        <View style={styles.sideColumn}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>{form.id ? 'Edit Rule' : 'Create Rule'}</Text>
            <Text style={styles.helperText}>Site-specific active rules override client-wide rules. Lower priority numbers win.</Text>
            <WebSelect value={form.clientId} onChange={(value: string) => updateForm({ clientId: value, siteId: '' })} options={clientOptions} />
            <WebSelect value={form.siteId} onChange={(value: string) => updateForm({ siteId: value })} options={siteOptions} />
            <TextInput style={styles.input} value={form.name} onChangeText={(value: string) => updateForm({ name: value })} placeholder="Rule name" />
            <View style={styles.formRow}>
              <TextInput style={styles.input} value={form.priority} onChangeText={(value: string) => updateForm({ priority: value })} placeholder="Priority" />
              <WebSelect
                value={form.status}
                onChange={(value: string) => updateForm({ status: value })}
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'inactive', label: 'Inactive' },
                ]}
              />
            </View>
            <View style={styles.formRow}>
              <TextInput style={styles.input} value={form.effectiveFrom} onChangeText={(value: string) => updateForm({ effectiveFrom: value })} placeholder="Effective from YYYY-MM-DD" />
              <TextInput style={styles.input} value={form.effectiveTo} onChangeText={(value: string) => updateForm({ effectiveTo: value })} placeholder="Effective to YYYY-MM-DD" />
            </View>
            <View style={styles.formRow}>
              <TextInput style={styles.input} value={form.billingRate} onChangeText={(value: string) => updateForm({ billingRate: value })} placeholder="Billing rate" />
              <TextInput style={styles.input} value={form.minimumBillableHours} onChangeText={(value: string) => updateForm({ minimumBillableHours: value })} placeholder="Minimum hours" />
            </View>
            <View style={styles.formRow}>
              <TextInput style={styles.input} value={form.roundUpToMinutes} onChangeText={(value: string) => updateForm({ roundUpToMinutes: value })} placeholder="Round up minutes" />
              <TextInput style={styles.input} value={form.graceMinutes} onChangeText={(value: string) => updateForm({ graceMinutes: value })} placeholder="Grace minutes" />
            </View>
            <View style={styles.formRow}>
              <TextInput style={styles.input} value={form.startTime} onChangeText={(value: string) => updateForm({ startTime: value })} placeholder="Start time HH:mm" />
              <TextInput style={styles.input} value={form.endTime} onChangeText={(value: string) => updateForm({ endTime: value })} placeholder="End time HH:mm" />
            </View>
            <View style={styles.formRow}>
              <TextInput style={styles.input} value={form.flatCallOutFee} onChangeText={(value: string) => updateForm({ flatCallOutFee: value })} placeholder="Flat call-out fee" />
              <TextInput style={styles.input} value={form.deductionHoursBeforeBilling} onChangeText={(value: string) => updateForm({ deductionHoursBeforeBilling: value })} placeholder="Deduction hours" />
            </View>
            <View style={styles.formRow}>
              <Pressable
                style={[styles.togglePill, form.appliesOnWeekendOnly && styles.togglePillActive]}
                onPress={() => updateForm({ appliesOnWeekendOnly: !form.appliesOnWeekendOnly })}
              >
                <Text style={[styles.togglePillText, form.appliesOnWeekendOnly && styles.togglePillTextActive]}>Weekend only</Text>
              </Pressable>
              <WebSelect
                value={form.appliesOnOvernightShift}
                onChange={(value: string) => updateForm({ appliesOnOvernightShift: value })}
                options={[
                  { value: '', label: 'Any shift type' },
                  { value: 'true', label: 'Overnight only' },
                  { value: 'false', label: 'Non-overnight only' },
                ]}
              />
            </View>
            <TextInput
              style={[styles.input, styles.notesInput]}
              value={form.notes}
              onChangeText={(value: string) => updateForm({ notes: value })}
              placeholder="Notes"
              multiline
            />
            <View style={styles.rowActions}>
              <Pressable style={styles.primaryButton} onPress={saveRule} disabled={saving}>
                <Text style={styles.primaryButtonText}>{saving ? 'Saving...' : form.id ? 'Update Rule' : 'Create Rule'}</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => setForm(EMPTY_FORM)}>
                <Text style={styles.secondaryButtonText}>Clear</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

const webSelectStyle = {
  borderRadius: 14,
  borderWidth: 1,
  borderColor: '#d6dce5',
  backgroundColor: '#ffffff',
  padding: '12px 14px',
  fontSize: 14,
  color: '#132238',
  minHeight: 46,
} as const;

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
  splitLayout: { flexDirection: 'row', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' },
  mainColumn: { flex: 2, minWidth: 520 },
  sideColumn: { flex: 1, minWidth: 360 },
  panel: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1, gap: 14 },
  panelTitle: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  helperText: { color: '#64748b', fontSize: 13, lineHeight: 19 },
  feedbackCard: { borderRadius: 16, padding: 14, borderWidth: 1 },
  feedbackSuccess: { backgroundColor: '#ecfdf5', borderColor: '#bbf7d0' },
  feedbackError: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  feedbackText: { color: '#0f172a', fontWeight: '700' },
  filterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  ruleCard: { borderColor: '#e2e8f0', borderWidth: 1, borderRadius: 18, padding: 14, gap: 10 },
  ruleHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' },
  ruleTitle: { color: '#0f172a', fontWeight: '800', fontSize: 16 },
  ruleMeta: { color: '#64748b', fontSize: 12, marginTop: 3 },
  statusBadge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  activeBadge: { backgroundColor: '#d1fae5' },
  inactiveBadge: { backgroundColor: '#e2e8f0' },
  statusBadgeText: { color: '#0f172a', fontSize: 12, fontWeight: '800' },
  ruleFacts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  factText: { color: '#334155', fontSize: 12, fontWeight: '700', backgroundColor: '#f8fafc', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  primaryButton: { backgroundColor: '#0f172a', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center' },
  primaryButtonText: { color: '#ffffff', fontWeight: '800' },
  secondaryButton: { backgroundColor: '#ffffff', borderColor: '#cbd5e1', borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, alignItems: 'center' },
  secondaryButtonText: { color: '#0f172a', fontWeight: '700' },
  input: { minWidth: 160, flex: 1, backgroundColor: '#ffffff', borderColor: '#d6dce5', borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: '#132238' },
  formRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  notesInput: { minHeight: 80, textAlignVertical: 'top' },
  togglePill: { borderColor: '#cbd5e1', borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 11 },
  togglePillActive: { backgroundColor: '#0f766e', borderColor: '#0f766e' },
  togglePillText: { color: '#0f172a', fontWeight: '800' },
  togglePillTextActive: { color: '#ffffff' },
});
