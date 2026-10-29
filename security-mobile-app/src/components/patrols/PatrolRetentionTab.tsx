import * as React from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { getPatrolExportLink, listPatrolExports, listPatrolHolds, placePatrolHold, releasePatrolHold, requestPatrolExport } from '../../services/api';
import { PATROL_EXPORT_PURPOSES, type PatrolExport, type PatrolExportPurpose, type PatrolHold } from '../../types/patrols';
import { Button } from '../ui/Button';
import { patrolFailureMessage } from './patrolAccess';
import type { PatrolPageContext } from './patrolContext';
import {
  exportDraftProblem,
  exportStatusLabel,
  formatBytes,
  formatPatrolDateTime,
  holdDraftProblem,
  holdReasonProblem,
  holdScopeLabel,
  signedLinkUsable,
  type HoldDraft,
} from './patrolPresentation';
import { Badge, ChipSelect, KeyValue, Notice, PatrolPanel, ResourceState, RowCard, TextField, ui, usePatrolResource } from './patrolUi';

const PURPOSE_LABELS: Record<PatrolExportPurpose, string> = {
  incident: 'Incident', investigation: 'Investigation', client_request: 'Client request', legal: 'Legal', audit: 'Audit', other: 'Other',
};

/**
 * Open a short-lived link without keeping it. On web the tab opens inside the click (so pop-up blockers allow it) and
 * is navigated once the link arrives; the link is never written anywhere else.
 */
function beginOpenLink(): { ok: boolean; finish: (url: string) => void; abandon: () => void } {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.open === 'function') {
    const tab = window.open('', '_blank');
    if (!tab) return { ok: false, finish: () => undefined, abandon: () => undefined };
    try { tab.opener = null; } catch { /* same-origin about:blank until navigated */ }
    return { ok: true, finish: (url) => { tab.location.href = url; }, abandon: () => tab.close() };
  }
  return { ok: true, finish: (url) => { Linking.openURL(url).catch(() => undefined); }, abandon: () => undefined };
}

/**
 * Downloads, retention & holds. Everyone with patrols.view reads the retention period; holds and bulk exports need
 * patrols.holds (Owner / Admin). Retention is changed in Site settings (90 days by an Owner or Admin only).
 */
export function PatrolRetentionTab({ ctx }: { ctx: PatrolPageContext }) {
  const canHolds = ctx.permissions.canManageHolds;
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'error' | 'info'; message: string } | null>(null);

  return (
    <View style={{ gap: 12 }}>
      {notice ? <Notice tone={notice.tone} message={notice.message} /> : null}
      <PatrolPanel title="Retention" subtitle="How long verified patrol photos are kept, counted from when S4 verified them.">
        {ctx.policies ? (
          <>
            <KeyValue label="Company default" value={`${ctx.policies.companyDefault.retentionDays} days`} />
            {ctx.sites.filter((s) => !ctx.siteId || s.siteId === ctx.siteId).map((s) => (
              <KeyValue key={s.siteId} label={s.siteName} value={`${s.policy.retentionDays} days${s.policy.source === 'site' ? '' : ' (company default)'}`} />
            ))}
            <Text style={ui.muted}>
              Change retention in Site settings{ctx.policies.extendedRetentionAllowed ? '' : ' (90 days can only be set by an Owner or Admin)'}. A hold keeps photos beyond their retention period.
            </Text>
          </>
        ) : <Text style={ui.muted}>Retention settings are loading.</Text>}
      </PatrolPanel>
      {canHolds ? <HoldsPanel ctx={ctx} setNotice={setNotice} /> : <Text style={ui.muted}>Evidence holds and bulk exports are managed by an Owner or Admin.</Text>}
      {canHolds ? <ExportsPanel ctx={ctx} setNotice={setNotice} /> : null}
    </View>
  );
}

