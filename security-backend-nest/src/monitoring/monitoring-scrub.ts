/**
 * Privacy scrubbing for error-monitoring events (Sentry).
 *
 * Pure and dependency-free so it is executed directly by the certification suite. It is applied as the
 * SDK's beforeSend / beforeBreadcrumb hook, so nothing reaches the monitoring provider without passing
 * through it. It removes, rather than tries to recognise and keep:
 *
 *   - every request header except a short allow-list (so Authorization, Cookie and x-s4-client go)
 *   - request bodies, cookies and query strings
 *   - sensitive URL query parameters (reset/verification tokens, refresh tokens, codes, emails…)
 *   - user identity beyond the numeric id
 *   - any field whose NAME marks it as operational content or a credential (incident and Log Book
 *     text, Welfare notes, screening evidence, SIA numbers, GPS coordinates, passwords, tokens)
 *   - JWTs, bearer tokens, email addresses, 16-digit SIA numbers and long opaque tokens inside any
 *     free-text string, including exception messages
 *   - console breadcrumbs entirely, because a log line can carry anything
 */

export const FILTERED = '[Filtered]';

const ALLOWED_HEADERS = new Set(['user-agent', 'content-type', 'accept', 'x-request-id']);

const SENSITIVE_QUERY_KEYS = new Set([
  'token', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken', 'code', 'password',
  'email', 'key', 'signature', 'secret', 'auth', 'authorization', 'session',
]);

/** Field names whose VALUE is never sent, matched case-insensitively against the whole key. */
const SENSITIVE_KEY_PATTERN =
  /pass(word)?|secret|token|authori[sz]ation|cookie|jwt|bearer|api[-_]?key|x-s4-client|sia|licen[cs]e|lat(itude)?$|^lat|lng|lon(gitude)?$|^lon|gps|coord|location|geo|note|notes|message|body|description|narrative|report|entry|text|welfare|incident|log[-_]?book|evidence|screening|document|email|phone|name|address|nino|utr|bank|sort[-_]?code|account[-_]?number/i;

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // JWT: three base64url segments, the first starting with the encoded '{"'.
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[Filtered:jwt]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [Filtered]'],
  [/([?&](?:token|refreshToken|refresh_token|access_token|code)=)[^&#\s]+/gi, '$1[Filtered]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[Filtered:email]'],
  // UK SIA licence numbers are 16 digits, optionally grouped.
  [/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, '[Filtered:number]'],
  // Opaque tokens: 32+ characters of base64url/hex with no spaces.
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[Filtered:token]'],
];

export function scrubText(value: string): string {
  return TEXT_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

/** Redact sensitive query parameter values, keeping the path and the parameter names. */
export function scrubUrl(url: string): string {
  const queryAt = url.indexOf('?');
  if (queryAt < 0) return scrubText(url);
  const base = url.slice(0, queryAt);
  const [query, ...fragment] = url.slice(queryAt + 1).split('#');
  const params = query
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const [rawKey] = pair.split('=');
      const key = decodeSafe(rawKey).toLowerCase();
      return SENSITIVE_QUERY_KEYS.has(key) || SENSITIVE_KEY_PATTERN.test(key)
        ? `${rawKey}=${FILTERED}`
        : scrubText(pair);
    });
  return `${scrubText(base)}?${params.join('&')}${fragment.length ? '#' + fragment.join('#') : ''}`;
}

function decodeSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Deep-scrub an arbitrary value: sensitive keys are replaced, every string is pattern-scrubbed. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return FILTERED;
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? FILTERED : scrubValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}

// Monitoring events are loosely typed SDK payloads; every field is treated as untrusted input here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

export function scrubBreadcrumb<T extends AnyRecord>(breadcrumb: T): T | null {
  if (!breadcrumb) return breadcrumb;
  if (breadcrumb.category === 'console') return null;
  const out: AnyRecord = { ...breadcrumb };
  if (typeof out.message === 'string') out.message = scrubText(out.message);
  if (out.data && typeof out.data === 'object') {
    const data: AnyRecord = {};
    for (const [key, inner] of Object.entries(out.data as AnyRecord)) {
      if (key === 'url' && typeof inner === 'string') data.url = scrubUrl(inner);
      else if (['method', 'status_code', 'reason'].includes(key)) data[key] = inner;
      else data[key] = SENSITIVE_KEY_PATTERN.test(key) || key.includes('query') || key.includes('body') ? FILTERED : scrubValue(inner);
    }
    out.data = data;
  }
  return out as T;
}

/**
 * The beforeSend hook. Returns a new event; never throws (a scrubber that throws would make the SDK
 * drop the event, which is safe, but would hide the error that caused it).
 */
export function scrubEvent<T extends AnyRecord>(event: T): T {
  try {
    const out: AnyRecord = { ...event };

    if (out.request) {
      const request: AnyRecord = { ...out.request };
      delete request.data;
      delete request.cookies;
      delete request.query_string;
      delete request.env;
      if (typeof request.url === 'string') request.url = scrubUrl(request.url);
      if (request.headers && typeof request.headers === 'object') {
        const headers: AnyRecord = {};
        for (const [name, value] of Object.entries(request.headers as AnyRecord)) {
          if (ALLOWED_HEADERS.has(name.toLowerCase())) headers[name] = typeof value === 'string' ? scrubText(value) : value;
        }
        request.headers = headers;
      }
      out.request = request;
    }

    if (out.user) out.user = typeof out.user.id === 'number' || typeof out.user.id === 'string' ? { id: out.user.id } : undefined;
    if (typeof out.message === 'string') out.message = scrubText(out.message);
    if (out.logentry?.message) out.logentry = { ...out.logentry, message: scrubText(String(out.logentry.message)), params: undefined };

    if (out.exception?.values) {
      out.exception = {
        ...out.exception,
        values: out.exception.values.map((value: AnyRecord) => ({
          ...value,
          value: typeof value.value === 'string' ? scrubText(value.value) : value.value,
          stacktrace: value.stacktrace
            ? {
                ...value.stacktrace,
                // Local variable capture would copy request data straight into the event.
                frames: (value.stacktrace.frames ?? []).map((frame: AnyRecord) => {
                  const { vars: _vars, ...rest } = frame;
                  return rest;
                }),
              }
            : value.stacktrace,
        })),
      };
    }

    if (out.extra) out.extra = scrubValue(out.extra);
    if (out.contexts) {
      const contexts: AnyRecord = {};
      for (const [name, context] of Object.entries(out.contexts as AnyRecord)) {
        // Runtime/os/device/trace contexts are structural; everything else is scrubbed.
        contexts[name] = ['runtime', 'os', 'device', 'app', 'trace', 'culture', 'cloud_resource'].includes(name)
          ? context
          : scrubValue(context);
      }
      out.contexts = contexts;
    }
    if (Array.isArray(out.breadcrumbs)) {
      out.breadcrumbs = out.breadcrumbs.map((crumb: AnyRecord) => scrubBreadcrumb(crumb)).filter(Boolean);
    }
    return out as T;
  } catch {
    // Fail closed: send only the bare minimum rather than an unscrubbed event.
    return { event_id: event.event_id, level: event.level, message: 'Event dropped by S4 privacy scrubber' } as unknown as T;
  }
}
