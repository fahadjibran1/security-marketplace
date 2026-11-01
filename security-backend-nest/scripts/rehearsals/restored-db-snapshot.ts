/**
 * Row fingerprints of a (restored) database for the S4 1.3.0 B1 rollback rehearsal: per table, one md5 per row keyed by
 * its id (or one md5 for a table without an id), computed WITHOUT the columns Migrations 73 and 74 add, so a database
 * can be compared across those migrations. Only hashes and ids are ever written or printed — never row contents (a
 * restored production backup holds real pilot data).
 */
type Runner = { query: (sql: string, params?: unknown[]) => Promise<any[]> };

export const MIGRATION_ADDED_COLUMNS: Record<string, string[]> = {
  patrol_schedules: ['supersededByScheduleId', 'supersededAt', 'anchor'],
  shifts: ['patrolRequirement'],
  patrol_policies: ['setupMode', 'windowAnchor', 'setupConfirmedAt', 'setupConfirmedByUserId'],
  patrol_routes: ['kind', 'supersededByRouteId', 'supersededAt'],
  patrol_checkpoints: ['confirmedAt', 'confirmedByUserId', 'confirmedTokenVersion'],
};

export type Snapshot = Record<string, Record<string, string>>;

export async function snapshot(db: Runner): Promise<Snapshot> {
  const tables = (await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'typeorm_migrations' ORDER BY 1`))
    .map((r: any) => r.tablename as string);
  const out: Snapshot = {};
  for (const t of tables) {
    const drop = (MIGRATION_ADDED_COLUMNS[t] ?? []).map((c) => ` - '${c}'`).join('');
    const hasId = (await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'`, [t])).length > 0;
    out[t] = {};
    if (hasId) {
      for (const r of await db.query(`SELECT x.id::text AS id, md5((to_jsonb(x)${drop})::text) AS h FROM "${t}" x`)) out[t][r.id] = r.h;
    } else {
      const [r] = await db.query(`SELECT md5(coalesce(string_agg(md5((to_jsonb(x)${drop})::text), ',' ORDER BY md5((to_jsonb(x)${drop})::text)), '')) AS h FROM "${t}" x`);
      out[t]['*'] = r.h;
    }
  }
  return out;
}

/** Per table: rows that existed in `before` and changed or disappeared, and how many rows were added (ids only). */
export function compare(before: Snapshot, after: Snapshot) {
  const changed: Record<string, string[]> = {};
  const removed: Record<string, string[]> = {};
  const added: Record<string, number> = {};
  for (const t of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[t] ?? {};
    const a = after[t] ?? {};
    const ch = Object.keys(b).filter((id) => id in a && a[id] !== b[id]);
    const rm = Object.keys(b).filter((id) => !(id in a));
    const ad = Object.keys(a).filter((id) => !(id in b)).length;
    if (ch.length) changed[t] = ch;
    if (rm.length) removed[t] = rm;
    if (ad) added[t] = ad;
  }
  return { changed, removed, added };
}
