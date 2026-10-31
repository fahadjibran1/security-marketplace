import * as React from 'react';
import { Text, View } from 'react-native';
import { getPatrolStorageUsage, savePatrolSitePolicy } from '../../services/api';
import type { PatrolConfigurationWarning, PatrolEffectivePolicy, PatrolPolicyUpdate } from '../../types/patrols';
import { Button } from '../ui/Button';
import { patrolFailureMessage } from './patrolAccess';
import type { PatrolPageContext } from './patrolContext';
import { formatBytes, formatPatrolDateTime, requirementScopeLabel } from './patrolPresentation';
import { ChipSelect, ConfigurationRequired, KeyValue, Notice, PatrolPanel, ResourceState, TextField, Toggle, ui, usePatrolResource } from './patrolUi';

type NumberField = 'startGraceMinutes' | 'maxPatrolDurationMinutes' | 'completionGraceMinutes' | 'syncGraceMinutes' | 'postShiftSyncHours' | 'clockDriftThresholdMinutes';

const NUMBER_FIELDS: Array<{ key: NumberField; label: string; min: number; max: number }> = [
  { key: 'startGraceMinutes', label: 'Start grace (minutes)', min: 0, max: 240 },
  { key: 'maxPatrolDurationMinutes', label: 'Maximum patrol duration (minutes)', min: 5, max: 720 },
  { key: 'completionGraceMinutes', label: 'Completion grace (minutes)', min: 0, max: 720 },
  { key: 'syncGraceMinutes', label: 'Evidence sync grace (minutes)', min: 0, max: 1440 },
  { key: 'postShiftSyncHours', label: 'Offline sync after Book Off (hours)', min: 1, max: 72 },
  { key: 'clockDriftThresholdMinutes', label: 'Clock drift flag threshold (minutes)', min: 1, max: 120 },
];

/**
 * S4 1.2.1 (owner decision): photos are "required: yes / no", never a count. The server keeps the numeric columns and
 * reads any value above 0 as "required"; the dashboard writes 1 (yes) or 0 (no).
 */
export const PHOTO_TOGGLES: Array<{ key: 'photosPerRun' | 'photosPerCheckpoint'; label: string }> = [
  { key: 'photosPerRun', label: 'Photos required for each patrol' },
  { key: 'photosPerCheckpoint', label: 'Photo at each checkpoint' },
];
export const photoRequired = (value: number | null | undefined) => Number(value) > 0;

type Draft = Omit<PatrolEffectivePolicy, NumberField | 'source' | 'qrRequireProximity' | 'proximityMeters'> & Record<NumberField, string>;

function toDraft(p: PatrolEffectivePolicy): Draft {
  const { source: _s, qrRequireProximity: _q, proximityMeters: _p, ...rest } = p;
  const draft = { ...rest } as unknown as Draft;
  NUMBER_FIELDS.forEach((f) => { (draft as any)[f.key] = String(p[f.key]); });
  return draft;
}

/** Only what changed, so an Operations user saving grace minutes never re-sends a 90-day retention it may not set. */
export function policyChanges(before: PatrolEffectivePolicy, draft: Draft): { update: PatrolPolicyUpdate; problem: string | null } {
  const update: PatrolPolicyUpdate = {};
  for (const f of NUMBER_FIELDS) {
    const raw = draft[f.key].trim();
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < f.min || value > f.max) return { update: {}, problem: `${f.label} must be a whole number from ${f.min} to ${f.max}.` };
    if (value !== before[f.key]) (update as any)[f.key] = value;
  }
  for (const f of PHOTO_TOGGLES) {
    const on = photoRequired(draft[f.key]);
    if (on !== photoRequired(before[f.key])) (update as any)[f.key] = on ? 1 : 0;
  }
  if (!draft.methods.length) return { update: {}, problem: 'Choose at least one patrol method.' };
  if (draft.methods.slice().sort().join() !== before.methods.slice().sort().join()) update.methods = draft.methods;
  for (const key of ['orderMode', 'requirementScope', 'retentionDays', 'incompleteNeedsAction', 'allowUnscheduledPatrols', 'escalateUnverified'] as const) {
    if (draft[key] !== before[key]) (update as any)[key] = draft[key];
  }
  return { update, problem: null };
}