function HoldsPanel({ ctx, setNotice }: { ctx: PatrolPageContext; setNotice: (n: { tone: 'success' | 'error' | 'info'; message: string } | null) => void }) {
  const [showAll, setShowAll] = React.useState(false);
  const holds = usePatrolResource(`holds|${ctx.companyKey}|${showAll}`, () => listPatrolHolds(showAll ? 'all' : 'active'));
  const [draft, setDraft] = React.useState<HoldDraft>({ scope: 'run', targetId: '', siteId: ctx.siteId ? String(ctx.siteId) : '', fromDate: '', toDate: '', reason: '' });
  const [busy, setBusy] = React.useState(false);
  const [release, setRelease] = React.useState<{ hold: PatrolHold; reason: string } | null>(null);

  const place = async () => {
    const problem = holdDraftProblem(draft);
    if (problem) { setNotice({ tone: 'error', message: problem }); return; }
    setBusy(true);
    try {
      const id = Number(draft.targetId);
      await placePatrolHold(draft.scope === 'site_date_range'
        ? { scope: draft.scope, siteId: Number(draft.siteId), fromDate: draft.fromDate.trim(), toDate: draft.toDate.trim(), reason: draft.reason.trim() }
        : { scope: draft.scope, ...(draft.scope === 'evidence' ? { evidenceId: id } : draft.scope === 'run' ? { runId: id } : { shiftId: id }), reason: draft.reason.trim() });
      setNotice({ tone: 'success', message: 'Hold placed.' });
      setDraft({ ...draft, targetId: '', reason: '' });
      await holds.reload(true);
      ctx.reloadHolds();
    } catch (error) {
      setNotice({ tone: 'error', message: patrolFailureMessage(error, 'Unable to place the hold.') });
    } finally { setBusy(false); }
  };

  const doRelease = async () => {
    if (!release) return;
    const problem = holdReasonProblem(release.reason);
    if (problem) { setNotice({ tone: 'error', message: problem }); return; }
    setBusy(true);
    try {
      await releasePatrolHold(release.hold.id, release.reason.trim());
      setNotice({ tone: 'success', message: `Hold #${release.hold.id} released. The photos return to their normal retention.` });
      setRelease(null);
      await holds.reload(true);
      ctx.reloadHolds();
    } catch (error) {
      setNotice({ tone: 'error', message: patrolFailureMessage(error, 'Unable to release the hold.') });
    } finally { setBusy(false); }
  };

  const list = holds.data ?? [];
  return (
    <PatrolPanel title="Evidence holds" subtitle="A hold keeps photos from being deleted until it is released. A reason is always recorded."
      right={<Button label={showAll ? 'Active only' : 'Include released'} size="sm" variant="tertiary" onPress={() => setShowAll(!showAll)} />}>
      {ResourceState({ resource: holds, empty: holds.data != null && list.length === 0, emptyMessage: showAll ? 'No holds have been placed.' : 'No active holds.', what: 'holds' })}
      {list.map((h) => (
        <RowCard key={h.id}>
          <View style={ui.actions}>
            <Text style={ui.rowTitle}>{holdScopeLabel(h, (id) => ctx.siteName(id))}</Text>
            <Badge label={h.releasedAt ? 'Released' : 'Active'} tone={h.releasedAt ? 'neutral' : 'warning'} />
            <Badge label={h.source} tone="neutral" />
          </View>
          <Text style={ui.rowMeta}>Placed {formatPatrolDateTime(h.createdAt, ctx.siteZone(h.siteId))} · {h.reason}</Text>
          {h.releasedAt ? <Text style={ui.rowMeta}>Released {formatPatrolDateTime(h.releasedAt, ctx.siteZone(h.siteId))}{h.releaseReason ? ` · ${h.releaseReason}` : ''}</Text> : null}
          {!h.releasedAt ? (
            release?.hold.id === h.id ? (
              <View style={{ gap: 8 }}>
                <TextField label="Reason for releasing" value={release.reason} onChangeText={(v) => setRelease({ hold: h, reason: v })} multiline />
                <View style={ui.actions}>
                  <Button label="Cancel" size="sm" variant="secondary" onPress={() => setRelease(null)} />
                  <Button label="Release hold" size="sm" variant="danger" loading={busy} onPress={() => { void doRelease(); }} />
                </View>
              </View>
            ) : <View style={ui.actions}><Button label="Release" size="sm" variant="tertiary" onPress={() => setRelease({ hold: h, reason: '' })} /></View>
          ) : null}
        </RowCard>
      ))}
      <View style={{ gap: 8 }}>
        <Text style={ui.fieldLabel}>Place a hold</Text>
        <ChipSelect label="Hold" options={[
          { value: 'run', label: 'A patrol' }, { value: 'evidence', label: 'A photo' }, { value: 'shift', label: 'A shift' }, { value: 'site_date_range', label: 'A site and dates' },
        ]} value={draft.scope} onChange={(v) => setDraft({ ...draft, scope: v as HoldDraft['scope'] })} scroll />
        {draft.scope === 'site_date_range' ? (
          <>
            <ChipSelect label="Site" options={ctx.sites.map((s) => ({ value: String(s.siteId), label: s.siteName }))} value={draft.siteId || null} onChange={(v) => setDraft({ ...draft, siteId: v })} scroll />
            <TextField label="From (YYYY-MM-DD, site date)" value={draft.fromDate} onChangeText={(v) => setDraft({ ...draft, fromDate: v })} />
            <TextField label="To (YYYY-MM-DD, site date)" value={draft.toDate} onChangeText={(v) => setDraft({ ...draft, toDate: v })} />
          </>
        ) : (
          <TextField label={draft.scope === 'run' ? 'Patrol number' : draft.scope === 'evidence' ? 'Photo number' : 'Shift number'} value={draft.targetId} onChangeText={(v) => setDraft({ ...draft, targetId: v })} />
        )}
        <TextField label="Reason for the hold" value={draft.reason} onChangeText={(v) => setDraft({ ...draft, reason: v })} multiline helper="Required, at least 3 characters." />
        <View style={ui.actions}><Button label="Place hold" loading={busy} onPress={() => { void place(); }} /></View>
      </View>
    </PatrolPanel>
  );
}

