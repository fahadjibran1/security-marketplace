import * as React from 'react';
import {
  ActivityIndicator,
  Modal,
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
  getEligibleTimesheets,
  submitWeeklyApproval,
  resubmitWeeklyApproval,
  resolveDispute,
  listSites,
  formatApiErrorMessage,
} from '../services/api';
import {
  ClientWeeklyApprovalSummary,
  ClientWeeklyApprovalStatus,
  CompanyApprovalDetail,
  EligibleTimesheetRow,
  Site,
} from '../types/models';
import { colors } from '../theme';

type ScreenMode = 'list' | 'detail' | 'new-submission';

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

function approvedHours(ts: EligibleTimesheetRow): number {
  if (ts.approvedHours != null) return Number(ts.approvedHours);
  if (ts.approvedMinutes != null) return Number(ts.approvedMinutes) / 60;
  return 0;
}

function guardName(ts: EligibleTimesheetRow): string {
  return ts.guard?.fullName ?? ts.shift?.guard?.fullName ?? 'Guard';
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

  // New submission state
  const [sites, setSites] = React.useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = React.useState(false);
  const [subSiteId, setSubSiteId] = React.useState<number | null>(null);
  const [subWeek, setSubWeek] = React.useState('');
  const [eligibleShifts, setEligibleShifts] = React.useState<EligibleTimesheetRow[]>([]);
  const [eligibleLoading, setEligibleLoading] = React.useState(false);
  const [eligibleError, setEligibleError] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());
  const [companyNote, setCompanyNote] = React.useState('');
  const [clientNote, setClientNote] = React.useState('');
  const [showConfirm, setShowConfirm] = React.useState(false);
  const [submitLoading, setSubmitLoading] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

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

  const handleResubmit = async () => {
    if (!selectedId || !detail) return;
    const ids = detail.lines.map((l) => (l as any).timesheetId).filter(Boolean) as number[];
    if (!ids.length) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await resubmitWeeklyApproval(selectedId, { timesheetIds: ids, companyInternalNote: companyNote || undefined });
      await openDetail(selectedId);
      await loadList();
    } catch (err) {
      setActionError(formatApiErrorMessage(err, 'Failed to resubmit.'));
    } finally {
      setActionLoading(false);
    }
  };

  const openNewSubmission = async () => {
    setMode('new-submission');
    setSubSiteId(null);
    setSubWeek('');
    setEligibleShifts([]);
    setSelectedIds(new Set());
    setCompanyNote('');
    setClientNote('');
    setSubmitError(null);
    setSitesLoading(true);
    try {
      const data = await listSites();
      setSites(data);
    } catch {
      setSites([]);
    } finally {
      setSitesLoading(false);
    }
  };

  const loadEligible = async () => {
    if (!subSiteId || !subWeek.trim()) return;
    setEligibleLoading(true);
    setEligibleError(null);
    setEligibleShifts([]);
    setSelectedIds(new Set());
    try {
      const rows = await getEligibleTimesheets(subSiteId, subWeek.trim());
      setEligibleShifts(rows);
      setSelectedIds(new Set(rows.map((r) => r.id)));
    } catch (err) {
      setEligibleError(formatApiErrorMessage(err, 'Failed to load eligible shifts.'));
    } finally {
      setEligibleLoading(false);
    }
  };

  const toggleId = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedTotal = eligibleShifts
    .filter((r) => selectedIds.has(r.id))
    .reduce((sum, r) => sum + approvedHours(r), 0);

  const handleSubmit = async () => {
    if (!subSiteId || !subWeek.trim() || selectedIds.size === 0) return;
    const site = sites.find((s) => s.id === subSiteId);
    if (!site?.clientId) { setSubmitError('Site has no client assigned.'); return; }
    setSubmitLoading(true);
    setSubmitError(null);
    try {
      await submitWeeklyApproval({
        clientId: site.clientId,
        siteId: subSiteId,
        weekCommencing: subWeek.trim(),
        timesheetIds: Array.from(selectedIds),
        companyInternalNote: companyNote.trim() || undefined,
        clientSubmissionNote: clientNote.trim() || undefined,
      });
      setShowConfirm(false);
      setMode('list');
      await loadList();
    } catch (err) {
      setSubmitError(formatApiErrorMessage(err, 'Submission failed.'));
      setShowConfirm(false);
    } finally {
      setSubmitLoading(false);
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

                {/* Layer D: Company Approval (live timesheet values) */}
                <View style={styles.evidenceLayer}>
                  <Text style={styles.layerTitle}>COMPANY APPROVAL</Text>
                  {line.timesheet?.companyApprovedStartAt && (
                    <Text style={styles.layerRow}>Approved On: {formatTime(line.timesheet.companyApprovedStartAt)}</Text>
                  )}
                  {line.timesheet?.companyApprovedEndAt && (
                    <Text style={styles.layerRow}>Approved Off: {formatTime(line.timesheet.companyApprovedEndAt)}</Text>
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

                {/* Layer E: Client-Submitted Snapshot */}
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

  // ── NEW SUBMISSION VIEW ──────────────────────────────────────────────────
  if (mode === 'new-submission') {
    const selectedSite = sites.find((s) => s.id === subSiteId);
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Pressable style={styles.backButton} onPress={() => setMode('list')}>
          <Text style={styles.backButtonText}>← Back to list</Text>
        </Pressable>
        <Text style={styles.pageTitle}>New Weekly Submission</Text>

        {/* Site selector */}
        <Text style={styles.sectionTitle}>Select Site</Text>
        {sitesLoading ? (
          <ActivityIndicator size="small" color={colors.primaryNavy} />
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
            <View style={styles.sitePicker}>
              {sites.filter((s) => s.clientId).map((s) => (
                <Pressable
                  key={s.id}
                  style={[styles.siteChip, subSiteId === s.id && styles.siteChipActive]}
                  onPress={() => { setSubSiteId(s.id); setEligibleShifts([]); setSelectedIds(new Set()); }}
                >
                  <Text style={[styles.siteChipText, subSiteId === s.id && styles.siteChipTextActive]}>{s.name}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        )}
        {selectedSite && <Text style={styles.clientLabel}>Client: {selectedSite.clientName ?? `#${selectedSite.clientId}`}</Text>}

        {/* Week picker */}
        <Text style={styles.sectionTitle}>Week Commencing (YYYY-MM-DD)</Text>
        <TextInput
          style={styles.textInput}
          placeholder="e.g. 2026-09-07"
          value={subWeek}
          onChangeText={(v: string) => { setSubWeek(v); setEligibleShifts([]); setSelectedIds(new Set()); }}
          autoCapitalize="none"
        />

        <Pressable
          style={[styles.actionButton, styles.primaryButton, (!subSiteId || !subWeek.trim()) && styles.disabledButton]}
          onPress={loadEligible}
          disabled={!subSiteId || !subWeek.trim()}
        >
          <Text style={styles.actionButtonText}>Load Eligible Shifts</Text>
        </Pressable>

        {eligibleLoading && <ActivityIndicator size="large" color={colors.primaryNavy} style={{ marginTop: 16 }} />}
        {eligibleError && <Text style={styles.errorText}>{eligibleError}</Text>}

        {/* Eligible shifts with checkboxes */}
        {eligibleShifts.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Eligible Shifts ({eligibleShifts.length})</Text>
            {eligibleShifts.map((ts) => {
              const checked = selectedIds.has(ts.id);
              const hrs = approvedHours(ts);
              return (
                <Pressable key={ts.id} style={[styles.lineCard, checked && styles.lineCardSelected]} onPress={() => toggleId(ts.id)}>
                  <View style={styles.checkRow}>
                    <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                      {checked && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={styles.guardName}>{guardName(ts)}</Text>
                  </View>
                  <Text style={styles.shiftDate}>
                    {ts.scheduledStartAt ? new Date(ts.scheduledStartAt).toLocaleDateString() : 'Unknown date'}
                  </Text>
                  <View style={styles.evidenceLayer}>
                    <Text style={styles.layerTitle}>SCHEDULED</Text>
                    <Text style={styles.layerRow}>On: {formatTime(ts.scheduledStartAt)} — Off: {formatTime(ts.scheduledEndAt)}</Text>
                  </View>
                  <View style={styles.evidenceLayer}>
                    <Text style={styles.layerTitle}>ATTENDANCE</Text>
                    {ts.actualCheckInAt && <Text style={styles.layerRow}>Check In: {formatTime(ts.actualCheckInAt)}</Text>}
                    {ts.actualCheckOutAt && <Text style={styles.layerRow}>Check Out: {formatTime(ts.actualCheckOutAt)}</Text>}
                  </View>
                  <View style={styles.evidenceLayer}>
                    <Text style={styles.layerTitle}>GUARD CLAIM</Text>
                    <Text style={styles.layerRow}>Claimed: {Number(ts.hoursWorked).toFixed(2)} hrs</Text>
                  </View>
                  <View style={styles.evidenceLayer}>
                    <Text style={styles.layerTitle}>COMPANY APPROVAL</Text>
                    {ts.companyApprovedStartAt && <Text style={styles.layerRow}>Approved On: {formatTime(ts.companyApprovedStartAt)}</Text>}
                    {ts.companyApprovedEndAt && <Text style={styles.layerRow}>Approved Off: {formatTime(ts.companyApprovedEndAt)}</Text>}
                    <Text style={styles.layerRow}>Approved: {hrs.toFixed(2)} hrs</Text>
                    {ts.overrideReason && <Text style={styles.layerRow}>Reason: {ts.overrideReason}</Text>}
                  </View>
                </Pressable>
              );
            })}

            {/* Summary */}
            <View style={styles.summaryCard}>
              <Text style={styles.summaryTitle}>Summary</Text>
              <Text style={styles.summaryRow}>{selectedIds.size} shifts selected</Text>
              <Text style={styles.summaryRow}>Total approved hours: {selectedTotal.toFixed(2)} hrs</Text>
            </View>

            {/* Notes */}
            <Text style={styles.sectionTitle}>Internal Note (company only)</Text>
            <TextInput style={styles.textInput} placeholder="Optional" value={companyNote} onChangeText={setCompanyNote} multiline />
            <Text style={styles.sectionTitle}>Client Note</Text>
            <TextInput style={styles.textInput} placeholder="Optional — visible to client" value={clientNote} onChangeText={setClientNote} multiline />

            {submitError && <Text style={styles.errorText}>{submitError}</Text>}

            <Pressable
              style={[styles.actionButton, styles.primaryButton, (selectedIds.size === 0 || submitLoading) && styles.disabledButton]}
              onPress={() => setShowConfirm(true)}
              disabled={selectedIds.size === 0 || submitLoading}
            >
              <Text style={styles.actionButtonText}>Review & Submit</Text>
            </Pressable>
          </>
        )}

        {eligibleShifts.length === 0 && !eligibleLoading && subSiteId && subWeek && !eligibleError && (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No eligible approved shifts found for this site and week.</Text>
          </View>
        )}

        {/* Confirmation modal */}
        <Modal visible={showConfirm} transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Confirm Submission</Text>
              <Text style={styles.modalBody}>
                Submit {selectedIds.size} shift{selectedIds.size !== 1 ? 's' : ''} ({selectedTotal.toFixed(2)} hrs) to client for approval?
              </Text>
              {selectedSite && <Text style={styles.modalBody}>Site: {selectedSite.name}</Text>}
              <Text style={styles.modalBody}>Week: {subWeek}</Text>
              <View style={styles.row}>
                <Pressable
                  style={[styles.actionButton, styles.primaryButton, submitLoading && styles.disabledButton]}
                  onPress={handleSubmit}
                  disabled={submitLoading}
                >
                  <Text style={styles.actionButtonText}>{submitLoading ? 'Submitting...' : 'Confirm Submit'}</Text>
                </Pressable>
                <Pressable style={[styles.actionButton, styles.cancelButton]} onPress={() => setShowConfirm(false)}>
                  <Text style={styles.actionButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </ScrollView>
    );
  }

  // ── LIST VIEW ────────────────────────────────────────────────────────────
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
        <Pressable style={styles.newButton} onPress={openNewSubmission}>
          <Text style={styles.newButtonText}>+ New Submission</Text>
        </Pressable>
      </View>

      {approvals.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No weekly approval requests yet.</Text>
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
  newButton: { backgroundColor: colors.primaryNavy, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  newButtonText: { color: '#ffffff', fontWeight: '700', fontSize: 14 },

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
  lineCardSelected: { borderColor: colors.primaryNavy, borderWidth: 2 },
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

  // Site picker
  sitePicker: { flexDirection: 'row', gap: 8 },
  siteChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#f1f5f9', borderWidth: 1, borderColor: '#e2e8f0' },
  siteChipActive: { backgroundColor: colors.primaryNavy, borderColor: colors.primaryNavy },
  siteChipText: { fontSize: 14, color: colors.primaryNavy, fontWeight: '600' },
  siteChipTextActive: { color: '#ffffff' },
  clientLabel: { fontSize: 13, color: colors.textSecondary ?? '#6b7280', marginBottom: 4 },

  // Checkbox
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.primaryNavy,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  checkboxChecked: { backgroundColor: colors.primaryNavy },
  checkmark: { color: '#ffffff', fontSize: 13, fontWeight: '700' },

  // Summary
  summaryCard: {
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 14,
    marginTop: 16,
    borderWidth: 1,
    borderColor: colors.primaryNavy,
  },
  summaryTitle: { fontSize: 14, fontWeight: '700', color: colors.primaryNavy, marginBottom: 6 },
  summaryRow: { fontSize: 14, color: colors.primaryNavy },

  // Actions
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

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 480 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: colors.primaryNavy, marginBottom: 12 },
  modalBody: { fontSize: 14, color: '#374151', marginBottom: 6 },

  emptyContainer: { alignItems: 'center', paddingVertical: 40 },
  emptyText: { fontSize: 15, color: '#6b7280' },
  errorText: { fontSize: 14, color: '#dc2626', textAlign: 'center', marginVertical: 8 },
  retryButton: { backgroundColor: colors.primaryNavy, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, marginTop: 8 },
  retryButtonText: { color: '#ffffff', fontWeight: '600' },
});
