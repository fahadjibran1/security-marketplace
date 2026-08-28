import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  formatApiErrorMessage,
  listCoverageShifts,
  listCoverageSites,
  listEligibleGuardsForShift,
} from '../../services/api';
import { CoverageShiftRow, CoverageSiteRow, EligibleGuardRow } from '../../types/models';
import { colors } from '../../theme';

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

export type CoverageNavigationContext = {
  uncoveredOnly?: boolean;
  siteId?: number | null;
  shiftId?: number | null;
};

type CompanyCoverageWorkspaceProps = {
  navigationContext?: CoverageNavigationContext;
};

export function CompanyCoverageWorkspace({ navigationContext }: CompanyCoverageWorkspaceProps) {
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [shifts, setShifts] = React.useState<CoverageShiftRow[]>([]);
  const [sites, setSites] = React.useState<CoverageSiteRow[]>([]);
  const [selectedShift, setSelectedShift] = React.useState<CoverageShiftRow | null>(null);
  const [eligibleGuards, setEligibleGuards] = React.useState<EligibleGuardRow[]>([]);
  const [feedback, setFeedback] = React.useState<{ tone: 'error' | 'success'; message: string } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [uncoveredOnly, setUncoveredOnly] = React.useState(Boolean(navigationContext?.uncoveredOnly));

  React.useEffect(() => {
    setUncoveredOnly(Boolean(navigationContext?.uncoveredOnly));
  }, [navigationContext]);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        from: from || undefined,
        to: to || undefined,
        siteId: navigationContext?.siteId ? String(navigationContext.siteId) : undefined,
        shiftId: navigationContext?.shiftId ? String(navigationContext.shiftId) : undefined,
        uncoveredOnly: uncoveredOnly || undefined,
      };
      const [nextShifts, nextSites] = await Promise.all([listCoverageShifts(params), listCoverageSites(params)]);
      setShifts(nextShifts);
      setSites(navigationContext?.siteId ? nextSites.filter((site) => site.siteId === navigationContext.siteId) : nextSites);
      const contextShift = navigationContext?.shiftId
        ? nextShifts.find((shift) => shift.shiftId === navigationContext.shiftId) ?? null
        : null;
      if (contextShift) {
        setSelectedShift(contextShift);
        setEligibleGuards(await listEligibleGuardsForShift(contextShift.shiftId));
      }
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load coverage intelligence.') });
    } finally {
      setLoading(false);
    }
  }, [from, navigationContext, to, uncoveredOnly]);

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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show uncovered shifts only"
            style={[styles.filterButton, uncoveredOnly ? styles.filterButtonActive : null]}
            onPress={() => setUncoveredOnly((current) => !current)}
          >
            <Text style={[styles.secondaryButtonText, uncoveredOnly ? styles.filterButtonTextActive : null]}>
              {uncoveredOnly ? 'Uncovered only: On' : 'Uncovered only: Off'}
            </Text>
          </Pressable>
        </View>
        {navigationContext?.shiftId ? <Text style={styles.reasonText}>Showing context for Shift #{navigationContext.shiftId}.</Text> : null}
        {navigationContext?.siteId ? <Text style={styles.reasonText}>Filtered to the selected coverage-gap site.</Text> : null}
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
  headerCard: { backgroundColor: colors.card, borderRadius: 22, padding: 22, borderWidth: 1, borderColor: colors.surfaceSubtle, flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  eyebrow: { color: colors.accentTealStrong, fontSize: 12, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  title: { color: colors.primaryNavy, fontSize: 30, fontWeight: '800' },
  subtitle: { color: colors.textSecondary, marginTop: 6, fontSize: 14, lineHeight: 21 },
  split: { flexDirection: 'row', gap: 18, alignItems: 'flex-start' },
  main: { flex: 2, gap: 18 },
  side: { flex: 1, minWidth: 320 },
  panel: { backgroundColor: colors.card, borderRadius: 22, padding: 18, borderColor: colors.surfaceSubtle, borderWidth: 1, gap: 14 },
  panelTitle: { color: colors.primaryNavy, fontSize: 18, fontWeight: '800' },
  formGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  input: { minWidth: 180, flex: 1, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: colors.primaryNavyStrong },
  secondaryButton: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, alignItems: 'center', alignSelf: 'flex-start' },
  secondaryButtonText: { color: colors.primaryNavy, fontWeight: '700' },
  feedbackCard: { borderRadius: 16, padding: 14, borderWidth: 1 },
  feedbackSuccess: { backgroundColor: colors.successSurface, borderColor: colors.successBorder },
  feedbackError: { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder },
  feedbackText: { color: colors.primaryNavy, fontWeight: '700' },
  row: { borderColor: colors.pendingSurface, borderWidth: 1, borderRadius: 16, padding: 12, gap: 5 },
  rowTitle: { color: colors.primaryNavy, fontWeight: '800' },
  rowText: { color: colors.textSecondary, fontWeight: '600' },
  reasonText: { color: colors.warning, fontSize: 12, fontWeight: '700' },
  statusBadge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, alignSelf: 'flex-start' },
  statusText: { color: colors.primaryNavy, fontSize: 12, fontWeight: '800' },
  good: { backgroundColor: colors.successSurface },
  warn: { backgroundColor: colors.warningSurface },
  bad: { backgroundColor: colors.dangerSurface },
  info: { backgroundColor: colors.infoSurface },
  filterButton: { borderColor: colors.border, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  filterButtonActive: { backgroundColor: colors.warningSurface, borderColor: colors.warning },
  filterButtonTextActive: { color: colors.warning },
});
