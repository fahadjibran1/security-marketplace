import * as React from 'react';
import { Text, View } from 'react-native';
import { getPatrolPolicies, listPatrolHolds, listPatrolRoutes } from '../../services/api';
import { StatePanel } from '../StatePanel';
import { PATROL_TABS, resolvePatrolTab, visiblePatrolTabs, type PatrolPermissions, type PatrolTab } from './patrolAccess';
import { DEFAULT_SITE_ZONE, type PatrolNavTarget, type PatrolPageContext } from './patrolContext';
import { PatrolCheckpointsTab } from './PatrolCheckpointsTab';
import { PatrolEvidenceTab, PatrolHistoryTab } from './PatrolHistoryTab';
import { PatrolLiveTab } from './PatrolLiveTab';
import { PatrolOverviewTab } from './PatrolOverviewTab';
import { patrolLayout } from './patrolPresentation';
import { PatrolRetentionTab } from './PatrolRetentionTab';
import { PatrolExceptionDetail, PatrolRunDetail } from './PatrolRunDetail';
import { PatrolSchedulesTab } from './PatrolSchedulesTab';
import { PatrolSettingsTab, PatrolStorageTab } from './PatrolSettingsTab';
import { ChipSelect, Notice, ui, usePatrolResource } from './patrolUi';

export type CompanyPatrolsWorkspaceProps = {
  /** The signed-in company. Every patrol read is keyed on it, so a different company never sees another's data. */
  companyKey: string;
  companyName?: string | null;
  permissions: PatrolPermissions;
  layoutWidth: number;
  /** A one-shot request to open a record (Live Operations alert, dashboard card). */
  target?: PatrolNavTarget | null;
  onTargetConsumed?: (requestId: number) => void;
  key?: string;
};

/**
 * The Patrol Management page (Patrols P1-D). Sections as tabs; every figure from the P1-A/B/C API. Without
 * patrols.view — which the session omits while the company's switch is off — nothing here mounts and nothing is
 * requested. Routine patrols, scans and photos live here; only actionable patrol alerts reach Live Operations.
 */
