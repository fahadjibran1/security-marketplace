import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createReadStream } from 'fs';
import * as http from 'http';
import * as https from 'https';
import { Readable } from 'stream';
import { PatrolErrorCode, patrolError } from '../patrol-constants';
import { PATROL_STORAGE_PREFIX_PATTERN, isPatrolKey } from './patrol-evidence-keys';
import { pathStyleUri, presignV4 } from './sigv4';

/**
 * Private S3-compatible object storage for patrol photo evidence (Patrols P1-C). Cloudflare R2 is the intended provider;
 * AWS S3 and MinIO speak the same API. Separate from the compliance / screening evidence store (its own bucket, keys and
 * credentials — EvidenceStorageService is untouched), and entirely optional: with no configuration every evidence route
 * fails closed with 503 PATROL_EVIDENCE_STORAGE_UNAVAILABLE and nothing else in Patrols changes.
 *
 *   PATROL_EVIDENCE_STORAGE_ENDPOINT           https://<account>.r2.cloudflarestorage.com (https required, except a
 *                                              localhost / 127.0.0.1 test server)
 *   PATROL_EVIDENCE_STORAGE_REGION             'auto' for R2 (the default); the bucket's region for S3; any for MinIO
 *   PATROL_EVIDENCE_STORAGE_BUCKET             a PRIVATE bucket (no public access, no public dev URL)
 *   PATROL_EVIDENCE_STORAGE_ACCESS_KEY_ID      a token scoped to that bucket: Object Read & Write only (no ListBucket,
 *   PATROL_EVIDENCE_STORAGE_SECRET_ACCESS_KEY    no admin)
 *   PATROL_EVIDENCE_STORAGE_PREFIX             optional key prefix (e.g. 'staging'), [a-z0-9-]
 *   PATROL_EVIDENCE_URL_TTL_SECONDS            presigned URL lifetime, 60–300 (default 120)
 *   PATROL_EVIDENCE_MAX_BYTES                  per-photo cap, 64 KiB–25 MiB (default 10 MiB)
 *   PATROL_EVIDENCE_STORAGE_CHECKSUM_HEADER    'false' to stop signing x-amz-checksum-sha256 on uploads (default on)
 *   PATROL_EVIDENCE_STORAGE_SIGN_CONTENT_LENGTH  'false' to stop signing Content-Length on uploads (default on)
 *
 * Path-style requests (https://endpoint/bucket/key) — what R2 and MinIO expect and S3 still accepts. Every request is a
 * SigV4 presigned request (sigv4.ts); the server's own requests are made with node's http(s) client, streamed in both
 * directions so no photo or export is ever held whole in memory. Errors never carry a URL or a credential.
 */

export const PATROL_EVIDENCE_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/webp'] as const;
export type PatrolEvidenceMimeType = (typeof PATROL_EVIDENCE_ALLOWED_TYPES)[number];
export const PATROL_EVIDENCE_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_BYTES_RANGE = [64 * 1024, 25 * 1024 * 1024] as const;
const TTL_RANGE = [60, 300] as const;
const REQUEST_TIMEOUT_MS = 60_000;

export type PatrolStorageConfig = {
  endpoint: URL;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string | null;
  urlTtlSeconds: number;
  maxObjectBytes: number;
  checksumHeader: boolean;
  signContentLength: boolean;
};

