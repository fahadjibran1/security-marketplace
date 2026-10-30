import * as React from 'react';
import { Image, Platform, Text, View } from 'react-native';
import { getPatrolEvidenceLink, getPatrolEvidenceThumbnails } from '../../services/api';
import { PATROL_EVIDENCE_ACCESS_PURPOSES, type PatrolEvidence, type PatrolEvidenceAccessPurpose, type PatrolRun } from '../../types/patrols';
import { Button } from '../ui/Button';
import { AppModal } from '../ui/Modal';
import { patrolFailureMessage } from './patrolAccess';
import type { PatrolPageContext } from './patrolContext';
import {
  PATROL_THUMBNAIL_PAGE_SIZE,
  canOpenEvidence,
  evidenceHeld,
  evidencePage,
  evidenceStatus,
  evidenceStatusLabel,
  evidenceStatusTone,
  formatBytes,
  formatPatrolDateTime,
  signedLinkLifetimeMs,
  signedLinkUsable,
  thumbnailLinks,
} from './patrolPresentation';
import { Badge, ChipSelect, Notice, RowCard, ui } from './patrolUi';

const PURPOSE_LABELS: Record<PatrolEvidenceAccessPurpose, string> = {
  review: 'Routine review', incident: 'Incident', investigation: 'Investigation', client_request: 'Client request', legal: 'Legal', audit: 'Audit', other: 'Other',
};

type Viewer = { evidenceId: number; url: string; expiresAt: string };
type Previews = { key: string; expiresAt: string; links: Map<number, string> };

/** The browser's own <img> (web only), for native lazy loading. */
const HtmlImg: any = 'img';

const TILE = { width: 56, height: 56, borderRadius: 6, backgroundColor: '#EAF0F5', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' } as const;

/**
 * A small preview of one photo from a short-lived link. On the web it is a native <img loading="lazy">, so the browser
 * fetches it only when the row scrolls into view, and sends no referrer. If the browser cannot draw the stored format
 * (HEIC outside Safari) the tile says so and the full photo can still be opened.
 */
function PhotoPreview({ evidenceId, url, onError }: { evidenceId: number; url: string; onError: () => void }) {
  const label = `Preview of patrol photo ${evidenceId}`;
  if (Platform.OS === 'web') {
    return (
      <HtmlImg src={url} alt={label} aria-label={label} loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} onError={onError}
        width={56} height={56} style={{ width: 56, height: 56, objectFit: 'cover', display: 'block' }} />
    );
  }
  return <Image accessibilityLabel={label} source={{ uri: url, cache: 'reload' } as any} onError={onError} style={{ width: 56, height: 56 }} resizeMode="cover" />;
}

/**
 * Photo evidence of one run: metadata, verification status, retention expiry and hold status, a page at a time.
 *
 * Previews (issue #79): for the page on screen, ONE request for the page's short-lived links (the server audits it once,
 * purpose browse), drawn small and lazy-loaded. The links live in this component's memory until they expire (then they
 * are discarded and can be asked for again), the page changes, the company changes or the list closes — never logged,
 * stored, cached or reused. Pending, rejected, deleted and expired photos get no link and keep the placeholder.
 *
 * Full view: one photo through the P1-C short-lived link, fetched only when the person asks (with a stated purpose).
 * Without patrols.evidence this component is never mounted and no link of any kind is ever requested.
 */
