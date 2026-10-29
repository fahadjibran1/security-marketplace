import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppModal } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { colors, radii, spacing, typography } from '../../../theme';
import { ApiError, getMyPatrolPlan, getMyPatrolRuns } from '../../../services/api';
import { newPatrolClientId, photoPortsFor } from '../../../services/patrolNative';
import { usePatrolOutbox } from '../../../services/patrolSync';
import type { GuardPatrolPlan, GuardPatrolRun } from '../../../types/patrols';
import { GuardPatrolCamera } from './GuardPatrolCamera';
import { photoErrorMessage, processCapturedPhoto } from './patrolImage';
import { NOT_SENT_MESSAGE, type OutboxItem } from './patrolOutbox';
import { decideScan, scanVerdictMessage } from './patrolQrScan';
import {
  activePatrol,
  completionSummary,
  dueWindow,
  localPatrols,
  notSentItems,
  patrolCardVisible,
  patrolCheckpoints,
  patrolView,
  timePair,
  upcomingWindows,
  waitingCount,
  type LocalPatrol,
} from './patrolState';

type Notice = { tone: 'good' | 'warning' | 'danger' | 'info'; text: string } | null;
type CameraTask = { mode: 'scan' } | { mode: 'photo'; kind: 'run_photo' } | { mode: 'photo'; kind: 'checkpoint_photo'; clientVisitId: string; label: string } | null;

/**
 * Patrols on the Guard's current shift (Patrols P1-E). Shown only when the company has Patrols on (the plan loads) and
 * the shift's site has patrols. Independently of the shift, anything still waiting to send — or that S4 refused — is
 * listed so it is never forgotten after Book Off or a sign-out. Welfare Checks are not read or changed here.
 */
