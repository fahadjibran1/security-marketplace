#!/usr/bin/env node
/**
 * Patrols P1-E — Patrol Management on the Guard's phone. Executes the real pure modules (camera access, QR decisions,
 * photo processing, the offline outbox and its sync engine, the SQLite statements, the patrol states) against fakes
 * of the device and of the backend that follow the backend's documented rules, and checks the wiring in source.
 *
 *   GPAT-01  camera access: granted / ask with rationale / denied / permanently denied (Settings) / unavailable
 *   GPAT-02  QR: the local format check agrees with the backend's parser; invalid, duplicate, foreign; server verdict words
 *   GPAT-03  photos: HEIC (or any camera output) → JPEG, EXIF / GPS removed, still a decodable JPEG, FF D8 FF, size cap,
 *            SHA-256 against the published vector in the backend's format, unsupported formats, low storage, write failure
 *   GPAT-04  outbox durability across a restart (store reopened), Book Off, sign-out / sign-in and network loss
 *   GPAT-05  the SQLite statements on a real SQLite engine, closed and reopened (node:sqlite)
 *   GPAT-06  an expired session pauses the queue and drops nothing
 *   GPAT-07  shared phone: Guard B cannot read, send or delete Guard A's items or photos
 *   GPAT-08  idempotent replays (lost answers, duplicates) and 409 payload mismatch as a surfaced permanent error
 *   GPAT-09  post-shift sync inside the window; refusal after it is surfaced, retained, and expires after 14 days
 *   GPAT-10  photo upload: intent → PUT with the signed headers → complete; 409 NOT_UPLOADED re-uploads; 503 retries
 *   GPAT-11  strict per-patrol order; a photo never blocks the patrol; exceptions travel in the completion
 *   GPAT-12  states: pending sync → in progress → awaiting verification → verified ONLY when the server says so
 *   GPAT-13  backoff with jitter, single-flight, device times preserved, sentAtDevice added at send, no location sent
 *   GPAT-14  no gallery / photo library / image picker anywhere; no background location anywhere
 *   GPAT-15  Welfare Checks stay independent of Patrols
 *   GPAT-16  camera permission configuration; the store identity, version and signing inputs are unchanged
 *   GPAT-17  upcoming patrols come from the server's windows only; card visibility
 *   GPAT-18  the web app has no patrol panel and never loads the device modules
 *   GPAT-19  stale camera / re-encode temporaries are swept (older than 1 h, unreferenced, cache folders only); queued
 *            evidence is never touched; a doubt deletes nothing (S4 1.2.0 hardening)
 *   GPAT-20  shared phone, both Guards with pending work in one database: B sends only B's, A's stays dormant through
 *            B's session, restart and the sweep, and A recovers everything by signing back in (S4 1.2.0 hardening)
 *   GPAT-21  patrol evidence and the outbox are kept out of Android backup / device transfer and iOS backups by the
 *            config plugin; expo-secure-store's exclusion is kept (S4 1.2.0 hardening)
 *   GPAT-23  the camera hardware is declared optional (android:required="false") so Google Play does not imply it as
 *            required and drop camera-less devices; the CAMERA permission is kept (S4 1.2.0 Android 22)
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const tests = [];
const test = (id, fn) => tests.push([id, fn]);
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:'"`])\/\/[^\n'"`]*$/gm, '$1');

const camera = loadTs('src/components/guard/patrol/patrolCamera.ts');
const qr = loadTs('src/components/guard/patrol/patrolQrScan.ts');
const image = loadTs('src/components/guard/patrol/patrolImage.ts');
const outbox = loadTs('src/components/guard/patrol/patrolOutbox.ts');
const sql = loadTs('src/components/guard/patrol/patrolOutboxSql.ts');
const state = loadTs('src/components/guard/patrol/patrolState.ts');
const tempCleanup = loadTs('src/components/guard/patrol/patrolTempCleanup.ts');
const backendQr = loadTs('../security-backend-nest/src/patrol/patrol-qr.ts');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's4-patrol-spec-'));
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// ─── Fakes ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A file-backed outbox store: a "restart" is a new instance reading the same file. Filters on the owner like the SQL. */
class FileStore {
  constructor(file) { this.file = file; }
  read() { return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : []; }
  write(rows) { fs.writeFileSync(this.file, JSON.stringify(rows)); }
  async list(owner) { return this.read().filter((r) => r.ownerUserId === owner).sort((a, b) => a.seq - b.seq); }
  async put(item) { const rows = this.read().filter((r) => !(r.ownerUserId === item.ownerUserId && r.id === item.id)); rows.push(JSON.parse(JSON.stringify(item))); this.write(rows); }
  async remove(owner, id) { this.write(this.read().filter((r) => !(r.ownerUserId === owner && r.id === id))); }
  async referencedFilePaths() { return this.read().filter((r) => r.kind === 'photo' && r.photo).map((r) => r.photo.filePath); }
}

/** node:sqlite (Node >= 22.5) when present; otherwise null and the SQL-specific checks are skipped, as in GPAT-05. */
const sqliteEngine = () => { try { return require('node:sqlite').DatabaseSync; } catch { return null; } };

/** Each Guard's private evidence folder. */
function filesFor(userId) {
  const root = path.join(TMP, 'evidence', `u${userId}`) + path.sep;
  fs.mkdirSync(root, { recursive: true });
  return {
    root,
    owns: (p) => typeof p === 'string' && p.startsWith(root) && !p.slice(root.length).includes('..'),
    exists: async (p) => fs.existsSync(p),
    remove: async (p) => { if (p.startsWith(root) && fs.existsSync(p)) fs.unlinkSync(p); },
    write: (name, bytes) => { const p = path.join(root, name); fs.writeFileSync(p, bytes); return p; },
  };
}

const apiError = (status, code, message = code) => Object.assign(new Error(`${status} ${code}`), { name: 'ApiError', status, body: { statusCode: status, code, message } });
const networkError = () => Object.assign(new Error('Network request failed'), { name: 'NetworkError' });

/**
 * The backend's Guard API as P1-A/B/C document it: idempotent on client ids (same content → the stored row; different
 * → 409 PATROL_IDEMPOTENCY_CONFLICT), the post-shift window refusing NEW writes but never replays, evidence intents
 * with presigned PUTs and a completion that verifies only what reached storage.
 */
class FakeBackend {
  constructor() {
    this.runs = new Map(); this.visits = new Map(); this.evidence = new Map(); this.objects = new Map();
    this.calls = []; this.offline = false; this.authExpired = false; this.windowClosed = false; this.loseNextAnswer = false;
    this.storageDown = false; this.nextId = 1; this.verifyRuns = false;
  }
  gate(name, body) {
    this.calls.push({ name, body: body ? JSON.parse(JSON.stringify(body)) : null });
    if (this.offline) throw networkError();
    if (this.authExpired) throw apiError(401, 'UNAUTHORIZED');
  }
  answer(value) { if (this.loseNextAnswer) { this.loseNextAnswer = false; throw networkError(); } return value; }
  transport() {
    return {
      startRun: async (body) => {
        this.gate('startRun', body);
        const existing = [...this.runs.values()].find((r) => r.clientRunId === body.clientRunId);
        if (existing) {
          if (existing.startedAtDevice !== body.startedAtDevice || existing.shiftId !== body.shiftId) throw apiError(409, 'PATROL_IDEMPOTENCY_CONFLICT');
          return this.answer({ ...existing });
        }
        if (this.windowClosed) throw apiError(409, 'PATROL_SYNC_WINDOW_CLOSED', 'Patrol data for this shift could only be sent until …');
        const run = { id: this.nextId++, clientRunId: body.clientRunId, shiftId: body.shiftId, status: 'in_progress', verificationStatus: 'pending', startedAtDevice: body.startedAtDevice, startedAtServer: new Date().toISOString(), completedAtDevice: null, completedAtServer: null };
        this.runs.set(run.id, run);
        return this.answer({ ...run });
      },
      recordVisit: async (runId, body) => {
        this.gate('recordVisit', body);
        const existing = this.visits.get(body.clientVisitId);
        if (existing) {
          if (existing.scanPayload !== body.scanPayload || existing.scannedAtDevice !== body.scannedAtDevice) throw apiError(409, 'PATROL_IDEMPOTENCY_CONFLICT');
          return this.answer({ ...existing });
        }
        if (this.runs.get(runId).status !== 'in_progress') throw apiError(409, 'PATROL_RUN_NOT_IN_PROGRESS');
        if (this.windowClosed) throw apiError(409, 'PATROL_SYNC_WINDOW_CLOSED');
        const visit = { id: this.nextId++, runId, clientVisitId: body.clientVisitId, scanPayload: body.scanPayload, scannedAtDevice: body.scannedAtDevice, result: 'verified', flags: [], checkpointLabel: 'Main gate', receivedAtServer: new Date().toISOString() };
        this.visits.set(body.clientVisitId, visit);
        return this.answer({ ...visit });
      },
      completeRun: async (runId, body) => {
        this.gate('completeRun', body);
        const run = this.runs.get(runId);
        if (run.status !== 'in_progress') {
          if (run.completedAtDevice !== body.completedAtDevice) throw apiError(409, 'PATROL_IDEMPOTENCY_CONFLICT');
          return this.answer({ ...run });
        }
        if (this.windowClosed) throw apiError(409, 'PATROL_SYNC_WINDOW_CLOSED');
        Object.assign(run, { status: body.exceptionReason ? 'incomplete' : 'completed', completedAtDevice: body.completedAtDevice, completedAtServer: new Date().toISOString(), exceptionReason: body.exceptionReason ?? null });
        return this.answer({ ...run });
      },
      requestUpload: async (runId, body) => {
        this.gate('requestUpload', body);
        if (this.storageDown) throw apiError(503, 'PATROL_EVIDENCE_STORAGE_UNAVAILABLE');
        assert.match(body.sha256, /^[0-9a-f]{64}$/, 'the backend DTO format');
        assert.equal(body.contentType, 'image/jpeg');
        let ev = this.evidence.get(body.clientEvidenceId);
        if (ev && (ev.sha256 !== body.sha256 || ev.sizeBytes !== body.sizeBytes || ev.capturedAtDevice !== body.capturedAtDevice)) throw apiError(409, 'PATROL_IDEMPOTENCY_CONFLICT');
        if (!ev) {
          if (this.windowClosed) throw apiError(409, 'PATROL_SYNC_WINDOW_CLOSED');
          ev = { id: this.nextId++, clientEvidenceId: body.clientEvidenceId, runId, visitId: body.visitId ?? null, kind: body.kind, sha256: body.sha256, sizeBytes: body.sizeBytes, capturedAtDevice: body.capturedAtDevice, uploadStatus: 'pending', receivedAt: null };
          this.evidence.set(body.clientEvidenceId, ev);
        }
        const settled = !['pending', 'uploaded'].includes(ev.uploadStatus);
        const headers = { 'Content-Type': 'image/jpeg', 'x-amz-checksum-sha256': Buffer.from(ev.sha256, 'hex').toString('base64') };
        return this.answer({ evidence: { ...ev }, upload: settled ? null : { method: 'PUT', url: `https://storage.invalid/put/${ev.id}?X-Amz-Signature=secret`, expiresAt: new Date(Date.now() + 120_000).toISOString(), headers } });
      },
      putObject: async (upload, filePath) => {
        this.calls.push({ name: 'putObject', headers: upload.headers, filePath });
        if (this.offline) throw networkError();
        const bytes = fs.readFileSync(filePath);
        const id = Number(upload.url.split('/put/')[1].split('?')[0]);
        const ev = [...this.evidence.values()].find((e) => e.id === id);
        const digest = crypto.createHash('sha256').update(bytes).digest('base64');
        if (digest !== upload.headers['x-amz-checksum-sha256'] || bytes.length !== ev.sizeBytes) return { status: 400 };
        this.objects.set(id, bytes);
        return { status: 200 };
      },
      completeUpload: async (evidenceId) => {
        this.gate('completeUpload', { evidenceId });
        const ev = [...this.evidence.values()].find((e) => e.id === evidenceId);
        if (!['pending', 'uploaded'].includes(ev.uploadStatus)) return this.answer({ ...ev });
        const bytes = this.objects.get(evidenceId);
        if (!bytes) throw apiError(409, 'PATROL_EVIDENCE_NOT_UPLOADED');
        ev.uploadStatus = crypto.createHash('sha256').update(bytes).digest('hex') === ev.sha256 ? 'verified' : 'rejected';
        ev.receivedAt = new Date().toISOString();
        return this.answer({ ...ev });
      },
    };
  }
  sent(name) { return this.calls.filter((c) => c.name === name); }
}

