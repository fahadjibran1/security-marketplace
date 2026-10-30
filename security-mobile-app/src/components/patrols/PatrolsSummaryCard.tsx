import * as React from 'react';
import { Text, View } from 'react-native';
import { getPatrolOverview } from '../../services/api';
import { Button } from '../ui/Button';
import type { PatrolPermissions } from './patrolAccess';
import { DEFAULT_SITE_ZONE } from './patrolContext';
import { siteTodayKey } from './patrolPresentation';
import { KeyValue, PatrolPanel, ui, usePatrolResource } from './patrolUi';

/**
 * The concise Patrols card on the main Company Dashboard. Renders nothing — and requests nothing — without
 * patrols.view (which also covers the company's switch being off). Every figure is the overview endpoint's.
 */
export function PatrolsSummaryCard({ companyKey, permissions, onOpen }: { companyKey: string; permissions: PatrolPermissions; onOpen: () => void; key?: string }) {
  // #77: today on the site-local basis; across all sites the server judges each site on its own day of this date.
  const today = siteTodayKey(DEFAULT_SITE_ZONE);
  const overview = usePatrolResource(`card|${companyKey}|${today}`, () => getPatrolOverview({ date: today, dateBasis: 'site_local' }), { enabled: permissions.canView, poll: true });
  if (!permissions.canView || overview.failure === 'not_enabled' || overview.failure === 'forbidden') return null;
  const data = overview.data;
  return (
    <View testID="patrols-summary-card">
      <PatrolPanel title="Patrols" subtitle="Today (each site's local day), all sites." right={<Button label="Open Patrol Management" size="sm" variant="secondary" onPress={onOpen} />}>
        {overview.loading && !data ? <Text style={ui.muted}>Loading patrols…</Text> : null}
        {overview.error && !data ? <Text style={ui.muted}>Patrol figures are unavailable right now.</Text> : null}
        {data ? (
          <View style={{ gap: 2 }}>
            <KeyValue label="Live patrols" value={String(data.inProgressNow)} />
            <KeyValue label="Completed today" value={String(data.runsByStatus?.completed ?? 0)} />
            <KeyValue label="Open patrol exceptions" value={String(data.openExceptions)} />
            <KeyValue label="Flagged scans today" value={String(data.flaggedScans)} />
          </View>
        ) : null}
      </PatrolPanel>
    </View>
  );
}
