// The Guard's offline patrol outbox and its sync engine (Patrols P1-E). PURE: storage, files, network and clock are
// injected, so the same code is executed by scripts/guard-patrols.spec.cjs and on the phone (src/services/patrolSync.ts).
//
// DURABILITY. Every Guard action is written to the outbox (SQLite on the phone) BEFORE any network call, with the
// client-generated id the backend is idempotent on and the device time of the action. Nothing is ever deleted because a
// send failed, the app was killed, the Guard booked off, signed out or lost signal.
//
// OWNERSHIP. Every row carries the Guard's user id. The engine is built for ONE signed-in user and only ever reads, sends
// or deletes that user's rows (the SQL itself filters on it) and only that user's evidence folder. On sign-out the
// queue is simply not running; it resumes when the same Guard signs in again. Another person signing in on a shared
// phone gets their own (empty) queue and cannot see or send the first Guard's items or photos.
//
// ORDER. Per patrol (clientRunId): start → scans in the order they were made → completion, strictly; a later step is
// never sent before an earlier one is accepted. A photo waits only for what it belongs to (the start, or its scan) and
// never holds up the rest. A Guard-reported exception ("checkpoint inaccessible") travels inside the completion, which
// is the backend's API for it (POST /patrols/runs/:id/complete exceptionReason → an incomplete patrol).
//
// RETRY. Exponential backoff with jitter (PATROL_RETRY_BASE_MS doubling to PATROL_RETRY_MAX_MS), single-flight (one pass
// at a time; a request for another pass during one runs once more after it). A connection failure ends the pass. Replays
// reuse the same client id, so a request that reached the server before the phone lost the answer is harmless.
//
// OUTCOMES (from the server; never decided locally):
//   done      accepted (a replay of an accepted write is accepted too). A photo is done only when the server VERIFIED it;
//             its local file is deleted then.
//   refused   the server will not accept it under the sync rules — PATROL_SYNC_WINDOW_CLOSED (more than the policy's
//             post-shift hours after Book Off), PATROL_SYNC_NOT_BOOKED_ON, PATROL_SHIFT_NOT_IN_PROGRESS. Kept and shown
//             ("could not be sent — contact your control room"), never retried, never silently deleted.
//   failed    any other permanent answer (409 PATROL_IDEMPOTENCY_CONFLICT payload mismatch, a rejected photo, 404 …).
//             Kept and shown the same way.
//   auth      401 after the shared session renewal failed: the WHOLE queue pauses (nothing is dropped or counted as an
//             attempt) until the Guard signs in again.
//
// RETENTION. done rows: PATROL_DONE_RETENTION_MS (7 days) for the on-phone history, then removed (their photo was
// already deleted on verification). refused / failed rows and their photo: PATROL_REFUSED_RETENTION_MS (14 days after
// the refusal), then removed with the photo — long enough for the control room to arrange recovery (issue #68). Pending
// rows never expire.

import type { GuardEvidenceUploadIntent, PatrolEvidence, PatrolRun, PatrolVisit } from '../../../types/patrols';

export const PATROL_RETRY_BASE_MS = 5_000;
export const PATROL_RETRY_MAX_MS = 2 * 60_000;
export const PATROL_DONE_RETENTION_MS = 7 * 24 * 3600_000;
export const PATROL_REFUSED_RETENTION_MS = 14 * 24 * 3600_000;
const MAX_STEPS_PER_PASS = 500;

export type OutboxKind = 'start' | 'scan' | 'photo' | 'exception' | 'complete';
export type OutboxStatus = 'pending' | 'done' | 'refused' | 'failed';
export type PhotoStage = 'intent' | 'put' | 'complete';

