import * as React from 'react';
import { Fragment } from 'react/jsx-runtime';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import type {
  RotaCoveragePhase,
  RotaCoverageState,
  RotaPositionCounts,
  RotaSlotPositionSummary,
  RotaSlotDetail,
  RotaSlotCell,
  RotaWeekSnapshot,
} from '../../types/models';

const IS_WEB = typeof document !== 'undefined';

// ── Exported types ────────────────────────────────────────────────────────────

export type PlannerWeekDay = {
  date: string;
  label: string;
  shortLabel: string;
};

/** A RotaSlotCell enriched with the site context from its parent SiteWeekRow. */
export type FlatSlotCell = RotaSlotCell & {
  siteId: number;
  siteName: string;
  clientId: number | null;
  clientName: string | null;
};

/** A legacy Shift (rotaSlotId=null) surfaced for backward-compatible display only. */
export type LegacyShiftRow = {
  id: number;
  date: string;
  startTime: string;
  endTime: string;
  siteName: string;
  guardName: string | null;
  status: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUtcTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  } catch {
    return iso.slice(11, 16);
  }
}

function formatUtcDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  } catch {
    return iso.slice(0, 10);
  }
}

// ── Coverage state tokens ─────────────────────────────────────────────────────

function slotStateTokens(state: RotaCoverageState): {
  bg: string; fg: string; label: string; problem: boolean;
} {
  switch (state) {
    case 'fully_planned':       return { bg: colors.successSurface,  fg: colors.success,  label: 'Fully planned',      problem: false };
    case 'offered_pending':     return { bg: colors.infoSurface,     fg: colors.info,     label: 'Awaiting acceptance', problem: false };
    case 'under_planned':       return { bg: colors.warningSurface,  fg: colors.warning,  label: 'Cover required',     problem: true  };
    case 'fully_open':          return { bg: colors.dangerSurface,   fg: colors.danger,   label: 'Open',               problem: true  };
    case 'has_problems':        return { bg: colors.warningSurface,  fg: colors.warning,  label: 'Attention',          problem: true  };
    case 'live_fully_staffed':  return { bg: colors.successSurface,  fg: colors.success,  label: 'Fully staffed',      problem: false };
    case 'live_partial':        return { bg: colors.warningSurface,  fg: colors.warning,  label: 'Short staffed',      problem: true  };
    case 'live_none_on_site':   return { bg: colors.dangerSurface,   fg: colors.danger,   label: 'None on site',       problem: true  };
    case 'live_has_problems':   return { bg: colors.warningSurface,  fg: colors.warning,  label: 'Attention',          problem: true  };
    case 'outcome_completed':   return { bg: colors.pendingSurface,  fg: colors.pending,  label: 'Completed',          problem: false };
    case 'outcome_shortfall':   return { bg: colors.warningSurface,  fg: colors.warning,  label: 'Completed short',    problem: true  };
    case 'outcome_failed':      return { bg: colors.dangerSurface,   fg: colors.danger,   label: 'Failed',             problem: true  };
    case 'outcome_has_problems':return { bg: colors.warningSurface,  fg: colors.warning,  label: 'Attention',          problem: true  };
    case 'outcome_cancelled':   return { bg: colors.pendingSurface,  fg: colors.pending,  label: 'Cancelled',          problem: false };
    case 'cancelled':           return { bg: colors.pendingSurface,  fg: colors.pending,  label: 'Cancelled',          problem: false };
    default:                    return { bg: colors.pendingSurface,  fg: colors.pending,  label: state || '—',         problem: false };
  }
}

function positionStatusTokens(status: string): { fg: string; label: string } {
  switch (status) {
    case 'unfilled':    return { fg: colors.danger,   label: 'Open position' };
    case 'offered':     return { fg: colors.info,     label: 'Offered'       };
    case 'ready':       return { fg: colors.success,  label: 'Ready'         };
    case 'in_progress': return { fg: colors.success,  label: 'On shift'      };
    case 'completed':   return { fg: colors.pending,  label: 'Completed'     };
    case 'missed':      return { fg: colors.warning,  label: 'Missed'        };
    case 'rejected':    return { fg: colors.warning,  label: 'Rejected'      };
    case 'cancelled':   return { fg: colors.textMuted, label: 'Cancelled'    };
    default:            return { fg: colors.textMuted, label: status || '—'  };
  }
}

