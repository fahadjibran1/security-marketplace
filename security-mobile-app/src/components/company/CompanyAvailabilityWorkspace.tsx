import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  formatApiErrorMessage,
  listAvailabilityOverrides,
  listAvailabilityRules,
  listCompanyGuards,
  listGuardLeave,
  saveAvailabilityOverride,
  saveAvailabilityRule,
  saveGuardLeave,
} from '../../services/api';
import { CompanyGuard, GuardAvailabilityOverride, GuardAvailabilityRule, GuardLeave } from '../../types/models';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function WebSelect({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(typeof document !== 'undefined'), []);
  if (ready) {
    const SelectTag: any = 'select';
    const OptionTag: any = 'option';
    return (
      <SelectTag value={value} onChange={(event: any) => onChange(event.target.value)} style={webSelectStyle}>
        {options.map((option) => <OptionTag key={option.value} value={option.value}>{option.label}</OptionTag>)}
      </SelectTag>
    );
  }
  return <TextInput value={value} onChangeText={onChange} style={styles.input} />;
}

function formatDate(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB');
}

export function CompanyAvailabilityWorkspace() {
  const [guards, setGuards] = React.useState<CompanyGuard[]>([]);
  const [rules, setRules] = React.useState<GuardAvailabilityRule[]>([]);
  const [overrides, setOverrides] = React.useState<GuardAvailabilityOverride[]>([]);
  const [leaveRows, setLeaveRows] = React.useState<GuardLeave[]>([]);
  const [guardFilter, setGuardFilter] = React.useState('');
  const [ruleForm, setRuleForm] = React.useState({ guardId: '', weekday: '1', startTime: '09:00', endTime: '17:00', isAvailable: 'true' });
  const [overrideForm, setOverrideForm] = React.useState({ guardId: '', date: '', startTime: '', endTime: '', status: 'unavailable', note: '' });
  const [leaveForm, setLeaveForm] = React.useState({ guardId: '', leaveType: 'annual_leave', startAt: '', endAt: '', reason: '', status: 'approved' });
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [loading, setLoading] = React.useState(false);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const guardId = guardFilter ? Number(guardFilter) : undefined;
      const [nextGuards, nextRules, nextOverrides, nextLeave] = await Promise.all([
        listCompanyGuards(),
        listAvailabilityRules(guardId),
        listAvailabilityOverrides(guardId),
        listGuardLeave(),
      ]);
      setGuards(nextGuards);
      setRules(nextRules);
      setOverrides(nextOverrides);
      setLeaveRows(guardId ? nextLeave.filter((row) => row.guard?.id === guardId) : nextLeave);
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load availability records.') });
    } finally {
      setLoading(false);
    }
  }, [guardFilter]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const guardOptions = React.useMemo(() => [
    { value: '', label: 'All guards' },
    ...guards.filter((row) => row.guard).map((row) => ({ value: String(row.guard!.id), label: row.guard!.fullName })),
  ], [guards]);

  const saveRule = async () => {
    if (!ruleForm.guardId) return setFeedback({ tone: 'error', message: 'Choose a guard for the rule.' });
    try {
      await saveAvailabilityRule({
        guardId: Number(ruleForm.guardId),
        weekday: Number(ruleForm.weekday),
        startTime: ruleForm.startTime,
        endTime: ruleForm.endTime,
        isAvailable: ruleForm.isAvailable === 'true',
      });
      setFeedback({ tone: 'success', message: 'Availability rule saved.' });
      await loadData();
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save availability rule.') });
    }
  };

  const saveOverride = async () => {
    if (!overrideForm.guardId || !overrideForm.date) return setFeedback({ tone: 'error', message: 'Choose a guard and date for the override.' });
    try {
      await saveAvailabilityOverride({
        guardId: Number(overrideForm.guardId),
        date: overrideForm.date,
        startTime: overrideForm.startTime || null,
        endTime: overrideForm.endTime || null,
        status: overrideForm.status,
        note: overrideForm.note || null,
      });
      setFeedback({ tone: 'success', message: 'Availability override saved.' });
      await loadData();
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save override.') });
    }
  };

  const saveLeave = async () => {
    if (!leaveForm.guardId || !leaveForm.startAt || !leaveForm.endAt) return setFeedback({ tone: 'error', message: 'Choose a guard, start, and end for leave.' });
    try {
      await saveGuardLeave({
        guardId: Number(leaveForm.guardId),
        leaveType: leaveForm.leaveType,
        startAt: leaveForm.startAt,
        endAt: leaveForm.endAt,
        reason: leaveForm.reason || null,
        status: leaveForm.status,
      });
      setFeedback({ tone: 'success', message: 'Leave saved.' });
      await loadData();
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save leave.') });
    }
  };

  return (
    <View style={styles.workspace}>
      <View style={styles.headerCard}>
        <View>
          <Text style={styles.eyebrow}>Availability</Text>
          <Text style={styles.title}>Guard Availability & Leave</Text>
          <Text style={styles.subtitle}>Recurring availability, one-off overrides, and approved leave controls.</Text>
        </View>
        <Pressable style={styles.secondaryButton} onPress={loadData}><Text style={styles.secondaryButtonText}>{loading ? 'Loading...' : 'Refresh'}</Text></Pressable>
      </View>
      {feedback ? <View style={[styles.feedbackCard, feedback.tone === 'error' ? styles.feedbackError : styles.feedbackSuccess]}><Text style={styles.feedbackText}>{feedback.message}</Text></View> : null}
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Filters</Text>
        <WebSelect value={guardFilter} onChange={setGuardFilter} options={guardOptions} />
      </View>
      <View style={styles.panelGrid}>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Recurring Availability</Text>
          <View style={styles.formGrid}>
            <WebSelect value={ruleForm.guardId} onChange={(value: string) => setRuleForm((current) => ({ ...current, guardId: value }))} options={guardOptions} />
            <WebSelect value={ruleForm.weekday} onChange={(value: string) => setRuleForm((current) => ({ ...current, weekday: value }))} options={WEEKDAYS.map((label, index) => ({ value: String(index), label }))} />
            <TextInput style={styles.input} value={ruleForm.startTime} onChangeText={(value: string) => setRuleForm((current) => ({ ...current, startTime: value }))} placeholder="Start HH:mm" />
            <TextInput style={styles.input} value={ruleForm.endTime} onChangeText={(value: string) => setRuleForm((current) => ({ ...current, endTime: value }))} placeholder="End HH:mm" />
            <WebSelect value={ruleForm.isAvailable} onChange={(value: string) => setRuleForm((current) => ({ ...current, isAvailable: value }))} options={[{ value: 'true', label: 'Available' }, { value: 'false', label: 'Unavailable' }]} />
          </View>
          <Pressable style={styles.primaryButton} onPress={saveRule}><Text style={styles.primaryButtonText}>Save Rule</Text></Pressable>
          {rules.map((rule) => <Text key={rule.id} style={styles.rowText}>{rule.guard?.fullName}: {WEEKDAYS[rule.weekday]} {rule.startTime}-{rule.endTime} {rule.isAvailable ? 'available' : 'unavailable'}</Text>)}
        </View>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>One-Off Override</Text>
          <View style={styles.formGrid}>
            <WebSelect value={overrideForm.guardId} onChange={(value: string) => setOverrideForm((current) => ({ ...current, guardId: value }))} options={guardOptions} />
            <TextInput style={styles.input} value={overrideForm.date} onChangeText={(value: string) => setOverrideForm((current) => ({ ...current, date: value }))} placeholder="Date YYYY-MM-DD" />
            <TextInput style={styles.input} value={overrideForm.startTime} onChangeText={(value: string) => setOverrideForm((current) => ({ ...current, startTime: value }))} placeholder="Start optional" />
            <TextInput style={styles.input} value={overrideForm.endTime} onChangeText={(value: string) => setOverrideForm((current) => ({ ...current, endTime: value }))} placeholder="End optional" />
            <WebSelect value={overrideForm.status} onChange={(value: string) => setOverrideForm((current) => ({ ...current, status: value }))} options={[{ value: 'unavailable', label: 'Unavailable' }, { value: 'available', label: 'Available' }]} />
          </View>
          <TextInput style={styles.input} value={overrideForm.note} onChangeText={(value: string) => setOverrideForm((current) => ({ ...current, note: value }))} placeholder="Note optional" />
          <Pressable style={styles.primaryButton} onPress={saveOverride}><Text style={styles.primaryButtonText}>Save Override</Text></Pressable>
          {overrides.map((row) => <Text key={row.id} style={styles.rowText}>{row.guard?.fullName}: {formatDate(row.date)} {row.status}</Text>)}
        </View>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Leave</Text>
          <View style={styles.formGrid}>
            <WebSelect value={leaveForm.guardId} onChange={(value: string) => setLeaveForm((current) => ({ ...current, guardId: value }))} options={guardOptions} />
            <TextInput style={styles.input} value={leaveForm.startAt} onChangeText={(value: string) => setLeaveForm((current) => ({ ...current, startAt: value }))} placeholder="Start ISO/date" />
            <TextInput style={styles.input} value={leaveForm.endAt} onChangeText={(value: string) => setLeaveForm((current) => ({ ...current, endAt: value }))} placeholder="End ISO/date" />
            <WebSelect value={leaveForm.status} onChange={(value: string) => setLeaveForm((current) => ({ ...current, status: value }))} options={[{ value: 'approved', label: 'Approved' }, { value: 'pending', label: 'Pending' }, { value: 'rejected', label: 'Rejected' }]} />
          </View>
          <TextInput style={styles.input} value={leaveForm.reason} onChangeText={(value: string) => setLeaveForm((current) => ({ ...current, reason: value }))} placeholder="Reason optional" />
          <Pressable style={styles.primaryButton} onPress={saveLeave}><Text style={styles.primaryButtonText}>Save Leave</Text></Pressable>
          {leaveRows.map((row) => <Text key={row.id} style={styles.rowText}>{row.guard?.fullName}: {formatDate(row.startAt)} to {formatDate(row.endAt)} / {row.status}</Text>)}
        </View>
      </View>
    </View>
  );
}