/** Per-site patrol settings (patrols.manage to change). Location-based verification stays disabled. */
export function PatrolSettingsTab({ ctx }: { ctx: PatrolPageContext }) {
  const [target, setTarget] = React.useState<string>(ctx.siteId ? String(ctx.siteId) : 'default');
  React.useEffect(() => { setTarget(ctx.siteId ? String(ctx.siteId) : 'default'); }, [ctx.siteId, ctx.companyKey]);
  const policies = ctx.policies;
  const current: PatrolEffectivePolicy | null = !policies ? null
    : target === 'default' ? policies.companyDefault
      : policies.sites.find((s) => String(s.siteId) === target)?.policy ?? null;
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [savedWarnings, setSavedWarnings] = React.useState<PatrolConfigurationWarning[] | null>(null);
  React.useEffect(() => { setDraft(current ? toDraft(current) : null); setNotice(null); setSavedWarnings(null); }, [current, target]);
  const canManage = ctx.permissions.canManage;

  const save = async () => {
    if (!current || !draft) return;
    const { update, problem } = policyChanges(current, draft);
    if (problem) { setNotice({ tone: 'error', message: problem }); return; }
    if (!Object.keys(update).length) { setNotice({ tone: 'success', message: 'Nothing has changed.' }); return; }
    setSaving(true);
    try {
      const saved = await savePatrolSitePolicy(target === 'default' ? null : Number(target), update);
      setNotice({ tone: 'success', message: 'Patrol settings saved.' });
      setSavedWarnings(saved?.configurationWarnings ?? null);
      ctx.reloadPolicies();
    } catch (error) {
      setNotice({ tone: 'error', message: patrolFailureMessage(error, 'Unable to save these settings.') });
    } finally { setSaving(false); }
  };

  if (!policies) return <Text style={ui.muted}>Loading patrol settings…</Text>;
  const site = policies.sites.find((s) => String(s.siteId) === target);
  // The server's own warnings: this site's, or (company default) those of every site that uses the default.
  const warnings = savedWarnings
    ?? (site ? site.configurationWarnings ?? [] : policies.sites.filter((s) => s.policy.source !== 'site').flatMap((s) => s.configurationWarnings ?? []));
  return (
    <View style={{ gap: 12 }}>
      <ChipSelect label="Settings for" scroll options={[{ value: 'default', label: 'Company default' }, ...policies.sites.map((s) => ({ value: String(s.siteId), label: s.siteName }))]} value={target} onChange={setTarget} />
      {notice ? <Notice tone={notice.tone} message={notice.message} /> : null}
      <ConfigurationRequired warnings={warnings} />
      {!canManage ? <Text style={ui.muted}>You can view these settings. Changing them needs the patrols.manage permission.</Text> : null}
      {current && draft ? (
        <PatrolPanel
          title={site ? site.siteName : 'Company default'}
          subtitle={site ? `Site time: ${site.timezone || 'Europe/London'} · ${current.source === 'site' ? 'Site-specific settings' : 'Using the company default'}` : 'Applies to every site without its own settings.'}
        >
          <ChipSelect label="Patrol requirement" options={[{ value: 'site', label: 'Per site' }, { value: 'per_guard', label: 'Per Guard' }]} value={draft.requirementScope} onChange={(v) => canManage && setDraft({ ...draft, requirementScope: v as Draft['requirementScope'] })} />
          <Text style={ui.muted}>{requirementScopeLabel(draft.requirementScope)}</Text>
          <ChipSelect label="Checkpoint order" options={[{ value: 'any', label: 'Any order' }, { value: 'strict', label: 'Strict order' }]} value={draft.orderMode} onChange={(v) => canManage && setDraft({ ...draft, orderMode: v as Draft['orderMode'] })} />
          <View style={ui.chipRowWrap}>
            {(['qr', 'photo'] as const).map((m) => (
              <Toggle key={m} disabled={!canManage} label={m === 'qr' ? 'QR checkpoint scans' : 'Photos'} value={draft.methods.includes(m)} onChange={(on) => setDraft({ ...draft, methods: on ? [...draft.methods, m] : draft.methods.filter((x) => x !== m) })} />
            ))}
          </View>
          <ChipSelect
            label="Photo retention"
            options={[{ value: 30, label: '30 days' }, { value: 90, label: policies.extendedRetentionAllowed ? '90 days' : '90 days (Owner / Admin)' }]}
            value={draft.retentionDays}
            onChange={(v) => { if (canManage && (v !== 90 || policies.extendedRetentionAllowed || current.retentionDays === 90)) setDraft({ ...draft, retentionDays: v }); }}
          />
          {PHOTO_TOGGLES.map((f) => (
            <Toggle key={f.key} disabled={!canManage} label={f.label} value={photoRequired(draft[f.key])} onChange={(on) => setDraft({ ...draft, [f.key]: on ? 1 : 0 })} />
          ))}
          <Text style={ui.muted}>Only photos S4 has received and checked count towards verifying a patrol. A patrol missing a required photo can still be completed with a reason; it is then recorded as incomplete.</Text>
          {NUMBER_FIELDS.map((f) => (
            <TextField key={f.key} label={f.label} value={draft[f.key]} onChangeText={(v) => setDraft({ ...draft, [f.key]: v })} editable={canManage} helper={`${f.min}–${f.max}`} />
          ))}
          <Toggle disabled={!canManage} label="An incomplete patrol needs action (raises a Live Operations alert)" value={draft.incompleteNeedsAction} onChange={(v) => setDraft({ ...draft, incompleteNeedsAction: v })} />
          <Toggle disabled={!canManage} label="Allow patrols outside a scheduled window" value={draft.allowUnscheduledPatrols} onChange={(v) => setDraft({ ...draft, allowUnscheduledPatrols: v })} />
          <Toggle disabled={!canManage} label="Raise an alert when evidence is still missing at the sync deadline" value={draft.escalateUnverified} onChange={(v) => setDraft({ ...draft, escalateUnverified: v })} />
          <Text style={ui.muted}>Location-based verification is disabled until the privacy assessment is approved. Patrols never collect a location.</Text>
          {canManage ? <View style={ui.actions}><Button label="Save settings" loading={saving} onPress={() => { void save(); }} /></View> : null}
        </PatrolPanel>
      ) : <Text style={ui.muted}>No settings found for this site.</Text>}
    </View>
  );
}

