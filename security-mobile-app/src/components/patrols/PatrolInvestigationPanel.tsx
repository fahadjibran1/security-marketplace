import * as React from 'react';
import { Text, View } from 'react-native';
import { getPatrolExceptionInvestigation } from '../../services/api';
import type { PatrolAttentionCase, PatrolInvestigation, PatrolInvestigationRun } from '../../types/patrols';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import type { PatrolPageContext } from './patrolContext';
import { PatrolEvidenceList } from './PatrolEvidenceList';
import { PatrolExceptionActions } from './PatrolExceptionActions';
import {
  affectedWindowsText,
  DATA_INCONSISTENCY_LABEL,
  INCONSISTENCY_NOTE,
  patrolCaseStatusLabel,
  patrolCaseTitle,
  RECONCILIATION_NOTE,
} from './patrolOperationsPresentation';
import { exceptionStatusLabel, exceptionTypeLabel, formatPatrolDateTime, runStatusLabel, verificationLabel } from './patrolPresentation';
import { BadgeRow, KeyValue, Notice, PatrolPanel, ResourceState, RowCard, ui, usePatrolResource } from './patrolUi';

const window = (start: string | null | undefined, end: string | null | undefined, zone: string) =>
  start ? `${formatPatrolDateTime(start, zone)}${end ? ` – ${formatPatrolDateTime(end, zone).slice(-5)}` : ''}` : 'Not recorded';

function checkpointText(run: PatrolInvestigationRun): string {
  if (run.checkpoints.required == null) return run.checkpoints.qrRuleMissing ? 'QR required, but the route has no checkpoints set' : 'QR not required';
  return `${run.checkpoints.verified ?? 0} of ${run.checkpoints.required} verified · ${run.checkpoints.scans} scan${run.checkpoints.scans === 1 ? '' : 's'}`;
}

function photoText(run: PatrolInvestigationRun): string {
  return `${run.photos.taken} taken · ${run.photos.verified} verified · ${run.photos.missing} missing`;
}

/**
 * S3 Stage 3 (owner-approved 4 Nov 2026): one patrol case, investigated from Live Operations without leaving it.
 * Read from GET /patrols/exceptions/:id/investigation (patrols.view). Photographs open only through the existing
 * audited evidence viewer (PatrolEvidenceList: a reason, a short-lived link, patrols.evidence) — never from this read.
 * Acknowledge / resolve use the existing patrol exception actions (acknowledge first; the existing reasons and note
 * rules; a 409 re-reads and explains). A reconciliation summary has no patrol record of its own: its actions are the
 * alert's, and resolving it leaves the windows it lists open.
 */
