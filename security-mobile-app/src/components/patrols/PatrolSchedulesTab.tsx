import * as React from 'react';
import { Text, View } from 'react-native';
import { archivePatrolSchedule, createPatrolSchedule, listPatrolSchedules, updatePatrolSchedule } from '../../services/api';
import type { PatrolSchedule, PatrolScheduleInput } from '../../types/patrols';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { Drawer } from '../ui/Drawer';
import { patrolFailureMessage } from './patrolAccess';
import type { PatrolPageContext } from './patrolContext';
import { DAY_NAMES, daysLabel, requirementScopeLabel, scheduleDraftProblem, type ScheduleDraft } from './patrolPresentation';
import { Badge, ChipSelect, Notice, PatrolPanel, ResourceState, RowCard, TextField, Toggle, ui, usePatrolResource } from './patrolUi';

const EMPTY: ScheduleDraft = {
  siteId: '', name: '', routeId: '', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], activeFrom: '18:00', activeTo: '06:00',
  frequencyMinutes: '60', windowMinutes: '', startsOn: '', endsOn: '', active: true,
};

function toDraft(s: PatrolSchedule): ScheduleDraft {
  return {
    siteId: String(s.siteId), name: s.name, routeId: s.routeId ? String(s.routeId) : '', daysOfWeek: s.daysOfWeek?.length ? s.daysOfWeek : [1, 2, 3, 4, 5, 6, 7],
    activeFrom: s.activeFrom, activeTo: s.activeTo, frequencyMinutes: String(s.frequencyMinutes), windowMinutes: String(s.windowMinutes),
    startsOn: s.startsOn ?? '', endsOn: s.endsOn ?? '', active: s.active,
  };
}

function toInput(d: ScheduleDraft, creating: boolean): PatrolScheduleInput {
  const input: PatrolScheduleInput = {
    name: d.name.trim(), routeId: d.routeId ? Number(d.routeId) : null, daysOfWeek: [...d.daysOfWeek].sort((a, b) => a - b),
    activeFrom: d.activeFrom, activeTo: d.activeTo, frequencyMinutes: Number(d.frequencyMinutes),
    startsOn: d.startsOn.trim() || null, endsOn: d.endsOn.trim() || null, active: d.active,
  };
  if (d.windowMinutes.trim()) input.windowMinutes = Number(d.windowMinutes);
  if (creating) input.siteId = Number(d.siteId);
  return input;
}

