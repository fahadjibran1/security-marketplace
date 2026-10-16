/**
 * Performance P3 — compares two census runs (scripts/perf-p3-census.ts) of the same database.
 *
 * For every (principal, route): the status must match and the response must be identical, path by path
 * (values compared by hash; the values themselves are never in the files). A top-level array whose
 * elements carry an `id` is compared element by element BY ID, because a query without ORDER BY may
 * legitimately return rows in another order; a difference in order alone is reported separately.
 *
 *   npx ts-node scripts/perf-p3-census-compare.ts <before.json> <after.json>
 * Exit status 1 when any response differs.
 */
import { readFileSync } from 'fs';

type Row = { principal: string; route: string; status: number; ms: number; queries: number; maxJoins: number; totalJoins: number; sqlBytes: number; items: number | null; shape: Record<string, string> };

/**
 * Re-keys every array element that has an `id` by that id (`….#<idhash>.…` instead of `….<index>.…`), at
 * any depth, and returns the element order of every such array so a difference in order alone can be
 * reported separately from a difference in content.
 */
function byId(shape: Record<string, string>): { shape: Record<string, string>; order: string[] } | null {
  const out: Record<string, string> = {};
  const orders = new Map<string, string[]>();
  for (const [path, hash] of Object.entries(shape)) {
    const parts = path.split('.');
    const rewritten: string[] = [parts[0]];
    for (let i = 1; i < parts.length; i += 1) {
      const original = parts.slice(0, i + 1).join('.');
      const id = /^\d+$/.test(parts[i]) ? shape[`${original}.id`] : undefined;
      if (id !== undefined) {
        const arrayKey = rewritten.join('.');
        const order = orders.get(arrayKey) ?? [];
        if (order[Number(parts[i])] === undefined) order[Number(parts[i])] = id;
        orders.set(arrayKey, order);
        rewritten.push(`#${id}`);
      } else {
        rewritten.push(parts[i]);
      }
    }
    out[rewritten.join('.')] = hash;
  }
  const order = [...orders.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, ids]) => `${k}=${ids.join(',')}`);
  return { shape: out, order };
}

export function compareCensus(before: Row[], after: Row[]) {
  const key = (r: Row) => `${r.principal} ${r.route}`;
  const afterBy = new Map(after.map((r) => [key(r), r]));
  const report: Array<{ key: string; status: string; diffs: string[]; orderOnly: boolean; before: Row; after?: Row }> = [];
  for (const b of before) {
    const a = afterBy.get(key(b));
    if (!a) { report.push({ key: key(b), status: 'missing', diffs: [], orderOnly: false, before: b }); continue; }
    const diffs: string[] = [];
    if (a.status !== b.status) diffs.push(`status ${b.status} -> ${a.status}`);
    let bs = b.shape;
    let as = a.shape;
    let orderOnly = false;
    const bi = byId(bs);
    const ai = byId(as);
    if (bi && ai) {
      bs = bi.shape;
      as = ai.shape;
      orderOnly = bi.order.join() !== ai.order.join();
    }
    for (const p of new Set([...Object.keys(bs), ...Object.keys(as)])) {
      if (bs[p] !== as[p]) diffs.push(`${p}: ${bs[p] === undefined ? 'absent' : 'present'} -> ${as[p] === undefined ? 'absent' : bs[p] === undefined ? 'present' : 'changed'}`);
    }
    report.push({ key: key(b), status: diffs.length ? 'DIFFERENT' : 'identical', diffs, orderOnly, before: b, after: a });
  }
  return report;
}

if (require.main === module) {
  const [beforePath, afterPath] = process.argv.slice(2);
  const before: Row[] = JSON.parse(readFileSync(beforePath, 'utf8')).results;
  const after: Row[] = JSON.parse(readFileSync(afterPath, 'utf8')).results;
  const report = compareCensus(before, after);
  const routes = new Map<string, typeof report>();
  for (const r of report) {
    const route = r.before.route.replace(/\d{4}-\d\d-\d\d/g, 'D');
    if (!routes.has(route)) routes.set(route, []);
    routes.get(route)!.push(r);
  }
  console.log('route'.padEnd(38), 'reqs', 'result'.padEnd(10), 'stmts b->a'.padEnd(11), 'maxJOIN b->a'.padEnd(13), 'SQL KB b->a'.padEnd(12), 'order');
  let different = 0;
  for (const [route, rows] of routes) {
    const max = (f: (r: (typeof rows)[number]) => number) => Math.max(...rows.map(f));
    const bad = rows.filter((r) => r.status !== 'identical');
    different += bad.length;
    console.log(route.padEnd(38), String(rows.length).padEnd(4), (bad.length ? `DIFF x${bad.length}` : 'identical').padEnd(10),
      `${max((r) => r.before.queries)}->${max((r) => r.after?.queries ?? 0)}`.padEnd(11),
      `${max((r) => r.before.maxJoins)}->${max((r) => r.after?.maxJoins ?? 0)}`.padEnd(13),
      `${Math.round(max((r) => r.before.sqlBytes) / 1024)}->${Math.round(max((r) => r.after?.sqlBytes ?? 0) / 1024)}`.padEnd(12),
      rows.some((r) => r.orderOnly) ? 'order differs' : '');
  }
  for (const r of report.filter((x) => x.status !== 'identical').slice(0, 20)) {
    console.log(`\n${r.key}: ${r.status}`);
    for (const d of r.diffs.slice(0, 12)) console.log('   ', d);
    if (r.diffs.length > 12) console.log(`    … ${r.diffs.length - 12} more`);
  }
  console.log(`\n${report.length} requests compared, ${different} different`);
  process.exit(different ? 1 : 0);
}