let clock = Date.parse('2026-10-29T21:00:00.000Z');
const now = () => new Date(clock);
const engineFor = (userId, store, backend, extra = {}) => new outbox.PatrolOutboxEngine({ ownerUserId: userId, store, transport: backend.transport(), files: extra.files ?? filesFor(userId), now, random: () => 0.5, ...extra });
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

let idn = 0;
const cid = (p) => `${p}-${String(++idn).padStart(8, '0')}`;
const MAC = 'A'.repeat(43);
const label = (publicId, version = 1, keyId = 'k1') => `s4cp:1:${keyId}:${publicId}:${version}:${MAC}`;
const GATE = 'a'.repeat(32);
const YARD = 'b'.repeat(32);

/** A patrol recorded entirely offline: start, one scan, one run photo, completion. */
async function recordPatrol(engine, files, shiftId = 501) {
  const clientRunId = cid('run');
  const at = (m) => new Date(clock + m * 60_000).toISOString();
  await engine.enqueueStart({ clientRunId, shiftId, companyId: 7, scheduleId: 3, routeId: null, startedAtDevice: at(0) });
  const clientVisitId = cid('visit');
  await engine.enqueueScan({ clientRunId, clientVisitId, scanPayload: label(GATE), scannedAtDevice: at(2), meta: { publicId: GATE, label: 'Main gate' } });
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x03, 0x01, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
  const clientEvidenceId = cid('photo');
  const filePath = files.write(`${clientEvidenceId}.jpg`, bytes);
  await engine.enqueuePhoto({ clientRunId, clientEvidenceId, kind: 'run_photo', capturedAtDevice: at(3), file: { path: filePath, sha256: sha256(bytes), sizeBytes: bytes.length } });
  await engine.enqueueComplete({ clientRunId, completedAtDevice: at(5) });
  return { clientRunId, clientVisitId, clientEvidenceId, filePath, at };
}

// ─── Tests ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('GPAT-01-CAMERA-PERMISSION-GRANTED-ASK-DENIED-BLOCKED-UNAVAILABLE', () => {
  assert.equal(camera.cameraAccess({ granted: true, canAskAgain: true, status: 'granted' }, true).kind, 'ready');
  const ask = camera.cameraAccess({ granted: false, canAskAgain: true, status: 'undetermined' }, true);
  assert.deepEqual([ask.kind, ask.action], ['ask', 'request']);
  assert.match(ask.message, /scan the checkpoint QR labels/);
  assert.match(ask.message, /not saved to your photo library and carry no location/, 'the rationale says what happens to photos');
  const denied = camera.cameraAccess({ granted: false, canAskAgain: true, status: 'denied' }, true);
  assert.deepEqual([denied.kind, denied.action], ['denied', 'request']);
  const blocked = camera.cameraAccess({ granted: false, canAskAgain: false, status: 'denied' }, true);
  assert.deepEqual([blocked.kind, blocked.action], ['blocked', 'open_settings'], 'permanently denied → Settings, never a dead button');
  assert.match(blocked.message, /Settings/);
  const none = camera.cameraAccess({ granted: true, canAskAgain: true, status: 'granted' }, false);
  assert.deepEqual([none.kind, none.action], ['unavailable', null], 'no camera (or onMountError) wins over a granted permission');
  assert.equal(camera.cameraAccess(null, null).kind, 'checking');
  const ui = codeOf('src/components/guard/patrol/GuardPatrolCamera.tsx');
  assert.match(ui, /Linking\.openSettings\(\)/);
  assert.match(ui, /onMountError=\{\(\) => setAvailable\(false\)\}/, 'a camera that fails to start is reported as unavailable');
  assert.match(ui, /barcodeTypes: \['qr'\]/, 'QR codes only');
  assert.match(ui, /exif: false/, 'the capture asks for no EXIF');
});

test('GPAT-02-QR-FORMAT-AGREES-WITH-THE-BACKEND-INVALID-DUPLICATE-FOREIGN-AND-VERDICTS', () => {
  const keyring = { current: { keyId: 'k1', key: 'x'.repeat(40) }, accepted: [{ keyId: 'k1', key: 'x'.repeat(40) }] };
  const signed = backendQr.signCheckpointLabel(GATE, 3, keyring);
  const samples = [signed, label(GATE), ` ${label(GATE)} `, `s4cp:2:k1:${GATE}:1:${MAC}`, `s4cp:1:k1:${GATE.toUpperCase()}:1:${MAC}`, `s4cp:1:k1:${GATE}:0:${MAC}`,
    `s4cp:1:k1:${GATE}:1:${MAC.slice(1)}`, `s4cp:1::${GATE}:1:${MAC}`, 'https://example.com/qr', 'WIFI:S:office;T:WPA;P:secret;;', '', 'x'.repeat(300), `s4cp:1:k1:${GATE}:1:${MAC}:extra`];
  for (const s of samples) {
    const ours = qr.parseCheckpointPayload(s);
    const theirs = backendQr.parseCheckpointLabel(s);
    assert.equal(Boolean(ours), Boolean(theirs), `phone and server agree on the format of ${JSON.stringify(s.slice(0, 40))}`);
    if (ours) assert.deepEqual([ours.publicId, ours.tokenVersion, ours.keyId], [theirs.publicId, theirs.tokenVersion, theirs.keyId]);
  }
  const plan = { checkpoints: [{ publicId: GATE, label: 'Main gate', photoRequired: true }, { publicId: YARD, label: 'Yard', photoRequired: false }] };
  const ok = qr.decideScan(signed, plan, []);
  assert.deepEqual([ok.kind, ok.publicId, ok.payload, ok.checkpoint.label, ok.notice], ['record', GATE, signed, 'Main gate', null], 'the payload is sent exactly as scanned');
  const invalid = qr.decideScan('https://example.com/qr', plan, []);
  assert.equal(invalid.kind, 'invalid_format');
  assert.match(invalid.message, /not an S4 patrol checkpoint label\. Nothing was recorded/);
  const dup = qr.decideScan(label(GATE), plan, [GATE]);
  assert.equal(dup.kind, 'duplicate');
  assert.match(dup.message, /Main gate was already scanned in this patrol/);
  const foreign = qr.decideScan(label('c'.repeat(32)), plan, []);
  assert.deepEqual([foreign.kind, foreign.checkpoint], ['record', null], 'a label not on this site\'s list is still recorded (the server judges it)');
  assert.match(foreign.notice, /not on this site's checkpoint list.*withdrawn, replaced, or belong to another site/);
  const words = (flags, result = 'flagged') => qr.scanVerdictMessage({ result, flags, checkpointLabel: 'Main gate' });
  assert.match(words(['wrong_site']).text, /belongs to another site/);
  assert.match(words(['checkpoint_revoked']).text, /withdrawn/);
  assert.match(words(['revoked_label']).text, /replaced by a newer one/);
  assert.match(words(['unknown_checkpoint']).text, /not one of your company's checkpoints/);
  assert.match(words(['tampered_signature']).text, /could not be verified/);
  assert.match(words(['duplicate_in_run']).text, /already scanned/);
  assert.equal(words([], 'verified').tone, 'good');
  assert.match(words(['signing_key_unavailable'], 'unverified').text, /could not check its signature/);
  for (const f of ['wrong_site', 'checkpoint_revoked', 'revoked_label', 'unknown_checkpoint', 'tampered_signature']) assert.equal(words([f]).tone, 'danger');
  assert.doesNotMatch(JSON.stringify(['verified', 'flagged'].map((r) => words([], r).text)), /present|was at/i, 'a scan never claims the Guard was present');
});

// JPEG builders: SOI, optional segments, DQT, SOS, scan bytes, EOI.
const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff]), payload]);
const exifWithGps = seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('MM\0*\0\0\0\x08GPSLatitude 51.5074 N GPSLongitude 0.1278 W Make Apple', 'latin1')]));
const xmp = seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude="51,30.4N"/>', 'latin1'));
const icc = seg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([1, 1, 0, 0, 0, 0])]));
const comment = seg(0xfe, Buffer.from('Shot on iPhone at 51.5N', 'latin1'));

