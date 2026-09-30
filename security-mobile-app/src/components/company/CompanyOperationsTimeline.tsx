import * as React from 'react';
import { Fragment } from 'react/jsx-runtime';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  DEFAULT_TIMELINE_RANGE,
  TIMELINE_RANGES,
  axisFraction,
  buildTimeline,
  panTimelineWindow,
  resolveTimelineWindow,
  timelineHourTicks,
  timelineRowCount,
  type TimelineRangeHours,
  type TimelineRow,
  type TimelineShiftInput,
  type TimelineSiteGroup,
  type TimelineWindow,
  type WelfareMarker,
} from './operationsTimeline';
import { colors, radii } from '../../theme';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;

/**
 * The control-room Operations Timeline.
 *
 * WHAT IT REPLACES
 * A flat Current Operations table, read one shift at a time. It could not answer "who is on at 21:00
 * across my sites" and showed no Welfare history — only the current window's status word, with the rest
 * buried in per-shift cards further down the page.
 *
 * HOW IT IS BUILT
 * Every position, label and marker state comes from `operationsTimeline.ts`, which is pure and certified
 * (31 checks, 12 mutations). This component contains NO time arithmetic and NO Welfare logic: it turns
 * fractions into widths and draws them. That separation is why the geometry could be proven before any
 * pixel existed.
 *
 * THE LAYOUT
 * A sticky identity column carries site and guard identity — name, scheduled window, Book On / Book Off —
 * so the timeline itself never wastes horizontal space repeating them. The axis scrolls horizontally
 * under a sticky hour header. Both panes scroll vertically together as one page, which keeps a row's
 * identity beside its bar at all times.
 *
 * TIME STATE IS STATE, NOT SCROLL POSITION. Earlier / Now / Later and the range selector move a window of
 * INSTANTS; the horizontal scrollbar only moves the viewport within that window. Deriving time from pixel
 * offsets would make the NOW line and the markers disagree with the clock.
 */

const IDENTITY_WIDTH = 220;
/** Pixels per hour on the axis. 24h therefore scrolls rather than compressing into the viewport. */
const HOUR_WIDTH = 132;
const ROW_HEIGHT = 56;
const SITE_HEADER_HEIGHT = 32;

export type OperationsTimelineProps = {
  /** The already-filtered operational rows. One dataset drives the timeline, the counts and the export. */
  inputs: readonly TimelineShiftInput[];
  /** The operational clock from the existing 15-second refresh cycle. Never a clock of our own. */
  nowMs: number;
  /** The site zone used for the hour header. Per-row labels still use each row's own site zone. */
  headerTimeZone: string;
  /** Anchor for the visible window — the selected operational day, or now for today. */
  anchorMs: number;
  selectedShiftId: number | null;
  /** Set briefly when an Attention item targets a row, so it can flash into view. */
  highlightedShiftId: number | null;
  onSelectShift: (shiftId: number) => void;
  onExportCsv: () => void;
  onExportXlsx: () => void;
  exporting: boolean;
};

