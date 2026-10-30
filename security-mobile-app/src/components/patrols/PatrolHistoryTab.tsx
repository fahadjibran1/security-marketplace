import * as React from 'react';
import { Text, View } from 'react-native';
import { listPatrolRuns, listPatrolRunEvidence } from '../../services/api';
import { PATROL_RUN_STATUSES, type PatrolRunStatus } from '../../types/patrols';
import { Button } from '../ui/Button';
import type { PatrolPageContext } from './patrolContext';
import { PatrolEvidenceList } from './PatrolEvidenceList';
import { formatPatrolDateTime, runCheckpointProgress, runFlagBadges, runStatusLabel, runTone, verificationLabel } from './patrolPresentation';
import { Badge, BadgeRow, ChipSelect, Notice, PatrolPanel, ResourceState, RowCard, TextField, ui, usePatrolResource } from './patrolUi';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_SIZE = 25;

type Filters = { from: string; to: string; status: PatrolRunStatus | '' };

function useRunPage(ctx: PatrolPageContext, filters: Filters, page: number) {
  const from = DATE_ONLY.test(filters.from.trim()) ? filters.from.trim() : null;
  const to = DATE_ONLY.test(filters.to.trim()) ? filters.to.trim() : null;
  return usePatrolResource(
    `hist|${ctx.companyKey}|${ctx.siteId ?? 'all'}|${from}|${to}|${filters.status}|${page}`,
    () => listPatrolRuns({ siteId: ctx.siteId, from, to, status: filters.status || null, page, pageSize: PAGE_SIZE }),
  );
}

function RunFilters({ filters, setFilters }: { filters: Filters; setFilters: (f: Filters) => void }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={ui.grid}>
        <View style={{ flexGrow: 1, minWidth: 160 }}><TextField label="From (YYYY-MM-DD, UTC)" value={filters.from} onChangeText={(v) => setFilters({ ...filters, from: v })} /></View>
        <View style={{ flexGrow: 1, minWidth: 160 }}><TextField label="To (YYYY-MM-DD, UTC)" value={filters.to} onChangeText={(v) => setFilters({ ...filters, to: v })} /></View>
      </View>
      <ChipSelect
        label="Status"
        scroll
        options={[{ value: '', label: 'All' }, ...PATROL_RUN_STATUSES.map((s) => ({ value: s, label: runStatusLabel(s) }))]}
        value={filters.status}
        onChange={(v) => setFilters({ ...filters, status: v as Filters['status'] })}
      />
    </View>
  );
}

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <View style={ui.actions}>
      <Button label="Previous" size="sm" variant="secondary" disabled={page <= 1} onPress={() => onPage(page - 1)} />
      <Text style={ui.rowMeta}>Page {page} of {pages} · {total} patrol{total === 1 ? '' : 's'}</Text>
      <Button label="Next" size="sm" variant="secondary" disabled={page >= pages} onPress={() => onPage(page + 1)} />
    </View>
  );
}

/** History: paginated runs filtered by site (page filter), date range and status. Each opens the run detail. */
export function PatrolHistoryTab({ ctx }: { ctx: PatrolPageContext }) {
  const [filters, setFilters] = React.useState<Filters>({ from: '', to: '', status: '' });
  const [page, setPage] = React.useState(1);
  React.useEffect(() => { setPage(1); }, [filters.from, filters.to, filters.status, ctx.siteId, ctx.companyKey]);
  const runs = useRunPage(ctx, filters, page);
  const items = runs.data?.items ?? [];
  return (
    <View style={{ gap: 12 }}>
      <RunFilters filters={filters} setFilters={setFilters} />
      {ResourceState({ resource: runs, empty: runs.data != null && items.length === 0, emptyMessage: 'No patrols match these filters.', what: 'patrols' })}
      {runs.error && runs.data ? <Notice tone="error" message={runs.error} /> : null}
      {items.map((run) => (
        <RowCard key={run.id} accessibilityLabel={`Open patrol ${run.id}`} onPress={() => ctx.openRun(run.id)}>
          <View style={ui.actions}>
            <Text style={ui.rowTitle}>#{run.id} · {run.siteName || ctx.siteName(run.siteId)}</Text>
            <Badge label={runStatusLabel(run.status)} tone={runTone(run)} />
            <Badge label={verificationLabel(run.verificationStatus)} tone={run.verificationStatus === 'verified' ? 'success' : run.verificationStatus === 'flagged' ? 'danger' : 'pending'} />
          </View>
          <Text style={ui.rowMeta}>{run.guardName || `Guard #${run.guardId}`} · started {formatPatrolDateTime(run.startedAtServer, ctx.siteZone(run.siteId))} · {runCheckpointProgress(run)?.label ?? 'Checkpoint progress not reported'}</Text>
          <BadgeRow badges={runFlagBadges(run)} />
        </RowCard>
      ))}
      {runs.data && runs.data.total > 0 ? <Pager page={page} total={runs.data.total} onPage={setPage} /> : null}
    </View>
  );
}