// ── Filter select (web-native) ────────────────────────────────────────────────

function FilterSelect({
  value, onChange, options, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ label: string; value: string }>;
  placeholder?: string;
}) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => { setMounted(IS_WEB); }, []);

  if (mounted) {
    const SelectTag: any = 'select';
    const OptionTag: any = 'option';
    return (
      <SelectTag
        value={value}
        onChange={(e: any) => onChange(e.target.value)}
        style={filterSelectStyle}
        aria-label={placeholder ?? 'Select'}
      >
        <OptionTag value="">{placeholder ?? 'Select'}</OptionTag>
        {options.map((opt) => (
          <OptionTag key={opt.value} value={opt.value}>{opt.label}</OptionTag>
        ))}
      </SelectTag>
    );
  }
  return null;
}

const filterSelectStyle: any = {
  height: 38,
  borderWidth: 1.5,
  borderColor: colors.fieldBorder,
  borderRadius: radii.sm,
  paddingLeft: spacing.md,
  paddingRight: spacing.md,
  fontSize: 14,
  color: colors.textPrimary,
  backgroundColor: colors.card,
  outlineStyle: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

// ── Props ─────────────────────────────────────────────────────────────────────

type CompanyRotaPlannerWorkspaceProps = {
  plannerClientId: string;
  plannerSiteId: string;
  setPlannerClientId: (v: string) => void;
  setPlannerSiteId: (v: string) => void;
  siteClientOptions: Array<{ label: string; value: string }>;
  plannerSiteOptions: Array<{ label: string; value: string }>;

  weekCommencing: string;
  weekEnding: string;
  plannerWeekDays: PlannerWeekDay[];
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onTodayWeek: () => void;

  slotsByDayName: Map<string, FlatSlotCell[]>;
  weekSnapshot: RotaWeekSnapshot | null;
  loadingRota: boolean;
  rotaError: string | null;
  onRetryLoadRota: () => void;

  selectedSlotDetail: RotaSlotDetail | null;
  loadingSlotDetail: boolean;
  onOpenSlot: (slotId: number) => void;
  onCloseSlotDrawer: () => void;

  legacyShiftsByDate: Map<string, LegacyShiftRow[]>;
};

// ── Component ─────────────────────────────────────────────────────────────────

const DAY_NAMES = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
] as const;

