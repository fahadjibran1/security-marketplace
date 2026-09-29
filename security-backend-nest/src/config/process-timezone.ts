/**
 * The process clock must be UTC. (Phase 1, TECH-DEBT-TIME-01.)
 *
 * WHY THIS IS A BOOT-TIME ASSERTION AND NOT A COMMENT
 * Scheduled shift times and attendance timestamps live in `timestamp without time zone` columns. The
 * node-postgres driver reads and writes those columns using the PROCESS's local timezone: it renders a
 * Date with the local wall clock on the way in, and constructs a Date from the stored wall clock as local
 * time on the way out. That round trip only preserves the true instant when the process is running in UTC.
 *
 * Render sets TZ=UTC explicitly for this service, so today it holds. But if that variable were ever
 * dropped — a new service, a container default, a local run — every stored instant would silently shift by
 * the host's offset. Nothing would error. Shifts would drift, welfare windows would open at the wrong
 * time, and timesheet hours would be wrong by the offset, all without a single failed request.
 *
 * So the process refuses to start instead. A service that will not boot is recoverable in minutes; hours
 * of silently misfiled attendance evidence is not.
 *
 * The real fix is `timestamptz` columns, which do not depend on the process clock at all. That is
 * TECH-DEBT-TIME-01 and it needs a migration with a reviewed backfill, so for now the assertion holds the
 * invariant the columns depend on.
 */

/** Zone names that mean UTC. A zero offset is not enough — a zone can be at +00:00 only seasonally. */
const UTC_ZONE_NAMES = new Set(['UTC', 'Etc/UTC', 'UTC0', 'Etc/UCT', 'UCT', 'Universal', 'Zulu']);

export type TimezoneAssertion = {
  ok: boolean;
  /** The zone the process resolved, as Intl reports it. */
  resolvedTimeZone: string;
  /** The TZ environment variable as set, or null when unset. */
  envTimeZone: string | null;
  /** The process's current offset from UTC in minutes, east-positive. */
  offsetMinutes: number;
  /** Operator-facing explanation. Empty when ok. */
  message: string;
};

/**
 * Checks the process clock. Pure and synchronous, so it can be asserted at boot and tested directly.
 *
 * `now` is injectable because a zone that is at +00:00 in winter and +01:00 in summer — Europe/London,
 * the one this platform is most likely to be misconfigured with — passes an offset check in January and
 * fails it in July. The zone NAME is therefore what decides, and the offset is reported for diagnosis.
 */
export function assertProcessTimezone(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  /**
   * The zone and offset to judge, for tests. Omitted in production, where the real process clock is the
   * whole point. Overridable because a test process cannot change its own TZ once Node has started, and a
   * failure path that only runs on a developer's machine is not a tested failure path.
   */
  observed?: { timeZone: string; offsetMinutes: number },
): TimezoneAssertion {
  const envTimeZone = env.TZ?.trim() ? env.TZ.trim() : null;

  let resolvedTimeZone = observed?.timeZone ?? '';
  if (observed === undefined) {
    try {
      resolvedTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      resolvedTimeZone = '';
    }
  }

  // Offset as the process itself sees it, which is what the database driver will use. Negated to make it
  // east-positive, and the `|| 0` collapses the -0 that negating zero produces, so a reported offset
  // compares equal to 0 rather than surprising a strict check.
  const offsetMinutes = observed?.offsetMinutes ?? (-now.getTimezoneOffset() || 0);

  const zoneIsUtc = UTC_ZONE_NAMES.has(resolvedTimeZone);
  if (zoneIsUtc && offsetMinutes === 0) {
    return { ok: true, resolvedTimeZone, envTimeZone, offsetMinutes, message: '' };
  }

  const reason = !zoneIsUtc
    ? `process timezone is "${resolvedTimeZone || 'unknown'}" (TZ=${envTimeZone ?? 'unset'})`
    : `process timezone resolves to UTC but the current offset is ${offsetMinutes} minutes`;

  return {
    ok: false,
    resolvedTimeZone,
    envTimeZone,
    offsetMinutes,
    message:
      `${reason}. Scheduled shift times and attendance timestamps are stored in ` +
      '`timestamp without time zone` columns, which the database driver reads and writes using this ' +
      "process's local clock. Any zone other than UTC silently shifts every stored instant. " +
      'Set TZ=UTC for this service and restart.',
  };
}

/** Throws unless the process clock is UTC. Called from bootstrap before the app listens. */
export function requireUtcProcessTimezone(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  observed?: { timeZone: string; offsetMinutes: number },
): TimezoneAssertion {
  const assertion = assertProcessTimezone(env, now, observed);
  if (!assertion.ok) {
    throw new Error(`Refusing to start: ${assertion.message}`);
  }
  return assertion;
}
