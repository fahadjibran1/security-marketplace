import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '../ui/Card';
import { KpiCard } from '../ui/KpiCard';
import { colors, radii } from '../../theme';
import type { UrgentOperationalItem } from './CompanyLiveOperationsWorkspace';
import type { ComplianceMetrics } from './compliance-model';
import {
  DASHBOARD_LIVE_ROWS_LIMIT,
  attentionTiming,
  type AttentionSummary,
  type CoverageSummary,
  type LiveShiftRow,
  type UpcomingGroup,
} from './dashboardOverview';
import type { OperationsTone } from './operationsPresentation';

const IS_WEB = typeof document !== 'undefined';
const WEB_POINTER = IS_WEB ? ({ cursor: 'pointer' } as const) : null;
const HIDDEN_FROM_AT = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', 'aria-hidden': true } as any;
const HEADING_2 = { accessibilityRole: 'header', 'aria-level': 2 } as any;
const HEADING_3 = { accessibilityRole: 'header', 'aria-level': 3 } as any;

/** The sections the dashboard leads into. All are existing Company workspace sections. */
export type DashboardTarget = 'sites' | 'live-operations' | 'incidents' | 'alerts' | 'rota-planner' | 'compliance';

/** Whether a section's data sources loaded on the last attempt. */
export type DashboardSourceState = 'ready' | 'error';

export type DashboardKpis = {
  activeSites: number;
  liveShifts: number;
  coverageGaps: number;
  openIncidents: number;
  alerts: number;
  /** An open incident is recorded as critical severity. */
  incidentsCritical?: boolean;
  /** An active panic / SOS alert is outstanding. */
  alertsCritical?: boolean;
};

/** compact: desktop control-room density (from 1024px). comfortable: the touch-friendly default. */
export type DashboardDensity = 'compact' | 'comfortable';

export type DashboardFreshness = {
  /** "Monday, 5 October · 18:55" on the dashboard's clock. */
  clock: string;
  /** The zone, named only when the company's sites span more than one. */
  zoneNote: string | null;
  /** "Updated 18:55" after a fully successful load; null before the first one. */
  updated: string | null;
  refreshing: boolean;
  /** True when the most recent load had a failure — the Updated time is then the last good one. */
  lastLoadFailed: boolean;
  autoRefreshSeconds: number;
};

export type CompanyDashboardOverviewProps = {
  loading: boolean;
  density?: DashboardDensity;
  freshness: DashboardFreshness;
  kpis: DashboardKpis;
  attention: AttentionSummary;
  liveRows: LiveShiftRow[];
  coverage: CoverageSummary;
  upcoming: UpcomingGroup[];
  compliance: { canView: boolean; metrics: ComplianceMetrics | null };
  sources: {
    attention: DashboardSourceState;
    live: DashboardSourceState;
    coverage: DashboardSourceState;
    upcoming: DashboardSourceState;
    compliance: DashboardSourceState;
  };
  now: Date;
  onNavigate: (target: DashboardTarget) => void;
  onOpenCoverageGaps: () => void;
  onOpenAttentionItem: (item: UrgentOperationalItem) => void;
  onViewAllAttention: () => void;
  onOpenLiveShift: (shiftId: number) => void;
};

type Severity = 'red' | 'amber' | 'blue';

function severityOf(category: UrgentOperationalItem['category']): Severity {
  switch (category) {
    case 'panic':
    case 'incident':
    case 'missed_shift':
      return 'red';
    case 'late_start':
    case 'missed_check_call':
    case 'uncovered_shift':
    case 'rejected_offer':
    case 'safety':
    case 'missing_book_off':
      return 'amber';
    default:
      return 'blue';
  }
}

/** The status word on each row, so severity is never carried by colour alone. */
export function attentionBadgeLabel(category: UrgentOperationalItem['category']): string {
  switch (category) {
    case 'panic':             return 'Critical';
    case 'incident':          return 'Incident';
    case 'missed_shift':      return 'Missed shift';
    case 'late_start':        return 'Late start';
    case 'uncovered_shift':   return 'Coverage gap';
    case 'missed_check_call': return 'Missed Welfare Check';
    case 'missing_book_off':  return 'Missing Book Off';
    case 'rejected_offer':    return 'Offer rejected';
    case 'safety':            return 'Safety';
    case 'site_request':      return 'Site Request';
    case 'upcoming_risk':     return 'Upcoming risk';
    default:                  return String(category).replace(/_/g, ' ');
  }
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.filter((part) => part && part.trim()).join(' · ');
}

