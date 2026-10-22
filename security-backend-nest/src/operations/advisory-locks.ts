/**
 * Postgres advisory-lock namespaces shared between services. One lock per shift id within a namespace.
 *
 * The welfare sweep takes WELFARE_SWEEP_LOCK_NAMESPACE with a TRY lock and skips a shift it cannot lock;
 * shift reconciliation (Close without Book Off) takes the same lock and waits, so a sweep can never
 * open or close alerts on a shift half-way through being reconciled.
 */
export const WELFARE_SWEEP_LOCK_NAMESPACE = 534_401_401;

/**
 * One lock per Guard id. Every path that commits a Guard to a time window (rota assignment, a shift created
 * or reassigned with a Guard, a rota time change, a Guard accepting an offer) takes it before its overlap
 * check and holds it until its write commits, so two such paths can never both pass the check for
 * overlapping windows. Order: ascending Guard id, before any lock on a shift row (a rota time change
 * holds its rota slot row first; nothing that holds a Guard lock waits on a rota slot row).
 */
export const GUARD_ASSIGNMENT_LOCK_NAMESPACE = 534_401_402;

export async function lockGuardsForAssignment(
  manager: { query: (sql: string, parameters?: unknown[]) => Promise<unknown> },
  guardIds: Array<number | null | undefined>,
): Promise<void> {
  const ids = [...new Set(guardIds.filter((id): id is number => typeof id === 'number'))].sort((a, b) => a - b);
  for (const id of ids) {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [GUARD_ASSIGNMENT_LOCK_NAMESPACE, id]);
  }
}

/**
 * TypeORM's Postgres driver answers an UPDATE … RETURNING with [rows, rowCount], not the rows themselves, so
 * `.length` of the raw result is always 2 and a refused write would look like a success. Read the rows.
 */
export function returningRows<T>(result: unknown): T[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
}
