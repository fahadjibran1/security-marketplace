/**
 * Route versions (S4 1.3.0 B1, Migration 74; mirrors the schedule versions of Migration 73, patrol-schedule-versions.ts).
 *
 * A route's checkpoint list (and its order rule) is never changed in place once anything could have relied on it: a change
 * ARCHIVES the current route (active = false, archivedAt = the change instant) and CREATES a successor with a NEW id in
 * the same transaction, linked by patrol_routes."supersededByRouteId" / "supersededAt" (composite FK to the same company
 * and site, one predecessor per successor). The automatic route of a site (kind 'auto': every confirmed, active,
 * unrevoked checkpoint) is ALWAYS changed this way, whenever that set changes.
 *
 *   schedules  always name the CURRENT (active) version: the successor is written into every schedule that named the
 *              replaced version in the same locked transaction (owner decision, B1 follow-up), so the 1.2.1 backend — which
 *              knows no versions — always finds an active route on a rollback, with no manual step. The route a WINDOW owes
 *              is still the version in force at the window's START (routeVersionAt walks the chain back to its first
 *              version, then forward), so a checkpoint added mid-window never changes that window's obligation.
 *   runs       keep the routeId they started under (the version resolved at start), so a run is always judged against the
 *              checkpoint list it was started with.
 *   reads      show a schedule's current route (its routeId, which is also routeHead).
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

/** The first version of the chain `routeId` belongs to (walking predecessors back). */
export function routeRoot(links: RouteVersionLinks, routeId: number): number {
  const predecessorOf = new Map<number, number>();
  for (const [pred, link] of links) predecessorOf.set(link.successorId, pred);
  let current = Number(routeId);
  const seen = new Set<number>([current]);
  for (let i = 0; i < CHAIN_LIMIT; i += 1) {
    const pred = predecessorOf.get(current);
    if (pred == null || seen.has(pred)) return current;
    current = pred;
    seen.add(current);
  }
  return current;
}

/**
 * The version of `routeId`'s chain in force at `at`: the version whose effective interval contains `at` — the chain's
 * first version for anything before its first change, then each successor from the instant it took effect. Whichever
 * version of the chain `routeId` names (a schedule names the CURRENT version, see PatrolConfigService.supersedeRoute),
 * the answer is the same: the chain is walked back to its first version, then forward.
 */
export function routeVersionAt(links: RouteVersionLinks, routeId: number | null | undefined, at: Date): number | null {
  if (routeId == null) return null;
  let current = routeRoot(links, Number(routeId));
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

/** Whether two route ids are versions of the same route (either may be the older one). */
export function sameRouteChain(links: RouteVersionLinks, a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false;
  return routeRoot(links, Number(a)) === routeRoot(links, Number(b));
}

/** A route's checkpoint list, normalised for comparison: [checkpointId, required] in position order. */
export function routeContentKey(items: Array<{ checkpointId: number; required?: boolean | null }>, orderMode: string): string {
  return `${orderMode}|${items.map((i) => `${Number(i.checkpointId)}:${i.required === false ? 0 : 1}`).join(',')}`;
}

export const PATROL_ROUTE_SUPERSEDED_ACTION = 'patrol.route.superseded';
/** The name every automatic route version carries. */
export const AUTO_ROUTE_NAME = 'All confirmed checkpoints';
