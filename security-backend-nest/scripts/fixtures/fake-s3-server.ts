/**
 * An in-process, S3-compatible test server for the patrol evidence specs (Patrols P1-C). It is NOT a mock of the
 * product's client: it verifies every request the way S3 / R2 / MinIO do, with its OWN SigV4 implementation written from
 * the AWS specification (it does not import src/patrol/evidence/sigv4.ts), so a signing bug on either side fails the test.
 *
 * Verified per request (query-string / presigned auth only; anything else is refused 403):
 *   - path-style /{bucket}/{key}; the bucket must be the configured one
 *   - X-Amz-Algorithm, X-Amz-Credential ({accessKey}/{date}/{region}/s3/aws4_request), X-Amz-Date, X-Amz-Expires (≤ 7 days),
 *     X-Amz-SignedHeaders (must include host and every x-amz-* header the request carries), X-Amz-Signature
 *   - expiry against the server's clock (settable), and a date not in the future (15 min skew)
 *   - the signature over the canonical request built from the request AS RECEIVED (signed header values included)
 *   - x-amz-checksum-sha256 on PUT: the body must hash to it (400 BadDigest), as S3 / R2 / MinIO check it
 * Operations: PUT (object, or CopyObject with x-amz-copy-source), GET (with response-content-type / -disposition
 * overrides), HEAD, DELETE (idempotent 204). Failures can be injected per method / key prefix, and an async hook can
 * observe each request before it is served (the specs use it to check the database state at the moment of a DELETE).
 * The request log records method, key and status — never a URL or signature.
 */
import { createHash, createHmac } from 'node:crypto';
import * as http from 'node:http';

export type FakeObject = { body: Buffer; contentType: string };
export type FakeRequestLog = { method: string; key: string; status: number; copySource?: string };
export type FakeFailure = { method: string; keyPrefix?: string; status: number; times: number };

export type FakeS3 = {
  url: string;
  bucket: string;
  objects: Map<string, FakeObject>;
  log: FakeRequestLog[];
  failures: FakeFailure[];
  setNow: (now: Date | null) => void;
  onRequest: ((method: string, key: string) => Promise<void> | void) | null;
  keys: (prefix?: string) => string[];
  stop: () => Promise<void>;
};

const enc = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();

