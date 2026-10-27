import * as React from 'react';
import { Fragment } from 'react/jsx-runtime';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  DEFAULT_TIMELINE_RANGE,
  TIMELINE_RANGES,
  axisFraction,
  buildTimeline,
  nowScrollOffset,
  panTimelineWindow,
  resolveTimelineWindow,
  timelineFollowAnchor,
  timelineFollowReducer,
  INITIAL_TIMELINE_FOLLOW,
  timelineHourTicks,
  timelineRowCount,
  WELFARE_MARKER_GLYPH,
  WELFARE_MARKER_WORD,
  type TimelineRangeHours,
  type TimelineRow,
  type TimelineShiftInput,
  type TimelineSiteGroup,
  type TimelineWindow,
  type WelfareMarker,
} from './operationsTimeline';
import { colors, radii } from '../../theme';
import { NO_BOOK_ON_OVERDUE_LABEL, formatOverdueMinutes } from './noBookOnOverdue';

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
/**
 * The NARROWEST an hour may be drawn. The axis takes any width the card gives it beyond that, so a wide
 * desktop spreads the hours out instead of leaving dead grid to the right; a narrow one keeps the hours
 * legible and scrolls. 24h therefore still scrolls rather than compressing into the viewport.
 */
const HOUR_WIDTH = 132;
/** Everything on the axis is placed by its fraction of the window, so the axis can be any width. */
const pct = (fraction: number) => `${fraction * 100}%` as `${number}%`;
const ROW_HEIGHT = 56;
/** The Welfare marker's hit area and chip diameter. Big enough to find, small enough to stay a marker. */
const MARKER_SIZE = 16;
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
  /** Range the axis opens on. The controller still changes it from the header; this only seeds it. */
  initialRangeHours?: TimelineRangeHours;
  onSelectShift: (shiftId: number) => void;
  onExportCsv: () => void;
  onExportXlsx: () => void;
  exporting: boolean;
  /** The shifts or attendance behind these rows failed to load: an empty view is then not "nothing on". */
  unavailable?: boolean;
  /** Bumped by the page's Today button: re-centre on now exactly as the timeline's own "Now" does. */
  recentreSignal?: number;
  /**
   * Which day the axis shows ('live', 'today' or the YYYY-MM-DD picked). A change here is a new view and
   * re-centres; the anchor itself also moves with the clock, which must NOT (follow mode, Welfare Phase 3).
   */
  anchorKey?: string;
  /** Opens the server-built Shift Attendance / Welfare Monitoring report dialog (Welfare Phase 3). */
  onOpenReport?: (kind: 'shift-attendance' | 'welfare-monitoring') => void;
};

