import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, createHash } from 'crypto';

export type SignedEvidenceAccess = {
  url: string;
  expiresAt: string;
  method: 'GET' | 'PUT';
  headers?: Record<string, string>;
};

export type EvidenceObject = {
  key: string;
  mimeType: string;
  originalFileName: string;
};

export abstract class EvidenceStorageService {
  abstract readonly provider: string;
  abstract createSignedUploadUrl(object: EvidenceObject): Promise<SignedEvidenceAccess>;
  abstract createSignedDownloadUrl(object: EvidenceObject): Promise<SignedEvidenceAccess>;
  abstract verifyUpload(object: EvidenceObject, expectedSizeBytes: number): Promise<void>;
}

type StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
};

function encode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key: Buffer | string, value: string) {
  return createHmac('sha256', key).update(value).digest();
}

@Injectable()
export class S3CompatibleEvidenceStorageService extends EvidenceStorageService {
  readonly provider = 's3-compatible';

  private config(): StorageConfig {
    const expiresSeconds = Number(process.env.EVIDENCE_SIGNED_URL_TTL_SECONDS || '180');
    const config = {
      endpoint: process.env.EVIDENCE_STORAGE_ENDPOINT?.trim() || '',
      region: process.env.EVIDENCE_STORAGE_REGION?.trim() || '',
      bucket: process.env.EVIDENCE_STORAGE_BUCKET?.trim() || '',
      accessKeyId: process.env.EVIDENCE_STORAGE_ACCESS_KEY_ID?.trim() || '',
      secretAccessKey: process.env.EVIDENCE_STORAGE_SECRET_ACCESS_KEY?.trim() || '',
      expiresSeconds,
    };
    if (!config.endpoint || !config.region || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      throw new ServiceUnavailableException('Private evidence storage is not configured.');
    }
    if (!Number.isInteger(expiresSeconds) || expiresSeconds < 60 || expiresSeconds > 300) {
      throw new ServiceUnavailableException('Evidence signed URL lifetime must be between 60 and 300 seconds.');
    }
    return config;
  }

  createSignedUploadUrl(object: EvidenceObject) {
    return Promise.resolve(this.sign('PUT', object, { 'content-type': object.mimeType }));
  }

  createSignedDownloadUrl(object: EvidenceObject) {
    return Promise.resolve(this.sign('GET', object));
  }

  async verifyUpload(object: EvidenceObject, expectedSizeBytes: number) {
    const access = this.sign('HEAD', object);
    const response = await fetch(access.url, { method: 'HEAD' });
    if (!response.ok) throw new BadRequestException('Private evidence upload is not available.');
    const size = Number(response.headers.get('content-length'));
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (size !== expectedSizeBytes || mimeType !== object.mimeType) {
      throw new BadRequestException('Uploaded evidence metadata does not match the authorized file.');
    }
  }

  private sign(method: 'GET' | 'PUT' | 'HEAD', object: EvidenceObject, signedHeaders: Record<string, string> = {}): SignedEvidenceAccess {
    if (!/^(?:compliance\/(?:company\/\d+|guard)\/\d+|screening\/guard\/\d+)\/[0-9a-f-]{36}$/.test(object.key)) {
      throw new BadRequestException('Invalid evidence object key.');
    }
    const config = this.config();
    const endpoint = new URL(config.endpoint);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const scope = `${date}/${config.region}/s3/aws4_request`;
    const pathPrefix = endpoint.pathname.replace(/\/$/, '');
    const canonicalUri = `${pathPrefix}/${encode(config.bucket)}/${object.key.split('/').map(encode).join('/')}`;
    const headers: Record<string, string> = { ...signedHeaders, host: endpoint.host };
    const headerNames = Object.keys(headers).sort();
    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(config.expiresSeconds),
      'X-Amz-SignedHeaders': headerNames.join(';'),
    };
    const canonicalQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
    const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name].trim()}\n`).join('');
    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${headerNames.join(';')}\nUNSIGNED-PAYLOAD`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, date), config.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const url = `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    return {
      url,
      method: method === 'HEAD' ? 'GET' : method,
      expiresAt: new Date(now.getTime() + config.expiresSeconds * 1000).toISOString(),
      ...(method === 'PUT' ? { headers: { 'Content-Type': object.mimeType } } : {}),
    };
  }
}
