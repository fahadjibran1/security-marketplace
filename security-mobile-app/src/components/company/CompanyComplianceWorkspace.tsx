import * as React from 'react';
import { Fragment } from 'react/jsx-runtime';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatApiErrorMessage } from '../../services/api';
import type {
  CompanyGuard,
  CompanyScreeningOutcome,
  ComplianceRecord,
  ComplianceRecordPayload,
  GuardComplianceSummary,
  GuardDocument,
} from '../../types/models';
import { colors, radii, spacing, typography } from '../../theme';
import { StatusBadge } from '../StatusBadge';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { Drawer } from '../ui/Drawer';
import {
  ActionCell,
  PrimaryCell,
  StatusCell,
  TableCell,
  TableEmptyState,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '../ui/TableFoundation';
import { ComplianceGuardDrawerBody } from './ComplianceGuardDrawerBody';
import { ComplianceDataSource, liveComplianceDataSource, PickedDocument } from './complianceDataSource';
import {
  buildComplianceRows,
  ComplianceFilter,
  computeMetrics,
  findRowByGuardId,
  indexScreeningOutcomes,
  maskSiaNumber,
  planGuardTarget,
  recordsForGuard,
  rightToWorkIndicator,
  ScreeningOutcome,
  screeningIndicator,
  selectVisibleRows,
  siaIndicator,
  STATUS_LABELS,
  STATUS_TONES,
  summarizeDocuments,
} from './compliance-model';
import { buildVerificationDialog, createRequestGate, documentBelongsToGuard } from './compliance-selection';
import type { GuardNavTarget } from './guard-navigation';

const IS_WEB = typeof document !== 'undefined';

const FILTER_TABS: Array<{ key: ComplianceFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'valid', label: 'Valid' },
  { key: 'expiring', label: 'Expiring' },
  { key: 'attention', label: 'Needs Attention' },
  { key: 'unknown', label: 'Unknown' },
];

export type CompanyComplianceWorkspaceProps = {
  /** compliance.view — without it the workspace shows an access notice and loads nothing. */
  canViewCompliance?: boolean;
  /** compliance.manage — view evidence file, upload, verify/unverify, save compliance records. UX only; the backend enforces. */
  canManageCompliance?: boolean;
  /** screening.view — Company screening STATUS only. */
  canViewScreening?: boolean;
  currentUserId?: number | null;
  /**
   * One-shot Guard target from the Guards workspace. Applied once this workspace's own data has loaded (or it is
   * known the user cannot view Compliance), then reported back through onTargetConsumed.
   */
  target?: GuardNavTarget | null;
  onTargetConsumed?: (requestId: number) => void;
  /** Defaults to the live API. The visual-QA preview injects fixtures. */
  dataSource?: ComplianceDataSource;
};

type Notice = { tone: 'success' | 'error' | 'warning'; message: string };
type PendingVerification = { document: GuardDocument; verified: boolean; guardId: number; guardName: string };

/**
 * Open a signed, short-lived evidence URL. On web the tab is opened synchronously (inside the click) and
 * navigated once the URL arrives, so pop-up blockers do not swallow it and the evidence page gets no
 * `window.opener`. Returns a handle used to finish or abandon the navigation.
 */
function beginOpenEvidence(): { ok: boolean; finish: (url: string) => void; abandon: () => void } {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const tab = window.open('', '_blank');
    if (!tab) return { ok: false, finish: () => undefined, abandon: () => undefined };
    try {
      tab.opener = null;
    } catch {
      // Best effort: the tab is same-origin about:blank until navigated.
    }
    return {
      ok: true,
      finish: (url: string) => {
        tab.location.href = url;
      },
      abandon: () => tab.close(),
    };
  }
  return {
    ok: true,
    finish: (url: string) => {
      Linking.openURL(url).catch(() => undefined);
    },
    abandon: () => undefined,
  };
}

function categorizeUploadError(message: string): string {
  if (/not configured|service unavailable/i.test(message)) return 'Document storage is temporarily unavailable. Please try again later.';
  if (/session|unauthorized|unauthenticated/i.test(message)) return 'Your session has expired. Please sign in again and retry the upload.';
  if (/network|fetch failed|connection|unreachable/i.test(message)) return 'Unable to reach the upload service. Check your connection and try again.';
  return message;
}

