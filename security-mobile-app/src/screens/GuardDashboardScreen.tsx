import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, TextInput } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import { listShifts } from '../services/api';
import { Shift } from '../types/models';

export function GuardDashboardScreen() {
  const [siaLicence, setSiaLicence] = useState('');
  const [locationSharing, setLocationSharing] = useState(false);
  const [dailyLog, setDailyLog] = useState('');
  const [shifts, setShifts] = useState<Shift[]>([]);

  useEffect(() => {
    async function loadShifts() {
      try {
        const shiftRows = await listShifts();
        setShifts(shiftRows);
      } catch (error) {
        Alert.alert('Load failed', error instanceof Error ? error.message : 'Unknown error');
      }
    }

    loadShifts();
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Guard Dashboard</Text>
      <Text style={styles.subtitle}>Run patrol operations and stay safety-compliant.</Text>

      <FeatureCard
        title="Profile + SIA Recruitment"
        subtitle="Complete onboarding details and track compliance checklist status."
        ctaLabel="Continue Onboarding"
        onPress={() => Alert.alert('Onboarding', 'Recruitment workflow will open here.')}
      />

      <FeatureCard
        title="SIA Licence Verification"
        subtitle="Enter your SIA licence number for verification checks."
        ctaLabel="Verify Licence"
        onPress={() => Alert.alert('Verification Sent', `Checking SIA licence: ${siaLicence || 'N/A'}`)}
      >
        <TextInput
          style={styles.input}
          placeholder="SIA licence number"
          value={siaLicence}
          onChangeText={setSiaLicence}
        />
      </FeatureCard>

      <FeatureCard title="Location Sharing" subtitle="Share your live location with recruited companies.">
        <Switch value={locationSharing} onValueChange={setLocationSharing} />
      </FeatureCard>

      <FeatureCard
        title="NFC Patrol Checkpoints"
        subtitle={`Today's scheduled patrol shifts: ${shifts.length}`}
        ctaLabel="Scan NFC Tag"
        onPress={() => Alert.alert('Patrol Checkpoint', 'NFC scanning flow will open here.')}
      />

      <FeatureCard
        title="Incident Reporting"
        subtitle="Report incidents with time, notes, location, and attachments."
        ctaLabel="Create Incident"
        onPress={() => Alert.alert('Incident', 'Incident report form will open here.')}
      />

      <FeatureCard title="Daily Log Book" subtitle="Maintain shift-by-shift activity logs.">
        <TextInput
          style={[styles.input, styles.logInput]}
          placeholder="Write your daily log notes..."
          multiline
          value={dailyLog}
          onChangeText={setDailyLog}
        />
      </FeatureCard>

      <FeatureCard
        title="Messaging"
        subtitle="Send and receive messages with your company or supervisor."
        ctaLabel="Open Messages"
        onPress={() => Alert.alert('Messages', 'Realtime chat module will open here.')}
      />

      <FeatureCard
        title="Automated Safety Check Calls"
        subtitle="Receive timed check-ins to confirm your status on shift."
        ctaLabel="Confirm Safe"
        onPress={() => Alert.alert('Safety Check', 'Safety check-in confirmed.')}
      />

      <FeatureCard
        title="Emergency Panic Button"
        subtitle="Trigger immediate alerts to company control room and emergency contacts."
        ctaLabel="Activate Panic Alert"
        onPress={() => Alert.alert('Panic Alert Triggered', 'Emergency alert has been sent.')}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f3f4f6' },
  content: { padding: 16, paddingBottom: 24 },
  title: { fontSize: 24, fontWeight: '700', color: '#111827', marginBottom: 4 },
  subtitle: { color: '#374151', marginBottom: 14 },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 10,
    backgroundColor: '#fff',
  },
  logInput: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
});
