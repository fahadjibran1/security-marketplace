import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  formatApiErrorMessage,
  listCoverageShifts,
  listCoverageSites,
  listEligibleGuardsForShift,
} from '../../services/api';
import { CoverageShiftRow, CoverageSiteRow, EligibleGuardRow } from '../../types/models';

function formatDate(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

function statusTone(status: string) {
  if (status === 'fully_covered') return styles.good;
  if (status === 'partially_covered') return styles.warn;
  if (status === 'overstaffed') return styles.info;
  return styles.bad;
}

export function CompanyCoverageWorkspace() {
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [shifts, setShifts] = React.useState<CoverageShiftRow[]>([]);
  const [sites, setSites] = React.useState<CoverageSiteRow[]>([]);
  const [selectedShift, setSelectedShift] = React.useState<CoverageShiftRow | null>(null);
  const [eligibleGuards, setEligibleGuards] = React.useState<EligibleGuardRow[]>([]);
  const [feedback, setFeedback] = React.useState<{ tone: 'error' | 'success'; message: string } | null>(null);
  const [loading, setLoading] = React.useState(false);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = { from: from || undefined, to: to || undefined };
      const [nextShifts, nextSites] = await Promise.all([listCoverageShifts(params), listCoverageSites(params)]);
      setShifts(nextShifts);
      setSites(nextSites);
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load coverage intelligence.') });
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const openShift = async (shift: CoverageShiftRow) => {
    setSelectedShift(shift);
    try {
      setEligibleGuards(await listEligibleGuardsForShift(shift.shiftId));
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load eligible guards.') });
    }
  };

  return (
    <View style={styles.workspace}>
      <View style={styles.headerCard}>
        <View>
          <Text style={styles.eyebrow}>Coverage</Text>
          <Text style={styles.title}>Coverage Intelligence</Text>
          <Text style={styles.subtitle}>Understaffed shifts, site gaps, and guard eligibility reasons.</Text>
        </View>
        <Pressable style={styles.secondaryButton} onPress={loadData}><Text style={styles.secondaryButtonText}>{loading ? 'Loading...' : 'Refresh'}</Text></Pressable>
      </View>
      {feedback ? <View style={[styles.feedbackCard, feedback.tone === 'error' ? styles.feedbackError : styles.feedbackSuccess]}><Text style={styles.feedbackText}>{feedback.message}</Text></View> : null}
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Filters</Text>
        <View style={styles.formGrid}>
          <TextInput style={styles.input} value={from} onChangeText={setFrom} placeholder="From YYYY-MM-DD" />
          <TextInput style={styles.input} value={to} onChangeText={setTo} placeholder="To YYYY-MM-DD" />
        </View>
      </View>
      <View style={styles.split}>
        <View style={styles.main}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Site Coverage</Text>
            {sites.map((site) => (
              <View key={String(site.siteId)} style={styles.row}>
                <Text style={styles.rowTitle}>{site.siteName}</Text>
                <Text style={styles.rowText}>{site.clientName} | {site.shifts} shifts | gap {site.coverageGap}</Text>
              </View>
            ))}
          </View>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Upcoming Shift Gaps</Text>
            {shifts.map((shift) => (
              <Pressable key={shift.shiftId} style={styles.row} onPress={() => openShift(shift)}>
                <Text style={styles.rowTitle}>{shift.siteName}</Text>
                <Text style={styles.rowText}>{formatDate(shift.start)} | required {shift.requiredGuardCount} | assigned {shift.assignedGuardCount} | gap {shift.coverageGap}</Text>
                <View style={[styles.statusBadge, statusTone(shift.coverageStatus)]}><Text style={styles.statusText}>{shift.coverageStatus.replace(/_/g, ' ')}</Text></View>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={styles.side}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Eligible Guards</Text>
            {selectedShift ? <Text style={styles.rowText}>{selectedShift.siteName} / {formatDate(selectedShift.start)}</Text> : <Text style={styles.rowText}>Select a shift to see guard eligibility.</Text>}
            {eligibleGuards.map((guard) => (
              <View key={guard.guardId} style={styles.row}>
                <Text style={styles.rowTitle}>{guard.fullName || `Guard #${guard.guardId}`}</Text>
                <Text style={styles.rowText}>{guard.isEligible ? 'Eligible' : 'Blocked'} | availability: {guard.availabilityStatus}</Text>
                {guard.reasons.map((reason) => <Text key={reason} style={styles.reasonText}>{reason}</Text>)}
              </View>
            ))}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  workspace: { gap: 18 },
  headerCard: { backgroundColor: '#ffffff', borderRadius: 22, padding: 22, borderWidth: 1, borderColor: '#dbe4ef', flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  eyebrow: { color: '#0f766e', fontSize: 12, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  title: { color: '#0f172a', fontSize: 30, fontWeight: '800' },
  subtitle: { color: '#64748b', marginTop: 6, fontSize: 14, lineHeight: 21 },
  split: { flexDirection: 'row', gap: 18, alignItems: 'flex-start' },
  main: { flex: 2, gap: 18 },
  side: { flex: 1, minWidth: 320 },
  panel: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1, gap: 14 },
  panelTitle: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  formGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  input: { minWidth: 180, flex: 1, backgroundColor: '#ffffff', borderColor: '#d6dce5', borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: '#132238' },
  secondaryButton: { backgroundColor: '#ffffff', borderColor: '#cbd5e1', borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, alignItems: 'center', alignSelf: 'flex-start' },
  secondaryButtonText: { color: '#0f172a', fontWeight: '700' },
  feedbackCard: { borderRadius: 16, padding: 14, borderWidth: 1 },
  feedbackSuccess: { backgroundColor: '#ecfdf5', borderColor: '#bbf7d0' },
  feedbackError: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  feedbackText: { color: '#0f172a', fontWeight: '700' },
  row: { borderColor: '#e2e8f0', borderWidth: 1, borderRadius: 16, padding: 12, gap: 5 },
  rowTitle: { color: '#0f172a', fontWeight: '800' },
  rowText: { color: '#475569', fontWeight: '600' },
  reasonText: { color: '#b45309', fontSize: 12, fontWeight: '700' },
  statusBadge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, alignSelf: 'flex-start' },
  statusText: { color: '#0f172a', fontSize: 12, fontWeight: '800' },
  good: { backgroundColor: '#dcfce7' },
  warn: { backgroundColor: '#fef3c7' },
  bad: { backgroundColor: '#fee2e2' },
  info: { backgroundColor: '#dbeafe' },
});
