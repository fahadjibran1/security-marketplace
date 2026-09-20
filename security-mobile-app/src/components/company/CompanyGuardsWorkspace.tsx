import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Fragment } from 'react/jsx-runtime';

import type { CompanyGuard, ComplianceRecord, GuardProfile, Shift } from '../../types/models';
import { colors, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { StatusBadge } from '../StatusBadge';
import type { StatusTone } from '../StatusBadge';
import {
  ActionCell,
  MetaCell,
  PrimaryCell,
  StatusCell,
  TableCell,
  TableEmptyState,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '../ui/TableFoundation';

const IS_WEB = typeof document !== 'undefined';

// ─── Types ────────────────────────────────────────────────────────────────────

type FilterKey = 'all' | 'active' | 'needs-attention' | 'on-shift' | 'blocked';

type PendingAction = {
  type: 'block' | 'inactive' | 'reactivate';
  companyGuardId: number;
  guardName: string;
  futureReadyCount: number;
  outstandingOfferCount: number;
  inProgressCount: number;
};

export type CompanyGuardsWorkspaceProps = {
  companyGuards: CompanyGuard[];
  availablePlatformGuards: GuardProfile[];
  shifts: Shift[];
  complianceRecords: ComplianceRecord[];
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  approvingGuardId: number | null;
  onLinkGuard: (guardId: number) => Promise<void>;
  onUpdateGuardStatus: (companyGuardId: number, status: 'ACTIVE' | 'INACTIVE' | 'BLOCKED') => Promise<void>;
  onOpenPayAdmin: (guardId: number, guardName: string) => void;
  onNavigateToCompliance: () => void;
  onNavigateToAvailability: () => void;
  onNavigateToShiftOffers: () => void;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

function siaExpiryLabel(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const exp = new Date(iso);
    if (isNaN(exp.getTime())) return iso.slice(0, 10);
    const diffDays = Math.ceil((exp.getTime() - Date.now()) / 86400000);
    if (diffDays < 0) return 'Expired';
    if (diffDays <= 30) return `Expires in ${diffDays}d`;
    return fmtDate(iso);
  } catch {
    return iso.slice(0, 10);
  }
}

function siaExpiryTone(iso?: string | null): StatusTone {
  if (!iso) return 'neutral';
  try {
    const exp = new Date(iso);
    if (isNaN(exp.getTime())) return 'neutral';
    const diffDays = Math.ceil((exp.getTime() - Date.now()) / 86400000);
    if (diffDays < 0) return 'danger';
    if (diffDays <= 30) return 'warning';
    return 'neutral';
  } catch {
    return 'neutral';
  }
}

type ComplianceSummary = { label: string; tone: StatusTone };

function getComplianceSummary(guardId: number | undefined, records: ComplianceRecord[]): ComplianceSummary {
  if (!guardId) return { label: 'Unknown', tone: 'neutral' };
  const guardRecords = records.filter(r => r.guard?.id === guardId);
  if (guardRecords.length === 0) return { label: 'Unknown', tone: 'neutral' };
  const statuses = guardRecords.map(r => (r.status || '').toLowerCase());
  if (statuses.some(s => s === 'expired')) return { label: 'Expired', tone: 'danger' };
  if (statuses.some(s => s === 'expiring')) return { label: 'Expiring', tone: 'warning' };
  return { label: 'Valid', tone: 'success' };
}

type WorkStatus = 'on-shift' | 'upcoming' | 'off-duty';

function getWorkStatus(guardId: number | undefined, shifts: Shift[]): WorkStatus {
  if (!guardId) return 'off-duty';
  const now = new Date();
  const guardShifts = shifts.filter(s => (s.guard?.id ?? (s as any).guardId) === guardId);
  if (guardShifts.some(s => s.status === 'in_progress')) return 'on-shift';
  if (guardShifts.some(s => s.status === 'ready' && new Date(s.start) > now)) return 'upcoming';
  return 'off-duty';
}

function workStatusLabel(ws: WorkStatus): string {
  if (ws === 'on-shift') return 'On shift';
  if (ws === 'upcoming') return 'Upcoming';
  return 'Off duty';
}

function workStatusTone(ws: WorkStatus): StatusTone {
  if (ws === 'on-shift') return 'success';
  if (ws === 'upcoming') return 'info';
  return 'neutral';
}

function relationshipTone(status: string): StatusTone {
  const s = (status || '').toUpperCase();
  if (s === 'ACTIVE') return 'success';
  if (s === 'BLOCKED') return 'danger';
  return 'neutral';
}

function relationshipLabel(status: string): string {
  const s = (status || '').toUpperCase();
  if (s === 'ACTIVE') return 'Active';
  if (s === 'INACTIVE') return 'Inactive';
  if (s === 'BLOCKED') return 'Blocked';
  return status;
}

function isNeedsAttention(cg: CompanyGuard, complianceRecords: ComplianceRecord[]): boolean {
  const status = (cg.status || '').toUpperCase();
  if (status === 'BLOCKED' || status === 'INACTIVE') return true;
  const compliance = getComplianceSummary(cg.guard?.id, complianceRecords);
  return compliance.label === 'Expired';
}

function getGuardShiftCounts(guardId: number | undefined, shifts: Shift[]) {
  if (!guardId) return { futureReadyCount: 0, outstandingOfferCount: 0, inProgressCount: 0 };
  const now = new Date();
  const guardShifts = shifts.filter(s => (s.guard?.id ?? (s as any).guardId) === guardId);
  return {
    futureReadyCount: guardShifts.filter(s => s.status === 'ready' && new Date(s.start) > now).length,
    outstandingOfferCount: guardShifts.filter(s => s.status === 'offered').length,
    inProgressCount: guardShifts.filter(s => s.status === 'in_progress').length,
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FILTER_TABS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'needs-attention', label: 'Needs Attention' },
  { key: 'on-shift', label: 'On Shift' },
  { key: 'blocked', label: 'Blocked' },
];

// ─── Component ────────────────────────────────────────────────────────────────

export function CompanyGuardsWorkspace({
  companyGuards,
  availablePlatformGuards,
  shifts,
  complianceRecords,
  loading,
  approvingGuardId,
  onLinkGuard,
  onUpdateGuardStatus,
  onOpenPayAdmin,
  onNavigateToCompliance,
  onNavigateToAvailability,
  onNavigateToShiftOffers,
}: CompanyGuardsWorkspaceProps) {
  const [filter, setFilter] = React.useState<FilterKey>('active');
  const [search, setSearch] = React.useState('');
  const [quickView, setQuickView] = React.useState<CompanyGuard | null>(null);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [linkSearch, setLinkSearch] = React.useState('');
  const [pendingAction, setPendingAction] = React.useState<PendingAction | null>(null);
  const [statusChanging, setStatusChanging] = React.useState(false);

  // Exclude guards already in workforce at any status from the link modal
  const allLinkedGuardIds = React.useMemo(
    () => new Set(companyGuards.map(cg => cg.guard?.id).filter((id): id is number => typeof id === 'number')),
    [companyGuards],
  );

  const trulyAvailableGuards = React.useMemo(
    () => availablePlatformGuards.filter(g => !allLinkedGuardIds.has(g.id)),
    [availablePlatformGuards, allLinkedGuardIds],
  );

  // ── Summary metrics ────────────────────────────────────────────────────────
  const totalCount = companyGuards.length;
  const activeCount = React.useMemo(
    () => companyGuards.filter(cg => (cg.status || '').toUpperCase() === 'ACTIVE').length,
    [companyGuards],
  );
  const onShiftCount = React.useMemo(
    () => companyGuards.filter(cg => getWorkStatus(cg.guard?.id, shifts) === 'on-shift').length,
    [companyGuards, shifts],
  );
  const attentionCount = React.useMemo(
    () => companyGuards.filter(cg => isNeedsAttention(cg, complianceRecords)).length,
    [companyGuards, complianceRecords],
  );

  // ── Filtered rows ─────────────────────────────────────────────────────────
  const filteredGuards = React.useMemo(() => {
    let rows = companyGuards;

    switch (filter) {
      case 'active':
        rows = rows.filter(cg => (cg.status || '').toUpperCase() === 'ACTIVE');
        break;
      case 'needs-attention':
        rows = rows.filter(cg => isNeedsAttention(cg, complianceRecords));
        break;
      case 'on-shift':
        rows = rows.filter(cg => getWorkStatus(cg.guard?.id, shifts) === 'on-shift');
        break;
      case 'blocked':
        rows = rows.filter(cg => (cg.status || '').toUpperCase() === 'BLOCKED');
        break;
      default:
        break;
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(cg => {
        const g = cg.guard;
        if (!g) return false;
        return (
          g.fullName.toLowerCase().includes(q) ||
          (g.phone || '').toLowerCase().includes(q) ||
          (g.siaLicenseNumber || g.siaLicenceNumber || '').toLowerCase().includes(q)
        );
      });
    }

    return rows;
  }, [companyGuards, filter, search, shifts, complianceRecords]);

  // ── Link guard search ─────────────────────────────────────────────────────
  const filteredAvailable = React.useMemo(() => {
    if (!linkSearch.trim()) return trulyAvailableGuards;
    const q = linkSearch.trim().toLowerCase();
    return trulyAvailableGuards.filter(g =>
      g.fullName.toLowerCase().includes(q) ||
      (g.phone || '').toLowerCase().includes(q) ||
      (g.siaLicenseNumber || g.siaLicenceNumber || '').toLowerCase().includes(q),
    );
  }, [trulyAvailableGuards, linkSearch]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleOpenLinkDrawer = () => {
    setLinkSearch('');
    setLinkOpen(true);
  };

  const handleLinkGuard = async (guardId: number) => {
    await onLinkGuard(guardId);
    setLinkOpen(false);
  };

  const requestStatusChange = (type: PendingAction['type'], cg: CompanyGuard) => {
    const guardId = cg.guard?.id;
    const guardName = cg.guard?.fullName ?? 'this guard';
    const counts = getGuardShiftCounts(guardId, shifts);
    setPendingAction({ type, companyGuardId: cg.id, guardName, ...counts });
  };

  const confirmStatusChange = async () => {
    if (!pendingAction) return;
    const nextStatus =
      pendingAction.type === 'block' ? 'BLOCKED' as const
      : pendingAction.type === 'inactive' ? 'INACTIVE' as const
      : 'ACTIVE' as const;
    setStatusChanging(true);
    try {
      await onUpdateGuardStatus(pendingAction.companyGuardId, nextStatus);
      setPendingAction(null);
      setQuickView(null);
    } finally {
      setStatusChanging(false);
    }
  };

  // ── Confirmation copy ─────────────────────────────────────────────────────
  const getConfirmationCopy = (action: PendingAction) => {
    const { type, guardName, futureReadyCount, outstandingOfferCount, inProgressCount } = action;
    const warnings = [
      futureReadyCount > 0 ? `${futureReadyCount} accepted future shift${futureReadyCount !== 1 ? 's' : ''}` : '',
      outstandingOfferCount > 0 ? `${outstandingOfferCount} outstanding offer${outstandingOfferCount !== 1 ? 's' : ''}` : '',
      inProgressCount > 0 ? `${inProgressCount} shift currently in progress` : '',
    ].filter(Boolean);

    if (type === 'block') {
      const shiftNote = warnings.length > 0
        ? `\n\nThis guard currently has:\n${warnings.map(w => `• ${w}`).join('\n')}\n\nThese records will not be cancelled automatically. Review future shifts separately.`
        : '';
      const liveNote = inProgressCount > 0 ? '\n\nThe current shift will continue. Blocking does not book the guard off.' : '';
      return {
        title: `Block ${guardName}?`,
        message: `They will not be able to accept new offers or receive new assignments from your company. Existing accepted or active shifts will not be cancelled automatically.${liveNote}${shiftNote}`,
        confirmLabel: 'Block Guard',
        variant: 'danger' as const,
      };
    }
    if (type === 'inactive') {
      const shiftNote = warnings.length > 0
        ? `\n\nThis guard currently has:\n${warnings.map(w => `• ${w}`).join('\n')}\n\nThese records will not be cancelled automatically.`
        : '';
      return {
        title: `Set ${guardName} Inactive?`,
        message: `The relationship will be marked inactive. They will not receive new work from your company. Existing shifts will not be affected.${shiftNote}`,
        confirmLabel: 'Set Inactive',
        variant: 'standard' as const,
      };
    }
    return {
      title: `Reactivate ${guardName}?`,
      message: `Reactivation restores the company relationship only.\n\nThe guard must still pass compliance, screening and availability checks before new work can be assigned.`,
      confirmLabel: 'Reactivate',
      variant: 'standard' as const,
    };
  };

  // ── Derived quick-view data ────────────────────────────────────────────────
  const qvGuard = quickView?.guard ?? null;
  const qvWorkStatus = getWorkStatus(qvGuard?.id, shifts);
  const qvCompliance = getComplianceSummary(qvGuard?.id, complianceRecords);
  const qvStatus = (quickView?.status || '').toUpperCase();

  const confirmCopy = pendingAction ? getConfirmationCopy(pendingAction) : null;

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading guards workspace…</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>

      {/* ── Summary strip ─────────────────────────────────────────────────── */}
      <View style={styles.summaryStrip}>
        <MetricChip
          label="Total Guards"
          value={totalCount}
          onPress={() => setFilter('all')}
          active={filter === 'all'}
        />
        <MetricChip
          label="Active"
          value={activeCount}
          onPress={() => setFilter('active')}
          active={filter === 'active'}
          tone="success"
        />
        <MetricChip
          label="On Shift"
          value={onShiftCount}
          onPress={() => setFilter('on-shift')}
          active={filter === 'on-shift'}
          tone="info"
        />
        <MetricChip
          label="Needs Attention"
          value={attentionCount}
          onPress={() => setFilter('needs-attention')}
          active={filter === 'needs-attention'}
          tone={attentionCount > 0 ? 'warning' : 'neutral'}
        />
      </View>

      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <View style={styles.toolbar}>
        <View style={styles.toolbarRow}>
          <View style={styles.searchWrapper}>
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder="Search by name, phone or SIA…"
              placeholderTextColor={colors.textSecondary}
              clearButtonMode="while-editing"
            />
          </View>
          <Pressable
            style={styles.linkButton}
            onPress={handleOpenLinkDrawer}
            accessibilityRole="button"
          >
            <Text style={styles.linkButtonText}>+ Link Guard</Text>
          </Pressable>
        </View>
        <View style={styles.filterTabs}>
          {FILTER_TABS.map(tab => (
            <Pressable
              key={tab.key}
              style={[styles.filterTab, filter === tab.key && styles.filterTabActive]}
              onPress={() => setFilter(tab.key)}
              accessibilityRole="button"
            >
              <Text style={[styles.filterTabText, filter === tab.key && styles.filterTabTextActive]}>
                {tab.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* ── Table ─────────────────────────────────────────────────────────── */}
      <View style={styles.tableCard}>
        <View style={styles.tableScroll}>
          <View style={styles.tableInner}>
            <TableHeader>
              <TableHeaderCell label="Guard" flex={2} />
              <TableHeaderCell label="Relationship" flex={1} />
              <TableHeaderCell label="Compliance" flex={1} />
              <TableHeaderCell label="Work Status" flex={1} />
              <TableHeaderCell label="SIA" flex={1} />
              <TableHeaderCell label="" width={48} />
            </TableHeader>

            {filteredGuards.length === 0 ? (
              <TableEmptyState
                message={
                  companyGuards.length === 0
                    ? 'No guards linked to your workforce.'
                    : 'No guards match your search or filter.'
                }
                actionLabel={companyGuards.length === 0 ? 'Link Guard' : undefined}
                onAction={companyGuards.length === 0 ? handleOpenLinkDrawer : undefined}
              />
            ) : (
              filteredGuards.map(cg => {
                const guard = cg.guard;
                if (!guard) return null;
                const ws = getWorkStatus(guard.id, shifts);
                const compliance = getComplianceSummary(guard.id, complianceRecords);
                const siaLabel = siaExpiryLabel(guard.siaExpiryDate);
                const siaTone = siaExpiryTone(guard.siaExpiryDate);
                return (
                  <Fragment key={cg.id}>
                  <TableRow
                    onPress={() => setQuickView(cg)}
                    selected={quickView?.id === cg.id}
                  >
                    <PrimaryCell label={guard.fullName} subtitle={guard.phone} flex={2} />
                    <StatusCell label={relationshipLabel(cg.status)} tone={relationshipTone(cg.status)} flex={1} />
                    <StatusCell label={compliance.label} tone={compliance.tone} flex={1} />
                    <StatusCell label={workStatusLabel(ws)} tone={workStatusTone(ws)} flex={1} />
                    <TableCell flex={1}>
                      {siaLabel !== '—' ? (
                        <StatusBadge label={siaLabel} tone={siaTone} size="small" />
                      ) : (
                        <Text style={styles.metaGrey}>—</Text>
                      )}
                    </TableCell>
                    <ActionCell width={48}>
                      <Text style={styles.chevron}>›</Text>
                    </ActionCell>
                  </TableRow>
                  </Fragment>
                );
              })
            )}
          </View>
        </View>
      </View>

      {/* ── Quick View Drawer ──────────────────────────────────────────────── */}
      <Drawer
        visible={quickView !== null}
        onClose={() => setQuickView(null)}
        title={qvGuard?.fullName ?? 'Guard'}
        subtitle={quickView ? `${relationshipLabel(quickView.status)} · ${workStatusLabel(qvWorkStatus)}` : undefined}
        compact
        footer={
          <Button label="Close" variant="secondary" onPress={() => setQuickView(null)} />
        }
      >
        {quickView && qvGuard ? (
          <View style={styles.drawerBody}>

            <DrawerSection title="Guard">
              <DrawerRow label="Name" value={qvGuard.fullName} />
              <DrawerRow label="Phone" value={qvGuard.phone || '—'} />
            </DrawerSection>

            <DrawerSection title="Workforce">
              <View style={styles.drawerRow}>
                <Text style={styles.drawerRowLabel}>Relationship</Text>
                <StatusBadge label={relationshipLabel(quickView.status)} tone={relationshipTone(quickView.status)} size="small" />
              </View>
              <View style={styles.drawerRow}>
                <Text style={styles.drawerRowLabel}>Work Status</Text>
                <StatusBadge label={workStatusLabel(qvWorkStatus)} tone={workStatusTone(qvWorkStatus)} size="small" />
              </View>
              <DrawerRow label="Linked Since" value={fmtDate(quickView.createdAt)} />
            </DrawerSection>

            <DrawerSection title="Compliance">
              <View style={styles.drawerRow}>
                <Text style={styles.drawerRowLabel}>Status</Text>
                <StatusBadge label={qvCompliance.label} tone={qvCompliance.tone} size="small" />
              </View>
              <DrawerRow label="SIA Expiry" value={siaExpiryLabel(qvGuard.siaExpiryDate)} />
              {qvGuard.rightToWorkStatus ? (
                <DrawerRow label="Right to Work" value={qvGuard.rightToWorkStatus} />
              ) : null}
              {qvCompliance.label === 'Unknown' ? (
                <Text style={styles.drawerHint}>
                  Full compliance data not yet loaded. Use View Compliance for detail.
                </Text>
              ) : null}
            </DrawerSection>

            <DrawerSection title="Actions">
              <View style={styles.actionButtons}>
                {qvStatus === 'ACTIVE' ? (
                  <>
                    <Button
                      label="Block Guard"
                      variant="danger"
                      onPress={() => requestStatusChange('block', quickView)}
                    />
                    <Button
                      label="Set Inactive"
                      variant="secondary"
                      onPress={() => requestStatusChange('inactive', quickView)}
                    />
                  </>
                ) : (
                  <Button
                    label="Reactivate"
                    variant="primary"
                    onPress={() => requestStatusChange('reactivate', quickView)}
                  />
                )}
                <Button
                  label="Pay Admin"
                  variant="secondary"
                  onPress={() => {
                    onOpenPayAdmin(qvGuard.id, qvGuard.fullName);
                    setQuickView(null);
                  }}
                />
              </View>
              <View style={[styles.actionButtons, styles.actionButtonsSecondary]}>
                <Button label="View Compliance" variant="tertiary" onPress={onNavigateToCompliance} />
                <Button label="View Availability" variant="tertiary" onPress={onNavigateToAvailability} />
              </View>
              {qvStatus === 'BLOCKED' ? (
                <View style={styles.drawerWarning}>
                  <Text style={styles.drawerWarningText}>
                    This guard is blocked. Outstanding shift offers will not be cancelled automatically. Review separately.
                  </Text>
                  <Pressable
                    onPress={() => { setQuickView(null); onNavigateToShiftOffers(); }}
                    accessibilityRole="button"
                  >
                    <Text style={styles.drawerWarningLink}>Review Shift Offers</Text>
                  </Pressable>
                </View>
              ) : null}
            </DrawerSection>

          </View>
        ) : null}
      </Drawer>

      {/* ── Link Guard Drawer ──────────────────────────────────────────────── */}
      <Drawer
        visible={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="Link Guard"
        subtitle="Add an existing approved guard to your workforce."
        compact
      >
        <View style={styles.linkDrawerBody}>
          <TextInput
            style={styles.searchInput}
            value={linkSearch}
            onChangeText={setLinkSearch}
            placeholder="Search by name, phone or SIA…"
            placeholderTextColor={colors.textSecondary}
          />
          {filteredAvailable.length === 0 ? (
            <View style={styles.linkEmptyState}>
              <Text style={styles.linkEmptyText}>
                {trulyAvailableGuards.length === 0
                  ? 'All approved platform guards are already in your workforce.'
                  : 'No guards match your search.'}
              </Text>
            </View>
          ) : (
            filteredAvailable.map(guard => (
              <View key={guard.id} style={styles.linkRow}>
                <View style={styles.linkRowInfo}>
                  <Text style={styles.linkRowName}>{guard.fullName}</Text>
                  <Text style={styles.linkRowMeta}>
                    {guard.phone}
                    {guard.siaLicenseNumber || guard.siaLicenceNumber
                      ? ` · ${guard.siaLicenseNumber || guard.siaLicenceNumber}`
                      : ''}
                  </Text>
                </View>
                <Button
                  label={approvingGuardId === guard.id ? 'Linking…' : 'Link Guard'}
                  variant="primary"
                  onPress={() => handleLinkGuard(guard.id)}
                  disabled={approvingGuardId !== null}
                />
              </View>
            ))
          )}
        </View>
      </Drawer>

      {/* ── Confirmation dialogs ───────────────────────────────────────────── */}
      {pendingAction && confirmCopy ? (
        <ConfirmationDialog
          visible
          onClose={() => setPendingAction(null)}
          onConfirm={confirmStatusChange}
          title={confirmCopy.title}
          message={confirmCopy.message}
          confirmLabel={confirmCopy.confirmLabel}
          variant={confirmCopy.variant}
          loading={statusChanging}
        />
      ) : null}

    </View>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

type MetricChipProps = {
  label: string;
  value: number;
  onPress: () => void;
  active?: boolean;
  tone?: 'success' | 'warning' | 'info' | 'neutral';
};

function MetricChip({ label, value, onPress, active, tone }: MetricChipProps) {
  const valueColor = tone === 'success' ? colors.success
    : tone === 'warning' ? colors.warning
    : tone === 'info' ? colors.info
    : colors.primaryNavy;
  return (
    <Pressable
      style={[styles.metricChip, active && styles.metricChipActive]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={[styles.metricValue, { color: active ? colors.accentTeal : valueColor }]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </Pressable>
  );
}

function DrawerSection({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return (
    <View style={styles.drawerSection}>
      <Text style={styles.drawerSectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function DrawerRow({ label, value }: { label: string; value?: string }) {
  return (
    <View style={styles.drawerRow}>
      <Text style={styles.drawerRowLabel}>{label}</Text>
      <Text style={styles.drawerRowValue}>{value ?? '—'}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    gap: spacing.lg,
  },

  // Loading
  loadingContainer: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  loadingText: {
    ...typography.body,
    color: colors.textSecondary,
  },

  // Summary strip
  summaryStrip: {
    flexDirection: 'row',
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  metricChip: {
    flex: 1,
    minWidth: 110,
    backgroundColor: colors.card,
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
    ...(IS_WEB ? { cursor: 'pointer' } as any : {}),
  },
  metricChipActive: {
    borderColor: colors.accentTeal,
    backgroundColor: colors.accentTealSoft,
  },
  metricValue: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.primaryNavy,
    letterSpacing: -0.5,
  },
  metricLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },

  // Toolbar
  toolbar: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  toolbarRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  searchWrapper: {
    flex: 1,
  },
  searchInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceSubtle,
    ...(IS_WEB ? { outlineStyle: 'none' } as any : {}),
  },
  filterTabs: {
    flexDirection: 'row',
    gap: spacing.xs,
    flexWrap: 'wrap',
  },
  filterTab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    ...(IS_WEB ? { cursor: 'pointer' } as any : {}),
  },
  filterTabActive: {
    backgroundColor: colors.primaryNavy,
    borderColor: colors.primaryNavy,
  },
  filterTabText: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  filterTabTextActive: {
    color: '#FFFFFF',
  },
  linkButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderRadius: radii.sm,
    backgroundColor: colors.accentTeal,
    flexShrink: 0,
    ...(IS_WEB ? { cursor: 'pointer' } as any : {}),
  },
  linkButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },

  // Table
  tableCard: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  tableScroll: {
    overflow: 'hidden',
  },
  tableInner: {
    minWidth: 680,
  },
  chevron: {
    fontSize: 18,
    color: colors.textSecondary,
    fontWeight: '700',
    textAlign: 'center',
  },
  metaGrey: {
    fontSize: 13,
    color: colors.textSecondary,
  },

  // Quick view drawer
  drawerBody: {
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  drawerSection: {
    gap: 2,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: spacing.xs,
  },
  drawerSectionTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  drawerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    gap: spacing.md,
  },
  drawerRowLabel: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  drawerRowValue: {
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: '500',
    textAlign: 'right',
    flexShrink: 1,
  },
  drawerHint: {
    fontSize: 12,
    color: colors.textSecondary,
    fontStyle: 'italic',
    marginTop: 4,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexWrap: 'wrap',
    marginTop: spacing.sm,
  },
  actionButtonsSecondary: {
    marginTop: spacing.xs,
  },
  drawerWarning: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    backgroundColor: colors.warningSurface,
    borderRadius: radii.sm,
    gap: 4,
  },
  drawerWarningText: {
    fontSize: 13,
    color: colors.warning,
    lineHeight: 18,
  },
  drawerWarningLink: {
    fontSize: 13,
    color: colors.accentTeal,
    fontWeight: '600',
    textDecorationLine: 'underline',
    ...(IS_WEB ? { cursor: 'pointer' } as any : {}),
  },

  // Link guard drawer
  linkDrawerBody: {
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  linkEmptyState: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
  },
  linkEmptyText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  linkRowInfo: {
    flex: 1,
    gap: 2,
  },
  linkRowName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  linkRowMeta: {
    fontSize: 12,
    color: colors.textSecondary,
  },
});
