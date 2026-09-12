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
  getCompanyWeeklyApprovals,
  getCompanyApprovalDetail,
  resubmitWeeklyApproval,
  resolveDispute,
  reviseApprovedTime,
  formatApiErrorMessage,
} from '../services/api';
import {
  ClientWeeklyApprovalSummary,
  ClientWeeklyApprovalStatus,
  CompanyApprovalDetail,
} from '../types/models';
import { colors } from '../theme';

type ScreenMode = 'list' | 'detail';

function statusLabel(status: ClientWeeklyApprovalStatus): string {
  switch (status) {
    case 'pending_approval': return 'Awaiting Client Approval';
    case 'client_approved': return 'Client Approved';
    case 'disputed': return 'Returned for Correction';
    case 'resolved': return 'Ready to Resubmit';
    case 'locked': return 'Finalised';
    default: return String(status);
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

function formatTime(val: string | Date | null | undefined): string {
  if (!val) return '—';
  try {
    return new Date(val).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

interface Props {
  onSelect?: (id: number) => void;
}

export function CompanyWeeklyApprovalsScreen({ onSelect }: Props) {
  const [mode, setMode] = React.useState<ScreenMode>('list');

  // List state
  const [approvals, setApprovals] = React.useState<ClientWeeklyApprovalSummary[]>([]);
  const [listLoading, setListLoading] = React.useState(true);
  const [listError, setListError] = React.useState<string | null>(null);

  // Detail state
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [detail, setDetail] = React.useState<CompanyApprovalDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [actionLoading, setActionLoading] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  // Dispute resolution state
  const [resolveId, setResolveId] = React.useState<number | null>(null);
  const [resolutionMsg, setResolutionMsg] = React.useState('');

  // P1H-C: Client billing correction state
  const [billingCorrectTimesheetId, setBillingCorrectTimesheetId] = React.useState<number | null>(null);
  const [billingStartInput, setBillingStartInput] = React.useState('');
  const [billingEndInput, setBillingEndInput] = React.useState('');
  const [billingCorrectionReason, setBillingCorrectionReason] = React.useState('');

  const loadList = React.useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const data = await getCompanyWeeklyApprovals();
      setApprovals(data);
    } catch (err) {
      setListError(formatApiErrorMessage(err, 'Failed to load weekly approvals.'));
    } finally {
      setListLoading(false);
    }
  }, []);

  React.useEffect(() => { loadList(); }, [loadList]);

  const openDetail = React.useCallback(async (id: number) => {
    setSelectedId(id);
    setMode('detail');
    setDetailLoading(true);
    setDetailError(null);
    setResolveId(null);
    setResolutionMsg('');
    setBillingCorrectTimesheetId(null);
    setBillingStartInput('');
    setBillingEndInput('');
    setBillingCorrectionReason('');
    setActionError(null);
    try {
      const data = await getCompanyApprovalDetail(id);
      setDetail(data);
    } catch (err) {
      setDetailError(formatApiErrorMessage(err, 'Failed to load details.'));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleResolveDispute = async () => {
    if (!selectedId || !resolveId || !resolutionMsg.trim()) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await resolveDispute(selectedId, resolveId, resolutionMsg.trim());
      setResolveId(null);
      setResolutionMsg('');
      await openDetail(selectedId);
      await loadList();
    } catch (err) {
      setActionError(formatApiErrorMessage(err, 'Failed to resolve dispute.'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleBillingCorrection = async () => {
    if (!selectedId || billingCorrectTimesheetId == null) return;
    const startIso = billingStartInput.trim();
    const endIso = billingEndInput.trim();
    const reason = billingCorrectionReason.trim();
    if (!startIso || !endIso || !reason) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await reviseApprovedTime(selectedId, {
        timesheetId: billingCorrectTimesheetId,
        newBillingStartAt: startIso,
        newBillingEndAt: endIso,
        clientCorrectionReason: reason,
      });
      setBillingCorrectTimesheetId(null);
      setBillingStartInput('');
      setBillingEndInput('');
      setBillingCorrectionReason('');
      await openDetail(selectedId);
    } catch (err) {
      setActionError(formatApiErrorMessage(err, 'Failed to apply billing correction.'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleResubmit = async () => {
    if (!selectedId || !detail) return;
    const ids = detail.lines.map((l) => (l as any).timesheetId).filter(Boolean) as number[];
    if (!ids.length) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await resubmitWeeklyApproval(selectedId, { timesheetIds: ids });
      await openDetail(selectedId);
      await loadList();
    } catch (err) {
      setActionError(formatApiErrorMessage(err, 'Failed to resubmit.'));
    } finally {
      setActionLoading(false);
    }
  };

  // ── DETAIL VIEW ──────────────────────────────────────────────────────────
  if (mode === 'detail') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Pressable style={styles.backButton} onPress={() => { setMode('list'); setDetail(null); setSelectedId(null); }}>
          <Text style={styles.backButtonText}>← Back to list</Text>
        </Pressable>

        {detailLoading ? (
          <ActivityIndicator size="large" color={colors.primaryNavy} style={{ marginTop: 40 }} />
        ) : detailError ? (
          <Text style={styles.errorText}>{detailError}</Text>
        ) : detail ? (
          <>
            <Text style={styles.pageTitle}>{detail.siteName}</Text>
            <Text style={styles.weekRange}>{detail.weekCommencing} — {detail.weekEnding}</Text>
            <View style={[styles.badge, { backgroundColor: statusColor(detail.status), alignSelf: 'flex-start', marginBottom: 12 }]}>
              <Text style={styles.badgeText}>{statusLabel(detail.status)}</Text>
            </View>
            <Text style={styles.totalHours}>Total approved: {Number(detail.weekTotalApprovedHours ?? detail.totalApprovedHours ?? 0).toFixed(2)} hrs</Text>

            {/* ── SHIFT EVIDENCE LAYERS ─── */}
            <Text style={styles.sectionTitle}>Shifts ({detail.lines.length})</Text>
            {detail.lines.map((line) => (
              <View key={line.id} style={styles.lineCard}>
                <Text style={styles.guardName}>{line.guardName ?? 'Guard'}</Text>
                <Text style={styles.shiftDate}>Date: {line.shiftDate}</Text>

                {/* Billing summary card — shown on disputed requests so the hierarchy is immediately visible */}
                {detail.status === 'disputed' && (
                  <View style={styles.billingSummaryCard}>
                    <Text style={styles.billingSummaryTitle}>Billing Summary</Text>
                    {line.timesheet?.hoursWorked != null && (
                      <Text style={styles.billingSummaryRow}>Guard Claim: {Number(line.timesheet.hoursWorked).toFixed(2)} hrs</Text>
                    )}
                    {line.timesheet?.approvedMinutes != null && (
                      <Text style={[styles.billingSummaryRow, { fontWeight: '700' }]}>
                        Guard Pay Approved: {(line.timesheet.approvedMinutes / 60).toFixed(2)} hrs
                      </Text>
                    )}
                    <Text style={styles.billingSummaryRow}>
                      Client Submitted (V{detail.currentVersion}): {Number(line.approvedHoursAtSubmission).toFixed(2)} hrs
                    </Text>
                    {detail.clientSubmissionNote ? (
                      <Text style={styles.billingSummaryComment}>Client Comment: "{detail.clientSubmissionNote}"</Text>
                    ) : null}
                    {line.timesheet?.clientBillingApprovedMinutes != null && (
                      <Text style={[styles.billingSummaryRow, styles.billingCorrectionHighlight]}>
                        Pending Client Billing Correction: {((line.timesheet.clientBillingApprovedMinutes ?? 0) / 60).toFixed(2)} hrs
                      </Text>
                    )}
                  </View>
                )}

                {/* Layer A: Scheduled */}
                <View style={styles.evidenceLayer}>
                  <Text style={styles.layerTitle}>SCHEDULED</Text>
                  <Text style={styles.layerRow}>Book On: {formatTime(line.scheduledStart)}</Text>
                  <Text style={styles.layerRow}>Book Off: {formatTime(line.scheduledEnd)}</Text>
                </View>

                {/* Layer B: Attendance */}
                <View style={styles.evidenceLayer}>
                  <Text style={styles.layerTitle}>ATTENDANCE</Text>
                  <Text style={styles.layerRow}>Check In: {formatTime(line.actualCheckIn)}</Text>
                  <Text style={styles.layerRow}>Check Out: {formatTime(line.actualCheckOut)}</Text>
                  {line.verifiedMinutes != null && (
                    <Text style={styles.layerRow}>GPS Verified: {(line.verifiedMinutes / 60).toFixed(2)} hrs</Text>
                  )}
                </View>

                {/* Layer C: Guard Claim */}
                <View style={styles.evidenceLayer}>
                  <Text style={styles.layerTitle}>GUARD CLAIM</Text>
                  {line.timesheet?.scheduledStartAt && (
                    <Text style={styles.layerRow}>Claimed On: {formatTime(line.timesheet.scheduledStartAt)}</Text>
                  )}
                  {line.timesheet?.scheduledEndAt && (
                    <Text style={styles.layerRow}>Claimed Off: {formatTime(line.timesheet.scheduledEndAt)}</Text>
                  )}
                  {line.timesheet?.hoursWorked != null && (
                    <Text style={styles.layerRow}>Claimed Hours: {Number(line.timesheet.hoursWorked).toFixed(2)} hrs</Text>
                  )}
                </View>

                {/* Layer D: Company Guard-pay Approval (payroll-authoritative — not changed by P1H-C) */}
                <View style={styles.evidenceLayer}>
                  <Text style={styles.layerTitle}>COMPANY GUARD-PAY APPROVAL</Text>
                  {line.timesheet?.companyApprovedStartAt && (
                    <Text style={styles.layerRow}>Approved On: {formatTime(line.timesheet.companyApprovedStartAt)}</Text>
                  )}
                  {line.timesheet?.companyApprovedEndAt && (
                    <Text style={styles.layerRow}>Approved Off: {formatTime(line.timesheet.companyApprovedEndAt)}</Text>
                  )}
                  {line.timesheet?.approvedMinutes != null && (
                    <Text style={[styles.layerRow, { fontWeight: '600' }]}>
                      Guard Pay: {(line.timesheet.approvedMinutes / 60).toFixed(2)} hrs
                    </Text>
                  )}
                  {line.hasOverride && (
                    <View style={styles.adjustedBadge}>
                      <Text style={styles.adjustedBadgeText}>Adjusted</Text>
                    </View>
                  )}
                  {line.timesheet?.overrideReason ? (
                    <Text style={styles.layerRow}>Reason: {line.timesheet.overrideReason}</Text>
                  ) : line.hasOverride ? (
                    <Text style={[styles.layerRow, { fontStyle: 'italic' }]}>Reason: (on timesheet record)</Text>
                  ) : null}
                </View>

                {/* Layer E: Company Client-billing Correction (P1H-C — billing only, independent of payroll) */}
                {detail.status === 'disputed' && (() => {
                  const ts = line.timesheet;
                  const hasPendingCorrection = ts?.clientBillingApprovedMinutes != null;
                  const timesheetId = (line as any).timesheetId ?? null;
                  const disputeForLine = detail.disputes.find(
                    (d) => d.timesheetId === timesheetId && d.status === 'open',
                  );
                  const hasOpenDispute = !!disputeForLine;
                  return (
                    <View style={[styles.evidenceLayer, hasPendingCorrection ? styles.billingCorrectionLayer : null]}>
                      <Text style={styles.layerTitle}>CLIENT BILLING CORRECTION</Text>
                      {hasPendingCorrection ? (
                        <>
                          <Text style={[styles.layerRow, { color: '#0d9488', fontWeight: '700' }]}>
                            Pending Billing: {((ts!.clientBillingApprovedMinutes ?? 0) / 60).toFixed(2)} hrs
                          </Text>
                          {ts?.clientBillingApprovedStartAt && (
                            <Text style={styles.layerRow}>Billing On: {formatTime(ts.clientBillingApprovedStartAt)}</Text>
                          )}
                          {ts?.clientBillingApprovedEndAt && (
                            <Text style={styles.layerRow}>Billing Off: {formatTime(ts.clientBillingApprovedEndAt)}</Text>
                          )}
                          {ts?.clientBillingCorrectionReason && (
                            <Text style={styles.layerRow}>Reason: {ts.clientBillingCorrectionReason}</Text>
                          )}
                          <Text style={[styles.layerRow, { fontSize: 11, color: '#6b7280', marginTop: 4 }]}>
                            Guard pay ({ts?.approvedMinutes != null ? ((ts.approvedMinutes) / 60).toFixed(2) : '—'} hrs) is unchanged.
                          </Text>
                        </>
                      ) : (
                        <Text style={[styles.layerRow, { fontStyle: 'italic', color: '#9ca3af' }]}>
                          No billing correction applied.
                        </Text>
                      )}
                      {hasOpenDispute && timesheetId != null && billingCorrectTimesheetId !== timesheetId && (
                        <Pressable
                          style={[styles.adjustBillingButton, { marginTop: 8 }]}
                          onPress={() => {
                            setBillingCorrectTimesheetId(timesheetId);
                            const prefilledStart = ts?.clientBillingApprovedStartAt ?? ts?.companyApprovedStartAt ?? '';
                            const prefilledEnd = ts?.clientBillingApprovedEndAt ?? ts?.companyApprovedEndAt ?? '';
                            setBillingStartInput(prefilledStart ?? '');
                            setBillingEndInput(prefilledEnd ?? '');
                            setBillingCorrectionReason('');
                          }}
                        >
                          <Text style={styles.adjustBillingButtonText}>
                            {hasPendingCorrection ? 'Revise Billing Hours' : 'Adjust Billing Hours'}
                          </Text>
                        </Pressable>
                      )}
                    </View>
                  );
                })()}

                {/* Layer F: Client-Submitted Snapshot (immutable per version) */}
                <View style={styles.evidenceLayer}>
                  <Text style={styles.layerTitle}>CLIENT-SUBMITTED SNAPSHOT</Text>
                  {line.companyApprovedStartAtSubmission && (
                    <Text style={styles.layerRow}>Submitted On: {formatTime(line.companyApprovedStartAtSubmission)}</Text>
                  )}
                  {line.companyApprovedEndAtSubmission && (
                    <Text style={styles.layerRow}>Submitted Off: {formatTime(line.companyApprovedEndAtSubmission)}</Text>
                  )}
                  <Text style={styles.layerRow}>Approved: {Number(line.approvedHoursAtSubmission).toFixed(2)} hrs</Text>
                </View>
              </View>
            ))}

            {/* ── DISPUTES ─── */}
            {detail.disputes.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Disputes</Text>
                {detail.disputes.map((d) => (
                  <View key={d.id} style={styles.disputeCard}>
                    <Text style={styles.disputeRow}>Shift #{d.timesheetId} — {d.disputeReason}</Text>
                    <Text style={styles.disputeRow}>Status: {d.status}</Text>
                    {d.resolutionMessage && (
                      <Text style={styles.disputeRow}>Resolution: {d.resolutionMessage}</Text>
                    )}
                    {d.status === 'open' && (
                      <Pressable
                        style={styles.resolveButton}
                        onPress={() => { setResolveId(d.id); setResolutionMsg(''); }}
                      >
                        <Text style={styles.resolveButtonText}>Resolve Dispute</Text>
                      </Pressable>
                    )}
                  </View>
                ))}
              </>
            )}

            {/* ── P1H-C BILLING CORRECTION FORM ─── */}
            {billingCorrectTimesheetId != null && (
              <View style={styles.billingCorrectionForm}>
                <Text style={styles.sectionTitle}>Adjust Client Billing Hours</Text>
                <Text style={[styles.layerRow, { marginBottom: 8, color: '#374151' }]}>
                  This adjustment affects CLIENT BILLING ONLY. Guard pay remains unchanged.
                </Text>
                <Text style={styles.formLabel}>Billing Start (ISO 8601, e.g. 2026-01-12T08:00:00Z)</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="e.g. 2026-01-12T08:00:00Z"
                  value={billingStartInput}
                  onChangeText={setBillingStartInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.formLabel}>Billing End (ISO 8601)</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="e.g. 2026-01-12T15:00:00Z"
                  value={billingEndInput}
                  onChangeText={setBillingEndInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.formLabel}>Correction Reason (required)</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="Why is the client billing time being corrected?"
                  value={billingCorrectionReason}
                  onChangeText={setBillingCorrectionReason}
                  multiline
                />
                <View style={styles.row}>
                  <Pressable
                    style={[
                      styles.actionButton,
                      styles.billingCorrectionButton,
                      (!billingStartInput.trim() || !billingEndInput.trim() || !billingCorrectionReason.trim() || actionLoading) && styles.disabledButton,
                    ]}
                    onPress={handleBillingCorrection}
                    disabled={!billingStartInput.trim() || !billingEndInput.trim() || !billingCorrectionReason.trim() || actionLoading}
                  >
                    <Text style={styles.actionButtonText}>{actionLoading ? 'Saving...' : 'Save Billing Correction'}</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.actionButton, styles.cancelButton]}
                    onPress={() => { setBillingCorrectTimesheetId(null); setBillingStartInput(''); setBillingEndInput(''); setBillingCorrectionReason(''); }}
                  >
                    <Text style={styles.actionButtonText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* ── RESOLVE FORM ─── */}
            {resolveId != null && (
              <View style={styles.resolveForm}>
                <Text style={styles.sectionTitle}>Resolve Dispute #{resolveId}</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="Resolution message (required)"
                  value={resolutionMsg}
                  onChangeText={setResolutionMsg}
                  multiline
                />
                <View style={styles.row}>
                  <Pressable
                    style={[styles.actionButton, styles.primaryButton, (!resolutionMsg.trim() || actionLoading) && styles.disabledButton]}
                    onPress={handleResolveDispute}
                    disabled={!resolutionMsg.trim() || actionLoading}
                  >
                    <Text style={styles.actionButtonText}>{actionLoading ? 'Saving...' : 'Submit Resolution'}</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.actionButton, styles.cancelButton]}
                    onPress={() => { setResolveId(null); setResolutionMsg(''); }}
                  >
                    <Text style={styles.actionButtonText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* ── RESUBMIT ─── */}
            {detail.status === 'resolved' && (
              <Pressable
                style={[styles.actionButton, styles.primaryButton, { marginTop: 16 }, actionLoading && styles.disabledButton]}
                onPress={handleResubmit}
                disabled={actionLoading}
              >
                <Text style={styles.actionButtonText}>{actionLoading ? 'Resubmitting...' : 'Resubmit to Client'}</Text>
              </Pressable>
            )}

            {actionError && <Text style={styles.errorText}>{actionError}</Text>}
          </>
        ) : null}
      </ScrollView>
    );
  }

  // ── LIST VIEW (tracking only) ─────────────────────────────────────────────
  if (listLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primaryNavy} />
      </View>
    );
  }

  if (listError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{listError}</Text>
        <Pressable style={styles.retryButton} onPress={loadList}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.listHeader}>
        <Text style={styles.pageTitle}>Client Timesheets</Text>
      </View>

      {approvals.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No weekly submissions yet. Use Company Timesheets to send a week to a client.</Text>
        </View>
      ) : (
        approvals.map((item) => (
          <Pressable
            key={item.id}
            style={styles.card}
            onPress={() => { onSelect?.(item.id); openDetail(item.id); }}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.siteName}>{item.siteName}</Text>
              <View style={[styles.badge, { backgroundColor: statusColor(item.status) }]}>
                <Text style={styles.badgeText}>{statusLabel(item.status)}</Text>
              </View>
            </View>
            <Text style={styles.weekRange}>{item.weekCommencing} — {item.weekEnding}</Text>
            {item.totalApprovedHours != null && (
              <Text style={styles.hoursText}>Total: {Number(item.totalApprovedHours).toFixed(2)} hrs</Text>
            )}
            {item.status === 'disputed' && (
              <Text style={styles.disputeWarning}>Client returned for correction — action required</Text>
            )}
            <Text style={styles.versionText}>Version {item.currentVersion}</Text>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingBottom: 48 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },

  listHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  pageTitle: { fontSize: 20, fontWeight: '700', color: colors.primaryNavy },

  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border ?? '#e2e8f0',
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  siteName: { fontSize: 16, fontWeight: '600', color: colors.primaryNavy, flex: 1, marginRight: 8 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeText: { color: '#ffffff', fontSize: 12, fontWeight: '600' },
  weekRange: { fontSize: 14, color: colors.textSecondary ?? '#374151', marginBottom: 4 },
  hoursText: { fontSize: 14, color: colors.textSecondary ?? '#4b5563', marginBottom: 2 },
  disputeWarning: { fontSize: 13, color: '#ea580c', fontWeight: '600', marginTop: 4 },
  versionText: { fontSize: 12, color: '#9ca3af', marginTop: 4 },
  totalHours: { fontSize: 14, color: colors.textSecondary ?? '#4b5563', marginBottom: 8 },

  backButton: { marginBottom: 16, paddingVertical: 4 },
  backButtonText: { color: colors.accentTealStrong ?? '#0d9488', fontSize: 15, fontWeight: '600' },

  sectionTitle: { fontSize: 16, fontWeight: '700', color: colors.primaryNavy, marginTop: 20, marginBottom: 8 },
  shiftDate: { fontSize: 13, color: colors.textSecondary ?? '#374151', marginBottom: 6 },

  lineCard: {
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border ?? '#e2e8f0',
  },
  guardName: { fontSize: 15, fontWeight: '700', color: colors.primaryNavy, marginBottom: 6 },

  evidenceLayer: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
  layerTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  layerRow: { fontSize: 13, color: '#374151', marginBottom: 2 },

  adjustedBadge: {
    backgroundColor: '#fff7ed',
    borderWidth: 1,
    borderColor: '#ea580c',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
    marginTop: 4,
    marginBottom: 2,
  },
  adjustedBadgeText: { fontSize: 12, color: '#ea580c', fontWeight: '700' },

  disputeCard: { backgroundColor: '#fef2f2', borderRadius: 8, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#fecaca' },
  disputeRow: { fontSize: 13, color: '#374151', marginBottom: 2 },
  resolveButton: { marginTop: 8, backgroundColor: colors.primaryNavy, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6, alignSelf: 'flex-start' },
  resolveButtonText: { color: '#ffffff', fontSize: 13, fontWeight: '600' },

  resolveForm: { backgroundColor: '#f0fdf4', borderRadius: 10, padding: 14, marginTop: 12 },

  row: { flexDirection: 'row', gap: 10, marginTop: 12 },
  actionButton: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  primaryButton: { backgroundColor: colors.primaryNavy },
  cancelButton: { backgroundColor: '#6b7280' },
  disabledButton: { opacity: 0.4 },
  actionButtonText: { color: '#ffffff', fontWeight: '700', fontSize: 14 },

  textInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 10,
    minHeight: 80,
    textAlignVertical: 'top',
    backgroundColor: '#fff',
    fontSize: 14,
    marginBottom: 8,
  },

  emptyContainer: { alignItems: 'center', paddingVertical: 40 },
  emptyText: { fontSize: 15, color: '#6b7280', textAlign: 'center' },
  errorText: { fontSize: 14, color: '#dc2626', textAlign: 'center', marginVertical: 8 },
  retryButton: { backgroundColor: colors.primaryNavy, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, marginTop: 8 },
  retryButtonText: { color: '#ffffff', fontWeight: '600' },

  billingSummaryCard: { backgroundColor: '#f0fdf4', borderRadius: 12, padding: 12, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: '#0d9488' },
  billingSummaryTitle: { color: '#065f46', fontWeight: '800', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
  billingSummaryRow: { fontSize: 13, color: '#374151', lineHeight: 20 },
  billingSummaryComment: { fontSize: 12, color: '#6b7280', fontStyle: 'italic', marginTop: 4 },
  billingCorrectionHighlight: { color: '#0d9488', fontWeight: '700', marginTop: 2 },

  billingCorrectionLayer: { borderWidth: 1, borderColor: '#0d9488', backgroundColor: '#f0fdfa' },
  adjustBillingButton: {
    backgroundColor: '#0d9488',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  adjustBillingButtonText: { color: '#ffffff', fontSize: 13, fontWeight: '600' },
  billingCorrectionForm: { backgroundColor: '#f0fdfa', borderRadius: 10, padding: 14, marginTop: 12, borderWidth: 1, borderColor: '#0d9488' },
  billingCorrectionButton: { backgroundColor: '#0d9488' },
  formLabel: { fontSize: 12, fontWeight: '600', color: '#374151', marginBottom: 4, marginTop: 8 },
});