export type PatrolStorageConfigResult = { ok: true; config: PatrolStorageConfig } | { ok: false; reason: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Reads the configuration. Never throws and never reports a secret: { ok: false, reason } names only what is wrong. */
export function readPatrolStorageConfig(env: NodeJS.ProcessEnv = process.env): PatrolStorageConfigResult {
  const v = (name: string) => env[name]?.trim() || '';
  const endpointRaw = v('PATROL_EVIDENCE_STORAGE_ENDPOINT');
  const bucket = v('PATROL_EVIDENCE_STORAGE_BUCKET');
  const accessKeyId = v('PATROL_EVIDENCE_STORAGE_ACCESS_KEY_ID');
  const secretAccessKey = v('PATROL_EVIDENCE_STORAGE_SECRET_ACCESS_KEY');
  if (!endpointRaw && !bucket && !accessKeyId && !secretAccessKey) return { ok: false, reason: 'not configured' };
  const missing = [
    ['PATROL_EVIDENCE_STORAGE_ENDPOINT', endpointRaw], ['PATROL_EVIDENCE_STORAGE_BUCKET', bucket],
    ['PATROL_EVIDENCE_STORAGE_ACCESS_KEY_ID', accessKeyId], ['PATROL_EVIDENCE_STORAGE_SECRET_ACCESS_KEY', secretAccessKey],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) return { ok: false, reason: `missing ${missing.join(', ')}` };
  let endpoint: URL;
  try {
    endpoint = new URL(endpointRaw);
  } catch {
    return { ok: false, reason: 'PATROL_EVIDENCE_STORAGE_ENDPOINT is not a URL' };
  }
  if (endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    return { ok: false, reason: 'PATROL_EVIDENCE_STORAGE_ENDPOINT must be a plain origin (optionally with a path)' };
  }
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && LOCAL_HOSTS.has(endpoint.hostname))) {
    return { ok: false, reason: 'PATROL_EVIDENCE_STORAGE_ENDPOINT must use https' };
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return { ok: false, reason: 'PATROL_EVIDENCE_STORAGE_BUCKET is not a valid bucket name' };
  const region = v('PATROL_EVIDENCE_STORAGE_REGION') || 'auto';
  if (!/^[a-z0-9-]{1,32}$/.test(region)) return { ok: false, reason: 'PATROL_EVIDENCE_STORAGE_REGION is invalid' };
  const prefix = v('PATROL_EVIDENCE_STORAGE_PREFIX') || null;
  if (prefix && !PATROL_STORAGE_PREFIX_PATTERN.test(prefix)) return { ok: false, reason: 'PATROL_EVIDENCE_STORAGE_PREFIX must be [a-z0-9-]' };
  const urlTtlSeconds = Number(v('PATROL_EVIDENCE_URL_TTL_SECONDS') || '120');
  if (!Number.isInteger(urlTtlSeconds) || urlTtlSeconds < TTL_RANGE[0] || urlTtlSeconds > TTL_RANGE[1]) {
    return { ok: false, reason: 'PATROL_EVIDENCE_URL_TTL_SECONDS must be 60–300' };
  }
  const maxObjectBytes = Number(v('PATROL_EVIDENCE_MAX_BYTES') || String(PATROL_EVIDENCE_DEFAULT_MAX_BYTES));
  if (!Number.isInteger(maxObjectBytes) || maxObjectBytes < MAX_BYTES_RANGE[0] || maxObjectBytes > MAX_BYTES_RANGE[1]) {
    return { ok: false, reason: 'PATROL_EVIDENCE_MAX_BYTES must be 65536–26214400' };
  }
  return {
    ok: true,
    config: {
      endpoint, region, bucket, accessKeyId, secretAccessKey, prefix, urlTtlSeconds, maxObjectBytes,
      checksumHeader: v('PATROL_EVIDENCE_STORAGE_CHECKSUM_HEADER').toLowerCase() !== 'false',
      signContentLength: v('PATROL_EVIDENCE_STORAGE_SIGN_CONTENT_LENGTH').toLowerCase() !== 'false',
    },
  };
}

export type SignedObjectAccess = { method: 'GET' | 'PUT'; url: string; expiresAt: string; headers?: Record<string, string> };
export type ObjectHead = { exists: false } | { exists: true; size: number; contentType: string | null };

/** A storage failure. The message is safe to log: it never holds a URL, a signature or a credential. */
export class PatrolStorageError extends Error {
  constructor(readonly operation: string, readonly status: number | null, readonly code: string) {
    super(`patrol storage ${operation} failed (${status ?? 'network'} ${code})`);
  }
}

