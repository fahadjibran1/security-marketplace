import * as React from 'react';
import { Text, View } from 'react-native';
import { getPatrolPolicies, listPatrolHolds, listPatrolRoutes } from '../../services/api';
import { StatePanel } from '../StatePanel';
import { DEFAULT_PATROL_SECTION, PATROL_SECTIONS, PATROL_TABS, resolvePatrolTab, visiblePatrolSections, visiblePatrolTabs, type PatrolPermissions, type PatrolSection, type PatrolTab } from './patrolAccess';
import { DEFAULT_SITE_ZONE, type PatrolNavTarget, type PatrolPageContext } from './patrolContext';
import { PatrolCheckpointsTab } from './PatrolCheckpointsTab';
import { PatrolEvidenceBrowser } from './PatrolEvidenceBrowser';
import { PatrolEvidenceTab, PatrolHistoryTab } from './PatrolHistoryTab';
import { PatrolLiveTab } from './PatrolLiveTab';
import { PatrolMonitorTab } from './PatrolMonitorTab';
import { PatrolOverviewTab } from './PatrolOverviewTab';
import { patrolLayout } from './patrolPresentation';
import { PatrolRetentionTab } from './PatrolRetentionTab';
import { PatrolExceptionDetail, PatrolRunDetail } from './PatrolRunDetail';
import { PatrolSchedulesTab } from './PatrolSchedulesTab';
import { PatrolSettingsTab, PatrolStorageTab } from './PatrolSettingsTab';
import { PatrolSetupTab } from './PatrolSetupTab';
import { ChipSelect, Notice, PatrolPanel, ui, usePatrolResource } from './patrolUi';

export type CompanyPatrolsWorkspaceProps = {
  /** The signed-in company. Every patrol read is keyed on it, so a different company never sees another's data. */
  companyKey: string;
  companyName?: string | null;
  permissions: PatrolPermissions;
  layoutWidth: number;
  /** A one-shot request to open a record (Live Operations alert, dashboard card). */
  target?: PatrolNavTarget | null;
  onTargetConsumed?: (requestId: number) => void;
  /** S4 1.2.1: open Live Operations at a patrol exception's alert (its shift). */
  onOpenLiveOperationsAlert?: (target: { alertId: number; shiftId: number | null }) => void;
  key?: string;
};

/**
 * The Patrol Management page (Patrols P1-D). Sections as tabs; every figure from the P1-A/B/C API. Without
 * patrols.view — which the session omits while the company's switch is off — nothing here mounts and nothing is
 * requested. Routine patrols, scans and photos live here; only actionable patrol alerts reach Live Operations.
 *
 * S4 1.3.0 B2: the primary navigation is Setup / Today / Evidence. Advanced holds every earlier tab, unchanged.
 * S4 Patrol Monitor S2: Monitor (one compact card per site) comes first and is the section the page opens on.
 */