export interface OutboxItem {
  /** The step's own client id: clientRunId (start), clientVisitId (scan), clientEvidenceId (photo), or derived ones. */
  id: string;
  ownerUserId: number;
  companyId: number | null;
  shiftId: number;
  clientRunId: string;
  /** Creation order; also the strict sending order of a run's non-photo steps. */
  seq: number;
  kind: OutboxKind;
  /** Device time of the Guard's action (ISO), kept as captured. */
  createdAt: string;
  /** Exactly what is sent (sentAtDevice is added at each send). Never a location. */
  body: Record<string, unknown>;
  /** Display-only context kept on the phone (checkpoint label, site name …). Never sent. */
  meta: Record<string, unknown>;
  /** The step that must be accepted first (start for scans and run photos, the scan for a checkpoint photo). */
  dependsOn: string | null;
  photo?: { stage: PhotoStage; filePath: string; sha256: string; sizeBytes: number; contentType: 'image/jpeg'; evidenceId: number | null; uploadStatus: string | null };
  attempts: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  status: OutboxStatus;
  settledAt: string | null;
  /** What the server answered (ids, verdicts, server receipt times). */
  server: {
    runId?: number;
    visitId?: number;
    result?: string;
    flags?: string[];
    checkpointLabel?: string | null;
    receivedAt?: string | null;
    runStatus?: string;
    verificationStatus?: string;
    evidenceId?: number;
    uploadStatus?: string;
    carriedBy?: string;
  } | null;
}

/** Persistent storage of the outbox. Every method is scoped to one owner. */
export interface OutboxStore {
  list(ownerUserId: number): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  remove(ownerUserId: number, id: string): Promise<void>;
}

export type PresignedUpload = NonNullable<GuardEvidenceUploadIntent['upload']>;

export interface PatrolTransport {
  startRun(body: Record<string, unknown>): Promise<PatrolRun>;
  recordVisit(runId: number, body: Record<string, unknown>): Promise<PatrolVisit>;
  completeRun(runId: number, body: Record<string, unknown>): Promise<PatrolRun>;
  requestUpload(runId: number, body: Record<string, unknown>): Promise<GuardEvidenceUploadIntent>;
  /** PUT the file's bytes to the presigned URL with exactly its headers. Resolves with the storage's HTTP status. */
  putObject(upload: PresignedUpload, filePath: string): Promise<{ status: number }>;
  completeUpload(evidenceId: number): Promise<PatrolEvidence>;
}

export interface EvidenceFiles {
  /** Whether the path is inside this owner's private evidence folder. */
  owns(path: string): boolean;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export type ErrorClass =
  | { kind: 'transient'; code: string; message: string; network: boolean }
  | { kind: 'auth'; code: string; message: string }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'reupload'; code: string; message: string };

const REFUSED_CODES = new Set(['PATROL_SYNC_WINDOW_CLOSED', 'PATROL_SYNC_NOT_BOOKED_ON', 'PATROL_SHIFT_NOT_IN_PROGRESS']);

function errorBody(error: unknown): { status: number | null; code: string | null; message: string | null; name: string | null } {
  const e = (error ?? {}) as { status?: unknown; body?: unknown; name?: unknown; message?: unknown };
  const body = (e.body && typeof e.body === 'object' ? e.body : {}) as { code?: unknown; message?: unknown };
  return {
    status: typeof e.status === 'number' ? e.status : null,
    code: typeof body.code === 'string' ? body.code : null,
    message: typeof body.message === 'string' ? body.message : typeof e.message === 'string' ? e.message : null,
    name: typeof e.name === 'string' ? e.name : null,
  };
}

/** How one failed send is treated. Unknown shapes are transient: a doubt never discards anything. */
export function classifyError(error: unknown): ErrorClass {
  const { status, code, message, name } = errorBody(error);
  if (status == null) {
    const network = name === 'NetworkError' || name === 'TypeError' || name === 'AbortError';
    return { kind: 'transient', code: network ? 'NETWORK' : 'UNKNOWN', message: network ? 'No connection to S4.' : 'Could not send yet. Retrying.', network };
  }
  if (status === 401) return { kind: 'auth', code: 'AUTH_REQUIRED', message: 'Sign in again to send your patrol.' };
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { kind: 'transient', code: code ?? `HTTP_${status}`, message: message ?? 'S4 is busy. Retrying.', network: false };
  }
  if (code === 'PATROL_EVIDENCE_NOT_UPLOADED') return { kind: 'reupload', code, message: message ?? 'Photo not received yet.' };
  if (code === 'PATROL_EVIDENCE_COMPLETION_IN_PROGRESS') return { kind: 'transient', code, message: message ?? 'Photo is being checked.', network: false };
  if (code && REFUSED_CODES.has(code)) return { kind: 'refused', code, message: message ?? 'S4 could not accept this.' };
  return { kind: 'failed', code: code ?? `HTTP_${status}`, message: message ?? 'S4 could not accept this.' };
}

