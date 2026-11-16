import * as React from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { formatApiErrorMessage, getMyGuard, getMyGuardComplianceStatus, listMyGuardDocuments } from '../../services/api';
import { GuardComplianceSummary, GuardDocument, GuardProfile } from '../../types/models';
import { StatusBadge } from '../StatusBadge';
import { colors, control, radii, spacing, typography } from '../../theme';
import { getGuardVettingLabel, getGuardWorkEligibilityLabel } from '../../navigation/guard-lifecycle';
import { COMPLIANCE_COPY, complianceChecksDisplayLabel } from './profile/profileCopy';
import { ProfileCard, ProfileNote } from './profile/ProfileCard';
import { profileLayout } from './profile/profileLayout';
import { localToday, siaLicenceStatus } from './profile/profileOverview';
import { PROFILE_TONE_COLORS, profileTokens } from './profile/profileTheme';

function heroTone(value: string) {
  const v = value.toLowerCase();
  if (v.includes('eligible') && !v.includes('not')) return { bg: colors.successSurface, text: colors.success };
  if (v.includes('verified') || v === 'active' || v.includes('approved')) return { bg: colors.successSurface, text: colors.success };
  if (v.includes('expired') || v.includes('blocked') || v.includes('not eligible')) return { bg: colors.dangerSurface, text: colors.danger };
  if (v.includes('awaiting') || v.includes('pending') || v.includes('review')) return { bg: colors.warningSurface, text: colors.warning };
  return { bg: colors.pendingSurface, text: colors.pending };
}

