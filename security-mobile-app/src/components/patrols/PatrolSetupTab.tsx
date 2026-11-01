import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import {
  activatePatrolSiteSetup,
  confirmPatrolCheckpoint,
  createPatrolCheckpoint,
  getPatrolCheckpointLabel,
  getPatrolSiteSetup,
  savePatrolSiteSetup,
} from '../../services/api';
import { colors } from '../../theme';
import type { PatrolCheckpointLabel, PatrolSetupCheckpoint, PatrolSiteSetup, PatrolSiteSetupInput } from '../../types/patrols';
import { printIncidentReport } from '../company/incidentReportPrint';
import { StatePanel } from '../StatePanel';
import { Button } from '../ui/Button';
import type { PatrolPageContext } from './patrolContext';
import { formatPatrolDateTime } from './patrolPresentation';
import { isServerLabelPayload, renderLabelSheetHtml } from './patrolQr';
import { PatrolQrCode } from './PatrolQrCode';
import {
  ANCHOR_OPTIONS,
  EVIDENCE_MODE_OPTIONS,
  FREQUENCY_PRESETS,
  SETUP_MODE_OPTIONS,
  activationSummary,
  canActivate,
  draftFromSetup,
  frequencyLabel,
  setupChecklist,
  setupDraftChanged,
  setupDraftProblems,
  setupFailureText,
  type SetupDraft,
} from './patrolSetupText';
import { Badge, ChipSelect, Notice, PatrolPanel, ResourceState, RowCard, TextField, ui, usePatrolResource } from './patrolUi';

type Flash = { tone: 'success' | 'error' | 'info'; message: string } | null;
const OTHER = -1;

/**
 * S4 1.3.0 B2 — the guided site patrol setup (the B1 API: GET / PUT /patrols/sites/:id/setup, POST …/setup/confirm,
 * POST /patrols/checkpoints/:id/confirm). One workflow per site: which shifts patrol, the evidence method (QR only /
 * Photos only / QR + Photos — no photo count), how often and from when (scheduled start by default, Book On as the
 * override), and the checkpoints with their printable labels and authorised test scans. A plain-English checklist sits
 * beside it; Activate stays disabled until every item passes (the server re-checks: 422 PATROL_SETUP_INCOMPLETE).
 * Reading needs patrols.view; every change needs patrols.manage.
 */