export function GuardPatrolPanel({ userId, shift }: { userId: number; shift: { id: number; status: string; companyId?: number | null; siteName?: string | null } | null }) {
  const outbox = usePatrolOutbox(userId);
  const [plan, setPlan] = React.useState<GuardPatrolPlan | null>(null);
  const [serverRuns, setServerRuns] = React.useState<GuardPatrolRun[]>([]);
  const [open, setOpen] = React.useState(false);
  const [camera, setCamera] = React.useState<CameraTask>(null);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [working, setWorking] = React.useState(false);
  const [exceptionFor, setExceptionFor] = React.useState<{ publicId: string; label: string } | null>(null);
  const [exceptionText, setExceptionText] = React.useState('');
  const [completing, setCompleting] = React.useState(false);
  const [completionNote, setCompletionNote] = React.useState('');
  const [finished, setFinished] = React.useState<string | null>(null);
  const shiftId = shift?.id ?? null;
  const live = String(shift?.status ?? '').toLowerCase() === 'in_progress';

  React.useEffect(() => {
    let alive = true;
    setPlan(null);
    if (!shiftId || !live) return;
    getMyPatrolPlan(shiftId)
      .then((p) => { if (alive) setPlan(p); })
      .catch((error) => {
        // 404 PATROLS_NOT_ENABLED / not the Guard's shift, 409 no site: no patrol card. A network failure leaves the
        // card out too — patrols already on this phone keep syncing and are listed below.
        if (!alive) return;
        setPlan(null);
        if (!(error instanceof ApiError)) setNotice({ tone: 'info', text: 'Patrols could not be loaded (no connection). Anything already recorded on this phone is kept and sent later.' });
      });
    return () => { alive = false; };
  }, [shiftId, live]);

  React.useEffect(() => {
    let alive = true;
    if (!shiftId || !plan) return;
    getMyPatrolRuns(shiftId).then((rows) => { if (alive) setServerRuns(rows); }).catch(() => undefined);
    return () => { alive = false; };
  }, [shiftId, plan, outbox.report]);

  const items = outbox.items;
  const engine = outbox.engine;
  const visible = patrolCardVisible({ shiftStatus: shift?.status, plan });
  const waiting = waitingCount(items);
  const refused = notSentItems(items);
  const active = shiftId ? activePatrol(items, shiftId) : null;
  const now = new Date();

  if (!visible && waiting === 0 && refused.length === 0) return null;

  const serverFor = (p: LocalPatrol) => serverRuns.find((r) => r.clientRunId === p.clientRunId) ?? null;
  const tz = plan?.site.timezone ?? 'Europe/London';
  const windows = plan ? upcomingWindows(plan, now) : null;
  const routeId = active ? (active.start.body.routeId as number | undefined) ?? null : null;

  async function guard<T>(fn: () => Promise<T>, failure: string): Promise<T | null> {
    setWorking(true);
    try {
      return await fn();
    } catch (error) {
      setNotice({ tone: 'danger', text: error instanceof Error && error.message ? `${failure} ${error.message}` : failure });
      return null;
    } finally {
      setWorking(false);
    }
  }

  async function startPatrol() {
    if (!engine || !plan || !shiftId) return;
    const window = dueWindow(plan, new Date());
    const clientRunId = newPatrolClientId();
    const ok = await guard(() => engine.enqueueStart({
      clientRunId,
      shiftId,
      companyId: shift?.companyId ?? null,
      scheduleId: window?.scheduleId ?? null,
      routeId: window?.routeId ?? null,
      startedAtDevice: new Date().toISOString(), // captured now, stored before any network call
      meta: { siteName: plan.site.name, scheduleName: window?.scheduleName ?? null, timezone: plan.site.timezone },
    }), 'Could not save the patrol on this phone.');
    if (ok) {
      setNotice({ tone: 'info', text: window ? `Patrol started for ${window.scheduleName}.` : 'Unscheduled patrol started.' });
      setFinished(null);
      setOpen(true);
      outbox.kick();
    }
  }

  async function onScanned(data: string) {
    setCamera(null);
    if (!engine || !plan || !active) return;
    const decision = decideScan(data, plan, active.scans.map((s) => String(s.meta.publicId ?? '')));
    if (decision.kind !== 'record') {
      setNotice({ tone: decision.kind === 'duplicate' ? 'warning' : 'danger', text: `${decision.title}. ${decision.message}` });
      return;
    }
    const clientVisitId = newPatrolClientId();
    const saved = await guard(() => engine.enqueueScan({
      clientRunId: active.clientRunId,
      clientVisitId,
      scanPayload: decision.payload,
      scannedAtDevice: new Date().toISOString(),
      meta: { publicId: decision.publicId, label: decision.checkpoint?.label ?? null },
    }), 'Could not save the scan on this phone.');
    if (!saved) return;
    outbox.kick();
    const label = decision.checkpoint?.label ?? 'Checkpoint';
    const needsPhoto = (decision.checkpoint?.photoRequired ?? false) || plan.policy.photosPerCheckpoint > 0;
    setNotice({ tone: decision.notice ? 'warning' : 'good', text: decision.notice ?? `${label} scanned.${needsPhoto ? ' Take the checkpoint photo now.' : ''}` });
    if (needsPhoto) setCamera({ mode: 'photo', kind: 'checkpoint_photo', clientVisitId, label });
  }

  async function onCaptured(capture: { uri: string; width: number; height: number }) {
    const task = camera;
    setCamera(null);
    if (!engine || !active || !task || task.mode !== 'photo') return;
    setWorking(true);
    try {
      const clientEvidenceId = newPatrolClientId();
      const processed = await processCapturedPhoto(capture, photoPortsFor(userId), { fileName: `${clientEvidenceId}.jpg` });
      await engine.enqueuePhoto({
        clientRunId: active.clientRunId,
        clientEvidenceId,
        kind: task.kind,
        clientVisitId: task.kind === 'checkpoint_photo' ? task.clientVisitId : null,
        capturedAtDevice: new Date().toISOString(),
        file: { path: processed.path, sha256: processed.sha256, sizeBytes: processed.sizeBytes },
        meta: { label: task.kind === 'checkpoint_photo' ? task.label : 'Patrol photo' },
      });
      setNotice({ tone: 'good', text: 'Photo saved on this phone and queued to send.' });
      outbox.kick();
    } catch (error) {
      setNotice({ tone: 'danger', text: photoErrorMessage(error) });
    } finally {
      setWorking(false);
    }
  }

  async function saveException() {
    if (!engine || !active || !exceptionFor) return;
    const reason = exceptionText.trim();
    if (!reason) {
      setNotice({ tone: 'warning', text: 'Say why the checkpoint could not be reached.' });
      return;
    }
    const ok = await guard(() => engine.recordException({
      clientRunId: active.clientRunId,
      id: newPatrolClientId(),
      label: exceptionFor.label,
      publicId: exceptionFor.publicId,
      reason,
      at: new Date().toISOString(),
    }), 'Could not save the reason on this phone.');
    if (ok) {
      setNotice({ tone: 'info', text: `${exceptionFor.label}: reason saved. It is sent with the patrol when you complete it.` });
      setExceptionFor(null);
      setExceptionText('');
    }
  }

  async function completePatrol() {
    if (!engine || !active || !plan) return;
    const summary = completionSummary(plan, routeId, active);
    if (summary.needsReason && !completionNote.trim()) {
      setNotice({ tone: 'warning', text: 'Some checkpoints were not scanned. Give a reason, or record why each one could not be reached.' });
      return;
    }
    const ok = await guard(() => engine.enqueueComplete({ clientRunId: active.clientRunId, completedAtDevice: new Date().toISOString(), note: completionNote.trim() || null }), 'Could not save the completion on this phone.');
    if (ok) {
      setFinished(active.clientRunId);
      setCompleting(false);
      setCompletionNote('');
      outbox.kick();
    }
  }

  const finishedPatrol = finished ? localPatrols(items).find((p) => p.clientRunId === finished) ?? null : null;
  const recent = localPatrols(items, shiftId).slice(0, 5);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>Patrols</Text>
      {visible && plan ? (
        <>
          {windows === null ? (
            <Text style={styles.muted}>Scheduled patrol times are not available. You can still start a patrol.</Text>
          ) : windows.length ? (
            windows.map((w) => (
              <Text key={w.windowKey} style={[styles.windowRow, w.state === 'due_now' ? styles.due : null]}>
                {`${w.time} · ${w.scheduleName} · ${w.state === 'due_now' ? 'DUE NOW' : w.state === 'covered' ? 'covered' : 'upcoming'}`}
              </Text>
            ))
          ) : (
            <Text style={styles.muted}>No more scheduled patrols on this shift.</Text>
          )}
          {active ? (
            <Button label="Continue patrol" onPress={() => setOpen(true)} fullWidth />
          ) : (
            <Button label="Start patrol" onPress={() => { void startPatrol(); }} loading={working} fullWidth />
          )}
        </>
      ) : null}
      {recent.map((p) => {
        const view = patrolView(p, serverFor(p));
        return (
          <Text key={p.clientRunId} style={styles.runRow}>
            {`${timePair(view.startedAtDevice, view.startedAtServer, tz)} · ${view.label}${view.waiting ? ` · ${view.waiting} waiting to send` : ''}`}
          </Text>
        );
      })}
      {waiting > 0 ? (
        <Text style={styles.waiting}>
          {outbox.report?.paused === 'auth'
            ? `${waiting} patrol item(s) are kept on this phone. Sign in again to send them.`
            : `${waiting} patrol item(s) waiting to send. They are kept on this phone and sent automatically.`}
        </Text>
      ) : null}
      {refused.length ? (
        <View style={styles.refused}>
          <Text style={styles.refusedTitle}>{`${refused.length} patrol item(s): ${NOT_SENT_MESSAGE}`}</Text>
          {refused.slice(0, 3).map(({ item }) => (
            <Text key={item.id} style={styles.refusedText}>{`${describe(item)} — ${item.lastErrorMessage ?? item.lastErrorCode ?? ''}`}</Text>
          ))}
        </View>
      ) : null}
      {notice && !open ? <Text style={[styles.notice, toneStyle(notice.tone)]}>{notice.text}</Text> : null}

      <AppModal
        visible={open}
        onClose={() => { setOpen(false); setCompleting(false); setFinished(null); }}
        title={finishedPatrol ? 'Patrol completed on this phone' : completing ? 'Complete patrol' : 'Patrol in progress'}
        subtitle={plan?.site.name}
        size="large"
      >
        <ScrollView contentContainerStyle={styles.modalBody}>
          {notice ? <Text style={[styles.notice, toneStyle(notice.tone)]}>{notice.text}</Text> : null}
          {finishedPatrol && plan ? (
            <CompletionConfirmation plan={plan} local={finishedPatrol} serverRun={serverFor(finishedPatrol)} routeId={(finishedPatrol.start.body.routeId as number | undefined) ?? null} />
          ) : active && plan && completing ? (
            <CompletionReview plan={plan} local={active} routeId={routeId} note={completionNote} onNote={setCompletionNote} onConfirm={() => { void completePatrol(); }} onBack={() => setCompleting(false)} busy={working} />
          ) : active && plan ? (
            <>
              {patrolCheckpoints(plan, routeId, active).map((c) => (
                <View key={c.publicId} style={styles.checkpointRow}>
                  <Text style={[styles.checkpointLabel, c.scanned ? styles.scanned : null]}>
                    {`${c.scanned ? '✓ ' : c.exception ? '! ' : '○ '}${c.label}${c.photoRequired ? ' · photo' : ''}`}
                  </Text>
                  {c.exception ? <Text style={styles.muted}>{`Not reached: ${c.exception}`}</Text> : null}
                  {!c.scanned && !c.exception ? (
                    <Pressable accessibilityRole="button" onPress={() => { setExceptionFor({ publicId: c.publicId, label: c.label }); setExceptionText(''); }}>
                      <Text style={styles.link}>Can't reach it</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
              {active.scans.map((s) => s.server?.result ? (
                <Text key={s.id} style={[styles.muted, toneStyle(scanVerdictMessage({ result: s.server.result, flags: s.server.flags ?? [], checkpointLabel: s.server.checkpointLabel ?? (s.meta.label as string | null) }).tone)]}>
                  {scanVerdictMessage({ result: s.server.result, flags: s.server.flags ?? [], checkpointLabel: s.server.checkpointLabel ?? (s.meta.label as string | null) }).text}
                </Text>
              ) : null)}
              {exceptionFor ? (
                <View style={styles.exceptionBox}>
                  <Text style={styles.label}>{`Why could ${exceptionFor.label} not be reached?`}</Text>
                  <TextInput value={exceptionText} onChangeText={setExceptionText} placeholder="e.g. gate locked, area flooded" style={styles.input} maxLength={200} multiline />
                  <View style={styles.row}>
                    <Button label="Save reason" onPress={() => { void saveException(); }} loading={working} />
                    <Button label="Cancel" variant="tertiary" onPress={() => setExceptionFor(null)} />
                  </View>
                </View>
              ) : null}
              <View style={styles.actions}>
                <Button label="Scan checkpoint" onPress={() => setCamera({ mode: 'scan' })} disabled={working} fullWidth />
                <Button label="Take patrol photo" variant="secondary" onPress={() => setCamera({ mode: 'photo', kind: 'run_photo' })} disabled={working} fullWidth />
                <Button label="Complete patrol" variant="secondary" onPress={() => setCompleting(true)} disabled={working} fullWidth />
              </View>
              <Text style={styles.muted}>Everything is saved on this phone first and sent when there is a connection. No location is recorded.</Text>
            </>
          ) : (
            <Text style={styles.muted}>No patrol in progress.</Text>
          )}
        </ScrollView>
      </AppModal>

      <GuardPatrolCamera
        visible={camera !== null}
        mode={camera?.mode ?? 'scan'}
        title={camera?.mode === 'scan' ? 'Scan checkpoint' : camera?.mode === 'photo' && camera.kind === 'checkpoint_photo' ? `Photo: ${camera.label}` : 'Patrol photo'}
        onClose={() => setCamera(null)}
        onScanned={(data) => { void onScanned(data); }}
        onCaptured={(capture) => { void onCaptured(capture); }}
      />
    </View>
  );
}

function CompletionReview({ plan, local, routeId, note, onNote, onConfirm, onBack, busy }: {
  plan: GuardPatrolPlan; local: LocalPatrol; routeId: number | null; note: string; onNote: (v: string) => void; onConfirm: () => void; onBack: () => void; busy: boolean;
}) {
  const s = completionSummary(plan, routeId, local);
  return (
    <View style={styles.summary}>
      <Text style={styles.label}>{`Checkpoints scanned: ${s.checkpointsScanned} of ${s.checkpointsTotal}`}</Text>
      <Text style={styles.label}>{`Photos taken: ${s.photosTaken}${s.photosRequired ? ` (expected ${s.photosRequired})` : ''}`}</Text>
      {s.missing.map((m) => <Text key={m.publicId} style={styles.muted}>{`Not scanned: ${m.label}${m.exception ? ` — ${m.exception}` : ''}`}</Text>)}
      {s.missing.length ? (
        <>
          <Text style={styles.label}>{s.needsReason ? 'Reason (required)' : 'Anything to add (optional)'}</Text>
          <TextInput value={note} onChangeText={onNote} placeholder="Why the patrol could not be finished" style={styles.input} maxLength={300} multiline />
          <Text style={styles.muted}>A patrol completed with a reason is recorded as incomplete, with your reason.</Text>
        </>
      ) : null}
      <View style={styles.row}>
        <Button label="Complete patrol" onPress={onConfirm} loading={busy} />
        <Button label="Back" variant="tertiary" onPress={onBack} />
      </View>
    </View>
  );
}

function CompletionConfirmation({ plan, local, serverRun, routeId }: { plan: GuardPatrolPlan; local: LocalPatrol; serverRun: GuardPatrolRun | null; routeId: number | null }) {
  const s = completionSummary(plan, routeId, local);
  const view = patrolView(local, serverRun);
  const tz = plan.site.timezone;
  return (
    <View style={styles.summary}>
      <Text style={styles.label}>{`Status: ${view.label}`}</Text>
      <Text style={styles.muted}>{`Started ${timePair(view.startedAtDevice, view.startedAtServer, tz)}`}</Text>
      <Text style={styles.muted}>{`Completed ${timePair(view.completedAtDevice, view.completedAtServer, tz)}`}</Text>
      <Text style={styles.label}>{`Checkpoints scanned: ${s.checkpointsScanned} of ${s.checkpointsTotal}`}</Text>
      <Text style={styles.label}>{`Photos: ${s.photosTaken}`}</Text>
      {view.waiting ? <Text style={styles.waiting}>{`${view.waiting} item(s) waiting to send. They stay on this phone until S4 has them.`}</Text> : <Text style={styles.muted}>Everything recorded on this phone has reached S4.</Text>}
      {view.notSent.length ? <Text style={styles.refusedTitle}>{`${view.notSent.length} item(s): ${NOT_SENT_MESSAGE}`}</Text> : null}
      <Text style={styles.muted}>{view.phase === 'verified' ? 'S4 has verified this patrol.' : 'S4 verifies the patrol once it has every required scan and photo.'}</Text>
    </View>
  );
}

function describe(item: OutboxItem): string {
  if (item.kind === 'start') return 'Patrol start';
  if (item.kind === 'scan') return `Scan${item.meta.label ? ` of ${item.meta.label}` : ''}`;
  if (item.kind === 'photo') return `Photo${item.meta.label ? ` (${item.meta.label})` : ''}`;
  if (item.kind === 'complete') return 'Patrol completion';
  return 'Patrol note';
}

function toneStyle(tone: 'good' | 'warning' | 'danger' | 'info') {
  return tone === 'good' ? styles.good : tone === 'warning' ? styles.warn : tone === 'danger' ? styles.bad : styles.info;
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  sectionLabel: { color: colors.textSecondary, ...typography.label, textTransform: 'uppercase', letterSpacing: 0.5 },
  windowRow: { color: colors.textPrimary, ...typography.caption },
  due: { color: colors.warning, fontWeight: '700' },
  muted: { color: colors.textSecondary, ...typography.caption },
  runRow: { color: colors.textPrimary, ...typography.caption },
  waiting: { color: colors.info, ...typography.caption },
  refused: { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder, borderWidth: 1, borderRadius: radii.sm, padding: spacing.sm, gap: spacing.xs },
  refusedTitle: { color: colors.danger, ...typography.label },
  refusedText: { color: colors.textPrimary, ...typography.caption },
  notice: { ...typography.caption, padding: spacing.sm, borderRadius: radii.sm },
  good: { color: colors.success, backgroundColor: colors.successSurface },
  warn: { color: colors.warning, backgroundColor: colors.warningSurface },
  bad: { color: colors.danger, backgroundColor: colors.dangerSurface },
  info: { color: colors.info, backgroundColor: colors.infoSurface },
  modalBody: { gap: spacing.md, paddingBottom: spacing.lg },
  checkpointRow: { gap: spacing.xs, paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.border },
  checkpointLabel: { color: colors.textPrimary, ...typography.body },
  scanned: { color: colors.success },
  link: { color: colors.info, ...typography.label, minHeight: 32 },
  exceptionBox: { gap: spacing.sm, padding: spacing.sm, borderRadius: radii.sm, backgroundColor: colors.surfaceSubtle },
  label: { color: colors.textPrimary, ...typography.label },
  input: { minHeight: 64, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.sm, padding: spacing.sm, color: colors.textPrimary, backgroundColor: colors.card },
  row: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  actions: { gap: spacing.sm },
  summary: { gap: spacing.sm },
});