// Phase 2E: `onSummary` hands the compliance status this panel has just read to the Profile overview's in-memory cache,
// so Back to the overview shows the same SIA reading without reading it again.
export function GuardCompliancePanel({ onManageCompliance, onSummary }: { onManageCompliance?: () => void; onSummary?: (summary: GuardComplianceSummary) => void }) {
  const [guard, setGuard] = React.useState<GuardProfile | null>(null);
  const [summary, setSummary] = React.useState<GuardComplianceSummary | null>(null);
  const [documents, setDocuments] = React.useState<GuardDocument[]>([]);
  const [error, setError] = React.useState('');

  // Read fresh each time the section opens (the authoritative SIA and compliance view). `live` drops a response that
  // arrives after the Guard has left the section (Phase 2E stale-response guard).
  React.useEffect(() => {
    let live = true;
    Promise.all([getMyGuard(), getMyGuardComplianceStatus(), listMyGuardDocuments()])
      .then(([nextGuard, nextSummary, nextDocuments]) => {
        if (!live) return;
        setGuard(nextGuard); setSummary(nextSummary); setDocuments(nextDocuments);
        if (nextSummary) onSummary?.(nextSummary);
      })
      .catch((loadError) => { if (live) setError(formatApiErrorMessage(loadError, 'Unable to load your work-readiness status.')); });
    return () => { live = false; };
    // Read once per opening; onSummary is a stable dashboard callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const documentState = (type: string) => {
    const matching = documents.filter((item) => item.type === type && item.uploadCompletedAt);
    if (!matching.length) return 'Not provided';
    return matching.some((item) => item.verified) ? 'Verified' : 'Provided — awaiting verification';
  };

  // The company compliance file, not S4 screening: shown as "Compliance checks" so it cannot read as screening.
  const complianceChecks = complianceChecksDisplayLabel(getGuardVettingLabel(summary));
  const eligibility = getGuardWorkEligibilityLabel(summary);
  const eligibilityTone = heroTone(eligibility);
  // Phase 2D: the SAME reading of the SIA licence as the Profile overview (number and expiry source, wording, UK date).
  const sia = siaLicenceStatus({ guard, compliance: summary }, localToday());
  const { width, height, fontScale } = useWindowDimensions();
  const stacked = profileLayout({ width, height, fontScale }).detailRowStacks;

  return (
    // Phase 2D: no inner 'Compliance summary' heading (the section is already titled SIA & compliance), the flat Profile
    // card, one row per fact, and the eligibility shown once (the 'Work eligibility' row) instead of a hero repeating it.
    <ProfileCard subtitle="What is complete, what is under review and what may stop you being assigned to work." testID="guard-compliance-summary">
      {error ? <View style={styles.errorBox}><Text accessibilityRole="alert" style={styles.error}>{error}</Text></View> : null}

      <View style={styles.rows}>
        <Summary label="Work eligibility" value={eligibility} stacked={stacked} />
        <Summary label="Account access" value="Active" stacked={stacked} />
        <Summary label={COMPLIANCE_COPY.checksLabel} value={complianceChecks} stacked={stacked} />
        <Summary label="SIA licence" value={sia.number || 'Not added'} detail={sia.number ? sia.detail : undefined} detailTone={sia.tone} plain={Boolean(sia.number)} testID="guard-compliance-sia" stacked={stacked} />
        <Summary label="SIA evidence" value={documentState('sia_licence')} stacked={stacked} />
        <Summary label="Right-to-work evidence" value={documentState('right_to_work')} detail={guard?.rightToWorkStatus ? 'Status: ' + sentence(guard.rightToWorkStatus) : undefined} stacked={stacked} />
      </View>

      <View style={[styles.statusNote, { backgroundColor: eligibilityTone.bg }]}>
        <Text style={[styles.statusNoteText, { color: eligibilityTone.text }]}>{summary?.blockingReasons?.length ? `${summary.blockingReasons.length} item${summary.blockingReasons.length === 1 ? '' : 's'} need attention or review.` : 'No compliance blocker is currently shown.'}</Text>
        <Text style={styles.readinessHint}>{COMPLIANCE_COPY.deploymentNote}</Text>
      </View>

      {summary?.blockingReasons?.length ? (
        <View style={styles.blockers}>
          <Text style={styles.blockerTitle}>Action required</Text>
          {summary.blockingReasons.map((reason) => <View key={reason} style={styles.blockerRow}><View style={styles.blockerDot} /><Text style={styles.blocker}>{reason}</Text></View>)}
        </View>
      ) : null}

      {/* Shown only when the caller supplies a destination. The Profile's SIA & compliance section supplies none: it
          labels the update route for what it is (the optional S4 screening file) instead of "Manage compliance". */}
      {onManageCompliance ? (
        <Pressable accessibilityRole="button" style={({ pressed }: { pressed: boolean }) => [styles.button, pressed && styles.buttonPressed]} onPress={onManageCompliance}>
          <Text style={styles.buttonText}>Manage compliance</Text>
        </Pressable>
      ) : null}
      <ProfileNote>Providing evidence does not verify it. Verification is completed only by an authorised reviewer.</ProfileNote>
    </ProfileCard>
  );
}

/** One compliance fact: label beside its status on a standard phone, above it when the layout is compact. */
// `plain`: the value is an identifier (the SIA licence number), shown as text rather than as a status chip.
function Summary({ label, value, detail, detailTone, testID, stacked, plain = false }: { label: string; value: string; detail?: string; detailTone?: keyof typeof PROFILE_TONE_COLORS; testID?: string; stacked: boolean; plain?: boolean }) {
    return (
      <View style={[styles.row, stacked && styles.rowStacked]} testID={testID}>
        <Text style={[styles.label, !stacked && styles.labelColumn]}>{label}</Text>
        <View style={[styles.valueColumn, stacked && styles.valueStacked]}>
          {plain ? <Text style={styles.plainValue}>{value}</Text> : <StatusBadge label={value} casing="sentence" />}
          {detail ? <Text style={[styles.detail, detailTone && detailTone !== 'neutral' ? { color: PROFILE_TONE_COLORS[detailTone].text } : null]}>{detail}</Text> : null}
        </View>
      </View>
    );
}

/** 'verified' / 'NOT_PROVIDED' as 'Verified' / 'Not provided': sentence case, as every Profile status is shown. */
function sentence(value: string): string {
  const text = String(value).replace(/_/g, ' ').trim().toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

const styles = StyleSheet.create({
  statusNote: { borderRadius: profileTokens.shape.controlRadius, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  statusNoteText: { ...profileTokens.type.value },
  readinessHint: { color: colors.textSecondary, ...typography.caption },
  rows: { gap: 0 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 6, borderTopWidth: 1, borderTopColor: profileTokens.colors.border },
  rowStacked: { flexDirection: 'column', gap: 4 },
  labelColumn: { flexBasis: '42%', flexShrink: 0, flexGrow: 0, paddingTop: 2 },
  valueColumn: { flex: 1, minWidth: 0, gap: 2 },
  valueStacked: { flex: 0 },
  plainValue: { ...profileTokens.type.value, color: profileTokens.colors.textPrimary },
  label: { color: colors.textSecondary, ...profileTokens.type.body },
  detail: { color: colors.textMuted, ...typography.caption },
  blockers: { padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.warningSurface, gap: spacing.sm },
  blockerTitle: { color: colors.warning, ...typography.label },
  blockerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  blockerDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.warning, marginTop: 6 },
  blocker: { flex: 1, color: colors.warning, ...typography.caption },
  button: { minHeight: control.minTouchTarget, alignSelf: 'flex-start', justifyContent: 'center', backgroundColor: colors.accentTealStrong, borderRadius: radii.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  buttonPressed: { backgroundColor: colors.accentTeal },
  buttonText: { color: colors.textOnBrand, ...typography.label },
  note: { color: colors.textSecondary, ...typography.caption },
  errorBox: { backgroundColor: colors.dangerSurface, padding: spacing.md, borderRadius: radii.md },
  error: { color: colors.danger, ...typography.label },
});