function guardPart(name: string | null | undefined): string | null {
  return name && !['Unknown guard', 'No confirmed guard', 'No guard'].includes(name) ? name : null;
}

// ─── small building blocks ───────────────────────────────────────────────────

function ActionLink({ label, onPress, accessibilityLabel, compact = false }: { label: string; onPress: () => void; accessibilityLabel?: string; compact?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ hovered, pressed, focused }: any) => [
        styles.actionLink,
        compact ? cs.actionLink : null,
        hovered ? styles.actionLinkHover : null,
        pressed ? styles.actionLinkPressed : null,
        IS_WEB && focused ? (styles.focusRing as any) : null,
        WEB_POINTER as any,
      ]}
    >
      <Text style={styles.actionLinkText}>
        {label} <Text {...HIDDEN_FROM_AT}>→</Text>
      </Text>
    </Pressable>
  );
}

function PanelMessage({ title, description, tone = 'neutral', compact = false }: { title: string; description?: string; tone?: 'neutral' | 'error' | 'good'; compact?: boolean }) {
  return (
    <View
      style={[styles.panelMessage, compact ? cs.panelMessage : null, tone === 'error' ? styles.panelMessageError : null]}
      {...(tone === 'error' ? ({ accessibilityRole: 'alert' } as any) : {})}
    >
      <Text style={[styles.panelMessageTitle, tone === 'error' ? styles.panelMessageTitleError : tone === 'good' ? styles.panelMessageTitleGood : null]}>
        {title}
      </Text>
      {description ? <Text style={styles.panelMessageText}>{description}</Text> : null}
    </View>
  );
}

/** An inline notice that a section is showing its last loaded data because the latest load failed. */
function StaleNotice({ what }: { what: string }) {
  return (
    <View style={styles.staleNotice} {...({ accessibilityRole: 'alert' } as any)}>
      <Text style={styles.staleNoticeText}>{`${what} could not be refreshed. Showing the last loaded data.`}</Text>
    </View>
  );
}

const TONE_TEXT: Record<OperationsTone, any> = {
  neutral: null,
  good: { color: colors.success },
  warning: { color: colors.warning },
  danger: { color: colors.danger },
};

// ─── the dashboard ───────────────────────────────────────────────────────────

