import { createHash, createHmac } from 'crypto';

/**
 * AWS Signature Version 4, query-string ("presigned") form, for S3-compatible object storage (Cloudflare R2, AWS S3,
 * MinIO). Pure: no clock, no environment, no I/O. The compliance / screening EvidenceStorageService keeps its own signer
 * unchanged; this one is Patrols' (P1-C) and is certified against the AWS documentation's published example
 * (scripts/patrol-evidence.spec.ts PE-S01) as well as against the in-process S3 test server.
 *
 * Every request Patrols makes to storage — the Guard's upload, a viewer's download, and the server's own HEAD / GET /
 * COPY / PUT / DELETE — is a presigned request with an UNSIGNED-PAYLOAD body hash. Headers named in `headers` are SIGNED:
 * the request must send exactly those values or the storage refuses it (Content-Type, x-amz-checksum-sha256,
 * Content-Length on an upload; x-amz-copy-source on a copy).
 *
 * A presigned URL is a bearer credential for its lifetime: it is returned to the caller who is allowed to use it and is
 * never logged, audited or stored.
 */

export const SIGV4_MAX_EXPIRES_SECONDS = 604_800; // 7 days: the S3 / R2 maximum

export type PresignRequest = {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** Host header value (host[:port]) and the already-encoded canonical URI ("/bucket/key" path-style). */
  host: string;
  canonicalUri: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now: Date;
  /** Headers to sign (names are lower-cased); host is always signed. */
  headers?: Record<string, string>;
  /** Extra query parameters to sign (e.g. response-content-type). */
  query?: Record<string, string>;
};

export type Presigned = { query: string; signedHeaders: string[]; amzDate: string };

/** RFC 3986 encoding as SigV4 needs it (encodeURIComponent plus !'()*). */
export function sigv4Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Path-style canonical URI: the endpoint's own path prefix, the bucket, then each key segment encoded. */
export function pathStyleUri(endpointPath: string, bucket: string, key: string): string {
  const prefix = endpointPath.replace(/\/+$/, '');
  return `${prefix}/${sigv4Encode(bucket)}/${key.split('/').map(sigv4Encode).join('/')}`;
}

const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();

export function amzDateOf(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export function presignV4(input: PresignRequest): Presigned {
  if (!Number.isInteger(input.expiresSeconds) || input.expiresSeconds < 1 || input.expiresSeconds > SIGV4_MAX_EXPIRES_SECONDS) {
    throw new Error('SigV4 presign lifetime out of range');
  }
  const amzDate = amzDateOf(input.now);
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: input.host };
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = String(value);
  const headerNames = Object.keys(headers).sort();
  const query: Record<string, string> = {
    ...(input.query ?? {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresSeconds),
    'X-Amz-SignedHeaders': headerNames.join(';'),
  };
  const canonicalQuery = Object.entries(query)
    .map(([k, v]) => [sigv4Encode(k), sigv4Encode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonicalRequest = [input.method, input.canonicalUri, canonicalQuery, canonicalHeaders, headerNames.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return { query: `${canonicalQuery}&X-Amz-Signature=${signature}`, signedHeaders: headerNames, amzDate };
}
