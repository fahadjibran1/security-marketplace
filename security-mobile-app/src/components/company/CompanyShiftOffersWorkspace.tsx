import * as React from 'react';
import { Fragment } from 'react/jsx-runtime';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Shift } from '../../types/models';
import { colors, control, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { StatusBadge, type StatusTone } from '../StatusBadge';
import {
  ActionCell,
  MetaCell,
  PrimaryCell,
  TableCell,
  TableEmptyState,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '../ui/TableFoundation';

const IS_WEB = typeof document !== 'undefined';

// ─── Types ────────────────────────────────────────────────────────────────────

type OfferStatus = 'awaiting' | 'accepted' | 'rejected' | 'missed';
type FilterTab = 'awaiting' | 'accepted' | 'rejected' | 'all';

export type ShiftOffersFeedback = { tone: 'success' | 'error'; message: string };

type Props = {
  shifts: Shift[];
  refreshing: boolean;
  onRefresh: () => void;
  feedback: ShiftOffersFeedback | null;
  onWithdrawOffer: (shiftId: number) => Promise<void>;
  onNavigateToRota: (siteId: string, weekCommencing: string) => void;
  onNavigateToLiveOps: (shiftId: number) => void;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch {
    return iso.slice(0, 10);
  }
}

function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const lit = iso.match(/[T\s](\d{2}):(\d{2})/);
  if (lit) return `${lit[1]}:${lit[2]}`;
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  } catch {
    return '—';
  }
}

function isOvernightShift(start?: string | null, end?: string | null): boolean {
  if (!start || !end) return false;
  const startDate = start.slice(0, 10);
  const endDate = end.slice(0, 10);
  return endDate > startDate;
}

function fmtShiftWindow(start?: string | null, end?: string | null): string {
  const s = fmtTime(start);
  const e = fmtTime(end);
  if (isOvernightShift(start, end)) return `${s}–${e} (+1)`;
  return `${s}–${e}`;
}

function startUrgency(start?: string | null): string | null {
  if (!start) return null;
  try {
    const now = Date.now();
    const startMs = new Date(start).getTime();
    if (isNaN(startMs)) return null;
    const diffMin = Math.round((startMs - now) / 60_000);
    if (diffMin < 0) return null;
    if (diffMin < 60) return `Starts in ${diffMin}m`;
    if (diffMin < 60 * 24) return 'Starts today';
    if (diffMin < 60 * 48) return 'Tomorrow';
    return null;
  } catch {
    return null;
  }
}

function weekCommencingFor(isoDate?: string | null): string {
  try {
    const d = isoDate ? new Date(isoDate) : new Date();
    if (isNaN(d.getTime())) return (isoDate || '').slice(0, 10);
    const day = d.getDay();
    const offset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setDate(d.getDate() + offset);
    return monday.toISOString().slice(0, 10);
  } catch {
    return (isoDate || '').slice(0, 10);
  }
}

function normalizeOfferStatus(status?: string | null): OfferStatus | 'other' {
  const s = (status || '').toLowerCase().trim();
  if (s === 'offered' || s === 'assigned') return 'awaiting';
  if (s === 'ready' || s === 'accepted') return 'accepted';
  if (s === 'rejected') return 'rejected';
  if (s === 'missed') return 'missed';
  return 'other';
}

function getStatusBadgeProps(normalized: OfferStatus | 'other'): { label: string; tone: StatusTone } {
  switch (normalized) {
    case 'awaiting':  return { label: 'Awaiting',  tone: 'info' };
    case 'accepted':  return { label: 'Accepted',  tone: 'success' };
    case 'rejected':  return { label: 'Rejected',  tone: 'danger' };
    case 'missed':    return { label: 'Missed',    tone: 'warning' };
    default:          return { label: 'Unknown',   tone: 'neutral' };
  }
}

function isOfferRelevant(status?: string | null): boolean {
  const s = normalizeOfferStatus(status);
  return s === 'awaiting' || s === 'accepted' || s === 'rejected' || s === 'missed';
}

function getSiteName(shift: Shift): string {
  return shift.site?.name || shift.siteName || '—';
}

function getGuardName(shift: Shift): string {
  return shift.guard?.fullName || '—';
}

function getSiteId(shift: Shift): string {
  return String(shift.site?.id ?? shift.siteId ?? '');
}

// ─── Column layout ────────────────────────────────────────────────────────────

const COL_SHIFT_W   = 156;
const COL_STATUS_W  = 100;
const COL_URGENCY_W = 110;
const COL_ACTION_W  = 52;

