import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  getClientWeeklyApprovals,
  getClientWeeklyApprovalDetail,
  approveWeek,
  disputeWeek,
  formatApiErrorMessage,
} from '../services/api';
import {
  ClientWeeklyApprovalSummary,
  ClientWeeklyApprovalDetail,
  ClientWeeklyApprovalStatus,
  ClientDisputeItem,
} from '../types/models';

function statusLabel(status: ClientWeeklyApprovalStatus): string {
  switch (status) {
    case 'pending_approval': return 'Awaiting Approval';
    case 'client_approved': return 'Approved';
    case 'disputed': return 'Returned for Correction';
    case 'resolved': return 'Ready to Resubmit';
    case 'locked': return 'Finalised';
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
  userRole?: string;
}

export function ClientWeeklyApprovalsScreen({ userRole }: Props) {
  const isAdmin = userRole === 'client_admin';

  const [approvals, setApprovals] = React.useState<ClientWeeklyApprovalSummary[]>([]);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [detail, setDetail] = React.useState<ClientWeeklyApprovalDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionLoading, setActionLoading] = React.useState(false);

  // Dispute state
  const [disputeTimesheetId, setDisputeTimesheetId] = React.useState<number | null>(null);
  const [disputeReason, setDisputeReason] = React.useState('');

  const loadList = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getClientWeeklyApprovals();
      setApprovals(data);
    } catch (err) {
      setError(formatApiErrorMessage(err, 'Failed to load weekly approvals.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = React.useCallback(async (id: number) => {
    setDetailLoading(true);
    setActionError(null);
    try {
      const data = await getClientWeeklyApprovalDetail(id);
      setDetail(data);
    } catch (err) {
      setActionError(formatApiErrorMessage(err, 'Failed to load details.'));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  React.useEffect(() => { loadList(); }, [loadList]);

  React.useEffect(() => {
    if (selectedId != null) loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const handleApprove = async () => {
    if (!selectedId || !isAdmin) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await approveWeek(selectedId);
      await loadList();
      await loadDetail(selectedId);
    } catch (err) {
      setActionError(formatApiErrorMessage(err, 'Approval failed.'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleDispute = async () => {
    if (!selectedId || !isAdmin || !disputeTimesheetId || !disputeReason.trim()) return;
    const disputes: ClientDisputeItem[] = [{ timesheetId: disputeTimesheetId, disputeReason: disputeReason.trim() }];
    setActionLoading(true);
    setActionError(null);
    try {
      await disputeWeek(selectedId, disputes);
      setDisputeTimesheetId(null);
      setDisputeReason('');
      await loadList();
      await loadDetail(selectedId);
    } catch (err) {
      setActionError(formatApiErrorMessage(err, 'Dispute failed.'));
    } finally {
      setActionLoading(false);
    }
  };

  // Detail view
  if (selectedId != null) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Pressable style={styles.backButton} onPress={() => { setSelectedId(null); setDetail(null); setDisputeTimesheetId(null); setDisputeReason(''); setActionError(null); }}>
          <Text style={styles.backButtonText}>Back to list</Text>
        </Pressable>

        {detailLoading ? (
          <ActivityIndicator size="large" color="#1e3a5f" style={{ marginTop: 40 }} />
        ) : detail ? (
          <>
            <Text style={styles.title}>{detail.siteName}</Text>
            <Text style={styles.weekRange}>{detail.weekCommencing} — {detail.weekEnding}</Text>
            <View style={[styles.badge, { backgroundColor: statusColor(detail.status), alignSelf: 'flex-start', marginBottom: 8 }]}>
              <Text style={styles.badgeText}>{statusLabel(detail.status)}</Text>
            </View>
            <Text style={styles.sectionTitle}>Shifts ({detail.lines.length})</Text>
            {detail.lines.map((line) => (
              <View key={line.id} style={styles.lineCard}>
                <Text style={styles.guardName}>{line.guardName ?? 'Guard'}</Text>
                <Text style={styles.lineDetail}>Date: {line.shiftDate}</Text>
                {line.scheduledStart && <Text style={styles.lineDetail}>Book On: {new Date(line.scheduledStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>}
                {line.scheduledEnd && <Text style={styles.lineDetail}>Book Off: {new Date(line.scheduledEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>}
                {line.actualCheckIn && <Text style={styles.lineDetail}>Check In: {new Date(line.actualCheckIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>}
                {line.actualCheckOut && <Text style={styles.lineDetail}>Check Out: {new Date(line.actualCheckOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>}
                {line.verifiedHours != null && <Text style={styles.lineDetail}>Verified: {line.verifiedHours.toFixed(2)} hrs</Text>}
                <Text style={styles.lineDetail}>Approved: {Number(line.approvedHoursAtSubmission).toFixed(2)} hrs</Text>
                {line.hasOverride && <Text style={styles.adjustmentBadge}>Adjusted</Text>}
                {isAdmin && detail.status === 'pending_approval' && (
                  <Pressable
                    style={styles.disputeLineButton}
                    onPress={() => { setDisputeTimesheetId(line.timesheetId); setDisputeReason(''); }}
                  >
                    <Text style={styles.disputeLineButtonText}>Dispute this shift</Text>
                  </Pressable>
                )}
              </View>
            ))}

            {disputeTimesheetId != null && isAdmin && (
              <View style={styles.disputeForm}>
                <Text style={styles.sectionTitle}>Dispute Shift #{disputeTimesheetId}</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="Enter dispute reason (required)"
                  value={disputeReason}
                  onChangeText={setDisputeReason}
                  multiline
                />
                <View style={styles.row}>
                  <Pressable style={[styles.actionButton, styles.dangerButton]} onPress={handleDispute} disabled={actionLoading || !disputeReason.trim()}>
                    <Text style={styles.actionButtonText}>{actionLoading ? 'Submitting...' : 'Submit Dispute'}</Text>
                  </Pressable>
                  <Pressable style={[styles.actionButton, styles.cancelButton]} onPress={() => { setDisputeTimesheetId(null); setDisputeReason(''); }}>
                    <Text style={styles.actionButtonText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {detail.disputes.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Disputes</Text>
                {detail.disputes.map((d) => (
                  <View key={d.id} style={styles.disputeCard}>
                    <Text style={styles.lineDetail}>Shift #{d.timesheetId}</Text>
                    <Text style={styles.lineDetail}>Reason: {d.disputeReason}</Text>
                    <Text style={styles.lineDetail}>Status: {d.status}</Text>
                    {d.resolutionMessage && <Text style={styles.lineDetail}>Resolution: {d.resolutionMessage}</Text>}
                  </View>
                ))}
              </>
            )}

            {actionError && <Text style={styles.errorText}>{actionError}</Text>}

            {isAdmin && detail.status === 'pending_approval' && !disputeTimesheetId && (
              <Pressable style={[styles.actionButton, styles.approveButton]} onPress={handleApprove} disabled={actionLoading}>
                <Text style={styles.actionButtonText}>{actionLoading ? 'Approving...' : 'Approve Week'}</Text>
              </Pressable>
            )}
          </>
        ) : null}
      </ScrollView>
    );
  }

  // List view
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
        <Pressable style={styles.retryButton} onPress={() => loadList()}>
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
      <Text style={styles.title}>Weekly Approval Requests</Text>
      {approvals.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No weekly approval requests found.</Text>
        </View>
      ) : (
        approvals.map((item) => (
          <Pressable key={item.id} style={styles.card} onPress={() => setSelectedId(item.id)}>
            <View style={styles.cardHeader}>
              <Text style={styles.siteName}>{item.siteName}</Text>
              <View style={[styles.badge, { backgroundColor: statusColor(item.status) }]}>
                <Text style={styles.badgeText}>{statusLabel(item.status)}</Text>
              </View>
            </View>
            <Text style={styles.weekRange}>{item.weekCommencing} — {item.weekEnding}</Text>
            {item.totalApprovedHours != null && (
              <Text style={styles.hoursText}>{Number(item.totalApprovedHours).toFixed(2)} approved hours</Text>
            )}
            {item.clientSubmissionNote && (
              <Text style={styles.noteText}>{item.clientSubmissionNote}</Text>
            )}
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
  title: { fontSize: 20, fontWeight: '700', color: '#1e3a5f', marginBottom: 12 },
  weekRange: { fontSize: 14, color: '#374151', marginBottom: 4 },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: '#1e3a5f', marginTop: 16, marginBottom: 8 },
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
  hoursText: { fontSize: 14, color: '#4b5563', marginBottom: 2 },
  noteText: { fontSize: 13, color: '#6b7280', fontStyle: 'italic', marginTop: 4 },
  lineCard: {
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  guardName: { fontSize: 15, fontWeight: '600', color: '#1e3a5f', marginBottom: 4 },
  lineDetail: { fontSize: 13, color: '#374151', marginBottom: 2 },
  adjustmentBadge: { fontSize: 12, color: '#ea580c', fontWeight: '600', marginTop: 4 },
  disputeLineButton: { marginTop: 8, backgroundColor: '#fff7ed', borderColor: '#ea580c', borderWidth: 1, borderRadius: 6, padding: 6, alignSelf: 'flex-start' },
  disputeLineButtonText: { color: '#ea580c', fontSize: 13, fontWeight: '600' },
  disputeCard: { backgroundColor: '#fef2f2', borderRadius: 8, padding: 12, marginBottom: 8 },
  disputeForm: { backgroundColor: '#fff7ed', borderRadius: 8, padding: 12, marginTop: 8, marginBottom: 8 },
  textInput: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 6, padding: 10, minHeight: 80, textAlignVertical: 'top', backgroundColor: '#fff', marginBottom: 12, fontSize: 14 },
  row: { flexDirection: 'row', gap: 8 },
  actionButton: { flex: 1, padding: 12, borderRadius: 8, alignItems: 'center', marginTop: 16 },
  approveButton: { backgroundColor: '#16a34a' },
  dangerButton: { backgroundColor: '#ea580c' },
  cancelButton: { backgroundColor: '#6b7280' },
  actionButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 14 },
  backButton: { marginBottom: 12, padding: 8 },
  backButtonText: { color: '#2563eb', fontSize: 15, fontWeight: '500' },
  emptyContainer: { alignItems: 'center', paddingVertical: 40 },
  emptyText: { fontSize: 15, color: '#6b7280' },
  errorText: { fontSize: 14, color: '#dc2626', textAlign: 'center', marginBottom: 12 },
  retryButton: { backgroundColor: '#1e3a5f', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  retryButtonText: { color: '#ffffff', fontWeight: '600' },
});
