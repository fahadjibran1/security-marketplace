import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import {
  archivePatrolRoute,
  createPatrolCheckpoint,
  createPatrolRoute,
  getPatrolCheckpointLabel,
  listPatrolCheckpoints,
  revokePatrolCheckpoint,
  rotatePatrolCheckpoint,
  updatePatrolCheckpoint,
  updatePatrolRoute,
} from '../../services/api';
import type { PatrolCheckpoint, PatrolCheckpointLabel, PatrolRoute } from '../../types/patrols';
import { printIncidentReport } from '../company/incidentReportPrint';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { Drawer } from '../ui/Drawer';
import { patrolFailureMessage } from './patrolAccess';
import type { PatrolPageContext } from './patrolContext';
import { formatPatrolDateTime } from './patrolPresentation';
import { isServerLabelPayload, renderLabelSheetHtml } from './patrolQr';
import { PatrolQrCode } from './PatrolQrCode';
import { Badge, ChipSelect, Notice, PatrolPanel, ResourceState, RowCard, TextField, Toggle, ui, usePatrolResource } from './patrolUi';

type CheckpointDraft = { id: number | null; siteId: string; label: string; description: string; photoRequired: boolean; active: boolean };
type RouteDraft = { id: number | null; siteId: string; name: string; orderMode: 'any' | 'strict'; checkpointIds: number[]; required: Record<number, boolean> };

/**
 * Checkpoints, routes and printable QR labels. Every change needs patrols.manage, and so does a label: the label is
 * fetched from the server, which signs it — this screen only draws and prints what it was given.
 */