const webSelectStyle = { minWidth: 180, flex: 1, border: '1px solid #d6dce5', borderRadius: 14, padding: '12px 14px', color: '#132238', background: '#ffffff' };
const styles = StyleSheet.create({
  workspace: { gap: 18 },
  headerCard: { backgroundColor: '#ffffff', borderRadius: 22, padding: 22, borderWidth: 1, borderColor: '#dbe4ef', flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  eyebrow: { color: '#0f766e', fontSize: 12, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  title: { color: '#0f172a', fontSize: 30, fontWeight: '800' },
  subtitle: { color: '#64748b', marginTop: 6, fontSize: 14, lineHeight: 21 },
  panelGrid: { gap: 14 },
  panel: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1, gap: 14 },
  panelTitle: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  formGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  input: { minWidth: 180, flex: 1, backgroundColor: '#ffffff', borderColor: '#d6dce5', borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: '#132238' },
  primaryButton: { backgroundColor: '#0f766e', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center', alignSelf: 'flex-start' },
  primaryButtonText: { color: '#ffffff', fontWeight: '800' },
  secondaryButton: { backgroundColor: '#ffffff', borderColor: '#cbd5e1', borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, alignItems: 'center', alignSelf: 'flex-start' },
  secondaryButtonText: { color: '#0f172a', fontWeight: '700' },
  feedbackCard: { borderRadius: 16, padding: 14, borderWidth: 1 },
  feedbackSuccess: { backgroundColor: '#ecfdf5', borderColor: '#bbf7d0' },
  feedbackError: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  feedbackText: { color: '#0f172a', fontWeight: '700' },
  rowText: { color: '#334155', fontWeight: '700' },
});