export function PatrolSetupTab({ ctx, onSelectSite }: { ctx: PatrolPageContext; onSelectSite: (siteId: number) => void }) {
  const siteId = ctx.siteId ?? ctx.sites[0]?.siteId ?? null;
  const canManage = ctx.permissions.canManage;
  const setup = usePatrolResource(`setup|${ctx.companyKey}|${siteId ?? 'none'}`, () => getPatrolSiteSetup(siteId as number), { enabled: siteId != null });
  const [draft, setDraft] = React.useState<SetupDraft | null>(null);
  const [flash, setFlash] = React.useState<Flash>(null);
  const [busy, setBusy] = React.useState<'save' | 'activate' | 'labels' | 'add' | null>(null);
  const [labels, setLabels] = React.useState<Record<number, PatrolCheckpointLabel>>({});
  const [newCheckpoint, setNewCheckpoint] = React.useState('');
  const [scanFor, setScanFor] = React.useState<number | null>(null);
  const [scanText, setScanText] = React.useState('');
  const [scanBusy, setScanBusy] = React.useState(false);
  const [customFrequency, setCustomFrequency] = React.useState(false);

  // A different site or company: start again from what the server holds.
  React.useEffect(() => {
    setDraft(null); setFlash(null); setLabels({}); setScanFor(null); setScanText(''); setNewCheckpoint(''); setCustomFrequency(false);
  }, [ctx.companyKey, siteId]);
  React.useEffect(() => {
    if (!setup.data) return;
    setDraft((current) => current ?? draftFromSetup(setup.data as PatrolSiteSetup));
    if (setup.data.frequencyMinutes != null && !FREQUENCY_PRESETS.includes(setup.data.frequencyMinutes)) setCustomFrequency(true);
  }, [setup.data]);

  if (!ctx.sites.length) {
    return <StatePanel title="No sites yet" message="Add a site first; patrols are set up per site." tone="empty" />;
  }

  const view = setup.data;
  const state = ResourceState({ resource: setup, empty: false, emptyMessage: '', what: 'the patrol setup' });
  const siteChooser = (
    <ChipSelect
      label="Site to set up"
      scroll
      options={ctx.sites.map((s) => ({ value: s.siteId, label: s.siteName }))}
      value={siteId}
      onChange={(v) => onSelectSite(Number(v))}
    />
  );
  if (!view || !draft) return <View style={{ gap: 12 }}>{siteChooser}{state}</View>;

  const problems = setupDraftProblems(draft);
  const changed = setupDraftChanged(draft, view);
  const rows = setupChecklist(view, changed);
  const ready = canActivate(rows);
  const qr = draft.evidenceMode !== 'photo';
  const savedQr = view.evidenceMode !== 'photo';
  const routes = ctx.routes.filter((r) => r.siteId === siteId && r.kind !== 'auto' && !r.archivedAt && r.active && !r.supersededByRouteId);
  const active = view.checkpoints.filter((c) => c.active && !c.revokedAt);
  const zone = view.timezone || ctx.siteZone(siteId);
  const warnings = (view.warnings ?? []).filter((w) => w.code !== 'SETUP_NOT_ACTIVE');
  const set = (patch: Partial<SetupDraft>) => { setFlash(null); setDraft({ ...draft, ...patch }); };
  const frequencyValue = customFrequency ? OTHER : Number(draft.frequency) || null;

  const save = async () => {
    if (Object.keys(problems).length) { setFlash({ tone: 'error', message: Object.values(problems).join(' ') }); return; }
    setBusy('save'); setFlash(null);
    try {
      const input: PatrolSiteSetupInput = {
        setupMode: draft.setupMode!,
        evidenceMode: draft.evidenceMode!,
        frequencyMinutes: Number(draft.frequency) || view.frequencyMinutes || 60,
        windowAnchor: draft.windowAnchor,
        ...(draft.evidenceMode !== 'photo' && draft.routeId != null ? { routeId: draft.routeId } : {}),
      };
      const saved = await savePatrolSiteSetup(siteId as number, input);
      setDraft(draftFromSetup(saved));
      await setup.reload(true);
      ctx.reloadRoutes();
      setFlash({ tone: 'success', message: saved.active ? 'Saved. The change applies to patrol times from now on.' : 'Saved. Finish the checklist, then activate.' });
    } catch (error) {
      setFlash({ tone: 'error', message: setupFailureText(error, 'Unable to save the patrol setup.') });
    } finally { setBusy(null); }
  };

  const activate = async () => {
    if (!ready) return;
    setBusy('activate'); setFlash(null);
    try {
      await activatePatrolSiteSetup(siteId as number);
      await setup.reload(true);
      ctx.reloadPolicies();
      setFlash({ tone: 'success', message: `Patrols are active at ${view.siteName ?? 'this site'}.` });
    } catch (error) {
      await setup.reload(true);
      setFlash({ tone: 'error', message: setupFailureText(error, 'Unable to activate the patrol setup.') });
    } finally { setBusy(null); }
  };

  const addCheckpoint = async () => {
    const label = newCheckpoint.trim();
    if (!label) { setFlash({ tone: 'error', message: 'Give the checkpoint a name, for example "Main gate".' }); return; }
    setBusy('add'); setFlash(null);
    try {
      await createPatrolCheckpoint({ siteId: siteId as number, label });
      setNewCheckpoint('');
      await setup.reload(true);
      setFlash({ tone: 'success', message: `"${label}" added. Print its label, put it up, then test-scan it.` });
    } catch (error) {
      setFlash({ tone: 'error', message: setupFailureText(error, 'Unable to add this checkpoint.') });
    } finally { setBusy(null); }
  };

  const prepareLabels = async () => {
    setBusy('labels'); setFlash(null);
    const next: Record<number, PatrolCheckpointLabel> = {};
    try {
      for (const cp of active) {
        const label = await getPatrolCheckpointLabel(cp.id);
        if (isServerLabelPayload(label.payload)) next[cp.id] = label;
      }
      setLabels(next);
      if (!Object.keys(next).length) setFlash({ tone: 'info', message: 'There are no checkpoint labels to print yet.' });
    } catch (error) {
      setFlash({ tone: 'error', message: setupFailureText(error, 'Unable to prepare the labels.') });
    } finally { setBusy(null); }
  };

  const printLabels = () => {
    const chosen = Object.values(labels).filter((l) => isServerLabelPayload(l.payload));
    if (!chosen.length) { setFlash({ tone: 'info', message: 'Prepare the labels first.' }); return; }
    if (Platform.OS !== 'web') { setFlash({ tone: 'info', message: 'Printing labels is available in the web dashboard.' }); return; }
    const html = renderLabelSheetHtml(
      chosen.map((l) => ({ label: l.label, siteName: ctx.siteName(l.siteId), payload: l.payload, tokenVersion: l.tokenVersion, checkpointId: l.checkpointId })),
      { companyName: ctx.companyName, generatedAt: formatPatrolDateTime(new Date().toISOString(), zone) },
    );
    if (!printIncidentReport(html)) setFlash({ tone: 'error', message: 'The browser blocked the print window. Allow pop-ups for S4 and try again.' });
  };

  const confirmScan = async (cp: PatrolSetupCheckpoint) => {
    const payload = scanText.trim();
    if (!payload) { setFlash({ tone: 'error', message: 'Scan the printed label (or paste what the scanner read) first.' }); return; }
    setScanBusy(true); setFlash(null);
    try {
      await confirmPatrolCheckpoint(cp.id, { scanPayload: payload, siteId: siteId as number });
      setScanFor(null); setScanText('');
      await setup.reload(true);
      ctx.reloadRoutes();
      setFlash({ tone: 'success', message: `"${cp.label}" confirmed: the label scans correctly and it is part of the patrol route.` });
    } catch (error) {
      setFlash({ tone: 'error', message: setupFailureText(error, 'That scan was not accepted.') });
    } finally { setScanBusy(false); }
  };

  const desktop = ctx.layout.mode === 'desktop';
  const labelCount = Object.keys(labels).length;

  return (
    <View style={{ gap: 12 }} testID="patrol-setup">
      {siteChooser}
      <View style={ui.actions}>
        <Text style={ui.rowTitle}>{view.siteName ?? ctx.siteName(siteId)}</Text>
        {view.active
          ? <Badge label="Patrols active" tone="success" />
          : <Badge label="Not active" tone="pending" />}
        {view.active && view.confirmedAt ? <Text style={ui.muted}>Active since {formatPatrolDateTime(view.confirmedAt, zone)}</Text> : null}
      </View>
      {!canManage ? <Text style={ui.muted}>You can view this setup. Changing it needs the patrols.manage permission (Owner, Admin or Operations).</Text> : null}
      {flash ? <Notice tone={flash.tone} message={flash.message} /> : null}

      <View style={desktop ? { flexDirection: 'row', gap: 16, alignItems: 'flex-start' } : { gap: 12 }}>
        <View style={{ flex: 2, gap: 12, minWidth: 0 }}>
          <PatrolPanel title="1. Which shifts patrol" subtitle="The site default. A shift can still be set to Required or Not Required in the Rota Planner.">
            <ChipSelect options={SETUP_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} value={draft.setupMode} onChange={(v) => set({ setupMode: v })} />
            <Text style={ui.rowMeta}>{SETUP_MODE_OPTIONS.find((o) => o.value === draft.setupMode)?.help ?? 'Not chosen yet.'}</Text>
            {problems.setupMode ? <Text style={[ui.rowMeta, { color: colors.danger }]}>{problems.setupMode}</Text> : null}
          </PatrolPanel>

          <PatrolPanel title="2. Evidence" subtitle="How a Guard proves a patrol.">
            <ChipSelect options={EVIDENCE_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} value={draft.evidenceMode} onChange={(v) => set({ evidenceMode: v })} />
            <Text style={ui.rowMeta}>{EVIDENCE_MODE_OPTIONS.find((o) => o.value === draft.evidenceMode)?.help ?? 'Not chosen yet.'}</Text>
            {problems.evidenceMode ? <Text style={[ui.rowMeta, { color: colors.danger }]}>{problems.evidenceMode}</Text> : null}
            {qr && routes.length ? (
              <ChipSelect
                label="Checkpoints patrolled"
                scroll
                options={[{ value: 0, label: 'Every test-scanned checkpoint' }, ...routes.map((r) => ({ value: r.id, label: `Route: ${r.name}` }))]}
                value={draft.routeId ?? 0}
                onChange={(v) => set({ routeId: Number(v) || null })}
              />
            ) : null}
          </PatrolPanel>

          <PatrolPanel title="3. How often" subtitle="Patrol times are worked out for each shift.">
            <ChipSelect
              label="A patrol is due"
              options={[...FREQUENCY_PRESETS.map((m) => ({ value: m, label: frequencyLabel(m) })), { value: OTHER, label: 'Other' }]}
              value={frequencyValue}
              onChange={(v) => {
                if (v === OTHER) { setCustomFrequency(true); return; }
                setCustomFrequency(false); set({ frequency: String(v) });
              }}
            />
            {customFrequency ? (
              <TextField label="Minutes between patrols" value={draft.frequency} onChangeText={(v) => set({ frequency: v })} placeholder="e.g. 45" helper="Between 15 and 1440 minutes." />
            ) : null}
            {problems.frequency ? <Text style={[ui.rowMeta, { color: colors.danger }]}>{problems.frequency}</Text> : null}
            <ChipSelect label="Counted" options={ANCHOR_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} value={draft.windowAnchor} onChange={(v) => set({ windowAnchor: v })} />
            <Text style={ui.rowMeta}>{ANCHOR_OPTIONS.find((o) => o.value === draft.windowAnchor)?.help}</Text>
          </PatrolPanel>

          {canManage ? (
            <View style={ui.actions}>
              <Button label="Save setup" onPress={() => { void save(); }} loading={busy === 'save'} disabled={!changed || Object.keys(problems).length > 0} />
              {changed ? <Text style={ui.muted}>Unsaved changes.</Text> : <Text style={ui.muted}>Everything above is saved.</Text>}
            </View>
          ) : null}

          {qr || savedQr ? (
            <PatrolPanel
              title="4. Checkpoints"
              subtitle="Print each label, put it up at the checkpoint, then test-scan it. Only test-scanned checkpoints are patrolled."
              right={canManage && active.length ? (
                <View style={ui.actions}>
                  <Button label="Prepare labels" size="sm" variant="secondary" loading={busy === 'labels'} onPress={() => { void prepareLabels(); }} />
                  <Button label={`Print labels${labelCount ? ` (${labelCount})` : ''}`} size="sm" variant="secondary" disabled={!labelCount} onPress={printLabels} />
                </View>
              ) : null}
            >
              {!active.length ? <Text style={ui.muted}>No checkpoints at this site yet.</Text> : null}
              {active.map((cp) => (
                <RowCard key={cp.id}>
                  <View style={ui.actions}>
                    <Text style={ui.rowTitle}>{cp.label}</Text>
                    {cp.confirmed ? <Badge label="Test-scanned" tone="success" /> : <Badge label="Not test-scanned" tone="warning" />}
                    {cp.onCurrentRoute ? <Badge label="On the patrol route" tone="info" /> : null}
                  </View>
                  <Text style={ui.rowMeta}>
                    Label v{cp.tokenVersion}{cp.confirmed && cp.confirmedAt ? ` · confirmed ${formatPatrolDateTime(cp.confirmedAt, zone)}` : ' · print the label and test-scan it to include it'}
                  </Text>
                  {labels[cp.id] ? (
                    <View style={{ alignItems: 'flex-start', gap: 4 }}>
                      <PatrolQrCode payload={labels[cp.id].payload} size={132} />
                      <Text style={ui.muted}>Label v{labels[cp.id].tokenVersion} issued by S4. Included in the next print.</Text>
                    </View>
                  ) : null}
                  {canManage ? (
                    scanFor === cp.id ? (
                      <View style={{ gap: 8 }}>
                        <TextField
                          label={`Test scan of "${cp.label}"`}
                          value={scanText}
                          onChangeText={setScanText}
                          placeholder="Scan the printed label"
                          helper="Scan the label at the checkpoint with a handheld scanner, or paste the text your scanner read. S4 checks it is this checkpoint's current label."
                        />
                        <View style={ui.actions}>
                          <Button label="Confirm scan" size="sm" loading={scanBusy} onPress={() => { void confirmScan(cp); }} />
                          <Button label="Cancel" size="sm" variant="tertiary" onPress={() => { setScanFor(null); setScanText(''); }} />
                        </View>
                      </View>
                    ) : (
                      <View style={ui.actions}>
                        <Button label={cp.confirmed ? 'Test scan again' : 'Test scan'} size="sm" variant={cp.confirmed ? 'tertiary' : 'secondary'} accessibilityLabel={`Test scan ${cp.label}`}
                          onPress={() => { setFlash(null); setScanText(''); setScanFor(cp.id); }} />
                      </View>
                    )
                  ) : null}
                </RowCard>
              ))}
              {canManage ? (
                <View style={{ gap: 8 }}>
                  <TextField label="New checkpoint" value={newCheckpoint} onChangeText={setNewCheckpoint} placeholder="e.g. Main gate" />
                  <View style={ui.actions}><Button label="Add checkpoint" size="sm" variant="secondary" loading={busy === 'add'} onPress={() => { void addCheckpoint(); }} /></View>
                </View>
              ) : null}
              <Text style={ui.muted}>{'Rotating or revoking a label, and custom routes, are under Advanced → Checkpoints & Routes.'}</Text>
            </PatrolPanel>
          ) : null}
        </View>

        <View style={{ flex: 1, gap: 12, minWidth: desktop ? 300 : 0 }}>
          <PatrolPanel title="Activation checklist" subtitle="Everything must be ticked before patrols can start.">
            {rows.map((row) => (
              <View key={row.code} style={ui.actions} accessibilityLabel={`${row.ok ? 'Done' : 'To do'}: ${row.text}`}>
                <Text style={{ color: row.ok ? colors.success : colors.danger, fontWeight: '700' }}>{row.ok ? '✓' : '✗'}</Text>
                <Text style={[ui.rowMeta, { flex: 1, color: colors.textPrimary }]}>{row.text}</Text>
              </View>
            ))}
            {warnings.map((w) => <View key={w.code}><Notice tone="info" message={w.message} /></View>)}
          </PatrolPanel>

          <PatrolPanel title={view.active ? 'In force' : ready ? 'Ready to activate' : 'Activation summary'} subtitle={view.active ? undefined : ready ? 'Check the summary, then activate.' : 'Complete the checklist to activate.'}>
            {(view.active || ready ? activationSummary(view) : []).map((line, i) => <Text key={i} style={[ui.rowMeta, { color: colors.textPrimary }]}>{line}</Text>)}
            {canManage && !view.active ? (
              <Button label="Activate patrols" onPress={() => { void activate(); }} loading={busy === 'activate'} disabled={!ready} accessibilityLabel="Activate patrols" />
            ) : null}
            {canManage && !view.active && !ready ? <Text style={ui.muted}>Activate is available once every checklist item is ticked.</Text> : null}
          </PatrolPanel>
        </View>
      </View>
    </View>
  );
}
