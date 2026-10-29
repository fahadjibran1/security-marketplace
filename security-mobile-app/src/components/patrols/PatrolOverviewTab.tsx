import * as React from 'react';
import { Text, View } from 'react-native';
import { getPatrolOverview, listPatrolExceptions, listPatrolRuns } from '../../services/api';
import { KpiCard } from '../ui/KpiCard';
import type { PatrolPageContext } from './patrolContext';
import {
  buildPatrolKpis,
  exceptionTypeLabel,
  formatPatrolDateTime,
  utcDateKey,
} from './patrolPresentation';
import { Badge, Notice, PatrolPanel, ResourceState, RowCard, ui, usePatrolResource } from './patrolUi';

/**
 * Overview: cross-site figures from real responses only (overview, exceptions, today's runs). A figure the API does not
 * provide reads "Not available"; nothing is estimated. Polls modestly while on screen.
 */
export function PatrolOverviewTab({ ctx }: { ctx: PatrolPageContext }) {
  const today = utcDateKey();
  const key = `${ctx.companyKey}|${ctx.siteId ?? 'all'}|${today}`;
  const overview = usePatrolResource(`ov|${key}`, () => getPatrolOverview({ siteId: ctx.siteId, date: today }), { poll: true });
  const exceptions = usePatrolResource(`ex|${key}`, () => listPatrolExceptions({ siteId: ctx.siteId }), { poll: true });
  const todaysRuns = usePatrolResource(`tr|${key}`, () => listPatrolRuns({ siteId: ctx.siteId, from: today, to: today, pageSize: 100 }), { poll: true });

  const kpis = buildPatrolKpis({ overview: overview.data, exceptions: exceptions.data, todaysRuns: todaysRuns.data });
  const open = (exceptions.data ?? []).filter((e) => e.status !== 'resolved').slice(0, 10);
  const state = ResourceState({ resource: overview, empty: false, emptyMessage: '', what: 'the patrol overview' });

  return (
    <View style={{ gap: 16 }}>
      {state}
      {overview.data ? (
        <Text style={ui.muted}>
          Figures for {overview.data.date} (UTC day){ctx.siteId ? ` · ${ctx.siteName(ctx.siteId)}` : ' · all sites'}. Updated every 30 seconds while this page is open.
        </Text>
      ) : null}
      <View style={ui.grid} accessibilityLabel="Patrol KPIs">
        {kpis.map((kpi) => (
          <View key={kpi.id} style={{ flexBasis: `${Math.floor(100 / ctx.layout.kpiColumns) - 2}%`, flexGrow: 1, minWidth: 140 }}>
            <KpiCard label={kpi.label} value={kpi.value} icon="◎" tone={kpi.tone} compact statusText={kpi.available ? undefined : kpi.note} />
          </View>
        ))}
      </View>
      {overview.data ? (
        <Text style={ui.muted}>
          Configured: {overview.data.activeSchedules} active schedule{overview.data.activeSchedules === 1 ? '' : 's'}, {overview.data.activeRoutes} route{overview.data.activeRoutes === 1 ? '' : 's'}, {overview.data.activeCheckpoints} checkpoint{overview.data.activeCheckpoints === 1 ? '' : 's'}.
        </Text>
      ) : null}
      <PatrolPanel title="Open patrol exceptions" subtitle="Actionable exceptions also appear in Live Operations, where they are acknowledged and resolved.">
        {ResourceState({ resource: exceptions, empty: exceptions.data != null && open.length === 0, emptyMessage: 'There are no open patrol exceptions.', what: 'open patrol exceptions' })}
        {exceptions.error && exceptions.data ? <Notice tone="error" message={exceptions.error} /> : null}
        {open.map((e) => (
          <RowCard
            key={e.id}
            accessibilityLabel={`Open exception ${e.id}`}
            onPress={() => (e.runId ? ctx.openRun(e.runId) : ctx.openException(e.id))}
          >
            <View style={ui.actions}>
              <Text style={ui.rowTitle}>{exceptionTypeLabel(e.type)}</Text>
              <Badge label={e.status === 'acknowledged' ? 'Acknowledged' : 'Open'} tone={e.status === 'acknowledged' ? 'info' : 'warning'} />
            </View>
            <Text style={ui.rowMeta}>
              {ctx.siteName(e.siteId)} · window {formatPatrolDateTime(e.windowStart, ctx.siteZone(e.siteId))}–{formatPatrolDateTime(e.windowEnd, ctx.siteZone(e.siteId)).slice(-5)}
            </Text>
            {e.lateEvidenceAt ? <Text style={ui.rowMeta}>Evidence received after the alert — confirm before resolving.</Text> : null}
          </RowCard>
        ))}
      </PatrolPanel>
    </View>
  );
}
