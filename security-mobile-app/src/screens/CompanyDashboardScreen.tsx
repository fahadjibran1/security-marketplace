import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import { listCompanies, listGuards, listJobs, listShifts } from '../services/api';
import { CompanyProfile, GuardProfile, Job, Shift } from '../types/models';

export function CompanyDashboardScreen() {
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [guards, setGuards] = useState<GuardProfile[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);

  useEffect(() => {
    async function loadData() {
      try {
        const [companiesData, jobsData, guardsData, shiftsData] = await Promise.all([
          listCompanies(),
          listJobs(),
          listGuards(),
          listShifts(),
        ]);
        setCompany(companiesData[0] || null);
        setJobs(jobsData);
        setGuards(guardsData);
        setShifts(shiftsData);
      } catch (error) {
        Alert.alert('Load failed', error instanceof Error ? error.message : 'Unknown error');
      }
    }

    loadData();
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Company Dashboard</Text>
      <Text style={styles.subtitle}>Manage projects, guards, and client billing.</Text>

      <FeatureCard
        title="Company Profile"
        subtitle={
          company
            ? `${company.name}\nNo: ${company.companyNumber}\n${company.address}\n${company.contactDetails}`
            : 'Loading company profile...'
        }
      />

      <FeatureCard
        title="Advertise Jobs"
        subtitle={`Open jobs: ${jobs.filter((job) => job.status === 'open').length}`}
        ctaLabel="Create Job"
        onPress={() => Alert.alert('Job posted', 'Job publishing flow will open here.')}
      />

      <FeatureCard
        title="Employ Guards on Projects"
        subtitle={`Available guards: ${guards.length}`}
        ctaLabel="Assign Guard"
        onPress={() => Alert.alert('Assignment', 'Project assignment flow will open here.')}
      />

      <FeatureCard
        title="Hours Management"
        subtitle={`Scheduled shifts: ${shifts.length}`}
        ctaLabel="Review Timesheets"
        onPress={() => Alert.alert('Timesheets', 'Timesheet approval flow will open here.')}
      />

      <FeatureCard
        title="Client Invoicing"
        subtitle="Generate invoices from approved hours and send to clients."
        ctaLabel="Create Invoice"
        onPress={() => Alert.alert('Invoice', 'Invoice generation flow will open here.')}
      />

      <FeatureCard
        title="Guard Profiles"
        subtitle="Access guard profiles, SIA status, documents, and availability."
        ctaLabel="Open Profiles"
        onPress={() => Alert.alert('Guard profiles', 'Guard profile directory will open here.')}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f3f4f6' },
  content: { padding: 16, paddingBottom: 24 },
  title: { fontSize: 24, fontWeight: '700', color: '#111827', marginBottom: 4 },
  subtitle: { color: '#374151', marginBottom: 14 },
});