export function CompanyOperationsTimeline({
  inputs,
  nowMs,
  headerTimeZone,
  anchorMs,
  selectedShiftId,
  highlightedShiftId,
  onSelectShift,
  onExportCsv,
  onExportXlsx,
  exporting,
}: OperationsTimelineProps) {
  const [rangeHours, setRangeHours] = React.useState<TimelineRangeHours>(DEFAULT_TIMELINE_RANGE);
  /** Whole-hour pan offset. Time state lives here, never in a scroll position. */
  const [panHours, setPanHours] = React.useState(0);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [collapsedSites, setCollapsedSites] = React.useState<Record<string, boolean>>({});

  // Changing the range or the day re-centres, because a pan measured against the old window means
  // nothing against the new one.
  React.useEffect(() => { setPanHours(0); }, [rangeHours, anchorMs]);

  const window: TimelineWindow = React.useMemo(
    () => panTimelineWindow(resolveTimelineWindow(anchorMs, rangeHours, headerTimeZone), panHours),
    [anchorMs, rangeHours, headerTimeZone, panHours],
  );

  const groups = React.useMemo(() => buildTimeline(inputs, window, nowMs), [inputs, window, nowMs]);
  const rowCount = timelineRowCount(groups);
  const ticks = React.useMemo(() => timelineHourTicks(window, headerTimeZone), [window, headerTimeZone]);
  const axisWidth = rangeHours * HOUR_WIDTH;

  // Null when the controller has panned away from now. The foundation refuses to clamp, so the line is
  // simply absent rather than lying about where now is.
  const nowFraction = axisFraction(nowMs, window);

  const zonesInView = React.useMemo(
    () => Array.from(new Set(groups.map((group) => group.timeZone))),
    [groups],
  );

  return (
    <View style={styles.root}>
      {/* ── Header: identity, time navigation, range, export ─────────────── */}
      <View style={styles.headerRow}>
        <View style={styles.headerTitleBlock}>
          <Text style={styles.headerTitle}>Operations Timeline</Text>
          <Text style={styles.headerCount}>
            {rowCount} shift{rowCount === 1 ? '' : 's'}
            {zonesInView.length > 1 ? ' · mixed site timezones' : ''}
          </Text>
        </View>

        <View style={styles.headerControls}>
          <View style={styles.panGroup}>
            <TimelineButton label="Earlier" onPress={() => setPanHours((h) => h - rangeHours / 2)} />
            <TimelineButton label="Now" onPress={() => setPanHours(0)} active={panHours === 0} />
            <TimelineButton label="Later" onPress={() => setPanHours((h) => h + rangeHours / 2)} />
          </View>

          <View style={styles.rangeGroup}>
            {TIMELINE_RANGES.map((hours) => (
              <Pressable
                key={hours}
                accessibilityRole="button"
                accessibilityLabel={`Show ${hours} hours`}
                accessibilityState={{ selected: rangeHours === hours }}
                style={[styles.rangeBtn, rangeHours === hours ? styles.rangeBtnActive : null, IS_WEB ? (WEB_PTR as any) : null]}
                onPress={() => setRangeHours(hours)}
              >
                <Text style={[styles.rangeBtnText, rangeHours === hours ? styles.rangeBtnTextActive : null]}>
                  {hours}h
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.exportWrap}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Export operations report"
              style={[styles.exportBtn, IS_WEB ? (WEB_PTR as any) : null]}
              onPress={() => setExportOpen((open) => !open)}
              disabled={exporting}
            >
              <Text style={styles.exportBtnText}>{exporting ? 'Preparing...' : 'Export ▾'}</Text>
            </Pressable>
            {exportOpen && !exporting ? (
              <View style={styles.exportMenu}>
                <Pressable
                  accessibilityRole="button"
                  style={[styles.exportItem, IS_WEB ? (WEB_PTR as any) : null]}
                  onPress={() => { setExportOpen(false); onExportXlsx(); }}
                >
                  <Text style={styles.exportItemText}>Excel (.xlsx)</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  style={[styles.exportItem, IS_WEB ? (WEB_PTR as any) : null]}
                  onPress={() => { setExportOpen(false); onExportCsv(); }}
                >
                  <Text style={styles.exportItemText}>CSV (.csv)</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </View>
      </View>

      {rowCount === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No live or scheduled operations for this view.</Text>
          <Text style={styles.emptyDesc}>
            Attention Now may still hold unresolved alerts. Past shifts remain in Rota Planner and Coverage.
          </Text>
        </View>
      ) : (
        <View style={styles.grid}>
          {/* ── Sticky identity column ──────────────────────────────────── */}
          <View style={styles.identityColumn}>
            <View style={[styles.identityCell, styles.axisHeader]}>
              <Text style={styles.identityHeaderText}>SITE / GUARD</Text>
            </View>
            {groups.map((group) => (
              <Fragment key={`identity-${group.siteId ?? group.siteName}`}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${group.siteName}, ${group.rows.length} shifts`}
                  style={[styles.siteHeader, IS_WEB ? (WEB_PTR as any) : null]}
                  onPress={() =>
                    setCollapsedSites((prev) => ({
                      ...prev,
                      [siteKey(group)]: !prev[siteKey(group)],
                    }))
                  }
                >
                  <Text style={styles.siteHeaderText} numberOfLines={1}>
                    {collapsedSites[siteKey(group)] ? '▸' : '▾'} {group.siteName}
                  </Text>
                </Pressable>
                {collapsedSites[siteKey(group)]
                  ? null
                  : group.rows.map((row) => (
                      <Pressable
                        key={`identity-row-${row.shiftId}`}
                        accessibilityRole="button"
                        accessibilityLabel={identityLabel(row)}
                        style={[
                          styles.identityCell,
                          selectedShiftId === row.shiftId ? styles.rowSelected : null,
                          highlightedShiftId === row.shiftId ? styles.rowHighlighted : null,
                          IS_WEB ? (WEB_PTR as any) : null,
                        ]}
                        onPress={() => onSelectShift(row.shiftId)}
                      >
                        <Text style={styles.identityGuard} numberOfLines={1}>{row.guardName}</Text>
                        <Text style={styles.identityScheduled} numberOfLines={1}>
                          {row.scheduled}{row.overnight ? ' (+1)' : ''}
                        </Text>
                        <Text
                          style={[styles.identityAttendance, row.attendance.late ? styles.identityLate : null]}
                          numberOfLines={1}
                        >
                          {row.attendance.bookOn} · {row.attendance.bookOff}
                        </Text>
                      </Pressable>
                    ))}
              </Fragment>
            ))}
          </View>

          {/* ── Scrolling time axis ─────────────────────────────────────── */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator
            style={styles.axisScroll}
            contentContainerStyle={{ width: axisWidth }}
          >
            <View style={{ width: axisWidth }}>
              {/* Sticky hour header */}
              <View style={[styles.axisHeader, styles.axisHeaderRow]}>
                {ticks.map((tick) => (
                  <View key={tick.ms} style={[styles.tick, { left: tick.fraction * axisWidth }]}>
                    <Text style={styles.tickLabel}>{tick.label}</Text>
                  </View>
                ))}
              </View>

              <View style={styles.axisBody}>
                {/* Hour gridlines, behind everything */}
                {ticks.map((tick) => (
                  <View key={`line-${tick.ms}`} style={[styles.gridLine, { left: tick.fraction * axisWidth }]} />
                ))}

                {/* NOW line. Absent — not clamped — when panned away from now. */}
                {nowFraction !== null ? (
                  <View
                    accessibilityLabel="Current time"
                    style={[styles.nowLine, { left: nowFraction * axisWidth }]}
                  >
                    <View style={styles.nowFlag}><Text style={styles.nowFlagText}>NOW</Text></View>
                  </View>
                ) : null}

                {groups.map((group) => (
                  <Fragment key={`axis-${group.siteId ?? group.siteName}`}>
                    <View style={styles.siteHeaderSpacer} />
                    {collapsedSites[siteKey(group)]
                      ? null
                      : group.rows.map((row) => (
                          <Pressable
                            key={`axis-row-${row.shiftId}`}
                            accessibilityRole="button"
                            accessibilityLabel={identityLabel(row)}
                            style={[
                              styles.axisRow,
                              selectedShiftId === row.shiftId ? styles.rowSelected : null,
                              highlightedShiftId === row.shiftId ? styles.rowHighlighted : null,
                              IS_WEB ? (WEB_PTR as any) : null,
                            ]}
                            onPress={() => onSelectShift(row.shiftId)}
                          >
                            <ShiftBar row={row} axisWidth={axisWidth} />
                          </Pressable>
                        ))}
                  </Fragment>
                ))}
              </View>
            </View>
          </ScrollView>
        </View>
      )}

      {/* ── Legend. Never colour alone: the glyphs are named. ───────────── */}
      {rowCount > 0 ? (
        <View style={styles.legend}>
          <Text style={styles.legendTitle}>Welfare Check</Text>
          {([
            ['✓', 'Completed'],
            ['●', 'Due'],
            ['!', 'Overdue'],
            ['✕', 'Missed'],
            ['—', 'Not required'],
          ] as const).map(([glyph, word]) => (
            <Text key={word} style={styles.legendItem}>{glyph} {word}</Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const siteKey = (group: TimelineSiteGroup) => String(group.siteId ?? group.siteName);

/** One sentence carrying everything the row shows, for a screen reader and the row tooltip. */
function identityLabel(row: TimelineRow): string {
  return `${row.guardName}, scheduled ${row.scheduled}, ${row.status}, ${row.attendance.bookOn}, ${row.attendance.bookOff}`;
}

// ─── the bar ──────────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<TimelineRow['status'], { bar: any; text: any }> = {
  Live: { bar: { backgroundColor: colors.successSurface, borderColor: colors.success }, text: { color: colors.success } },
  Late: { bar: { backgroundColor: colors.warningSurface, borderColor: colors.warning }, text: { color: colors.warning } },
  Upcoming: { bar: { backgroundColor: colors.surfaceSubtle, borderColor: colors.border }, text: { color: colors.textSecondary } },
  Completed: { bar: { backgroundColor: colors.surfaceSubtle, borderColor: colors.fieldBorder }, text: { color: colors.textSecondary } },
  'Coverage Gap': { bar: { backgroundColor: colors.dangerSurface, borderColor: colors.danger }, text: { color: colors.danger } },
};

function ShiftBar({ row, axisWidth }: { row: TimelineRow; axisWidth: number }) {
  const tone = STATUS_STYLE[row.status] ?? STATUS_STYLE.Upcoming;
  const left = row.span.startFraction * axisWidth;
  const width = Math.max(row.span.widthFraction * axisWidth, 6);

  return (
    <View
      style={[
        styles.bar,
        tone.bar,
        {
          left,
          width,
          // A clipped edge is squared off, so a bar that continues past the view does not read as if it
          // ended there.
          borderTopLeftRadius: row.span.clippedStart ? 0 : radii.sm,
          borderBottomLeftRadius: row.span.clippedStart ? 0 : radii.sm,
          borderTopRightRadius: row.span.clippedEnd ? 0 : radii.sm,
          borderBottomRightRadius: row.span.clippedEnd ? 0 : radii.sm,
        },
      ]}
    >
      <View style={styles.barLabelRow}>
        {row.span.clippedStart ? <Text style={styles.clipCue}>‹</Text> : null}
        <Text style={[styles.barStatus, tone.text]} numberOfLines={1}>{row.status}</Text>
        {row.span.clippedEnd ? <Text style={styles.clipCue}>›</Text> : null}
      </View>

      {/* Welfare markers sit along the bar, positioned by the foundation. */}
      <View style={styles.markerStrip} pointerEvents="box-none">
        {row.welfare.map((marker) => (
          <WelfareMarkerDot key={`${row.shiftId}-${marker.index}`} marker={marker} axisWidth={axisWidth} left={left} />
        ))}
      </View>
    </View>
  );
}

const MARKER_TONE: Record<WelfareMarker['state'], any> = {
  completed: { color: colors.success },
  due: { color: colors.textSecondary },
  overdue: { color: colors.warning },
  missed: { color: colors.danger },
  not_applicable: { color: colors.disabledText },
};

function WelfareMarkerDot({
  marker,
  axisWidth,
  left: barLeft,
}: {
  key?: string | number;
  marker: WelfareMarker;
  axisWidth: number;
  left: number;
}) {
  // Positioned against the axis, then offset into the bar's own coordinate space.
  const absolute = marker.span.startFraction * axisWidth;
  const width = Math.max(marker.span.widthFraction * axisWidth, 10);

  return (
    <View
      // `title` is what produces a native tooltip on web; the accessibility label covers native.
      {...(IS_WEB ? ({ title: marker.accessibleLabel } as any) : null)}
      accessibilityLabel={marker.accessibleLabel}
      style={[styles.marker, { left: absolute - barLeft, width }]}
    >
      <Text style={[styles.markerGlyph, MARKER_TONE[marker.state]]}>{marker.glyph}</Text>
    </View>
  );
}

function TimelineButton({ label, onPress, active }: { label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      style={[styles.panBtn, active ? styles.panBtnActive : null, IS_WEB ? (WEB_PTR as any) : null]}
      onPress={onPress}
    >
      <Text style={[styles.panBtnText, active ? styles.panBtnTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSubtle,
    flexWrap: 'wrap',
  },
  headerTitleBlock: { gap: 2 },
  headerTitle: { fontSize: 14, fontWeight: '800', color: colors.textPrimary, letterSpacing: 0.3 },
  headerCount: { fontSize: 11, color: colors.textSecondary, fontWeight: '600' },
  headerControls: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },

  panGroup: { flexDirection: 'row', gap: 4 },
  panBtn: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: radii.sm,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
  },
  panBtnActive: { borderColor: colors.accentTeal, backgroundColor: colors.card },
  panBtnText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  panBtnTextActive: { color: colors.accentTeal },

  rangeGroup: {
    flexDirection: 'row',
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, overflow: 'hidden',
  },
  rangeBtn: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.card },
  rangeBtnActive: { backgroundColor: colors.primaryNavy },
  rangeBtnText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  rangeBtnTextActive: { color: colors.textOnBrand },

  exportWrap: { position: 'relative' },
  exportBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: radii.sm,
    backgroundColor: colors.primaryNavy,
  },
  exportBtnText: { fontSize: 11, fontWeight: '800', color: colors.textOnBrand },
  exportMenu: {
    position: 'absolute', top: 32, right: 0, zIndex: 40, elevation: 8,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.sm, minWidth: 150, overflow: 'hidden',
  },
  exportItem: { paddingHorizontal: 12, paddingVertical: 9 },
  exportItemText: { fontSize: 12, color: colors.textPrimary, fontWeight: '600' },

  empty: { padding: 28, alignItems: 'center', gap: 6 },
  emptyTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, textAlign: 'center' },
  emptyDesc: { fontSize: 12, color: colors.textSecondary, textAlign: 'center', maxWidth: 460 },

  grid: { flexDirection: 'row' },

  identityColumn: {
    width: IDENTITY_WIDTH,
    borderRightWidth: 1,
    borderRightColor: colors.fieldBorder,
    backgroundColor: colors.card,
    // The identity column is a sibling of the horizontal ScrollView, so it simply never scrolls with it.
    zIndex: 2,
  },
  identityHeaderText: { fontSize: 10, fontWeight: '800', color: colors.textSecondary, letterSpacing: 0.8 },
  identityCell: {
    height: ROW_HEIGHT,
    paddingHorizontal: 10,
    justifyContent: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 1,
  },
  identityGuard: { fontSize: 12, fontWeight: '700', color: colors.textPrimary },
  identityScheduled: { fontSize: 11, color: colors.textSecondary, fontWeight: '600' },
  identityAttendance: { fontSize: 10, color: colors.textSecondary },
  identityLate: { color: colors.warning, fontWeight: '700' },

  siteHeader: {
    height: SITE_HEADER_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: 10,
    backgroundColor: colors.primaryNavySoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.fieldBorder,
  },
  siteHeaderText: { fontSize: 11, fontWeight: '800', color: colors.textOnBrand, letterSpacing: 0.5 },
  siteHeaderSpacer: {
    height: SITE_HEADER_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: colors.fieldBorder,
    backgroundColor: colors.primaryNavySoft,
  },

  axisScroll: { flex: 1 },
  axisHeader: {
    height: 30,
    justifyContent: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.fieldBorder,
    backgroundColor: colors.surfaceSubtle,
    paddingHorizontal: 10,
  },
  axisHeaderRow: { position: 'relative', paddingHorizontal: 0 },
  tick: { position: 'absolute', top: 8, paddingLeft: 4 },
  tickLabel: { fontSize: 10, fontWeight: '700', color: colors.textSecondary },

  axisBody: { position: 'relative' },
  gridLine: {
    position: 'absolute', top: 0, bottom: 0, width: 1,
    backgroundColor: colors.border,
  },
  nowLine: {
    position: 'absolute', top: 0, bottom: 0, width: 2,
    backgroundColor: colors.danger, zIndex: 6,
  },
  nowFlag: {
    position: 'absolute', top: 0, left: 0,
    backgroundColor: colors.danger,
    paddingHorizontal: 4, paddingVertical: 1,
    borderBottomRightRadius: radii.sm,
  },
  nowFlagText: { fontSize: 9, fontWeight: '800', color: colors.textOnBrand, letterSpacing: 0.5 },

  axisRow: {
    height: ROW_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    justifyContent: 'center',
    position: 'relative',
  },
  rowSelected: { backgroundColor: colors.infoSurface },
  rowHighlighted: { backgroundColor: colors.warningSurface },

  bar: {
    position: 'absolute',
    top: 8,
    height: ROW_HEIGHT - 18,
    borderWidth: 1,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  barLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 6 },
  barStatus: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  clipCue: { fontSize: 10, fontWeight: '800', color: colors.textSecondary },

  markerStrip: { position: 'absolute', left: 0, right: 0, bottom: 2, height: 14 },
  marker: { position: 'absolute', alignItems: 'center', justifyContent: 'center', height: 14 },
  markerGlyph: { fontSize: 11, fontWeight: '800', lineHeight: 13 },

  legend: {
    flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surfaceSubtle,
  },
  legendTitle: { fontSize: 10, fontWeight: '800', color: colors.textSecondary, letterSpacing: 0.6 },
  legendItem: { fontSize: 10, color: colors.textSecondary, fontWeight: '600' },
});