export function CompanyDashboardOverview(props: CompanyDashboardOverviewProps) {
  const { freshness, kpis, attention, liveRows, coverage, upcoming, compliance, sources, now } = props;
  const shownLiveRows = liveRows.slice(0, DASHBOARD_LIVE_ROWS_LIMIT);
  const moreLiveRows = liveRows.length - shownLiveRows.length;
  const compact = props.density === 'compact';
  /** The compact override for a style key, or nothing in comfortable density. */
  const c = (key: string) => (compact ? cs[key] : null);
  const cardDensity = compact ? 'compact' : 'default';

  return (
    <View style={[styles.stack, c('stack')]}>
      {/* ── Freshness ── */}
      <View style={styles.freshness}>
        <Text style={[styles.freshnessClock, c('freshnessClock')]}>
          {freshness.clock}
          {freshness.zoneNote ? <Text style={styles.freshnessZone}>{`  (${freshness.zoneNote})`}</Text> : null}
        </Text>
        <Text style={[styles.freshnessStatus, c('freshnessStatus'), freshness.lastLoadFailed ? styles.freshnessStatusWarn : null]} {...({ accessibilityLiveRegion: 'polite', 'aria-live': 'polite' } as any)}>
          {freshness.refreshing
            ? 'Refreshing…'
            : freshness.lastLoadFailed
              ? joinParts(['Last refresh failed', freshness.updated ? `data ${freshness.updated.replace(/^Updated /, 'from ')}` : 'no data loaded yet'])
              : freshness.updated
                ? joinParts([freshness.updated, `refreshes every ${freshness.autoRefreshSeconds === 60 ? 'minute' : `${freshness.autoRefreshSeconds} seconds`}`])
                : 'Loading…'}
        </Text>
      </View>

      {/* ── ROW 1: KPIs ── */}
      <View style={styles.kpiStrip}>
        <View style={styles.kpiCell}>
          <KpiCard compact={compact} label="Active Sites" value={String(kpis.activeSites)} icon="📍" tone={kpis.activeSites > 0 ? 'good' : 'neutral'}
            onPress={() => props.onNavigate('sites')} accessibilityHint="Opens Sites" />
        </View>
        <View style={styles.kpiCell}>
          <KpiCard compact={compact} label="Live Shifts" value={String(kpis.liveShifts)} icon="🟢" tone={kpis.liveShifts > 0 ? 'good' : 'neutral'}
            onPress={() => props.onNavigate('live-operations')} accessibilityHint="Opens Live Operations" />
        </View>
        <View style={styles.kpiCell}>
          <KpiCard compact={compact} label="Coverage Gaps" value={String(kpis.coverageGaps)} icon="⚠️"
            tone={kpis.coverageGaps > 0 ? 'warning' : 'good'} statusText={kpis.coverageGaps > 0 ? 'Needs cover' : undefined}
            onPress={props.onOpenCoverageGaps} accessibilityHint="Opens uncovered shifts in Coverage" />
        </View>
        <View style={styles.kpiCell}>
          <KpiCard compact={compact} label="Open Incidents" value={String(kpis.openIncidents)} icon="🚨"
            tone={kpis.openIncidents > 0 ? (kpis.incidentsCritical ? 'attention' : 'warning') : 'good'}
            statusText={kpis.openIncidents > 0 ? (kpis.incidentsCritical ? 'Critical' : 'Open') : undefined}
            onPress={() => props.onNavigate('incidents')} accessibilityHint="Opens Incidents" />
        </View>
        <View style={styles.kpiCell}>
          <KpiCard compact={compact} label="Alerts" value={String(kpis.alerts)} icon="🔔"
            tone={kpis.alerts > 0 ? (kpis.alertsCritical ? 'attention' : 'warning') : 'good'}
            statusText={kpis.alerts > 0 ? (kpis.alertsCritical ? 'SOS active' : 'Outstanding') : undefined}
            onPress={() => props.onNavigate('alerts')} accessibilityHint="Opens Safety Alerts" />
        </View>
      </View>

      {/* ── ROW 2: Attention Required ── */}
      <View style={styles.attentionPanel}>
        <View style={[styles.attentionHeader, c('attentionHeader')]}>
          <Text style={[styles.attentionTitle, c('attentionTitle')]} {...HEADING_2}>
            {attention.total > 0 ? 'Attention Required' : 'All Clear'}
          </Text>
          <Text style={[styles.attentionSubtitle, c('attentionSubtitle')]}>
            {attention.total > 0
              ? `${attention.total} item${attention.total !== 1 ? 's' : ''} requiring action${attention.hasMore ? ` · showing the ${attention.shown.length} most urgent` : ''}.`
              : props.loading ? 'Checking operational conditions…' : 'No operational conditions require immediate attention right now.'}
          </Text>
        </View>
        {sources.attention === 'error' && attention.total > 0 ? <StaleNotice what="Attention items" /> : null}
        {props.loading ? (
          <PanelMessage compact={compact} title="Loading attention items…" />
        ) : sources.attention === 'error' && attention.total === 0 ? (
          <PanelMessage compact={compact} tone="error" title="Attention items could not be loaded" description="Use Refresh to try again. Live Operations shows the full queue." />
        ) : attention.total === 0 ? (
          <PanelMessage compact={compact} tone="good" title="Operational position is clear." />
        ) : (
          <>
            {attention.shown.map((item, index) => {
              const severity = severityOf(item.category);
              const badge = attentionBadgeLabel(item.category);
              const timing = attentionTiming(item, now);
              const where = joinParts([item.siteName, guardPart(item.guardName)]);
              return (
                <Pressable
                  key={item.id}
                  onPress={() => props.onOpenAttentionItem(item)}
                  accessibilityRole="button"
                  accessibilityLabel={joinParts([`${badge}: ${item.issueType}`, where, timing])}
                  style={({ hovered, pressed, focused }: any) => [
                    styles.attentionItem,
                    c('attentionItem'),
                    index === attention.shown.length - 1 && !attention.hasMore ? styles.attentionItemLast : null,
                    hovered ? styles.rowHover : null,
                    pressed ? styles.rowPressed : null,
                    IS_WEB && focused ? (styles.focusRingInset as any) : null,
                    WEB_POINTER as any,
                  ]}
                >
                  <View style={[styles.attentionBar, c('attentionBar'), styles[`bar_${severity}`]]} />
                  {/* Body and status share a wrapping line: on a narrow screen the status drops below the
                      text instead of squeezing the issue, site and Guard into ellipses. */}
                  <View style={[styles.attentionContent, c('attentionContent')]}>
                    <View style={[styles.attentionBody, c('attentionBody')]}>
                      <Text style={[styles.attentionLabel, c('attentionLabel')]} numberOfLines={1}>{item.issueType}</Text>
                      {/* Where and how long share a line when there is room, and wrap on a phone. */}
                      <View style={styles.metaRow}>
                        <Text style={[styles.attentionMeta, c('attentionMeta')]} numberOfLines={1}>{where}</Text>
                        {timing ? <Text style={[styles.attentionTiming, c('attentionTiming')]} numberOfLines={1}>{timing}</Text> : null}
                      </View>
                    </View>
                    <View style={styles.attentionStatus}>
                      <View style={[styles.badge, c('badge'), styles[`badge_${severity}`]]}>
                        <Text style={[styles.badgeText, c('badgeText'), styles[`badgeText_${severity}`]]} numberOfLines={1}>{badge}</Text>
                      </View>
                      <Text style={styles.chevron} {...HIDDEN_FROM_AT}>→</Text>
                    </View>
                  </View>
                </Pressable>
              );
            })}
            {attention.hasMore ? (
              <View style={[styles.viewAllRow, c('viewAllRow')]}>
                <ActionLink compact={compact}
                  label={`View all ${attention.total} items in Live Operations`}
                  onPress={props.onViewAllAttention}
                />
              </View>
            ) : null}
          </>
        )}
      </View>

      {/* ── ROW 3: Live Operations (2/3) + Today's Coverage (1/3) ── */}
      <View style={[styles.row, c('row')]}>
        <View style={styles.rowMain}>
          <Card density={cardDensity} style={styles.panel} webSurfaceHover title="Live Operations" subtitle="Guards on duty right now." headingLevel={2}>
            {sources.live === 'error' && liveRows.length > 0 ? <StaleNotice what="Live shifts" /> : null}
            {props.loading ? (
              <PanelMessage compact={compact} title="Loading live shifts…" />
            ) : sources.live === 'error' && liveRows.length === 0 ? (
              <PanelMessage compact={compact} tone="error" title="Live shifts could not be loaded" description="Use Refresh to try again, or open Live Operations." />
            ) : liveRows.length === 0 ? (
              <PanelMessage compact={compact} title="No live shifts right now" description="When Guards are booked on and working, they appear here." />
            ) : (
              <View>
                {shownLiveRows.map((row, index) => (
                  <Pressable
                    key={row.shiftId}
                    onPress={() => props.onOpenLiveShift(row.shiftId)}
                    accessibilityRole="button"
                    accessibilityLabel={joinParts([
                      `${row.siteName}, ${row.guardName}, ${row.timeRange}`,
                      row.stateLabel,
                      row.bookedOn ? `Booked on ${row.bookedOn}` : 'No Book On recorded',
                      row.welfare ? `Welfare ${row.welfare.label}${row.welfare.detail ? `, ${row.welfare.detail}` : ''}` : null,
                      row.lastActivity ? `Last activity ${row.lastActivity}` : null,
                      row.attentionCount > 0 ? `${row.attentionCount} open attention item${row.attentionCount !== 1 ? 's' : ''}` : null,
                      'opens in Live Operations',
                    ])}
                    style={({ hovered, pressed, focused }: any) => [
                      styles.liveRow,
                      c('liveRow'),
                      index === shownLiveRows.length - 1 ? styles.liveRowLast : null,
                      hovered ? styles.rowHover : null,
                      pressed ? styles.rowPressed : null,
                      IS_WEB && focused ? (styles.focusRingInset as any) : null,
                      WEB_POINTER as any,
                    ]}
                  >
                    <View style={styles.liveRowHead}>
                      <Text style={styles.liveSite} numberOfLines={1}>{row.siteName}</Text>
                      <View style={[styles.badge, c('badge'), row.stateLabel === 'In progress' ? styles.badge_good : styles.badge_amber]}>
                        <Text style={[styles.badgeText, c('badgeText'), row.stateLabel === 'In progress' ? styles.badgeText_good : styles.badgeText_amber]} numberOfLines={1}>
                          {row.stateLabel}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.liveGuard} numberOfLines={1}>{`${row.guardName} · ${row.timeRange}`}</Text>
                    <View style={styles.facts}>
                      <Text style={styles.fact}>
                        <Text style={styles.factLabel}>Booked on </Text>
                        {row.bookedOn ?? <Text style={TONE_TEXT.warning}>Not recorded</Text>}
                      </Text>
                      {row.welfare ? (
                        <Text style={styles.fact}>
                          <Text style={styles.factLabel}>Welfare </Text>
                          <Text style={[styles.factStrong, TONE_TEXT[row.welfare.tone]]}>{row.welfare.label}</Text>
                          {row.welfare.detail ? ` · ${row.welfare.detail}` : ''}
                        </Text>
                      ) : null}
                      {row.lastActivity ? (
                        <Text style={styles.fact}>
                          <Text style={styles.factLabel}>Last activity </Text>
                          {row.lastActivity}
                        </Text>
                      ) : null}
                      {row.attentionCount > 0 ? (
                        <Text style={[styles.fact, styles.factStrong, TONE_TEXT.danger]}>
                          {`${row.attentionCount} open attention item${row.attentionCount !== 1 ? 's' : ''}`}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                ))}
                {moreLiveRows > 0 ? (
                  <Text style={styles.moreNote}>{`${moreLiveRows} more live shift${moreLiveRows !== 1 ? 's' : ''} in Live Operations.`}</Text>
                ) : null}
              </View>
            )}
            <ActionLink compact={compact} label="Open Live Operations" onPress={() => props.onNavigate('live-operations')} />
          </Card>
        </View>

        <View style={styles.rowSide}>
          <Card
            density={cardDensity}
            style={styles.panelNatural}
            webSurfaceHover
            title="Today's Coverage"
            subtitle="Shift coverage position right now."
            tone={coverage.uncovered > 0 ? 'warning' : 'default'}
            headingLevel={2}
          >
            {sources.coverage === 'error' ? <StaleNotice what="Coverage" /> : null}
            <View style={[styles.stats, c('stats')]}>
              <View style={[styles.stat, c('stat')]}>
                <Text style={[styles.statValue, c('statValue')]}>{coverage.liveNow}</Text>
                <Text style={styles.statLabel}>Live now</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={[styles.stat, c('stat')]}>
                <Text style={[styles.statValue, c('statValue'), coverage.uncovered > 0 ? styles.statValueWarn : null]}>{coverage.uncovered}</Text>
                <Text style={styles.statLabel}>Uncovered</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={[styles.stat, c('stat')]}>
                <Text style={[styles.statValue, c('statValue'), coverage.gapSites > 0 ? styles.statValueWarn : null]}>{coverage.gapSites}</Text>
                <Text style={styles.statLabel}>Gap sites</Text>
              </View>
            </View>
            {coverage.uncovered > 0 ? (
              <>
                <PanelMessage compact={compact}
                  title={`${coverage.uncovered} uncovered shift${coverage.uncovered !== 1 ? 's need' : ' needs'} cover`}
                  description={`Across ${coverage.gapSites} site${coverage.gapSites !== 1 ? 's' : ''}.`}
                />
                <ActionLink compact={compact} label="Review coverage gaps" onPress={props.onOpenCoverageGaps} />
              </>
            ) : (
              <PanelMessage compact={compact} tone="good" title="Coverage looks good" description="No uncovered shifts detected." />
            )}
          </Card>
        </View>
      </View>

      {/* ── ROW 4: Upcoming Shifts (1/2) + Compliance Overview (1/2) ── */}
      <View style={[styles.row, c('row')]}>
        <View style={styles.rowHalf}>
          <Card density={cardDensity} style={styles.panel} webSurfaceHover title="Upcoming Shifts" subtitle="The next shifts, unassigned ones first." headingLevel={2}>
            {sources.upcoming === 'error' && upcoming.length > 0 ? <StaleNotice what="Shifts" /> : null}
            {props.loading ? (
              <PanelMessage compact={compact} title="Loading shifts…" />
            ) : sources.upcoming === 'error' && upcoming.length === 0 ? (
              <PanelMessage compact={compact} tone="error" title="Shifts could not be loaded" description="Use Refresh to try again." />
            ) : upcoming.length === 0 ? (
              <PanelMessage compact={compact} title="No upcoming shifts" description="Future shifts appear here once they are planned." />
            ) : (
              upcoming.map((group) => (
                <View key={group.label} style={[styles.group, c('group')]}>
                  <Text style={styles.groupLabel} {...HEADING_3}>{group.label}</Text>
                  {group.rows.map((row) => (
                    <View
                      key={row.shiftId}
                      style={[styles.upcomingRow, c('upcomingRow')]}
                      accessible
                      accessibilityLabel={joinParts([group.label, row.timeRange, row.siteName, row.unassigned ? 'Unassigned' : row.guardName])}
                    >
                      <Text style={styles.upcomingTime}>{row.timeRange}</Text>
                      <View style={styles.upcomingBody}>
                        <Text style={styles.upcomingSite} numberOfLines={1}>{row.siteName}</Text>
                        {row.unassigned ? (
                          <View style={[styles.badge, c('badge'), styles.badge_amber, styles.badgeInline]}>
                            <Text style={[styles.badgeText, c('badgeText'), styles.badgeText_amber]}>Unassigned</Text>
                          </View>
                        ) : (
                          <Text style={styles.upcomingGuard} numberOfLines={1}>{row.guardName}</Text>
                        )}
                      </View>
                    </View>
                  ))}
                </View>
              ))
            )}
            <ActionLink compact={compact} label="View shift schedule" onPress={() => props.onNavigate('rota-planner')} />
          </Card>
        </View>

        <View style={styles.rowHalf}>
          <Card
            density={cardDensity}
            style={styles.panelNatural}
            webSurfaceHover
            title="Compliance Overview"
            subtitle="Guard compliance status, as the Compliance screen reports it."
            tone={compliance.metrics && compliance.metrics.needsAttention > 0 ? 'danger' : compliance.metrics && compliance.metrics.expiring > 0 ? 'warning' : 'default'}
            headingLevel={2}
          >
            {!compliance.canView ? (
              <PanelMessage compact={compact} title="Compliance not available" description="Your role does not include access to Guard compliance." />
            ) : sources.compliance === 'error' && !compliance.metrics ? (
              <PanelMessage compact={compact} tone="error" title="Compliance could not be loaded" description="Use Refresh to try again." />
            ) : props.loading || !compliance.metrics ? (
              <PanelMessage compact={compact} title="Loading compliance…" />
            ) : compliance.metrics.total === 0 ? (
              <PanelMessage compact={compact} title="No compliance records" description="Guard compliance appears here once Guards are linked to your company." />
            ) : (
              <>
                {sources.compliance === 'error' ? <StaleNotice what="Compliance" /> : null}
                <View style={[styles.stats, c('stats')]}>
                  {([
                    ['Valid', compliance.metrics.valid, null],
                    ['Expiring', compliance.metrics.expiring, compliance.metrics.expiring > 0 ? styles.statValueWarn : null],
                    ['Needs attention', compliance.metrics.needsAttention, compliance.metrics.needsAttention > 0 ? styles.statValueDanger : null],
                    ['Unknown', compliance.metrics.unknown, null],
                  ] as const).map(([label, value, tone], index) => (
                    <View
                      key={label}
                      style={[styles.stat, c('stat'), index > 0 ? styles.statBordered : null]}
                      accessible
                      accessibilityLabel={`${label}: ${value} Guard${value !== 1 ? 's' : ''}`}
                    >
                      <Text style={[styles.statValueSmall, c('statValueSmall'), tone]}>{value}</Text>
                      <Text style={styles.statLabel}>{label}</Text>
                    </View>
                  ))}
                </View>
              </>
            )}
            {compliance.canView ? <ActionLink compact={compact} label="View compliance" onPress={() => props.onNavigate('compliance')} /> : null}
          </Card>
        </View>
      </View>
    </View>
  );
}

const ROW_DIVIDER = 'rgba(226, 232, 240, 0.88)';

const styles: Record<string, any> = StyleSheet.create({
  stack: { gap: 18 },

  freshness: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    columnGap: 16,
    rowGap: 2,
  } as any,
  freshnessClock: { fontSize: 14, fontWeight: '700', color: colors.primaryNavy },
  freshnessZone: { fontSize: 12, fontWeight: '500', color: colors.textSecondary },
  freshnessStatus: { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  freshnessStatusWarn: { color: colors.warning, fontWeight: '700' },

  kpiStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  // Five across from a 768px window; two per row on a phone.
  kpiCell: { flexGrow: 1, flexBasis: 130, minWidth: 130, alignSelf: 'stretch' },

  attentionPanel: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  attentionHeader: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 4,
  },
  attentionTitle: { fontSize: 15, fontWeight: '700', color: colors.primaryNavy, letterSpacing: -0.1 },
  attentionSubtitle: { fontSize: 13, fontWeight: '500', color: colors.textSecondary, lineHeight: 19 },
  attentionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: ROW_DIVIDER,
    paddingRight: 16,
  },
  attentionItemLast: { borderBottomWidth: 0 },
  attentionBar: { width: 4, alignSelf: 'stretch', minHeight: 56 },
  bar_red: { backgroundColor: colors.danger },
  bar_amber: { backgroundColor: colors.warning },
  bar_blue: { backgroundColor: colors.info },
  attentionContent: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 12,
    rowGap: 6,
    paddingVertical: 11,
  } as any,
  attentionBody: { flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0, gap: 2 },
  attentionStatus: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 0, marginLeft: 'auto' } as any,
  attentionLabel: { fontSize: 14, fontWeight: '700', color: colors.primaryNavy, lineHeight: 20 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 10 } as any,
  attentionMeta: { fontSize: 13, fontWeight: '500', color: colors.textPrimary, lineHeight: 18 },
  attentionTiming: { fontSize: 12, fontWeight: '600', color: colors.textSecondary, lineHeight: 17 },
  chevron: { fontSize: 16, color: colors.textSecondary, flexShrink: 0 },
  viewAllRow: { paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: 1, borderTopColor: ROW_DIVIDER },

  badge: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    flexShrink: 1,
    maxWidth: 180,
  },
  badgeInline: { alignSelf: 'flex-start' },
  badge_red: { borderColor: colors.dangerBorder, backgroundColor: colors.dangerSurface },
  badge_amber: { borderColor: colors.warningBorder, backgroundColor: colors.warningSurface },
  badge_blue: { borderColor: colors.infoBorder, backgroundColor: colors.infoSurface },
  badge_good: { borderColor: colors.successBorder, backgroundColor: colors.successSurface },
  badgeText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' } as any,
  badgeText_red: { color: colors.danger },
  badgeText_amber: { color: colors.warning },
  badgeText_blue: { color: colors.info },
  badgeText_good: { color: colors.success },

  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 18 },
  rowMain: { flexGrow: 2, flexBasis: 460, minWidth: 0, maxWidth: '100%' } as any,
  // Wide enough that the three coverage figures never collide; below that it takes its own row.
  rowSide: { flexGrow: 1, flexBasis: 280, minWidth: 0, maxWidth: '100%' } as any,
  rowHalf: { flexGrow: 1, flexBasis: 340, minWidth: 0, maxWidth: '100%' } as any,
  panel: { flex: 1, alignSelf: 'stretch' },
  // Summary cards keep their own height rather than stretching to a taller neighbour's empty space.
  panelNatural: { alignSelf: 'flex-start', width: '100%' } as any,

  rowHover: { backgroundColor: 'rgba(15, 23, 42, 0.03)' },
  rowPressed: { backgroundColor: 'rgba(15, 23, 42, 0.05)' },
  focusRing: { outlineStyle: 'solid', outlineWidth: 2, outlineColor: colors.focusRing, outlineOffset: 2 } as any,
  focusRingInset: { outlineStyle: 'solid', outlineWidth: 2, outlineColor: colors.focusRing, outlineOffset: -2 } as any,

  liveRow: {
    paddingVertical: 11,
    paddingHorizontal: 10,
    gap: 3,
    borderBottomWidth: 1,
    borderBottomColor: ROW_DIVIDER,
    borderRadius: 8,
  },
  liveRowLast: { borderBottomWidth: 0 },
  liveRowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  liveSite: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '800', color: colors.primaryNavy, textTransform: 'uppercase', letterSpacing: 0.3 } as any,
  liveGuard: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, lineHeight: 18 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 2 } as any,
  fact: { fontSize: 12, lineHeight: 18, color: colors.textPrimary, fontWeight: '500' },
  factLabel: { color: colors.textSecondary, fontWeight: '500' },
  factStrong: { fontWeight: '800' },
  moreNote: { fontSize: 12, fontWeight: '600', color: colors.textSecondary, paddingHorizontal: 10, paddingTop: 6 },

  stats: { flexDirection: 'row', marginBottom: 6 },
  stat: { flex: 1, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 4, gap: 4, minWidth: 0 },
  statValue: { fontSize: 30, fontWeight: '800', color: colors.primaryNavy, letterSpacing: -0.5 },
  statValueSmall: { fontSize: 26, fontWeight: '800', color: colors.primaryNavy, letterSpacing: -0.3 },
  statValueWarn: { color: colors.warning },
  statValueDanger: { color: colors.danger },
  statLabel: { fontSize: 11, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, textAlign: 'center' } as any,
  statDivider: { width: 1, backgroundColor: colors.border, marginVertical: 10 },
  statBordered: { borderLeftWidth: 1, borderLeftColor: colors.border },

  group: { gap: 2, marginBottom: 6 },
  groupLabel: { fontSize: 11, fontWeight: '800', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.8, paddingTop: 4, paddingBottom: 2 } as any,
  upcomingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: ROW_DIVIDER,
  },
  upcomingTime: { width: 92, flexShrink: 0, fontSize: 13, fontWeight: '700', color: colors.primaryNavy } as any,
  upcomingBody: { flex: 1, minWidth: 0, gap: 3 },
  upcomingSite: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  upcomingGuard: { fontSize: 12, fontWeight: '500', color: colors.textSecondary },

  panelMessage: { paddingVertical: 12, paddingHorizontal: 4, gap: 4 },
  panelMessageError: {
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurface,
    marginVertical: 6,
  },
  panelMessageTitle: { fontSize: 14, fontWeight: '700', color: colors.primaryNavy },
  panelMessageTitleError: { color: colors.danger },
  panelMessageTitleGood: { color: colors.success },
  panelMessageText: { fontSize: 13, lineHeight: 19, color: colors.textSecondary, fontWeight: '500' },

  staleNotice: {
    marginHorizontal: 0,
    marginVertical: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    backgroundColor: colors.warningSurface,
  },
  staleNoticeText: { fontSize: 12, fontWeight: '600', color: colors.warning },

  actionLink: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    // Comfortable density is the touch layout, so a full 44px target.
    minHeight: 44,
    justifyContent: 'center',
  },
  actionLinkHover: { backgroundColor: 'rgba(11, 31, 51, 0.05)' },
  actionLinkPressed: { opacity: 0.85 },
  actionLinkText: { fontSize: 13, fontWeight: '700', color: colors.accentTealStrong },
});