export function CompanyComplianceWorkspace({
  canViewCompliance = true,
  canManageCompliance = false,
  canViewScreening = false,
  currentUserId = null,
  target = null,
  onTargetConsumed,
  dataSource = liveComplianceDataSource,
}: CompanyComplianceWorkspaceProps = {}) {
  const ds = dataSource;
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [summaries, setSummaries] = React.useState<GuardComplianceSummary[]>([]);
  const [companyGuards, setCompanyGuards] = React.useState<CompanyGuard[]>([]);
  const [records, setRecords] = React.useState<ComplianceRecord[] | null>(null);
  const [screening, setScreening] = React.useState<Map<number, ScreeningOutcome> | null>(null);
  const [filter, setFilter] = React.useState<ComplianceFilter>('all');
  const [search, setSearch] = React.useState('');
  const [selectedGuardId, setSelectedGuardId] = React.useState<number | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [viewingId, setViewingId] = React.useState<number | null>(null);
  const [verifyingId, setVerifyingId] = React.useState<number | null>(null);
  const [pendingVerification, setPendingVerification] = React.useState<PendingVerification | null>(null);
  const loadGate = React.useRef(createRequestGate());
  const noticeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = React.useCallback((next: Notice | null) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(next);
    if (next?.tone === 'success') noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  }, []);
  React.useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  // One load = one call each (statuses, guards, records, screening batch). Never per Guard. A gate drops any
  // response that has been superseded by a newer load.
  const load = React.useCallback(async (mode: 'initial' | 'refresh') => {
    const token = loadGate.current.next();
    if (mode === 'initial') setPhase('loading');
    else setRefreshing(true);
    showNotice(null);
    const [statuses, guards, recordList, screeningList] = await Promise.allSettled([
      ds.listStatuses(),
      ds.listGuards(),
      canManageCompliance ? ds.listRecords() : Promise.resolve(null),
      canViewScreening ? ds.listScreeningOutcomes() : Promise.resolve(null),
    ]);
    if (!loadGate.current.isCurrent(token)) return;

    if (statuses.status === 'rejected') {
      const message = formatApiErrorMessage(statuses.reason, 'Unable to load compliance records.');
      if (mode === 'initial') {
        setLoadError(message);
        setPhase('error');
      } else {
        showNotice({ tone: 'error', message });
      }
      setRefreshing(false);
      return;
    }

    setSummaries(statuses.value);
    if (guards.status === 'fulfilled') setCompanyGuards(guards.value);
    setRecords(recordList.status === 'fulfilled' ? (recordList.value as ComplianceRecord[] | null) : null);
    setScreening(
      screeningList.status === 'fulfilled' && screeningList.value
        ? indexScreeningOutcomes(screeningList.value as CompanyScreeningOutcome[])
        : null,
    );
    const partial: string[] = [];
    if (canViewScreening && screeningList.status === 'rejected') partial.push('screening status');
    if (canManageCompliance && recordList.status === 'rejected') partial.push('compliance records');
    if (partial.length) showNotice({ tone: 'warning', message: `Some information could not be loaded: ${partial.join(' and ')}. Refresh to try again.` });
    setLoadError(null);
    setPhase('ready');
    setRefreshing(false);
  }, [canManageCompliance, canViewScreening, ds, showNotice]);

  React.useEffect(() => {
    if (!canViewCompliance) return;
    load('initial');
  }, [canViewCompliance, load]);

  const rows = React.useMemo(() => buildComplianceRows(summaries, companyGuards), [summaries, companyGuards]);
  const metrics = React.useMemo(() => computeMetrics(rows), [rows]);
  const visibleRows = React.useMemo(() => selectVisibleRows(rows, filter, search), [rows, filter, search]);
  // The drawer is bound to ONE Guard id and resolved strictly from ALL rows (not the filtered table), so
  // filtering or searching never swaps the Guard under an open drawer and never falls back to another Guard.
  const activeRow = React.useMemo(() => findRowByGuardId(rows, selectedGuardId), [rows, selectedGuardId]);

  React.useEffect(() => {
    if (selectedGuardId !== null && !activeRow && phase === 'ready') setSelectedGuardId(null);
  }, [activeRow, phase, selectedGuardId]);
  React.useEffect(() => {
    setPendingVerification((current) => (current && current.guardId !== selectedGuardId ? null : current));
  }, [selectedGuardId]);

  const closeDrawer = () => setSelectedGuardId(null);

  // Targeted navigation (Guards → View Compliance). One-shot: waits for this workspace's OWN data (never consumed
  // while loading or after a failed load), resets filter + search so the Guard is visible, opens the Guard only if it
  // is in the loaded rows (strict lookup, no fallback), then reports the request consumed. Normal use resumes.
  const handledTargetRequest = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!target || handledTargetRequest.current === target.requestId) return;
    if (!canViewCompliance) {
      // Authoritative: this user cannot view Compliance, so there is nothing to open. No bypass.
      handledTargetRequest.current = target.requestId;
      onTargetConsumed?.(target.requestId);
      return;
    }
    if (phase !== 'ready') return;
    handledTargetRequest.current = target.requestId;
    const plan = planGuardTarget(rows, target.guardId);
    setFilter(plan.filter);
    setSearch(plan.search);
    setSelectedGuardId(plan.selectedGuardId);
    if (!plan.found) showNotice({ tone: 'warning', message: 'That guard is not in the compliance list, so no guard was opened.' });
    onTargetConsumed?.(target.requestId);
  }, [target, phase, rows, canViewCompliance, onTargetConsumed, showNotice]);

  // ── Document actions (all bound to the active Guard) ────────────────────────
  const viewDocument = React.useCallback(async (document: GuardDocument) => {
    if (!activeRow || !documentBelongsToGuard(document, activeRow.guardId)) {
      showNotice({ tone: 'error', message: 'This document does not belong to the selected guard. Reopen the guard and try again.' });
      return;
    }
    const target = beginOpenEvidence();
    if (!target.ok) {
      showNotice({ tone: 'error', message: 'Your browser blocked the new tab. Allow pop-ups for this site, then choose View document again.' });
      return;
    }
    setViewingId(document.id);
    try {
      // Short-lived signed URL; the permanent storage location is never exposed to the browser.
      const access = await ds.accessDocument(document.id);
      target.finish(access.url);
      showNotice({ tone: 'success', message: 'Document opened in a new tab. The secure link expires after a few minutes — choose View document again if it stops working.' });
    } catch (error) {
      target.abandon();
      showNotice({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to open this document. It may be unavailable or you may not have permission to view it.') });
    } finally {
      setViewingId(null);
    }
  }, [activeRow, ds, showNotice]);

  const requestVerification = React.useCallback((document: GuardDocument, verified: boolean) => {
    if (!activeRow || !documentBelongsToGuard(document, activeRow.guardId)) {
      showNotice({ tone: 'error', message: 'This document does not belong to the selected guard. Reopen the guard and try again.' });
      return;
    }
    setPendingVerification({ document, verified, guardId: activeRow.guardId, guardName: activeRow.fullName });
  }, [activeRow, showNotice]);

  const confirmVerification = React.useCallback(async () => {
    const pending = pendingVerification;
    if (!pending) return;
    // The action must still target the Guard it was opened for.
    if (pending.guardId !== selectedGuardId) {
      setPendingVerification(null);
      showNotice({ tone: 'error', message: 'The selected guard changed. Nothing was updated — review the document again.' });
      return;
    }
    setVerifyingId(pending.document.id);
    try {
      await ds.verifyDocument(pending.document.id, pending.verified);
      setPendingVerification(null);
      await load('refresh');
      showNotice({ tone: 'success', message: `Document ${pending.verified ? 'verified' : 'marked unverified'}.` });
    } catch (error) {
      setPendingVerification(null);
      showNotice({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to update document verification.') });
    } finally {
      setVerifyingId(null);
    }
  }, [ds, load, pendingVerification, selectedGuardId, showNotice]);

  const uploadDocument = React.useCallback(async (
    guardId: number,
    input: { type: string; file: PickedDocument; expiryDate: string },
  ): Promise<string | null> => {
    try {
      await ds.uploadDocument({ guardId, type: input.type, file: input.file, expiryDate: input.expiryDate || null });
    } catch (error) {
      return categorizeUploadError(error instanceof Error ? error.message : 'Upload failed. Please try again.');
    }
    await load('refresh');
    showNotice({ tone: 'success', message: 'Document uploaded. It is Pending until it has been verified.' });
    return null;
  }, [ds, load, showNotice]);

  const saveRecord = React.useCallback(async (
    guardId: number,
    payload: Omit<ComplianceRecordPayload, 'guardId'>,
  ): Promise<string | null> => {
    try {
      await ds.saveRecord({ ...payload, guardId });
    } catch (error) {
      return formatApiErrorMessage(error, 'Unable to save compliance record.');
    }
    await load('refresh');
    showNotice({ tone: 'success', message: 'Compliance record saved.' });
    return null;
  }, [ds, load, showNotice]);

  const verificationDialog = pendingVerification
    ? buildVerificationDialog({ guardName: pendingVerification.guardName, document: pendingVerification.document, verified: pendingVerification.verified })
    : null;

  // ── Render ────────────────────────────────────────────────────────────────
  if (!canViewCompliance) {
    return (
      <View style={styles.stateCard}>
        <Text style={styles.stateTitle}>Compliance is not available for your role</Text>
        <Text style={styles.stateText}>Ask a company owner or administrator if you need access to Guard compliance.</Text>
      </View>
    );
  }

  if (phase === 'loading') {
    return (
      <View style={styles.stateCard} accessibilityLiveRegion="polite">
        <ActivityIndicator color={colors.accentTeal} />
        <Text style={styles.stateText}>Loading compliance…</Text>
      </View>
    );
  }

  if (phase === 'error') {
    return (
      <View style={styles.stateCard}>
        <Text style={styles.stateTitle}>Compliance could not be loaded</Text>
        <Text style={styles.stateText}>{loadError}</Text>
        <Button label="Retry" onPress={() => load('initial')} />
      </View>
    );
  }

  const screeningFor = (guardId: number): ScreeningOutcome | null | undefined => {
    if (!canViewScreening || !screening) return undefined;
    // A Guard the batch did not return has no outcome to show; do not invent one.
    return screening.get(guardId) ?? null;
  };

  return (
    <View style={styles.root}>
      {/* ── Summary strip ─────────────────────────────────────────────── */}
      <View style={styles.summaryStrip}>
        <MetricChip label="Total Guards" value={metrics.total} active={filter === 'all'} onPress={() => setFilter('all')} />
        <MetricChip label="Valid" value={metrics.valid} active={filter === 'valid'} tone="success" onPress={() => setFilter('valid')} />
        <MetricChip label="Expiring" value={metrics.expiring} active={filter === 'expiring'} tone="warning" onPress={() => setFilter('expiring')} />
        <MetricChip
          label="Needs Attention"
          value={metrics.needsAttention}
          active={filter === 'attention'}
          tone={metrics.needsAttention > 0 ? 'danger' : 'neutral'}
          onPress={() => setFilter('attention')}
        />
      </View>

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <View style={styles.toolbar}>
        <View style={styles.toolbarRow}>
          <View style={styles.searchWrapper}>
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder="Search by guard name or SIA number…"
              placeholderTextColor={colors.textSecondary}
              clearButtonMode="while-editing"
              accessibilityLabel="Search guards"
            />
          </View>
          <Button label="Refresh" variant="secondary" size="sm" onPress={() => load('refresh')} loading={refreshing} />
        </View>
        <View style={styles.filterTabs}>
          {FILTER_TABS.map((tab) => (
            <Pressable
              key={tab.key}
              style={[styles.filterTab, filter === tab.key && styles.filterTabActive]}
              onPress={() => setFilter(tab.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === tab.key }}
            >
              <Text style={[styles.filterTabText, filter === tab.key && styles.filterTabTextActive]}>
                {tab.label}
                {tab.key === 'unknown' && metrics.unknown > 0 ? ` (${metrics.unknown})` : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {notice ? (
        <View style={[styles.notice, notice.tone === 'error' ? styles.noticeError : notice.tone === 'warning' ? styles.noticeWarning : styles.noticeSuccess]}>
          <Text style={styles.noticeText}>{notice.message}</Text>
          <Pressable onPress={() => showNotice(null)} accessibilityRole="button" accessibilityLabel="Dismiss message" hitSlop={10}>
            <Text style={styles.noticeDismiss}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <View style={styles.tableCard}>
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.tableScrollContent}>
          <View style={styles.tableInner}>
            <TableHeader>
              <TableHeaderCell label="Guard" flex={2} />
              <TableHeaderCell label="Compliance" flex={1.1} />
              <TableHeaderCell label="SIA" flex={1.3} />
              <TableHeaderCell label="Right to work" flex={1.3} />
              <TableHeaderCell label="Documents" flex={1.4} />
              <TableHeaderCell label="Screening" flex={1.2} />
              <TableHeaderCell label="" width={136} />
            </TableHeader>

            {visibleRows.length === 0 ? (
              <TableEmptyState
                message={
                  rows.length === 0
                    ? 'No guards to review.\nLink Guards from the Guards workspace first.'
                    : 'No guards match your search or filter.'
                }
                actionLabel={rows.length > 0 ? 'Clear search and filter' : undefined}
                onAction={rows.length > 0 ? () => { setSearch(''); setFilter('all'); } : undefined}
              />
            ) : (
              visibleRows.map((row) => {
                const sia = siaIndicator(row.summary);
                const rtw = rightToWorkIndicator(row.summary);
                const docs = summarizeDocuments(row.summary);
                const outcome = screeningFor(row.guardId);
                const screeningBadge = screeningIndicator(outcome);
                return (
                  <Fragment key={row.guardId}>
                  <TableRow onPress={() => setSelectedGuardId(row.guardId)} selected={selectedGuardId === row.guardId}>
                    <PrimaryCell label={row.fullName} subtitle={maskSiaNumber(row.summary?.siaLicenceNumber) ? `SIA ${maskSiaNumber(row.summary?.siaLicenceNumber)}` : undefined} flex={2} />
                    <StatusCell label={STATUS_LABELS[row.status]} tone={STATUS_TONES[row.status]} flex={1.1} />
                    <TableCell flex={1.3}>
                      <Indicator label={sia.label} detail={sia.detail} tone={sia.tone} />
                    </TableCell>
                    <TableCell flex={1.3}>
                      <Indicator label={rtw.label} detail={rtw.detail} tone={rtw.tone} />
                    </TableCell>
                    <TableCell flex={1.4}>
                      {docs ? (
                        <View style={styles.cellStack}>
                          <Text style={[styles.cellStrong, { color: toneColor(docs.tone) }]}>{docs.headline}</Text>
                          {docs.detail ? <Text style={styles.cellDetail}>{docs.detail}</Text> : null}
                        </View>
                      ) : (
                        <Text style={styles.cellMuted}>—</Text>
                      )}
                    </TableCell>
                    <TableCell flex={1.2}>
                      {screeningBadge.label === '—' ? (
                        <Text style={styles.cellMuted}>—</Text>
                      ) : (
                        <StatusBadge label={screeningBadge.label} tone={screeningBadge.tone} size="small" />
                      )}
                    </TableCell>
                    <ActionCell width={136}>
                      <Text style={styles.actionLink}>{row.status === 'unknown' ? 'Review compliance ›' : 'Review ›'}</Text>
                    </ActionCell>
                  </TableRow>
                  </Fragment>
                );
              })
            )}
          </View>
        </ScrollView>
      </View>

      {/* ── Guard drawer ──────────────────────────────────────────────── */}
      <Drawer
        visible={activeRow !== null}
        onClose={closeDrawer}
        title={activeRow?.fullName ?? 'Guard'}
        subtitle={activeRow ? `${STATUS_LABELS[activeRow.status]} compliance` : undefined}
        width={520}
        compact
        footer={<Button label="Close" variant="secondary" onPress={closeDrawer} />}
      >
        {activeRow ? (
          <Fragment key={activeRow.guardId}>
          <ComplianceGuardDrawerBody
            row={activeRow}
            canManage={canManageCompliance}
            canViewScreening={canViewScreening}
            screening={screeningFor(activeRow.guardId)}
            screeningUnavailable={canViewScreening && screening === null}
            records={canManageCompliance && records ? recordsForGuard(records, activeRow.guardId) : null}
            currentUserId={currentUserId}
            viewingId={viewingId}
            verifyingId={verifyingId}
            onView={viewDocument}
            onRequestVerification={requestVerification}
            onPickDocument={() => ds.pickDocument()}
            onUploadDocument={(input) => uploadDocument(activeRow.guardId, input)}
            onSaveRecord={(payload) => saveRecord(activeRow.guardId, payload)}
            onReview={() => load('refresh')}
          />
          </Fragment>
        ) : null}
      </Drawer>

      <ConfirmationDialog
        visible={Boolean(pendingVerification && verificationDialog)}
        onClose={() => setPendingVerification(null)}
        onConfirm={confirmVerification}
        title={verificationDialog?.title ?? ''}
        message={verificationDialog?.message ?? ''}
        confirmLabel={verificationDialog?.confirmLabel}
        variant={verificationDialog?.variant}
        loading={verifyingId !== null}
      />
    </View>
  );
}

// ─── Small presentational pieces ──────────────────────────────────────────────

function toneColor(tone: string) {
  if (tone === 'success') return colors.success;
  if (tone === 'warning') return colors.warning;
  if (tone === 'danger') return colors.danger;
  return colors.textPrimary;
}

/** Neutral values render as plain text; anything that needs attention renders as a badge with the date underneath. */
function Indicator({ label, detail, tone }: { label: string; detail?: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'pending' | 'neutral' }) {
  if (label === '—') return <Text style={styles.cellMuted}>—</Text>;
  if (tone === 'neutral') return <Text style={styles.cellStrong}>{label}</Text>;
  return (
    <View style={styles.cellStack}>
      <StatusBadge label={label} tone={tone} size="small" />
      {detail ? <Text style={styles.cellDetail}>{detail}</Text> : null}
    </View>
  );
}

function MetricChip({
  label,
  value,
  onPress,
  active,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  onPress: () => void;
  active: boolean;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const valueColor = tone === 'success' ? colors.success : tone === 'warning' ? colors.warning : tone === 'danger' ? colors.danger : colors.primaryNavy;
  return (
    <Pressable
      style={[styles.metricChip, active && styles.metricChipActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label}: ${value}`}
    >
      <Text style={[styles.metricValue, { color: active ? colors.accentTeal : valueColor }]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.lg },

  // Whole-workspace states
  stateCard: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.md,
  },
  stateTitle: { ...typography.panelHeading, color: colors.textPrimary, textAlign: 'center' },
  stateText: { ...typography.body, color: colors.textSecondary, textAlign: 'center' },

  // Summary strip
  summaryStrip: { flexDirection: 'row', gap: spacing.md, flexWrap: 'wrap' },
  metricChip: {
    flex: 1,
    minWidth: 132, // 2×2 on small screens (390–430), four across from ~600px up
    minHeight: 44,
    backgroundColor: colors.card,
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
    ...(IS_WEB ? ({ cursor: 'pointer' } as any) : {}),
  },
  metricChipActive: { borderColor: colors.accentTeal, backgroundColor: colors.accentTealSoft },
  metricValue: { fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  metricLabel: { ...typography.caption, color: colors.textSecondary },

  // Toolbar
  toolbar: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  toolbarRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  searchWrapper: { flex: 1 },
  searchInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    minHeight: 44,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceSubtle,
    ...(IS_WEB ? ({ outlineStyle: 'none' } as any) : {}),
  },
  filterTabs: { flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap' },
  filterTab: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    ...(IS_WEB ? ({ cursor: 'pointer' } as any) : {}),
  },
  filterTabActive: { backgroundColor: colors.primaryNavy, borderColor: colors.primaryNavy },
  filterTabText: { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  filterTabTextActive: { color: '#FFFFFF' },

  // Notice
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  noticeSuccess: { backgroundColor: colors.successSurface, borderColor: colors.successBorder },
  noticeWarning: { backgroundColor: colors.warningSurface, borderColor: colors.warningBorder },
  noticeError: { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder },
  noticeText: { flex: 1, fontSize: 13, color: colors.textPrimary, fontWeight: '600', lineHeight: 18 },
  noticeDismiss: { fontSize: 14, color: colors.textSecondary, fontWeight: '700', paddingHorizontal: 4 },

  // Table
  tableCard: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  tableScrollContent: { flexGrow: 1, minWidth: 940 },
  tableInner: { flex: 1, minWidth: 940 },
  cellStack: { gap: 2, alignItems: 'flex-start' },
  cellStrong: { fontSize: 13, color: colors.textPrimary, fontWeight: '600' },
  cellDetail: { fontSize: 12, color: colors.textSecondary },
  cellMuted: { fontSize: 13, color: colors.textSecondary },
  actionLink: { fontSize: 13, color: colors.accentTeal, fontWeight: '700' },
});
