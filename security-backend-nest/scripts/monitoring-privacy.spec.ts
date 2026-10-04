/**
 * PRIVACY / PII-SCRUB certification for error monitoring (Sentry), plus its OFF-by-default switch.
 *
 * Executes the real scrubber on realistic events — a failed password reset with the token in the URL, an
 * authenticated request with its Authorization and Cookie headers, an incident submission with its body,
 * breadcrumbs carrying GPS and Log Book text — and proves what leaves is only what may leave. Also proves
 * the SDK is never loaded, let alone initialised, when no DSN is configured.
 *
 * No network, no database. Nothing is sent anywhere.
 */
import { strict as assert } from 'node:assert';
import {
  buildSentryOptions,
  initMonitoring,
  resolveMonitoringConfig,
} from '../src/monitoring/monitoring';
import { FILTERED, scrubBreadcrumb, scrubEvent, scrubText, scrubUrl } from '../src/monitoring/monitoring-scrub';

let passed = 0;
const test = (id: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

const RESET_TOKEN = 'k3J9xQ2mT7vL0pR8sW1yZ4aB6cD5eF3gH2iJ9kL0mN7';
const VERIFY_TOKEN = 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn7Mm6L';
const REFRESH_TOKEN = 'rT0k3n-rEfReSh_abcdefghijklmnopqrstuvwxyz0123456';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjQyLCJlbWFpbCI6Imd1YXJkQGV4YW1wbGUuY29tIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU';
const SIA = '1234567890123456';
const EMAIL = 'guard.person@example.co.uk';
const INCIDENT_TEXT = 'Intruder seen at the north gate, police called, CCTV reviewed';
const LOG_BOOK_TEXT = 'Patrol 3: fire door 4 found open, secured';
const WELFARE_NOTE = 'Guard said they felt unwell and dizzy';

const leaks = (value: unknown) => {
  const dump = JSON.stringify(value);
  return [RESET_TOKEN, VERIFY_TOKEN, REFRESH_TOKEN, JWT, SIA, EMAIL, INCIDENT_TEXT, LOG_BOOK_TEXT, WELFARE_NOTE, 'Bearer ey', 's4sid=', '51.50', '-0.12']
    .filter((needle) => dump.includes(needle));
};

const event: Record<string, any> = {
  event_id: 'abc',
  level: 'error',
  message: `Reset failed for ${EMAIL} with token ${RESET_TOKEN}`,
  user: { id: 42, email: EMAIL, ip_address: '203.0.113.9', username: 'Guard Person' },
  request: {
    url: `https://api.example/auth/reset-password?token=${RESET_TOKEN}&lang=en`,
    method: 'POST',
    query_string: `token=${RESET_TOKEN}`,
    cookies: { s4sid: 'cookie-value' },
    data: { token: RESET_TOKEN, newPassword: 'Hunter2-secret', notes: INCIDENT_TEXT },
    headers: {
      Authorization: `Bearer ${JWT}`,
      Cookie: 's4sid=cookie-value',
      'x-s4-client': 'mobile',
      'User-Agent': 'S4/1.0',
      'x-request-id': 'req-1',
    },
    env: { REMOTE_ADDR: '203.0.113.9' },
  },
  exception: {
    values: [{
      type: 'QueryFailedError',
      value: `duplicate key (siaLicenseNumber)=(${SIA}) for ${EMAIL}; refresh ${REFRESH_TOKEN}; jwt ${JWT}`,
      stacktrace: { frames: [{ filename: 'auth.service.ts', function: 'reset', vars: { token: RESET_TOKEN, password: 'Hunter2-secret' } }] },
    }],
  },
  extra: {
    incident: { title: 'Gate', notes: INCIDENT_TEXT },
    logBookEntry: LOG_BOOK_TEXT,
    welfareNote: WELFARE_NOTE,
    location: { latitude: 51.5074, longitude: -0.1278 },
    siaLicenseNumber: SIA,
    screeningEvidence: 'passport.pdf',
    harmless: 'count=3',
  },
  contexts: {
    runtime: { name: 'node', version: 'v20' },
    shift: { guardPhone: '07700900000', message: LOG_BOOK_TEXT },
  },
  breadcrumbs: [
    { category: 'console', message: `logging ${VERIFY_TOKEN}` },
    { category: 'http', data: { url: `https://app.sfour.co.uk/verify-email?token=${VERIFY_TOKEN}`, method: 'GET', status_code: 200, body: LOG_BOOK_TEXT } },
    { category: 'gps', data: { lat: 51.5074, lng: -0.1278 } },
  ],
};

test('PII-SCRUB-01-NOTHING-SENSITIVE-SURVIVES-A-REALISTIC-EVENT', () => {
  const out: any = scrubEvent(structuredClone(event));
  assert.deepEqual(leaks(out), [], `leaked: ${leaks(out).join(', ')}`);
});

test('PII-SCRUB-02-AUTHORIZATION-COOKIE-AND-CLIENT-HEADERS-STRIPPED', () => {
  const out: any = scrubEvent(structuredClone(event));
  const headers = Object.keys(out.request.headers).map((h) => h.toLowerCase()).sort();
  assert.deepEqual(headers, ['user-agent', 'x-request-id'], 'allow-list only');
});

test('PII-SCRUB-03-REQUEST-BODIES-COOKIES-AND-QUERY-STRINGS-DROPPED', () => {
  const out: any = scrubEvent(structuredClone(event));
  assert.equal(out.request.data, undefined);
  assert.equal(out.request.cookies, undefined);
  assert.equal(out.request.query_string, undefined);
  assert.equal(out.request.env, undefined);
});

test('PII-SCRUB-04-RESET-AND-VERIFICATION-TOKENS-SCRUBBED-FROM-URLS', () => {
  const out: any = scrubEvent(structuredClone(event));
  assert.equal(out.request.url, `https://api.example/auth/reset-password?token=${FILTERED}&lang=en`);
  assert.equal(scrubUrl(`/verify-email?token=${VERIFY_TOKEN}`), `/verify-email?token=${FILTERED}`);
  assert.equal(scrubUrl(`/x?refreshToken=${REFRESH_TOKEN}&email=${EMAIL}&page=2`), `/x?refreshToken=${FILTERED}&email=${FILTERED}&page=2`);
  assert.equal(scrubUrl('/sites?page=2'), '/sites?page=2', 'harmless parameters keep their value');
});

test('PII-SCRUB-05-USER-REDUCED-TO-ID', () => {
  const out: any = scrubEvent(structuredClone(event));
  assert.deepEqual(out.user, { id: 42 });
});

test('PII-SCRUB-06-OPERATIONAL-CONTENT-NEVER-SENT', () => {
  const out: any = scrubEvent(structuredClone(event));
  for (const key of ['incident', 'logBookEntry', 'welfareNote', 'location', 'siaLicenseNumber', 'screeningEvidence']) {
    assert.equal(out.extra[key], FILTERED, `${key} filtered by name`);
  }
  assert.equal(out.extra.harmless, 'count=3', 'structural data is kept');
  assert.equal(out.contexts.shift.guardPhone, FILTERED);
  assert.equal(out.contexts.shift.message, FILTERED);
  assert.deepEqual(out.contexts.runtime, { name: 'node', version: 'v20' }, 'runtime context kept');
});

test('PII-SCRUB-07-EXCEPTION-MESSAGES-AND-LOCAL-VARIABLES-CLEANED', () => {
  const out: any = scrubEvent(structuredClone(event));
  const value = out.exception.values[0];
  assert.ok(!value.value.includes(SIA) && !value.value.includes(EMAIL) && !value.value.includes(JWT) && !value.value.includes(REFRESH_TOKEN), value.value);
  assert.equal(value.type, 'QueryFailedError', 'the error type is kept for triage');
  assert.equal(value.stacktrace.frames[0].vars, undefined, 'captured locals removed');
  assert.equal(value.stacktrace.frames[0].function, 'reset', 'the stack itself is kept');
});

test('PII-SCRUB-08-BREADCRUMBS-SCRUBBED-CONSOLE-DROPPED', () => {
  const out: any = scrubEvent(structuredClone(event));
  assert.equal(out.breadcrumbs.length, 2, 'console breadcrumb dropped');
  assert.equal(out.breadcrumbs[0].data.url, `https://app.sfour.co.uk/verify-email?token=${FILTERED}`);
  assert.equal(out.breadcrumbs[0].data.body, FILTERED);
  assert.equal(out.breadcrumbs[0].data.status_code, 200);
  assert.equal(out.breadcrumbs[1].data.lat, FILTERED, 'GPS not sent');
  assert.equal(out.breadcrumbs[1].data.lng, FILTERED);
  assert.equal(scrubBreadcrumb({ category: 'console', message: 'x' }), null);
});

test('PII-SCRUB-09-FREE-TEXT-PATTERNS', () => {
  assert.match(scrubText(`Bearer ${JWT}`), /^Bearer \[Filtered/);
  assert.equal(scrubText('Bearer opaque.value-123'), 'Bearer [Filtered]');
  assert.ok(!scrubText(`licence ${SIA}`).includes(SIA));
  assert.ok(!scrubText('licence 1234 5678 9012 3456').includes('9012'));
  assert.ok(!scrubText(`mail ${EMAIL}`).includes(EMAIL));
  assert.equal(scrubText('Shift 42 failed after 3 retries'), 'Shift 42 failed after 3 retries', 'ordinary text untouched');
});

test('PII-SCRUB-10-A-BROKEN-EVENT-FAILS-CLOSED', () => {
  const hostile: Record<string, unknown> = { event_id: 'x', level: 'error', message: `token ${RESET_TOKEN}` };
  Object.defineProperty(hostile, 'request', { enumerable: true, get() { throw new Error('boom'); } });
  const out: any = scrubEvent(hostile);
  assert.deepEqual(leaks(out), []);
  assert.equal(out.message, 'Event dropped by S4 privacy scrubber');
});

test('SENTRY-CONFIG-01-DISABLED-WITHOUT-A-DSN-AND-SDK-NEVER-LOADED', () => {
  assert.equal(resolveMonitoringConfig({ NODE_ENV: 'production' }).enabled, false);
  assert.equal(resolveMonitoringConfig({ NODE_ENV: 'production', SENTRY_DSN: '   ' }).enabled, false);
  const sdkPath = require.resolve('@sentry/node');
  delete require.cache[sdkPath];
  const silent = { log: () => undefined } as never;
  assert.equal(initMonitoring({ NODE_ENV: 'production' }, silent), false);
  assert.equal(require.cache[sdkPath], undefined, '@sentry/node is not even required when disabled');
});

test('SENTRY-CONFIG-02-PRIVACY-OPTIONS', () => {
  const config = resolveMonitoringConfig({ SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0', NODE_ENV: 'production', RENDER_GIT_COMMIT: 'abc123' });
  assert.equal(config.enabled, true);
  assert.equal(config.environment, 'production', 'environment tagged');
  assert.equal(config.release, 'abc123', 'release tagged from the deploy commit');
  const options = buildSentryOptions(config);
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.tracesSampleRate, undefined, 'no performance tracing');
  assert.equal(options.profilesSampleRate, undefined, 'no profiling');
  assert.equal(options.includeLocalVariables, false);
  assert.equal(options.beforeSendTransaction(), null, 'no transactions ever leave');
  assert.ok(!('replaysSessionSampleRate' in options) && !('replaysOnErrorSampleRate' in options), 'no session replay');
  assert.deepEqual(leaks(options.beforeSend(structuredClone(event))), [], 'beforeSend is the scrubber');
  assert.equal(options.beforeBreadcrumb({ category: 'console', message: 'x' }), null);
});

test('SENTRY-CONFIG-03-NO-DSN-IN-SOURCE-OR-MANIFEST', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..', '..');
  const manifest = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  assert.ok(!/- key: SENTRY_DSN/.test(manifest), 'production manifest does not declare SENTRY_DSN, so it stays off');
  const sources = ['monitoring.ts', 'monitoring-scrub.ts'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'monitoring', f), 'utf8')).join('\n');
  assert.ok(!/ingest\.sentry\.io|https:\/\/[0-9a-f]{32}@/.test(sources), 'no DSN hard-coded');
});