function parseAmzDate(value: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

export async function startFakeS3(opts: { accessKeyId: string; secretAccessKey: string; bucket: string; region: string }): Promise<FakeS3> {
  const objects = new Map<string, FakeObject>();
  const log: FakeRequestLog[] = [];
  const failures: FakeFailure[] = [];
  let clock: Date | null = null;
  const state: { onRequest: FakeS3['onRequest'] } = { onRequest: null };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void handle(req, Buffer.concat(chunks), res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });

  const reply = (res: http.ServerResponse, method: string, key: string, status: number, body = '', headers: Record<string, string> = {}, extra: Partial<FakeRequestLog> = {}) => {
    log.push({ method, key, status, ...extra });
    res.writeHead(status, headers);
    res.end(method === 'HEAD' ? undefined : body);
  };

  async function handle(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) {
    const method = req.method ?? 'GET';
    const raw = req.url ?? '/';
    const [rawPath, rawQuery = ''] = raw.split('?');
    const segments = rawPath.split('/').slice(1);
    const bucket = decodeURIComponent(segments[0] ?? '');
    const key = segments.slice(1).map(decodeURIComponent).join('/');
    if (bucket !== opts.bucket || !key) return reply(res, method, key, 403, '<Error><Code>AccessDenied</Code></Error>');

    // ── SigV4 (query) verification ──
    const params: Array<[string, string]> = rawQuery
      ? rawQuery.split('&').filter(Boolean).map((p) => {
        const i = p.indexOf('=');
        return [decodeURIComponent(i < 0 ? p : p.slice(0, i)), decodeURIComponent(i < 0 ? '' : p.slice(i + 1))] as [string, string];
      })
      : [];
    const q = new Map(params);
    const deny = (code: string) => reply(res, method, key, 403, `<Error><Code>${code}</Code></Error>`);
    if (q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || !q.get('X-Amz-Signature')) return deny('AccessDenied');
    const amzDate = q.get('X-Amz-Date') ?? '';
    const at = parseAmzDate(amzDate);
    const expires = Number(q.get('X-Amz-Expires'));
    const [ak, date, region, service, terminator] = (q.get('X-Amz-Credential') ?? '').split('/');
    if (!at || ak !== opts.accessKeyId || date !== amzDate.slice(0, 8) || region !== opts.region || service !== 's3' || terminator !== 'aws4_request') {
      return deny('InvalidAccessKeyId');
    }
    if (!Number.isInteger(expires) || expires < 1 || expires > 604_800) return deny('AuthorizationQueryParametersError');
    const now = clock ?? new Date();
    if (now.getTime() > at.getTime() + expires * 1000) return deny('AccessDenied'); // "Request has expired"
    if (at.getTime() > now.getTime() + 15 * 60 * 1000) return deny('RequestTimeTooSkewed');
    const signedHeaders = (q.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean);
    if (!signedHeaders.includes('host')) return deny('AccessDenied');
    for (const name of Object.keys(req.headers)) {
      if (name.startsWith('x-amz-') && !signedHeaders.includes(name)) return deny('AccessDenied'); // unsigned x-amz-* header
    }
    const canonicalQuery = params
      .filter(([k]) => k !== 'X-Amz-Signature')
      .map(([k, v]) => [enc(k), enc(v)] as const)
      .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const headerValue = (name: string) => {
      const v = req.headers[name];
      return (Array.isArray(v) ? v.join(',') : v ?? '').trim().replace(/\s+/g, ' ');
    };
    const canonicalHeaders = signedHeaders.map((n) => `${n}:${headerValue(n)}\n`).join('');
    const canonicalRequest = [method, rawPath, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, date), region), 's3'), 'aws4_request');
    if (createHmac('sha256', kSigning).update(stringToSign).digest('hex') !== q.get('X-Amz-Signature')) return deny('SignatureDoesNotMatch');

    if (state.onRequest) await state.onRequest(method, key);
    const failure = failures.find((f) => f.times > 0 && f.method === method && (!f.keyPrefix || key.startsWith(f.keyPrefix)));
    if (failure) {
      failure.times -= 1;
      return reply(res, method, key, failure.status, '<Error><Code>InternalError</Code></Error>');
    }

    if (method === 'PUT') {
      const copySource = req.headers['x-amz-copy-source'];
      if (typeof copySource === 'string') {
        const sourcePath = decodeURIComponent(copySource.split('?')[0]).replace(/^\//, '');
        const sourceBucket = sourcePath.split('/')[0];
        const sourceKey = sourcePath.split('/').slice(1).join('/');
        const source = sourceBucket === opts.bucket ? objects.get(sourceKey) : undefined;
        if (!source) return reply(res, method, key, 404, '<Error><Code>NoSuchKey</Code></Error>', {}, { copySource: sourceKey });
        objects.set(key, { body: Buffer.from(source.body), contentType: source.contentType });
        return reply(res, method, key, 200, '<CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>', { 'content-type': 'application/xml' }, { copySource: sourceKey });
      }
      const checksum = req.headers['x-amz-checksum-sha256'];
      if (typeof checksum === 'string' && createHash('sha256').update(body).digest('base64') !== checksum) {
        return reply(res, method, key, 400, '<Error><Code>BadDigest</Code></Error>');
      }
      objects.set(key, { body, contentType: String(req.headers['content-type'] ?? 'application/octet-stream') });
      return reply(res, method, key, 200, '', { etag: `"${createHash('md5').update(body).digest('hex')}"` });
    }
    if (method === 'GET' || method === 'HEAD') {
      const object = objects.get(key);
      if (!object) return reply(res, method, key, 404, '<Error><Code>NoSuchKey</Code></Error>');
      const headers: Record<string, string> = {
        'content-type': q.get('response-content-type') ?? object.contentType,
        'content-length': String(object.body.length),
      };
      const disposition = q.get('response-content-disposition');
      if (disposition) headers['content-disposition'] = disposition;
      log.push({ method, key, status: 200 });
      res.writeHead(200, headers);
      res.end(method === 'HEAD' ? undefined : object.body);
      return;
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return reply(res, method, key, 204);
    }
    return reply(res, method, key, 405);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake S3 did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    bucket: opts.bucket,
    objects,
    log,
    failures,
    setNow: (now) => {
      clock = now;
    },
    get onRequest() {
      return state.onRequest;
    },
    set onRequest(fn) {
      state.onRequest = fn;
    },
    keys: (prefix = '') => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