const TABLE_BODY_MAX_HEIGHT: number | string = IS_WEB
  ? ('calc(100vh - 358px)' as any)
  : 440;

// ─── SummaryPill ─────────────────────────────────────────────────────────────

function SummaryPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: StatusTone | null;
}) {
  const { bg, fg } = tone
    ? { bg: TONE_BG[tone], fg: TONE_FG[tone] }
    : { bg: colors.surfaceSubtle, fg: colors.textSecondary };
  return (
    <View style={[styles.summaryPill, { backgroundColor: bg }]}>
      <Text style={[styles.summaryValue, { color: fg }]}>{value}</Text>
      <Text style={[styles.summaryLabel, { color: fg }]}>{label}</Text>
    </View>
  );
}

const TONE_BG: Partial<Record<StatusTone, string>> = {
  info:    colors.infoSurface,
  success: colors.successSurface,
  danger:  colors.dangerSurface,
  warning: colors.warningSurface,
};
const TONE_FG: Partial<Record<StatusTone, string>> = {
  info:    colors.info,
  success: colors.success,
  danger:  colors.danger,
  warning: colors.warning,
};

// ─── FilterChip ──────────────────────────────────────────────────────────────

function FilterChip({
  label,
  active,
  onPress,
}: {
  key?: string | number;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Text
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.filterChip, active ? styles.filterChipActive : styles.filterChipInactive]}
    >
      {label}
    </Text>
  );
}

// ─── DrawerRow ────────────────────────────────────────────────────────────────

function DrawerRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View style={styles.drawerRow}>
      <Text style={styles.drawerRowLabel}>{label}</Text>
      <Text style={styles.drawerRowValue}>{value}</Text>
    </View>
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

// ─── UrgencyChip ─────────────────────────────────────────────────────────────

