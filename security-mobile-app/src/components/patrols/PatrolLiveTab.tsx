import * as React from 'react';
import { Text, View } from 'react-native';
import { listPatrolRuns } from '../../services/api';
import type { PatrolPageContext } from './patrolContext';
import {
  formatClockDrift,
  formatPatrolDateTime,
  pendingSyncLabel,
  runCheckpointProgress,
  runFlagBadges,
  verificationLabel,
} from './patrolPresentation';
import { Badge, BadgeRow, Notice, ResourceState, RowCard, ui, usePatrolResource } from './patrolUi';

/** Live Patrols: runs in progress, with checkpoint progress, flags and pending-sync state. Polls while on screen. */
export function PatrolLiveTab({ ctx }: { ctx: PatrolPageContext }) {
  const runs = usePatrolResource(
    `live|${ctx.companyKey}|${ctx.siteId ?? 'all'}`,
    () => listPatrolRuns({ siteId: ctx.siteId, status: 'in_progress', pageSize: 100 }),
    { poll: true },
  );
  const items = runs.data?.items ?? [];
  return (
    <View style={{ gap: 12 }}>
      {ResourceState({ resource: runs, empty: runs.data != null && items.length === 0, emptyMessage: 'No patrol is in progress right now.', what: 'live patrols' })}
      {runs.error && runs.data ? <Notice tone="error" message={runs.error} /> : null}
      {runs.data && runs.data.total > items.length ? <Text style={ui.muted}>Showing {items.length} of {runs.data.total} live patrols.</Text> : null}
      {items.map((run) => {
        const progress = runCheckpointProgress(run);
        const pending = pendingSyncLabel(run);
        const zone = ctx.siteZone(run.siteId);
        return (
          <RowCard key={run.id} accessibilityLabel={`Open patrol ${run.id}`} onPress={() => ctx.openRun(run.id)}>
            <View style={ui.actions}>
              <Text style={ui.rowTitle}>{run.guardName || `Guard #${run.guardId}`} · {run.siteName || ctx.siteName(run.siteId)}</Text>
              <Badge label="In progress" tone="info" />
              <Badge label={verificationLabel(run.verificationStatus)} tone={run.verificationStatus === 'flagged' ? 'danger' : 'pending'} />
            </View>
            <Text style={ui.rowMeta} accessibilityLabel="Checkpoint progress">{progress ? progress.label : 'Checkpoint progress not reported'}{run.flaggedVisitCount ? ` · ${run.flaggedVisitCount} flagged scan${run.flaggedVisitCount === 1 ? '' : 's'}` : ''}</Text>
            <Text style={ui.rowMeta}>Started {formatPatrolDateTime(run.startedAtDevice, zone)} (device) · received {formatPatrolDateTime(run.startedAtServer, zone)} (S4)</Text>
            {run.clockDriftMs != null && Math.abs(run.clockDriftMs) >= 1000 ? <Text style={ui.rowMeta}>{formatClockDrift(run.clockDriftMs)}</Text> : null}
            <BadgeRow badges={runFlagBadges(run)} />
            {pending ? <Text style={ui.rowMeta} accessibilityLabel="Pending sync">{pending}</Text> : null}
          </RowCard>
        );
      })}
    </View>
  );
}