export function PatrolEvidenceList({ ctx, run, evidence }: { ctx: PatrolPageContext; run: Pick<PatrolRun, 'id' | 'shiftId' | 'siteId'>; evidence: PatrolEvidence[] }) {
  const [purpose, setPurpose] = React.useState<PatrolEvidenceAccessPurpose>('review');
  const [viewer, setViewer] = React.useState<Viewer | null>(null);
  const [opening, setOpening] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [expiredNote, setExpiredNote] = React.useState(false);
  const [requestedPage, setPage] = React.useState(1);
  const [previews, setPreviews] = React.useState<Previews | null>(null);
  const [previewState, setPreviewState] = React.useState<'idle' | 'loading' | 'expired' | 'error'>('idle');
  const [previewAttempt, setPreviewAttempt] = React.useState(0);
  const [broken, setBroken] = React.useState<Set<number>>(() => new Set());

  const page = evidencePage(evidence, requestedPage, PATROL_THUMBNAIL_PAGE_SIZE);
  const viewableIds = page.items.filter(canOpenEvidence).map((e) => e.id);
  const pageKey = `${ctx.companyKey}|${run.id}|${page.page}|${viewableIds.join(',')}`;
  const allowed = ctx.permissions.canViewEvidence;

  // Drop the link the moment it stops being usable; also on unmount and on a company change.
  React.useEffect(() => {
    if (!viewer) return undefined;
    const id = setTimeout(() => { setViewer(null); setExpiredNote(true); }, signedLinkLifetimeMs(viewer, Date.now()));
    return () => clearTimeout(id);
  }, [viewer]);
  React.useEffect(() => { setViewer(null); setPage(1); }, [ctx.companyKey, run.id]);

  // One preview grant per page view, only when the page has a photo that can be shown.
  React.useEffect(() => {
    setPreviews(null);
    setBroken(new Set());
    if (!allowed || viewableIds.length === 0) { setPreviewState('idle'); return undefined; }
    let live = true;
    setPreviewState('loading');
    getPatrolEvidenceThumbnails(run.id, { page: page.page, pageSize: PATROL_THUMBNAIL_PAGE_SIZE })
      .then((grant) => {
        if (!live) return;
        const links = thumbnailLinks(grant, viewableIds, Date.now());
        if (!links.size || !grant?.expiresAt) { setPreviewState('error'); return; }
        setPreviews({ key: pageKey, expiresAt: grant.expiresAt, links });
        setPreviewState('idle');
      })
      .catch(() => { if (live) setPreviewState('error'); });
    return () => { live = false; };
    // pageKey captures the company, run, page and which photos on it are viewable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey, allowed, previewAttempt]);

  // Discard the preview links when they expire (they can be asked for again).
  React.useEffect(() => {
    if (!previews) return undefined;
    const id = setTimeout(() => { setPreviews(null); setPreviewState('expired'); }, signedLinkLifetimeMs(previews, Date.now()));
    return () => clearTimeout(id);
  }, [previews]);

  if (!allowed) return null;

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

  const links = previews && previews.key === pageKey ? previews.links : null;
  const zone = ctx.siteZone(run.siteId);
  return (
    <View style={{ gap: 8 }}>
      {error ? <Notice tone="error" message={error} /> : null}
      {expiredNote ? <Notice tone="info" message="The photo link expired and was discarded. Open the photo again to view it." /> : null}
      {evidence.length ? (
        <ChipSelect label="Why are you viewing these photos?" options={PATROL_EVIDENCE_ACCESS_PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABELS[p] }))} value={purpose} onChange={setPurpose} scroll />
      ) : <Text style={ui.muted}>No photos were recorded for this patrol.</Text>}
      {evidence.length ? <Text style={ui.rowMeta}>Previews of this page are recorded once in the audit log. Opening a photo records it with your reason.</Text> : null}
      {previewState === 'expired' ? (
        <View style={ui.actions}>
          <Notice tone="info" message="Photo previews expired and were discarded." />
          <Button label="Show previews again" size="sm" variant="secondary" onPress={() => { setPreviewState('loading'); setPreviewAttempt((n) => n + 1); }} />
        </View>
      ) : null}
      {previewState === 'error' ? (
        <View style={ui.actions}>
          <Notice tone="error" message="Photo previews could not be loaded." />
          <Button label="Try previews again" size="sm" variant="secondary" onPress={() => { setPreviewState('loading'); setPreviewAttempt((n) => n + 1); }} />
        </View>
      ) : null}
      {page.items.map((item) => {
        const status = evidenceStatus(item);
        const held = evidenceHeld(item, run, ctx.holds, zone);
        const preview = links?.get(item.id);
        return (
          <RowCard key={item.id}>
            <View style={ui.actions}>
              <View style={TILE as any}>
                {preview && !broken.has(item.id)
                  ? <PhotoPreview evidenceId={item.id} url={preview} onError={() => setBroken((b) => new Set(b).add(item.id))} />
                  : (
                    <View accessibilityLabel={broken.has(item.id) ? 'Preview unavailable' : 'Photo placeholder'}>
                      <Text style={ui.muted}>{broken.has(item.id) ? 'No preview' : canOpenEvidence(item) && previewState === 'loading' ? '…' : 'Photo'}</Text>
                    </View>
                  )}
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
      {page.totalPages > 1 ? (
        <View style={ui.actions}>
          <Text style={ui.rowMeta}>{page.label}</Text>
          <Button label="Previous photos" size="sm" variant="secondary" disabled={page.page <= 1} onPress={() => setPage(page.page - 1)} />
          <Button label="Next photos" size="sm" variant="secondary" disabled={page.page >= page.totalPages} onPress={() => setPage(page.page + 1)} />
        </View>
      ) : null}
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