function UrgencyChip({ start }: { start?: string | null }) {
  const label = startUrgency(start);
  if (!label) return null;
  const isImmediate = label.startsWith('Starts in');
  return (
    <View style={[styles.urgencyChip, isImmediate ? styles.urgencyImmediate : styles.urgencyNormal]}>
      <Text style={[styles.urgencyText, isImmediate ? styles.urgencyTextImmediate : styles.urgencyTextNormal]}>
        {label}
      </Text>
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CompanyShiftOffersWorkspace({
  shifts,
  refreshing,
  onRefresh,
  feedback,
  onWithdrawOffer,
  onNavigateToRota,
  onNavigateToLiveOps,
}: Props) {
  const [search, setSearch]         = React.useState('');
  const [filter, setFilter]         = React.useState<FilterTab>('awaiting');
  const [drawerOffer, setDrawerOffer] = React.useState<Shift | null>(null);
  const [withdrawTarget, setWithdrawTarget] = React.useState<Shift | null>(null);
  const [withdrawing, setWithdrawing] = React.useState(false);

  // ─── Derived ────────────────────────────────────────────────────────────

  const offerRows = React.useMemo(
    () =>
      shifts
        .filter((s) => isOfferRelevant(s.status))
        .sort((a, b) => a.start.localeCompare(b.start)),
    [shifts],
  );

  const awaitingCount    = React.useMemo(() => offerRows.filter((s) => normalizeOfferStatus(s.status) === 'awaiting').length,  [offerRows]);
  const acceptedCount    = React.useMemo(() => offerRows.filter((s) => normalizeOfferStatus(s.status) === 'accepted').length,  [offerRows]);
  const rejectedCount    = React.useMemo(() => offerRows.filter((s) => normalizeOfferStatus(s.status) === 'rejected').length,  [offerRows]);
  const needsCoverCount  = React.useMemo(() => offerRows.filter((s) => { const ns = normalizeOfferStatus(s.status); return ns === 'rejected' || ns === 'missed'; }).length, [offerRows]);

  const filteredRows = React.useMemo(() => {
    let rows = offerRows;
    if (filter !== 'all') {
      rows = rows.filter((s) => {
        const ns = normalizeOfferStatus(s.status);
        if (filter === 'awaiting')  return ns === 'awaiting';
        if (filter === 'accepted')  return ns === 'accepted';
        if (filter === 'rejected')  return ns === 'rejected' || ns === 'missed';
        return true;
      });
    }
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (s) =>
          getSiteName(s).toLowerCase().includes(q) ||
          getGuardName(s).toLowerCase().includes(q),
      );
    }
    return rows;
  }, [offerRows, filter, search]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handleViewOffer = React.useCallback((shift: Shift) => {
    setDrawerOffer(shift);
  }, []);

  const handleRequestWithdraw = React.useCallback((shift: Shift) => {
    setWithdrawTarget(shift);
  }, []);

  const handleConfirmWithdraw = React.useCallback(async () => {
    if (!withdrawTarget) return;
    try {
      setWithdrawing(true);
      await onWithdrawOffer(withdrawTarget.id);
      setWithdrawTarget(null);
      setDrawerOffer(null);
    } finally {
      setWithdrawing(false);
    }
  }, [withdrawTarget, onWithdrawOffer]);

  const handleNavigateToRota = React.useCallback(
    (shift: Shift) => {
      const siteId = getSiteId(shift);
      if (!siteId) return;
      onNavigateToRota(siteId, weekCommencingFor(shift.start));
      setDrawerOffer(null);
    },
    [onNavigateToRota],
  );

  const handleNavigateToLiveOps = React.useCallback(
    (shift: Shift) => {
      onNavigateToLiveOps(shift.id);
      setDrawerOffer(null);
    },
    [onNavigateToLiveOps],
  );

  // ─── Drawer ───────────────────────────────────────────────────────────────

  const renderDrawer = () => {
    const shift = drawerOffer;
    if (!shift) return null;
    const ns       = normalizeOfferStatus(shift.status);
    const badge    = getStatusBadgeProps(ns);
    const siteName = getSiteName(shift);
    const hasSiteId = Boolean(getSiteId(shift));
    const hasRotaSlot = shift.rotaSlotId != null;
    const canViewInRota = hasSiteId;
    const showWithdraw = ns === 'awaiting';

    const drawerFooter = (
      <View style={styles.drawerFooter}>
        <Button
          label="Close"
          variant="secondary"
          size="md"
          onPress={() => setDrawerOffer(null)}
        />
        {canViewInRota ? (
          <Button
            label={ns === 'rejected' || ns === 'missed' ? 'View in Rota / Plan Cover' : 'View in Rota'}
            variant="secondary"
            size="md"
            onPress={() => handleNavigateToRota(shift)}
          />
        ) : null}
        {ns === 'accepted' ? (
          <Button
            label="Open in Live Operations"
            variant="secondary"
            size="md"
            onPress={() => handleNavigateToLiveOps(shift)}
          />
        ) : null}
        {showWithdraw ? (
          <Button
            label="Withdraw Offer"
            variant="danger"
            size="md"
            onPress={() => handleRequestWithdraw(shift)}
          />
        ) : null}
      </View>
    );

    return (
      <Drawer
        visible
        onClose={() => setDrawerOffer(null)}
        title="Shift Offer"
        subtitle={siteName}
        compact
        width={460}
        footer={drawerFooter}
      >
        <DrawerSection title="Offer">
          <View style={styles.drawerBadgeRow}>
            <StatusBadge label={badge.label} tone={badge.tone} size="small" />
          </View>
          <DrawerRow label="Guard" value={getGuardName(shift)} />
        </DrawerSection>

        <DrawerSection title="Shift">
          <DrawerRow label="Site" value={siteName} />
          <DrawerRow label="Date" value={fmtDate(shift.start)} />
          <DrawerRow label="Start" value={fmtTime(shift.start)} />
          <DrawerRow
            label="End"
            value={isOvernightShift(shift.start, shift.end) ? `${fmtTime(shift.end)} (+1 day)` : fmtTime(shift.end)}
          />
        </DrawerSection>

        {shift.instructions ? (
          <DrawerSection title="Instructions">
            <Text style={styles.drawerInstructions}>{shift.instructions}</Text>
          </DrawerSection>
        ) : null}

        {hasRotaSlot ? (
          <DrawerSection title="Rota Context">
            <Text style={styles.drawerMeta}>
              This shift is linked to a Rota slot. Use "View in Rota" to see coverage and planning context.
            </Text>
          </DrawerSection>
        ) : (
          <DrawerSection title="Rota Context">
            <Text style={styles.drawerMeta}>
              Legacy offer — not linked to a Rota slot. Navigate to the Rota Planner for this site to plan cover.
            </Text>
          </DrawerSection>
        )}

        {ns === 'awaiting' ? (
          <DrawerSection title="Status">
            <Text style={styles.drawerMeta}>Waiting for the guard to accept or decline this offer.</Text>
          </DrawerSection>
        ) : null}

        {ns === 'rejected' ? (
          <DrawerSection title="Action Required">
            <Text style={[styles.drawerMeta, styles.drawerMetaDanger]}>
              This offer was declined. Cover needs to be planned for this position.
            </Text>
          </DrawerSection>
        ) : null}

        {ns === 'missed' ? (
          <DrawerSection title="Action Required">
            <Text style={[styles.drawerMeta, styles.drawerMetaWarning]}>
              Guard did not check in within the required window. Follow up and plan re-cover.
            </Text>
          </DrawerSection>
        ) : null}
      </Drawer>
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const emptyMessage: Record<FilterTab, string> = {
    awaiting: 'No guard responses are currently outstanding.',
    accepted: 'No accepted offers.',
    rejected: 'No rejected offers or missed shifts.',
    all:      'No offers match your search.',
  };

  return (
    <View style={styles.root}>

      {/* Feedback banner */}
      {feedback ? (
        <View style={[styles.feedbackBanner, feedback.tone === 'error' ? styles.feedbackError : styles.feedbackSuccess]}>
          <Text style={[styles.feedbackText, feedback.tone === 'error' ? styles.feedbackTextError : styles.feedbackTextSuccess]}>
            {feedback.message}
          </Text>
        </View>
      ) : null}

      {/* Summary strip */}
      <View style={styles.summaryStrip}>
        <SummaryPill label="Awaiting"    value={awaitingCount}   tone={awaitingCount   > 0 ? 'info'    : null} />
        <SummaryPill label="Accepted"    value={acceptedCount}   tone={acceptedCount   > 0 ? 'success' : null} />
        <SummaryPill label="Rejected"    value={rejectedCount}   tone={rejectedCount   > 0 ? 'danger'  : null} />
        <SummaryPill label="Needs Cover" value={needsCoverCount} tone={needsCoverCount > 0 ? 'warning' : null} />
      </View>

      {/* Toolbar: search + filters + refresh */}
      <View style={styles.toolbar}>
        <View style={styles.toolbarLeft}>
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search site or guard…"
            placeholderTextColor={colors.fieldPlaceholder}
            clearButtonMode="while-editing"
          />
        </View>
        <View style={styles.filterRow}>
          {(['awaiting', 'accepted', 'rejected', 'all'] as FilterTab[]).map((tab) => (
            <FilterChip
              key={tab}
              label={tab === 'all' ? 'All' : tab === 'awaiting' ? 'Awaiting' : tab === 'accepted' ? 'Accepted' : 'Rejected'}
              active={filter === tab}
              onPress={() => setFilter(tab)}
            />
          ))}
        </View>
        <Text
          accessibilityRole="button"
          onPress={onRefresh}
          style={styles.refreshLink}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Text>
      </View>

      {/* Table */}
      <View style={styles.tableCard}>

        <TableHeader>
          <TableHeaderCell label="Site"      flex={2} />
          <TableHeaderCell label="Shift"     width={COL_SHIFT_W} />
          <TableHeaderCell label="Guard"     flex={1.5} />
          <TableHeaderCell label="Status"    width={COL_STATUS_W} />
          <TableHeaderCell label=""          width={COL_URGENCY_W} />
          <TableHeaderCell label=""          width={COL_ACTION_W} />
        </TableHeader>

        <ScrollView style={{ maxHeight: TABLE_BODY_MAX_HEIGHT }} showsVerticalScrollIndicator={false}>
          {filteredRows.length === 0 ? (
            <TableEmptyState
              message={search.trim() ? 'No offers match your search.' : emptyMessage[filter]}
            />
          ) : (
            filteredRows.map((shift) => {
              const ns    = normalizeOfferStatus(shift.status);
              const badge = getStatusBadgeProps(ns);
              return (
                <Fragment key={shift.id}>
                <TableRow
                  onPress={() => handleViewOffer(shift)}
                >
                  {/* Site */}
                  <PrimaryCell
                    label={getSiteName(shift)}
                    flex={2}
                  />

                  {/* Shift date + time */}
                  <TableCell width={COL_SHIFT_W}>
                    <Text style={styles.shiftDate} numberOfLines={1}>{fmtDate(shift.start)}</Text>
                    <Text style={styles.shiftTime} numberOfLines={1}>{fmtShiftWindow(shift.start, shift.end)}</Text>
                  </TableCell>

                  {/* Guard */}
                  <MetaCell value={getGuardName(shift)} flex={1.5} />

                  {/* Status */}
                  <TableCell width={COL_STATUS_W}>
                    <StatusBadge label={badge.label} tone={badge.tone} size="small" />
                  </TableCell>

                  {/* Urgency */}
                  <TableCell width={COL_URGENCY_W}>
                    <UrgencyChip start={shift.start} />
                  </TableCell>

                  {/* Action */}
                  <ActionCell width={COL_ACTION_W}>
                    <Text style={styles.viewChevron} accessibilityLabel="View offer">›</Text>
                  </ActionCell>
                </TableRow>
                </Fragment>
              );
            })
          )}
        </ScrollView>
      </View>

      {/* Offer detail drawer */}
      {renderDrawer()}

      {/* Withdraw confirmation */}
      <ConfirmationDialog
        visible={withdrawTarget !== null}
        onClose={() => setWithdrawTarget(null)}
        onConfirm={handleConfirmWithdraw}
        title="Withdraw this offer?"
        message={
          withdrawTarget
            ? `The guard will no longer be able to accept this offer for ${getSiteName(withdrawTarget)} on ${fmtDate(withdrawTarget.start)}. The position will be cancelled and cover may need to be planned again.`
            : 'The guard will no longer be able to accept this offer. The position will be cancelled and cover may need to be planned again.'
        }
        confirmLabel="Withdraw Offer"
        cancelLabel="Keep Offer"
        variant="danger"
        loading={withdrawing}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: spacing.md,
  },

  // ── Feedback banner ────────────────────────────────────────────────────────
  feedbackBanner: {
    borderRadius: radii.card,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderLeftWidth: 4,
  },
  feedbackSuccess: {
    backgroundColor: colors.successSurface,
    borderLeftColor: colors.success,
  },
  feedbackError: {
    backgroundColor: colors.dangerSurface,
    borderLeftColor: colors.danger,
  },
  feedbackText: {
    ...typography.caption,
  },
  feedbackTextSuccess: {
    color: colors.success,
  },
  feedbackTextError: {
    color: colors.danger,
  },

  // ── Summary strip ──────────────────────────────────────────────────────────
  summaryStrip: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexWrap: IS_WEB ? ('nowrap' as any) : 'wrap',
  },
  summaryPill: {
    flex: 1,
    minWidth: 96,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.card,
  },
  summaryValue: {
    ...typography.panelHeading,
    fontSize: 20,
    lineHeight: 24,
  },
  summaryLabel: {
    ...typography.caption,
    fontWeight: '500',
  },

  // ── Toolbar ────────────────────────────────────────────────────────────────
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flexWrap: IS_WEB ? ('nowrap' as any) : 'wrap',
  },
  toolbarLeft: {
    flex: 1,
    minWidth: 180,
  },
  searchInput: {
    height: control.buttonHeightSm,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
    color: colors.textPrimary,
    ...typography.caption,
  },
  filterRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  filterChip: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    ...typography.caption,
    fontWeight: '500',
    overflow: IS_WEB ? ('hidden' as any) : 'visible',
  },
  filterChipActive: {
    backgroundColor: colors.primaryNavy,
    color: colors.textOnBrand,
  },
  filterChipInactive: {
    backgroundColor: colors.surfaceSubtle,
    color: colors.textSecondary,
  },
  refreshLink: {
    ...typography.caption,
    color: colors.accentTeal,
    fontWeight: '600',
    paddingVertical: 6,
    paddingHorizontal: spacing.xs,
  },

  // ── Table ──────────────────────────────────────────────────────────────────
  tableCard: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  shiftDate: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  shiftTime: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 1,
  },
  viewChevron: {
    fontSize: 20,
    color: colors.textMuted,
    lineHeight: 24,
    textAlign: 'center',
  },

  // ── Urgency chip ───────────────────────────────────────────────────────────
  urgencyChip: {
    borderRadius: radii.pill,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    alignSelf: 'flex-start',
  },
  urgencyImmediate: {
    backgroundColor: colors.warningSurface,
  },
  urgencyNormal: {
    backgroundColor: colors.infoSurface,
  },
  urgencyText: {
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 15,
  },
  urgencyTextImmediate: {
    color: colors.warning,
  },
  urgencyTextNormal: {
    color: colors.info,
  },

  // ── Drawer ─────────────────────────────────────────────────────────────────
  drawerSection: {
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceSubtle,
  },
  drawerSectionTitle: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
  },
  drawerBadgeRow: {
    marginBottom: spacing.sm,
  },
  drawerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 4,
  },
  drawerRowLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    flex: 1,
  },
  drawerRowValue: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '500',
    flex: 2,
    textAlign: 'right',
  },
  drawerInstructions: {
    ...typography.caption,
    color: colors.textPrimary,
    lineHeight: 20,
  },
  drawerMeta: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  drawerMetaDanger: {
    color: colors.danger,
  },
  drawerMetaWarning: {
    color: colors.warning,
  },
  drawerFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'flex-end',
  },
});