test('GPAT-03-PHOTO-JPEG-CONVERSION-EXIF-GPS-REMOVED-SIZE-CAP-HASH-UNSUPPORTED', async () => {
  const Jimp = require('jimp');
  const real = await new Jimp(64, 48, 0x336699ff).quality(80).getBufferAsync(Jimp.MIME_JPEG);
  assert.equal(image.detectImageFormat(real), 'jpeg');
  // Put EXIF (with GPS), XMP, a comment and an ICC profile into a real JPEG, as a phone camera would.
  const dirty = Buffer.concat([real.subarray(0, 2), exifWithGps, xmp, comment, icc, real.subarray(2)]);
  assert.ok(dirty.includes(Buffer.from('GPSLatitude')));
  assert.equal(image.jpegMetadataSegments(dirty).length, 3);
  const clean = Buffer.from(image.stripJpegMetadata(dirty));
  assert.deepEqual([...clean.subarray(0, 3)], [0xff, 0xd8, 0xff], 'FF D8 FF');
  assert.ok(!clean.includes(Buffer.from('GPS')) && !clean.includes(Buffer.from('Exif')) && !clean.includes(Buffer.from('xmpmeta')) && !clean.includes(Buffer.from('iPhone')), 'no location or device metadata left');
  assert.ok(clean.includes(Buffer.from('ICC_PROFILE')), 'the colour profile (no personal data) is kept');
  assert.deepEqual(image.jpegMetadataSegments(clean), []);
  const decoded = await Jimp.read(clean);
  assert.deepEqual([decoded.bitmap.width, decoded.bitmap.height], [64, 48], 'still a decodable JPEG');
  assert.deepEqual(Buffer.from(image.stripJpegMetadata(real)).equals(real), true, 'a clean JPEG is unchanged byte for byte');

  // The published SHA-256 vector, and the backend's own format and header conversion.
  const abc = new Uint8Array(crypto.createHash('sha256').update('abc').digest());
  assert.equal(image.toHex(abc), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const dto = codeOf('../security-backend-nest/src/patrol/dto/patrol-evidence.dto.ts');
  assert.match(dto, /sha256 must be 64 lowercase hex characters/);
  assert.match(codeOf('../security-backend-nest/src/patrol/evidence/patrol-object-store.ts'), /Buffer\.from\(input\.sha256Hex, 'hex'\)\.toString\('base64'\)/, 'the server derives the checksum header from the hex');

  // The pipeline, from an iPhone HEIC capture.
  const files = filesFor(900);
  const removed = [];
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(16)]);
  assert.equal(image.detectImageFormat(heic), 'heic');
  const store = new Map([['cam://capture.heic', heic], ['tmp://encoded.jpg', dirty]]);
  const reencodes = [];
  const ports = (over = {}) => ({
    readBytes: async (uri) => { if (!store.has(uri) && !fs.existsSync(uri)) throw new Error('missing'); return new Uint8Array(store.get(uri) ?? fs.readFileSync(uri)); },
    reencodeJpeg: async (uri, opts) => { reencodes.push(opts); return { uri: 'tmp://encoded.jpg', width: 2048, height: 1536 }; },
    sha256: async (bytes) => new Uint8Array(crypto.createHash('sha256').update(bytes).digest()),
    writeEvidence: async (name, bytes) => files.write(name, bytes),
    removeFile: async (uri) => { removed.push(uri); },
    freeBytes: () => 500 * 1024 * 1024,
    ...over,
  });
  const out = await image.processCapturedPhoto({ uri: 'cam://capture.heic', width: 4032, height: 3024 }, ports(), { fileName: 'ev-00000001.jpg' });
  assert.equal(out.contentType, 'image/jpeg');
  assert.equal(reencodes[0].maxEdge, 2048);
  assert.equal(reencodes[0].quality, 0.7);
  const onDisk = fs.readFileSync(out.path);
  assert.ok(files.owns(out.path), 'written into the Guard\'s own private folder');
  assert.equal(out.sha256, sha256(onDisk), 'the declared hash is the hash of exactly the bytes that will be uploaded');
  assert.equal(out.sizeBytes, onDisk.length);
  assert.ok(!onDisk.includes(Buffer.from('GPS')), 'no location in the queued file');
  assert.ok(removed.includes('cam://capture.heic') && removed.includes('tmp://encoded.jpg'), 'camera and temporary files are removed');

  const reject = async (over, code, opts = {}) => {
    await assert.rejects(image.processCapturedPhoto({ uri: 'cam://capture.heic', width: 4032, height: 3024 }, ports(over), { fileName: 'ev-00000002.jpg', ...opts }), (e) => e.code === code && e.message.length > 20);
  };
  store.set('cam://capture.gif', Buffer.from('GIF89a....'));
  await assert.rejects(image.processCapturedPhoto({ uri: 'cam://capture.gif', width: 1, height: 1 }, ports(), { fileName: 'ev-00000003.jpg' }), (e) => e.code === 'unsupported_format' && /format S4 cannot use/.test(e.message));
  store.set('tmp://still-heic', heic);
  await reject({ reencodeJpeg: async () => ({ uri: 'tmp://still-heic', width: 10, height: 10 }) }, 'unsupported_format');
  await reject({}, 'too_large', { maxBytes: 100 });
  await reject({ freeBytes: () => 10 * 1024 * 1024 }, 'low_storage');
  await reject({ writeEvidence: async () => { throw new Error('ENOSPC'); } }, 'write_failed');
  await reject({ writeEvidence: async (name, bytes) => files.write(name, Buffer.from(bytes).subarray(0, 10)) }, 'write_failed');
  assert.match(image.photoErrorMessage(new image.PatrolPhotoError('low_storage')), /almost out of storage/);
  assert.equal(image.PATROL_PHOTO_MAX_BYTES, 10 * 1024 * 1024, 'the backend default cap');
});

