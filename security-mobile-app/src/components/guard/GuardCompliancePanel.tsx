import * as React from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { formatApiErrorMessage, getMyGuard, getMyGuardComplianceStatus, listMyGuardDocuments } from '../../services/api';
import { GuardComplianceSummary, GuardDocument, GuardProfile } from '../../types/models';
import { StatusBadge } from '../StatusBadge';
import { colors, control, radii, spacing, typography } from '../../theme';
import { getGuardVettingLabel, getGuardWorkEligibilityLabel } from '../../navigation/guard-lifecycle';
import { COMPLIANCE_COPY, complianceChecksDisplayLabel } from './profile/profileCopy';
import { ProfileCard, ProfileNote } from './profile/ProfileCard';
import { rightToWorkStatusDescription } from './profile/profileCompliance';
import { profileLayout } from './profile/profileLayout';
import { localToday, screeningStatusText, siaLicenceStatus } from './profile/profileOverview';
import { PROFILE_TONE_COLORS, profileTokens } from './profile/profileTheme';

// Phase 2E: `onSummary` hands the compliance status this panel has just read to the Profile overview's in-memory cache,
// so Back to the overview shows the same SIA reading without reading it again.
// UX-02 Package B: `screeningStatus` is the optional S4 screening status the overview has already read (no extra call);
// it is shown as its own fact, never folded into deployment.
export function GuardCompliancePanel({ onManageCompliance, onSummary, screeningStatus }: { onManageCompliance?: () => void; onSummary?: (summary: GuardComplianceSummary) => void; screeningStatus?: string | null }) {
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
  const deployment = getGuardWorkEligibilityLabel(summary);
  // Phase 2D: the SAME reading of the SIA licence as the Profile overview (number and expiry source, wording, UK date).
  const sia = siaLicenceStatus({ guard, compliance: summary }, localToday());
  // UX-02 R4: the right-to-work status is free text, so it is described by what the backend does with it, never shown
  // as a raw code ("Status: Psw").
  const rightToWork = rightToWorkStatusDescription(
    guard?.rightToWorkStatus ?? summary?.rightToWorkStatus,
    guard?.rightToWorkExpiryDate ?? summary?.rightToWorkExpiryDate,
  );
  const blockers = summary?.blockingReasons ?? [];
  const { width, height, fontScale } = useWindowDimensions();
  const stacked = profileLayout({ width, height, fontScale }).detailRowStacks;

  return (
    // UX-02 Package B: five distinct facts, one row each, in the order the Guard is asked about them — SIA licence, SIA
    // evidence, right-to-work evidence, Deployment (with its genuine blocking reasons beneath it) and Optional S4
    // screening. No inner 'Compliance summary' heading, no subtitle repeating the section caption, and no green banner
    // repeating "Eligible": its explanation is the one note at the end. "Account access" moved to Privacy & account.
    <ProfileCard testID="guard-compliance-summary">
      {error ? <View style={styles.errorBox}><Text accessibilityRole="alert" style={styles.error}>{error}</Text></View> : null}

      <View style={styles.rows}>
        <Summary first label="SIA licence" value={sia.number || 'Not added'} detail={sia.number ? sia.detail : undefined} detailTone={sia.tone} plain={Boolean(sia.number)} testID="guard-compliance-sia" stacked={stacked} />
        <Summary label="SIA evidence" value={documentState('sia_licence')} stacked={stacked} testID="guard-compliance-sia-evidence" />
        <Summary label="Right-to-work evidence" value={documentState('right_to_work')} detail={rightToWork.text} detailTone={rightToWork.tone} stacked={stacked} testID="guard-compliance-rtw" />
        <Summary label="Deployment" value={deployment} detail={<><Text>{COMPLIANCE_COPY.checksLabel}</Text><Text>{": "}</Text><Text>{complianceChecks}</Text></>} stacked={stacked} testID="guard-compliance-deployment">
          {blockers.length ? (
            <View style={styles.blockers} accessibilityLabel={`${blockers.length} item${blockers.length === 1 ? '' : 's'} need attention or review: ${blockers.join('. ')}`} testID="guard-compliance-blockers">
              {blockers.map((reason) => <View key={reason} style={styles.blockerRow}><View style={styles.blockerDot} /><Text style={styles.blocker}>{reason}</Text></View>)}
            </View>
          ) : null}
        </Summary>
        <Summary label="Optional S4 screening" value={screeningStatus ? screeningStatusText(screeningStatus) : 'See Optional S4 screening'} plain stacked={stacked} testID="guard-compliance-screening" />
      </View>

      {/* Shown only when the caller supplies a destination. The Profile's SIA & compliance section supplies none: it
          labels the update route for what it is (the optional S4 screening file) instead of "Manage compliance". */}
      {onManageCompliance ? (
        <Pressable accessibilityRole="button" style={({ pressed }: { pressed: boolean }) => [styles.button, pressed && styles.buttonPressed]} onPress={onManageCompliance}>
          <Text style={styles.buttonText}>Manage compliance</Text>
        </Pressable>
      ) : null}
      {/* The one note (the banner's explanation and the evidence note), each sentence its own text run. */}
      <ProfileNote>
        <Text>{COMPLIANCE_COPY.deploymentNote}</Text>
        <Text>{' '}</Text>
        <Text>Providing evidence does not verify it. Verification is completed only by an authorised reviewer.</Text>
      </ProfileNote>
    </ProfileCard>
  );
}

