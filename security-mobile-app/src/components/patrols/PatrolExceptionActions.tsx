import * as React from 'react';
import { Text, View } from 'react-native';
import { acknowledgePatrolException, resolvePatrolException } from '../../services/api';
import type { PatrolException } from '../../types/patrols';
import { Button } from '../ui/Button';
import {
  RESOLUTION_NOTE_MAX_LENGTH,
  requiresResolutionNote,
  resolutionLabel,
  resolutionOptions,
  validateResolution,
  type ResolutionFamily,
} from '../company/alertResolution';
import { patrolConflictMessage, patrolFailureMessage } from './patrolAccess';
import type { PatrolPageContext } from './patrolContext';
import { exceptionStatusLabel, formatPatrolDateTime } from './patrolPresentation';
import { ChipSelect, KeyValue, Notice, TextField, ui } from './patrolUi';

/**
 * The patrol resolution reasons for one exception (S4 1.2.1), from the SAME table the Live Operations resolve dialog uses
 * (alertResolution.ts, mirroring PATROL_RESOLUTION_REASONS): "Patrol completed — late sync" only once evidence reached
 * S4 after the exception (lateEvidenceAt), which is exactly when the server accepts it.
 */
export function exceptionResolutionFamily(exception: Pick<PatrolException, 'lateEvidenceAt'>): ResolutionFamily {
  return exception.lateEvidenceAt ? 'patrol_late_sync' : 'patrol';
}

/** Whether a failed action means "someone resolved it meanwhile" (409 PATROL_EXCEPTION_ALREADY_RESOLVED). */
export function isAlreadyResolved(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  const body = (error as { body?: { code?: unknown } })?.body;
  return status === 409 && body?.code === 'PATROL_EXCEPTION_ALREADY_RESOLVED';
}

/**
 * The decision on one patrol exception and, for people allowed to act (alerts.manage or patrols.manage, or the legacy
 * owner — canActOnExceptions), Acknowledge / Resolve through the EXISTING patrol exception endpoints. The server stays the
 * source of truth: after every action, and after a refusal, `onChanged` re-reads it, so a cached "Open" never outlives
 * the server's "Resolved". A linked Live Operations alert moves with it (the backend acts through the alert lifecycle).
 */
export function PatrolExceptionActions({ ctx, exception, onChanged }: { ctx: PatrolPageContext; exception: PatrolException; onChanged: () => void }) {
  const zone = ctx.siteZone(exception.siteId);
  const family = exceptionResolutionFamily(exception);
  const [resolving, setResolving] = React.useState(false);
  const [reason, setReason] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'error' | 'info'; message: string } | null>(null);
  // A different exception (or a fresh server state) starts a fresh form.
  React.useEffect(() => { setResolving(false); setReason(null); setNote(''); setNotice(null); }, [exception.id]);
  React.useEffect(() => { if (exception.status === 'resolved') setResolving(false); }, [exception.status]);

  const canAct = ctx.permissions.canActOnExceptions && exception.status !== 'resolved';
  // S3 Stage 1: an exception with a Live Operations alert is acknowledged before it is resolved (the backend enforces it).
  // An exception with no alert (not actionable under the policy) keeps its direct resolution.
  const mustAcknowledgeFirst = Boolean(exception.safetyAlertId) && exception.status === 'open';

  const act = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await fn();
      setNotice({ tone: 'success', message: success });
      setResolving(false);
    } catch (error) {
      const conflict = patrolConflictMessage(error);
      setNotice(isAlreadyResolved(error)
        ? { tone: 'info', message: 'This exception was already resolved. Showing the latest decision.' }
        : conflict
          ? { tone: 'info', message: conflict }
          : { tone: 'error', message: patrolFailureMessage(error, 'Unable to update this exception.') });
      if (conflict) setResolving(false);
    } finally {
      setBusy(false);
      onChanged(); // always re-read the server's state
    }
  };

  const acknowledge = () => act(() => acknowledgePatrolException(exception.id), 'Exception acknowledged.');
  const resolve = () => {
    const check = validateResolution(family, { reason, note });
    if (!check.ok) { setNotice({ tone: 'error', message: check.message ?? 'Check the resolution.' }); return; }
    const trimmed = note.trim();
    return act(() => resolvePatrolException(exception.id, { resolutionReason: reason as string, ...(trimmed ? { resolutionNote: trimmed } : {}) }), 'Exception resolved.');
  };

  return (
    <View style={{ gap: 8 }}>
      <KeyValue label="Status" value={exceptionStatusLabel(exception.status)} />
      {exception.acknowledgedAt ? (
        <KeyValue label="Acknowledged" value={`${formatPatrolDateTime(exception.acknowledgedAt, zone)}${exception.acknowledgedByName ? ` by ${exception.acknowledgedByName}` : ''}`} />
      ) : null}
      {exception.resolution ? <KeyValue label="Resolution" value={resolutionLabel('patrol_late_sync', exception.resolution)} /> : null}
      {exception.resolvedAt ? (
        <KeyValue label="Resolved" value={`${formatPatrolDateTime(exception.resolvedAt, zone)}${exception.resolvedByName ? ` by ${exception.resolvedByName}` : ''}`} />
      ) : null}
      {notice ? <Notice tone={notice.tone} message={notice.message} /> : null}
      {canAct && !resolving ? (
        <View style={ui.actions}>
          {exception.status === 'open' ? <Button label="Acknowledge" size="sm" variant="secondary" loading={busy} onPress={() => { void acknowledge(); }} /> : null}
          {mustAcknowledgeFirst ? null : <Button label="Resolve" size="sm" disabled={busy} onPress={() => { setNotice(null); setResolving(true); }} />}
        </View>
      ) : null}
      {canAct && mustAcknowledgeFirst ? <Text style={ui.muted}>Acknowledge this patrol alert first, then investigate and record the outcome.</Text> : null}
      {canAct && resolving ? (
        <View style={{ gap: 8 }}>
          <ChipSelect label="Resolution reason" options={resolutionOptions(family).map((o) => ({ value: o.value, label: o.label }))} value={reason} onChange={(v) => setReason(String(v))} />
          <TextField
            label={requiresResolutionNote(family, reason) ? 'Resolution note (required)' : 'Resolution note (optional)'}
            value={note}
            onChangeText={setNote}
            multiline
            helper={`What was established. At most ${RESOLUTION_NOTE_MAX_LENGTH} characters.`}
          />
          <View style={ui.actions}>
            <Button label="Confirm resolution" size="sm" loading={busy} onPress={() => { void resolve(); }} />
            <Button label="Cancel" size="sm" variant="tertiary" disabled={busy} onPress={() => { setResolving(false); setNotice(null); }} />
          </View>
        </View>
      ) : null}
      {exception.safetyAlertId && ctx.openLiveOperationsAlert ? (
        <View style={ui.actions}>
          <Button
            label="Open in Live Operations"
            size="sm"
            variant="tertiary"
            onPress={() => ctx.openLiveOperationsAlert?.({ alertId: exception.safetyAlertId as number, shiftId: exception.shiftId ?? null })}
          />
        </View>
      ) : null}
      {!ctx.permissions.canActOnExceptions && exception.status !== 'resolved' ? (
        <Text style={ui.muted}>Acknowledging and resolving needs the alerts or patrol management permission.</Text>
      ) : null}
    </View>
  );
}
