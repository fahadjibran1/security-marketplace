type RawEnv = Record<string, unknown>;
import { buildDatabaseSslOptions } from '../database/database-tls.config';

const DEFAULT_JWT_SECRET = 'super-secret-change-me';

function toTrimmedString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseBoolean(value: unknown, fallback: boolean) {
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return normalized === 'true';
}

function hasProductionDatabaseConfig(config: RawEnv) {
  const connectionUrl =
    toTrimmedString(config.DATABASE_POOLER_URL) || toTrimmedString(config.DATABASE_URL);

  if (connectionUrl) {
    return true;
  }

  return [
    config.DATABASE_HOST,
    config.DATABASE_PORT,
    config.DATABASE_USER,
    config.DATABASE_PASSWORD,
    config.DATABASE_NAME,
  ].every((value) => Boolean(toTrimmedString(value)));
}

function validateProductionEvidenceStorage(config: RawEnv) {
  const required = [
    'EVIDENCE_STORAGE_ENDPOINT',
    'EVIDENCE_STORAGE_REGION',
    'EVIDENCE_STORAGE_BUCKET',
    'EVIDENCE_STORAGE_ACCESS_KEY_ID',
    'EVIDENCE_STORAGE_SECRET_ACCESS_KEY',
  ];
  if (required.some((key) => !toTrimmedString(config[key]))) {
    throw new Error('Private evidence storage configuration is required in production.');
  }
  const endpoint = new URL(toTrimmedString(config.EVIDENCE_STORAGE_ENDPOINT));
  if (endpoint.protocol !== 'https:') {
    throw new Error('EVIDENCE_STORAGE_ENDPOINT must use HTTPS in production.');
  }
  const ttl = Number(toTrimmedString(config.EVIDENCE_SIGNED_URL_TTL_SECONDS) || '180');
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 300) {
    throw new Error('EVIDENCE_SIGNED_URL_TTL_SECONDS must be between 60 and 300.');
  }
}

export function validateRuntimeEnv(config: RawEnv) {
  const nodeEnv = toTrimmedString(config.NODE_ENV) || 'development';
  const corsOrigin = toTrimmedString(config.CORS_ORIGIN);
  const jwtSecret = toTrimmedString(config.JWT_SECRET);
  const databaseSynchronize = parseBoolean(
    config.DATABASE_SYNCHRONIZE,
    nodeEnv === 'production' ? false : true,
  );

  if (nodeEnv === 'production') {
    if (!jwtSecret || jwtSecret === DEFAULT_JWT_SECRET || jwtSecret.length < 32) {
      throw new Error('JWT_SECRET must be set to a strong unique value in production (minimum 32 characters).');
    }

    if (!corsOrigin || corsOrigin === '*') {
      throw new Error('CORS_ORIGIN must be explicitly set in production and cannot be "*".');
    }

    if (databaseSynchronize) {
      throw new Error('DATABASE_SYNCHRONIZE must be false in production.');
    }

    if (!hasProductionDatabaseConfig(config)) {
      throw new Error(
        'Production database configuration is required. Set DATABASE_POOLER_URL or DATABASE_URL, or provide all split DATABASE_* connection values.',
      );
    }

    buildDatabaseSslOptions({
      NODE_ENV: nodeEnv,
      DATABASE_SSL: toTrimmedString(config.DATABASE_SSL),
      DATABASE_CA_CERT: toTrimmedString(config.DATABASE_CA_CERT),
    });
    validateProductionEvidenceStorage(config);
  }

  return config;
}

export function getJwtSecret(env: NodeJS.ProcessEnv) {
  return env.JWT_SECRET?.trim() || DEFAULT_JWT_SECRET;
}

export function getCorsOrigins(env: NodeJS.ProcessEnv) {
  const configured = env.CORS_ORIGIN?.trim();
  if (!configured || configured === '*') {
    return true;
  }

  return configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function getTrustProxySetting(env: NodeJS.ProcessEnv) {
  const configured = env.TRUST_PROXY?.trim();
  if (!configured) {
    return env.NODE_ENV === 'production' ? 1 : false;
  }

  if (configured === 'true') {
    return true;
  }

  if (configured === 'false') {
    return false;
  }

  const numericValue = Number(configured);
  return Number.isInteger(numericValue) ? numericValue : configured;
}

export function isSwaggerEnabled(env: NodeJS.ProcessEnv) {
  return parseBoolean(env.ENABLE_SWAGGER, env.NODE_ENV !== 'production');
}
