import * as React from 'react';
import { Text, View } from 'react-native';
import { getPatrolMonitorSummary } from '../../services/api';
import { colors, spacing, typography } from '../../theme';
import type { PatrolMonitorSummary } from '../../types/patrols';
import { Button } from '../ui/Button';
import type { PatrolPageContext } from './patrolContext';
import { DEFAULT_SITE_ZONE } from './patrolContext';
import { MonitorLegend } from './PatrolMonitorMarks';
import { PatrolMonitorSiteCard } from './PatrolMonitorSiteCard';
import {
  MONITOR_SITE_GROUPS,
  filterMonitorSites,
  monitorClients,
  monitorDateLabel,
  monitorSiteGroup,
  shiftMonitorDate,
  sortMonitorSites,
  type MonitorStatusFilter,
} from './patrolMonitorPresentation';
import { siteTodayKey } from './patrolPresentation';
import { ChipSelect, ResourceState, ui, usePatrolResource } from './patrolUi';

/**
 * The Patrol Monitor (S4 Patrol Monitor S2, owner-approved 3 Nov 2026): one compact card per site, sites needing
 * attention first. Read-only: the summary is ONE request (GET /patrols/monitor/summary), refreshed every 30 s only while
 * the page is on screen and showing today; a site's hours are read only when its card is expanded. A past day is read
 * once and not refreshed. Nothing here writes.
 */
export function PatrolMonitorTab({ ctx }: { ctx: PatrolPageContext; key?: string }) {
  // null: today at each site (each site's own local day). Otherwise the site-local day chosen.
  const [date, setDate] = React.useState<string | null>(null);
  const [clientId, setClientId] = React.useState<number | null>(null);
  const [status, setStatus] = React.useState<MonitorStatusFilter>('all');
  const [expanded, setExpanded] = React.useState<ReadonlySet<number>>(() => new Set());
  const live = date == null;
  const phone = ctx.layout.mode === 'mobile';

  const summary = usePatrolResource<PatrolMonitorSummary>(
    `monitor-summary|${ctx.companyKey}|${date ?? 'today'}`,
    () => getPatrolMonitorSummary({ date }),
    { poll: live },
  );
  // Every site's card is the site list itself (the page's site picker is hidden here); read once per company and day.
  const data = summary.data && Array.isArray(summary.data.sites) ? summary.data : null;
  const today = data?.date && live ? data.date : siteTodayKey(DEFAULT_SITE_ZONE);
  const shown = date ?? today;

  const allSites = data ? data.sites : [];
  const clients = monitorClients(allSites);
  const sites = sortMonitorSites(filterMonitorSites(allSites, { clientId, status }));

  const toggle = (siteId: number) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(siteId)) next.delete(siteId); else next.add(siteId);
    return next;
  });
  const go = (days: number) => {
    const next = shiftMonitorDate(shown, days);
    setDate(next >= today ? null : next);
  };

  return (
    <View style={{ gap: spacing.md }} testID="patrol-monitor">
      <View style={styles.dateBar} accessibilityLabel="Patrol Monitor day">
        <Button label={phone ? '‹' : '‹ Previous day'} accessibilityLabel="Previous day" variant="secondary" size={phone ? 'md' : 'sm'} onPress={() => go(-1)} />
        <View style={{ alignItems: 'center', minWidth: phone ? 0 : 150, flexShrink: 1 }}>
          <Text style={styles.date} accessibilityRole="header">{live ? 'Today' : monitorDateLabel(shown)}</Text>
          <Text style={ui.muted}>{live ? (data?.date ? monitorDateLabel(data.date) : 'Each site’s local day') : 'Site-local day · not refreshed'}</Text>
        </View>
        <Button label={phone ? '›' : 'Next day ›'} accessibilityLabel="Next day" variant="secondary" size={phone ? 'md' : 'sm'} disabled={live} onPress={() => go(1)} />
        {!live ? <Button label="Back to today" variant="tertiary" size="sm" onPress={() => setDate(null)} /> : null}
      </View>

      {data && live ? (
        <View style={styles.liveOps} accessibilityLabel="Live Operations patrol counts">
          <Text style={styles.liveOpsText}>Open patrol alerts: {data.liveOps.openPatrolAlerts}</Text>
          <Text style={styles.liveOpsText}>Missed today: {data.liveOps.missedToday}{data.liveOps.missedToday ? ` (${data.liveOps.missedTodayOpen} open)` : ''}</Text>
        </View>
      ) : null}

      {clients.length > 1 ? (
        <ChipSelect label="Client" scroll options={[{ value: 0, label: 'All clients' }, ...clients.map((c) => ({ value: c.id, label: c.name }))]} value={clientId ?? 0} onChange={(v) => setClientId(v ? Number(v) : null)} />
      ) : null}
      {data && allSites.length ? (
        <ChipSelect
          label="Show"
          scroll={ctx.layout.tabsScroll}
          options={[{ value: 'all' as MonitorStatusFilter, label: 'All sites' }, ...MONITOR_SITE_GROUPS.map((g) => ({ value: g.id as MonitorStatusFilter, label: g.label }))]}
          value={status}
          onChange={(v) => setStatus(v)}
        />
      ) : null}

      {ResourceState({
        resource: summary,
        empty: Boolean(data) && sites.length === 0,
        emptyMessage: allSites.length ? 'No site matches these filters.' : 'No site has patrols set up. Set patrols up for a site under Setup.',
        what: 'sites with patrols',
      })}

      {MONITOR_SITE_GROUPS.map((group) => {
        const inGroup = sites.filter((s) => monitorSiteGroup(s.status) === group.id);
        if (!inGroup.length) return null;
        return (
          <View key={group.id} style={{ gap: spacing.sm }} testID={`patrol-monitor-group-${group.id}`}>
            <Text style={styles.groupTitle} accessibilityRole="header">{group.label} ({inGroup.length})</Text>
            {inGroup.map((s) => (
              <PatrolMonitorSiteCard key={s.siteId} ctx={ctx} site={s} expanded={expanded.has(s.siteId)} live={live} onToggle={() => toggle(s.siteId)} />
            ))}
          </View>
        );
      })}

      {/* The key to the hour cells, once, whenever a site's hours are open. */}
      {expanded.size ? <MonitorLegend /> : null}
    </View>
  );
}

const styles = {
  dateBar: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm, flexWrap: 'wrap' as const },
  date: { ...typography.panelHeading, color: colors.primaryNavy },
  liveOps: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: spacing.md },
  liveOpsText: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' as const },
  groupTitle: { ...typography.label, color: colors.textSecondary },
};
