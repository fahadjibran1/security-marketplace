import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { getPatrolMonitorSite } from '../../services/api';
import { colors, radii, spacing, typography } from '../../theme';
import type { PatrolMonitorCell, PatrolMonitorHour, PatrolMonitorLane, PatrolMonitorSite, PatrolMonitorSummarySite } from '../../types/patrols';
import type { PatrolPageContext } from './patrolContext';
import { MonitorAdHocDetail, PatrolMonitorCellDetail, type MonitorCellSelection } from './PatrolMonitorCellDetail';
import { monitorPalette } from './PatrolMonitorMarks';
import {
  monitorCellA11yLabel,
  monitorCellCount,
  monitorCellOpens,
  monitorClockOnDay,
  monitorGridLayout,
  monitorHourLabel,
  monitorHourOffsetShown,
  monitorAdHocByHour,
  monitorLaneLabels,
  monitorCardVerified,
  monitorNeedsReview,
  monitorNextWindowLabel,
  monitorShiftTimes,
  monitorSiteStatusInfo,
  monitorStateInfo,
  type MonitorTone,
} from './patrolMonitorPresentation';
import type { PatrolLayout } from './patrolPresentation';
import { ResourceState, ui, usePatrolResource } from './patrolUi';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as any) : null;

/**
 * One compact site card (S4 Patrol Monitor S2). Collapsed it shows only the summary row it was given — nothing is
 * fetched. Expanded, it reads the site's lanes × hours once (GET /patrols/monitor/sites/:id) and refreshes them only
 * while it stays expanded, on screen, and on today's date (`live`). Collapsing stops the refresh and drops the data.
 */
export function PatrolMonitorSiteCard({ ctx, site, expanded, live, onToggle }: {
  ctx: PatrolPageContext;
  site: PatrolMonitorSummarySite;
  expanded: boolean;
  live: boolean;
  onToggle: () => void;
  key?: string | number;
}) {
  const detail = usePatrolResource(
    `monitor-site|${ctx.companyKey}|${site.siteId}|${site.date}`,
    () => getPatrolMonitorSite(site.siteId, { date: site.date }),
    { enabled: expanded, poll: expanded && live },
  );
  const [selection, setSelection] = React.useState<MonitorCellSelection | null>(null);
  React.useEffect(() => { if (!expanded) setSelection(null); }, [expanded]);

  const status = monitorSiteStatusInfo(site.status);
  const c = site.counts;
  const review = monitorNeedsReview(c);
  const verified = monitorCardVerified(c);
  const statusPalette = monitorPalette(status.tone);
  const title = `${site.siteName}${site.clientName ? `, ${site.clientName}` : ''}`;
  const wide = ctx.layout.mode !== 'mobile';
  // Exactly what a collapsed card owes the reader: verified of those due (later windows apart), missed, needs review,
  // the next window. Additional (ad-hoc) patrols are listed once the site is open; they are never counted.
  const chips = (
    <>
      <Chip symbol="✓" label={verified.label} tone="neutral" />
      {verified.later ? <Chip symbol="○" label={verified.later} tone="neutral" /> : null}
      <Chip symbol="✕" label={`Missed ${c.missed}`} tone={c.missed > 0 ? 'danger' : 'neutral'} />
      <Chip symbol="⚑" label={`Needs review ${review}`} tone={review > 0 ? 'warning' : 'neutral'} />
      <Chip symbol="○" label={monitorNextWindowLabel(site.nextWindowStart, site.timeZone, site.date)} tone="neutral" />
    </>
  );
  return (
    <View style={styles.card} testID={`patrol-monitor-site-${site.siteId}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${site.siteName}`}
        accessibilityHint={`${status.label}. ${c.verified} of ${c.owed} due patrols verified, ${c.missed} missed, ${review} need review.`}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }: any) => [styles.head, pressed ? { backgroundColor: colors.surfaceSubtle } : null, WEB_PTR]}
      >
        {/* Compact: one line on desktop and tablet (name · counts · status); stacked on a phone. */}
        <View style={styles.headTop}>
          <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
          <View style={wide ? { width: 240 } : { flex: 1, minWidth: 140 }}>
            <Text style={styles.siteName} numberOfLines={1}>{site.siteName}</Text>
            <Text style={ui.rowMeta} numberOfLines={1}>{site.clientName || 'No client'}</Text>
          </View>
          {wide ? <View style={[styles.chips, { flex: 1 }]}>{chips}</View> : null}
          <View style={[styles.status, { backgroundColor: statusPalette.bg, borderColor: statusPalette.border }]}>
            <Text style={[styles.statusText, { color: statusPalette.fg }]}>{status.symbol} {status.label}</Text>
          </View>
        </View>
        {wide ? null : <View style={styles.chips}>{chips}</View>}
      </Pressable>
      {expanded ? (
        <View style={styles.body} testID={`patrol-monitor-detail-${site.siteId}`}>
          {ResourceState({ resource: detail, empty: false, emptyMessage: '', what: `${title} patrols` })}
          {detail.data ? <MonitorSiteDetail ctx={ctx} site={detail.data} layout={ctx.layout} onOpenCell={setSelection} /> : null}
        </View>
      ) : null}
      <PatrolMonitorCellDetail ctx={ctx} site={detail.data} selection={expanded ? selection : null} onClose={() => setSelection(null)} />
    </View>
  );
}