/**
 * Compact (desktop, from 1024px) overrides. A control room reads this at a desk with a mouse, so rows,
 * cards and gaps tighten to fit the queue and the start of Live Operations above the fold. Comfortable
 * density below 1024px keeps the touch-sized originals above.
 */
const cs: Record<string, any> = StyleSheet.create({
  stack: { gap: 14 },
  row: { gap: 14 },
  freshnessClock: { fontSize: 13 },
  freshnessStatus: { fontSize: 12 },
  attentionHeader: { paddingHorizontal: 16, paddingTop: 11, paddingBottom: 9, gap: 2 },
  attentionTitle: { fontSize: 16, lineHeight: 21 },
  attentionSubtitle: { fontSize: 12, lineHeight: 17 },
  attentionItem: { paddingRight: 14, gap: 12 },
  attentionBar: { minHeight: 44 },
  attentionContent: { paddingVertical: 10 },
  attentionBody: { gap: 1 },
  attentionLabel: { lineHeight: 19 },
  attentionMeta: { fontSize: 12, lineHeight: 17 },
  attentionTiming: { fontSize: 12, lineHeight: 17 },
  badge: { paddingVertical: 2, paddingHorizontal: 7 },
  // Compact pills keep 11px text — the status word is what the operator reads — with tighter padding.
  badgeText: { fontSize: 11, letterSpacing: 0.4, lineHeight: 14 },
  viewAllRow: { paddingVertical: 2 },
  liveRow: { paddingVertical: 7, gap: 2 },
  stats: { marginBottom: 2 },
  stat: { paddingVertical: 6 },
  statValue: { fontSize: 24 },
  statValueSmall: { fontSize: 22 },
  group: { marginBottom: 4 },
  upcomingRow: { paddingVertical: 5 },
  panelMessage: { paddingVertical: 6 },
  actionLink: { marginTop: 2, paddingVertical: 5, minHeight: 30 },
});