/** One compliance fact: label beside its status on a standard phone, above it when the layout is compact. */
// `plain`: the value is text (the SIA licence number, the screening status), not a status chip.
function Summary({ label, value, detail, detailTone, testID, stacked, plain = false, first = false, children }: { label: string; value: string; detail?: React.ReactNode; detailTone?: keyof typeof PROFILE_TONE_COLORS; testID?: string; stacked: boolean; plain?: boolean; first?: boolean; children?: React.ReactNode }) {
    return (
      <View style={[styles.row, first && styles.rowFirst, stacked && styles.rowStacked]} testID={testID}>
        <Text style={[styles.label, !stacked && styles.labelColumn]}>{label}</Text>
        <View style={[styles.valueColumn, stacked && styles.valueStacked]}>
          {plain ? <Text style={styles.plainValue}>{value}</Text> : <StatusBadge label={value} casing="sentence" />}
          {detail ? <Text style={[styles.detail, detailTone && detailTone !== 'neutral' ? { color: PROFILE_TONE_COLORS[detailTone].text } : null]}>{detail}</Text> : null}
          {children}
        </View>
      </View>
    );
}

const styles = StyleSheet.create({
  rows: { gap: 0 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: profileTokens.colors.border },
  rowFirst: { borderTopWidth: 0, paddingTop: 0 },
  rowStacked: { flexDirection: 'column', gap: 4 },
  labelColumn: { flexBasis: '42%', flexShrink: 0, flexGrow: 0, paddingTop: 2 },
  valueColumn: { flex: 1, minWidth: 0, gap: 2 },
  valueStacked: { flex: 0 },
  plainValue: { ...profileTokens.type.value, color: profileTokens.colors.textPrimary },
  label: { color: colors.textSecondary, ...profileTokens.type.body },
  detail: { color: colors.textMuted, ...typography.caption },
  blockers: { marginTop: 4, gap: spacing.xs },
  blockerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  blockerDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.warning, marginTop: 6 },
  blocker: { flex: 1, color: colors.warning, ...typography.caption },
  button: { minHeight: control.minTouchTarget, alignSelf: 'flex-start', justifyContent: 'center', backgroundColor: colors.accentTealStrong, borderRadius: radii.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: colors.textOnBrand, ...typography.label },
  errorBox: { backgroundColor: colors.dangerSurface, padding: spacing.md, borderRadius: radii.md },
  error: { color: colors.danger, ...typography.label },
});
