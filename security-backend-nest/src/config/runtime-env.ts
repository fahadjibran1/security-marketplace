type RawEnv = Record<string, unknown>;

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

export function validateRuntimeEnv(config: RawEnv) {
  const nodeEnv = toTrimmedString(config.NODE_ENV) || 'development';
  const corsOrigin = toTrimmedString(config.CORS_ORIGIN);
  const jwtSecret = toTrimmedString(config.JWT_SECRET);
  const databaseSynchronize = parseBoolean(
    config.DATABASE_SYNCHRONIZE,
    nodeEnv === 'production' ? false : true,
  );

  if (nodeEnv === 'production') {
    if (!jwtSecret || jwtSecret === DEFAULT_JWT_SECRET) {
      throw new Error('JWT_SECRET must be set to a strong unique value in production.');
    }

    if (!corsOrigin || corsOrigin === '*') {
      throw new Error('CORS_ORIGIN must be explicitly set in production and cannot be "*".');
    }

    if (databaseSynchronize) {
      throw new Error('DATABASE_SYNCHRONIZE must be false in production.');
    }
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
    return env.NODE_ENV === 'production';
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
  return parseBoolean(env.ENABLE_SWAGGER, true);
}
