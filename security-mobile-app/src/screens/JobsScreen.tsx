import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import { StatePanel } from '../components/StatePanel';
import { StatusBadge } from '../components/StatusBadge';
import { createJobApplication, formatApiErrorMessage, listJobs, listMyJobApplications } from '../services/api';
import { AuthUser, Job, JobApplication } from '../types/models';
import { colors, control, radii, spacing, typography } from '../theme';

interface JobsScreenProps { user: AuthUser }

function showAlert(title: string, message: string) {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') { window.alert(`${title}\n\n${message}`); return; }
  Alert.alert(title, message);
}
function getLiteralDateTimeParts(value?: string | null) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  return { year: match[1], month: match[2], day: match[3], hour: match[4] || null, minute: match[5] || null };
}
function formatAppliedDateLabel(value?: string | null) {
  if (!value) return 'Date pending';
  const p = getLiteralDateTimeParts(value);
  const date = p ? new Date(Number(p.year), Number(p.month) - 1, Number(p.day)) : new Date(value);
  return date.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}
function isOpenJob(job: Job) { return (job.status || '').trim().toLowerCase() === 'open'; }
function formatJobHourlyPay(rate: number | undefined | null) {
  const n = Number(rate); if (!Number.isFinite(n)) return '';
  try { return `${new Intl.NumberFormat(undefined, { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 }).format(n)} / hr`; }
  catch { return `£${n.toFixed(2)} / hr`; }
}

export function JobsScreen({ user }: JobsScreenProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applyingJobId, setApplyingJobId] = useState<number | null>(null);
  const myApplications = useMemo(() => [...applications].sort((a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime()), [applications]);
  const appliedJobIds = useMemo(() => new Set(myApplications.map((a) => a.jobId)), [myApplications]);
  const openJobs = useMemo(() => jobs.filter((job) => isOpenJob(job) && !appliedJobIds.has(job.id)), [jobs, appliedJobIds]);

  const load = useCallback(async () => {
    try { setLoading(true); setError(null); const [jobRows, applicationRows] = await Promise.all([listJobs(), listMyJobApplications()]); setJobs(jobRows.filter(isOpenJob)); setApplications(applicationRows); }
    catch (err) { setError(formatApiErrorMessage(err, 'Unable to load jobs.')); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load, user.id]);

  async function handleApplyToJob(jobId: number) {
    if (appliedJobIds.has(jobId) || applyingJobId === jobId) return;
    try { setApplyingJobId(jobId); await createJobApplication({ jobId }); await load(); showAlert('Application sent', 'Your application has been submitted successfully.'); }
    catch (err) {
      const message = formatApiErrorMessage(err, 'Unable to apply for this job.');
      if (['already', 'duplicate', 'exists'].some((word) => message.toLowerCase().includes(word))) await load();
      showAlert('Application failed', message);
    } finally { setApplyingJobId(null); }
  }

  if (loading && jobs.length === 0 && applications.length === 0) return <StatePanel title="Loading jobs" message="Checking open work and your latest applications." loading tone="info" />;

  return (
    <View style={styles.root}>
      {error ? <StatePanel title="Could not load jobs" message={error} tone="error" actionLabel={loading ? 'Retrying…' : 'Try again'} onAction={load} /> : null}

      <FeatureCard title="Open jobs" subtitle={openJobs.length ? `${openJobs.length} role${openJobs.length === 1 ? '' : 's'} currently available.` : 'No role is currently accepting applications.'}>
        {!loading && !error && openJobs.length === 0 ? <StatePanel title="No open roles" message="When suitable work is published, it will appear here with the site, pay and staffing requirement." /> : null}
        {openJobs.map((job) => {
          const pay = formatJobHourlyPay(job.hourlyRate);
          const site = job.site?.name || job.company?.name || 'Location pending';
          const team = typeof job.guardsRequired === 'number' && job.guardsRequired > 0 ? `${job.guardsRequired} guard${job.guardsRequired === 1 ? '' : 's'} needed` : null;
          return <View key={job.id} style={styles.jobCard}>
            <View style={styles.cardHead}><View style={styles.flex}><Text style={styles.jobTitle}>{job.title}</Text><Text style={styles.site}>{site}</Text></View><StatusBadge label="Open" tone="success" /></View>
            {pay || team ? <View style={styles.metaRow}>{pay ? <Text style={styles.pay}>{pay}</Text> : null}{team ? <Text style={styles.meta}>{team}</Text> : null}</View> : null}
            <Text style={styles.description} numberOfLines={3}>{job.description?.trim() || 'Shift details will be provided by the company.'}</Text>
            <Pressable accessibilityRole="button" onPress={() => handleApplyToJob(job.id)} disabled={applyingJobId === job.id} style={({ pressed }: { pressed: boolean }) => [styles.apply, pressed && styles.pressed, applyingJobId === job.id && styles.disabled]}>
              <Text style={styles.applyText}>{applyingJobId === job.id ? 'Applying…' : 'Apply for this job'}</Text>
            </Pressable>
          </View>;
        })}
      </FeatureCard>

      <FeatureCard title="My applications" subtitle={myApplications.length ? `${myApplications.length} application${myApplications.length === 1 ? '' : 's'} on record.` : 'Your submitted applications will appear here.'}>
        {!loading && !error && myApplications.length === 0 ? <StatePanel title="No applications yet" message="Apply for an open role above and its latest status will be tracked here." /> : null}
        {myApplications.map((application) => <View key={application.id} style={styles.applicationCard}>
          <View style={styles.flex}><Text style={styles.applicationTitle}>{application.job?.title || `Job #${application.jobId}`}</Text><Text style={styles.site}>{application.job?.site?.name || application.job?.company?.name || 'Location pending'}</Text><Text style={styles.meta}>Applied {formatAppliedDateLabel(application.appliedAt)}</Text></View>
          <StatusBadge label={application.status || 'Pending'} />
        </View>)}
      </FeatureCard>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%', gap: spacing.md, paddingBottom: spacing.xs },
  jobCard: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md, backgroundColor: colors.card },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  flex: { flex: 1 },
  jobTitle: { color: colors.textPrimary, ...typography.heading },
  applicationTitle: { color: colors.textPrimary, ...typography.bodyStrong },
  site: { color: colors.textSecondary, ...typography.caption, marginTop: spacing.xs },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md },
  pay: { color: colors.primaryNavy, ...typography.bodyStrong },
  meta: { color: colors.textSecondary, ...typography.caption, marginTop: spacing.xs },
  description: { color: colors.textSecondary, ...typography.caption },
  apply: { minHeight: control.buttonHeight, borderRadius: radii.md, backgroundColor: colors.accentTealStrong, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  applyText: { color: colors.textOnBrand, ...typography.bodyStrong },
  applicationCard: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: spacing.md, backgroundColor: colors.card },
  pressed: { opacity: 0.84 },
  disabled: { opacity: 0.55 },
});
