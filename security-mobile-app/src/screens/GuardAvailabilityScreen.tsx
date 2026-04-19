import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { FeatureCard } from '../components/FeatureCard';
import {
  formatApiErrorMessage,
  listMyAvailabilityOverrides,
  listMyAvailabilityRules,
  listMyGuardLeave,
  saveAvailabilityOverride,
  saveAvailabilityRule,
  saveMyGuardLeave,
} from '../services/api';
import { GuardAvailabilityOverride, GuardAvailabilityRule, GuardLeave } from '../types/models';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatDate(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB');
}

export function GuardAvailabilityScreen() {
  const [rules, setRules] = useState<GuardAvailabilityRule[]>([]);
  const [overrides, setOverrides] = useState<GuardAvailabilityOverride[]>([]);
  const [leaveRows, setLeaveRows] = useState<GuardLeave[]>([]);
  const [ruleForm, setRuleForm] = useState({ weekday: '1', startTime: '09:00', endTime: '17:00', isAvailable: 'true' });
  const [overrideForm, setOverrideForm] = useState({ date: '', startTime: '', endTime: '', status: 'unavailable', note: '' });
  const [leaveForm, setLeaveForm] = useState({ leaveType: 'annual_leave', startAt: '', endAt: '', reason: '' });
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadData() {
    setLoading(true);
    try {
      const [nextRules, nextOverrides, nextLeave] = await Promise.all([
        listMyAvailabilityRules(),
        listMyAvailabilityOverrides(),
        listMyGuardLeave(),
      ]);
      setRules(nextRules);
      setOverrides(nextOverrides);
      setLeaveRows(nextLeave);
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load availability records.') });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleSaveRule() {
    try {
      await saveAvailabilityRule(
        {
          weekday: Number(ruleForm.weekday),
          startTime: ruleForm.startTime,
          endTime: ruleForm.endTime,
          isAvailable: ruleForm.isAvailable === 'true',
        },
        true,
      );
      setFeedback({ tone: 'success', message: 'Weekly availability saved.' });
      await loadData();
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save availability.') });
    }
  }

  async function handleSaveOverride() {
    try {
      await saveAvailabilityOverride(
        {
          date: overrideForm.date,
          startTime: overrideForm.startTime || null,
          endTime: overrideForm.endTime || null,
          status: overrideForm.status,
          note: overrideForm.note || null,
        },
        true,
      );
      setOverrideForm({ date: '', startTime: '', endTime: '', status: 'unavailable', note: '' });
      setFeedback({ tone: 'success', message: 'One-off availability saved.' });
      await loadData();
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save one-off availability.') });
    }
  }

  async function handleSaveLeave() {
    try {
      await saveMyGuardLeave({
        leaveType: leaveForm.leaveType,
        startAt: leaveForm.startAt,
        endAt: leaveForm.endAt,
        reason: leaveForm.reason || null,
      });
      setLeaveForm({ leaveType: 'annual_leave', startAt: '', endAt: '', reason: '' });
      setFeedback({ tone: 'success', message: 'Leave request saved for company review.' });
      await loadData();
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save leave request.') });
    }
  }

  return (
    <FeatureCard title="Availability & leave" subtitle="Share when you can work and request time off.">
      {feedback ? (
        <View style={[styles.feedback, feedback.tone === 'error' ? styles.feedbackError : styles.feedbackSuccess]}>
          <Text style={styles.feedbackText}>{feedback.message}</Text>
        </View>
      ) : null}
      <Text style={styles.sectionTitle}>Weekly availability</Text>
      <View style={styles.grid}>
        <TextInput
          style={styles.input}
          placeholder="Weekday 0-6"
          value={ruleForm.weekday}
          onChangeText={(weekday: string) => setRuleForm((prev) => ({ ...prev, weekday }))}
        />
        <TextInput
          style={styles.input}
          placeholder="Start HH:mm"
          value={ruleForm.startTime}
          onChangeText={(startTime: string) => setRuleForm((prev) => ({ ...prev, startTime }))}
        />
        <TextInput
          style={styles.input}
          placeholder="End HH:mm"
          value={ruleForm.endTime}
          onChangeText={(endTime: string) => setRuleForm((prev) => ({ ...prev, endTime }))}
        />
        <TextInput
          style={styles.input}
          placeholder="true or false"
          value={ruleForm.isAvailable}
          onChangeText={(isAvailable: string) => setRuleForm((prev) => ({ ...prev, isAvailable }))}
        />
      </View>
      <Pressable style={styles.primaryButton} onPress={handleSaveRule}>
        <Text style={styles.primaryButtonText}>Save weekly availability</Text>
      </Pressable>
      <View style={styles.list}>
        {rules.length === 0 ? (
          <Text style={styles.metaText}>{loading ? 'Loading availability...' : 'No weekly availability rules yet.'}</Text>
        ) : (
          rules.map((rule) => (
            <View key={rule.id} style={styles.simpleRow}>
              <Text style={styles.rowTitle}>{WEEKDAYS[rule.weekday] || `Day ${rule.weekday}`}</Text>
              <Text style={styles.metaText}>
                {rule.startTime}-{rule.endTime} | {rule.isAvailable ? 'Available' : 'Unavailable'}
              </Text>
            </View>
          ))
        )}
      </View>

      <Text style={styles.sectionTitle}>One-off availability</Text>
      <View style={styles.grid}>
        <TextInput
          style={styles.input}
          placeholder="Date YYYY-MM-DD"
          value={overrideForm.date}
          onChangeText={(date: string) => setOverrideForm((prev) => ({ ...prev, date }))}
        />
        <TextInput
          style={styles.input}
          placeholder="Start HH:mm optional"
          value={overrideForm.startTime}
          onChangeText={(startTime: string) => setOverrideForm((prev) => ({ ...prev, startTime }))}
        />
        <TextInput
          style={styles.input}
          placeholder="End HH:mm optional"
          value={overrideForm.endTime}
          onChangeText={(endTime: string) => setOverrideForm((prev) => ({ ...prev, endTime }))}
        />
        <TextInput
          style={styles.input}
          placeholder="available/unavailable"
          value={overrideForm.status}
          onChangeText={(status: string) => setOverrideForm((prev) => ({ ...prev, status }))}
        />
      </View>
      <TextInput
        style={styles.input}
        placeholder="Note optional"
        value={overrideForm.note}
        onChangeText={(note: string) => setOverrideForm((prev) => ({ ...prev, note }))}
      />
      <Pressable style={styles.secondaryButton} onPress={handleSaveOverride}>
        <Text style={styles.secondaryButtonText}>Save one-off availability</Text>
      </Pressable>
      <View style={styles.list}>
        {overrides.length === 0 ? (
          <Text style={styles.metaText}>No one-off overrides yet.</Text>
        ) : (
          overrides.slice(0, 5).map((override) => (
            <View key={override.id} style={styles.simpleRow}>
              <Text style={styles.rowTitle}>{formatDate(override.date)}</Text>
              <Text style={styles.metaText}>
                {override.status} | {override.startTime || 'All day'}-{override.endTime || 'All day'}
              </Text>
            </View>
          ))
        )}
      </View>

      <Text style={styles.sectionTitle}>Leave request</Text>
      <View style={styles.grid}>
        <TextInput
          style={styles.input}
          placeholder="Type"
          value={leaveForm.leaveType}
          onChangeText={(leaveType: string) => setLeaveForm((prev) => ({ ...prev, leaveType }))}
        />
        <TextInput
          style={styles.input}
          placeholder="Start ISO/date"
          value={leaveForm.startAt}
          onChangeText={(startAt: string) => setLeaveForm((prev) => ({ ...prev, startAt }))}
        />
        <TextInput
          style={styles.input}
          placeholder="End ISO/date"
          value={leaveForm.endAt}
          onChangeText={(endAt: string) => setLeaveForm((prev) => ({ ...prev, endAt }))}
        />
      </View>
      <TextInput
        style={styles.input}
        placeholder="Reason optional"
        value={leaveForm.reason}
        onChangeText={(reason: string) => setLeaveForm((prev) => ({ ...prev, reason }))}
      />
      <Pressable style={styles.secondaryButton} onPress={handleSaveLeave}>
        <Text style={styles.secondaryButtonText}>Request leave</Text>
      </Pressable>
      <View style={styles.list}>
        {leaveRows.length === 0 ? (
          <Text style={styles.metaText}>No leave records yet.</Text>
        ) : (
          leaveRows.slice(0, 5).map((leave) => (
            <View key={leave.id} style={styles.simpleRow}>
              <Text style={styles.rowTitle}>{String(leave.leaveType).replace(/_/g, ' ')}</Text>
              <Text style={styles.metaText}>
                {formatDate(leave.startAt)} to {formatDate(leave.endAt)} | {leave.status}
              </Text>
            </View>
          ))
        )}
      </View>
    </FeatureCard>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { color: '#111827', fontSize: 15, fontWeight: '800', marginTop: 12, marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: {
    minWidth: 150,
    flexGrow: 1,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#111827',
    backgroundColor: '#FFFFFF',
  },
  primaryButton: { alignSelf: 'flex-start', marginTop: 10, backgroundColor: '#111827', borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10 },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800' },
  secondaryButton: { alignSelf: 'flex-start', marginTop: 10, borderWidth: 1, borderColor: '#111827', borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10 },
  secondaryButtonText: { color: '#111827', fontWeight: '800' },
  list: { gap: 8, marginTop: 10 },
  simpleRow: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 12, padding: 10, backgroundColor: '#F9FAFB' },
  rowTitle: { color: '#111827', fontWeight: '800' },
  metaText: { color: '#6B7280', fontSize: 13, marginTop: 2 },
  feedback: { borderRadius: 12, padding: 10, marginBottom: 10 },
  feedbackError: { backgroundColor: '#FEE2E2' },
  feedbackSuccess: { backgroundColor: '#DCFCE7' },
  feedbackText: { color: '#111827', fontWeight: '700' },
});