function Chip({ symbol, label, tone, hint }: { symbol: string; label: string; tone: MonitorTone; hint?: string }) {
  const p = monitorPalette(tone);
  return (
    <View style={[styles.chip, { backgroundColor: p.bg, borderColor: p.border }]}>
      <Text style={[styles.chipText, { color: p.fg }]}>{symbol} {label}{hint ? <Text style={styles.chipHint}> · {hint}</Text> : null}</Text>
    </View>
  );
}

function MonitorSiteDetail({ ctx, site, layout, onOpenCell }: { ctx: PatrolPageContext; site: PatrolMonitorSite; layout: PatrolLayout; onOpenCell: (s: MonitorCellSelection) => void }) {
  const day = site.range.date;
  const [showExtra, setShowExtra] = React.useState(false);
  const extra = [...site.otherRuns].sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) || a.runId - b.runId);
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={ui.muted}>
        Site time ({site.timeZone}).{' '}
        {site.sweep.judgedThrough ? `Missed patrols checked by S4 up to ${monitorClockOnDay(site.sweep.judgedThrough, site.timeZone, day)}.` : 'Missed patrols not yet checked by S4.'}
        {site.policy.requirementScope === 'site' ? ' Site-wide patrols: any Guard on duty can complete them.' : ' Each Guard on duty owes their own patrols.'}
      </Text>
      {site.lanes.length
        ? <MonitorGrid site={site} layout={layout} onOpenCell={onOpenCell} extraOpen={showExtra} onToggleExtra={() => setShowExtra((v) => !v)} />
        : <Text style={ui.muted}>No patrol rows for this day.</Text>}
      {showExtra && extra.length ? (
        <View style={{ gap: spacing.sm }} testID="patrol-monitor-additional-list">
          <Text style={ui.muted}>Additional patrols are recorded with their photos but count towards no scheduled patrol.</Text>
          {extra.map((o) => <MonitorAdHocDetail key={o.runId} ctx={ctx} site={site} other={o} onLeave={() => undefined} />)}
        </View>
      ) : null}
    </View>
  );
}