/** Storage usage, company and per site, from the live metering endpoint (patrols.holds). */
export function PatrolStorageTab({ ctx }: { ctx: PatrolPageContext }) {
  const usage = usePatrolResource(`usage|${ctx.companyKey}`, () => getPatrolStorageUsage(), { enabled: ctx.permissions.canManageHolds });
  if (!ctx.permissions.canManageHolds) return null;
  const data = usage.data;
  const sites = (data?.sites ?? []).filter((s) => !ctx.siteId || s.siteId === ctx.siteId);
  return (
    <View style={{ gap: 12 }}>
      {ResourceState({ resource: usage, empty: false, emptyMessage: '', what: 'storage usage' })}
      {data ? (
        <>
          {!data.storageConfigured ? <Notice tone="info" message="Patrol photo storage is not configured on this server, so no new photos can be stored." /> : null}
          <PatrolPanel title="Company total">
            <KeyValue label="All stored items" value={`${data.totals.objects} · ${formatBytes(data.totals.bytes)}`} />
            <KeyValue label="Active photos" value={`${data.totals.activeObjects} · ${formatBytes(data.totals.activeBytes)}`} />
            <KeyValue label="Quarantined (recoverable)" value={`${data.totals.quarantinedObjects} · ${formatBytes(data.totals.quarantinedBytes)}`} />
            <KeyValue label="Export ZIPs" value={`${data.exports.objects} · ${formatBytes(data.exports.bytes)}`} />
          </PatrolPanel>
          <PatrolPanel title="By site">
            {sites.length === 0 ? <Text style={ui.muted}>No patrol photos are stored{ctx.siteId ? ' for this site' : ''}.</Text> : null}
            {sites.map((s) => (
              <View key={s.siteId} style={{ gap: 2 }}>
                <Text style={ui.rowTitle}>{s.siteName || ctx.siteName(s.siteId)}</Text>
                <KeyValue label="Active photos" value={`${s.activeObjects} · ${formatBytes(s.activeBytes)}`} />
                <KeyValue label="Quarantined" value={`${s.quarantinedObjects} · ${formatBytes(s.quarantinedBytes)}`} />
                <Text style={ui.muted}>Updated {formatPatrolDateTime(s.updatedAt, ctx.siteZone(s.siteId))}</Text>
              </View>
            ))}
          </PatrolPanel>
        </>
      ) : null}
    </View>
  );
}