export function CompanyRotaPlannerWorkspace({
  plannerClientId,
  plannerSiteId,
  setPlannerClientId,
  setPlannerSiteId,
  siteClientOptions,
  plannerSiteOptions,
  weekCommencing,
  weekEnding,
  plannerWeekDays,
  onPrevWeek,
  onNextWeek,
  onTodayWeek,
  slotsByDayName,
  weekSnapshot,
  loadingRota,
  rotaError,
  onRetryLoadRota,
  selectedSlotDetail,
  loadingSlotDetail,
  onOpenSlot,
  onCloseSlotDrawer,
  legacyShiftsByDate,
}: CompanyRotaPlannerWorkspaceProps) {

  // ── Week label ───────────────────────────────────────────────────────────────
  const weekLabel = plannerWeekDays.length >= 7
    ? `${plannerWeekDays[0].shortLabel} – ${plannerWeekDays[6].shortLabel}`
    : `${weekCommencing} – ${weekEnding}`;

  // ── Summary stats from snapshot ──────────────────────────────────────────────
  const snap = weekSnapshot;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <View style={styles.workspace}>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <View style={styles.toolbar}>
        <View style={styles.filterGroup}>
          <View style={styles.filterCell}>
            <FilterSelect
              value={plannerClientId}
              onChange={setPlannerClientId}
              options={siteClientOptions}
              placeholder="All clients"
            />
          </View>
          <View style={styles.filterCell}>
            <FilterSelect
              value={plannerSiteId}
              onChange={setPlannerSiteId}
              options={plannerSiteOptions}
              placeholder="All sites"
            />
          </View>
        </View>

        <View style={styles.weekNav}>
          <Pressable
            onPress={onPrevWeek}
            style={({ pressed }: any) => [styles.navBtn, pressed && styles.navBtnPressed]}
            accessibilityLabel="Previous week"
            accessibilityRole="button"
          >
            <Text style={styles.navBtnText}>‹</Text>
          </Pressable>
          <Text style={styles.weekLabel} numberOfLines={1}>{weekLabel}</Text>
          <Pressable
            onPress={onNextWeek}
            style={({ pressed }: any) => [styles.navBtn, pressed && styles.navBtnPressed]}
            accessibilityLabel="Next week"
            accessibilityRole="button"
          >
            <Text style={styles.navBtnText}>›</Text>
          </Pressable>
          <Button label="Today" variant="secondary" size="sm" onPress={onTodayWeek} />
        </View>
      </View>

      {/* ── Summary strip ───────────────────────────────────────────────────── */}
      {snap && (
        <View style={styles.summaryStrip}>
          <SummaryStat value={snap.totalSlots}      label="Periods" />
          <View style={styles.summaryDivider} />
          <SummaryStat value={snap.totalPositions}  label="Positions" />
          <View style={styles.summaryDivider} />
          <SummaryStat
            value={snap.openPositions}
            label="Open"
            highlight={snap.openPositions > 0 ? 'danger' : undefined}
          />
          <View style={styles.summaryDivider} />
          <SummaryStat
            value={snap.offeredPending}
            label="Awaiting"
            highlight={snap.offeredPending > 0 ? 'info' : undefined}
          />
          <View style={styles.summaryDivider} />
          <SummaryStat
            value={snap.onShiftNow}
            label="On shift"
            highlight={snap.onShiftNow > 0 ? 'success' : undefined}
          />
          <View style={styles.summaryDivider} />
          <SummaryStat
            value={snap.problems}
            label="Problems"
            highlight={snap.problems > 0 ? 'warning' : undefined}
          />
        </View>
      )}

      {/* ── Loading state ────────────────────────────────────────────────────── */}
      {loadingRota && (
        <View style={styles.centeredFeedback}>
          <ActivityIndicator color={colors.accentTeal} />
          <Text style={styles.feedbackText}>Loading rota…</Text>
        </View>
      )}

      {/* ── Error state ──────────────────────────────────────────────────────── */}
      {!loadingRota && rotaError && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{rotaError}</Text>
          <Button label="Retry" variant="secondary" size="sm" onPress={onRetryLoadRota} />
        </View>
      )}

      {/* ── Day sections ─────────────────────────────────────────────────────── */}
      {!loadingRota && !rotaError && (
        <View style={styles.daySections}>
          {plannerWeekDays.map((day, dayIdx) => {
            const dayName = DAY_NAMES[dayIdx];
            const slots = slotsByDayName.get(dayName) ?? [];
            const legacyRows = legacyShiftsByDate.get(day.date) ?? [];
            const totalRows = slots.length + legacyRows.length;
            const dayOpenCount = slots.reduce((acc, s) => acc + s.counts.open, 0);

            return (
              <View key={day.date} style={styles.daySection}>
                {/* Day header */}
                <View style={styles.dayHeader}>
                  <View style={styles.dayHeaderTitle}>
                    <Text style={styles.dayName}>{day.label}</Text>
                    <Text style={styles.dayShortLabel}>{day.shortLabel}</Text>
                  </View>
                  <View style={styles.dayHeaderMeta}>
                    {totalRows > 0 && (
                      <Text style={styles.daySlotCount}>
                        {slots.length} period{slots.length !== 1 ? 's' : ''}
                        {legacyRows.length > 0 && ` · ${legacyRows.length} legacy`}
                      </Text>
                    )}
                    {dayOpenCount > 0 && (
                      <View style={styles.openChip}>
                        <Text style={styles.openChipText}>{dayOpenCount} open</Text>
                      </View>
                    )}
                  </View>
                </View>

                {/* RotaSlot rows */}
                {slots.length === 0 && legacyRows.length === 0 ? (
                  <View style={styles.emptyDayRow}>
                    <Text style={styles.emptyDayText}>No rota periods planned.</Text>
                  </View>
                ) : (
                  <>
                    {slots.map((cell, idx) => (
                      <Fragment key={`slot-${cell.slotId}`}>
                        <RotaSlotRow
                          cell={cell}
                          isLast={idx === slots.length - 1 && legacyRows.length === 0}
                          onPress={() => onOpenSlot(cell.slotId)}
                        />
                      </Fragment>
                    ))}
                    {legacyRows.map((legacy, idx) => (
                      <Fragment key={`legacy-${legacy.id}`}>
                        <LegacyRow
                          row={legacy}
                          isLast={idx === legacyRows.length - 1}
                        />
                      </Fragment>
                    ))}
                  </>
                )}
              </View>
            );
          })}
        </View>
      )}

      {/* ── Read-only slot detail drawer ─────────────────────────────────────── */}
      <Drawer
        visible={selectedSlotDetail !== null || loadingSlotDetail}
        onClose={onCloseSlotDrawer}
        title={selectedSlotDetail?.siteName ?? 'Loading…'}
        subtitle={
          selectedSlotDetail
            ? `${formatUtcDate(selectedSlotDetail.startAt)} · ${formatUtcTime(selectedSlotDetail.startAt)}–${formatUtcTime(selectedSlotDetail.endAt)}`
            : ''
        }
        compact
        width={480}
        footer={
          <View style={styles.drawerFooterRow}>
            <Button label="Close" variant="secondary" size="sm" onPress={onCloseSlotDrawer} />
          </View>
        }
      >
        <SlotDetailBody
          detail={selectedSlotDetail}
          loading={loadingSlotDetail}
        />
      </Drawer>
    </View>
  );
}

