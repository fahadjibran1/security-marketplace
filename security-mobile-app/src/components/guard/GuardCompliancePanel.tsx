import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatApiErrorMessage, getMyGuard, getMyGuardComplianceStatus, listMyGuardDocuments } from '../../services/api';
import { GuardComplianceSummary, GuardDocument, GuardProfile } from '../../types/models';
import { FeatureCard } from '../FeatureCard';
import { StatusBadge } from '../StatusBadge';
import { colors, control, radii, spacing, typography } from '../../theme';
import { getGuardVettingLabel, getGuardWorkEligibilityLabel } from '../../navigation/guard-lifecycle';

function formatDate(value?: string | null) {
  if (!value) return 'Not provided';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB');
}

function heroTone(value: string) {
  const v = value.toLowerCase();
  if (v.includes('eligible') && !v.includes('not')) return { bg: colors.successSurface, text: colors.success };
  if (v.includes('verified') || v === 'active' || v.includes('approved')) return { bg: colors.successSurface, text: colors.success };
  if (v.includes('expired') || v.includes('blocked') || v.includes('not eligible')) return { bg: colors.dangerSurface, text: colors.danger };
  if (v.includes('awaiting') || v.includes('pending') || v.includes('review')) return { bg: colors.warningSurface, text: colors.warning };
  return { bg: colors.pendingSurface, text: colors.pending };
}

export function GuardCompliancePanel({ onManageCompliance }: { onManageCompliance?: () => void }) {
  const [guard, setGuard] = React.useState<GuardProfile | null>(null);
  const [summary, setSummary] = React.useState<GuardComplianceSummary | null>(null);
  const [documents, setDocuments] = React.useState<GuardDocument[]>([]);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    Promise.all([getMyGuard(), getMyGuardComplianceStatus(), listMyGuardDocuments()])
      .then(([nextGuard, nextSummary, nextDocuments]) => { setGuard(nextGuard); setSummary(nextSummary); setDocuments(nextDocuments); })
      .catch((loadError) => setError(formatApiErrorMessage(loadError, 'Unable to load your work-readiness status.')));
  }, []);

  const documentState = (type: string) => {
    const matching = documents.filter((item) => item.type === type && item.uploadCompletedAt);
    if (!matching.length) return 'Not provided';
    return matching.some((item) => item.verified) ? 'Verified' : 'Awaiting verification';
  };

  const vetting = getGuardVettingLabel(summary);
  const eligibility = getGuardWorkEligibilityLabel(summary);
  const eligibilityTone = heroTone(eligibility);

  return (
    <FeatureCard title="Work readiness" subtitle="See what is complete, what is under review and what may stop you being assigned to work.">
      {error ? <View style={styles.errorBox}><Text accessibilityRole="alert" style={styles.error}>{error}</Text></View> : null}

      <View style={[styles.readinessHero, { backgroundColor: eligibilityTone.bg }]}>
        <Text style={styles.readinessLabel}>CURRENT STATUS</Text>
        <Text style={[styles.readinessValue, { color: eligibilityTone.text }]}>{eligibility}</Text>
        <Text style={styles.readinessHint}>{summary?.blockingReasons?.length ? `${summary.blockingReasons.length} item${summary.blockingReasons.length === 1 ? '' : 's'} need attention or review.` : 'No compliance blocker is currently shown.'}</Text>
      </View>

      <View style={styles.grid}>
        <Summary label="Account access" value="Active" />
        <Summary label="Work eligibility" value={eligibility} />
        <Summary label="Vetting" value={vetting} />
        <Summary label="SIA licence" value={guard?.siaLicenseNumber || guard?.siaLicenceNumber || 'Not provided'} detail={`Expiry: ${formatDate(guard?.siaExpiryDate)}`} />
        <Summary label="SIA evidence" value={documentState('sia_licence')} />
        <Summary label="Right-to-work evidence" value={documentState('right_to_work')} detail={guard?.rightToWorkStatus ? `Status: ${guard.rightToWorkStatus}` : undefined} />
      </View>

      {summary?.blockingReasons?.length ? (
        <View style={styles.blockers}>
          <Text style={styles.blockerTitle}>Action required</Text>
          {summary.blockingReasons.map((reason) => <View key={reason} style={styles.blockerRow}><View style={styles.blockerDot} /><Text style={styles.blocker}>{reason}</Text></View>)}
        </View>
      ) : null}

      <Pressable accessibilityRole="button" style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]} onPress={onManageCompliance}>
        <Text style={styles.buttonText}>Review compliance details</Text>
      </Pressable>
      <Text style={styles.note}>Providing evidence does not verify it. Verification is completed only by an authorised reviewer.</Text>
    </FeatureCard>
  );
}

function Summary({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <View style={styles.summary}><Text style={styles.label}>{label}</Text><StatusBadge label={value} />{detail ? <Text style={styles.detail}>{detail}</Text> : null}</View>;
}

const styles = StyleSheet.create({
  readinessHero: { borderRadius: radii.lg, padding: spacing.lg, gap: spacing.xs },
  readinessLabel: { color: colors.textSecondary, ...typography.caption, fontWeight: '700', letterSpacing: 0.8 },
  readinessValue: { ...typography.heading },
  readinessHint: { color: colors.textSecondary, ...typography.caption },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  summary: { minWidth: 160, flexGrow: 1, flexBasis: '30%', padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.card, gap: spacing.sm },
  label: { color: colors.textSecondary, ...typography.caption, fontWeight: '700' },
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