export function CompanyPatrolsWorkspace({ companyKey, companyName = null, permissions, layoutWidth, target, onTargetConsumed, onOpenLiveOperationsAlert }: CompanyPatrolsWorkspaceProps) {
  const layout = patrolLayout(layoutWidth);
  const [tab, setTab] = React.useState<PatrolTab | null>(() => resolvePatrolTab('overview', permissions));
  const [section, setSection] = React.useState<PatrolSection>(DEFAULT_PATROL_SECTION);
  const [siteId, setSiteId] = React.useState<number | null>(null);
  const [runId, setRunId] = React.useState<number | null>(null);
  const [exceptionId, setExceptionId] = React.useState<number | null>(null);

  // A different company: drop every piece of page state at once (the reads below are keyed on companyKey too).
  const seenCompany = React.useRef(companyKey);
  React.useEffect(() => {
    if (seenCompany.current === companyKey) return;
    seenCompany.current = companyKey;
    setTab(resolvePatrolTab('overview', permissions));
    setSection(DEFAULT_PATROL_SECTION);
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
    if (target.kind === 'run') { setSection('advanced'); setTab('history'); setExceptionId(null); setRunId(target.runId); }
    else if (target.kind === 'exception') { setSection('today'); setTab('overview'); setRunId(null); setExceptionId(target.exceptionId); }
    else { setSection('today'); setTab(resolvePatrolTab(target.tab, permissions)); }
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
    openLiveOperationsAlert: onOpenLiveOperationsAlert,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [companyKey, companyName, permissions, layout.mode, siteId, sites, policies.data, routes.data, holds.data, onOpenLiveOperationsAlert]);

  if (!enabled || !tab) {
    return <StatePanel title="Patrol Management is not available" message="Patrol Management is not enabled for this company, or your role does not include it." tone="empty" />;
  }
  if (policies.failure === 'not_enabled') {
    return <StatePanel title="Patrol Management is not enabled" message="Patrol Management is not enabled for this company. Contact S4 to turn it on." tone="empty" />;
  }

  const tabs = visiblePatrolTabs(permissions);
  const tabOptions = PATROL_TABS.filter((t) => tabs.includes(t.id)).map((t) => ({ value: t.id, label: t.label }));
  const sections = visiblePatrolSections(permissions);
  const sectionOptions = PATROL_SECTIONS.filter((s) => sections.includes(s.id)).map((s) => ({ value: s.id, label: s.label }));
  const advanced = section === 'advanced';

  return (
    <View style={{ gap: 16 }} testID="patrol-management">
      {/* The dashboard shell already titles the page (NAV_ITEMS label and caption). */}
      <View accessibilityRole="tablist" accessibilityLabel="Patrol Management">
        <ChipSelect options={sectionOptions} value={section} onChange={(v) => setSection(v)} scroll={layout.tabsScroll} />
      </View>
      {advanced ? (
        <View accessibilityRole="tablist" accessibilityLabel="Patrol Management sections">
          <Text style={ui.muted}>Advanced: schedules, checkpoints and routes, history, photos, downloads, retention and holds, site settings and storage.</Text>
          <ChipSelect options={tabOptions} value={tab} onChange={(v) => setTab(v)} scroll={layout.tabsScroll} />
        </View>
      ) : null}
      {section !== 'setup' && section !== 'monitor' && !(advanced && tab === 'settings') ? (
        <ChipSelect
          label="Site"
          scroll
          options={[{ value: 0, label: 'All sites' }, ...sites.map((s) => ({ value: s.siteId, label: s.siteName }))]}
          value={siteId ?? 0}
          onChange={(v) => setSiteId(v ? Number(v) : null)}
        />
      ) : null}
      {policies.error && !policies.data ? <Notice tone="error" message={policies.error} /> : null}
      {siteId && section !== 'monitor' ? <Text style={ui.muted}>Site time: {ctx.siteZone(siteId)}</Text> : null}

      {/* Keyed on the company: a different company starts with no filter, day or open card carried over. */}
      {section === 'monitor' ? <PatrolMonitorTab key={companyKey} ctx={ctx} /> : null}
      {section === 'setup' ? <PatrolSetupTab ctx={ctx} onSelectSite={(id) => setSiteId(id)} /> : null}
      {section === 'today' ? (
        <View style={{ gap: 16 }}>
          <PatrolOverviewTab ctx={ctx} />
          <PatrolPanel title="Live patrols" subtitle="Patrols in progress right now.">
            <PatrolLiveTab ctx={ctx} />
          </PatrolPanel>
        </View>
      ) : null}
      {section === 'evidence' ? <PatrolEvidenceBrowser ctx={ctx} /> : null}

      {advanced && tab === 'overview' ? <PatrolOverviewTab ctx={ctx} /> : null}
      {advanced && tab === 'live' ? <PatrolLiveTab ctx={ctx} /> : null}
      {advanced && tab === 'schedules' ? <PatrolSchedulesTab ctx={ctx} /> : null}
      {advanced && tab === 'checkpoints' ? <PatrolCheckpointsTab ctx={ctx} /> : null}
      {advanced && tab === 'history' ? <PatrolHistoryTab ctx={ctx} /> : null}
      {advanced && tab === 'evidence' && permissions.canViewEvidence ? <PatrolEvidenceTab ctx={ctx} /> : null}
      {advanced && tab === 'retention' ? <PatrolRetentionTab ctx={ctx} /> : null}
      {advanced && tab === 'settings' ? <PatrolSettingsTab ctx={ctx} /> : null}
      {advanced && tab === 'storage' && permissions.canManageHolds ? <PatrolStorageTab ctx={ctx} /> : null}

      <PatrolRunDetail ctx={ctx} runId={runId} onClose={() => setRunId(null)} />
      <PatrolExceptionDetail ctx={ctx} exceptionId={exceptionId} onClose={() => setExceptionId(null)} />
    </View>
  );
}
