/**
 * Route versions (S4 1.3.0 B1, Migration 74; mirrors the schedule versions of Migration 73, patrol-schedule-versions.ts).
 *
 * A route's checkpoint list (and its order rule) is never changed in place once anything could have relied on it: a change
 * ARCHIVES the current route (active = false, archivedAt = the change instant) and CREATES a successor with a NEW id in
 * the same transaction, linked by patrol_routes."supersededByRouteId" / "supersededAt" (composite FK to the same company
 * and site, one predecessor per successor). The automatic route of a site (kind 'auto': every confirmed, active,
 * unrevoked checkpoint) is ALWAYS changed this way, whenever that set changes.
 *
 *   schedules  keep the routeId they were given (the FIRST version). The route a WINDOW owes is the version in force at
 *              the window's START: follow the successor chain while the next link took effect at or before that start
 *              (routeVersionAt). A checkpoint added mid-window therefore never changes that window's obligation.
 *   runs       keep the routeId they started under (the version resolved at start), so a run is always judged against the
 *              checkpoint list it was started with.
 *   reads      show a schedule's CURRENT route as the head of its chain (routeHead).
 *
 * A route archived by hand (DELETE) has no successor: the chain ends there, exactly as before 1.3.0.
 */

type Runner = { query: (sql: string, params?: unknown[]) => Promise<any> };

/** predecessor id → its successor and the instant the successor took effect. */
export type RouteVersionLinks = Map<number, { successorId: number; at: Date }>;

/** Every route version link of the company. */
export async function routeVersionLinks(runner: Runner, companyId: number): Promise<RouteVersionLinks> {
  const rows = await runner.query(
    `SELECT "id", "supersededByRouteId", "supersededAt" FROM "patrol_routes" WHERE "companyId" = $1 AND "supersededByRouteId" IS NOT NULL`,
    [companyId],
  );
  const links: RouteVersionLinks = new Map();
  for (const row of rows) links.set(Number(row.id), { successorId: Number(row.supersededByRouteId), at: new Date(row.supersededAt) });
  return links;
}

const CHAIN_LIMIT = 10_000;

/** The version of `routeId`'s chain in force at `at`: successors that took effect at or before `at` are followed. */
export function routeVersionAt(links: RouteVersionLinks, routeId: number | null | undefined, at: Date): number | null {
  if (routeId == null) return null;
  let current = Number(routeId);
  const seen = new Set<number>([current]);
  for (let i = 0; i < CHAIN_LIMIT; i += 1) {
    const next = links.get(current);
    if (!next || next.at.getTime() > at.getTime() || seen.has(next.successorId)) return current;
    current = next.successorId;
    seen.add(current);
  }
  return current;
}

/** The newest version of `routeId`'s chain (the current route). */
export function routeHead(links: RouteVersionLinks, routeId: number | null | undefined): number | null {
  if (routeId == null) return null;
  return routeVersionAt(links, routeId, new Date(8.64e15));
}

/** Whether `later` is `earlier` or one of its successors (the same route, a newer version). */
export function sameRouteChain(links: RouteVersionLinks, earlier: number | null | undefined, later: number | null | undefined): boolean {
  if (earlier == null || later == null) return false;
  let current = Number(earlier);
  const seen = new Set<number>();
  for (let i = 0; i < CHAIN_LIMIT && !seen.has(current); i += 1) {
    if (current === Number(later)) return true;
    seen.add(current);
    const next = links.get(current);
    if (!next) return false;
    current = next.successorId;
  }
  return false;
}

/** A route's checkpoint list, normalised for comparison: [checkpointId, required] in position order. */
export function routeContentKey(items: Array<{ checkpointId: number; required?: boolean | null }>, orderMode: string): string {
  return `${orderMode}|${items.map((i) => `${Number(i.checkpointId)}:${i.required === false ? 0 : 1}`).join(',')}`;
}

export const PATROL_ROUTE_SUPERSEDED_ACTION = 'patrol.route.superseded';
/** The name every automatic route version carries. */
export const AUTO_ROUTE_NAME = 'All confirmed checkpoints';
