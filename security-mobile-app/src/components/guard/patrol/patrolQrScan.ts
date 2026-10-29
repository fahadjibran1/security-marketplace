// Checkpoint QR scanning on the Guard's phone (Patrols P1-E). PURE: no camera, no network.
//
// The label payload is `s4cp:1:<keyId>:<publicId>:<tokenVersion>:<mac>`, signed by the server. The app checks only its
// FORMAT (the same rule as the server's parseCheckpointLabel in security-backend-nest/src/patrol/patrol-qr.ts) so that a
// random QR code (a URL, a Wi-Fi code, another product's label) is refused on the spot instead of being queued. Whether
// the signature is valid, the label current, the checkpoint active and on this site is decided ONLY by the server: the
// payload is sent exactly as scanned and the server's verdict (result + flags) is what the Guard is finally shown.

const KEY_ID = /^[A-Za-z0-9]{1,16}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const VERSION = /^[1-9][0-9]{0,8}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;

export type ParsedCheckpointLabel = { publicId: string; keyId: string; tokenVersion: number; payload: string };

/** The label's parts when the text is a well-formed s4cp:1 label, else null. Never checks the signature. */
export function parseCheckpointPayload(raw: unknown): ParsedCheckpointLabel | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) return null;
  const payload = raw.trim();
  const parts = payload.split(':');
  if (parts.length !== 6 || parts[0] !== 's4cp' || parts[1] !== '1') return null;
  const [, , keyId, publicId, version, mac] = parts;
  if (!KEY_ID.test(keyId) || !PUBLIC_ID.test(publicId) || !VERSION.test(version) || !MAC.test(mac)) return null;
  return { publicId, keyId, tokenVersion: Number(version), payload };
}

export type PlanCheckpoint = { publicId: string; label: string; photoRequired: boolean };

export type LocalScanDecision =
  | { kind: 'invalid_format'; title: string; message: string }
  | { kind: 'duplicate'; title: string; message: string; publicId: string; label: string | null }
  | {
      kind: 'record';
      publicId: string;
      payload: string;
      /** The checkpoint as this site's plan knows it, or null when the label is not on the site's current list. */
      checkpoint: PlanCheckpoint | null;
      /** Shown immediately; the server's verdict replaces it once the scan has synced. */
      notice: string | null;
    };

/**
 * What to do with one scanned QR code.
 *   invalid_format  not an S4 checkpoint label: nothing is recorded or sent
 *   duplicate       this checkpoint was already scanned in this patrol: nothing is recorded (the first scan stands)
 *   record          queue the scan with the raw payload. A label that is not on this site's current checkpoint list is
 *                   still recorded (a scanned label is evidence) and flagged by the server — revoked, reprinted, another
 *                   site's or not this company's — with a notice saying so honestly.
 */
export function decideScan(raw: unknown, plan: { checkpoints: PlanCheckpoint[] }, scannedInRun: readonly string[]): LocalScanDecision {
  const parsed = parseCheckpointPayload(raw);
  if (!parsed) {
    return {
      kind: 'invalid_format',
      title: 'Not a checkpoint label',
      message: 'This QR code is not an S4 patrol checkpoint label. Nothing was recorded. Scan the S4 label at the checkpoint.',
    };
  }
  const checkpoint = plan.checkpoints.find((c) => c.publicId === parsed.publicId) ?? null;
  if (scannedInRun.includes(parsed.publicId)) {
    return {
      kind: 'duplicate',
      title: 'Already scanned',
      message: `${checkpoint ? checkpoint.label : 'This checkpoint'} was already scanned in this patrol. The first scan stands; nothing new was recorded.`,
      publicId: parsed.publicId,
      label: checkpoint?.label ?? null,
    };
  }
  return {
    kind: 'record',
    publicId: parsed.publicId,
    payload: parsed.payload,
    checkpoint,
    notice: checkpoint
      ? null
      : 'This label is not on this site\'s checkpoint list. The scan has been recorded and S4 will check it — it may be withdrawn, replaced, or belong to another site.',
  };
}

export type ServerScanVerdict = { result: 'verified' | 'unverified' | 'flagged' | string; flags: string[]; checkpointLabel?: string | null };

/** The Guard-facing words for the server's verdict on a synced scan. Never claims more than "the label was scanned". */
export function scanVerdictMessage(verdict: ServerScanVerdict): { tone: 'good' | 'warning' | 'danger'; text: string } {
  const flags = new Set(verdict.flags ?? []);
  const name = verdict.checkpointLabel ? `${verdict.checkpointLabel}: ` : '';
  if (flags.has('wrong_site')) return { tone: 'danger', text: `${name}this label belongs to another site. Tell your control room.` };
  if (flags.has('checkpoint_revoked')) return { tone: 'danger', text: `${name}this checkpoint has been withdrawn. Tell your control room.` };
  if (flags.has('revoked_label') || flags.has('invalid_label_version')) {
    return { tone: 'danger', text: `${name}this label has been replaced by a newer one. Tell your control room so the label can be changed.` };
  }
  if (flags.has('unknown_checkpoint')) return { tone: 'danger', text: 'This label is not one of your company\'s checkpoints. Tell your control room.' };
  if (flags.has('tampered_signature') || flags.has('unknown_signing_key') || flags.has('malformed_payload')) {
    return { tone: 'danger', text: `${name}this label could not be verified. Tell your control room.` };
  }
  if (flags.has('duplicate_in_run')) return { tone: 'warning', text: `${name}already scanned in this patrol.` };
  if (flags.has('not_on_route')) return { tone: 'warning', text: `${name}this checkpoint is not on this patrol's route.` };
  if (verdict.result === 'verified') return { tone: 'good', text: `${name}label scan verified.` };
  return { tone: 'warning', text: `${name}label scan recorded; S4 could not check its signature.` };
}