/** Exponential backoff with jitter: base × 2^(attempts−1), capped, then scaled by 0.5–1.0. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const raw = Math.min(PATROL_RETRY_MAX_MS, PATROL_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(raw * (0.5 + 0.5 * Math.min(1, Math.max(0, random()))));
}

export const NOT_SENT_MESSAGE = 'Could not be sent — contact your control room.';

/** A Guard's exception reasons and their own words, as the completion's exceptionReason (≤ 500 characters). */
export function composeExceptionReason(exceptions: Array<{ label: string; reason: string }>, note: string | null): string | null {
  const lines = exceptions.map((e) => `Checkpoint not reached — ${e.label}: ${e.reason.trim()}`);
  if (note && note.trim()) lines.push(note.trim());
  if (!lines.length) return null;
  const text = lines.join('\n');
  return text.length <= 500 ? text : `${text.slice(0, 497)}...`;
}

export type SyncReport = { sent: number; pending: number; paused: 'auth' | null; offline: boolean };

type EngineOptions = {
  ownerUserId: number;
  store: OutboxStore;
  transport: PatrolTransport;
  files: EvidenceFiles;
  now?: () => Date;
  random?: () => number;
};

export class PatrolOutboxEngine {
  readonly ownerUserId: number;
  private readonly store: OutboxStore;
  private readonly transport: PatrolTransport;
  private readonly files: EvidenceFiles;
  private readonly now: () => Date;
  private readonly random: () => number;
  private running: Promise<SyncReport> | null = null;
  private again = false;
  private eagerNext = false;
  private authPaused = false;
  private listeners = new Set<() => void>();

