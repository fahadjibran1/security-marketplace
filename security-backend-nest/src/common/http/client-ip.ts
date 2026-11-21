/**
 * SEC-PUBLIC-02: the one place the API decides which IP address a request came from.
 *
 * It returns Express's `req.ip`, which honours the `trust proxy` setting (TRUST_PROXY, a hop count: 1 in production for
 * Render's edge proxy). With a hop count of N, Express walks X-Forwarded-For from the RIGHT and skips exactly N trusted
 * proxies, so the address it returns was appended by infrastructure S4 trusts. Entries a client writes into
 * X-Forwarded-For itself sit to the left of those and are never used.
 *
 * Code must never read X-Forwarded-For (or any other client-settable header) directly: the first entry of that list is
 * whatever the client sent, so keying a rate limit on it let anyone rotate the value and never be limited, and recording
 * it in an audit log let anyone choose the address recorded. scripts/auth-rate-limit.spec.ts fails the build if
 * `x-forwarded-for` is read anywhere in src/.
 *
 * IPv4-mapped IPv6 addresses (::ffff:203.0.113.7) are reduced to their IPv4 form so one client is one key whichever
 * socket family carried it.
 */
export function resolveClientIp(req: { ip?: string | null; socket?: { remoteAddress?: string | null } | null } | null | undefined): string | null {
  const raw = req?.ip ?? req?.socket?.remoteAddress ?? null;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase().startsWith('::ffff:') && trimmed.includes('.') ? trimmed.slice(7) : trimmed;
}