export function CompanyOperationsTimeline({
  inputs,
  nowMs,
  headerTimeZone,
  anchorMs,
  selectedShiftId,
  highlightedShiftId,
  initialRangeHours,
  onSelectShift,
  onExportCsv,
  onExportXlsx,
  exporting,
  unavailable = false,
  recentreSignal = 0,
  anchorKey,
  onOpenReport,
}: OperationsTimelineProps) {
  const [rangeHours, setRangeHours] = React.useState<TimelineRangeHours>(
    initialRangeHours ?? DEFAULT_TIMELINE_RANGE,
  );
  /** Follow mode and the whole-hour pan. Time state lives here, never in a scroll position. */
  const [follow, setFollow] = React.useState(INITIAL_TIMELINE_FOLLOW);
  const dispatchFollow = React.useCallback(
    (event: Parameters<typeof timelineFollowReducer>[1]) => setFollow((state) => timelineFollowReducer(state, event)),
    [],
  );
  const panHours = follow.panHours;
  const effectiveAnchorMs = timelineFollowAnchor(follow, anchorMs);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [collapsedSites, setCollapsedSites] = React.useState<Record<string, boolean>>({});

  // A different day is a new view: follow again, centred on it. The anchor moving with the clock is not a new
  // view — that was what pulled a controller back to now every 15 seconds. Skipped on mount.
  const viewKey = anchorKey ?? 'live';
  const firstView = React.useRef(true);
  React.useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    dispatchFollow({ type: 'view-changed' });
  }, [viewKey]);
  const firstRange = React.useRef(true);
  React.useEffect(() => {
    if (firstRange.current) { firstRange.current = false; return; }
    dispatchFollow({ type: 'range-changed' });
  }, [rangeHours]);

  /**
   * The horizontal viewport, measured rather than assumed.
   *
   * At 24h the axis is wider than any screen, so where the viewport OPENS matters: scrolled to the left
   * it shows lunchtime while the work is at 21:00, and the board looks empty. These two measurements let
   * the effect below put NOW in shot. Neither is time state — the window of instants is untouched.
   */
  const axisScrollRef = React.useRef<InstanceType<typeof ScrollView> | null>(null);
  const [axisViewportWidth, setAxisViewportWidth] = React.useState(0);
  const [axisContentWidth, setAxisContentWidth] = React.useState(0);
  /** Bumped by "Now" so pressing it re-centres the viewport even when the window did not move. */
  const [recentreToken, setRecentreToken] = React.useState(0);
  const recentreOnNow = React.useCallback(() => {
    dispatchFollow({ type: 'now' });
    setRecentreToken((t) => t + 1);
  }, []);
  /**
   * Telling the controller's scroll from ours. The code scrolls the axis when it centres on now, and the
   * browser scrolls it by itself when the axis is resized (a range change clamps the offset) — neither comes
   * with any input. So a scroll pauses following only when it follows the controller's own input on the
   * axis: a wheel, a pointer (the scrollbar included), a touch or a key on web; a drag on native.
   */
  const USER_INTENT_MS = 1500;
  const userIntentUntil = React.useRef(0);
  React.useEffect(() => {
    if (!IS_WEB || typeof document === 'undefined') return undefined;
    const node = document.getElementById('operations-timeline-axis');
    if (!node) return undefined;
    const mark = () => { userIntentUntil.current = Date.now() + USER_INTENT_MS; };
    const events = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
    events.forEach((name) => node.addEventListener(name, mark, { passive: true }));
    return () => events.forEach((name) => node.removeEventListener(name, mark));
    // Re-attached when the axis appears: it is not rendered while the board is empty.
  }, [axisViewportWidth > 0]);
  const pauseForController = React.useCallback(() => {
    if (follow.following) dispatchFollow({ type: 'manual-scroll', anchorMs });
  }, [follow.following, anchorMs, dispatchFollow]);
  const onAxisScroll = React.useCallback(() => {
    if (Date.now() > userIntentUntil.current) return;
    pauseForController();
  }, [pauseForController]);
  // Today, from the page: the same action as "Now". Skipped on mount so opening the page does not scroll.
  React.useEffect(() => {
    if (recentreSignal > 0) recentreOnNow();
  }, [recentreSignal, recentreOnNow]);

  const window: TimelineWindow = React.useMemo(
    () => panTimelineWindow(resolveTimelineWindow(effectiveAnchorMs, rangeHours, headerTimeZone), panHours),
    [effectiveAnchorMs, rangeHours, headerTimeZone, panHours],
  );

  const groups = React.useMemo(() => buildTimeline(inputs, window, nowMs), [inputs, window, nowMs]);
  const rowCount = timelineRowCount(groups);
  const ticks = React.useMemo(() => timelineHourTicks(window, headerTimeZone), [window, headerTimeZone]);
  const axisMinWidth = rangeHours * HOUR_WIDTH;

  // Null when the controller has panned away from now. The foundation refuses to clamp, so the line is
  // simply absent rather than lying about where now is.
  const nowFraction = axisFraction(nowMs, window);

  /**
   * Re-position the viewport around NOW.
   *
   * Read through a ref, deliberately: `nowFraction` changes on every 15-second tick, and an effect that
   * depended on it would yank the axis back from wherever the controller had scrolled it. It runs when
   * the range, the day, the pan or the measured widths change — and when "Now" is pressed.
   */
  const nowFractionRef = React.useRef(nowFraction);
  nowFractionRef.current = nowFraction;

  React.useEffect(() => {
    // Only the long ranges open centred. At 8h the axis starts where the window starts, which is where a
    // bar's status badge is drawn — auto-scrolling the default view would push "LIVE", "LATE" and
    // "COMPLETED" off the left edge of every shift that began earlier. 12h and 24h are wide enough that
    // the opposite problem wins: without this the controller is shown lunchtime while the work is at 21:00.
    // Pressing "Now" always re-centres, because then it is what the controller asked for.
    // Paused, nothing moves the viewport: the controller is looking at something (follow mode).
    if (!follow.following) return;
    if (rangeHours <= DEFAULT_TIMELINE_RANGE && recentreToken === 0) return;
    const offset = nowScrollOffset(nowFractionRef.current, axisContentWidth, axisViewportWidth);
    axisScrollRef.current?.scrollTo({ x: offset, y: 0, animated: false });
  }, [rangeHours, effectiveAnchorMs, follow.following, panHours, axisContentWidth, axisViewportWidth, recentreToken]);

  const zonesInView = React.useMemo(
    () => Array.from(new Set(groups.map((group) => group.timeZone))),
    [groups],
  );

  return (
    // While the Export menu is open the card stops clipping, and the header sits above the grid, so the whole
    // menu is drawn over the rows instead of under them (Welfare Phase 3: the menu grew from two items to four).
    <View style={[styles.root, exportOpen ? styles.rootMenuOpen : null]}>
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
            <TimelineButton label="Earlier" onPress={() => dispatchFollow({ type: 'pan', deltaHours: -rangeHours / 2, anchorMs })} />
            <TimelineButton
              label="Now"
              onPress={recentreOnNow}
              active={follow.following && panHours === 0}
            />
            <TimelineButton label="Later" onPress={() => dispatchFollow({ type: 'pan', deltaHours: rangeHours / 2, anchorMs })} />
          </View>
          {follow.following ? null : (
            <Text style={styles.pausedHint} accessibilityLiveRegion="polite">Paused · press Now to follow</Text>
          )}

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
                {onOpenReport ? (
                  <>
                    <Text style={styles.exportSection}>Reports from S4 records</Text>
                    <Pressable
                      accessibilityRole="button"
                      style={[styles.exportItem, IS_WEB ? (WEB_PTR as any) : null]}
                      onPress={() => { setExportOpen(false); onOpenReport('shift-attendance'); }}
                    >
                      <Text style={styles.exportItemText}>Shift Attendance report…</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      style={[styles.exportItem, IS_WEB ? (WEB_PTR as any) : null]}
                      onPress={() => { setExportOpen(false); onOpenReport('welfare-monitoring'); }}
                    >
                      <Text style={styles.exportItemText}>Welfare Monitoring report…</Text>
                    </Pressable>
                  </>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      </View>

      {rowCount === 0 && unavailable ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Live operations could not be loaded.</Text>
          <Text style={styles.emptyDesc}>
            S4 cannot show what is in progress right now. Use Refresh; Book On, Book Off and alert actions still work.
          </Text>
        </View>
      ) : rowCount === 0 ? (
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
                        {/* Actual attendance is the line a controller scans for, so Book On carries the
                            weight and Book Off sits behind it. A missing Book On past the start is the
                            one thing on this row that must catch the eye. */}
                        <Text style={styles.identityAttendance} numberOfLines={1}>
                          <Text style={row.attendance.late ? styles.identityLate : styles.identityOn}>
                            {/* Ready, no Book On, 15+ minutes past start: a warning only — nothing marks it missed. */}
                            {row.noBookOnOverdueMinutes != null
                              ? `${NO_BOOK_ON_OVERDUE_LABEL} ${formatOverdueMinutes(row.noBookOnOverdueMinutes)}`
                              : row.attendance.bookOn}
                          </Text>
                          <Text style={styles.identitySep}>{'  ·  '}</Text>
                          <Text style={styles.identityOff}>{row.attendance.bookOff}</Text>
                        </Text>
                      </Pressable>
                    ))}
              </Fragment>
            ))}
          </View>

          {/* ── Scrolling time axis ─────────────────────────────────────── */}
          <ScrollView
            ref={axisScrollRef}
            horizontal
            showsHorizontalScrollIndicator
            // A stable handle on the scrolling axis for the visual-review preview and for end-to-end
            // tests, which otherwise have to guess which div is the viewport.
            nativeID="operations-timeline-axis"
            style={styles.axisScroll}
            contentContainerStyle={{ minWidth: axisMinWidth, flexGrow: 1 }}
            onLayout={(e: any) => setAxisViewportWidth(e.nativeEvent.layout.width)}
            onContentSizeChange={(w: number) => setAxisContentWidth(w)}
            onScroll={onAxisScroll}
            onScrollBeginDrag={pauseForController}
            scrollEventThrottle={100}
          >
            <View style={{ minWidth: axisMinWidth, flexGrow: 1 }}>
              {/* Sticky hour header */}
              <View style={[styles.axisHeader, styles.axisHeaderRow]}>
                {ticks.map((tick) => (
                  <View key={tick.ms} style={[styles.tick, { left: pct(tick.fraction) }]}>
                    <Text style={styles.tickLabel}>{tick.label}</Text>
                  </View>
                ))}
              </View>

              <View style={styles.axisBody}>
                {/* Hour gridlines, behind everything */}
                {ticks.map((tick) => (
                  <View key={`line-${tick.ms}`} style={[styles.gridLine, { left: pct(tick.fraction) }]} />
                ))}

                {/* NOW line. Absent — not clamped — when panned away from now. */}
                {nowFraction !== null ? (
                  <View
                    accessibilityLabel="Current time"
                    style={[styles.nowLine, { left: pct(nowFraction) }]}
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
                            <ShiftBar row={row} />
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
          {/* The key is drawn with the SAME treatment as the bar, chips included, so it explains what is
              actually on screen rather than a simplified version of it. */}
          {(['upcoming', 'due', 'overdue', 'completed', 'missed', 'ended_at_book_off', 'not_applicable'] as const).map((state) => (
            <View key={state} style={styles.legendEntry}>
              <View style={[styles.markerChip, MARKER_TONE[state].chip ?? null]}>
                <Text style={[styles.markerGlyph, MARKER_TONE[state].glyph]}>
                  {WELFARE_MARKER_GLYPH[state]}
                </Text>
              </View>
              <Text style={styles.legendItem}>{WELFARE_MARKER_WORD[state]}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const siteKey = (group: TimelineSiteGroup) => String(group.siteId ?? group.siteName);

/** One sentence carrying everything the row shows, for a screen reader and the row tooltip. */
function identityLabel(row: TimelineRow): string {
  const status = row.status === 'Closed by Control' ? 'Closed by Control — No Book Off'
    : row.status === 'Completed' && row.attendance.bookOff === 'Book Off missing' ? 'Completed — Book Off missing'
    : row.status;
  const ended = row.span.endedBeforeWindow ? ', ended before this view' : '';
  return `${row.guardName}, scheduled ${row.scheduled}, ${status}${ended}, ${row.attendance.bookOn}, ${row.attendance.bookOff}`;
}

// ─── the bar ──────────────────────────────────────────────────────────────────

/**
 * How each status is drawn.
 *
 * LIVE IS NOT GREEN. A green bar reads as "all good", and a live shift with an overdue and a missed
 * Welfare Check is not all good — the old treatment painted the worst row on the board in the most
 * reassuring colour available. Live is now a neutral surface with a teal edge and a solid LIVE badge: it
 * says "this is running", which is the only thing the bar itself knows. Welfare condition is left
 * entirely to the markers, which is where it is actually measured.
 *
 * Late, Coverage Gap and Completed stay distinct, because each of those IS a verdict about the shift.
 */
const STATUS_STYLE: Record<TimelineRow['status'], { bar: any; badge: any; badgeText: any }> = {
  Live: {
    bar: {
      backgroundColor: colors.card,
      borderColor: colors.fieldBorder,
      borderLeftWidth: 3,
      borderLeftColor: colors.accentTeal,
    },
    badge: { backgroundColor: colors.primaryNavy },
    badgeText: { color: colors.textOnBrand },
  },
  Late: {
    bar: { backgroundColor: colors.warningSurface, borderColor: colors.warning },
    badge: { backgroundColor: colors.warning },
    badgeText: { color: colors.textOnBrand },
  },
  // Amber like Late: an operational exception to chase, not a welfare breach.
  'No Book Off': {
    bar: { backgroundColor: colors.warningSurface, borderColor: colors.warning, borderStyle: 'dashed' },
    badge: { backgroundColor: colors.warning },
    badgeText: { color: colors.textOnBrand },
  },
  // Awaiting reconciliation: the bar stops at the scheduled end, with a solid amber edge so it is not
  // mistaken for a completed shift.
  'Missing Book Off': {
    bar: { backgroundColor: colors.warningSurface, borderColor: colors.warning, borderLeftWidth: 3, borderLeftColor: colors.warning },
    badge: { backgroundColor: colors.warning },
    badgeText: { color: colors.textOnBrand },
  },
  Upcoming: {
    bar: { backgroundColor: colors.card, borderColor: colors.border, borderStyle: 'dashed' },
    badge: { backgroundColor: colors.surfaceSubtle, borderWidth: 1, borderColor: colors.border },
    badgeText: { color: colors.textSecondary },
  },
  Completed: {
    bar: { backgroundColor: colors.surfaceSubtle, borderColor: colors.fieldBorder },
    // A lighter chip with darker type: the grey-on-grey it replaced was the least legible thing on the
    // board, and a finished shift still has to be readable when a controller is reconstructing a day.
    badge: { backgroundColor: colors.border },
    badgeText: { color: colors.textPrimary },
  },
  // Phase 4: closed by Control without a Book Off. Settled like Completed, with an amber edge so it is never
  // read as an ordinary Book Off.
  'Closed by Control': {
    bar: { backgroundColor: colors.surfaceSubtle, borderColor: colors.fieldBorder, borderLeftWidth: 3, borderLeftColor: colors.warning },
    badge: { backgroundColor: colors.border },
    badgeText: { color: colors.textPrimary },
  },
  // Welfare Phase 4: booked off more than 15 minutes early. Settled, with an amber edge and a dashed outline so
  // the scheduled time after the Book Off never reads as worked; the badge names it.
  'Booked Off Early': {
    bar: { backgroundColor: colors.surfaceSubtle, borderColor: colors.warning, borderStyle: 'dashed', borderLeftWidth: 3, borderLeftColor: colors.warning },
    badge: { backgroundColor: colors.warning },
    badgeText: { color: colors.textOnBrand },
  },
  'Coverage Gap': {
    bar: { backgroundColor: colors.dangerSurface, borderColor: colors.danger },
    badge: { backgroundColor: colors.danger },
    badgeText: { color: colors.textOnBrand },
  },
};

/**
 * An overdue Book Off whose visible bar is too short to hold its badge — or that ended before this view
 * entirely — has its badge drawn BESIDE the bar. The bar itself is never widened past the scheduled end.
 */
const OVERDUE_BADGE_OUTSIDE_BELOW = 0.12;
function badgeOutside(row: TimelineRow): boolean {
  if (row.status !== 'No Book Off' && row.status !== 'Missing Book Off') return false;
  return Boolean(row.span.endedBeforeWindow) || row.span.widthFraction < OVERDUE_BADGE_OUTSIDE_BELOW;
}

function ShiftBar({ row }: { row: TimelineRow }) {
  const tone = STATUS_STYLE[row.status] ?? STATUS_STYLE.Upcoming;
  const outside = badgeOutside(row);
  const badge = (
    <View style={styles.barLabelRow}>
      {row.span.clippedStart ? <Text style={styles.clipCue}>‹</Text> : null}
      <View style={[styles.statusBadge, tone.badge]}>
        <Text style={[styles.statusBadgeText, tone.badgeText]} numberOfLines={1}>{row.status}</Text>
      </View>
      {row.span.clippedEnd ? <Text style={styles.clipCue}>›</Text> : null}
    </View>
  );

  return (
    <>
    {row.span.endedBeforeWindow ? null : (
    <View
      style={[
        styles.bar,
        tone.bar,
        {
          left: pct(row.span.startFraction),
          width: pct(row.span.widthFraction),
          // A shift too short to see at this range still has to be clickable.
          minWidth: 6,
          // A clipped edge is squared off, so a bar that continues past the view does not read as if it
          // ended there.
          borderTopLeftRadius: row.span.clippedStart ? 0 : radii.sm,
          borderBottomLeftRadius: row.span.clippedStart ? 0 : radii.sm,
          borderTopRightRadius: row.span.clippedEnd ? 0 : radii.sm,
          borderBottomRightRadius: row.span.clippedEnd ? 0 : radii.sm,
        },
      ]}
    >
      {outside ? null : badge}

      {/* Welfare markers sit along the bar, positioned by the foundation. */}
      <View style={styles.markerStrip} pointerEvents="box-none">
        {row.welfare.map((marker) => (
          <WelfareMarkerDot key={`${row.shiftId}-${marker.index}`} marker={marker} span={row.span} />
        ))}
      </View>
    </View>
    )}
    {outside ? (
      <View
        style={[styles.outsideBadge, { left: pct(row.span.endedBeforeWindow ? 0 : row.span.startFraction + row.span.widthFraction) }]}
        pointerEvents="none"
      >
        {badge}
      </View>
    ) : null}
    </>
  );
}

/**
 * How each Welfare state is drawn on the bar.
 *
 * Overdue and Missed are the two a controller must find while scanning thirty rows, so they are given a
 * filled chip — a difference in SHAPE, not only in colour, which is what survives a monochrome screen and
 * colour-vision deficiency. Completed, Due and Not required stay as bare glyphs so the exceptions are the
 * only things that stand out. Every marker still carries its glyph and its accessible label.
 */
const MARKER_TONE: Record<WelfareMarker['state'], { glyph: any; chip?: any }> = {
  upcoming: { glyph: { color: colors.disabledText } },
  completed: { glyph: { color: colors.success } },
  due: { glyph: { color: colors.textSecondary } },
  overdue: { glyph: { color: colors.textOnBrand }, chip: { backgroundColor: colors.warning } },
  missed: { glyph: { color: colors.textOnBrand }, chip: { backgroundColor: colors.danger } },
  ended_at_book_off: { glyph: { color: colors.textSecondary } },
  not_applicable: { glyph: { color: colors.disabledText } },
};

function WelfareMarkerDot({
  marker,
  span,
}: {
  key?: string | number;
  marker: WelfareMarker;
  span: TimelineRow['span'];
}) {
  // The marker is placed against the axis by the foundation; here it is re-expressed in the bar's own
  // coordinate space, because the bar is what it is drawn inside. A bar clipped to a sliver still divides
  // cleanly — the guard keeps a degenerate span from dividing by zero.
  const barWidth = Math.max(span.widthFraction, 1e-9);
  const left = (marker.span.startFraction - span.startFraction) / barWidth;
  const width = marker.span.widthFraction / barWidth;
  const tone = MARKER_TONE[marker.state];

  return (
    <View
      // `title` is what produces a native tooltip on web; the accessibility label covers native.
      {...(IS_WEB ? ({ title: marker.accessibleLabel } as any) : null)}
      accessibilityLabel={marker.accessibleLabel}
      style={[styles.marker, { left: pct(left), width: pct(width), minWidth: MARKER_SIZE }]}
    >
      <View style={[styles.markerChip, tone.chip ?? null]}>
        <Text style={[styles.markerGlyph, tone.glyph]}>{marker.glyph}</Text>
      </View>
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
  rootMenuOpen: { overflow: 'visible', zIndex: 30 },
  headerRow: {
    position: 'relative',
    zIndex: 20,
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
  identityGuard: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, letterSpacing: 0.1 },
  identityScheduled: { fontSize: 11, color: colors.textSecondary, fontWeight: '600' },
  identityAttendance: { fontSize: 11, color: colors.textSecondary, marginTop: 1 },
  identityOn: { color: colors.textPrimary, fontWeight: '700' },
  identityOff: { color: colors.textSecondary, fontWeight: '600' },
  identitySep: { color: colors.textMuted },
  identityLate: { color: colors.danger, fontWeight: '800' },

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
  barLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 5, paddingTop: 1 },
  // Beside a short or off-view overdue bar: positioned like a bar, without a bar's background.
  outsideBadge: { position: 'absolute', top: 8, height: ROW_HEIGHT - 18, justifyContent: 'center' },
  statusBadge: {
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: radii.sm, flexShrink: 1,
  },
  statusBadgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  clipCue: { fontSize: 10, fontWeight: '800', color: colors.textSecondary },

  markerStrip: { position: 'absolute', left: 0, right: 0, bottom: 2, height: MARKER_SIZE },
  marker: { position: 'absolute', alignItems: 'center', justifyContent: 'center', height: MARKER_SIZE },
  markerChip: {
    minWidth: MARKER_SIZE, height: MARKER_SIZE, borderRadius: MARKER_SIZE / 2,
    paddingHorizontal: 2, alignItems: 'center', justifyContent: 'center',
  },
  markerGlyph: { fontSize: 12, fontWeight: '800', lineHeight: 14 },

  pausedHint: { fontSize: 11, fontWeight: '700', color: colors.warning, alignSelf: 'center' },
  exportSection: { fontSize: 10, fontWeight: '800', color: colors.textSecondary, letterSpacing: 0.6, paddingHorizontal: 12, paddingTop: 8 },
  legend: {
    flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surfaceSubtle,
  },
  legendTitle: { fontSize: 10, fontWeight: '800', color: colors.textSecondary, letterSpacing: 0.6 },
  legendEntry: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendItem: { fontSize: 10, color: colors.textSecondary, fontWeight: '600' },
});
