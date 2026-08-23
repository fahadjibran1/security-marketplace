import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatApiErrorMessage, getMyGuard, getMyGuardComplianceStatus, listMyGuardDocuments } from '../../services/api';
import { GuardComplianceSummary, GuardDocument, GuardProfile } from '../../types/models';
import { FeatureCard } from '../FeatureCard';
import { colors } from '../../theme';
import { getGuardVettingLabel, getGuardWorkEligibilityLabel } from '../../navigation/guard-lifecycle';

function formatDate(value?: string | null) {
  if (!value) return 'Not provided';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB');
}

export function GuardCompliancePanel({ onManageCompliance }: { onManageCompliance?: () => void }) {
  const [guard, setGuard] = React.useState<GuardProfile | null>(null);
  const [summary, setSummary] = React.useState<GuardComplianceSummary | null>(null);
  const [documents, setDocuments] = React.useState<GuardDocument[]>([]);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    Promise.all([getMyGuard(), getMyGuardComplianceStatus(), listMyGuardDocuments()])
      .then(([nextGuard, nextSummary, nextDocuments]) => {
        setGuard(nextGuard); setSummary(nextSummary); setDocuments(nextDocuments);
      })
      .catch((loadError) => setError(formatApiErrorMessage(loadError, 'Unable to load compliance summary.')));
  }, []);

  const documentState = (type: string) => {
    const matching = documents.filter((item) => item.type === type && item.uploadCompletedAt);
    if (!matching.length) return 'Not provided';
    return matching.some((item) => item.verified) ? 'Verified' : 'Provided — awaiting verification';
  };

  return (
    <FeatureCard title="Compliance summary" subtitle="Your profile shows compliance status only. Manage candidate information and private evidence in Screening.">
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <View style={styles.grid}>
        <Summary label="Account access" value="Active" />
        <Summary label="Vetting" value={getGuardVettingLabel(summary)} />
        <Summary label="Work eligibility" value={getGuardWorkEligibilityLabel(summary)} />
        <Summary label="SIA licence number" value={guard?.siaLicenseNumber || guard?.siaLicenceNumber || 'Not provided'} />
        <Summary label="SIA expiry" value={formatDate(guard?.siaExpiryDate)} />
        <Summary label="SIA evidence" value={documentState('sia_licence')} />
        <Summary label="Right to Work" value={guard?.rightToWorkStatus || 'Not provided'} />
        <Summary label="Right to Work expiry" value={formatDate(guard?.rightToWorkExpiryDate)} />
        <Summary label="Right-to-work evidence" value={documentState('right_to_work')} />
      </View>
      {summary?.blockingReasons?.length ? <View style={styles.blockers}><Text style={styles.blockerTitle}>Why you are not yet work eligible</Text>{summary.blockingReasons.map((reason) => <Text key={reason} style={styles.blocker}>• {reason}</Text>)}</View> : null}
      <Pressable accessibilityRole="button" style={styles.button} onPress={onManageCompliance}><Text style={styles.buttonText}>Manage compliance</Text></Pressable>
      <Text style={styles.note}>Uploaded evidence is never treated as verified. Only an authorised reviewer can complete verification.</Text>
    </FeatureCard>
  );
}

function Summary({label,value}:{label:string;value:string}){return <View style={styles.summary}><Text style={styles.label}>{label}</Text><Text style={styles.value}>{value}</Text></View>;}

const styles=StyleSheet.create({
  grid:{flexDirection:'row',flexWrap:'wrap',gap:12},summary:{minWidth:210,flexGrow:1,flexBasis:'30%',padding:12,borderWidth:1,borderColor:colors.border,borderRadius:12,backgroundColor:'#F8FAFC'},label:{color:colors.textSecondary,fontSize:12,fontWeight:'800',textTransform:'uppercase'},value:{color:colors.textPrimary,fontSize:15,fontWeight:'700',marginTop:5},blockers:{padding:12,borderRadius:12,backgroundColor:'#FEF3C7',gap:5},blockerTitle:{color:'#92400E',fontWeight:'800'},blocker:{color:'#92400E'},button:{alignSelf:'flex-start',backgroundColor:colors.accentTeal,borderRadius:10,paddingHorizontal:16,paddingVertical:11},buttonText:{color:'#fff',fontWeight:'800'},note:{color:colors.textSecondary,lineHeight:20},error:{color:'#B91C1C',fontWeight:'700'}
});
