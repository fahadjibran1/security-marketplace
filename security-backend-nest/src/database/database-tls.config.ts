export type DatabaseTlsEnv = {
  NODE_ENV?: string;
  DATABASE_SSL?: string;
  DATABASE_CA_CERT?: string;
};

export type DatabaseSslOptions = false | {
  rejectUnauthorized: true;
  ca: string;
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized === 'true' : fallback;
}

export function normalizeDatabaseCaCertificate(value: string | undefined): string {
  return value?.trim().replace(/\\n/g, '\n') ?? '';
}

function isPemCertificate(value: string): boolean {
  return /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----$/.test(value);
}

export function buildDatabaseSslOptions(env: DatabaseTlsEnv): DatabaseSslOptions {
  const production = env.NODE_ENV?.trim() === 'production';
  const sslEnabled = parseBoolean(env.DATABASE_SSL, production);

  if (!sslEnabled) {
    if (production) {
      throw new Error('Production database TLS must be enabled.');
    }
    return false;
  }

  const ca = normalizeDatabaseCaCertificate(env.DATABASE_CA_CERT);
  if (!isPemCertificate(ca)) {
    throw new Error('A valid DATABASE_CA_CERT PEM certificate is required when database TLS is enabled.');
  }

  return { rejectUnauthorized: true, ca };
}