  constructor(options: EngineOptions) {
    if (!Number.isInteger(options.ownerUserId) || options.ownerUserId <= 0) throw new Error('A patrol outbox needs a signed-in user.');
    this.ownerUserId = options.ownerUserId;
    this.store = options.store;
    this.transport = options.transport;
    this.files = options.files;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  get pausedForAuth(): boolean {
    return this.authPaused;
  }

  /** After the Guard signs in again with a working session. */
  resumeAfterSignIn() {
    this.authPaused = false;
  }

  /** This owner's items, oldest first. Rows of anyone else are never returned, even if a store misbehaved. */
  async items(): Promise<OutboxItem[]> {
    const rows = await this.store.list(this.ownerUserId);
    return rows.filter((r) => r.ownerUserId === this.ownerUserId).sort((a, b) => a.seq - b.seq);
  }

  private async nextSeq(): Promise<number> {
    const rows = await this.items();
    return rows.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
  }

  private base(fields: Pick<OutboxItem, 'id' | 'kind' | 'shiftId' | 'clientRunId' | 'companyId' | 'body' | 'meta' | 'dependsOn' | 'createdAt'>, seq: number): OutboxItem {
    return {
      ...fields,
      ownerUserId: this.ownerUserId,
      seq,
      attempts: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      status: 'pending',
      settledAt: null,
      server: null,
    };
  }

  private async add(item: OutboxItem): Promise<OutboxItem> {
    const existing = (await this.items()).find((r) => r.id === item.id);
    if (existing) return existing; // the same client id is the same action: never queued twice
    await this.store.put(item);
    this.emit();
    return item;
  }

  async enqueueStart(input: { clientRunId: string; shiftId: number; companyId: number | null; scheduleId: number | null; routeId: number | null; startedAtDevice: string; meta?: Record<string, unknown> }) {
    const body: Record<string, unknown> = { clientRunId: input.clientRunId, shiftId: input.shiftId, startedAtDevice: input.startedAtDevice };
    if (input.scheduleId != null) body.scheduleId = input.scheduleId;
    if (input.routeId != null) body.routeId = input.routeId;
    return this.add(this.base({ id: input.clientRunId, kind: 'start', shiftId: input.shiftId, clientRunId: input.clientRunId, companyId: input.companyId, body, meta: input.meta ?? {}, dependsOn: null, createdAt: input.startedAtDevice }, await this.nextSeq()));
  }

  private async runStart(clientRunId: string): Promise<OutboxItem> {
    const start = (await this.items()).find((r) => r.kind === 'start' && r.clientRunId === clientRunId);
    if (!start) throw new Error('This patrol was not started on this phone.');
    return start;
  }

  async enqueueScan(input: { clientRunId: string; clientVisitId: string; scanPayload: string; scannedAtDevice: string; meta?: Record<string, unknown> }) {
    const start = await this.runStart(input.clientRunId);
    const body = { clientVisitId: input.clientVisitId, scanPayload: input.scanPayload, scannedAtDevice: input.scannedAtDevice };
    return this.add(this.base({ id: input.clientVisitId, kind: 'scan', shiftId: start.shiftId, clientRunId: input.clientRunId, companyId: start.companyId, body, meta: input.meta ?? {}, dependsOn: start.id, createdAt: input.scannedAtDevice }, await this.nextSeq()));
  }

  async enqueuePhoto(input: {
    clientRunId: string;
    clientEvidenceId: string;
    kind: 'run_photo' | 'checkpoint_photo';
    clientVisitId?: string | null;
    capturedAtDevice: string;
    file: { path: string; sha256: string; sizeBytes: number };
    meta?: Record<string, unknown>;
  }) {
    if (!this.files.owns(input.file.path)) throw new Error('A patrol photo must be in the signed-in Guard\'s own folder.');
    const start = await this.runStart(input.clientRunId);
    if (input.kind === 'checkpoint_photo' && !input.clientVisitId) throw new Error('A checkpoint photo belongs to a scan.');
    const body = { clientEvidenceId: input.clientEvidenceId, kind: input.kind, contentType: 'image/jpeg', sizeBytes: input.file.sizeBytes, sha256: input.file.sha256, capturedAtDevice: input.capturedAtDevice };
    const item = this.base({ id: input.clientEvidenceId, kind: 'photo', shiftId: start.shiftId, clientRunId: input.clientRunId, companyId: start.companyId, body, meta: input.meta ?? {}, dependsOn: input.kind === 'checkpoint_photo' ? input.clientVisitId! : start.id, createdAt: input.capturedAtDevice }, await this.nextSeq());
    item.photo = { stage: 'intent', filePath: input.file.path, sha256: input.file.sha256, sizeBytes: input.file.sizeBytes, contentType: 'image/jpeg', evidenceId: null, uploadStatus: null };
    return this.add(item);
  }

  /** A Guard-reported exception, kept on the phone until the patrol is completed (it is sent inside the completion). */
  async recordException(input: { clientRunId: string; id: string; label: string; reason: string; at: string; publicId?: string | null }) {
    const start = await this.runStart(input.clientRunId);
    const reason = input.reason.trim();
    if (!reason) throw new Error('Give a reason.');
    return this.add(this.base({ id: input.id, kind: 'exception', shiftId: start.shiftId, clientRunId: input.clientRunId, companyId: start.companyId, body: {}, meta: { label: input.label, reason, publicId: input.publicId ?? null }, dependsOn: start.id, createdAt: input.at }, await this.nextSeq()));
  }

  async enqueueComplete(input: { clientRunId: string; completedAtDevice: string; note?: string | null; meta?: Record<string, unknown> }) {
    const start = await this.runStart(input.clientRunId);
    const rows = await this.items();
    const id = `${input.clientRunId}-complete`;
    const already = rows.find((r) => r.id === id);
    if (already) return already;
    const exceptions = rows.filter((r) => r.kind === 'exception' && r.clientRunId === input.clientRunId);
    const reason = composeExceptionReason(exceptions.map((e) => ({ label: String(e.meta.label ?? 'Checkpoint'), reason: String(e.meta.reason ?? '') })), input.note ?? null);
    const body: Record<string, unknown> = { completedAtDevice: input.completedAtDevice };
    if (reason) body.exceptionReason = reason;
    const item = await this.add(this.base({ id, kind: 'complete', shiftId: start.shiftId, clientRunId: input.clientRunId, companyId: start.companyId, body, meta: input.meta ?? {}, dependsOn: start.id, createdAt: input.completedAtDevice }, await this.nextSeq()));
    for (const e of exceptions) {
      await this.store.put({ ...e, status: 'done', settledAt: input.completedAtDevice, server: { carriedBy: id } });
    }
    this.emit();
    return item;
  }

  /**
   * One sync pass (single-flight). A call during a pass makes exactly one more pass run after it.
   * `eager` (the app came to the foreground, the Guard just acted, or pressed Send now) tries each waiting step once
   * even if its backoff has not elapsed; the timer-driven retries respect the backoff.
   */
  sync(options: { eager?: boolean } = {}): Promise<SyncReport> {
    if (options.eager) this.eagerNext = true;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let report: SyncReport;
      try {
        do {
          this.again = false;
          const eager = this.eagerNext;
          this.eagerNext = false;
          report = await this.pass(eager);
        } while (this.again && !report.paused && !report.offline);
      } finally {
        this.running = null;
      }
      return report;
    })();
    return this.running;
  }

  /** The earliest time a waiting item may be retried, or null when nothing is waiting on a timer. */
  async nextWakeAt(): Promise<Date | null> {
    const pending = (await this.items()).filter((r) => r.status === 'pending' && r.kind !== 'exception' && r.nextAttemptAt);
    if (!pending.length) return null;
    return new Date(Math.min(...pending.map((r) => new Date(r.nextAttemptAt!).getTime())));
  }

  private async pass(eager = false): Promise<SyncReport> {
    const tried = new Set<string>();
    if (this.authPaused) return { sent: 0, pending: await this.pendingCount(), paused: 'auth', offline: false };
    await this.prune();
    let sent = 0;
    for (let step = 0; step < MAX_STEPS_PER_PASS; step += 1) {
      const rows = await this.items();
      for (const row of this.cascadeBlocked(rows)) await this.store.put(row);
      const next = this.nextEligible(rows, eager ? tried : null);
      if (!next) break;
      tried.add(next.id);
      const outcome = await this.send(next, rows);
      this.emit();
      if (outcome === 'sent') sent += 1;
      if (outcome === 'auth') return { sent, pending: await this.pendingCount(), paused: 'auth', offline: false };
      if (outcome === 'offline') return { sent, pending: await this.pendingCount(), paused: null, offline: true };
    }
    return { sent, pending: await this.pendingCount(), paused: null, offline: false };
  }

  private async pendingCount(): Promise<number> {
    return (await this.items()).filter((r) => r.status === 'pending' && r.kind !== 'exception').length;
  }

  /** A step whose prerequisite can never be accepted can never be either: it settles with the same outcome. */
  private cascadeBlocked(rows: OutboxItem[]): OutboxItem[] {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const settled = new Set<OutboxItem>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (row.status !== 'pending') continue;
        const blockers = [row.dependsOn ? byId.get(row.dependsOn) : undefined, ...this.earlierSteps(row, rows)].filter(Boolean) as OutboxItem[];
        const dead = blockers.find((b) => b.status === 'refused' || b.status === 'failed');
        if (dead) {
          row.status = dead.status;
          row.lastErrorCode = dead.lastErrorCode;
          row.lastErrorMessage = dead.lastErrorMessage;
          row.settledAt = this.now().toISOString();
          row.nextAttemptAt = null;
          settled.add(row);
          changed = true;
        }
      }
    }
    return [...settled];
  }

  /** The run's earlier non-photo steps that must be accepted first (strict order); photos wait only on dependsOn. */
  private earlierSteps(row: OutboxItem, rows: OutboxItem[]): OutboxItem[] {
    if (row.kind === 'photo' || row.kind === 'exception') return [];
    return rows.filter((r) => r.clientRunId === row.clientRunId && r.seq < row.seq && (r.kind === 'start' || r.kind === 'scan' || r.kind === 'complete'));
  }

  /** `eagerTried`: in an eager pass, the steps already tried in it (each is tried at most once despite its backoff). */
  private nextEligible(rows: OutboxItem[], eagerTried: Set<string> | null): OutboxItem | null {
    const now = this.now().getTime();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const row of rows) {
      if (row.status !== 'pending' || row.kind === 'exception') continue;
      if (row.ownerUserId !== this.ownerUserId) continue;
      if (row.nextAttemptAt && new Date(row.nextAttemptAt).getTime() > now && (!eagerTried || eagerTried.has(row.id))) continue;
      const dep = row.dependsOn ? byId.get(row.dependsOn) : null;
      if (row.dependsOn && (!dep || dep.status !== 'done')) continue;
      if (this.earlierSteps(row, rows).some((r) => r.status !== 'done')) continue;
      return row;
    }
    return null;
  }

  private runIdFor(row: OutboxItem, rows: OutboxItem[]): number {
    const start = rows.find((r) => r.kind === 'start' && r.clientRunId === row.clientRunId);
    const runId = start?.server?.runId;
    if (!runId) throw new Error('patrol run id missing');
    return runId;
  }

  private sentAt(): string {
    return this.now().toISOString();
  }

  private async settle(row: OutboxItem, status: OutboxStatus, server: OutboxItem['server'], error?: { code: string; message: string }) {
    const next: OutboxItem = {
      ...row,
      status,
      server: { ...(row.server ?? {}), ...(server ?? {}) },
      settledAt: status === 'pending' ? null : this.now().toISOString(),
      nextAttemptAt: null,
      lastErrorCode: error?.code ?? (status === 'done' ? null : row.lastErrorCode),
      lastErrorMessage: error?.message ?? (status === 'done' ? null : row.lastErrorMessage),
    };
    await this.store.put(next);
    return next;
  }

  private async retryLater(row: OutboxItem, error: { code: string; message: string }, patch: Partial<OutboxItem> = {}) {
    const attempts = row.attempts + 1;
    await this.store.put({
      ...row,
      ...patch,
      attempts,
      nextAttemptAt: new Date(this.now().getTime() + backoffMs(attempts, this.random)).toISOString(),
      lastErrorCode: error.code,
      lastErrorMessage: error.message,
    });
  }

  /** Sends one step. 'sent' | 'retry' | 'settled' | 'auth' | 'offline'. */
  private async send(row: OutboxItem, rows: OutboxItem[]): Promise<'sent' | 'retry' | 'settled' | 'auth' | 'offline'> {
    try {
      if (row.kind === 'start') {
        const run = await this.transport.startRun({ ...row.body, sentAtDevice: this.sentAt() });
        await this.settle(row, 'done', { runId: run.id, receivedAt: run.startedAtServer, runStatus: run.status, verificationStatus: run.verificationStatus });
        return 'sent';
      }
      if (row.kind === 'scan') {
        const visit = await this.transport.recordVisit(this.runIdFor(row, rows), { ...row.body, sentAtDevice: this.sentAt() });
        await this.settle(row, 'done', { visitId: visit.id, result: visit.result, flags: visit.flags, checkpointLabel: visit.checkpointLabel, receivedAt: visit.receivedAtServer });
        return 'sent';
      }
      if (row.kind === 'complete') {
        const run = await this.transport.completeRun(this.runIdFor(row, rows), { ...row.body, sentAtDevice: this.sentAt() });
        await this.settle(row, 'done', { runId: run.id, receivedAt: run.completedAtServer, runStatus: run.status, verificationStatus: run.verificationStatus });
        return 'sent';
      }
      return await this.sendPhoto(row, rows);
    } catch (error) {
      const c = classifyError(error);
      if (c.kind === 'auth') {
        this.authPaused = true;
        await this.store.put({ ...row, lastErrorCode: c.code, lastErrorMessage: c.message }); // not an attempt; nothing dropped
        return 'auth';
      }
      if (c.kind === 'refused' || c.kind === 'failed') {
        await this.settle(row, c.kind, null, c);
        return 'settled';
      }
      if (c.kind === 'reupload' && row.photo) {
        await this.retryLater(row, c, { photo: { ...row.photo, stage: 'put' } });
        return 'retry';
      }
      await this.retryLater(row, c);
      return c.kind === 'transient' && c.network ? 'offline' : 'retry';
    }
  }

  private async sendPhoto(row: OutboxItem, rows: OutboxItem[]): Promise<'sent' | 'retry' | 'settled'> {
    const photo = row.photo!;
    if (!this.files.owns(photo.filePath)) {
      await this.settle(row, 'failed', null, { code: 'LOCAL_FILE_NOT_OWNED', message: 'This photo is not in your own folder.' });
      return 'settled';
    }
    if (photo.stage !== 'complete') {
      if (!(await this.files.exists(photo.filePath))) {
        await this.settle(row, 'failed', null, { code: 'LOCAL_FILE_MISSING', message: 'The photo is no longer on this phone.' });
        return 'settled';
      }
      const body: Record<string, unknown> = { ...row.body, sentAtDevice: this.sentAt() };
      if (row.body.kind === 'checkpoint_photo') {
        const visitId = rows.find((r) => r.id === row.dependsOn)?.server?.visitId;
        if (!visitId) throw new Error('scan id missing');
        body.visitId = visitId;
      }
      const intent = await this.transport.requestUpload(this.runIdFor(row, rows), body);
      const evidenceId = intent.evidence.id;
      let current: OutboxItem = { ...row, photo: { ...photo, stage: 'put', evidenceId, uploadStatus: intent.evidence.uploadStatus }, server: { ...(row.server ?? {}), evidenceId } };
      await this.store.put(current);
      if (intent.upload) {
        const put = await this.transport.putObject(intent.upload, photo.filePath); // the URL is used once and never stored
        if (put.status === 400) {
          await this.settle(current, 'failed', null, { code: 'STORAGE_REJECTED_UPLOAD', message: 'Storage refused the photo bytes (the file may be damaged).' });
          return 'settled';
        }
        if (put.status < 200 || put.status >= 300) {
          await this.retryLater(current, { code: `STORAGE_${put.status}`, message: 'The photo upload did not finish. Retrying.' });
          return 'retry';
        }
      } else if (intent.evidence.uploadStatus === 'verified' || intent.evidence.uploadStatus === 'rejected') {
        return this.photoSettled(current, intent.evidence);
      }
      current = { ...current, photo: { ...current.photo!, stage: 'complete' } };
      await this.store.put(current);
      row = current;
    }
    const evidence = await this.transport.completeUpload(row.photo!.evidenceId!);
    return this.photoSettled(row, evidence);
  }

  private async photoSettled(row: OutboxItem, evidence: PatrolEvidence): Promise<'sent' | 'retry' | 'settled'> {
    const photo = { ...row.photo!, uploadStatus: evidence.uploadStatus };
    if (evidence.uploadStatus === 'verified') {
      await this.files.remove(photo.filePath).catch(() => undefined); // the server holds the verified copy now
      await this.settle({ ...row, photo }, 'done', { evidenceId: evidence.id, uploadStatus: 'verified', receivedAt: evidence.receivedAt });
      return 'sent';
    }
    if (evidence.uploadStatus === 'rejected' || evidence.uploadStatus === 'local_corrupt') {
      await this.settle({ ...row, photo }, 'failed', { evidenceId: evidence.id, uploadStatus: evidence.uploadStatus }, {
        code: 'PATROL_EVIDENCE_REJECTED',
        message: evidence.rejectionReason ? `S4 rejected the photo (${evidence.rejectionReason}).` : 'S4 rejected the photo.',
      });
      return 'settled';
    }
    await this.retryLater({ ...row, photo }, { code: 'PATROL_EVIDENCE_PENDING', message: 'The photo is still being checked.' });
    return 'retry';
  }

  /** Applies the retention rules (see the header). Never touches a pending row. */
  async prune(): Promise<number> {
    const now = this.now().getTime();
    let removed = 0;
    for (const row of await this.items()) {
      if (row.status === 'pending' || !row.settledAt) continue;
      const age = now - new Date(row.settledAt).getTime();
      const limit = row.status === 'done' ? PATROL_DONE_RETENTION_MS : PATROL_REFUSED_RETENTION_MS;
      if (age < limit) continue;
      if (row.photo && this.files.owns(row.photo.filePath)) await this.files.remove(row.photo.filePath).catch(() => undefined);
      await this.store.remove(this.ownerUserId, row.id);
      removed += 1;
    }
    if (removed) this.emit();
    return removed;
  }
}