test('GPAT-04-OUTBOX-DURABLE-ACROSS-RESTART-BOOK-OFF-SIGN-OUT-AND-NETWORK-LOSS', async () => {
  const file = path.join(TMP, 'durable.json');
  const backend = new FakeBackend();
  const files = filesFor(41);
  backend.offline = true;
  let engine = engineFor(41, new FileStore(file), backend, { files });
  const p = await recordPatrol(engine, files);
  let report = await engine.sync();
  assert.equal(report.offline, true);
  assert.equal(backend.runs.size, 0);
  assert.equal(report.pending, 4, 'start, scan, photo, completion all kept');
  // App killed; restarted (store reopened); the Guard booked off meanwhile (nothing in the outbox depends on the shift).
  engine = engineFor(41, new FileStore(file), backend, { files });
  assert.deepEqual((await engine.items()).map((i) => [i.kind, i.status]), [['start', 'pending'], ['scan', 'pending'], ['photo', 'pending'], ['complete', 'pending']]);
  // Signed out: the engine is gone, the rows and the photo are not.
  engine = null;
  assert.equal(new FileStore(file).read().length, 4);
  assert.ok(fs.existsSync(p.filePath), 'the queued photo is never deleted on sign-out');
  // The same Guard signs in again, online.
  backend.offline = false;
  clock += 10 * 60_000;
  engine = engineFor(41, new FileStore(file), backend, { files });
  report = await engine.sync();
  assert.deepEqual([report.sent, report.pending, report.paused, report.offline], [4, 0, null, false]);
  const order = backend.calls.slice(1).map((c) => c.name); // [0] was the offline attempt
  assert.ok(order.indexOf('startRun') < order.indexOf('recordVisit') && order.indexOf('recordVisit') < order.indexOf('completeRun'), 'start → scan → completion');
  assert.ok(order.indexOf('requestUpload') < order.indexOf('putObject') && order.indexOf('putObject') < order.indexOf('completeUpload'), 'intent → PUT → complete');
  assert.equal(backend.runs.size, 1);
  assert.equal([...backend.runs.values()][0].status, 'completed');
  assert.ok(!fs.existsSync(p.filePath), 'the photo file is deleted once the server verified it');
  assert.deepEqual((await engine.items()).map((i) => i.status), ['done', 'done', 'done', 'done']);
  // Sign-out and Book Off never touch the outbox: neither the sign-out path nor the session store knows about it.
  for (const rel of ['App.tsx', 'src/services/session.ts']) assert.doesNotMatch(codeOf(rel), /patrol/i, `${rel} never clears patrol data`);
  assert.doesNotMatch(stripComments(codeOf('src/services/patrolSync.ts')), /store\.remove|files\.remove|removeFile|\.delete\(\)|DELETE FROM|prune\(/, 'the app wiring deletes no patrol row or photo');
});

test('GPAT-05-THE-SQLITE-STATEMENTS-ON-A-REAL-SQLITE-ENGINE-REOPENED', async () => {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { DatabaseSync = null; }
  // Static guarantees, checked everywhere: every statement is scoped to the owner.
  const src = codeOf('src/components/guard/patrol/patrolOutboxSql.ts');
  assert.match(src, /SELECT data FROM patrol_outbox WHERE owner_user_id = \?/);
  assert.match(src, /DELETE FROM patrol_outbox WHERE owner_user_id = \? AND id = \?/);
  assert.match(src, /PRIMARY KEY \(owner_user_id, id\)/);
  assert.match(codeOf('src/services/patrolNative.ts'), /openDatabaseAsync\(DATABASE_NAME\)/);
  if (!DatabaseSync) {
    console.log('      (node:sqlite is not available on this Node; the SQL is executed on Node >= 22.5)');
    return;
  }
  const dbFile = path.join(TMP, 'outbox.db');
  const open = () => {
    const db = new DatabaseSync(dbFile);
    return {
      db,
      api: {
        execAsync: async (s) => db.exec(s),
        runAsync: async (s, params) => db.prepare(s).run(...params),
        getAllAsync: async (s, params) => db.prepare(s).all(...params),
      },
    };
  };
  let h = open();
  const backend = new FakeBackend();
  backend.offline = true;
  const filesA = filesFor(51);
  let engine = engineFor(51, new sql.SqlOutboxStore(h.api, now), backend, { files: filesA });
  await recordPatrol(engine, filesA);
  await engine.sync();
  const B = engineFor(52, new sql.SqlOutboxStore(h.api, now), backend);
  assert.deepEqual(await B.items(), [], 'another user sees nothing in the same database');
  await new sql.SqlOutboxStore(h.api, now).remove(52, (await engine.items())[0].id);
  assert.equal((await engine.items()).length, 4, 'another user cannot delete the Guard\'s rows');
  h.db.close();
  h = open(); // the app restarted
  engine = engineFor(51, new sql.SqlOutboxStore(h.api, now), backend, { files: filesA });
  assert.deepEqual((await engine.items()).map((i) => i.kind), ['start', 'scan', 'photo', 'complete'], 'every row survived the reopen, in order');
  backend.offline = false;
  assert.equal((await engine.sync()).sent, 0, 'a timer-driven pass respects the backoff of the failed start');
  const report = await engine.sync({ eager: true }); // the app came to the foreground
  assert.deepEqual([report.sent, report.pending], [4, 0], 'a foreground / action pass tries waiting steps at once');
  h.db.close();
  h = open();
  assert.deepEqual((await new sql.SqlOutboxStore(h.api, now).list(51)).map((i) => i.status), ['done', 'done', 'done', 'done'], 'the outcomes are durable too');
  h.db.close();
});

test('GPAT-06-AN-EXPIRED-SESSION-PAUSES-THE-QUEUE-AND-DROPS-NOTHING', async () => {
  const backend = new FakeBackend();
  const files = filesFor(61);
  const store = new FileStore(path.join(TMP, 'auth.json'));
  const engine = engineFor(61, store, backend, { files });
  const p = await recordPatrol(engine, files);
  backend.authExpired = true;
  let report = await engine.sync();
  assert.equal(report.paused, 'auth');
  assert.equal(report.pending, 4);
  const start = (await engine.items())[0];
  assert.deepEqual([start.status, start.attempts, start.lastErrorCode], ['pending', 0, 'AUTH_REQUIRED'], 'not an attempt, not dropped');
  const calls = backend.calls.length;
  report = await engine.sync();
  assert.equal(report.paused, 'auth');
  assert.equal(backend.calls.length, calls, 'paused: nothing is sent until the Guard signs in again');
  assert.ok(fs.existsSync(p.filePath));
  backend.authExpired = false;
  engine.resumeAfterSignIn();
  report = await engine.sync();
  assert.deepEqual([report.sent, report.pending, report.paused], [4, 0, null]);
  assert.match(codeOf('src/services/patrolSync.ts'), /engine\.resumeAfterSignIn\(\)/, 'a new Guard session resumes the queue');
  assert.match(codeOf('src/components/guard/patrol/GuardPatrolPanel.tsx'), /Sign in again to send them/);
});

test('GPAT-07-SHARED-PHONE-GUARD-B-CANNOT-READ-SEND-OR-DELETE-GUARD-A-S-ITEMS-OR-PHOTOS', async () => {
  const file = path.join(TMP, 'shared.json');
  const backend = new FakeBackend();
  backend.offline = true;
  const filesA = filesFor(71);
  const A = engineFor(71, new FileStore(file), backend, { files: filesA });
  const p = await recordPatrol(A, filesA);
  await A.sync();
  backend.offline = false;
  backend.calls = [];
  const filesB = filesFor(72);
  const B = engineFor(72, new FileStore(file), backend, { files: filesB });
  assert.deepEqual(await B.items(), []);
  const report = await B.sync();
  assert.deepEqual([report.sent, report.pending], [0, 0]);
  assert.equal(backend.calls.length, 0, 'B sends nothing of A\'s');
  assert.equal(filesB.owns(p.filePath), false, 'A\'s photo is outside B\'s folder');
  assert.equal(filesB.owns(path.join(filesB.root, '..', 'u71', path.basename(p.filePath))), false, 'no path tricks');
  await filesB.remove(p.filePath);
  assert.ok(fs.existsSync(p.filePath), 'B cannot delete A\'s photo');
  await assert.rejects(B.enqueuePhoto({ clientRunId: 'x', clientEvidenceId: cid('ev'), kind: 'run_photo', capturedAtDevice: now().toISOString(), file: { path: p.filePath, sha256: 'a'.repeat(64), sizeBytes: 1 } }), /own folder/);
  // Even a store that leaked A's rows to B would not get them sent: the engine re-checks the owner.
  const leaky = { list: async () => new FileStore(file).read(), put: async () => undefined, remove: async () => undefined };
  const B2 = engineFor(72, leaky, backend, { files: filesB });
  assert.deepEqual(await B2.items(), []);
  await B2.sync();
  assert.equal(backend.calls.length, 0);
  // A signs back in later: everything is still there and is sent.
  const again = engineFor(71, new FileStore(file), backend, { files: filesA });
  assert.equal((await again.sync({ eager: true })).sent, 4);
  assert.match(codeOf('src/services/patrolNative.ts'), /new Directory\(Paths\.document, EVIDENCE_ROOT, `u\$\{ownerUserId\}`\)/, 'files are namespaced per user under the private document directory');
});

test('GPAT-08-IDEMPOTENT-REPLAYS-AND-409-PAYLOAD-MISMATCH-IS-PERMANENT-AND-SURFACED', async () => {
  const backend = new FakeBackend();
  const files = filesFor(81);
  const engine = engineFor(81, new FileStore(path.join(TMP, 'idem.json')), backend, { files });
  const p = await recordPatrol(engine, files);
  backend.loseNextAnswer = true; // the start reaches the server; its answer is lost
  let report = await engine.sync();
  assert.equal(report.offline, true);
  assert.equal(backend.runs.size, 1, 'the server has the run');
  clock += 10 * 60_000;
  report = await engine.sync();
  assert.equal(backend.runs.size, 1, 'the replay with the same clientRunId created nothing new');
  assert.equal(backend.visits.size, 1);
  assert.equal(backend.evidence.size, 1);
  assert.equal(report.pending, 0);
  assert.equal(new Set(backend.sent('startRun').map((c) => c.body.clientRunId)).size, 1);
  assert.equal(await engine.enqueueStart({ clientRunId: p.clientRunId, shiftId: 501, companyId: 7, scheduleId: 3, routeId: null, startedAtDevice: p.at(0) }).then((i) => i.status), 'done', 'the same id is the same action, never queued twice');
  // A different action under an id the server already holds: 409, kept and shown, never retried.
  const engine2 = engineFor(82, new FileStore(path.join(TMP, 'idem2.json')), backend);
  await engine2.enqueueStart({ clientRunId: p.clientRunId, shiftId: 501, companyId: 7, scheduleId: 3, routeId: null, startedAtDevice: p.at(30) });
  await engine2.sync();
  const [conflict] = await engine2.items();
  assert.deepEqual([conflict.status, conflict.lastErrorCode], ['failed', 'PATROL_IDEMPOTENCY_CONFLICT']);
  const calls = backend.calls.length;
  clock += HOUR;
  await engine2.sync();
  assert.equal(backend.calls.length, calls, 'a permanent error is not retried');
  assert.equal(state.notSentItems(await engine2.items())[0].message, 'Could not be sent — contact your control room.');
});

test('GPAT-09-POST-SHIFT-SYNC-INSIDE-THE-WINDOW-REFUSAL-AFTER-IT-IS-SURFACED-RETAINED-AND-EXPIRES', async () => {
  const backend = new FakeBackend();
  const files = filesFor(91);
  backend.offline = true;
  const engine = engineFor(91, new FileStore(path.join(TMP, 'window.json')), backend, { files });
  await recordPatrol(engine, files);
  await engine.sync();
  // Booked off; back online 20 hours later — inside the 24 h window the server accepts.
  backend.offline = false;
  clock += 20 * HOUR;
  assert.equal((await engine.sync()).sent, 4, 'accepted after Book Off within the window (the server decides)');
  // Another patrol recorded offline and only back online after the window closed.
  backend.offline = true;
  const p = await recordPatrol(engine, files);
  await engine.sync();
  backend.offline = false;
  backend.windowClosed = true;
  clock += 30 * HOUR;
  await engine.sync();
  const mine = (await engine.items()).filter((i) => i.clientRunId === p.clientRunId);
  assert.deepEqual(mine.map((i) => [i.kind, i.status, i.lastErrorCode]), [
    ['start', 'refused', 'PATROL_SYNC_WINDOW_CLOSED'], ['scan', 'refused', 'PATROL_SYNC_WINDOW_CLOSED'],
    ['photo', 'refused', 'PATROL_SYNC_WINDOW_CLOSED'], ['complete', 'refused', 'PATROL_SYNC_WINDOW_CLOSED'],
  ], 'everything that depended on the refused start is settled with it');
  assert.equal(backend.sent('recordVisit').length, 1, 'nothing after the refused start was sent');
  assert.ok(fs.existsSync(p.filePath), 'the refused photo is kept on the phone');
  const banner = state.notSentItems(await engine.items());
  assert.equal(banner.length, 4);
  assert.ok(banner.every((b) => b.message === 'Could not be sent — contact your control room.'));
  const view = state.patrolView(state.localPatrols(await engine.items()).find((l) => l.clientRunId === p.clientRunId), null);
  assert.equal(view.phase, 'not_sent');
  // Retention: kept for 14 days after the refusal, then removed with the photo.
  clock += 13 * DAY;
  await engine.prune();
  assert.equal((await engine.items()).filter((i) => i.clientRunId === p.clientRunId).length, 4);
  clock += 2 * DAY;
  await engine.prune();
  assert.equal((await engine.items()).filter((i) => i.clientRunId === p.clientRunId).length, 0);
  assert.ok(!fs.existsSync(p.filePath));
  assert.equal(outbox.PATROL_REFUSED_RETENTION_MS, 14 * DAY);
  // Done rows go after 7 days; pending rows never expire.
  const pendingEngine = engineFor(92, new FileStore(path.join(TMP, 'pending.json')), backend);
  backend.windowClosed = false; backend.offline = true;
  await pendingEngine.enqueueStart({ clientRunId: cid('r'), shiftId: 9, companyId: 7, scheduleId: null, routeId: null, startedAtDevice: now().toISOString() });
  clock += 365 * DAY;
  await pendingEngine.prune();
  assert.equal((await pendingEngine.items()).length, 1, 'a pending row is never discarded');
  backend.offline = false;
});

test('GPAT-10-PHOTO-UPLOAD-INTENT-PUT-WITH-SIGNED-HEADERS-COMPLETE-REUPLOAD-AND-503', async () => {
  const backend = new FakeBackend();
  const files = filesFor(101);
  const engine = engineFor(101, new FileStore(path.join(TMP, 'upload.json')), backend, { files });
  const p = await recordPatrol(engine, files);
  backend.storageDown = true;
  await engine.sync();
  const photo = (await engine.items()).find((i) => i.kind === 'photo');
  assert.deepEqual([photo.status, photo.lastErrorCode, photo.attempts], ['pending', 'PATROL_EVIDENCE_STORAGE_UNAVAILABLE', 1], '503 is retried');
  assert.equal((await engine.items()).find((i) => i.kind === 'complete').status, 'done', 'a waiting photo never holds up the patrol');
  backend.storageDown = false;
  // The PUT never arrives (e.g. it failed silently): the server says NOT_UPLOADED and the phone uploads again.
  const realPut = backend.transport().putObject;
  let dropFirst = true;
  const t = backend.transport();
  t.putObject = async (u, f) => { if (dropFirst) { dropFirst = false; return { status: 200 }; } return realPut(u, f); };
  const engine2 = engineFor(101, new FileStore(path.join(TMP, 'upload.json')), backend, { files, transport: t });
  clock += 10 * 60_000;
  await engine2.sync();
  let item = (await engine2.items()).find((i) => i.kind === 'photo');
  assert.deepEqual([item.status, item.photo.stage, item.lastErrorCode], ['pending', 'put', 'PATROL_EVIDENCE_NOT_UPLOADED']);
  clock += 10 * 60_000;
  await engine2.sync();
  item = (await engine2.items()).find((i) => i.kind === 'photo');
  assert.deepEqual([item.status, item.photo.uploadStatus], ['done', 'verified']);
  const puts = backend.calls.filter((c) => c.name === 'putObject');
  assert.ok(puts.length >= 1);
  for (const put of puts) assert.deepEqual(Object.keys(put.headers).sort(), ['Content-Type', 'x-amz-checksum-sha256'], 'exactly the signed headers');
  assert.equal(backend.evidence.size, 1, 'one evidence record across every retry');
  assert.ok(!JSON.stringify(await engine2.items()).includes('X-Amz-Signature'), 'the presigned URL is never stored');
  assert.ok(!fs.existsSync(p.filePath));
  const native = codeOf('src/services/patrolNative.ts');
  assert.match(native, /httpMethod: 'PUT'/);
  assert.match(native, /uploadType: FileSystemUploadType\.BINARY_CONTENT/);
  assert.match(native, /headers: upload\.headers/);
  assert.doesNotMatch(stripComments(native), /console\.|Authorization/, 'no logging, and no S4 token sent to storage');
});

test('GPAT-11-STRICT-ORDER-PHOTOS-NEVER-BLOCK-AND-EXCEPTIONS-TRAVEL-IN-THE-COMPLETION', async () => {
  const backend = new FakeBackend();
  const files = filesFor(111);
  const engine = engineFor(111, new FileStore(path.join(TMP, 'order.json')), backend, { files });
  const clientRunId = cid('run');
  await engine.enqueueStart({ clientRunId, shiftId: 1, companyId: 7, scheduleId: null, routeId: null, startedAtDevice: now().toISOString() });
  const v1 = cid('v'); const v2 = cid('v');
  await engine.enqueueScan({ clientRunId, clientVisitId: v1, scanPayload: label(GATE), scannedAtDevice: now().toISOString(), meta: { publicId: GATE } });
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const ev = cid('ev');
  await engine.enqueuePhoto({ clientRunId, clientEvidenceId: ev, kind: 'checkpoint_photo', clientVisitId: v1, capturedAtDevice: now().toISOString(), file: { path: files.write(`${ev}.jpg`, bytes), sha256: sha256(bytes), sizeBytes: bytes.length } });
  await engine.enqueueScan({ clientRunId, clientVisitId: v2, scanPayload: label(YARD), scannedAtDevice: now().toISOString(), meta: { publicId: YARD } });
  await engine.recordException({ clientRunId, id: cid('ex'), label: 'Fence', publicId: 'f'.repeat(32), reason: 'Gate locked', at: now().toISOString() });
  await engine.enqueueComplete({ clientRunId, completedAtDevice: now().toISOString(), note: 'Heavy rain' });
  backend.storageDown = true;
  await engine.sync();
  const names = backend.calls.map((c) => c.name);
  assert.ok(names.indexOf('startRun') < names.indexOf('recordVisit'));
  assert.deepEqual(backend.sent('recordVisit').map((c) => c.body.clientVisitId), [v1, v2], 'scans in the order they were made');
  assert.ok(names.lastIndexOf('recordVisit') < names.indexOf('completeRun'));
  const upload = backend.sent('requestUpload')[0];
  assert.equal(upload.body.visitId, backend.visits.get(v1).id, 'a checkpoint photo names its scan');
  const completion = backend.sent('completeRun')[0].body;
  assert.equal(completion.exceptionReason, 'Checkpoint not reached — Fence: Gate locked\nHeavy rain', 'the Guard\'s exception and note in the completion');
  assert.equal([...backend.runs.values()][0].status, 'incomplete');
  assert.equal(outbox.composeExceptionReason([{ label: 'X', reason: 'y'.repeat(600) }], null).length, 500);
  assert.equal(outbox.composeExceptionReason([], '  '), null);
  assert.ok(!backend.calls.some((c) => /exception/i.test(c.name)), 'exceptions use the completion, the backend\'s Guard API for them');
});

test('GPAT-12-STATES-VERIFIED-ONLY-WHEN-THE-SERVER-CONFIRMS', async () => {
  const backend = new FakeBackend();
  const files = filesFor(121);
  backend.offline = true;
  const engine = engineFor(121, new FileStore(path.join(TMP, 'states.json')), backend, { files });
  const clientRunId = cid('run');
  await engine.enqueueStart({ clientRunId, shiftId: 5, companyId: 7, scheduleId: null, routeId: null, startedAtDevice: now().toISOString() });
  const local = async () => state.localPatrols(await engine.items())[0];
  assert.equal(state.patrolView(await local(), null).phase, 'pending_sync');
  assert.equal(state.activePatrol(await engine.items(), 5).clientRunId, clientRunId);
  backend.offline = false;
  await engine.sync();
  assert.equal(state.patrolView(await local(), null).phase, 'in_progress');
  await engine.enqueueComplete({ clientRunId, completedAtDevice: now().toISOString() });
  assert.equal(state.patrolView(await local(), null).phase, 'pending_sync', 'completed on the phone but not yet sent');
  await engine.sync();
  const l = await local();
  assert.equal(l.complete.status, 'done');
  assert.equal(state.patrolView(l, null).phase, 'awaiting_verification', 'everything sent is NOT verified');
  const serverRun = { ...[...backend.runs.values()][0], visits: [] };
  assert.equal(state.patrolView(l, { ...serverRun, verificationStatus: 'pending' }).phase, 'awaiting_verification');
  assert.equal(state.patrolView(l, { ...serverRun, verificationStatus: 'unverified' }).phase, 'awaiting_verification');
  assert.equal(state.patrolView(l, { ...serverRun, verificationStatus: 'verified' }).phase, 'verified', 'verified because the server says so');
  assert.equal(state.patrolView(l, { ...serverRun, status: 'incomplete' }).phase, 'incomplete');
  assert.equal(state.patrolView(l, { ...serverRun, status: 'closed_by_system' }).phase, 'closed_by_system');
  assert.equal(state.activePatrol(await engine.items(), 5), null);
  const view = state.patrolView(l, { ...serverRun, verificationStatus: 'verified' });
  assert.ok(view.startedAtServer && view.completedAtServer, 'server receipt times shown when known');
  assert.match(state.timePair('2026-10-29T21:00:00.000Z', '2026-10-29T21:04:00.000Z', 'Europe/London'), /^21:00 \(received by S4 21:04\)$/);
  assert.match(state.timePair('2026-10-29T21:00:00.000Z', null, 'Europe/London'), /on this phone/);
  for (const rel of ['src/components/guard/patrol/patrolState.ts', 'src/components/guard/patrol/patrolOutbox.ts', 'src/components/guard/patrol/GuardPatrolPanel.tsx']) {
    assert.doesNotMatch(stripComments(codeOf(rel)), /verificationStatus\s*[:=]\s*'verified'|uploadStatus\s*=\s*'verified'/, `${rel} never sets verified itself`);
  }
});

test('GPAT-13-BACKOFF-SINGLE-FLIGHT-DEVICE-TIMES-SENT-AT-DEVICE-AND-NO-LOCATION', async () => {
  for (let attempts = 1; attempts < 20; attempts += 1) {
    const raw = Math.min(outbox.PATROL_RETRY_MAX_MS, outbox.PATROL_RETRY_BASE_MS * 2 ** (attempts - 1));
    const low = outbox.backoffMs(attempts, () => 0);
    const high = outbox.backoffMs(attempts, () => 1);
    assert.ok(low === Math.round(raw * 0.5) && high === raw, `attempt ${attempts}`);
  }
  assert.equal(outbox.backoffMs(30, () => 1), 2 * 60_000, 'capped at two minutes');
  assert.ok(outbox.backoffMs(3, () => 0.2) !== outbox.backoffMs(3, () => 0.9), 'jitter');
  // Single-flight: concurrent sync() calls share one pass (one extra pass at most), never two sends of one step.
  const backend = new FakeBackend();
  const files = filesFor(131);
  const engine = engineFor(131, new FileStore(path.join(TMP, 'flight.json')), backend, { files });
  const p = await recordPatrol(engine, files);
  const [a, b, c] = await Promise.all([engine.sync(), engine.sync(), engine.sync()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(backend.sent('startRun').length, 1);
  assert.equal(backend.sent('recordVisit').length, 1);
  // Device times as captured; sentAtDevice added at the send.
  const start = backend.sent('startRun')[0].body;
  assert.equal(start.startedAtDevice, p.at(0));
  assert.equal(start.sentAtDevice, now().toISOString());
  assert.equal(backend.sent('recordVisit')[0].body.scannedAtDevice, p.at(2));
  assert.equal(backend.sent('completeRun')[0].body.completedAtDevice, p.at(5));
  assert.equal(backend.sent('requestUpload')[0].body.capturedAtDevice, p.at(3));
  const LOCATION = ['latitude', 'longitude', 'lat', 'lng', 'lon', 'accuracy', 'accuracyMeters', 'gpsAccuracyMeters', 'location', 'coords', 'coordinates', 'altitude', 'distanceMeters'];
  const backendList = codeOf('../security-backend-nest/src/patrol/patrol-constants.ts');
  for (const f of LOCATION) assert.ok(backendList.includes(`'${f}'`), `${f} is one of the backend's refused location fields`);
  for (const call of backend.calls.filter((x) => x.body)) {
    for (const f of LOCATION) assert.ok(!(f in call.body), `${call.name} never sends ${f}`);
  }
  // Retry classification.
  assert.equal(outbox.classifyError(networkError()).kind, 'transient');
  assert.equal(outbox.classifyError(apiError(503, 'PATROL_EVIDENCE_STORAGE_UNAVAILABLE')).kind, 'transient');
  assert.equal(outbox.classifyError(apiError(429, 'X')).kind, 'transient');
  assert.equal(outbox.classifyError(apiError(401, 'X')).kind, 'auth');
  assert.equal(outbox.classifyError(apiError(409, 'PATROL_SYNC_NOT_BOOKED_ON')).kind, 'refused');
  assert.equal(outbox.classifyError(apiError(409, 'PATROL_SYNC_WINDOW_CLOSED')).kind, 'refused');
  assert.equal(outbox.classifyError(apiError(409, 'PATROL_EVIDENCE_NOT_UPLOADED')).kind, 'reupload');
  assert.equal(outbox.classifyError(apiError(409, 'PATROL_IDEMPOTENCY_CONFLICT')).kind, 'failed');
  assert.equal(outbox.classifyError(apiError(400, 'PATROL_LOCATION_VERIFICATION_DISABLED')).kind, 'failed');
  assert.equal(outbox.classifyError(new Error('weird')).kind, 'transient', 'a doubt never discards');
});

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|cjs)$/.test(e.name)) out.push(full);
  }
  return out;
};
const appSources = () => [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'App.tsx'), path.join(ROOT, 'app.config.js')];

