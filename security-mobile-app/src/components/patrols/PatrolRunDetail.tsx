import * as React from 'react';
import { Text, View } from 'react-native';
import { getPatrolRun, listPatrolExceptions, placePatrolHold } from '../../services/api';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import { patrolFailureMessage } from './patrolAccess';
import type { PatrolPageContext } from './patrolContext';
import { PatrolEvidenceList } from './PatrolEvidenceList';
import {
  checkpointProgress,
  distinctScannedCheckpoints,
  exceptionTypeLabel,
  formatClockDrift,
  formatPatrolDateTime,
  holdReasonProblem,
  pendingSyncLabel,
  routeCheckpointTotal,
  runFlagBadges,
  runStatusLabel,
  runTone,
  scanFlagLabel,
  syncFlagLabel,
  verificationLabel,
} from './patrolPresentation';
import { Badge, BadgeRow, KeyValue, Notice, PatrolPanel, ResourceState, RowCard, TextField, ui, usePatrolResource } from './patrolUi';

/**
 * One patrol: the scan timeline with device and server times and clock drift, its flags, linked exceptions and their
 * Live Operations alerts, and its photo evidence (patrols.evidence). Holds on the run need patrols.holds.
 */
export function PatrolRunDetail({ ctx, runId, onClose }: { ctx: PatrolPageContext; runId: number | null; onClose: () => void }) {
  const detail = usePatrolResource(`run|${ctx.companyKey}|${runId ?? 'none'}`, () => getPatrolRun(runId as number), { enabled: runId != null });
  const [holdReason, setHoldReason] = React.useState('');
  const [holdBusy, setHoldBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  React.useEffect(() => { setHoldReason(''); setNotice(null); }, [runId, ctx.companyKey]);

  const data = detail.data;
  const run = data?.run;
  const zone = ctx.siteZone(run?.siteId);
  const progress = run && data ? checkpointProgress(distinctScannedCheckpoints(data.visits), routeCheckpointTotal(run, ctx.routes)) : null;
  const runHeld = run && ctx.holds ? ctx.holds.some((h) => !h.releasedAt && h.scope === 'run' && h.runId === run.id) : null;

  const placeHold = async () => {
    if (!run) return;
    const problem = holdReasonProblem(holdReason);
    if (problem) { setNotice({ tone: 'error', message: problem }); return; }
    setHoldBusy(true);
    try {
      await placePatrolHold({ scope: 'run', runId: run.id, reason: holdReason.trim() });
      setNotice({ tone: 'success', message: `Hold placed on patrol #${run.id}. Its photos are kept until the hold is released.` });
      setHoldReason('');
      ctx.reloadHolds();
    } catch (error) {
      setNotice({ tone: 'error', message: patrolFailureMessage(error, 'Unable to place the hold.') });
    } finally { setHoldBusy(false); }
  };

  return (
    <Drawer visible={runId != null} onClose={onClose} title={run ? `Patrol #${run.id}` : 'Patrol'} subtitle={run ? `${run.siteName || ctx.siteName(run.siteId)} · ${run.guardName || `Guard #${run.guardId}`}` : undefined} width={ctx.layout.detailFullScreen ? 10_000 : 640}>
      <View style={{ gap: 12 }}>
        {ResourceState({ resource: detail, empty: false, emptyMessage: '', what: 'this patrol' })}
        {notice ? <Notice tone={notice.tone} message={notice.message} /> : null}
        {run && data ? (
          <>
            <View style={ui.actions}>
              <Badge label={runStatusLabel(run.status)} tone={runTone(run)} />
              <Badge label={verificationLabel(run.verificationStatus)} tone={run.verificationStatus === 'verified' ? 'success' : run.verificationStatus === 'flagged' ? 'danger' : 'pending'} />
              {runHeld ? <Badge label="On hold" tone="warning" /> : null}
            </View>
            <BadgeRow badges={runFlagBadges(run)} />
            {pendingSyncLabel(run) ? <Notice tone="info" message={pendingSyncLabel(run) as string} /> : null}
            <PatrolPanel title="Summary" subtitle={`Times in site time (${zone}).`}>
              {progress ? <KeyValue label="Checkpoints" value={progress.label} /> : null}
              <KeyValue label="Started (device)" value={formatPatrolDateTime(run.startedAtDevice, zone)} />
              <KeyValue label="Started (received by S4)" value={formatPatrolDateTime(run.startedAtServer, zone)} />
              <KeyValue label="Completed (device)" value={formatPatrolDateTime(run.completedAtDevice, zone)} />
              <KeyValue label="Completed (received by S4)" value={formatPatrolDateTime(run.completedAtServer, zone)} />
              <KeyValue label="Clock drift" value={formatClockDrift(run.clockDriftMs)} />
              {run.windowStart ? <KeyValue label="Scheduled window" value={`${formatPatrolDateTime(run.windowStart, zone)} – ${formatPatrolDateTime(run.windowEnd, zone)}`} /> : <KeyValue label="Scheduled window" value="Unscheduled patrol" />}
              {run.exceptionReason ? <KeyValue label="Guard's reason" value={run.exceptionReason} /> : null}
              {run.syncFlags.length ? <KeyValue label="Sync flags" value={run.syncFlags.map(syncFlagLabel).join(', ')} /> : null}
            </PatrolPanel>

            <PatrolPanel title="Scan timeline" subtitle="A scan records that a checkpoint label was scanned.">
              {data.visits.length === 0 ? <Text style={ui.muted}>No scans have reached S4 for this patrol.</Text> : null}
              {data.visits.map((v) => (
                <RowCard key={v.id}>
                  <View style={ui.actions}>
                    <Text style={ui.rowTitle}>{v.checkpointLabel || (v.checkpointPublicId ? 'Unknown checkpoint' : 'Unidentified label')}</Text>
                    <Badge label={v.result === 'verified' ? 'Verified' : v.result === 'flagged' ? 'Flagged' : 'Unverified'} tone={v.result === 'verified' ? 'success' : v.result === 'flagged' ? 'danger' : 'pending'} />
                    {v.provisional ? <Badge label="Provisional" tone="pending" /> : null}
                    {v.syncedLate ? <Badge label="Late sync" tone="info" /> : null}
                  </View>
                  <Text style={ui.rowMeta}>Scanned {formatPatrolDateTime(v.scannedAtDevice, zone)} (device) · received {formatPatrolDateTime(v.receivedAtServer, zone)} (S4)</Text>
                  {v.clockDriftMs != null && Math.abs(v.clockDriftMs) >= 1000 ? <Text style={ui.rowMeta}>{formatClockDrift(v.clockDriftMs)}</Text> : null}
                  {v.flags.length ? <Text style={ui.rowMeta}>{v.flags.map(scanFlagLabel).join(' · ')}</Text> : null}
                  {v.syncFlags.length ? <Text style={ui.rowMeta}>{v.syncFlags.map(syncFlagLabel).join(' · ')}</Text> : null}
                </RowCard>
              ))}
            </PatrolPanel>

            <PatrolPanel title="Exceptions and alerts">
              {data.exceptions.length === 0 ? <Text style={ui.muted}>No exceptions were raised for this patrol.</Text> : null}
              {data.exceptions.map((e) => (
                <RowCard key={e.id}>
                  <View style={ui.actions}>
                    <Text style={ui.rowTitle}>{exceptionTypeLabel(e.type)}</Text>
                    <Badge label={e.status === 'resolved' ? 'Resolved' : e.status === 'acknowledged' ? 'Acknowledged' : 'Open'} tone={e.status === 'resolved' ? 'success' : 'warning'} />
                  </View>
                  <Text style={ui.rowMeta}>{e.safetyAlertId ? `Live Operations alert #${e.safetyAlertId} — acknowledge and resolve it in Live Operations.` : 'Recorded for review (no Live Operations alert).'}</Text>
                  {e.resolution ? <Text style={ui.rowMeta}>Resolution: {e.resolution.replace(/_/g, ' ')}</Text> : null}
                  {e.annotations.map((a, i) => (a.text ? <Text key={i} style={ui.rowMeta}>{a.text}</Text> : null))}
                </RowCard>
              ))}
            </PatrolPanel>

            <PatrolPanel title="Photo evidence" subtitle={`${data.evidenceCount} photo${data.evidenceCount === 1 ? '' : 's'}`}>
              {data.evidenceRestricted || !ctx.permissions.canViewEvidence
                ? <Text style={ui.muted}>Photos are only shown to roles with patrol evidence access (Owner, Admin, Operations, Control Room).</Text>
                : <PatrolEvidenceList ctx={ctx} run={run} evidence={data.evidence ?? []} />}
            </PatrolPanel>

            {ctx.permissions.canManageHolds ? (
              <PatrolPanel title="Evidence hold" subtitle="A hold keeps this patrol's photos past their retention period until it is released.">
                {runHeld ? <Text style={ui.rowMeta}>This patrol is on hold. Release holds in Downloads, retention & holds.</Text> : null}
                <TextField label="Reason for the hold" value={holdReason} onChangeText={setHoldReason} multiline helper="Required, at least 3 characters." />
                <View style={ui.actions}><Button label="Place hold on this patrol" variant="secondary" loading={holdBusy} onPress={() => { void placeHold(); }} /></View>
              </PatrolPanel>
            ) : null}
          </>
        ) : null}
      </View>
    </Drawer>
  );
}

/** An exception without a run (a missed window): what was due, where, and its alert. */
export function PatrolExceptionDetail({ ctx, exceptionId, onClose }: { ctx: PatrolPageContext; exceptionId: number | null; onClose: () => void }) {
  const list = usePatrolResource(`exc|${ctx.companyKey}|${exceptionId ?? 'none'}`, () => listPatrolExceptions({}), { enabled: exceptionId != null });
  const e = (list.data ?? []).find((x) => x.id === exceptionId) ?? null;
  const zone = ctx.siteZone(e?.siteId);
  return (
    <Drawer visible={exceptionId != null} onClose={onClose} title={e ? exceptionTypeLabel(e.type) : 'Patrol exception'} subtitle={e ? ctx.siteName(e.siteId) : undefined} width={ctx.layout.detailFullScreen ? 10_000 : 560}>
      <View style={{ gap: 12 }}>
        {ResourceState({ resource: list, empty: list.data != null && !e, emptyMessage: 'This exception is not in the latest patrol exceptions.', what: 'patrol exception' })}
        {e ? (
          <PatrolPanel title={`Exception #${e.id}`} subtitle={`Times in site time (${zone}).`}>
            <KeyValue label="Status" value={e.status === 'resolved' ? 'Resolved' : e.status === 'acknowledged' ? 'Acknowledged' : 'Open'} />
            <KeyValue label="Window" value={`${formatPatrolDateTime(e.windowStart, zone)} – ${formatPatrolDateTime(e.windowEnd, zone)}`} />
            <KeyValue label="Raised" value={formatPatrolDateTime(e.createdAt, zone)} />
            {e.shiftId ? <KeyValue label="Shift" value={`#${e.shiftId}`} /> : null}
            <KeyValue label="Live Operations alert" value={e.safetyAlertId ? `#${e.safetyAlertId}${e.alertStatus ? ` (${e.alertStatus})` : ''}` : 'None'} />
            {e.resolution ? <KeyValue label="Resolution" value={e.resolution.replace(/_/g, ' ')} /> : null}
            {e.lateEvidenceAt ? <Notice tone="info" message={`Evidence reached S4 after the alert (${formatPatrolDateTime(e.lateEvidenceAt, zone)}). Confirm before resolving.`} /> : null}
            {e.runId ? <Button label="Open the patrol" variant="secondary" onPress={() => ctx.openRun(e.runId as number)} /> : null}
          </PatrolPanel>
        ) : null}
      </View>
    </Drawer>
  );
}