@Injectable()
export class PatrolObjectStore {
  private readonly logger = new Logger(PatrolObjectStore.name);
  private lastReported: string | null = null;

  /** Configuration as of now (re-read each call, so tests and a redeploy see changes; cheap). */
  status(): PatrolStorageConfigResult {
    const result = readPatrolStorageConfig();
    if (!result.ok && result.reason !== 'not configured' && result.reason !== this.lastReported) {
      this.lastReported = result.reason;
      this.logger.warn(JSON.stringify({ event: 'patrol_evidence_storage_misconfigured', reason: result.reason }));
    }
    return result;
  }

  available(): boolean {
    return this.status().ok;
  }

  /** The configuration, or 503 PATROL_EVIDENCE_STORAGE_UNAVAILABLE (the evidence feature fails closed). */
  config(): PatrolStorageConfig {
    const result = this.status();
    if (!result.ok) {
      throw patrolError(HttpStatus.SERVICE_UNAVAILABLE, PatrolErrorCode.EVIDENCE_STORAGE_UNAVAILABLE,
        'Patrol photo storage is not available. Photos stay on the device and can be sent later.');
    }
    return result.config;
  }

  private presign(config: PatrolStorageConfig, method: 'GET' | 'PUT' | 'HEAD' | 'DELETE', key: string,
    options: { headers?: Record<string, string>; query?: Record<string, string>; expiresSeconds?: number; now?: Date } = {}) {
    if (!isPatrolKey(key)) throw new PatrolStorageError('presign', null, 'invalid_key');
    if (config.prefix && !key.startsWith(`${config.prefix}/`)) throw new PatrolStorageError('presign', null, 'foreign_prefix');
    const now = options.now ?? new Date();
    const expiresSeconds = options.expiresSeconds ?? config.urlTtlSeconds;
    const canonicalUri = pathStyleUri(config.endpoint.pathname, config.bucket, key);
    const signed = presignV4({
      method, host: config.endpoint.host, canonicalUri, region: config.region, accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey, expiresSeconds, now, headers: options.headers, query: options.query,
    });
    return {
      url: `${config.endpoint.origin}${canonicalUri}?${signed.query}`,
      expiresAt: new Date(now.getTime() + expiresSeconds * 1000).toISOString(),
    };
  }

  /**
   * The Guard's upload URL. Signed headers make the storage refuse any other content type, any other length and (where
   * the provider checks x-amz-checksum-sha256, as S3, R2 and MinIO do) any other bytes than the declared SHA-256.
   */
  presignUpload(key: string, input: { contentType: string; sizeBytes: number; sha256Hex: string; now?: Date }): SignedObjectAccess {
    const config = this.config();
    const headers: Record<string, string> = { 'content-type': input.contentType };
    if (config.signContentLength) headers['content-length'] = String(input.sizeBytes);
    if (config.checksumHeader) headers['x-amz-checksum-sha256'] = Buffer.from(input.sha256Hex, 'hex').toString('base64');
    const { url, expiresAt } = this.presign(config, 'PUT', key, { headers, now: input.now });
    const out: Record<string, string> = { 'Content-Type': input.contentType };
    if (config.checksumHeader) out['x-amz-checksum-sha256'] = headers['x-amz-checksum-sha256'];
    // Content-Length is signed but set by the HTTP client from the body; the app must send exactly sizeBytes bytes.
    return { method: 'PUT', url, expiresAt, headers: out };
  }

