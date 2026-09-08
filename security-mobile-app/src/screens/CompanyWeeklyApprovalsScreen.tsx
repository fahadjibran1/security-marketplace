import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { getCompanyWeeklyApprovals, formatApiErrorMessage } from '../services/api';
import { ClientWeeklyApprovalSummary, ClientWeeklyApprovalStatus } from '../types/models';

function statusLabel(status: ClientWeeklyApprovalStatus): string {
  switch (status) {
    case 'pending_approval': return 'Awaiting Client';
    case 'client_approved': return 'Client Approved';
    case 'disputed': return 'Disputed';
    case 'resolved': return 'Resolved';
    case 'locked': return 'Locked';
    default: return status;
  }
}

function statusColor(status: ClientWeeklyApprovalStatus): string {
  switch (status) {
    case 'pending_approval': return '#2563eb';
    case 'client_approved': return '#16a34a';
    case 'disputed': return '#ea580c';
    case 'resolved': return '#ca8a04';
    case 'locked': return '#6b7280';
    default: return '#6b7280';
  }
}

interface Props {
  onSelect?: (id: number) => void;
}

export function CompanyWeeklyApprovalsScreen({ onSelect }: Props) {
  const [approvals, setApprovals] = React.useState<ClientWeeklyApprovalSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getCompanyWeeklyApprovals();
      setApprovals(data);
    } catch (err) {
      setError(formatApiErrorMessage(err, 'Failed to load weekly approvals.'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1e3a5f" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.retryButton} onPress={() => load()}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.title}>Weekly Client Approvals</Text>
      {approvals.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No weekly approval requests found.</Text>
        </View>
      ) : (
        approvals.map((item) => (
          <Pressable
            key={item.id}
            style={styles.card}
            onPress={() => onSelect?.(item.id)}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.siteName}>{item.siteName}</Text>
              <View style={[styles.badge, { backgroundColor: statusColor(item.status) }]}>
                <Text style={styles.badgeText}>{statusLabel(item.status)}</Text>
              </View>
            </View>
            <Text style={styles.weekRange}>
              {item.weekCommencing} — {item.weekEnding}
            </Text>
            {item.totalApprovedHours != null && (
              <Text style={styles.hoursText}>
                Total approved: {Number(item.totalApprovedHours).toFixed(2)} hrs
              </Text>
            )}
            {item.status === 'disputed' && (
              <Text style={styles.disputeWarning}>Shifts disputed — action required</Text>
            )}
            <Text style={styles.versionText}>Version {item.currentVersion}</Text>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 16, paddingBottom: 40 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 20, fontWeight: '700', color: '#1e3a5f', marginBottom: 16 },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  siteName: { fontSize: 16, fontWeight: '600', color: '#1e3a5f', flex: 1 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeText: { color: '#ffffff', fontSize: 12, fontWeight: '600' },
  weekRange: { fontSize: 14, color: '#374151', marginBottom: 4 },
  hoursText: { fontSize: 14, color: '#4b5563', marginBottom: 2 },
  disputeWarning: { fontSize: 13, color: '#ea580c', fontWeight: '600', marginTop: 4 },
  versionText: { fontSize: 12, color: '#9ca3af', marginTop: 4 },
  emptyContainer: { alignItems: 'center', paddingVertical: 40 },
  emptyText: { fontSize: 15, color: '#6b7280' },
  errorText: { fontSize: 15, color: '#dc2626', textAlign: 'center', marginBottom: 12 },
  retryButton: { backgroundColor: '#1e3a5f', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  retryButtonText: { color: '#ffffff', fontWeight: '600' },
});
