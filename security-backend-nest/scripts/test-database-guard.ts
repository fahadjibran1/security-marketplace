/**
 * Test-database guard (SEC-001B 2A).
 *
 * Several specs used to fall back to a hard-coded URL (127.0.0.1:54322/...) when their database variable was unset.
 * That port is the default for local Supabase stacks, which may belong to other projects, so a spec must never pick a
 * database implicitly. These helpers make every such spec fail closed:
 *
 *   requireDisposableTestDatabaseUrl  synchronous, at module load, BEFORE anything can connect:
 *                                     the variable must be set explicitly (no default), and the URL must point at a
 *                                     loopback host, on a port that is not another project's, to an s4_ database
 *                                     whose name does not suggest production or staging.
 *   assertDisposableTestDatabase      read-only preflight, BEFORE the spec's first write:
 *                                     the server must be an S4-only disposable cluster — no Supabase roles, and no
 *                                     database other than postgres / templates / s4_* — and current_database() must be
 *                                     the one named in the URL. The name alone is never trusted.
 *
 * Nothing here writes. A refusal is an UnsafeTestDatabaseError naming the variable, never the credentials.
 */
type PgClient = {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('pg') as { Client: new (options: { connectionString: string; ssl: false }) => PgClient };

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(`Refusing to run against this database: ${message}`);
    this.name = 'UnsafeTestDatabaseError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** Local Supabase stacks (API 54321, DB 54322, Studio 54323, …) and the Supabase pooler: other projects' databases. */
const OTHER_PROJECT_PORTS = new Set([54320, 54321, 54322, 54323, 54324, 54325, 54326, 54327, 54328, 54329, 6543]);
/** The default Postgres port is used by GitHub Actions' disposable service container; locally its owner is unknown. */
const DEFAULT_PORT = 5432;
const DATABASE_NAME = /^s4_[a-z0-9_]+$/;
// Not "live": CI's own s4_live_ops_correctness is a disposable test database.
const LIVE_LOOKING_NAME = /(^|_)(prod|production|staging|stage)(_|$)/;
const SUPABASE_ROLES = ['supabase_admin', 'authenticator', 'service_role', 'supabase_auth_admin', 'anon'];

type Env = Record<string, string | undefined>;

const isCi = (env: Env) => env.GITHUB_ACTIONS === 'true';

/** Throws unless `raw` is a URL this guard accepts. Returns the parsed parts. */
export function assertDisposableTestDatabaseUrl(raw: string, label: string, env: Env = process.env) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTestDatabaseError(`${label} is not a valid database URL.`);
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new UnsafeTestDatabaseError(`${label} must be a postgresql:// URL.`);
  }
  const host = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new UnsafeTestDatabaseError(`${label} must point at a local (loopback) database, not "${host}".`);
  }
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  if (OTHER_PROJECT_PORTS.has(port)) {
    throw new UnsafeTestDatabaseError(`${label} uses port ${port}, which belongs to another project's local stack (e.g. Supabase).`);
  }
  if (port === DEFAULT_PORT && !isCi(env)) {
    throw new UnsafeTestDatabaseError(
      `${label} uses port ${DEFAULT_PORT}. Outside CI that server's owner is unknown; use a disposable container on its own port.`,
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!DATABASE_NAME.test(database)) {
    throw new UnsafeTestDatabaseError(`${label} must name an s4_ test database (lower case), not "${database}".`);
  }
  if (LIVE_LOOKING_NAME.test(database)) {
    throw new UnsafeTestDatabaseError(`${label} names "${database}", which looks like a production or staging database.`);
  }
  return { host, port, database };
}

/**
 * The URL in the first of `variables` that is set, validated. Throws — before any connection is attempted — when none
 * is set: there is deliberately no default database.
 */
export function requireDisposableTestDatabaseUrl(variables: string | string[], env: Env = process.env): string {
  const names = Array.isArray(variables) ? variables : [variables];
  const name = names.find((candidate) => (env[candidate] ?? '').trim() !== '');
  if (!name) {
    throw new UnsafeTestDatabaseError(
      `${names.join(' or ')} is not set. Set it explicitly to a disposable local s4_ test database; there is no default.`,
    );
  }
  const raw = env[name]!.trim();
  assertDisposableTestDatabaseUrl(raw, name, env);
  return raw;
}

export type QueryFn = (sql: string) => Promise<Array<Record<string, unknown>>>;

/**
 * Read-only preflight against the server itself, run before a spec's first write. `query` is injectable so the
 * refusals can be tested without any server; by default a short-lived pg client is used and closed again.
 */
export async function assertDisposableTestDatabase(raw: string, query?: QueryFn, env: Env = process.env): Promise<void> {
  const { database } = assertDisposableTestDatabaseUrl(raw, 'the test database URL', env);
  let client: PgClient | null = null;
  const run: QueryFn = query ?? (async (sql) => {
    if (!client) {
      client = new Client({ connectionString: raw, ssl: false });
      await client.connect();
      await client.query('SET default_transaction_read_only = on');
    }
    return (await client.query(sql)).rows;
  });
  try {
    const [{ current: actual }] = await run('SELECT current_database() AS current');
    if (actual !== database) {
      throw new UnsafeTestDatabaseError(`connected to "${String(actual)}", not "${database}".`);
    }
    const roles = await run(
      `SELECT rolname FROM pg_roles WHERE rolname IN (${SUPABASE_ROLES.map((r) => `'${r}'`).join(', ')})`,
    );
    if (roles.length) {
      throw new UnsafeTestDatabaseError('the server has Supabase roles; it is another project\'s database server.');
    }
    const foreign = await run(
      `SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' AND datname !~ '^s4_'`,
    );
    if (foreign.length) {
      throw new UnsafeTestDatabaseError(
        `the server holds ${foreign.length} non-S4 database(s); only a disposable S4-only server is allowed.`,
      );
    }
  } finally {
    if (client) await (client as PgClient).end().catch(() => undefined);
  }
}