/**
 * Photographic Evidence: pick a patrol, see its photos (metadata, status, retention, hold) and view one on demand
 * through the short-lived audited link. Mounted only with patrols.evidence.
 */
export function PatrolEvidenceTab({ ctx }: { ctx: PatrolPageContext }) {
  const [filters, setFilters] = React.useState<Filters>({ from: '', to: '', status: '' });
  const [page, setPage] = React.useState(1);
  const [runId, setRunId] = React.useState<number | null>(null);
  React.useEffect(() => { setPage(1); setRunId(null); }, [filters.from, filters.to, filters.status, ctx.siteId, ctx.companyKey]);
  const runs = useRunPage(ctx, filters, page);
  const allowed = ctx.permissions.canViewEvidence;
  const evidence = usePatrolResource(`evid|${ctx.companyKey}|${runId ?? 'none'}`, () => listPatrolRunEvidence(runId as number), { enabled: allowed && runId != null });
  if (!allowed) return null;
  const items = runs.data?.items ?? [];
  const selected = items.find((r) => r.id === runId) ?? null;
  return (
    <View style={{ gap: 12 }}>
      <Text style={ui.muted}>Photos open through a short-lived link and each view is recorded. Links are never saved.</Text>
      <RunFilters filters={filters} setFilters={setFilters} />
      {ResourceState({ resource: runs, empty: runs.data != null && items.length === 0, emptyMessage: 'No patrols match these filters.', what: 'patrols' })}
      <View style={ctx.layout.mode === 'desktop' ? { flexDirection: 'row', gap: 16, alignItems: 'flex-start' } : { gap: 12 }}>
        <View style={{ flex: 1, gap: 8, minWidth: 260 }}>
          {items.map((run) => (
            <RowCard key={run.id} accessibilityLabel={`Show photos of patrol ${run.id}`} onPress={() => setRunId(run.id)}>
              <View style={ui.actions}>
                <Text style={ui.rowTitle}>#{run.id} · {run.siteName || ctx.siteName(run.siteId)}</Text>
                {run.id === runId ? <Badge label="Selected" tone="info" /> : null}
              </View>
              <Text style={ui.rowMeta}>{run.guardName || `Guard #${run.guardId}`} · {formatPatrolDateTime(run.startedAtServer, ctx.siteZone(run.siteId))} · {verificationLabel(run.verificationStatus)}</Text>
            </RowCard>
          ))}
          {runs.data && runs.data.total > 0 ? <Pager page={page} total={runs.data.total} onPage={setPage} /> : null}
        </View>
        <View style={{ flex: 1, minWidth: 260 }}>
          <PatrolPanel title={selected ? `Photos of patrol #${selected.id}` : 'Photos'} subtitle={selected ? ctx.siteName(selected.siteId) : 'Choose a patrol to see its photos.'}>
            {runId != null ? ResourceState({ resource: evidence, empty: false, emptyMessage: '', what: 'photo evidence' }) : null}
            {selected && evidence.data ? <PatrolEvidenceList ctx={ctx} run={selected} evidence={evidence.data} /> : null}
          </PatrolPanel>
        </View>
      </View>
    </View>
  );
}
