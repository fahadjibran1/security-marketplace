import * as React from 'react';
import { Image, Text, View } from 'react-native';
import { getPatrolEvidenceLink, getPatrolEvidencePatrols, getPatrolEvidenceStampedImage, getPatrolEvidenceTree } from '../../services/api';
import { colors } from '../../theme';
import {
  PATROL_EVIDENCE_ACCESS_PURPOSES,
  type PatrolEvidenceAccessPurpose,
  type PatrolEvidenceCard,
  type PatrolEvidenceCardPhoto,
  type PatrolEvidenceTreeSite,
} from '../../types/patrols';
import { Button } from '../ui/Button';
import { AppModal } from '../ui/Modal';
import { patrolFailureMessage } from './patrolAccess';
import { DEFAULT_SITE_ZONE, type PatrolPageContext } from './patrolContext';
import {
  formatPatrolDate,
  formatPatrolDateTime,
  patrolColumn,
  patrolColumns,
  runStatusLabel,
  scanFlagLabel,
  signedLinkLifetimeMs,
  signedLinkUsable,
  siteTodayKey,
  verificationLabel,
  type PatrolTone,
} from './patrolPresentation';
import { Badge, ChipSelect, KeyValue, Notice, PatrolPanel, ResourceState, RowCard, ui, usePatrolResource } from './patrolUi';

const PURPOSE_LABELS: Record<PatrolEvidenceAccessPurpose, string> = {
  review: 'Routine review', incident: 'Incident', investigation: 'Investigation', client_request: 'Client request', legal: 'Legal', audit: 'Audit', other: 'Other',
};
const RANGES = [7, 30, 90];

export type EvidenceView = 'original' | 'stamped';
type Viewing = { evidenceId: number; view: EvidenceView; uri: string; expiresAt: string | null };

/** YYYY-MM-DD minus n days (calendar arithmetic on the date itself, no clock or zone involved). */
export function minusDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - days));
  return t.toISOString().slice(0, 10);
}

/** "Patrol time" groups: the window the patrol answered, else "Unscheduled" at its start (site time). */
export function patrolTimeGroups(cards: PatrolEvidenceCard[], timeZone: string): Array<{ key: string; label: string; cards: PatrolEvidenceCard[] }> {
  const groups = new Map<string, { key: string; label: string; sortAt: string; cards: PatrolEvidenceCard[] }>();
  for (const card of cards) {
    const key = card.window ? `w:${card.window.start}` : `u:${card.run.id}`;
    const label = card.window
      ? `${card.window.label}${card.window.scheduleName ? ` · ${card.window.scheduleName}` : ''}`
      : `Unscheduled · started ${formatPatrolDateTime(card.run.startedAtServer, timeZone).slice(-5)}`;
    const group = groups.get(key) ?? { key, label, sortAt: card.window?.start ?? card.run.startedAtServer ?? '', cards: [] };
    group.cards.push(card);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.sortAt.localeCompare(b.sortAt)).map(({ key, label, cards: list }) => ({ key, label, cards: list }));
}

function verificationTone(status: string): PatrolTone {
  return status === 'verified' ? 'success' : status === 'flagged' ? 'danger' : status === 'unverified' ? 'warning' : 'pending';
}

/**
 * S4 1.3.0 B2 — Evidence: browse Client → Site → Date → Patrol time → Guard (GET /patrols/evidence/tree and
 * /patrols/evidence/patrols). Every patrol is listed, QR-only ones included; "Photos only" keeps the patrols with a photo.
 * One patrol record shows its QR scans, photos, verification status and the server's plain-English explanation. A photo
 * opens as the ORIGINAL (the existing short-lived, audited link, with a stated reason) or STAMPED (derived by the server
 * on request, audited, never stored). Neither link nor image data is ever written as text, logged or kept after the
 * viewer closes. Photos need patrols.evidence; without it the record says so and nothing is requested.
 */