export function PatrolInvestigationPanel({
  ctx,
  patrolCase,
  onClose,
  onChanged,
  onOpenInPatrolManagement,
  summaryActions,
}: {
  ctx: PatrolPageContext;
  patrolCase: PatrolAttentionCase | null;
  onClose: () => void;
  /** Re-read the Live Operations patrol cases after an action (or a refusal). */
  onChanged: () => void;
  onOpenInPatrolManagement?: (c: PatrolAttentionCase) => void;
  /** A reconciliation summary's actions, through the existing alert lifecycle. */
  summaryActions?: { canAct: boolean; onAcknowledge: (c: PatrolAttentionCase) => Promise<void>; onResolve: (c: PatrolAttentionCase) => void };
}) {
  const exceptionId = patrolCase?.exceptionId ?? null;
  const resource = usePatrolResource<PatrolInvestigation>(
    `${ctx.companyKey}:investigation:${exceptionId ?? 'none'}`,
    () => getPatrolExceptionInvestigation(exceptionId as number),
    { enabled: exceptionId != null },
  );
  const inv = resource.data;
  const zone = inv?.site?.timeZone ?? patrolCase?.site?.timeZone ?? ctx.siteZone(patrolCase?.site?.id);
  const changed = () => { void resource.reload(true); onChanged(); };
  const [summaryBusy, setSummaryBusy] = React.useState(false);

  const title = patrolCase ? patrolCaseTitle(patrolCase) : 'Patrol case';
  const subtitle = patrolCase ? [patrolCase.site?.name, patrolCase.guardName].filter(Boolean).join(' · ') : undefined;

  return (
    <Drawer visible={patrolCase != null} onClose={onClose} title={title} subtitle={subtitle} width={ctx.layout.detailFullScreen ? 10_000 : 640}>
      {patrolCase ? (
        <View style={{ gap: 12 }} testID="patrol-investigation-panel">
          {/* The state in plain words ("Acknowledged by …" is who took it up, not an assignment). */}
          <Text style={ui.rowTitle} testID="patrol-investigation-state">{patrolCaseStatusLabel(patrolCase)}</Text>
          {patrolCase.lateEvidence ? <BadgeRow badges={[{ label: 'Late evidence', tone: 'info' }]} /> : null}
          {patrolCase.stateMismatch ? <Notice tone="error" message={`${DATA_INCONSISTENCY_LABEL}: ${INCONSISTENCY_NOTE}`} /> : null}

          {patrolCase.kind === 'reconciliation_summary' ? (
            <PatrolPanel title="Outage reconciliation" subtitle="S4 checked the patrol windows it could not judge while its checks were not running.">
              {patrolCase.message ? <Text style={ui.rowMeta}>{patrolCase.message}</Text> : null}
              <KeyValue label="Affected windows" value={affectedWindowsText(patrolCase.affectedWindows) ?? 'Not counted for this period'} />
              <KeyValue label="Raised" value={formatPatrolDateTime(patrolCase.raisedAt, zone)} />
              {patrolCase.acknowledgedByName ? <KeyValue label="Acknowledged by" value={`${patrolCase.acknowledgedByName} · ${formatPatrolDateTime(patrolCase.acknowledgedAt, zone)}`} /> : null}
              <Notice tone="info" message={RECONCILIATION_NOTE} />
              {summaryActions?.canAct ? (
                <View style={ui.actions}>
                  {patrolCase.status === 'open' ? (
                    <Button label="Acknowledge" size="sm" variant="secondary" loading={summaryBusy}
                      onPress={() => { setSummaryBusy(true); void summaryActions.onAcknowledge(patrolCase).finally(() => setSummaryBusy(false)); }} />
                  ) : (
                    <Button label="Resolve" size="sm" disabled={summaryBusy} onPress={() => summaryActions.onResolve(patrolCase)} />
                  )}
                </View>
              ) : null}
              {summaryActions?.canAct && patrolCase.status === 'open' ? <Text style={ui.muted}>Acknowledge this patrol alert first, then investigate and record the outcome.</Text> : null}
              {!summaryActions?.canAct ? <Text style={ui.muted}>Acknowledging and resolving needs the alerts or patrol management permission.</Text> : null}
            </PatrolPanel>
          ) : (
            <>
              <ResourceState resource={resource} empty={false} emptyMessage="" what="this patrol case" />
              {inv ? (
                <>
                  <PatrolPanel title="Case" subtitle={`Times in site time (${zone}).`}>
                    <KeyValue label="Finding" value={`${exceptionTypeLabel(inv.exception.type)} · ${exceptionStatusLabel(inv.exception.status)}`} />
                    <KeyValue label="Client" value={inv.site?.clientName ?? 'No client recorded'} />
                    <KeyValue label="Site" value={inv.site?.name ?? 'Patrol site'} />
                    <KeyValue label="Guard" value={inv.guard?.name ?? inv.shift?.guardName ?? 'No Guard recorded'} />
                    <KeyValue label="Shift" value={inv.shift ? `Shift ${inv.shift.id} · ${window(inv.shift.start, inv.shift.end, zone)}` : 'Site-wide patrol (any Guard on duty)'} />
                    <KeyValue label="Scheduled window" value={window(inv.scheduledWindow.start, inv.scheduledWindow.end, zone)} />
                    {inv.alert ? <KeyValue label="Raised" value={formatPatrolDateTime(inv.alert.raisedAt, zone)} /> : null}
                  </PatrolPanel>

                  <PatrolPanel title="Patrol" subtitle={inv.run ? (inv.run.unscheduled ? 'An ad-hoc patrol' : 'The patrol recorded for this window') : undefined}>
                    {inv.run ? (
                      <>
                        <KeyValue label="Status" value={`${runStatusLabel(inv.run.status)} · ${verificationLabel(inv.run.verificationStatus)}`} />
                        <KeyValue label="Verification" value={inv.run.verificationExplanation?.text ?? verificationLabel(inv.run.verificationStatus)} />
                        <KeyValue label="Started" value={formatPatrolDateTime(inv.run.startedAtDevice, zone)} />
                        <KeyValue label="QR checkpoints" value={checkpointText(inv.run)} />
                        {inv.run.missingCheckpoints?.length ? (
                          <KeyValue label="Missing checkpoints" value={inv.run.missingCheckpoints.map((c) => c.label ?? `#${c.id}`).join(', ')} />
                        ) : null}
                        <KeyValue label="Photos" value={photoText(inv.run)} />
                      </>
                    ) : (
                      <Text style={ui.rowMeta}>No patrol was started for this window.</Text>
                    )}
                  </PatrolPanel>

                  {inv.delayedEvidence.exceptionLateEvidenceAt || inv.delayedEvidence.alertLateSyncAt || inv.delayedEvidence.runSyncedLate || inv.delayedEvidence.receivedAfterWindow ? (
                    <PatrolPanel title="Late or offline evidence">
                      {inv.delayedEvidence.exceptionLateEvidenceAt ? <KeyValue label="Evidence after the alert" value={formatPatrolDateTime(inv.delayedEvidence.exceptionLateEvidenceAt, zone)} /> : null}
                      {inv.delayedEvidence.runSyncedLate ? <KeyValue label="Synced late" value="The Guard's phone sent this patrol after the window (offline)" /> : null}
                      {inv.delayedEvidence.receivedAfterWindow ? <KeyValue label="Photos received after the window" value={String(inv.delayedEvidence.receivedAfterWindow)} /> : null}
                    </PatrolPanel>
                  ) : null}

                  <PatrolPanel title="Photographs" subtitle={inv.evidence.counts ? `${inv.evidence.counts.total} recorded · ${inv.evidence.counts.verified} received and checked` : 'No photographs for this window'}>
                    {inv.run && inv.evidence.items && ctx.permissions.canViewEvidence ? (
                      <PatrolEvidenceList ctx={ctx} run={{ id: inv.run.id, shiftId: inv.run.shiftId, siteId: inv.site?.id ?? 0 }} evidence={inv.evidence.items} />
                    ) : inv.evidence.restricted ? (
                      <Text style={ui.muted} testID="patrol-investigation-evidence-restricted">Viewing photographs needs the patrol evidence permission.</Text>
                    ) : null}
                  </PatrolPanel>

                  {inv.relatedPatrols.length ? (
                    <PatrolPanel title="Patrols near this window" subtitle="Ad-hoc patrols, or another window's, within an hour. They do not complete this window.">
                      {inv.relatedPatrols.map((r) => (
                        <RowCard key={r.id} accessibilityLabel={`Patrol ${r.id}`}>
                          <Text style={ui.rowMeta}>{`P-${r.id} · ${r.guardName ?? 'Guard'} · started ${formatPatrolDateTime(r.startedAtDevice, zone)}`}</Text>
                          <Text style={ui.muted}>{`${r.unscheduled ? 'Ad-hoc' : 'Another window'} · ${runStatusLabel(r.status)} · ${photoText(r)}`}</Text>
                        </RowCard>
                      ))}
                    </PatrolPanel>
                  ) : null}

                  {inv.otherCasesForWindow.length ? (
                    <PatrolPanel title="Other cases for this window">
                      {inv.otherCasesForWindow.map((o) => (
                        <KeyValue key={o.exceptionId} label={exceptionTypeLabel(o.type)} value={exceptionStatusLabel(o.status)} />
                      ))}
                    </PatrolPanel>
                  ) : null}

                  <PatrolPanel title="Outcome">
                    <PatrolExceptionActions ctx={ctx} exception={{ ...inv.exception, alertStatus: inv.alert?.status ?? null }} onChanged={changed} />
                  </PatrolPanel>
                </>
              ) : null}
            </>
          )}

          {onOpenInPatrolManagement ? (
            <View style={ui.actions}>
              <Button label="Open in Patrol Management" size="sm" variant="tertiary" onPress={() => onOpenInPatrolManagement(patrolCase)} />
            </View>
          ) : null}
        </View>
      ) : null}
    </Drawer>
  );
}