/** Schedules per site, in the SITE's local time (timeBasis site_local). Create / edit / archive need patrols.manage. */
export function PatrolSchedulesTab({ ctx }: { ctx: PatrolPageContext }) {
  const schedules = usePatrolResource(`sch|${ctx.companyKey}|${ctx.siteId ?? 'all'}`, () => listPatrolSchedules({ siteId: ctx.siteId }));
  const [editing, setEditing] = React.useState<{ id: number | null; draft: ScheduleDraft } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [archiveTarget, setArchiveTarget] = React.useState<PatrolSchedule | null>(null);
  const canManage = ctx.permissions.canManage;

  const items = schedules.data ?? [];
  const bySite = new Map<number, PatrolSchedule[]>();
  items.forEach((s) => bySite.set(s.siteId, [...(bySite.get(s.siteId) ?? []), s]));

  const save = async () => {
    if (!editing) return;
    const problem = scheduleDraftProblem(editing.draft);
    if (problem) { setFormError(problem); return; }
    setSaving(true);
    setFormError(null);
    try {
      if (editing.id == null) await createPatrolSchedule(toInput(editing.draft, true));
      else await updatePatrolSchedule(editing.id, toInput(editing.draft, false));
      setNotice({ tone: 'success', message: editing.id == null ? 'Schedule created.' : 'Schedule saved.' });
      setEditing(null);
      await schedules.reload(true);
    } catch (error) {
      setFormError(patrolFailureMessage(error, 'Unable to save this schedule.'));
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!archiveTarget) return;
    try {
      await archivePatrolSchedule(archiveTarget.id);
      setNotice({ tone: 'success', message: `Schedule "${archiveTarget.name}" archived. Its history is kept.` });
      await schedules.reload(true);
    } catch (error) {
      setNotice({ tone: 'error', message: patrolFailureMessage(error, 'Unable to archive this schedule.') });
    } finally {
      setArchiveTarget(null);
    }
  };

  const draft = editing?.draft;
  const setDraft = (patch: Partial<ScheduleDraft>) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));
  const draftSiteId = draft ? Number(draft.siteId) || null : null;
  const siteRoutes = ctx.routes.filter((r) => r.siteId === draftSiteId && r.active && !r.archivedAt);

  return (
    <View style={{ gap: 12 }}>
      {notice ? <Notice tone={notice.tone} message={notice.message} /> : null}
      {canManage ? (
        <View style={ui.actions}>
          <Button label="New schedule" onPress={() => { setFormError(null); setEditing({ id: null, draft: { ...EMPTY, siteId: ctx.siteId ? String(ctx.siteId) : '' } }); }} />
        </View>
      ) : (
        <Text style={ui.muted}>You can view schedules. Changing them needs the patrols.manage permission (Owner, Admin or Operations).</Text>
      )}
      {ResourceState({ resource: schedules, empty: schedules.data != null && items.length === 0, emptyMessage: 'No patrol schedules yet.', what: 'patrol schedules' })}
      {[...bySite.entries()].map(([siteId, list]) => {
        const policy = ctx.sites.find((s) => s.siteId === siteId)?.policy;
        return (
          <PatrolPanel key={siteId} title={ctx.siteName(siteId)} subtitle={`Site time: ${ctx.siteZone(siteId)} · ${policy ? requirementScopeLabel(policy.requirementScope) : 'Requirement not available'}`}>
            {list.map((s) => (
              <RowCard key={s.id}>
                <View style={ui.actions}>
                  <Text style={ui.rowTitle}>{s.name}</Text>
                  <Badge label={s.archivedAt ? 'Archived' : s.active ? 'Active' : 'Paused'} tone={s.archivedAt ? 'neutral' : s.active ? 'success' : 'pending'} />
                </View>
                <Text style={ui.rowMeta}>{daysLabel(s.daysOfWeek)} · {s.activeFrom}–{s.activeTo} site time ({ctx.siteZone(s.siteId)})</Text>
                <Text style={ui.rowMeta}>Every {s.frequencyMinutes} min · window {s.windowMinutes} min{s.routeId ? ` · route ${ctx.routes.find((r) => r.id === s.routeId)?.name ?? `#${s.routeId}`}` : ' · any checkpoints'}</Text>
                {s.startsOn || s.endsOn ? <Text style={ui.rowMeta}>From {s.startsOn ?? 'now'} to {s.endsOn ?? 'no end date'}</Text> : null}
                {canManage && !s.archivedAt ? (
                  <View style={ui.actions}>
                    <Button label="Edit" size="sm" variant="secondary" onPress={() => { setFormError(null); setEditing({ id: s.id, draft: toDraft(s) }); }} />
                    <Button label="Archive" size="sm" variant="tertiary" onPress={() => setArchiveTarget(s)} />
                  </View>
                ) : null}
              </RowCard>
            ))}
          </PatrolPanel>
        );
      })}

      <Drawer visible={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id == null ? 'New patrol schedule' : 'Edit patrol schedule'} subtitle="Times are the site's local time." width={560}
        footer={<View style={ui.actions}><Button label="Cancel" variant="secondary" onPress={() => setEditing(null)} /><Button label="Save schedule" onPress={() => { void save(); }} loading={saving} /></View>}>
        {draft ? (
          <View style={{ gap: 12 }}>
            {formError ? <Notice tone="error" message={formError} /> : null}
            {editing?.id == null ? (
              <ChipSelect label="Site" options={ctx.sites.map((s) => ({ value: String(s.siteId), label: s.siteName }))} value={draft.siteId || null} onChange={(v) => setDraft({ siteId: v, routeId: '' })} />
            ) : <Text style={ui.rowMeta}>Site: {ctx.siteName(Number(draft.siteId))}</Text>}
            {draftSiteId ? <Text style={ui.muted}>Site time zone: {ctx.siteZone(draftSiteId)}</Text> : null}
            <TextField label="Schedule name" value={draft.name} onChangeText={(v) => setDraft({ name: v })} />
            <ChipSelect label="Route" options={[{ value: '', label: 'Any checkpoints' }, ...siteRoutes.map((r) => ({ value: String(r.id), label: r.name }))]} value={draft.routeId} onChange={(v) => setDraft({ routeId: v })} />
            <View style={{ gap: 4 }}>
              <Text style={ui.fieldLabel}>Days</Text>
              <View style={ui.chipRowWrap}>
                {DAY_NAMES.map((name, i) => (
                  <Toggle key={name} label={name} value={draft.daysOfWeek.includes(i + 1)} onChange={(on) => setDraft({ daysOfWeek: on ? [...draft.daysOfWeek, i + 1] : draft.daysOfWeek.filter((d) => d !== i + 1) })} />
                ))}
              </View>
            </View>
            <TextField label="Active from (HH:mm, site time)" value={draft.activeFrom} onChangeText={(v) => setDraft({ activeFrom: v })} />
            <TextField label="Active to (HH:mm, site time)" value={draft.activeTo} onChangeText={(v) => setDraft({ activeTo: v })} helper="An overnight schedule ends the next day." />
            <TextField label="Frequency (minutes)" value={draft.frequencyMinutes} onChangeText={(v) => setDraft({ frequencyMinutes: v })} helper="15 to 1440." />
            <TextField label="Window (minutes)" value={draft.windowMinutes} onChangeText={(v) => setDraft({ windowMinutes: v })} helper="Optional; defaults to the frequency and is never longer." />
            <TextField label="Starts on (YYYY-MM-DD)" value={draft.startsOn} onChangeText={(v) => setDraft({ startsOn: v })} />
            <TextField label="Ends on (YYYY-MM-DD)" value={draft.endsOn} onChangeText={(v) => setDraft({ endsOn: v })} />
            <Toggle label="Active" value={draft.active} onChange={(v) => setDraft({ active: v })} />
          </View>
        ) : null}
      </Drawer>

      <ConfirmationDialog
        visible={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        onConfirm={() => { void archive(); }}
        title="Archive this schedule?"
        message="No new patrol windows will be created from it. Patrols already recorded are kept."
        confirmLabel="Archive"
        variant="danger"
      />
    </View>
  );
}