export function PatrolEvidenceBrowser({ ctx }: { ctx: PatrolPageContext }) {
  const [rangeDays, setRangeDays] = React.useState(7);
  const [photos, setPhotos] = React.useState<'all' | 'only'>('all');
  const [day, setDay] = React.useState<{ siteId: number; date: string } | null>(null);
  const [openSiteId, setOpenSiteId] = React.useState<number | null>(null);
  const [reference, setReference] = React.useState<string | null>(null);
  const today = siteTodayKey(ctx.siteZone(ctx.siteId) || DEFAULT_SITE_ZONE);
  const from = rangeDays === 7 ? null : minusDays(today, rangeDays - 1);
  const to = rangeDays === 7 ? null : today;

  React.useEffect(() => { setDay(null); setReference(null); setOpenSiteId(null); }, [ctx.companyKey, ctx.siteId, rangeDays]);
  React.useEffect(() => { setReference(null); }, [day?.siteId, day?.date, photos]);

  const tree = usePatrolResource(`etree|${ctx.companyKey}|${ctx.siteId ?? 'all'}|${from ?? ''}|${to ?? ''}`, () => getPatrolEvidenceTree({ siteId: ctx.siteId, from, to }));
  const patrols = usePatrolResource(
    `epat|${ctx.companyKey}|${day?.siteId ?? 0}|${day?.date ?? ''}|${photos}`,
    () => getPatrolEvidencePatrols({ siteId: day!.siteId, date: day!.date, photos }),
    { enabled: day != null },
  );

  const clients = tree.data?.clients ?? [];
  const sites = clients.flatMap((c) => c.sites);
  const empty = tree.data != null && sites.every((s) => (photos === 'only' ? s.withPhotos : s.patrols) === 0);
  const cards = patrols.data?.patrols ?? [];
  const selected = cards.find((c) => c.reference === reference) ?? null;
  const zone = patrols.data?.timezone ?? ctx.siteZone(day?.siteId);

  const daySite = sites.find((s) => s.siteId === day?.siteId) ?? null;
  const dayClient = clients.find((c) => c.sites.some((s) => s.siteId === day?.siteId)) ?? null;

  const siteRow = (site: PatrolEvidenceTreeSite) => {
    const count = photos === 'only' ? site.withPhotos : site.patrols;
    const days = site.days.filter((d) => (photos === 'only' ? d.withPhotos : d.patrols) > 0);
    const open = openSiteId === site.siteId || (day?.siteId === site.siteId);
    return (
      <View key={site.siteId} style={{ gap: 6 }}>
        <RowCard accessibilityLabel={`Site ${site.siteName}`} onPress={() => setOpenSiteId(open ? null : site.siteId)}>
          <View style={ui.actions}>
            <Text style={ui.rowTitle}>{site.siteName}</Text>
            <Badge label={`${count} patrol${count === 1 ? '' : 's'}`} tone={count ? 'info' : 'neutral'} />
          </View>
          <Text style={ui.rowMeta}>{site.withPhotos} with photos · {site.patrols - site.withPhotos} QR only or without photos</Text>
        </RowCard>
        {open ? (
          days.length ? (
            <View style={[ui.chipRowWrap, { paddingLeft: 12 }]}>
              {days.map((d) => {
                const n = photos === 'only' ? d.withPhotos : d.patrols;
                const chosen = day?.siteId === site.siteId && day?.date === d.date;
                return (
                  <View key={d.date}><Button size="sm" variant={chosen ? 'primary' : 'secondary'} accessibilityLabel={`${site.siteName} ${d.date}`}
                    label={`${formatPatrolDate(d.date)} · ${n}`} onPress={() => setDay({ siteId: site.siteId, date: d.date })} /></View>
                );
              })}
            </View>
          ) : <Text style={[ui.muted, { paddingLeft: 12 }]}>No patrols in this range{photos === 'only' ? ' with photos' : ''}.</Text>
        ) : null}
      </View>
    );
  };

  return (
    <View style={{ gap: 12 }} testID="patrol-evidence-browser">
      <View style={ui.grid}>
        <ChipSelect label="Show" options={[{ value: 'all', label: 'All patrols' }, { value: 'only', label: 'Photos only' }]} value={photos} onChange={(v) => setPhotos(v as 'all' | 'only')} />
        <ChipSelect label="Range" options={RANGES.map((n) => ({ value: n, label: `Last ${n} days` }))} value={rangeDays} onChange={(v) => setRangeDays(Number(v))} />
      </View>
      <Text style={ui.muted}>
        {tree.data ? `${formatPatrolDate(tree.data.from)} to ${formatPatrolDate(tree.data.to)}, each site's own dates. ` : ''}
        QR-only patrols are included{photos === 'only' ? ' unless "Photos only" is chosen' : ''}.
      </Text>
      {ResourceState({ resource: tree, empty, emptyMessage: photos === 'only' ? 'No patrols with photos in this range.' : 'No patrols in this range.', what: 'patrol evidence' })}

      <View style={patrolColumns(ctx.layout)} testID="patrol-evidence-columns">
        <View style={[{ gap: 8 }, patrolColumn(ctx.layout, 1)]} testID="patrol-evidence-tree">
          {clients.map((client) => (
            <View key={`${client.clientId ?? 'none'}|${client.clientName ?? ''}`} style={{ gap: 6 }}>
              <Text style={ui.fieldLabel} accessibilityRole="header">{client.clientName ?? 'No client'}</Text>
              {client.sites.map(siteRow)}
            </View>
          ))}
        </View>

        <View style={[{ gap: 8 }, patrolColumn(ctx.layout, 1)]} testID="patrol-evidence-day">
          {day ? (
            <PatrolPanel
              title={`${daySite?.siteName ?? ctx.siteName(day.siteId)} · ${formatPatrolDate(day.date)}`}
              subtitle={`${dayClient?.clientName ?? 'No client'} › ${daySite?.siteName ?? ''} › ${formatPatrolDate(day.date)} (site time${zone ? `, ${zone}` : ''})`}
            >
              {ResourceState({ resource: patrols, empty: patrols.data != null && cards.length === 0, emptyMessage: photos === 'only' ? 'No patrols with photos on this day.' : 'No patrols on this day.', what: 'patrols' })}
              {patrolTimeGroups(cards, zone).map((group) => (
                <View key={group.key} style={{ gap: 6 }}>
                  <Text style={ui.fieldLabel}>{group.label}</Text>
                  {group.cards.map((card) => (
                    <RowCard key={card.reference} accessibilityLabel={`Open ${card.reference} ${card.guard.displayName}`} onPress={() => setReference(card.reference)}>
                      <View style={ui.actions}>
                        <Text style={ui.rowTitle}>{card.guard.displayName}</Text>
                        <Badge label={verificationLabel(card.verification.status)} tone={verificationTone(card.verification.status)} />
                        {card.reference === reference ? <Badge label="Open" tone="info" /> : null}
                      </View>
                      <Text style={ui.rowMeta}>
                        {card.reference} · {card.qrScans.length} QR scan{card.qrScans.length === 1 ? '' : 's'} · {card.photoCount} photo{card.photoCount === 1 ? '' : 's'}
                      </Text>
                    </RowCard>
                  ))}
                </View>
              ))}
            </PatrolPanel>
          ) : (
            <PatrolPanel title="Patrols" subtitle="Choose a site and a date to see its patrols."><Text style={ui.muted}>Nothing chosen yet.</Text></PatrolPanel>
          )}
        </View>

        <View style={patrolColumn(ctx.layout, 1.4)} testID="patrol-evidence-record">
          {selected ? <PatrolEvidenceRecord ctx={ctx} card={selected} timeZone={zone} siteName={patrols.data?.siteName ?? ''} /> : (
            <PatrolPanel title="Patrol record" subtitle="Choose a patrol to see its scans, photos and verification."><Text style={ui.muted}>No patrol chosen.</Text></PatrolPanel>
          )}
        </View>
      </View>
    </View>
  );
}