  /** A viewer's download URL: exact object, short-lived, served as an attachment of the stored type. */
  presignDownload(key: string, input: { contentType: string; fileName: string; now?: Date }): SignedObjectAccess {
    const config = this.config();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(input.fileName)) throw new PatrolStorageError('presign', null, 'invalid_file_name');
    const { url, expiresAt } = this.presign(config, 'GET', key, {
      now: input.now,
      query: { 'response-content-type': input.contentType, 'response-content-disposition': `attachment; filename="${input.fileName}"` },
    });
    return { method: 'GET', url, expiresAt };
  }

  async head(key: string): Promise<ObjectHead> {
    const res = await this.request('HEAD', key);
    res.resume();
    if (res.statusCode === 404) return { exists: false };
    if (!ok(res.statusCode)) throw new PatrolStorageError('head', res.statusCode ?? null, 'unexpected_status');
    const size = Number(res.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 0) throw new PatrolStorageError('head', res.statusCode ?? null, 'no_length');
    return { exists: true, size, contentType: String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() || null };
  }

  /** The object's bytes as a stream (404 → PatrolStorageError code not_found). The caller must consume or destroy it. */
  async getStream(key: string): Promise<Readable> {
    const res = await this.request('GET', key);
    if (res.statusCode === 404) {
      res.resume();
      throw new PatrolStorageError('get', 404, 'not_found');
    }
    if (!ok(res.statusCode)) {
      res.resume();
      throw new PatrolStorageError('get', res.statusCode ?? null, 'unexpected_status');
    }
    return res;
  }

  /** Server-side copy (no bytes pass through this process). */
  async copy(sourceKey: string, targetKey: string): Promise<void> {
    if (!isPatrolKey(sourceKey)) throw new PatrolStorageError('copy', null, 'invalid_key');
    const config = this.config();
    const source = `/${config.bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`;
    const res = await this.request('PUT', targetKey, { headers: { 'x-amz-copy-source': source } });
    const body = await readSmall(res);
    if (res.statusCode === 404) throw new PatrolStorageError('copy', 404, 'not_found');
    // S3 can answer 200 with an <Error> body for a failed copy.
    if (!ok(res.statusCode) || /<Error>/.test(body)) throw new PatrolStorageError('copy', res.statusCode ?? null, 'copy_failed');
  }

  /** Idempotent: an object that is already gone is not an error. */
  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', key);
    res.resume();
    if (res.statusCode === 404) return;
    if (!ok(res.statusCode)) throw new PatrolStorageError('delete', res.statusCode ?? null, 'unexpected_status');
  }

  /** Uploads a local file (an export ZIP), streamed, with its length and SHA-256 signed. */
  async putFile(key: string, filePath: string, input: { sizeBytes: number; contentType: string; sha256Hex: string }): Promise<void> {
    const config = this.config();
    const headers: Record<string, string> = { 'content-type': input.contentType, 'content-length': String(input.sizeBytes) };
    if (config.checksumHeader) headers['x-amz-checksum-sha256'] = Buffer.from(input.sha256Hex, 'hex').toString('base64');
    const res = await this.request('PUT', key, { headers, body: createReadStream(filePath) });
    await readSmall(res);
    if (!ok(res.statusCode)) throw new PatrolStorageError('put', res.statusCode ?? null, 'unexpected_status');
  }

  private request(
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
    options: { headers?: Record<string, string>; body?: Readable } = {},
  ): Promise<http.IncomingMessage> {
    const config = this.config();
    const { url } = this.presign(config, method, key, { headers: options.headers, expiresSeconds: 300 });
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.request(target, { method, headers: options.headers ?? {}, timeout: REQUEST_TIMEOUT_MS }, resolve);
      req.on('timeout', () => req.destroy(new PatrolStorageError(method.toLowerCase(), null, 'timeout')));
      req.on('error', (error) => reject(error instanceof PatrolStorageError ? error : new PatrolStorageError(method.toLowerCase(), null, 'network')));
      if (options.body) {
        options.body.on('error', () => req.destroy(new PatrolStorageError(method.toLowerCase(), null, 'body_read')));
        options.body.pipe(req);
      } else {
        req.end();
      }
    });
  }
}

function ok(status: number | undefined): boolean {
  return status !== undefined && status >= 200 && status < 300;
}

async function readSmall(res: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  let text = '';
  for await (const chunk of res) {
    if (text.length < limit) text += chunk.toString('utf8');
  }
  return text;
}