export function PatrolCheckpointsTab({ ctx }: { ctx: PatrolPageContext }) {
  const checkpoints = usePatrolResource(`cp|${ctx.companyKey}|${ctx.siteId ?? 'all'}`, () => listPatrolCheckpoints({ siteId: ctx.siteId, includeInactive: true }));
  const canManage = ctx.permissions.canManage;
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [cpDraft, setCpDraft] = React.useState<CheckpointDraft | null>(null);
  const [routeDraft, setRouteDraft] = React.useState<RouteDraft | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirm, setConfirm] = React.useState<{ kind: 'rotate' | 'revoke' | 'archive-route'; id: number; name: string } | null>(null);
  /** Labels fetched in this visit only (server-signed). Dropped when the company or the page changes. */
  const [labels, setLabels] = React.useState<Record<number, PatrolCheckpointLabel>>({});
  const [labelBusy, setLabelBusy] = React.useState<number | null>(null);
  React.useEffect(() => { setLabels({}); }, [ctx.companyKey]);

  const items = checkpoints.data ?? [];
  const routes = ctx.routes.filter((r) => (ctx.siteId ? r.siteId === ctx.siteId : true));

  const fetchLabel = async (cp: PatrolCheckpoint) => {
    setLabelBusy(cp.id);
    try {
      const label = await getPatrolCheckpointLabel(cp.id);
      if (!isServerLabelPayload(label.payload)) throw new Error('The server did not return a valid checkpoint label.');
      setLabels((all) => ({ ...all, [cp.id]: label }));
    } catch (error) {
      setNotice({ tone: 'error', message: patrolFailureMessage(error, 'Unable to issue this label.') });
    } finally {
      setLabelBusy(null);
    }
  };

  const printLabels = () => {
    const chosen = Object.values(labels).filter((l) => isServerLabelPayload(l.payload));
    if (!chosen.length) { setNotice({ tone: 'info', message: 'Generate at least one label first.' }); return; }
    if (Platform.OS !== 'web') { setNotice({ tone: 'info', message: 'Printing labels is available in the web dashboard.' }); return; }
    const html = renderLabelSheetHtml(
      chosen.map((l) => ({ label: l.label, siteName: ctx.siteName(l.siteId), payload: l.payload, tokenVersion: l.tokenVersion, checkpointId: l.checkpointId })),
      { companyName: ctx.companyName, generatedAt: formatPatrolDateTime(new Date().toISOString(), ctx.siteZone(ctx.siteId)) },
    );
    if (!printIncidentReport(html)) setNotice({ tone: 'error', message: 'The browser blocked the print window. Allow pop-ups for S4 and try again.' });
  };

  const saveCheckpoint = async () => {
    if (!cpDraft) return;
    if (!cpDraft.label.trim()) { setFormError('Give the checkpoint a name.'); return; }
    if (cpDraft.id == null && !Number(cpDraft.siteId)) { setFormError('Choose a site.'); return; }
    setSaving(true); setFormError(null);
    try {
      const payload = { label: cpDraft.label.trim(), description: cpDraft.description.trim() || null, photoRequired: cpDraft.photoRequired };
      if (cpDraft.id == null) await createPatrolCheckpoint({ ...payload, siteId: Number(cpDraft.siteId) });
      else await updatePatrolCheckpoint(cpDraft.id, { ...payload, active: cpDraft.active });
      setNotice({ tone: 'success', message: cpDraft.id == null ? 'Checkpoint created. Generate its label to print it.' : 'Checkpoint saved.' });
      setCpDraft(null);
      await checkpoints.reload(true);
      ctx.reloadRoutes();
    } catch (error) {
      setFormError(patrolFailureMessage(error, 'Unable to save this checkpoint.'));
    } finally { setSaving(false); }
  };

  const saveRoute = async () => {
    if (!routeDraft) return;
    if (!routeDraft.name.trim()) { setFormError('Give the route a name.'); return; }
    if (routeDraft.id == null && !Number(routeDraft.siteId)) { setFormError('Choose a site.'); return; }
    if (!routeDraft.checkpointIds.length) { setFormError('Add at least one checkpoint, in patrol order.'); return; }
    setSaving(true); setFormError(null);
    try {
      const list = routeDraft.checkpointIds.map((checkpointId) => ({ checkpointId, required: routeDraft.required[checkpointId] !== false }));
      if (routeDraft.id == null) await createPatrolRoute({ siteId: Number(routeDraft.siteId), name: routeDraft.name.trim(), orderMode: routeDraft.orderMode, checkpoints: list });
      else await updatePatrolRoute(routeDraft.id, { name: routeDraft.name.trim(), orderMode: routeDraft.orderMode, checkpoints: list });
      setNotice({ tone: 'success', message: routeDraft.id == null ? 'Route created.' : 'Route saved.' });
      setRouteDraft(null);
      ctx.reloadRoutes();
    } catch (error) {
      setFormError(patrolFailureMessage(error, 'Unable to save this route.'));
    } finally { setSaving(false); }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    try {
      if (confirm.kind === 'rotate') {
        await rotatePatrolCheckpoint(confirm.id);
        setLabels((all) => { const next = { ...all }; delete next[confirm.id]; return next; });
        setNotice({ tone: 'success', message: `"${confirm.name}" rotated. Print and replace its label: earlier copies are no longer valid.` });
      } else if (confirm.kind === 'revoke') {
        await revokePatrolCheckpoint(confirm.id);
        setLabels((all) => { const next = { ...all }; delete next[confirm.id]; return next; });
        setNotice({ tone: 'success', message: `"${confirm.name}" revoked. Scans of its label are now flagged.` });
      } else {
        await archivePatrolRoute(confirm.id);
        setNotice({ tone: 'success', message: `Route "${confirm.name}" archived.` });
      }
      await checkpoints.reload(true);
      ctx.reloadRoutes();
    } catch (error) {
      setNotice({ tone: 'error', message: patrolFailureMessage(error, 'Unable to complete this change.') });
    } finally { setConfirm(null); }
  };

  const routeSiteId = routeDraft ? Number(routeDraft.siteId) || null : null;
  const routeCandidates = items.filter((c) => c.siteId === routeSiteId && c.active && !c.revokedAt);
  const labelCount = Object.keys(labels).length;

  return (
    <View style={{ gap: 12 }}>
      {notice ? <Notice tone={notice.tone} message={notice.message} /> : null}
      {!canManage ? <Text style={ui.muted}>You can view checkpoints and routes. Changes and labels need the patrols.manage permission (Owner, Admin or Operations).</Text> : null}

      <PatrolPanel
        title="Checkpoints"
        subtitle="Each checkpoint has a signed QR label. Scanning a label records that the label was scanned."
        right={canManage ? (
          <View style={ui.actions}>
            <Button label="New checkpoint" size="sm" onPress={() => { setFormError(null); setCpDraft({ id: null, siteId: ctx.siteId ? String(ctx.siteId) : '', label: '', description: '', photoRequired: false, active: true }); }} />
            <Button label={`Print labels${labelCount ? ` (${labelCount})` : ''}`} size="sm" variant="secondary" onPress={printLabels} disabled={!labelCount} />
          </View>
        ) : null}
      >
        {ResourceState({ resource: checkpoints, empty: checkpoints.data != null && items.length === 0, emptyMessage: 'No checkpoints yet.', what: 'checkpoints' })}
        {items.map((cp) => {
          const label = labels[cp.id];
          const usable = cp.active && !cp.revokedAt;
          return (
            <RowCard key={cp.id}>
              <View style={ui.actions}>
                <Text style={ui.rowTitle}>{cp.label}</Text>
                <Badge label={cp.revokedAt ? 'Revoked' : cp.active ? 'Active' : 'Inactive'} tone={cp.revokedAt ? 'danger' : cp.active ? 'success' : 'pending'} />
                {cp.photoRequired ? <Badge label="Photo required" tone="info" /> : null}
              </View>
              <Text style={ui.rowMeta}>{ctx.siteName(cp.siteId)} · label v{cp.tokenVersion}{cp.rotatedAt ? ` · rotated ${formatPatrolDateTime(cp.rotatedAt, ctx.siteZone(cp.siteId))}` : ''}</Text>
              {cp.description ? <Text style={ui.rowMeta}>{cp.description}</Text> : null}
              {label ? (
                <View style={{ alignItems: 'flex-start', gap: 4 }}>
                  <PatrolQrCode payload={label.payload} size={140} />
                  <Text style={ui.muted}>Label v{label.tokenVersion} issued by S4. Included in the next print.</Text>
                </View>
              ) : null}
              {canManage ? (
                <View style={ui.actions}>
                  {usable ? <Button label={label ? 'Label ready' : 'Generate label'} size="sm" variant="secondary" disabled={Boolean(label)} loading={labelBusy === cp.id} onPress={() => { void fetchLabel(cp); }} /> : null}
                  {!cp.revokedAt ? <Button label="Edit" size="sm" variant="tertiary" onPress={() => { setFormError(null); setCpDraft({ id: cp.id, siteId: String(cp.siteId), label: cp.label, description: cp.description ?? '', photoRequired: cp.photoRequired, active: cp.active }); }} /> : null}
                  {usable ? <Button label="Rotate label" size="sm" variant="tertiary" onPress={() => setConfirm({ kind: 'rotate', id: cp.id, name: cp.label })} /> : null}
                  {!cp.revokedAt ? <Button label="Revoke" size="sm" variant="danger" onPress={() => setConfirm({ kind: 'revoke', id: cp.id, name: cp.label })} /> : null}
                </View>
              ) : null}
            </RowCard>
          );
        })}
      </PatrolPanel>

      <PatrolPanel
        title="Routes"
        subtitle="An ordered list of checkpoints. Strict order flags out-of-order scans; any order accepts them."
        right={canManage ? <Button label="New route" size="sm" onPress={() => { setFormError(null); setRouteDraft({ id: null, siteId: ctx.siteId ? String(ctx.siteId) : '', name: '', orderMode: 'any', checkpointIds: [], required: {} }); }} /> : null}
      >
        {routes.length === 0 ? <Text style={ui.muted}>No routes yet. A patrol without a route may scan any of the site's checkpoints.</Text> : null}
        {routes.map((route: PatrolRoute) => (
          <RowCard key={route.id}>
            <View style={ui.actions}>
              <Text style={ui.rowTitle}>{route.name}</Text>
              <Badge label={route.archivedAt ? 'Archived' : route.active ? 'Active' : 'Inactive'} tone={route.archivedAt ? 'neutral' : route.active ? 'success' : 'pending'} />
              <Badge label={route.orderMode === 'strict' ? 'Strict order' : 'Any order'} tone="neutral" />
            </View>
            <Text style={ui.rowMeta}>{ctx.siteName(route.siteId)} · {(route.checkpoints ?? []).length} checkpoint{(route.checkpoints ?? []).length === 1 ? '' : 's'}</Text>
            <Text style={ui.rowMeta}>{(route.checkpoints ?? []).map((c) => `${c.position}. ${c.label}${c.required ? '' : ' (optional)'}${c.revoked ? ' (revoked)' : ''}`).join('  ·  ')}</Text>
            {canManage && !route.archivedAt ? (
              <View style={ui.actions}>
                <Button label="Edit" size="sm" variant="secondary" onPress={() => {
                  setFormError(null);
                  const list = route.checkpoints ?? [];
                  setRouteDraft({ id: route.id, siteId: String(route.siteId), name: route.name, orderMode: route.orderMode, checkpointIds: list.map((c) => c.checkpointId), required: Object.fromEntries(list.map((c) => [c.checkpointId, c.required])) });
                }} />
                <Button label="Archive" size="sm" variant="tertiary" onPress={() => setConfirm({ kind: 'archive-route', id: route.id, name: route.name })} />
              </View>
            ) : null}
          </RowCard>
        ))}
      </PatrolPanel>

      <Drawer visible={Boolean(cpDraft)} onClose={() => setCpDraft(null)} title={cpDraft?.id == null ? 'New checkpoint' : 'Edit checkpoint'}
        footer={<View style={ui.actions}><Button label="Cancel" variant="secondary" onPress={() => setCpDraft(null)} /><Button label="Save checkpoint" loading={saving} onPress={() => { void saveCheckpoint(); }} /></View>}>
        {cpDraft ? (
          <View style={{ gap: 12 }}>
            {formError ? <Notice tone="error" message={formError} /> : null}
            {cpDraft.id == null ? <ChipSelect label="Site" options={ctx.sites.map((s) => ({ value: String(s.siteId), label: s.siteName }))} value={cpDraft.siteId || null} onChange={(v) => setCpDraft({ ...cpDraft, siteId: v })} /> : <Text style={ui.rowMeta}>Site: {ctx.siteName(Number(cpDraft.siteId))}</Text>}
            <TextField label="Checkpoint name" value={cpDraft.label} onChangeText={(v) => setCpDraft({ ...cpDraft, label: v })} />
            <TextField label="Description (optional)" value={cpDraft.description} onChangeText={(v) => setCpDraft({ ...cpDraft, description: v })} multiline />
            <Toggle label="A photo is required at this checkpoint" value={cpDraft.photoRequired} onChange={(v) => setCpDraft({ ...cpDraft, photoRequired: v })} />
            {cpDraft.id != null ? <Toggle label="Active" value={cpDraft.active} onChange={(v) => setCpDraft({ ...cpDraft, active: v })} /> : null}
            <Text style={ui.muted}>Location-based verification is disabled, so a checkpoint has no map position.</Text>
          </View>
        ) : null}
      </Drawer>

      <Drawer visible={Boolean(routeDraft)} onClose={() => setRouteDraft(null)} title={routeDraft?.id == null ? 'New route' : 'Edit route'} width={560}
        footer={<View style={ui.actions}><Button label="Cancel" variant="secondary" onPress={() => setRouteDraft(null)} /><Button label="Save route" loading={saving} onPress={() => { void saveRoute(); }} /></View>}>
        {routeDraft ? (
          <View style={{ gap: 12 }}>
            {formError ? <Notice tone="error" message={formError} /> : null}
            {routeDraft.id == null ? <ChipSelect label="Site" options={ctx.sites.map((s) => ({ value: String(s.siteId), label: s.siteName }))} value={routeDraft.siteId || null} onChange={(v) => setRouteDraft({ ...routeDraft, siteId: v, checkpointIds: [], required: {} })} /> : <Text style={ui.rowMeta}>Site: {ctx.siteName(Number(routeDraft.siteId))}</Text>}
            <TextField label="Route name" value={routeDraft.name} onChangeText={(v) => setRouteDraft({ ...routeDraft, name: v })} />
            <ChipSelect label="Order" options={[{ value: 'any', label: 'Any order' }, { value: 'strict', label: 'Strict order' }]} value={routeDraft.orderMode} onChange={(v) => setRouteDraft({ ...routeDraft, orderMode: v as 'any' | 'strict' })} />
            <Text style={ui.fieldLabel}>Checkpoints in patrol order</Text>
            {routeDraft.checkpointIds.map((id, index) => {
              const cp = items.find((c) => c.id === id);
              return (
                <View key={id} style={ui.actions}>
                  <Text style={ui.rowMeta}>{index + 1}. {cp?.label ?? `#${id}`}</Text>
                  <Toggle label="Required" value={routeDraft.required[id] !== false} onChange={(v) => setRouteDraft({ ...routeDraft, required: { ...routeDraft.required, [id]: v } })} />
                  {index > 0 ? <Button label="Up" size="sm" variant="tertiary" onPress={() => { const next = [...routeDraft.checkpointIds]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setRouteDraft({ ...routeDraft, checkpointIds: next }); }} /> : null}
                  <Button label="Remove" size="sm" variant="tertiary" onPress={() => setRouteDraft({ ...routeDraft, checkpointIds: routeDraft.checkpointIds.filter((x) => x !== id) })} />
                </View>
              );
            })}
            {routeSiteId ? (
              <ChipSelect label="Add a checkpoint" options={routeCandidates.filter((c) => !routeDraft.checkpointIds.includes(c.id)).map((c) => ({ value: c.id, label: c.label }))} value={null} onChange={(v) => setRouteDraft({ ...routeDraft, checkpointIds: [...routeDraft.checkpointIds, Number(v)] })} />
            ) : <Text style={ui.muted}>Choose a site first.</Text>}
          </View>
        ) : null}
      </Drawer>

      <ConfirmationDialog
        visible={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        onConfirm={() => { void runConfirm(); }}
        title={confirm?.kind === 'rotate' ? 'Rotate this label?' : confirm?.kind === 'revoke' ? 'Revoke this checkpoint?' : 'Archive this route?'}
        message={confirm?.kind === 'rotate'
          ? 'A new label version is issued. Every printed copy of the current label stops verifying, so print and replace it.'
          : confirm?.kind === 'revoke'
            ? 'Scans of this checkpoint will be flagged. This cannot be undone; create a new checkpoint instead.'
            : 'Schedules using this route keep their history. The route can no longer be chosen.'}
        confirmLabel={confirm?.kind === 'rotate' ? 'Rotate' : confirm?.kind === 'revoke' ? 'Revoke' : 'Archive'}
        variant="danger"
      />
    </View>
  );
}