test('GPAT-14-NO-GALLERY-OR-PHOTO-LIBRARY-AND-NO-BACKGROUND-LOCATION-ANYWHERE', () => {
  const pkg = JSON.parse(codeOf('package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const banned of ['expo-image-picker', 'expo-media-library', 'react-native-image-picker', 'expo-task-manager', 'expo-background-fetch', 'expo-background-task', 'react-native-background-geolocation']) {
    assert.ok(!deps.includes(banned), `${banned} is not a dependency`);
  }
  const offenders = [];
  for (const file of appSources()) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    if (/expo-image-picker|expo-media-library|launchImageLibrary|MediaLibrary|scanFromURLAsync|ImagePicker|CameraRoll/.test(src)) offenders.push(`${path.relative(ROOT, file)}: gallery`);
    if (/startLocationUpdatesAsync|requestBackgroundPermissionsAsync|watchPositionAsync|expo-task-manager|TaskManager|startGeofencingAsync/.test(src)) offenders.push(`${path.relative(ROOT, file)}: background location`);
  }
  assert.deepEqual(offenders, []);
  for (const rel of walk(path.join(ROOT, 'src/components/guard/patrol')).concat([path.join(ROOT, 'src/services/patrolNative.ts'), path.join(ROOT, 'src/services/patrolTempNative.ts'), path.join(ROOT, 'src/services/patrolSync.ts')])) {
    assert.doesNotMatch(fs.readFileSync(rel, 'utf8'), /from 'expo-location'|attendanceLocation/, `${path.relative(ROOT, rel)} does not use location`);
  }
  const expo = JSON.parse(codeOf('app.json')).expo;
  const plist = JSON.stringify(expo.ios);
  assert.doesNotMatch(plist + JSON.stringify(expo.plugins), /NSPhotoLibrary|photosPermission|savePhotosPermission|NSLocationAlways/);
  for (const p of ['ACCESS_BACKGROUND_LOCATION', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'RECORD_AUDIO', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_LOCATION']) {
    assert.ok(expo.android.blockedPermissions.includes(`android.permission.${p}`), `${p} stays blocked`);
  }
  assert.ok(!JSON.stringify(expo.android.permissions).match(/READ_MEDIA|MEDIA_IMAGES|BACKGROUND/), 'no media or background permission requested');
  // Patrol files live in the private document directory, never the cache or shared storage.
  const native = codeOf('src/services/patrolNative.ts');
  assert.match(native, /Paths\.document/);
  assert.doesNotMatch(stripComments(native), /Paths\.cache|cacheDirectory|externalStorage|StorageAccessFramework/);
});

test('GPAT-15-WELFARE-CHECKS-STAY-INDEPENDENT-OF-PATROLS', () => {
  const patrolFiles = walk(path.join(ROOT, 'src/components/guard/patrol')).concat([path.join(ROOT, 'src/services/patrolNative.ts'), path.join(ROOT, 'src/services/patrolTempNative.ts'), path.join(ROOT, 'src/services/patrolSync.ts')]);
  for (const file of patrolFiles) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    assert.doesNotMatch(src, /welfare|Welfare|pushNotifications|expo-notifications|confirmWelfare/, `${path.relative(ROOT, file)} shares nothing with Welfare Checks`);
  }
  for (const rel of ['src/components/guard/welfarePush.ts', 'src/components/guard/guardWelfarePresentation.ts', 'src/components/guard/WelfareCheckPrompt.tsx', 'src/services/pushNotifications.ts']) {
    assert.doesNotMatch(codeOf(rel), /patrol/i, `${rel} knows nothing of Patrols`);
  }
  // The patrol engine only reaches patrol endpoints.
  const api = codeOf('src/services/api.ts');
  const block = api.slice(api.indexOf('// ─── Patrols on the Guard\'s phone'));
  const paths = [...block.matchAll(/request<[^>]+>\(`([^`]+)`/g), ...block.matchAll(/request<[^>]+>\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 7 && paths.every((p) => p.startsWith('/patrols/')), JSON.stringify(paths));
  // On the Home screen the Patrol panel is its own component, with no props from the Welfare block.
  const screen = codeOf('src/screens/GuardDashboardScreen.tsx');
  const use = screen.slice(screen.indexOf('<GuardPatrolPanel'), screen.indexOf('/>', screen.indexOf('<GuardPatrolPanel')));
  assert.doesNotMatch(use, /welfare|operations/i);
  assert.match(codeOf('../security-backend-nest/scripts/patrol-schedule.spec.ts'), /PS-A04-WELFARE-IS-UNTOUCHED/, 'and the backend certifies the same');
});

test('GPAT-16-CAMERA-CONFIG-AND-UNCHANGED-IDENTITY-VERSION-AND-RELEASE-INPUTS', () => {
  const expo = JSON.parse(codeOf('app.json')).expo;
  assert.deepEqual([expo.android.package, expo.ios.bundleIdentifier, expo.version, expo.android.versionCode, expo.ios.buildNumber, expo.name, expo.scheme],
    ['com.sfour.s4', 'com.sfour.s4', '1.2.0', 22, '20', 'S4', 's4security'], 'identity unchanged; the version is the prepared S4 1.2.0 (Android 22, iOS 20)');
  assert.deepEqual(expo.updates, { enabled: false });
  assert.ok(!('runtimeVersion' in expo));
  assert.equal(expo.extra.eas.projectId, 'c786f15c-7d60-4122-9001-02cabbb7692b');
  const eas = codeOf('eas.json');
  assert.ok(!eas.includes('"channel"'));
  const [, cam] = expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-camera');
  assert.deepEqual(Object.keys(cam).sort(), ['cameraPermission', 'microphonePermission', 'recordAudioAndroid']);
  assert.match(cam.cameraPermission, /^S4 uses the camera only while you patrol/);
  assert.equal(cam.microphonePermission, false, 'no microphone purpose string');
  assert.equal(cam.recordAudioAndroid, false, 'no RECORD_AUDIO from the plugin');
  assert.ok(expo.android.permissions.includes('CAMERA'));
  assert.ok(!expo.android.blockedPermissions.includes('android.permission.CAMERA'));
  const pkg = JSON.parse(codeOf('package.json')).dependencies;
  const bundled = JSON.parse(codeOf('node_modules/expo/bundledNativeModules.json'));
  for (const name of ['expo-camera', 'expo-sqlite', 'expo-file-system', 'expo-image-manipulator', 'expo-crypto']) {
    assert.equal(pkg[name], bundled[name], `${name} is pinned to what Expo SDK 54 expects`);
  }
  assert.ok(!('expo-camera' in (JSON.parse(codeOf('package.json')).devDependencies || {})), 'a runtime dependency, not a dev one');
});

test('GPAT-17-UPCOMING-PATROLS-FROM-THE-SERVER-WINDOWS-ONLY-AND-CARD-VISIBILITY', () => {
  const plan = {
    shift: { id: 5, status: 'in_progress', start: '2026-10-29T20:00:00.000Z', end: '2026-10-30T06:00:00.000Z' },
    site: { id: 1, name: 'North Gate', timezone: 'Europe/London' },
    policy: { photosPerRun: 1, photosPerCheckpoint: 0 },
    schedules: [{ id: 3 }],
    routes: [{ id: 9, name: 'Perimeter', orderMode: 'any', checkpoints: [{ position: 1, required: true, publicId: GATE, label: 'Main gate' }, { position: 2, required: false, publicId: YARD, label: 'Yard' }] }],
    checkpoints: [{ publicId: GATE, label: 'Main gate', description: null, photoRequired: true }, { publicId: YARD, label: 'Yard', description: null, photoRequired: false }],
    windows: [
      { windowKey: 's3:2026-10-29:0', scheduleId: 3, scheduleName: 'Night', routeId: 9, localDate: '2026-10-29', start: '2026-10-29T20:00:00.000Z', end: '2026-10-29T21:00:00.000Z', covered: true },
      { windowKey: 's3:2026-10-29:1', scheduleId: 3, scheduleName: 'Night', routeId: 9, localDate: '2026-10-29', start: '2026-10-29T21:00:00.000Z', end: '2026-10-29T22:00:00.000Z', covered: false },
      { windowKey: 's3:2026-10-29:2', scheduleId: 3, scheduleName: 'Night', routeId: 9, localDate: '2026-10-29', start: '2026-10-29T22:00:00.000Z', end: '2026-10-29T23:00:00.000Z', covered: false },
    ],
  };
  const at = new Date('2026-10-29T21:15:00.000Z');
  const rows = state.upcomingWindows(plan, at);
  assert.deepEqual(rows.map((r) => [r.time, r.state]), [['21:00–22:00', 'due_now'], ['22:00–23:00', 'upcoming']], 'site-local times; past windows dropped');
  assert.equal(state.dueWindow(plan, at).windowKey, 's3:2026-10-29:1');
  assert.equal(state.upcomingWindows({ ...plan, windows: undefined }, at), null, 'an older backend: no due times are invented');
  assert.equal(state.dueWindow({ ...plan, windows: undefined }, at), null);
  assert.equal(state.patrolCardVisible({ shiftStatus: 'in_progress', plan }), true);
  assert.equal(state.patrolCardVisible({ shiftStatus: 'ready', plan }), false, 'only on a live shift');
  assert.equal(state.patrolCardVisible({ shiftStatus: 'in_progress', plan: null }), false, 'switch off (404) or no plan: no card');
  assert.equal(state.patrolCardVisible({ shiftStatus: 'in_progress', plan: { ...plan, checkpoints: [], schedules: [] } }), false, 'a site without patrols');
  const local = { clientRunId: 'r', shiftId: 5, start: { body: { routeId: 9 } }, scans: [{ meta: { publicId: GATE } }], photos: [], exceptions: [], complete: null };
  const sum = state.completionSummary(plan, 9, local);
  assert.deepEqual([sum.checkpointsTotal, sum.checkpointsScanned, sum.missing.length, sum.photosRequired, sum.needsReason], [2, 1, 0, 2, false], 'Yard is optional on the route; gate needs a photo; one run photo');
  const strict = state.completionSummary(plan, null, local);
  assert.deepEqual([strict.missing.map((m) => m.label), strict.needsReason], [['Yard'], true]);
  assert.doesNotMatch(stripComments(codeOf('src/components/guard/patrol/patrolState.ts')), /frequencyMinutes|activeFrom|windowMinutes/, 'the phone never computes a window from the schedule');
  const service = codeOf('../security-backend-nest/src/patrol/patrol-guard.service.ts');
  assert.match(service, /windowsBetween\(/, 'the plan\'s windows come from the sweep\'s engine');
});

test('GPAT-18-THE-WEB-APP-HAS-NO-PATROL-PANEL-AND-LOADS-NO-DEVICE-MODULE', () => {
  const web = loadTs('src/components/guard/patrol/GuardPatrolPanel.web.tsx');
  assert.equal(web.GuardPatrolPanel({ userId: 1, shift: { id: 1, status: 'in_progress' } }), null);
  assert.doesNotMatch(codeOf('src/components/guard/patrol/GuardPatrolPanel.web.tsx'), /^import /m, 'imports nothing');
  assert.match(codeOf('src/components/guard/patrol/GuardPatrolPanel.tsx'), /from '\.\.\/\.\.\/\.\.\/services\/patrolNative'/, 'only the phone build reaches the device modules');
  assert.match(codeOf('src/screens/GuardDashboardScreen.tsx'), /from '\.\.\/components\/guard\/patrol\/GuardPatrolPanel'/, 'resolved per platform by the bundler');
});

test('GPAT-19-STALE-CAMERA-TEMPORARIES-ARE-SWEPT-AND-QUEUED-EVIDENCE-NEVER-IS', async () => {
  const cache = path.join(TMP, 'cache');
  const camDir = path.join(cache, 'Camera');
  const manipDir = path.join(cache, 'ImageManipulator');
  const otherDir = path.join(cache, 'Other');
  for (const d of [camDir, manipDir, otherDir]) fs.mkdirSync(d, { recursive: true });
  // The real layout: <files>/patrol-evidence/u<id>/ (patrolNative.ts).
  const evidenceRoot = path.join(TMP, 'patrol-evidence', 'u191') + path.sep;
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const files = { root: evidenceRoot, write: (name, bytes) => { const p = path.join(evidenceRoot, name); fs.writeFileSync(p, bytes); return p; } };
  const T = clock;
  const mk = (dir, name, ageMs) => { const p = path.join(dir, name); fs.writeFileSync(p, 'x'); fs.utimesSync(p, (T - ageMs) / 1000, (T - ageMs) / 1000); return p; };
  const staleCapture = mk(camDir, 'stale-capture.jpg', 2 * HOUR);
  const staleEncoded = mk(manipDir, 'stale-encoded.jpg', 90 * 60_000);
  const freshCapture = mk(camDir, 'fresh-capture.jpg', 5 * 60_000); // a photo being processed right now
  const referencedTemp = mk(camDir, 'referenced.jpg', 5 * HOUR);
  const otherCache = mk(otherDir, 'not-ours.jpg', 9 * HOUR);
  const evidence = files.write('ev-queued0001.jpg', Buffer.from('queued'));
  fs.utimesSync(evidence, (T - 30 * DAY) / 1000, (T - 30 * DAY) / 1000);
  const prefixes = [camDir, manipDir].map((d) => d + path.sep);
  const deleted = [];
  const ports = (over = {}) => ({
    listTempFiles: async () => [camDir, manipDir, otherDir, files.root].flatMap((d) => fs.readdirSync(d).map((n) => path.join(d, n)))
      .map((p) => ({ uri: p.split(path.sep).join('/'), modifiedAtMs: fs.statSync(p).mtimeMs })),
    referencedPaths: async () => [referencedTemp.split(path.sep).join('/')],
    isTempLocation: (uri) => prefixes.some((pre) => { const u = uri.split('/').join(path.sep); return u.startsWith(pre) && !u.slice(pre.length).includes(path.sep); }),
    deleteFile: async (uri) => { deleted.push(uri); fs.unlinkSync(uri.split('/').join(path.sep)); },
    ...over,
  });
  const report = await tempCleanup.cleanStalePatrolTempFiles(ports(), T);
  assert.deepEqual(report.removed.map((u) => path.basename(u)).sort(), ['stale-capture.jpg', 'stale-encoded.jpg'], 'only stale, unreferenced camera / re-encode temporaries');
  assert.ok(!fs.existsSync(staleCapture) && !fs.existsSync(staleEncoded));
  for (const kept of [freshCapture, referencedTemp, otherCache, evidence]) assert.ok(fs.existsSync(kept), `${path.basename(kept)} is kept`);
  assert.equal(tempCleanup.PATROL_TEMP_MAX_AGE_MS, HOUR);
  // Queued evidence is never temporary, even if a port wrongly called its folder a temp location.
  const evidenceUri = evidence.split(path.sep).join('/');
  const wrong = await tempCleanup.cleanStalePatrolTempFiles(ports({ isTempLocation: () => true, referencedPaths: async () => [] }), T);
  assert.ok(fs.existsSync(evidence), 'patrol-evidence/ is never touched');
  assert.ok(!wrong.removed.includes(evidenceUri));
  assert.equal(tempCleanup.isPatrolEvidenceLocation('file:///data/user/0/com.sfour.s4/files/patrol-evidence/u7/ev-1.jpg'), true);
  assert.equal(tempCleanup.isPatrolEvidenceLocation('file:///data/user/0/com.sfour.s4/cache/Camera/a.jpg'), false);
  // A doubt deletes nothing: an unreadable outbox stops the sweep; an unknown age keeps the file.
  const before = deleted.length;
  const blocked = await tempCleanup.cleanStalePatrolTempFiles(ports({ referencedPaths: async () => { throw new Error('db locked'); } }), T + 10 * DAY);
  assert.deepEqual([blocked.skipped, blocked.removed.length, deleted.length], ['outbox_unreadable', 0, before]);
  const unknownAge = mk(camDir, 'unknown-age.jpg', 3 * HOUR);
  const noAge = await tempCleanup.cleanStalePatrolTempFiles(ports({ listTempFiles: async () => [{ uri: unknownAge.split(path.sep).join('/'), modifiedAtMs: null }] }), T);
  assert.deepEqual([noAge.removed.length, fs.existsSync(unknownAge)], [0, true]);
  const failing = await tempCleanup.cleanStalePatrolTempFiles(ports({ deleteFile: async () => { throw new Error('EBUSY'); } }), T);
  assert.equal(failing.failed, 1, 'a failed delete is counted, not thrown');
  // The SQL read that protects queued files returns every Guard's photo paths (and nothing else).
  const DatabaseSync = sqliteEngine();
  if (!DatabaseSync) console.log('      (node:sqlite is not available on this Node; referencedFilePaths is executed on Node >= 22.5)');
  else {
  const db = new DatabaseSync(':memory:');
  const api = { execAsync: async (s) => db.exec(s), runAsync: async (s, p) => db.prepare(s).run(...p), getAllAsync: async (s, p) => db.prepare(s).all(...p) };
  const backend = new FakeBackend();
  backend.offline = true;
  const fa = filesFor(192); const fb = filesFor(193);
  const pa = await recordPatrol(engineFor(192, new sql.SqlOutboxStore(api, now), backend, { files: fa }), fa);
  const pb = await recordPatrol(engineFor(193, new sql.SqlOutboxStore(api, now), backend, { files: fb }), fb);
  assert.deepEqual((await new sql.SqlOutboxStore(api, now).referencedFilePaths()).sort(), [pa.filePath, pb.filePath].sort());
  db.close();
  }
  assert.match(codeOf('src/components/guard/patrol/patrolOutboxSql.ts'), /SELECT data FROM patrol_outbox WHERE kind = 'photo'/, 'the one cross-owner read returns photo rows only');
  // Wiring: swept from the queue's own trigger, only the two cache folders, never the evidence folder; failures ignored.
  const native = stripComments(codeOf('src/services/patrolTempNative.ts'));
  assert.match(native, /const TEMP_FOLDERS = \['Camera', 'ImageManipulator'\]/);
  assert.match(native, /new Directory\(Paths\.cache, name\)/);
  assert.match(native, /referencedPaths: \(\) => patrolOutboxStore\(\)\.referencedFilePaths\(\)/);
  const syncSrc = stripComments(codeOf('src/services/patrolSync.ts'));
  assert.match(syncSrc, /kickRef\.current = \(eager = true\) => \{\s*sweepStalePatrolTempFiles\(\);/, 'swept before a sync pass');
  assert.match(syncSrc, /cleanStalePatrolTempFiles\(patrolTempCleanupPorts\(\), at\)\.catch\(\(\) => undefined\)/);
  assert.equal(tempCleanup.PATROL_TEMP_SWEEP_INTERVAL_MS, 10 * 60_000);
});

test('GPAT-20-SHARED-PHONE-BOTH-GUARDS-PENDING-B-SENDS-ONLY-B-AND-A-RECOVERS-AFTER-B', async () => {
  // A real SQLite database where available (Node >= 22.5), else the file-backed store that filters like the SQL.
  const DatabaseSync = sqliteEngine();
  const dbFile = path.join(TMP, 'shared-phone.db');
  const jsonFile = path.join(TMP, 'shared-phone.json');
  const open = () => { if (!DatabaseSync) return { db: { close: () => undefined }, store: new FileStore(jsonFile) }; const db = new DatabaseSync(dbFile); return { db, store: new sql.SqlOutboxStore({ execAsync: async (s) => db.exec(s), runAsync: async (s, p) => db.prepare(s).run(...p), getAllAsync: async (s, p) => db.prepare(s).all(...p) }, now) }; };
  const backend = new FakeBackend();
  const filesA = filesFor(201);
  const filesB = filesFor(202);
  // Guard A patrols offline and signs out with everything pending.
  backend.offline = true;
  let h = open();
  const A = engineFor(201, h.store, backend, { files: filesA });
  const a = await recordPatrol(A, filesA, 601);
  await A.sync();
  // Guard B signs in on the same phone, patrols, and is online.
  const B = engineFor(202, h.store, backend, { files: filesB });
  assert.deepEqual(await B.items(), [], 'B sees nothing of A\'s');
  const b = await recordPatrol(B, filesB, 602);
  backend.offline = false;
  backend.calls = [];
  const rb = await B.sync({ eager: true });
  assert.deepEqual([rb.sent, rb.pending], [4, 0], 'B sends exactly B\'s four steps');
  assert.ok(backend.calls.every((c) => !c.body || c.body.shiftId === undefined || c.body.shiftId === 602), 'nothing of A\'s shift was sent');
  assert.ok(backend.sent('putObject').every((c) => c.filePath === b.filePath), 'only B\'s photo was uploaded');
  assert.ok(fs.existsSync(a.filePath), 'A\'s queued photo is untouched by B\'s session');
  // B's retention prune (a week later) never reaches A's rows.
  clock += 8 * DAY;
  await B.sync();
  // The app restarts while B is signed out; A's rows are still pending in the same database.
  h.db.close();
  h = open();
  assert.deepEqual((await h.store.list(201)).map((i) => [i.kind, i.status]), [['start', 'pending'], ['scan', 'pending'], ['photo', 'pending'], ['complete', 'pending']], 'A\'s work stays dormant and intact');
  assert.ok((await h.store.referencedFilePaths()).includes(a.filePath), 'and protected from the temporary-file sweep');
  // A signs back in on the same phone: everything is sent, in order, from A's own folder (inside the post-shift rules,
  // which the server decides).
  backend.calls = [];
  const again = engineFor(201, h.store, backend, { files: filesA });
  const ra = await again.sync({ eager: true });
  assert.deepEqual([ra.sent, ra.pending, ra.paused], [4, 0, null], 'A recovers everything by signing back in');
  assert.ok(backend.sent('putObject').every((c) => c.filePath === a.filePath));
  assert.equal([...backend.runs.values()].filter((r) => r.shiftId === 601).length, 1, 'A\'s patrol is recorded once');
  assert.ok(!fs.existsSync(a.filePath), 'A\'s photo is deleted only after the server verified it');
  h.db.close();
});

test('GPAT-21-EVIDENCE-AND-OUTBOX-ARE-KEPT-OUT-OF-BACKUPS-AND-DEVICE-TRANSFER', () => {
  const plugin = require(path.join(ROOT, 'plugins', 'withPatrolBackupExclusion.js'));
  const expo = JSON.parse(codeOf('app.json')).expo;
  const names = expo.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
  assert.ok(names.includes('./plugins/withPatrolBackupExclusion'), 'the plugin is applied');
  const [, secureStore] = expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-secure-store');
  assert.equal(secureStore.configureAndroidBackup, false, 'expo-secure-store hands its backup rules to S4\'s plugin (no competing manifest values)');
  // Android: the manifest points at S4's own rules, whatever was there before.
  const manifest = { manifest: { application: [{ $: { 'android:name': '.MainApplication', 'android:allowBackup': 'true', 'android:fullBackupContent': '@xml/secure_store_backup_rules' } }] } };
  const app = plugin.applyManifest(manifest).manifest.application[0].$;
  assert.equal(app['android:fullBackupContent'], '@xml/s4_backup_rules');
  assert.equal(app['android:dataExtractionRules'], '@xml/s4_data_extraction_rules');
  assert.equal(app['android:allowBackup'], 'true', 'allowBackup is left as it was');
  // The rules are an allow-list: shared preferences minus SecureStore (expo-secure-store's own rules, kept exactly), and
  // no file / database / root / external domain — so patrol-evidence/ and SQLite/ are never backed up or transferred.
  const full = plugin.backupRulesXml();
  const extraction = plugin.dataExtractionRulesXml();
  const secureStoreRules = codeOf('node_modules/expo-secure-store/android/src/main/res/xml/secure_store_data_extraction_rules.xml');
  for (const line of ['<include domain="sharedpref" path="."/>', '<exclude domain="sharedpref" path="SecureStore"/>']) {
    assert.ok(secureStoreRules.includes(line), `expo-secure-store's rules still say ${line}`);
    assert.ok(full.includes(line) && extraction.includes(line), `kept: ${line}`);
  }
  const includes = (xml) => [...xml.matchAll(/<include domain="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(includes(full), ['sharedpref']);
  assert.deepEqual(includes(extraction), ['sharedpref', 'sharedpref'], 'cloud backup and device transfer');
  assert.match(full, /^<\?xml version="1\.0" encoding="utf-8"\?>\n[\s\S]*<full-backup-content>[\s\S]*<\/full-backup-content>\n$/);
  assert.match(extraction, /<cloud-backup>[\s\S]*<\/cloud-backup>\s*<device-transfer>[\s\S]*<\/device-transfer>/);
  for (const xml of [full, extraction]) assert.doesNotMatch(xml, /domain="(file|database|root|external|device_[a-z]+)"/, 'nothing from app files or databases');
  // The paths the rules keep out are the ones the app really uses.
  assert.match(codeOf('src/services/patrolNative.ts'), /const DATABASE_NAME = 's4-patrol-outbox\.db';/);
  assert.match(codeOf('src/services/patrolNative.ts'), /const EVIDENCE_ROOT = 'patrol-evidence';/);
  assert.match(codeOf('node_modules/expo-sqlite/android/src/main/java/expo/modules/sqlite/SQLiteModule.kt'), /context\.filesDir\.canonicalPath \+ File\.separator \+ "SQLite"/);
  assert.match(codeOf('node_modules/expo-sqlite/ios/SQLiteModule.swift'), /documentDirectory\?\.appendingPathComponent\("SQLite"\)/);
  // iOS: the reviewed Swift snippet on the SDK 54 template AppDelegate (scripts/fixtures, from expo-template-bare-minimum
  // 54.0.54): called first in didFinishLaunching, sets isExcludedFromBackup on both directories, idempotent.
  const template = codeOf('scripts/fixtures/expo-template-bare-minimum-54.0.54-AppDelegate.swift');
  const swift = plugin.applyAppDelegate(template, 'swift');
  assert.equal(plugin.applyAppDelegate(swift, 'swift'), swift, 'a second prebuild changes nothing');
  assert.match(swift, /\) -> Bool \{\n\/\/ @generated begin s4-patrol-backup-exclusion-call[^\n]*\n    s4ExcludePatrolDataFromBackup\(\)\n\/\/ @generated end s4-patrol-backup-exclusion-call\n    let delegate = ReactNativeDelegate\(\)/);
  assert.match(swift, /for name in \["patrol-evidence", "SQLite"\]/);
  assert.match(swift, /FileManager\.default\.urls\(for: \.documentDirectory, in: \.userDomainMask\)/);
  assert.match(swift, /values\.isExcludedFromBackup = true\n\s*try url\.setResourceValues\(values\)/);
  assert.match(swift, /createDirectory\(at: url, withIntermediateDirectories: true\)/);
  const added = swift.split('\n').filter((line) => !template.split('\n').includes(line) && !/^\s*\/\//.test(line)).join('\n');
  assert.match(added, /isExcludedFromBackup/);
  assert.doesNotMatch(added, /cachesDirectory|removeItem|moveItem|CryptoKit|CommonCrypto|SecKey|kSecAttr|FileProtectionType/, 'nothing moved, deleted, encrypted or re-protected');
  assert.equal((swift.match(/s4ExcludePatrolDataFromBackup\(\)/g) || []).length, 2, 'one declaration, one call');
  assert.throws(() => plugin.applyAppDelegate(template.replace('let delegate = ReactNativeDelegate()', ''), 'swift'), /Failed to match/, 'a changed template fails the prebuild rather than shipping without the exclusion');
  assert.throws(() => plugin.applyAppDelegate('@implementation AppDelegate', 'objcpp'), /Swift AppDelegate/);
});

test('GPAT-22-SEND-AGAIN-AFTER-A-RECOVERY-GRANT-RESENDS-ONLY-WINDOW-CLOSED-REFUSALS-WITH-THE-SAME-IDS', async () => {
  // Issue #68: S4 refused a patrol because the sync window had closed; the control room then issued a recovery grant.
  const backend = new FakeBackend();
  const files = filesFor(93);
  const engine = engineFor(93, new FileStore(path.join(TMP, 'recovery.json')), backend, { files });
  backend.offline = true;
  const p = await recordPatrol(engine, files);
  await engine.sync();
  backend.offline = false;
  backend.windowClosed = true;
  clock += 30 * HOUR;
  await engine.sync();
  const mine = async () => (await engine.items()).filter((i) => i.clientRunId === p.clientRunId);
  assert.deepEqual((await mine()).map((i) => i.status), ['refused', 'refused', 'refused', 'refused']);
  const refusedAt = (await mine())[0].settledAt;
  // Something refused for another reason, and something that failed, are never re-sent by "Send again".
  const other = { ...(await mine())[0], id: cid('other'), clientRunId: cid('run-other'), seq: 9_000, lastErrorCode: 'PATROL_SYNC_NOT_BOOKED_ON' };
  const failed = { ...(await mine())[0], id: cid('failed'), clientRunId: cid('run-failed'), seq: 9_001, status: 'failed', lastErrorCode: 'PATROL_IDEMPOTENCY_CONFLICT' };
  const store = new FileStore(path.join(TMP, 'recovery.json'));
  await store.put(other);
  await store.put(failed);
  // Nothing is ever retried automatically.
  clock += HOUR;
  const callsBefore = backend.calls.length;
  await engine.sync();
  assert.equal(backend.calls.length, callsBefore, 'a refusal is never retried on its own');
  // "Send again" while S4 still refuses: re-sent once with the same ids, refused again, still kept (and the photo too).
  assert.equal(await engine.retryWindowClosed(), 4, 'only the window-closed refusals are re-queued');
  assert.deepEqual((await mine()).map((i) => i.status), ['pending', 'pending', 'pending', 'pending']);
  await engine.sync({ eager: true });
  assert.deepEqual((await mine()).map((i) => [i.status, i.lastErrorCode]), Array(4).fill(['refused', 'PATROL_SYNC_WINDOW_CLOSED']));
  assert.ok(fs.existsSync(p.filePath), 'the photo is still kept');
  assert.notEqual((await mine())[0].settledAt, refusedAt, 'the 14-day retention restarts from the new refusal');
  // The grant is issued (the server accepts again): "Send again" delivers everything with the SAME client ids.
  backend.windowClosed = false;
  assert.equal(await engine.retryWindowClosed(), 4);
  const report = await engine.sync({ eager: true });
  assert.equal(report.sent, 4, 'start, scan, photo and completion accepted under the grant');
  assert.deepEqual((await mine()).map((i) => i.status), ['done', 'done', 'done', 'done']);
  const starts = backend.sent('startRun').filter((c) => c.body.clientRunId === p.clientRunId);
  assert.ok(starts.length >= 2 && starts.every((c) => c.body.clientRunId === p.clientRunId), 'the same clientRunId every time (idempotent on the server)');
  assert.deepEqual(backend.sent('recordVisit').filter((c) => c.body.clientVisitId === p.clientVisitId).map((c) => c.body.clientVisitId), [p.clientVisitId]);
  assert.ok(!fs.existsSync(p.filePath), 'the photo is removed only once the server verified it');
  const left = await engine.items();
  assert.equal(left.find((i) => i.id === other.id).status, 'refused', 'a Book On refusal is left alone');
  assert.equal(left.find((i) => i.id === failed.id).status, 'failed', 'a failure is left alone');
  assert.equal(await engine.retryWindowClosed(), 0, 'nothing left to re-send');
  // The Guard's control: shown only for a window-closed refusal, wired to retryWindowClosed and an eager send.
  const panel = fs.readFileSync(path.join(ROOT, 'src/components/guard/patrol/GuardPatrolPanel.tsx'), 'utf8');
  assert.match(panel, /item\.status === 'refused' && item\.lastErrorCode === PATROL_SYNC_WINDOW_CLOSED\) \? \(/);
  assert.match(panel, /<Button label="Send again"/);
  assert.match(panel, /engine\.retryWindowClosed\(\)[\s\S]{0,400}outbox\.kick\(\)/);
  assert.equal(outbox.RECOVERY_RETRY_HINT, 'If your control room has arranged late recovery for this shift, tap Send again.');
});

test('GPAT-23-CAMERA-HARDWARE-IS-OPTIONAL-SO-PLAY-KEEPS-CAMERA-LESS-DEVICES', () => {
  // Google Play reported 1.2.0 (21) dropping 436 devices that 1.1.2 (20) supported: CAMERA with no <uses-feature> makes
  // Play imply android.hardware.camera and android.hardware.camera.autofocus as REQUIRED. The plugin declares both
  // optional; a phone without a camera installs S4 and the patrol camera reports itself unavailable (GPAT-01).
  const plugin = require(path.join(ROOT, 'plugins', 'withOptionalCameraHardware.js'));
  const expo = JSON.parse(codeOf('app.json')).expo;
  const names = expo.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
  assert.ok(names.includes('./plugins/withOptionalCameraHardware'), 'the plugin is applied');
  assert.equal(names.indexOf('./plugins/withOptionalCameraHardware'), names.indexOf('./plugins/withPatrolBackupExclusion') + 1, 'right after the backup exclusion');
  const CAMERA_FEATURES = ['android.hardware.camera', 'android.hardware.camera.autofocus'];
  assert.deepEqual(plugin.OPTIONAL_FEATURES, CAMERA_FEATURES);
  const featuresOf = (m) => (m.manifest['uses-feature'] || []).map((f) => [f.$['android:name'], f.$['android:required']]);
  const exactlyOnceOptional = (m, label) => {
    for (const name of CAMERA_FEATURES) {
      const found = featuresOf(m).filter(([n]) => n === name);
      assert.deepEqual(found, [[name, 'false']], `${label}: ${name} exactly once, android:required="false"`);
    }
  };
  const permission = { $: { 'android:name': 'android.permission.CAMERA' } };
  // 1. A manifest with no <uses-feature> at all (what 1.2.0 (21) shipped).
  const bare = { manifest: { $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' }, 'uses-permission': [permission], application: [{ $: { 'android:name': '.MainApplication' } }] } };
  const fromBare = plugin.applyManifest(bare);
  exactlyOnceOptional(fromBare, 'no uses-feature before');
  assert.deepEqual(featuresOf(fromBare), CAMERA_FEATURES.map((n) => [n, 'false']), 'nothing else is added');
  assert.deepEqual(fromBare.manifest['uses-permission'], [permission], 'the CAMERA permission is untouched');
  // 2. An existing required camera entry (and a duplicate of it) becomes one optional entry; unrelated features are kept.
  const touch = { $: { 'android:name': 'android.hardware.touchscreen', 'android:required': 'false' } };
  const existing = { manifest: { 'uses-feature': [
    { $: { 'android:name': 'android.hardware.camera', 'android:required': 'true' } },
    touch,
    { $: { 'android:name': 'android.hardware.camera' } },
  ], application: [{ $: {} }] } };
  const fromExisting = plugin.applyManifest(existing);
  exactlyOnceOptional(fromExisting, 'camera required=true before');
  assert.deepEqual(featuresOf(fromExisting).filter(([n]) => !CAMERA_FEATURES.includes(n)), [['android.hardware.touchscreen', 'false']], 'an unrelated feature is kept as it was');
  // 3. Idempotent: a second prebuild adds nothing and changes nothing.
  for (const m of [fromBare, fromExisting]) {
    const once = JSON.stringify(m);
    assert.equal(JSON.stringify(plugin.applyManifest(JSON.parse(once))), once, 'a second prebuild changes nothing');
  }
  // 4. No new REQUIRED feature anywhere: every feature the plugin produces is optional.
  for (const m of [fromBare, fromExisting]) {
    assert.ok(featuresOf(m).every(([, required]) => required === 'false'), 'no required hardware feature');
  }
  // Android only, and the permission and its handling are kept.
  const src = codeOf('plugins/withOptionalCameraHardware.js');
  assert.match(src, /require\('expo\/config-plugins'\)/);
  assert.doesNotMatch(src, /withInfoPlist|withAppDelegate|withEntitlementsPlist|withIos|withDangerousMod|uses-permission/, 'no iOS mod and no permission change');
  assert.ok(expo.android.permissions.includes('CAMERA'), 'CAMERA is still requested');
  assert.ok(!expo.android.blockedPermissions.includes('android.permission.CAMERA'), 'and not blocked');
  assert.ok(!('features' in expo.android) && !('usesFeatures' in expo.android), 'no other feature declaration in app.json');
  assert.match(codeOf('src/components/guard/patrol/GuardPatrolCamera.tsx'), /CameraView\.isAvailableAsync\(\)\.then\(setAvailable\)/, 'a missing camera is detected at run time');
});

(async () => {
  try {
    for (const [id, fn] of tests) {
      await fn();
      passed += 1;
      console.log(`PASS  ${id}`);
    }
    console.log(`\n${passed} Guard patrol checks passed`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})();
