/**
 * Test-database guard regression (SEC-001B 2A).
 *
 * Proves that the database specs which used to fall back to an implicit local database now fail closed:
 *   MISSING     with no database variable set, each of the seven formerly-defaulting specs exits non-zero with the
 *               guard's refusal, and NO network connection is attempted (a preloaded probe records every socket
 *               connect; a positive control proves the probe sees one) — so nothing can be written anywhere.
 *   URL         the URL rules: loopback only, never another project's port (Supabase 54320-54329, pooler 6543), the
 *               default 5432 only in CI, an s4_ database whose name does not look live, postgresql:// only.
 *   PREFLIGHT   the server rules, with an injected query function (no server needed): current_database() must match,
 *               no Supabase roles, no non-S4 databases on the server.
 *
 * Needs no database. Run: npm run test:test-database-guard
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  QueryFn,
  UnsafeTestDatabaseError,
  assertDisposableTestDatabase,
  assertDisposableTestDatabaseUrl,
  requireDisposableTestDatabaseUrl,
} from './test-database-guard';

const failures: string[] = [];
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function refuses(fn: () => unknown, pattern: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err instanceof UnsafeTestDatabaseError, `expected UnsafeTestDatabaseError, got ${String(err)}`);
    expect(pattern.test(err.message), `refusal "${err.message}" does not match ${pattern}`);
    return;
  }
  throw new Error('expected a refusal, but the URL was accepted');
}
async function refusesAsync(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (err) {
    expect(err instanceof UnsafeTestDatabaseError, `expected UnsafeTestDatabaseError, got ${String(err)}`);
    expect(pattern.test(err.message), `refusal "${err.message}" does not match ${pattern}`);
    return;
  }
  throw new Error('expected a refusal, but the server was accepted');
}

const LOCAL = 'postgresql://s4:pw@127.0.0.1:55441/s4_release_gate';
const CI_URL = 'postgresql://s4:pw@localhost:5432/s4_release_gate';
const LOCAL_ENV = {};
const CI_ENV = { GITHUB_ACTIONS: 'true' };

// ── MISSING: the real specs, run with no database variable, under a network probe ─────────────────────────────────
const backendRoot = resolve(__dirname, '..');
const probeDir = mkdtempSync(join(tmpdir(), 's4-db-guard-'));
const probe = join(probeDir, 'net-probe.js');
writeFileSync(
  probe,
  [
    "const net = require('net');",
    'const original = net.Socket.prototype.connect;',
    'net.Socket.prototype.connect = function (...args) {',
    "  process.stderr.write('\\nNET-PROBE: connection attempted\\n');",
    "  throw new Error('net-probe: connections are not allowed in this test');",
    '};',
    'void original;',
  ].join('\n'),
);

const DB_VARIABLES = ['ROTA_SLOT_TEST_DB_URL', 'APP_BOOT_DATABASE_URL', 'P1I_DATABASE_URL', 'DATABASE_URL', 'DATABASE_POOLER_URL'];
function runWithoutDatabase(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' };
  for (const name of DB_VARIABLES) delete env[name];
  const result = spawnSync(
    process.execPath,
    ['-r', probe, '-r', 'ts-node/register', '-r', 'tsconfig-paths/register', ...args],
    { cwd: backendRoot, env, encoding: 'utf8', timeout: 180_000 },
  );
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const FORMERLY_DEFAULTING_SPECS: Array<[string, string]> = [
  ['scripts/company-guard-lifecycle.spec.ts', 'ROTA_SLOT_TEST_DB_URL'],
  ['scripts/rota-assignment-concurrency.spec.ts', 'ROTA_SLOT_TEST_DB_URL'],
  ['scripts/rota-slot-api.spec.ts', 'ROTA_SLOT_TEST_DB_URL'],
  ['scripts/rota-slot-service.spec.ts', 'ROTA_SLOT_TEST_DB_URL'],
  ['scripts/scheduling-safety.spec.ts', 'ROTA_SLOT_TEST_DB_URL'],
  ['scripts/shift-offer-lifecycle.spec.ts', 'ROTA_SLOT_TEST_DB_URL'],
  ['scripts/app-boot.spec.ts', 'APP_BOOT_DATABASE_URL'],
];

async function main() {
  console.log('\n── Test-database guard ──');

  console.log('MISSING');
  await check('positive control: the network probe detects a connection attempt', () => {
    const { output } = runWithoutDatabase([
      '-e',
      "new (require('pg').Client)({ connectionString: 'postgresql://x:y@127.0.0.1:9/s4_probe' }).connect().catch(() => process.exit(3));",
    ]);
    expect(output.includes('NET-PROBE: connection attempted'), 'the probe did not see the control connection');
  });
  for (const [spec, variable] of FORMERLY_DEFAULTING_SPECS) {
    await check(`${spec} with no ${variable}: refuses before any connection`, () => {
      const { status, output } = runWithoutDatabase([spec]);
      expect(status !== 0, `exited ${status}; expected a failure`);
      expect(output.includes(`${variable} is not set`), `no guard refusal in output:\n${output.slice(-800)}`);
      expect(!output.includes('NET-PROBE'), 'a network connection was attempted');
      expect(!/54322|s4_migration_rehearsal|p1i_membership_test/.test(output), 'output still mentions the old fallback');
    });
  }
  await check('requireDisposableTestDatabaseUrl: unset, empty and blank variables are refused', () => {
    refuses(() => requireDisposableTestDatabaseUrl('X_DB', {}), /X_DB is not set/);
    refuses(() => requireDisposableTestDatabaseUrl('X_DB', { X_DB: '' }), /X_DB is not set/);
    refuses(() => requireDisposableTestDatabaseUrl('X_DB', { X_DB: '   ' }), /X_DB is not set/);
    refuses(() => requireDisposableTestDatabaseUrl(['A_DB', 'B_DB'], {}), /A_DB or B_DB is not set/);
  });
  await check('refusals never echo credentials', () => {
    try {
      requireDisposableTestDatabaseUrl('X_DB', { X_DB: 'postgresql://postgres:supersecret@127.0.0.1:54322/postgres' });
    } catch (err) {
      expect(!String(err).includes('supersecret'), 'the password appeared in the refusal');
      return;
    }
    throw new Error('expected a refusal');
  });

  console.log('URL');
  await check('the former fallback URLs are refused (Supabase default port 54322)', () => {
    refuses(() => assertDisposableTestDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:54322/s4_migration_rehearsal', 'U', LOCAL_ENV), /port 54322/);
    refuses(() => assertDisposableTestDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:54322/p1i_membership_test', 'U', CI_ENV), /port 54322/);
  });
  await check('other local-stack and pooler ports are refused', () => {
    for (const port of [54320, 54321, 54323, 54329, 6543]) {
      refuses(() => assertDisposableTestDatabaseUrl(`postgresql://s4:pw@127.0.0.1:${port}/s4_x`, 'U', CI_ENV), new RegExp(`port ${port}`));
    }
  });
  await check('non-loopback hosts are refused (remote, staging, production, pooler)', () => {
    for (const host of ['db.example.com', 'staging-db.internal', 'aws-0-eu-west-2.pooler.supabase.com', '10.0.0.5', '0.0.0.0']) {
      refuses(() => assertDisposableTestDatabaseUrl(`postgresql://s4:pw@${host}:55441/s4_x`, 'U', CI_ENV), /loopback/);
    }
  });
  await check('port 5432 is refused outside CI and accepted in CI', () => {
    refuses(() => assertDisposableTestDatabaseUrl(CI_URL, 'U', LOCAL_ENV), /port 5432/);
    refuses(() => assertDisposableTestDatabaseUrl('postgresql://s4:pw@localhost/s4_release_gate', 'U', LOCAL_ENV), /port 5432/);
    assertDisposableTestDatabaseUrl(CI_URL, 'U', CI_ENV);
  });
  await check('database names: s4_ only, never live-looking', () => {
    for (const name of ['postgres', 'p1i_membership_test', 'security_mvp', 'S4_upper', 's4-dash', '']) {
      refuses(() => assertDisposableTestDatabaseUrl(`postgresql://s4:pw@127.0.0.1:55441/${name}`, 'U', LOCAL_ENV), /s4_ test database/);
    }
    for (const name of ['s4_prod', 's4_production', 's4_staging', 's4_stage', 's4_prod_copy', 's4_x_staging']) {
      refuses(() => assertDisposableTestDatabaseUrl(`postgresql://s4:pw@127.0.0.1:55441/${name}`, 'U', LOCAL_ENV), /production or staging/);
    }
  });
  await check('non-postgres URLs are refused', () => {
    refuses(() => assertDisposableTestDatabaseUrl('mysql://s4:pw@127.0.0.1:55441/s4_x', 'U', LOCAL_ENV), /postgresql:\/\//);
    refuses(() => assertDisposableTestDatabaseUrl('not a url', 'U', LOCAL_ENV), /not a valid/);
  });
  await check('the approved shapes are accepted (local disposable container; CI service container)', () => {
    equal(requireDisposableTestDatabaseUrl('X_DB', { X_DB: LOCAL }), LOCAL);
    equal(requireDisposableTestDatabaseUrl('X_DB', { X_DB: CI_URL, GITHUB_ACTIONS: 'true' }), CI_URL);
    assertDisposableTestDatabaseUrl('postgresql://s4:pw@[::1]:55441/s4_live_ops_correctness', 'U', LOCAL_ENV);
    assertDisposableTestDatabaseUrl('postgres://s4:pw@localhost:55441/s4_former_employer_gate', 'U', LOCAL_ENV);
  });

  console.log('PREFLIGHT');
  const server = (opts: { current?: string; roles?: string[]; databases?: string[] }): QueryFn => async (sql) => {
    if (sql.includes('current_database()')) return [{ current: opts.current ?? 's4_release_gate' }];
    if (sql.includes('pg_roles')) return (opts.roles ?? []).map((rolname) => ({ rolname }));
    if (sql.includes('pg_database')) return (opts.databases ?? []).map((datname) => ({ datname }));
    throw new Error(`unexpected query: ${sql}`);
  };
  await check('a disposable S4-only server is accepted', async () => {
    await assertDisposableTestDatabase(LOCAL, server({}), LOCAL_ENV);
  });
  await check('a Supabase server is refused even with an s4_ database name', async () => {
    await refusesAsync(assertDisposableTestDatabase(LOCAL, server({ roles: ['supabase_admin', 'authenticator'] }), LOCAL_ENV), /Supabase roles/);
  });
  await check('a server holding another project\'s databases is refused', async () => {
    await refusesAsync(assertDisposableTestDatabase(LOCAL, server({ databases: ['other_project_db'] }), LOCAL_ENV), /non-S4 database/);
  });
  await check('a connection that lands on a different database is refused', async () => {
    await refusesAsync(assertDisposableTestDatabase(LOCAL, server({ current: 'postgres' }), LOCAL_ENV), /connected to "postgres"/);
  });
  await check('the preflight validates the URL before querying anything', async () => {
    let queried = false;
    const spy: QueryFn = async () => { queried = true; return []; };
    await refusesAsync(assertDisposableTestDatabase('postgresql://p:p@127.0.0.1:54322/s4_x', spy, LOCAL_ENV), /port 54322/);
    expect(!queried, 'the server was queried before the URL was validated');
  });

  console.log(`\nTest-database guard: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
  console.log(JSON.stringify({ event: 'test_database_guard_passed', tests: passed }));
}

function equal(actual: unknown, expected: unknown) {
  expect(actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