function MonitorGrid({ site, layout, onOpenCell, extraOpen, onToggleExtra }: {
  site: PatrolMonitorSite;
  layout: PatrolLayout;
  onOpenCell: (s: MonitorCellSelection) => void;
  extraOpen: boolean;
  onToggleExtra: () => void;
}) {
  const { nameWidth, cellSize } = monitorGridLayout(layout);
  const rowHeight = cellSize + 4;
  const day = site.range.date;
  const hours = site.hours;
  // 3. A Guard's repeated rows carry the shift's times and reference.
  const labels = monitorLaneLabels(site.lanes, site.timeZone, day);
  const extra = site.otherRuns.length;
  const extraByHour = monitorAdHocByHour(site.otherRuns);
  // Open on the current hour (with the hour before it in view), once per site and day — never on a refresh, so a
  // person's own scrolling is kept.
  const scroller = React.useRef<any>(null);
  const current = hours.findIndex((h) => h.current);
  React.useEffect(() => {
    if (current > 0) scroller.current?.scrollTo?.({ x: (current - 1) * cellSize, animated: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.siteId, site.range.from]);
  return (
    <View style={{ flexDirection: 'row', minWidth: 0 }} testID="patrol-monitor-grid">
      {/* The lane names stay put while the hours scroll. */}
      <View style={{ width: nameWidth, flexShrink: 0 }} testID="patrol-monitor-lane-names">
        <View style={[styles.headerCell, { height: HEADER_HEIGHT, alignItems: 'flex-start' }]}><Text style={styles.hourOffset}>Hour</Text></View>
        {site.lanes.map((lane) => {
          const label = labels.get(lane.key)!;
          return (
            <View key={lane.key} style={[styles.laneName, { height: rowHeight }]} accessibilityLabel={`${label.title}${label.sub ? `, ${label.sub}` : ''}`}>
              <Text style={[styles.laneTitle, lane.kind === 'site' ? { color: colors.primaryNavy } : null]} numberOfLines={1}>{label.title}</Text>
              {label.sub ? <Text style={styles.laneSub} numberOfLines={1}>{label.sub}</Text> : null}
            </View>
          );
        })}
        {extra ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${extraOpen ? 'Hide' : 'Show'} additional patrols (${extra})`}
            accessibilityState={{ expanded: extraOpen }}
            onPress={onToggleExtra}
            style={[styles.laneName, styles.extraName, { height: rowHeight }, WEB_PTR]}
            testID="patrol-monitor-additional-row"
          >
            <Text style={[styles.laneTitle, { color: colors.info }]} numberOfLines={1}>{extraOpen ? '▾' : '▸'} Additional patrols ({extra})</Text>
            <Text style={styles.laneSub} numberOfLines={1}>Not counted</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView ref={scroller} horizontal style={{ flex: 1, minWidth: 0 }} showsHorizontalScrollIndicator testID="patrol-monitor-hours">
        <View>
          <View style={{ flexDirection: 'row', height: HEADER_HEIGHT }}>
            {hours.map((h, i) => (
              <View key={h.index} style={[styles.headerCell, { width: cellSize }, h.current ? styles.currentHour : null]} accessibilityLabel={`${h.label}:00${h.repeated ? ` second time, ${h.offset}` : ''}`}>
                <Text style={[styles.hourLabel, h.current ? { color: colors.primaryNavy } : null]}>{monitorHourLabel(h)}</Text>
                {monitorHourOffsetShown(hours, i) || h.repeated ? <Text style={styles.hourOffset}>{h.offset}</Text> : null}
              </View>
            ))}
          </View>
          {site.lanes.map((lane) => {
            const byHour = new Map(lane.cells.map((cell) => [cell.hour, cell]));
            return (
              <View key={lane.key} style={{ flexDirection: 'row', height: rowHeight }}>
                {hours.map((h) => {
                  const cell = byHour.get(h.index) ?? { hour: h.index, state: 'none' as const, total: 0, owed: 0, verified: 0, windowKeys: [] };
                  return <MonitorCellView key={h.index} lane={lane} spoken={labels.get(lane.key)!.spoken} cell={cell} hour={h} size={cellSize} onOpen={onOpenCell} />;
                })}
              </View>
            );
          })}
          {extra ? (
            <View style={{ flexDirection: 'row', height: rowHeight }} testID="patrol-monitor-additional-hours">
              {hours.map((h) => {
                const n = extraByHour.get(h.index) ?? 0;
                return (
                  <View key={h.index} style={{ width: cellSize, height: rowHeight, padding: 2 }} accessibilityLabel={n ? `Additional patrols, ${h.label}:00: ${n}` : undefined}>
                    <View style={[styles.cell, n ? styles.extraCell : styles.extraEmpty]}>
                      {n ? <Text style={[styles.cellSymbol, { color: colors.info }]}>◇{n > 1 ? n : ''}</Text> : null}
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function MonitorCellView({ lane, spoken, cell, hour, size, onOpen }: { lane: PatrolMonitorLane; spoken: string; cell: PatrolMonitorCell; hour: PatrolMonitorHour; size: number; onOpen: (s: MonitorCellSelection) => void; key?: number }) {
  const info = monitorStateInfo(cell.state);
  const p = monitorPalette(info.tone);
  const count = monitorCellCount(cell);
  const label = monitorCellA11yLabel(spoken, hour, cell);
  const face = (
    <View style={[styles.cell, { backgroundColor: p.bg, borderColor: hour.current ? colors.primaryNavy : p.border }]}>
      {info.symbol ? <Text style={[styles.cellSymbol, { color: p.fg }]}>{info.symbol}</Text> : null}
      {count ? <Text style={[styles.cellCount, { color: p.fg }]}>{count}</Text> : null}
      {/* An ad-hoc patrol in this hour: marked (and listed in the detail), never counted. */}
      {cell.adHoc ? <Text style={styles.cellAdHoc} accessibilityElementsHidden>{'◇'}{cell.adHoc > 1 ? cell.adHoc : ''}</Text> : null}
    </View>
  );
  if (!monitorCellOpens(cell)) {
    return <View style={{ width: size, height: size + 4, padding: 2 }} accessibilityLabel={label}>{face}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onOpen({ lane, cell, hour })}
      style={[{ width: size, height: size + 4, padding: 2 }, WEB_PTR]}
    >
      {face}
    </Pressable>
  );
}

const HEADER_HEIGHT = 36;

const styles = {
  card: { backgroundColor: colors.card, borderRadius: radii.card, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' as const },
  head: { padding: spacing.md, gap: spacing.sm },
  headTop: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm, flexWrap: 'wrap' as const },
  chevron: { ...typography.panelHeading, color: colors.textSecondary, width: 16 },
  siteName: { ...typography.panelHeading, color: colors.textPrimary },
  status: { borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  statusText: { ...typography.caption, fontWeight: '700' as const },
  chips: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: spacing.xs },
  chip: { borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  chipText: { ...typography.caption, fontWeight: '600' as const },
  chipHint: { fontWeight: '400' as const },
  body: { borderTopWidth: 1, borderTopColor: colors.border, padding: spacing.md, gap: spacing.sm },
  headerCell: { alignItems: 'center' as const, justifyContent: 'flex-end' as const, paddingBottom: 2 },
  currentHour: { borderBottomWidth: 2, borderBottomColor: colors.primaryNavy },
  hourLabel: { ...typography.caption, fontWeight: '700' as const, color: colors.textSecondary },
  hourOffset: { fontSize: 9, color: colors.textMuted },
  laneName: { justifyContent: 'center' as const, paddingRight: spacing.sm },
  laneTitle: { ...typography.caption, fontWeight: '700' as const, color: colors.textPrimary },
  laneSub: { fontSize: 11, color: colors.textSecondary },
  cell: { flex: 1, borderWidth: 1, borderRadius: 6, alignItems: 'center' as const, justifyContent: 'center' as const },
  cellSymbol: { fontSize: 14, fontWeight: '700' as const, lineHeight: 16 },
  cellCount: { fontSize: 10, fontWeight: '700' as const, lineHeight: 12 },
  extraName: { borderTopWidth: 1, borderTopColor: colors.border },
  extraCell: { backgroundColor: colors.infoSurface, borderColor: colors.infoBorder, borderStyle: 'dashed' as const },
  extraEmpty: { backgroundColor: colors.card, borderColor: colors.surfaceSubtle },
  cellAdHoc: { position: 'absolute' as const, top: 1, right: 3, fontSize: 9, fontWeight: '700' as const, color: colors.info },
};
