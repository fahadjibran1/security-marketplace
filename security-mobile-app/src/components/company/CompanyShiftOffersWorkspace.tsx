import * as React from 'react';
import { Fragment } from 'react/jsx-runtime';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Shift } from '../../types/models';
import {
  formatOfferDate,
  formatOfferWindow,
  shiftZone,
  weekCommencingForOffer,
} from '../shifts/shiftOfferTime';
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
  /** Replace Guard: the company's active Guards to choose from. Without both of these the action is not shown. */
  replacementGuards?: Array<{ id: number; name: string }>;
  /**
   * Rejects with the server's refusal (its message says why, `code` names it); the drawer shows it and stays open.
   * A fatigue acknowledgement refusal lets the user confirm and send again.
   */
  onReplaceGuard?: (shiftId: number, input: ReplaceGuardInput) => Promise<void>;
};

export type ReplaceGuardReasonCategory = 'operational_change' | 'cover_rearranged' | 'schedule_change';
export type ReplaceGuardInput = {
  replacementGuardId: number;
  reasonCategory: ReplaceGuardReasonCategory;
  reason: string;
  noShow?: boolean;
  fatigueAcknowledged?: boolean;
};

/** The neutral reasons the outgoing Guard may be shown (the server holds the same fixed set). */
const REASON_CATEGORIES: Array<{ key: ReplaceGuardReasonCategory; label: string }> = [
  { key: 'operational_change', label: 'Operational change' },
  { key: 'cover_rearranged', label: 'Cover rearranged' },
  { key: 'schedule_change', label: 'Schedule change' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Offer times are the SITE's wall clock: it is the site a guard has to be at, and the company is
// planning cover for it. The arithmetic lives in shiftOfferTime, shared with the Guard surface and
// executed by scripts/shift-offer-time.spec.cjs.

const fmtDate = formatOfferDate;

const fmtShiftWindow = formatOfferWindow;

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

function isShiftInFuture(end?: string | null): boolean {
  if (!end) return false;
  try {
    return new Date(end).getTime() > Date.now();
  } catch {
    return false;
  }
}

const weekCommencingFor = weekCommencingForOffer;

/**
 * Replace Guard is offered for an offer or an accepted shift that has not ended; an accepted shift that has started is
 * replaced only as a no-show, which the user confirms explicitly (the server decides; this only hides a button that
 * would be refused).
 */
function canReplaceGuard(shift: Shift, normalized: OfferStatus | 'other'): boolean {
  if (!shift.guard?.id) return false;
  return (normalized === 'awaiting' || normalized === 'accepted') && isShiftInFuture(shift.end);
}

function isAcceptedAndStarted(shift: Shift, normalized: OfferStatus | 'other'): boolean {
  return normalized === 'accepted' && !isShiftInFuture(shift.start) && isShiftInFuture(shift.end);
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

// ─── SummaryStat ─────────────────────────────────────────────────────────────

const HIGHLIGHT_SURFACE: Partial<Record<'danger' | 'info' | 'warning' | 'success', string>> = {
  info:    colors.infoSurface,
  success: colors.successSurface,
  danger:  colors.dangerSurface,
  warning: colors.warningSurface,
};

function SummaryStat({
  value,
  label,
  highlight,
  isActive,
  onPress,
}: {
  value: number;
  label: string;
  highlight?: 'danger' | 'info' | 'warning' | 'success';
  isActive?: boolean;
  onPress?: () => void;
}) {
  const numColor =
    highlight === 'danger'  ? colors.danger  :
    highlight === 'warning' ? colors.warning :
    highlight === 'info'    ? colors.info    :
    highlight === 'success' ? colors.success :
    colors.textPrimary;
  const activeBg = highlight ? (HIGHLIGHT_SURFACE[highlight] ?? undefined) : undefined;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Filter by ${label}`}
      style={({ pressed }: { pressed: boolean }) => [
        styles.summaryStat,
        isActive && activeBg ? { backgroundColor: activeBg } : null,
        pressed ? styles.summaryStatPressed : null,
      ]}
    >
      <Text style={[styles.summaryValue, { color: numColor }]}>{value}</Text>
      <Text style={[styles.summaryLabel, isActive ? { color: numColor } : null]}>{label}</Text>
    </Pressable>
  );
}

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
  replacementGuards,
  onReplaceGuard,
}: Props) {
  const [search, setSearch]         = React.useState('');
  const [filter, setFilter]         = React.useState<FilterTab>('awaiting');
  const [drawerOffer, setDrawerOffer] = React.useState<Shift | null>(null);
  const [withdrawTarget, setWithdrawTarget] = React.useState<Shift | null>(null);
  const [withdrawing, setWithdrawing] = React.useState(false);
  const [replaceMode, setReplaceMode] = React.useState(false);
  const [replacementId, setReplacementId] = React.useState<number | null>(null);
  const [replaceReason, setReplaceReason] = React.useState('');
  const [replaceCategory, setReplaceCategory] = React.useState<ReplaceGuardReasonCategory | null>(null);
  const [noShowConfirmed, setNoShowConfirmed] = React.useState(false);
  const [needsFatigueAck, setNeedsFatigueAck] = React.useState(false);
  const [replacing, setReplacing] = React.useState(false);
  const [replaceError, setReplaceError] = React.useState<string | null>(null);

  // A different (or closed) drawer starts the Replace Guard form afresh.
  React.useEffect(() => {
    setReplaceMode(false);
    setReplacementId(null);
    setReplaceReason('');
    setReplaceCategory(null);
    setNoShowConfirmed(false);
    setNeedsFatigueAck(false);
    setReplaceError(null);
  }, [drawerOffer?.id]);
  // A different Guard needs their own fatigue assessment.
  React.useEffect(() => { setNeedsFatigueAck(false); }, [replacementId]);

  // ─── Derived ────────────────────────────────────────────────────────────

  const offerRows = React.useMemo(
    () =>
      shifts
        .filter((s) => isOfferRelevant(s.status))
        .sort((a, b) => a.start.localeCompare(b.start)),
    [shifts],
  );

  const awaitingCount = React.useMemo(() => offerRows.filter((s) => normalizeOfferStatus(s.status) === 'awaiting').length, [offerRows]);
  const acceptedCount = React.useMemo(() => offerRows.filter((s) => normalizeOfferStatus(s.status) === 'accepted').length, [offerRows]);
  const rejectedCount = React.useMemo(() => offerRows.filter((s) => normalizeOfferStatus(s.status) === 'rejected').length, [offerRows]);

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

  const handleConfirmReplace = React.useCallback(async () => {
    if (!drawerOffer || !onReplaceGuard || !replacementId || !replaceCategory || !replaceReason.trim()) return;
    const noShow = isAcceptedAndStarted(drawerOffer, normalizeOfferStatus(drawerOffer.status));
    if (noShow && !noShowConfirmed) return;
    try {
      setReplacing(true);
      setReplaceError(null);
      await onReplaceGuard(drawerOffer.id, {
        replacementGuardId: replacementId,
        reasonCategory: replaceCategory,
        reason: replaceReason.trim(),
        ...(noShow ? { noShow: true } : {}),
        ...(needsFatigueAck ? { fatigueAcknowledged: true } : {}),
      });
      setDrawerOffer(null);
    } catch (error) {
      if ((error as { code?: string })?.code === 'REPLACE_GUARD_FATIGUE_ACKNOWLEDGEMENT_REQUIRED') setNeedsFatigueAck(true);
      setReplaceError(error instanceof Error && error.message ? error.message : 'Unable to replace the Guard right now.');
    } finally {
      setReplacing(false);
    }
  }, [drawerOffer, onReplaceGuard, replacementId, replaceCategory, replaceReason, noShowConfirmed, needsFatigueAck]);

  const handleNavigateToRota = React.useCallback(
    (shift: Shift) => {
      const siteId = getSiteId(shift);
      if (!siteId) return;
      onNavigateToRota(siteId, weekCommencingFor(shift.start, shiftZone(shift)));
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
    const ns         = normalizeOfferStatus(shift.status);
    const badge      = getStatusBadgeProps(ns);
    const siteName   = getSiteName(shift);
    const hasSiteId  = Boolean(getSiteId(shift));
    const hasRotaSlot = shift.rotaSlotId != null;
    const showWithdraw = ns === 'awaiting';

    // "Plan Cover" — rejected always (if site known); missed only while shift is future/live
    const canPlanCover = hasSiteId && (ns === 'rejected' || (ns === 'missed' && isShiftInFuture(shift.end)));
    const canViewInRota = hasSiteId && (ns === 'awaiting' || ns === 'accepted');

    const zone = shiftZone(shift);
    const shiftWindow = `${fmtDate(shift.start, zone)} · ${fmtShiftWindow(shift.start, shift.end, zone)}`;
    const showReplace = Boolean(onReplaceGuard && replacementGuards) && canReplaceGuard(shift, ns);
    const candidates = (replacementGuards ?? []).filter((g) => g.id !== shift.guard?.id);
    const noShowCase = isAcceptedAndStarted(shift, ns);

    const replaceFooter = (
      <View style={styles.drawerFooter}>
        <Button label="Cancel" variant="secondary" size="md" onPress={() => setReplaceMode(false)} disabled={replacing} />
        <Button
          label={needsFatigueAck ? 'Acknowledge and replace' : 'Replace Guard'}
          variant="primary"
          size="md"
          onPress={handleConfirmReplace}
          loading={replacing}
          disabled={!replacementId || !replaceCategory || !replaceReason.trim() || (noShowCase && !noShowConfirmed)}
        />
      </View>
    );

    const drawerFooter = replaceMode ? replaceFooter : (
      <View style={styles.drawerFooter}>
        <Button label="Close" variant="secondary" size="md" onPress={() => setDrawerOffer(null)} />
        {canViewInRota ? (
          <Button label="View in Rota" variant="secondary" size="md" onPress={() => handleNavigateToRota(shift)} />
        ) : null}
        {canPlanCover ? (
          <Button label="Plan Cover" variant="secondary" size="md" onPress={() => handleNavigateToRota(shift)} />
        ) : null}
        {ns === 'accepted' ? (
          <Button label="Open in Live Operations" variant="secondary" size="md" onPress={() => handleNavigateToLiveOps(shift)} />
        ) : null}
        {showReplace ? (
          <Button label="Replace Guard" variant="secondary" size="md" onPress={() => setReplaceMode(true)} />
        ) : null}
        {showWithdraw ? (
          <Button label="Withdraw Offer" variant="danger" size="md" onPress={() => handleRequestWithdraw(shift)} />
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
        {/* Status badge */}
        <View style={styles.drawerBadgeRow}>
          <StatusBadge label={badge.label} tone={badge.tone} size="small" />
        </View>

        {/* Key / value rows */}
        <DrawerRow label="Guard" value={getGuardName(shift)} />
        <DrawerRow label="Shift" value={shiftWindow} />

        {/* Replace Guard — one step: the shift becomes a new offer to the chosen Guard */}
        {replaceMode ? (
          <View style={styles.drawerInstructionsBlock}>
            <Text style={styles.drawerSectionTitle}>Replace Guard</Text>
            <Text style={styles.drawerMeta}>
              The shift becomes a new offer to the Guard you choose; it is not confirmed cover until they accept it.
              {' '}{getGuardName(shift)} is told their shift assignment has changed, with the reason you pick below (never
              the details).
            </Text>
            <View style={styles.replaceList}>
              {candidates.length === 0 ? (
                <Text style={styles.drawerMeta}>No other active Guards in your company.</Text>
              ) : (
                candidates.map((g) => (
                  <Pressable
                    key={g.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: replacementId === g.id }}
                    onPress={() => setReplacementId(g.id)}
                    style={[styles.replaceOption, replacementId === g.id ? styles.replaceOptionActive : null]}
                  >
                    <Text style={styles.drawerInstructions}>{g.name}</Text>
                  </Pressable>
                ))
              )}
            </View>
            <Text style={styles.drawerSectionTitle}>Reason shown to {getGuardName(shift)}</Text>
            <View style={styles.replaceList}>
              {REASON_CATEGORIES.map((c) => (
                <Pressable
                  key={c.key}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: replaceCategory === c.key }}
                  onPress={() => setReplaceCategory(c.key)}
                  style={[styles.replaceOption, replaceCategory === c.key ? styles.replaceOptionActive : null]}
                >
                  <Text style={styles.drawerInstructions}>{c.label}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              style={styles.searchInput}
              value={replaceReason}
              onChangeText={setReplaceReason}
              placeholder="Details (audit log only; never shown to a Guard)"
              placeholderTextColor={colors.fieldPlaceholder}
              maxLength={500}
            />
            {noShowCase ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: noShowConfirmed }}
                onPress={() => setNoShowConfirmed((v) => !v)}
                style={[styles.replaceOption, noShowConfirmed ? styles.replaceOptionActive : null, styles.replaceConfirm]}
              >
                <Text style={styles.drawerInstructions}>
                  {noShowConfirmed ? '☑' : '☐'} This shift has started and {getGuardName(shift)} has not booked on (no-show).
                </Text>
              </Pressable>
            ) : null}
            {replaceError ? <Text style={[styles.drawerMeta, styles.drawerMetaDanger]}>{replaceError}</Text> : null}
          </View>
        ) : null}

        {/* Rota context — awaiting and accepted only */}
        {(ns === 'awaiting' || ns === 'accepted') ? (
          <DrawerRow label="Rota" value={hasRotaSlot ? 'Linked' : 'Legacy shift'} />
        ) : null}

        {/* Instructions — awaiting and accepted only, if present */}
        {(ns === 'awaiting' || ns === 'accepted') && shift.instructions ? (
          <View style={styles.drawerInstructionsBlock}>
            <Text style={styles.drawerSectionTitle}>Instructions</Text>
            <Text style={styles.drawerInstructions}>{shift.instructions}</Text>
          </View>
        ) : null}

        {/* Action required — rejected */}
        {ns === 'rejected' ? (
          <View style={styles.drawerActionRequired}>
            <Text style={styles.drawerActionTitle}>Action Required</Text>
            <Text style={[styles.drawerActionBody, styles.drawerMetaDanger]}>
              This offer was declined.{'\n'}This position requires cover.
            </Text>
          </View>
        ) : null}

        {/* Action required — missed */}
        {ns === 'missed' ? (
          <View style={[styles.drawerActionRequired, styles.drawerActionRequiredWarning]}>
            <Text style={styles.drawerActionTitle}>Action Required</Text>
            <Text style={[styles.drawerActionBody, styles.drawerMetaWarning]}>
              {isShiftInFuture(shift.end)
                ? 'Guard did not check in.\nThis position requires cover.'
                : 'Guard did not check in.\nReview attendance records.'}
            </Text>
          </View>
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

      {/* Summary strip — clickable, synced with filter */}
      <View style={styles.summaryStrip}>
        <SummaryStat
          value={awaitingCount}
          label="Awaiting"
          highlight={awaitingCount > 0 ? 'info' : undefined}
          isActive={filter === 'awaiting'}
          onPress={() => setFilter('awaiting')}
        />
        <View style={styles.summaryDivider} />
        <SummaryStat
          value={acceptedCount}
          label="Accepted"
          highlight={acceptedCount > 0 ? 'success' : undefined}
          isActive={filter === 'accepted'}
          onPress={() => setFilter('accepted')}
        />
        <View style={styles.summaryDivider} />
        <SummaryStat
          value={rejectedCount}
          label="Rejected"
          highlight={rejectedCount > 0 ? 'danger' : undefined}
          isActive={filter === 'rejected'}
          onPress={() => setFilter('rejected')}
        />
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
                    <Text style={styles.shiftDate} numberOfLines={1}>{fmtDate(shift.start, shiftZone(shift))}</Text>
                    <Text style={styles.shiftTime} numberOfLines={1}>{fmtShiftWindow(shift.start, shift.end, shiftZone(shift))}</Text>
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
            ? `The guard will no longer be able to accept this offer for ${getSiteName(withdrawTarget)} on ${fmtDate(withdrawTarget.start, shiftZone(withdrawTarget))}. The position will be cancelled and cover may need to be planned again.`
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
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  } as any,
  summaryDivider: {
    width: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },
  summaryStat: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.card,
  },
  summaryStatPressed: {
    opacity: 0.75,
  },
  summaryValue: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 28,
    color: colors.textPrimary,
  },
  summaryLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  } as any,

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
  drawerBadgeRow: {
    marginBottom: spacing.sm,
  },
  drawerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceSubtle,
  },
  drawerRowLabel: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flex: 1,
  },
  drawerRowValue: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '500',
    flex: 2,
    textAlign: 'right',
  },
  drawerInstructionsBlock: {
    paddingTop: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceSubtle,
    paddingBottom: spacing.sm,
  },
  drawerSectionTitle: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
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
  drawerActionRequired: {
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.dangerSurface,
    borderRadius: radii.card,
    borderLeftWidth: 3,
    borderLeftColor: colors.danger,
  },
  drawerActionRequiredWarning: {
    backgroundColor: colors.warningSurface,
    borderLeftColor: colors.warning,
  },
  drawerActionTitle: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  drawerActionBody: {
    ...typography.caption,
    lineHeight: 19,
  },
  drawerFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'flex-end',
  },
  replaceList: {
    gap: spacing.xs,
    marginVertical: spacing.sm,
  },
  replaceOption: {
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
  },
  replaceOptionActive: {
    borderColor: colors.info,
    backgroundColor: colors.infoSurface,
  },
  replaceConfirm: {
    marginTop: spacing.sm,
  },
});