// ── RotaSlot row ──────────────────────────────────────────────────────────────

function RotaSlotRow({
  cell,
  isLast,
  onPress,
}: {
  cell: FlatSlotCell;
  isLast: boolean;
  onPress: () => void;
}) {
  const tok = slotStateTokens(cell.coverageState);
  const startStr = formatUtcTime(cell.startAt);
  const endStr   = formatUtcTime(cell.endAt);
  const timeStr  = `${startStr}–${endStr}`;
  const coverStr = `${cell.counts.assigned} / ${cell.counts.required}`;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed, hovered }: any) => [
        styles.slotRow,
        !isLast && styles.slotRowDivider,
        (pressed || hovered) && styles.slotRowHovered,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${timeStr} ${cell.siteName} ${cell.counts.assigned} of ${cell.counts.required} ${tok.label}`}
    >
      {/* Problem accent bar */}
      <View style={[styles.accentBar, { backgroundColor: tok.problem ? tok.fg : 'transparent' }]} />

      <View style={styles.rowContent}>
        {/* Time + night indicator */}
        <View style={styles.colTimeWrap}>
          <Text style={styles.colTime} numberOfLines={1}>{timeStr}</Text>
          {cell.isNightShift && <Text style={styles.nightDot}>●</Text>}
        </View>

        {/* Site */}
        <Text style={styles.colSite} numberOfLines={1}>
          {cell.siteName || '—'}
        </Text>

        {/* Cover fraction + open indicator */}
        <View style={styles.colCoverWrap}>
          <Text style={styles.colCover}>{coverStr}</Text>
          {cell.counts.open > 0 && (
            <Text style={styles.colCoverOpen}>{cell.counts.open} open</Text>
          )}
        </View>

        {/* State badge */}
        <View style={[styles.stateBadge, { backgroundColor: tok.bg }]}>
          <Text style={[styles.stateBadgeText, { color: tok.fg }]} numberOfLines={1}>
            {tok.label}
          </Text>
        </View>

        {/* Chevron */}
        <Text style={styles.chevron}>›</Text>
      </View>
    </Pressable>
  );
}

// ── Legacy row ────────────────────────────────────────────────────────────────

function LegacyRow({ row, isLast }: { row: LegacyShiftRow; isLast: boolean }) {
  return (
    <View style={[styles.slotRow, !isLast && styles.slotRowDivider, styles.legacyRow]}>
      <View style={styles.accentBar} />
      <View style={[styles.rowContent, styles.rowContentLegacy]}>
        <Text style={styles.colTime} numberOfLines={1}>
          {row.startTime}–{row.endTime}
        </Text>
        <Text style={styles.colSite} numberOfLines={1}>
          {row.siteName || '—'}
        </Text>
        <Text style={styles.colGuardLegacy} numberOfLines={1}>
          {row.guardName ?? 'Unassigned'}
        </Text>
        <View style={styles.legacyPill}>
          <Text style={styles.legacyPillText}>Legacy</Text>
        </View>
      </View>
    </View>
  );
}

// ── Slot detail body ──────────────────────────────────────────────────────────

function SlotDetailBody({
  detail,
  loading,
}: {
  detail: RotaSlotDetail | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <View style={drawerBodyStyles.centeredLoading}>
        <ActivityIndicator color={colors.accentTeal} />
        <Text style={drawerBodyStyles.loadingText}>Loading slot detail…</Text>
      </View>
    );
  }

  if (!detail) return null;

  const startStr = formatUtcTime(detail.startAt);
  const endStr   = formatUtcTime(detail.endAt);
  const dateStr  = formatUtcDate(detail.startAt);

  return (
    <ScrollView style={drawerBodyStyles.scroll} showsVerticalScrollIndicator={false}>
      <View style={drawerBodyStyles.body}>

        {/* Schedule */}
        <Text style={drawerBodyStyles.sectionLabel}>Schedule</Text>
        <CoverRow label="Date"  value={dateStr} />
        <CoverRow label="Start" value={startStr} />
        <CoverRow label="End"   value={endStr} />
        {detail.title && <CoverRow label="Title" value={detail.title} />}

        {/* Cover */}
        <Text style={[drawerBodyStyles.sectionLabel, drawerBodyStyles.sectionLabelSpaced]}>Cover</Text>
        <CoverRow label="Required"  value={String(detail.counts.required)} />
        <CoverRow label="Assigned"  value={String(detail.counts.assigned)} />
        <CoverRow label="Confirmed" value={String(detail.counts.confirmed)} />
        {detail.counts.offered > 0 && (
          <CoverRow label="Awaiting"  value={String(detail.counts.offered)} />
        )}
        {detail.counts.open > 0 && (
          <CoverRow label="Open"      value={String(detail.counts.open)}    emphasis="danger" />
        )}
        {detail.counts.problem > 0 && (
          <CoverRow label="Problems"  value={String(detail.counts.problem)} emphasis="warning" />
        )}
        {detail.counts.onShift > 0 && (
          <CoverRow label="On shift"  value={String(detail.counts.onShift)} emphasis="success" />
        )}

        {/* Positions */}
        <Text style={[drawerBodyStyles.sectionLabel, drawerBodyStyles.sectionLabelSpaced]}>
          Positions ({detail.positions.length})
        </Text>
        {detail.positions.map((pos) => (
          <Fragment key={pos.shiftId}>
            <PositionRow position={pos} />
          </Fragment>
        ))}
        {detail.positions.length === 0 && (
          <Text style={drawerBodyStyles.noPositions}>No positions.</Text>
        )}

        {/* Instructions */}
        {detail.instructions && (
          <>
            <Text style={[drawerBodyStyles.sectionLabel, drawerBodyStyles.sectionLabelSpaced]}>Instructions</Text>
            <Text style={drawerBodyStyles.instructions}>{detail.instructions}</Text>
          </>
        )}
      </View>
    </ScrollView>
  );
}

function CoverRow({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: 'danger' | 'warning' | 'success';
}) {
  const valueColor =
    emphasis === 'danger'  ? colors.danger  :
    emphasis === 'warning' ? colors.warning :
    emphasis === 'success' ? colors.success :
    colors.textPrimary;

  return (
    <View style={drawerBodyStyles.coverRow}>
      <Text style={drawerBodyStyles.coverLabel}>{label}</Text>
      <Text style={[drawerBodyStyles.coverValue, { color: valueColor }]}>{value}</Text>
    </View>
  );
}

function PositionRow({ position }: { position: RotaSlotPositionSummary }) {
  const tok = positionStatusTokens(position.status);
  return (
    <View style={drawerBodyStyles.positionRow}>
      <Text style={drawerBodyStyles.positionName} numberOfLines={1}>
        {position.guardName ?? 'Open position'}
      </Text>
      <Text style={[drawerBodyStyles.positionStatus, { color: tok.fg }]}>
        {tok.label}
      </Text>
    </View>
  );
}

// ── Summary stat atom ─────────────────────────────────────────────────────────

function SummaryStat({
  value,
  label,
  highlight,
}: {
  value: number;
  label: string;
  highlight?: 'danger' | 'info' | 'warning' | 'success';
}) {
  const numColor =
    highlight === 'danger'  ? colors.danger  :
    highlight === 'warning' ? colors.warning :
    highlight === 'info'    ? colors.info    :
    highlight === 'success' ? colors.success :
    colors.textPrimary;

  return (
    <View style={summaryStyles.stat}>
      <Text style={[summaryStyles.value, { color: numColor }]}>{value}</Text>
      <Text style={summaryStyles.label}>{label}</Text>
    </View>
  );
}

const summaryStyles = StyleSheet.create({
  stat: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  value: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 28,
    color: colors.textPrimary,
  },
  label: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
});

// ── Drawer body styles ────────────────────────────────────────────────────────

const drawerBodyStyles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  body: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.xs,
  },
  centeredLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  loadingText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.xs,
  } as any,
  sectionLabelSpaced: {
    marginTop: spacing.md,
  },
  coverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  coverLabel: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  coverValue: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  positionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  positionName: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  positionStatus: {
    fontSize: 12,
    fontWeight: '700',
    marginLeft: spacing.sm,
    flexShrink: 0,
  },
  noPositions: {
    ...typography.caption,
    color: colors.textMuted,
    fontStyle: 'italic',
  } as any,
  instructions: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 20,
  },
});

// ── Main styles ───────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  workspace: {
    gap: spacing.md,
  },

  // Toolbar
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
  },
  filterGroup: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexShrink: 1,
  },
  filterCell: {
    minWidth: 148,
    maxWidth: 220,
    flex: 1,
  },
  weekNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flex: 1,
    justifyContent: 'center',
    minWidth: 280,
  },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    flexShrink: 0,
  },
  navBtnPressed: {
    backgroundColor: colors.surfaceSubtle,
  },
  navBtnText: {
    fontSize: 22,
    lineHeight: 26,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  weekLabel: {
    ...typography.label,
    color: colors.textPrimary,
    flex: 1,
    textAlign: 'center',
  },

  // Summary strip
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

  // Loading / error feedback
  centeredFeedback: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.sm,
  },
  feedbackText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  errorBox: {
    backgroundColor: colors.dangerSurface,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.danger,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  errorText: {
    fontSize: 14,
    color: colors.danger,
    lineHeight: 20,
  },

  // Day sections
  daySections: {
    gap: spacing.sm,
  },
  daySection: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  } as any,
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSubtle,
  },
  dayHeaderTitle: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    flex: 1,
  },
  dayName: {
    ...typography.panelHeading,
    color: colors.textPrimary,
  },
  dayShortLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  dayHeaderMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 0,
  },
  daySlotCount: {
    ...typography.caption,
    color: colors.textMuted,
  },
  openChip: {
    backgroundColor: colors.dangerSurface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  openChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.danger,
  },
  emptyDayRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  emptyDayText: {
    ...typography.caption,
    color: colors.textMuted,
    fontStyle: 'italic',
  } as any,

  // Slot row
  slotRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 48,
  },
  slotRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  slotRowHovered: {
    backgroundColor: colors.surfaceSubtle,
  },
  legacyRow: {
    backgroundColor: colors.surfaceSubtle,
    opacity: 0.85,
  },
  accentBar: {
    width: 3,
    alignSelf: 'stretch',
    flexShrink: 0,
  },
  rowContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    minHeight: 48,
  },
  rowContentLegacy: {
    opacity: 1,
  },
  colTimeWrap: {
    width: 114,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  colTime: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  } as any,
  nightDot: {
    fontSize: 7,
    color: colors.info,
    lineHeight: 14,
  },
  colSite: {
    flex: 2,
    fontSize: 13,
    color: colors.textPrimary,
    minWidth: 0,
  },
  colCoverWrap: {
    width: 80,
    flexShrink: 0,
    alignItems: 'flex-end',
    gap: 1,
  },
  colCover: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  } as any,
  colCoverOpen: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.danger,
  },
  colGuardLegacy: {
    flex: 2,
    fontSize: 13,
    color: colors.textSecondary,
    minWidth: 0,
    fontStyle: 'italic',
  } as any,
  legacyPill: {
    backgroundColor: colors.pendingSurface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    flexShrink: 0,
  },
  legacyPillText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.pending,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  } as any,
  stateBadge: {
    width: 108,
    flexShrink: 0,
    borderRadius: radii.pill,
    paddingVertical: 3,
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
  },
  stateBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  } as any,
  chevron: {
    width: 20,
    flexShrink: 0,
    textAlign: 'center',
    fontSize: 16,
    color: colors.neutralSlate,
    fontWeight: '600',
  } as any,

  // Drawer footer
  drawerFooterRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
});
