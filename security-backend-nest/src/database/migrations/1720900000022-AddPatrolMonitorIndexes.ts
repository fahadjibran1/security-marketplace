import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 75: the two indexes the Patrol Monitor's reads need (S4 Patrol Monitor S1, owner-approved 3 Nov 2026 on the
 * measured benchmark: 50 sites, 1.27 M patrol runs).
 *
 *   patrol_runs  "IDX_patrol_runs_company_site_window_start"  ("companyId", "siteId", "windowStart")
 *                The runs of the windows in a range: a full scan of every patrol ever (489 ms, 39,380 buffers) becomes an
 *                index scan (1–2 ms, under 1,000 buffers).
 *   shifts       "IDX_shifts_company_site_end"                ("companyId", "siteId", "end")
 *                The shifts across a range ("end" > from is the selective bound): 92 ms → 0.3 ms.
 *
 * Indexes only: no table, column, constraint or row changes. Nothing else was justified by the measurement (a
 * patrol_exceptions index was not used by the planner; a partial safety_alerts index cannot serve today's query).
 *
 * Built with CREATE INDEX CONCURRENTLY, so production reads and writes carry on during the build; PostgreSQL refuses that
 * inside a transaction block, so the migration runs outside one (transaction = false; the deploy runs migrations with
 * --transaction each, which honours it, as for Migrations 59 and 63).
 *
 * Idempotent, and never silently accepts a wrong index:
 *   absent                                         → built concurrently, then checked valid with the exact definition
 *   present, valid, exact definition               → left alone (a repeated run changes nothing)
 *   present, INVALID, exact definition             → the remains of an interrupted concurrent build: dropped concurrently
 *                                                    and rebuilt (PostgreSQL never uses an invalid index)
 *   present with any other definition (columns, table, uniqueness, predicate, method), valid or not
 *                                                  → refused with the definition found; nothing is changed
 */
export const PATROL_MONITOR_INDEXES = [
  {
    name: 'IDX_patrol_runs_company_site_window_start',
    table: 'patrol_runs',
    definition: 'CREATE INDEX "IDX_patrol_runs_company_site_window_start" ON public.patrol_runs USING btree ("companyId", "siteId", "windowStart")',
    create: 'CREATE INDEX CONCURRENTLY "IDX_patrol_runs_company_site_window_start" ON "patrol_runs" ("companyId", "siteId", "windowStart")',
  },
  {
    name: 'IDX_shifts_company_site_end',
    table: 'shifts',
    definition: 'CREATE INDEX "IDX_shifts_company_site_end" ON public.shifts USING btree ("companyId", "siteId", "end")',
    create: 'CREATE INDEX CONCURRENTLY "IDX_shifts_company_site_end" ON "shifts" ("companyId", "siteId", "end")',
  },
] as const;

type Found = { definition: string; valid: boolean; ready: boolean } | null;

async function inspect(queryRunner: QueryRunner, name: string): Promise<Found> {
  const [row] = await queryRunner.query(
    `SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid, i.indisready AS ready
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    [name],
  );
  return row ? { definition: String(row.definition), valid: row.valid === true, ready: row.ready === true } : null;
}

export class AddPatrolMonitorIndexes1720900000022 implements MigrationInterface {
  name = 'AddPatrolMonitorIndexes1720900000022';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check both first: a wrong index refuses the whole migration before anything is built.
    const found = new Map<string, Found>();
    for (const index of PATROL_MONITOR_INDEXES) {
      const existing = await inspect(queryRunner, index.name);
      if (existing && existing.definition !== index.definition) {
        throw new Error(
          `Refusing AddPatrolMonitorIndexes1720900000022: "${index.name}" exists with a different definition ` +
            `(${existing.valid ? 'valid' : 'INVALID'}): ${existing.definition}. Expected: ${index.definition}. ` +
            'Investigate and drop it deliberately before running this migration again.',
        );
      }
      found.set(index.name, existing);
    }
    for (const index of PATROL_MONITOR_INDEXES) {
      const existing = found.get(index.name);
      if (existing?.valid && existing.ready) continue;
      // The remains of an interrupted concurrent build (same name, same definition, never usable): rebuild it.
      if (existing) await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
      await queryRunner.query(index.create);
    }
    for (const index of PATROL_MONITOR_INDEXES) {
      const built = await inspect(queryRunner, index.name);
      if (!built || !built.valid || !built.ready || built.definition !== index.definition) {
        throw new Error(`AddPatrolMonitorIndexes1720900000022: "${index.name}" is not a valid index with the expected definition after the build.`);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Indexes only: nothing is lost by removing them (the Monitor's reads fall back to the slower scans).
    // TypeORM's migration:revert wraps down() in a transaction whatever `transaction` says (only --transaction none does
    // not), and PostgreSQL refuses a concurrent drop there. So: concurrently when outside a transaction; otherwise a plain
    // drop that gives up after 5 s rather than queue behind a long-running read and hold up the table's other users.
    const inTransaction = queryRunner.isTransactionActive;
    if (inTransaction) await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    for (const index of [...PATROL_MONITOR_INDEXES].reverse()) {
      await queryRunner.query(`DROP INDEX ${inTransaction ? '' : 'CONCURRENTLY '}IF EXISTS "${index.name}"`);
    }
  }
}
