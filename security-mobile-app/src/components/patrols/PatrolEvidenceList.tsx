import * as React from 'react';
import { Image, Text, View } from 'react-native';
import { getPatrolEvidenceLink } from '../../services/api';
import { PATROL_EVIDENCE_ACCESS_PURPOSES, type PatrolEvidence, type PatrolEvidenceAccessPurpose, type PatrolRun } from '../../types/patrols';
import { Button } from '../ui/Button';
import { AppModal } from '../ui/Modal';
import { patrolFailureMessage } from './patrolAccess';
import type { PatrolPageContext } from './patrolContext';
import {
  canOpenEvidence,
  evidenceHeld,
  evidenceStatus,
  evidenceStatusLabel,
  evidenceStatusTone,
  formatBytes,
  formatPatrolDateTime,
  signedLinkLifetimeMs,
  signedLinkUsable,
} from './patrolPresentation';
import { Badge, ChipSelect, Notice, RowCard, ui } from './patrolUi';

const PURPOSE_LABELS: Record<PatrolEvidenceAccessPurpose, string> = {
  review: 'Routine review', incident: 'Incident', investigation: 'Investigation', client_request: 'Client request', legal: 'Legal', audit: 'Audit', other: 'Other',
};

type Viewer = { evidenceId: number; url: string; expiresAt: string };

/**
 * Photo evidence of one run: metadata, verification status, retention expiry and hold status. A photo is shown ONLY
 * through the P1-C short-lived, audited link, fetched when the person asks to view it (with a stated purpose). The link
 * lives in this component's memory until it expires or the viewer closes — never logged, stored, cached or reused.
 * Without patrols.evidence this component is never mounted and no link is ever requested.
 */
export function PatrolEvidenceList({ ctx, run, evidence }: { ctx: PatrolPageContext; run: Pick<PatrolRun, 'id' | 'shiftId' | 'siteId'>; evidence: PatrolEvidence[] }) {
  const [purpose, setPurpose] = React.useState<PatrolEvidenceAccessPurpose>('review');
  const [viewer, setViewer] = React.useState<Viewer | null>(null);
  const [opening, setOpening] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [expiredNote, setExpiredNote] = React.useState(false);

  // Drop the link the moment it stops being usable; also on unmount and on a company change.
  React.useEffect(() => {
    if (!viewer) return undefined;
    const id = setTimeout(() => { setViewer(null); setExpiredNote(true); }, signedLinkLifetimeMs(viewer, Date.now()));
    return () => clearTimeout(id);
  }, [viewer]);
  React.useEffect(() => { setViewer(null); }, [ctx.companyKey, run.id]);

  if (!ctx.permissions.canViewEvidence) return null;

  const open = async (item: PatrolEvidence) => {
    setOpening(item.id); setError(null); setExpiredNote(false);
    try {
      const link = await getPatrolEvidenceLink(item.id, purpose);
      if (!signedLinkUsable(link, Date.now())) throw new Error('The photo link had already expired. Try again.');
      setViewer({ evidenceId: item.id, url: link.url, expiresAt: link.expiresAt });
    } catch (failure) {
      setError(patrolFailureMessage(failure, 'Unable to open this photo.'));
    } finally {
      setOpening(null);
    }
  };

  const zone = ctx.siteZone(run.siteId);
  return (
    <View style={{ gap: 8 }}>
      {error ? <Notice tone="error" message={error} /> : null}
      {expiredNote ? <Notice tone="info" message="The photo link expired and was discarded. Open the photo again to view it." /> : null}
      {evidence.length ? (
        <ChipSelect label="Why are you viewing these photos?" options={PATROL_EVIDENCE_ACCESS_PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABELS[p] }))} value={purpose} onChange={setPurpose} scroll />
      ) : <Text style={ui.muted}>No photos were recorded for this patrol.</Text>}
      {evidence.map((item) => {
        const status = evidenceStatus(item);
        const held = evidenceHeld(item, run, ctx.holds, zone);
        return (
          <RowCard key={item.id}>
            <View style={ui.actions}>
              <View style={{ width: 56, height: 56, borderRadius: 6, backgroundColor: '#EAF0F5', alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Photo placeholder">
                <Text style={ui.muted}>Photo</Text>
              </View>
              <View style={{ flex: 1, gap: 2, minWidth: 160 }}>
                <View style={ui.actions}>
                  <Text style={ui.rowTitle}>{item.kind === 'checkpoint_photo' ? 'Checkpoint photo' : 'Patrol photo'} #{item.id}</Text>
                  <Badge label={evidenceStatusLabel(status)} tone={evidenceStatusTone(status)} />
                  {held === true ? <Badge label="On hold" tone="warning" /> : null}
                  {item.needsReview ? <Badge label="Needs review" tone="warning" /> : null}
                </View>
                <Text style={ui.rowMeta}>Taken {formatPatrolDateTime(item.capturedAtDevice, zone)} (device) · received {formatPatrolDateTime(item.receivedAt, zone)}</Text>
                <Text style={ui.rowMeta}>
                  {item.expiresAt ? `Retention: until ${formatPatrolDateTime(item.expiresAt, zone)}` : 'Retention: starts once verified'}
                  {item.retentionDays ? ` (${item.retentionDays} days)` : ''}
                  {held === true ? ' · held — not deleted while the hold is active' : held === null ? ' · hold status visible to Owner / Admin' : ''}
                </Text>
                {item.sizeBytes ? <Text style={ui.rowMeta}>{formatBytes(item.sizeBytes)}{item.widthPx && item.heightPx ? ` · ${item.widthPx}×${item.heightPx}` : ''}</Text> : null}
                {item.rejectionReason ? <Text style={ui.rowMeta}>Rejected: {item.rejectionReason}</Text> : null}
              </View>
              {canOpenEvidence(item) ? (
                <Button label="View photo" size="sm" variant="secondary" loading={opening === item.id} onPress={() => { void open(item); }} />
              ) : null}
            </View>
          </RowCard>
        );
      })}
      <AppModal visible={Boolean(viewer)} onClose={() => setViewer(null)} title={viewer ? `Photo #${viewer.evidenceId}` : 'Photo'} subtitle="Short-lived link. Viewing is recorded in the audit log." size="large">
        {viewer ? (
          <Image
            accessibilityLabel={`Patrol photo ${viewer.evidenceId}`}
            source={{ uri: viewer.url, cache: 'reload' } as any}
            style={{ width: '100%', height: 420, resizeMode: 'contain', backgroundColor: '#0B1F33' } as any}
          />
        ) : null}
      </AppModal>
    </View>
  );
}
