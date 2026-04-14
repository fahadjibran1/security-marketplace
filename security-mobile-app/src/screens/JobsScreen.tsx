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
      <View style={styles.loadingBlock}>
        <ActivityIndicator size="large" color="#111827" />
        <Text style={styles.loadingText}>Loading jobs…</Text>
      </View>
    );
  }

  return (
    <>
      {error ? (
        <View style={[styles.feedbackBanner, styles.feedbackError]}>
          <Text style={styles.feedbackTitle}>Could not load jobs</Text>
          <Text style={styles.feedbackMessage}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={load} disabled={loading}>
            <Text style={styles.retryButtonText}>{loading ? 'Retrying…' : 'Try again'}</Text>
          </Pressable>
        </View>
      ) : null}

      <FeatureCard
        title="Open Jobs"
        subtitle={openJobs.length ? 'Available jobs you can apply for.' : 'No open jobs right now'}
      >
        {loading && !error ? (
          <View style={styles.inlineLoadingRow}>
            <ActivityIndicator size="small" color="#111827" />
            <Text style={styles.helperText}>Updating…</Text>
          </View>
        ) : null}
        {!loading && !error && openJobs.length === 0 ? (
          <Text style={styles.helperText}>No open jobs right now.</Text>
        ) : null}
        {openJobs.map((job) => (
          <View key={job.id} style={styles.listCard}>
            <Text style={styles.cardTitle}>{job.title}</Text>
            <Text style={styles.metaText}>{job.site?.name || job.company?.name || 'Location pending'}</Text>
            <Text style={styles.metaText} numberOfLines={2}>
              {job.description?.trim() || 'Shift details available when you open the job.'}
            </Text>
            <Pressable
              style={[styles.secondaryActionButton, applyingJobId === job.id && styles.buttonDisabled]}
              onPress={() => handleApplyToJob(job.id)}
              disabled={applyingJobId === job.id || appliedJobIds.has(job.id)}
            >
              <Text style={styles.secondaryActionButtonText}>
                {applyingJobId === job.id ? 'Applying…' : 'Apply'}
              </Text>
            </Pressable>
          </View>
        ))}
      </FeatureCard>

      <FeatureCard
        title="My Applications"
        subtitle={
          myApplications.length
            ? `${myApplications.length} application${myApplications.length === 1 ? '' : 's'} submitted`
            : 'No applications yet'
        }
      >
        {loading && !error && myApplications.length === 0 ? (
          <View style={styles.inlineLoadingRow}>
            <ActivityIndicator size="small" color="#111827" />
            <Text style={styles.helperText}>Updating…</Text>
          </View>
        ) : null}
        {!loading && !error && myApplications.length === 0 ? (
          <Text style={styles.helperText}>Your submitted applications will appear here.</Text>
        ) : null}
        {myApplications.map((application) => (
          <View key={application.id} style={styles.simpleRow}>
            <View style={styles.flexGrow}>
              <Text style={styles.cardTitle}>{application.job?.title || `Job #${application.jobId}`}</Text>
              <Text style={styles.metaText}>
                {application.job?.site?.name || application.job?.company?.name || 'Location pending'}
              </Text>
              <Text style={styles.metaText}>Applied {formatAppliedDateLabel(application.appliedAt)}</Text>
            </View>
            <View style={styles.applicationStatusBadge}>
              <Text style={styles.applicationStatus}>{application.status}</Text>
            </View>
          </View>
        ))}
      </FeatureCard>
    </>
  );
}

const styles = StyleSheet.create({
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
  secondaryActionButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#E5E7EB',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryActionButtonText: { color: '#111827', fontWeight: '700' },
  cardTitle: { color: '#111827', fontWeight: '700', fontSize: 16 },
  metaText: { color: '#6B7280', fontSize: 13, lineHeight: 18 },
  simpleRow: {
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    paddingTop: 12,
    paddingBottom: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  listCard: { borderTopWidth: 1, borderTopColor: '#E5E7EB', paddingTop: 12, gap: 8 },
  applicationStatusBadge: {
    borderRadius: 999,
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  applicationStatus: { color: '#1D4ED8', fontWeight: '700', textTransform: 'capitalize', fontSize: 12 },
  buttonDisabled: { opacity: 0.7 },
});