function ExportsPanel({ ctx, setNotice }: { ctx: PatrolPageContext; setNotice: (n: { tone: 'success' | 'error' | 'info'; message: string } | null) => void }) {
  const [pollExports, setPollExports] = React.useState(false);
  const exportsList = usePatrolResource(`exports|${ctx.companyKey}`, () => listPatrolExports(), { poll: pollExports });
  const [draft, setDraft] = React.useState({ purpose: '' as PatrolExportPurpose | '', fromDate: '', toDate: '', runIds: '' });
  const [busy, setBusy] = React.useState(false);
  const [downloading, setDownloading] = React.useState<number | null>(null);
  const list = exportsList.data ?? [];
  // Poll only while an export is being prepared.
  React.useEffect(() => {
    setPollExports((exportsList.data ?? []).some((e) => e.status === 'queued' || e.status === 'running'));
  }, [exportsList.data]);

  const submit = async () => {
    const problem = exportDraftProblem(draft);
    if (problem) { setNotice({ tone: 'error', message: problem }); return; }
    setBusy(true);
    try {
      const ids = draft.runIds.split(/[\s,]+/).filter(Boolean).map(Number);
      await requestPatrolExport(ids.length
        ? { purpose: draft.purpose as PatrolExportPurpose, runIds: ids }
        : { purpose: draft.purpose as PatrolExportPurpose, siteId: ctx.siteId ?? undefined, fromDate: draft.fromDate.trim(), toDate: draft.toDate.trim() });
      setNotice({ tone: 'success', message: 'Export requested. It is prepared in the background; download it here when it is ready.' });
      await exportsList.reload(true);
    } catch (error) {
      setNotice({ tone: 'error', message: patrolFailureMessage(error, 'Unable to request the export.') });
    } finally { setBusy(false); }
  };

  const download = async (item: PatrolExport) => {
    const tab = beginOpenLink();
    if (!tab.ok) { setNotice({ tone: 'error', message: 'The browser blocked the download window. Allow pop-ups for S4 and try again.' }); return; }
    setDownloading(item.id);
    try {
      const link = await getPatrolExportLink(item.id);
      if (!signedLinkUsable(link, Date.now())) throw new Error('The download link had already expired. Try again.');
      tab.finish(link.url);
    } catch (error) {
      tab.abandon();
      setNotice({ tone: 'error', message: patrolFailureMessage(error, 'Unable to download this export.') });
    } finally { setDownloading(null); }
  };

  return (
    <PatrolPanel title="Bulk photo exports" subtitle="A ZIP of verified photos with a manifest. Up to 31 days or 200 patrols per export; ready exports expire after 24 hours.">
      <ChipSelect label="Purpose" options={PATROL_EXPORT_PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABELS[p] }))} value={draft.purpose || null} onChange={(v) => setDraft({ ...draft, purpose: v })} scroll />
      <Text style={ui.muted}>{ctx.siteId ? `Site: ${ctx.siteName(ctx.siteId)}` : 'All sites'} — or list patrol numbers instead of dates.</Text>
      <View style={ui.grid}>
        <View style={{ flexGrow: 1, minWidth: 160 }}><TextField label="From (YYYY-MM-DD)" value={draft.fromDate} onChangeText={(v) => setDraft({ ...draft, fromDate: v })} /></View>
        <View style={{ flexGrow: 1, minWidth: 160 }}><TextField label="To (YYYY-MM-DD)" value={draft.toDate} onChangeText={(v) => setDraft({ ...draft, toDate: v })} /></View>
      </View>
      <TextField label="Patrol numbers (optional, comma separated)" value={draft.runIds} onChangeText={(v) => setDraft({ ...draft, runIds: v })} />
      <View style={ui.actions}><Button label="Request export" loading={busy} onPress={() => { void submit(); }} /></View>
      {ResourceState({ resource: exportsList, empty: exportsList.data != null && list.length === 0, emptyMessage: 'No exports have been requested.', what: 'exports' })}
      {list.map((item) => (
        <RowCard key={item.id}>
          <View style={ui.actions}>
            <Text style={ui.rowTitle}>Export #{item.id} · {PURPOSE_LABELS[item.purpose as PatrolExportPurpose] ?? item.purpose}</Text>
            <Badge label={exportStatusLabel(item.status)} tone={item.status === 'ready' ? 'success' : item.status === 'failed' ? 'danger' : item.status === 'expired' ? 'neutral' : 'pending'} />
          </View>
          <Text style={ui.rowMeta}>
            {item.runIds.length ? `${item.runIds.length} patrol${item.runIds.length === 1 ? '' : 's'}` : `${item.siteId ? ctx.siteName(item.siteId) : 'All sites'}, ${item.fromDate ?? '—'} to ${item.toDate ?? '—'}`}
            {' · '}{item.includedCount} of {item.itemCount} photos{item.zipBytes != null ? ` · ${formatBytes(item.zipBytes)}` : ''}
          </Text>
          {item.status === 'ready' && item.expiresAt ? <Text style={ui.rowMeta}>Available until {formatPatrolDateTime(item.expiresAt, ctx.siteZone(ctx.siteId))}</Text> : null}
          {item.error ? <Text style={ui.rowMeta}>{item.error}</Text> : null}
          {item.status === 'ready' ? <View style={ui.actions}><Button label="Download ZIP" size="sm" variant="secondary" loading={downloading === item.id} onPress={() => { void download(item); }} /></View> : null}
        </RowCard>
      ))}
    </PatrolPanel>
  );
}