/**
 * End to end through the real SDK: Sentry.init with exactly the production options, a transport that only
 * records what it would have sent, and an error carrying a reset token, a JWT and an email. Proves the
 * scrubber really is wired into what leaves the process. Nothing is sent over the network.
 */
async function sdkEndToEnd() {
  const Sentry = require('@sentry/node');
  const sent: string[] = [];
  const config = resolveMonitoringConfig({ SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0', NODE_ENV: 'test' });
  Sentry.init({
    ...buildSentryOptions(config),
    defaultIntegrations: false,
    transport: (options: unknown) =>
      Sentry.createTransport(options, async (request: { body: string | Uint8Array }) => {
        sent.push(typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8'));
        return { statusCode: 200 };
      }),
  });
  Sentry.setUser({ id: 42, email: EMAIL });
  Sentry.addBreadcrumb({ category: 'http', data: { url: `/auth/reset-password?token=${RESET_TOKEN}` } });
  Sentry.captureException(new Error(`reset failed for ${EMAIL} token=${RESET_TOKEN} auth Bearer ${JWT}`));
  await Sentry.flush(2000);
  await Sentry.close(2000);
  const wire = sent.join('\n');
  assert.ok(sent.length >= 1, 'the event reached the (recording) transport');
  assert.deepEqual(leaks(wire), [], `leaked on the wire: ${leaks(wire).join(', ')}`);
  assert.ok(wire.includes('"environment":"test"'), 'environment tagged');
  passed += 1;
  console.log('PASS  SENTRY-CONFIG-04-SDK-WIRE-PAYLOAD-IS-SCRUBBED');
}

sdkEndToEnd()
  .then(() => console.log(JSON.stringify({ event: 'monitoring_privacy_certified', tests: passed })))
  .catch((error) => { console.error('FAIL ', error); process.exit(1); });
