import { strict as assert } from 'assert';
import { buildDatabaseSslOptions, normalizeDatabaseCaCertificate } from '../src/database/database-tls.config';
import { buildTypeOrmOptions } from '../src/database/typeorm.config';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { buildPreflightClientOptions } from './release-data-preflight';

const escapedCa = '-----BEGIN CERTIFICATE-----\\nVEVTVA==\\n-----END CERTIFICATE-----';
const normalizedCa = '-----BEGIN CERTIFICATE-----\nVEVTVA==\n-----END CERTIFICATE-----';

function expectSafeFailure(run: () => unknown) {
  let message = '';
  try {
    run();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(message, 'configuration must fail');
  assert.ok(!message.includes('VEVTVA=='), 'error must not expose certificate material');
}

function main() {
  const production = buildDatabaseSslOptions({
    NODE_ENV: 'production', DATABASE_SSL: 'true', DATABASE_CA_CERT: escapedCa,
  });
  assert.notEqual(production, false);
  assert.equal(production && production.rejectUnauthorized, true, 'production must verify the server');
  assert.deepEqual(production, { rejectUnauthorized: true, ca: normalizedCa }, 'production must supply the CA');
  expectSafeFailure(() => buildDatabaseSslOptions({ NODE_ENV: 'production', DATABASE_SSL: 'true' }));
  expectSafeFailure(() => buildDatabaseSslOptions({ NODE_ENV: 'production', DATABASE_SSL: 'true', DATABASE_CA_CERT: '  ' }));
  expectSafeFailure(() => buildDatabaseSslOptions({ NODE_ENV: 'production', DATABASE_SSL: 'true', DATABASE_CA_CERT: 'not a certificate VEVTVA==' }));
  assert.equal(buildDatabaseSslOptions({ NODE_ENV: 'test' }), false, 'test PostgreSQL must work without TLS');
  assert.equal(normalizeDatabaseCaCertificate(escapedCa), normalizedCa, 'escaped newlines must be normalized');

  const migrationOptions = buildTypeOrmOptions({
    NODE_ENV: 'production', DATABASE_SSL: 'true', DATABASE_CA_CERT: escapedCa,
    DATABASE_URL: 'postgresql://example.invalid/database', DATABASE_SYNCHRONIZE: 'false',
  });
  assert.deepEqual((migrationOptions as PostgresConnectionOptions).ssl, production, 'runtime and migration configuration must share TLS policy');
  const preflightOptions = buildPreflightClientOptions({
    NODE_ENV: 'production', DATABASE_SSL: 'true', DATABASE_CA_CERT: escapedCa,
    DATABASE_URL: 'postgresql://example.invalid/database',
  });
  assert.deepEqual(preflightOptions.ssl, production, 'preflight must share the production TLS policy');
  console.log(JSON.stringify({ event: 'database_tls_tests_passed', tests: 8 }));
}

main();
