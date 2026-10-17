/**
 * Postgres advisory-lock namespaces shared between services. One lock per shift id within a namespace.
 *
 * The welfare sweep takes WELFARE_SWEEP_LOCK_NAMESPACE with a TRY lock and skips a shift it cannot lock;
 * shift reconciliation (Close without Book Off) takes the same lock and waits, so a sweep can never
 * open or close alerts on a shift half-way through being reconciled.
 */
export const WELFARE_SWEEP_LOCK_NAMESPACE = 534_401_401;