export function CompanyPatrolsWorkspace({ companyKey, companyName = null, permissions, layoutWidth, target, onTargetConsumed }: CompanyPatrolsWorkspaceProps) {
  const layout = patrolLayout(layoutWidth);
  const [tab, setTab] = React.useState<PatrolTab | null>(() => resolvePatrolTab('overview', permissions));
  const [siteId, setSiteId] = React.useState<number | null>(null);
  const [runId, setRunId] = React.useState<number | null>(null);
  const [exceptionId, setExceptionId] = React.useState<number | null>(null);

  // A different company: drop every piece of page state at once (the reads below are keyed on companyKey too).
  const seenCompany = React.useRef(companyKey);
  React.useEffect(() => {
    if (seenCompany.current === companyKey) return;
    seenCompany.current = companyKey;
    setTab(resolvePatrolTab('overview', permissions));
    setSiteId(null);
    setRunId(null);
    setExceptionId(null);
  }, [companyKey, permissions]);

  // Permissions can shrink (a session refresh): never stay on a tab that is no longer allowed.
  React.useEffect(() => { setTab((current) => resolvePatrolTab(current, permissions)); }, [permissions]);

  const enabled = permissions.canView;
  const policies = usePatrolResource(`pol|${companyKey}`, () => getPatrolPolicies(), { enabled });
  const routes = usePatrolResource(`routes|${companyKey}`, () => listPatrolRoutes({ includeInactive: true }), { enabled });
  const holds = usePatrolResource(`activeHolds|${companyKey}`, () => listPatrolHolds('active'), { enabled: enabled && permissions.canManageHolds });

  // Live Operations → the patrol record. One-shot: consumed once, never replayed.
  React.useEffect(() => {
    if (!target || !enabled) return;
    if (target.kind === 'run') { setTab('history'); setExceptionId(null); setRunId(target.runId); }
    else if (target.kind === 'exception') { setTab('overview'); setRunId(null); setExceptionId(target.exceptionId); }
    else setTab(resolvePatrolTab(target.tab, permissions));
    onTargetConsumed?.(target.requestId);
  }, [target, enabled, onTargetConsumed, permissions]);

  const sites = policies.data?.sites ?? [];
  const ctx: PatrolPageContext = React.useMemo(() => ({
    companyKey,
    companyName,
    permissions,
    layout,
    siteId,
    sites,
    policies: policies.data,
    siteName: (id) => (id == null ? 'All sites' : sites.find((s) => s.siteId === id)?.siteName ?? `Site #${id}`),
    siteZone: (id) => (id == null ? DEFAULT_SITE_ZONE : sites.find((s) => s.siteId === id)?.timezone || DEFAULT_SITE_ZONE),
    routes: routes.data ?? [],
    holds: permissions.canManageHolds ? holds.data : null,
    reloadPolicies: () => { void policies.reload(true); },
    reloadRoutes: () => { void routes.reload(true); },
    reloadHolds: () => { void holds.reload(true); },
    openRun: (id) => { setExceptionId(null); setRunId(id); },
    openException: (id) => { setRunId(null); setExceptionId(id); },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [companyKey, companyName, permissions, layout.mode, siteId, sites, policies.data, routes.data, holds.data]);

  if (!enabled || !tab) {
    return <StatePanel title="Patrol Management is not available" message="Patrol Management is not enabled for this company, or your role does not include it." tone="empty" />;
  }
  if (policies.failure === 'not_enabled') {
    return <StatePanel title="Patrol Management is not enabled" message="Patrol Management is not enabled for this company. Contact S4 to turn it on." tone="empty" />;
  }

  const tabs = visiblePatrolTabs(permissions);
  const tabOptions = PATROL_TABS.filter((t) => tabs.includes(t.id)).map((t) => ({ value: t.id, label: t.label }));

  return (
    <View style={{ gap: 16 }} testID="patrol-management">
      {/* The dashboard shell already titles the page (NAV_ITEMS label and caption). */}
      <View accessibilityRole="tablist" accessibilityLabel="Patrol Management sections">
        <ChipSelect options={tabOptions} value={tab} onChange={(v) => setTab(v)} scroll={layout.tabsScroll} />
      </View>
      {tab !== 'settings' ? (
        <ChipSelect
          label="Site"
          scroll
          options={[{ value: 0, label: 'All sites' }, ...sites.map((s) => ({ value: s.siteId, label: s.siteName }))]}
          value={siteId ?? 0}
          onChange={(v) => setSiteId(v ? Number(v) : null)}
        />
      ) : null}
      {policies.error && !policies.data ? <Notice tone="error" message={policies.error} /> : null}
      {siteId ? <Text style={ui.muted}>Site time: {ctx.siteZone(siteId)}</Text> : null}

      {tab === 'overview' ? <PatrolOverviewTab ctx={ctx} /> : null}
      {tab === 'live' ? <PatrolLiveTab ctx={ctx} /> : null}
      {tab === 'schedules' ? <PatrolSchedulesTab ctx={ctx} /> : null}
      {tab === 'checkpoints' ? <PatrolCheckpointsTab ctx={ctx} /> : null}
      {tab === 'history' ? <PatrolHistoryTab ctx={ctx} /> : null}
      {tab === 'evidence' && permissions.canViewEvidence ? <PatrolEvidenceTab ctx={ctx} /> : null}
      {tab === 'retention' ? <PatrolRetentionTab ctx={ctx} /> : null}
      {tab === 'settings' ? <PatrolSettingsTab ctx={ctx} /> : null}
      {tab === 'storage' && permissions.canManageHolds ? <PatrolStorageTab ctx={ctx} /> : null}

      <PatrolRunDetail ctx={ctx} runId={runId} onClose={() => setRunId(null)} />
      <PatrolExceptionDetail ctx={ctx} exceptionId={exceptionId} onClose={() => setExceptionId(null)} />
    </View>
  );
}