/** One patrol: who, when, verification and why, QR scans, and its photos (original or stamped, on request). */
export function PatrolEvidenceRecord({ ctx, card, timeZone, siteName }: { ctx: PatrolPageContext; card: PatrolEvidenceCard; timeZone: string; siteName: string }) {
  const [view, setView] = React.useState<EvidenceView>('original');
  const [purpose, setPurpose] = React.useState<PatrolEvidenceAccessPurpose>('review');
  const [viewing, setViewing] = React.useState<Viewing | null>(null);
  const [opening, setOpening] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Drop what is on screen when the record, the company or the choice changes; an original's link also at expiry.
  React.useEffect(() => { setViewing(null); setError(null); }, [card.reference, ctx.companyKey]);
  React.useEffect(() => {
    if (!viewing?.expiresAt) return undefined;
    const id = setTimeout(() => setViewing(null), signedLinkLifetimeMs({ expiresAt: viewing.expiresAt }, Date.now()));
    return () => clearTimeout(id);
  }, [viewing]);

  const open = async (photo: PatrolEvidenceCardPhoto) => {
    setOpening(photo.id); setError(null);
    try {
      if (view === 'stamped') {
        const stamped = await getPatrolEvidenceStampedImage(photo.id);
        setViewing({ evidenceId: photo.id, view, uri: stamped.dataUri, expiresAt: null });
      } else {
        const link = await getPatrolEvidenceLink(photo.id, purpose);
        if (!signedLinkUsable(link, Date.now())) throw new Error('The photo link had already expired. Try again.');
        setViewing({ evidenceId: photo.id, view, uri: link.url, expiresAt: link.expiresAt });
      }
    } catch (failure) {
      setError(patrolFailureMessage(failure, view === 'stamped' ? 'Unable to show the stamped photo.' : 'Unable to open this photo.'));
    } finally {
      setOpening(null);
    }
  };

  const run = card.run;
  return (
    <PatrolPanel title={`Patrol ${card.reference}`} subtitle={`${siteName} · ${card.guard.displayName}`}>
      <View style={ui.actions}>
        <Badge label={verificationLabel(card.verification.status)} tone={verificationTone(card.verification.status)} />
        <Badge label={runStatusLabel(run.status)} tone="neutral" />
      </View>
      <Text style={[ui.rowMeta, { color: colors.textPrimary }]} accessibilityLabel="Verification explanation">{card.verification.text}</Text>
      <KeyValue label="Guard" value={card.guard.displayName} />
      <KeyValue label="Patrol time" value={card.window ? card.window.label : 'Unscheduled'} />
      <KeyValue label="Started (device)" value={formatPatrolDateTime(run.startedAtDevice, timeZone)} />
      <KeyValue label="Received by S4" value={formatPatrolDateTime(run.startedAtServer, timeZone)} />
      {run.completedAtServer ? <KeyValue label="Completed" value={formatPatrolDateTime(run.completedAtServer, timeZone)} /> : null}

      <Text style={ui.fieldLabel}>QR scans ({card.qrScans.length})</Text>
      {card.qrScans.length ? card.qrScans.map((scan) => (
        <View key={scan.id} style={ui.actions}>
          <Text style={ui.rowMeta}>{formatPatrolDateTime(scan.scannedAtDevice, timeZone).slice(-5)} · {scan.label ?? 'Unknown checkpoint'}</Text>
          <Badge label={scan.result === 'verified' ? 'Verified scan' : scan.result === 'flagged' ? 'Flagged' : 'Unverified'} tone={scan.result === 'verified' ? 'success' : scan.result === 'flagged' ? 'danger' : 'pending'} />
          {scan.flags.length ? <Text style={ui.muted}>{scan.flags.map(scanFlagLabel).join(' · ')}</Text> : null}
        </View>
      )) : <Text style={ui.muted}>No QR scans in this patrol.</Text>}

      <Text style={ui.fieldLabel}>Photos ({card.photoCount})</Text>
      {card.photosRestricted ? (
        <Text style={ui.muted}>Photos are visible to Owner, Admin, Operations and Control Room.</Text>
      ) : !card.photos || !card.photos.length ? (
        <Text style={ui.muted}>No photos in this patrol.</Text>
      ) : (
        <View style={{ gap: 8 }}>
          <ChipSelect label="View photos as" options={[{ value: 'original', label: 'Original' }, { value: 'stamped', label: 'Stamped' }]} value={view} onChange={(v) => { setView(v as EvidenceView); setViewing(null); }} />
          <Text style={ui.muted}>
            {view === 'original'
              ? 'The photo exactly as the Guard\'s phone sent it, opened through a short-lived link. Each view is recorded with your reason.'
              : 'A copy with the company, client, site, Guard, both times and www.sfour.co.uk printed on it, made for you on request. The original is unchanged; each view is recorded.'}
          </Text>
          {view === 'original' ? (
            <ChipSelect label="Why are you viewing these photos?" scroll options={PATROL_EVIDENCE_ACCESS_PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABELS[p] }))} value={purpose} onChange={setPurpose} />
          ) : null}
          {error ? <Notice tone="error" message={error} /> : null}
          {card.photos.map((photo) => (
            <RowCard key={photo.id}>
              <View style={ui.actions}>
                <Text style={ui.rowTitle}>{photo.kind === 'checkpoint_photo' ? 'Checkpoint photo' : 'Patrol photo'} #{photo.id}</Text>
                <Badge label={photo.viewable ? 'Verified' : photo.uploadStatus === 'pending' ? 'Waiting for upload' : 'Not viewable'} tone={photo.viewable ? 'success' : 'pending'} />
                {photo.viewable ? (
                  <Button label={view === 'stamped' ? 'View stamped' : 'View original'} size="sm" variant="secondary" loading={opening === photo.id} onPress={() => { void open(photo); }} />
                ) : null}
              </View>
              <Text style={ui.rowMeta}>Taken {formatPatrolDateTime(photo.capturedAtDevice, timeZone)} (device) · received {formatPatrolDateTime(photo.receivedAt, timeZone)} (S4)</Text>
            </RowCard>
          ))}
        </View>
      )}

      <AppModal visible={Boolean(viewing)} onClose={() => setViewing(null)} title={viewing ? `Photo #${viewing.evidenceId} · ${viewing.view === 'stamped' ? 'Stamped' : 'Original'}` : 'Photo'}
        subtitle={viewing?.view === 'stamped' ? 'Stamped copy made on request. Not stored.' : 'Short-lived link. Viewing is recorded in the audit log.'} size="large">
        {viewing ? (
          <Image
            accessibilityLabel={`Patrol photo ${viewing.evidenceId} (${viewing.view})`}
            source={{ uri: viewing.uri, cache: 'reload' } as any}
            style={{ width: '100%', height: 460, resizeMode: 'contain', backgroundColor: '#0B1F33' } as any}
          />
        ) : null}
      </AppModal>
    </PatrolPanel>
  );
}
