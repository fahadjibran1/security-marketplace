import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import { createJobApplication, formatApiErrorMessage, listJobs, listMyJobApplications } from '../services/api';
import { AuthUser, Job, JobApplication } from '../types/models';

interface JobsScreenProps {
  user: AuthUser;
}

function showAlert(title: string, message: string) {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

function getLiteralDateTimeParts(value?: string | null) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  return {
    year: match[1],
    month: match[2],
    day: match[3],
    hour: match[4] || null,
    minute: match[5] || null,
  };
}

function formatAppliedDateLabel(value?: string | null) {
  if (!value) return 'Date pending';
  const literalParts = getLiteralDateTimeParts(value);
  if (literalParts) {
    return new Date(
      Number(literalParts.year),
      Number(literalParts.month) - 1,
      Number(literalParts.day),
    ).toLocaleDateString(undefined, {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }
  return new Date(value).toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function isOpenJob(job: Job) {
  return (job.status || '').trim().toLowerCase() === 'open';
}

/** Guard-facing pay line from existing `hourlyRate` only (presentation). */
function formatJobHourlyPay(rate: number | undefined | null): string {
  const n = Number(rate);
  if (!Number.isFinite(n)) return '';
  try {
    const formatted = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'GBP',
      maximumFractionDigits: 2,
    }).format(n);
    return `${formatted} / hr`;
  } catch {
    return `£${n.toFixed(2)} / hr`;
  }
}

export function JobsScreen({ user }: JobsScreenProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applyingJobId, setApplyingJobId] = useState<number | null>(null);

  const myApplications = useMemo(
    () => [...applications].sort((a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime()),
    [applications],
  );

  const appliedJobIds = useMemo(() => new Set(myApplications.map((a) => a.jobId)), [myApplications]);

  const openJobs = useMemo(
    () => jobs.filter((job) => isOpenJob(job) && !appliedJobIds.has(job.id)),
    [jobs, appliedJobIds],
  );

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [jobRows, applicationRows] = await Promise.all([listJobs(), listMyJobApplications()]);
      setJobs(jobRows.filter(isOpenJob));
      setApplications(applicationRows);
    } catch (err) {
      setError(formatApiErrorMessage(err, 'Unable to load jobs.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleApplyToJob(jobId: number) {
    if (appliedJobIds.has(jobId) || applyingJobId === jobId) {
      return;
    }
    try {
      setApplyingJobId(jobId);
      await createJobApplication({ jobId });
      await load();
      showAlert('Application sent', 'Your application has been submitted successfully.');
    } catch (err) {
      const message = formatApiErrorMessage(err, 'Unable to apply for this job.');
      const looksDuplicate =
        message.toLowerCase().includes('already') ||
        message.toLowerCase().includes('duplicate') ||
        message.toLowerCase().includes('exists');
      if (looksDuplicate) {
        await load();
      }
      showAlert('Application failed', message);
    } finally {
      setApplyingJobId(null);
    }
  }

  if (loading && jobs.length === 0 && applications.length === 0) {
    return (
      <View style={styles.guardJobsRoot}>
        <View style={styles.loadingBlock}>
          <ActivityIndicator size="large" color="#111827" />
          <Text style={styles.loadingText}>Loading jobs…</Text>
        </View>
      </View>
    );
  }

  const openJobsSubtitle = openJobs.length
    ? `${openJobs.length} role${openJobs.length === 1 ? '' : 's'} open — tap Apply to send your interest.`
    : 'Nothing is accepting applications right now.';

  const applicationsSubtitle = myApplications.length
    ? `${myApplications.length} application${myApplications.length === 1 ? '' : 's'} on record.`
    : 'You have not applied to any roles yet.';

  return (
    <View style={styles.guardJobsRoot}>
      {error ? (
        <View style={[styles.feedbackBanner, styles.feedbackError]}>
          <Text style={styles.feedbackTitle}>Could not load jobs</Text>
          <Text style={styles.feedbackMessage}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={load} disabled={loading}>
            <Text style={styles.retryButtonText}>{loading ? 'Retrying…' : 'Try again'}</Text>
          </Pressable>
        </View>
      ) : null}

      <FeatureCard title="Open Jobs" subtitle={openJobsSubtitle} style={styles.guardJobsCard}>
        {loading && !error ? (
          <View style={styles.inlineLoadingRow}>
            <ActivityIndicator size="small" color="#111827" />
            <Text style={styles.helperText}>Updating…</Text>
          </View>
        ) : null}
        {!loading && !error && openJobs.length === 0 ? (
          <View style={styles.jobsEmptyBlock}>
            <Text style={styles.jobsEmptyTitle}>No open roles</Text>
            <Text style={styles.jobsEmptyBody}>
              When your coordinator publishes work, it will show here with pay and site so you can apply in one tap.
            </Text>
          </View>
        ) : null}
        {openJobs.map((job, index) => {
          const payLine = formatJobHourlyPay(job.hourlyRate);
          const siteLine = job.site?.name || job.company?.name || 'Location pending';
          const teamLine =
            typeof job.guardsRequired === 'number' && job.guardsRequired > 0
              ? `${job.guardsRequired} guard${job.guardsRequired === 1 ? '' : 's'} needed`
              : null;
          return (
            <View key={job.id} style={[styles.jobsOpenCard, index === 0 && styles.jobsOpenCardFirst]}>
              <View style={styles.jobsOpenCardInner}>
                <Text style={styles.jobsOpenTitle}>{job.title}</Text>
                <Text style={styles.jobsOpenSite}>{siteLine}</Text>
                {payLine || teamLine ? (
                  <View style={styles.jobsOpenMetaRow}>
                    {payLine ? <Text style={styles.jobsOpenPay}>{payLine}</Text> : null}
                    {teamLine ? (
                      <Text style={[styles.jobsOpenTeam, !payLine && styles.jobsOpenTeamSolo]}>{teamLine}</Text>
                    ) : null}
                  </View>
                ) : null}
                <Text style={styles.jobsOpenDescription} numberOfLines={3}>
                  {job.description?.trim() || 'Shift details available when you open the job.'}
                </Text>
                <Pressable
                  style={[styles.jobsApplyButton, applyingJobId === job.id && styles.buttonDisabled]}
                  onPress={() => handleApplyToJob(job.id)}
                  disabled={applyingJobId === job.id || appliedJobIds.has(job.id)}
                >
                  <Text style={styles.jobsApplyButtonText}>
                    {applyingJobId === job.id ? 'Applying…' : 'Apply'}
                  </Text>
                </Pressable>
              </View>
            </View>
          );
        })}
      </FeatureCard>

      {!error ? (
        <View style={styles.jobsSectionBridge}>
          <Text style={styles.jobsSectionBridgeLabel}>How this tab works</Text>
          <Text style={styles.jobsSectionBridgeBody}>
            Open roles are above. After you apply, each submission moves to My Applications with the latest status.
          </Text>
        </View>
      ) : null}

      <FeatureCard title="My Applications" subtitle={applicationsSubtitle} style={styles.guardJobsCard}>
        {loading && !error && myApplications.length === 0 ? (
          <View style={styles.inlineLoadingRow}>
            <ActivityIndicator size="small" color="#111827" />
            <Text style={styles.helperText}>Updating…</Text>
          </View>
        ) : null}
        {!loading && !error && myApplications.length === 0 ? (
          <View style={styles.jobsEmptyBlock}>
            <Text style={styles.jobsEmptyTitle}>No applications yet</Text>
            <Text style={styles.jobsEmptyBody}>
              Your submitted applications will appear here with site, date applied, and status so you can see what is
              moving.
            </Text>
          </View>
        ) : null}
        {myApplications.map((application, index) => (
          <View key={application.id} style={[styles.jobsApplicationCard, index === 0 && styles.jobsApplicationCardFirst]}>
            <View style={styles.jobsApplicationRow}>
              <View style={styles.flexGrow}>
                <Text style={styles.jobsApplicationTitle}>
                  {application.job?.title || `Job #${application.jobId}`}
                </Text>
                <Text style={styles.jobsApplicationSite}>
                  {application.job?.site?.name || application.job?.company?.name || 'Location pending'}
                </Text>
                <Text style={styles.jobsApplicationApplied}>
                  Applied {formatAppliedDateLabel(application.appliedAt)}
                </Text>
              </View>
              <View style={styles.applicationStatusBadge}>
                <Text style={styles.applicationStatus}>{application.status}</Text>
              </View>
            </View>
          </View>
        ))}
      </FeatureCard>
    </View>
  );
}

const styles = StyleSheet.create({
  guardJobsRoot: { width: '100%', gap: 12, paddingBottom: 4 },
  guardJobsCard: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    padding: 16,
    marginBottom: 0,
    shadowColor: '#0F172A',
    shadowOpacity: 0.05,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
    gap: 12,
  },
  jobsSectionBridge: {
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 6,
  },
  jobsSectionBridgeLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  jobsSectionBridgeBody: { fontSize: 13, lineHeight: 20, color: '#475569', fontWeight: '600' },
  jobsEmptyBlock: { gap: 8, paddingVertical: 8, paddingHorizontal: 2 },
  jobsEmptyTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A', letterSpacing: -0.2 },
  jobsEmptyBody: { fontSize: 14, lineHeight: 22, color: '#475569', fontWeight: '500' },
  jobsOpenCard: { marginTop: 12 },
  jobsOpenCardFirst: { marginTop: 2 },
  jobsOpenCardInner: {
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#E8ECF2',
    backgroundColor: '#F8FAFC',
    gap: 10,
  },
  jobsOpenTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0F172A',
    lineHeight: 22,
    letterSpacing: -0.2,
  },
  jobsOpenSite: { fontSize: 15, fontWeight: '700', color: '#334155', lineHeight: 22 },
  jobsOpenMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  jobsOpenPay: { fontSize: 15, fontWeight: '800', color: '#0F172A', letterSpacing: -0.1 },
  jobsOpenTeam: { fontSize: 13, fontWeight: '600', color: '#64748B' },
  jobsOpenTeamSolo: { fontSize: 14, fontWeight: '700', color: '#475569' },
  jobsOpenDescription: { fontSize: 13, lineHeight: 19, color: '#64748B', fontWeight: '500' },
  jobsApplyButton: {
    alignSelf: 'stretch',
    marginTop: 2,
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0F172A',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  jobsApplyButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16, letterSpacing: 0.2 },
  jobsApplicationCard: { marginTop: 12 },
  jobsApplicationCardFirst: { marginTop: 2 },
  jobsApplicationRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#EEF2F7',
    backgroundColor: '#FAFBFC',
  },
  jobsApplicationTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
    lineHeight: 21,
    letterSpacing: -0.15,
  },
  jobsApplicationSite: { fontSize: 14, fontWeight: '600', color: '#475569', marginTop: 4, lineHeight: 20 },
  jobsApplicationApplied: { fontSize: 13, fontWeight: '600', color: '#64748B', marginTop: 6, lineHeight: 19 },
  loadingBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 12,
  },
  loadingText: { color: '#4B5563', fontWeight: '600', fontSize: 15 },
  inlineLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  feedbackBanner: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, gap: 8, marginBottom: 12 },
  feedbackError: { backgroundColor: '#FEE2E2' },
  feedbackTitle: { fontWeight: '700', color: '#111827' },
  feedbackMessage: { color: '#374151', lineHeight: 20 },
  retryButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#111827',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryButtonText: { color: '#FFFFFF', fontWeight: '700' },
  helperText: { color: '#4B5563', lineHeight: 20 },
  flexGrow: { flex: 1 },
  applicationStatusBadge: {
    borderRadius: 999,
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  applicationStatus: { color: '#1D4ED8', fontWeight: '700', textTransform: 'capitalize', fontSize: 12 },
  buttonDisabled: { opacity: 0.7 },
});
