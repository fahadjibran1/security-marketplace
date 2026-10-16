/**
 * Performance P3 — dashboard route census (diagnostic tool, LOCAL ONLY).
 *
 * Boots the real application against a local database and replays, for every company user in it, the
 * GET requests the Company dashboard and Live Operations send. For each request it records:
 *   - every SQL statement the request issued (JOIN count and size only, never the text),
 *   - the response status and time,
 *   - the response body as a map of JSON path -> SHA-256 of the value, so two runs can be compared for
 *     byte-identical responses without the values (which may be personal data) ever being written out.
 *
 * Run once against the release build and once against a candidate, on the same database, then compare
 * with scripts/perf-p3-census-compare.ts. Read-only apart from what the routes themselves do (all GETs).
 *
 *   P3_CENSUS_DATABASE_URL  local database (required)
 *   P3_CENSUS_OUT           output JSON path (required)
 *   P3_CENSUS_ROUTES        optional comma-separated subset of routes
 */
import 'reflect-metadata';
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { LoggerService, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const url = process.env.P3_CENSUS_DATABASE_URL ?? '';
const out = process.env.P3_CENSUS_OUT ?? '';
if (!url || !out) throw new Error('P3_CENSUS_DATABASE_URL and P3_CENSUS_OUT are required');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('database must be local');

process.env.DATABASE_URL = url;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'perf-p3-census-local-secret';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.DATABASE_POOLER_URL;
delete process.env.DB_POOL_DIAGNOSTICS;

// Background jobs (minutes apart) must not write into a capture window; requests are what is measured.
const realSetInterval = global.setInterval;
(global as any).setInterval = (fn: any, ms?: number, ...args: any[]) =>
  (ms ?? 0) >= 30_000 ? ({ unref() {}, ref() {}, hasRef: () => false, refresh() {}, [Symbol.toPrimitive]: () => 0 } as any) : realSetInterval(fn, ms, ...args);

const today = new Date().toISOString().slice(0, 10);
const monday = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();

export const COMPANY_ROUTES = [
  '/clients', '/sites', '/shifts', '/coverage/shifts?uncoveredOnly=true', `/coverage/shifts?from=${today}&to=${today}`,
  '/guards', '/company-guards', '/company-guards/invitations', '/screening/company/outcomes',
  '/attendance/company', '/timesheets/company', '/incidents/company', '/alerts/company', '/daily-logs/company',
  '/notifications/company', '/compliance/statuses', '/compliance', '/jobs', '/job-applications', `/rota/week?weekCommencing=${monday}`,
];
export const GUARD_ROUTES = ['/shifts/my', '/alerts/mine', '/attendance/mine', '/timesheets/mine', '/daily-logs/mine', '/notifications/mine', '/incidents/mine', '/job-applications', '/company-guards/me'];

class QuietLogger implements LoggerService {
  log() {}
  warn() {}
  error(message: unknown) { if (process.env.P3_CENSUS_VERBOSE) console.error(message); }
}

/** JSON path -> hash of the leaf value. Arrays keep their index, so order differences are differences. */
export function flatten(value: unknown, path = '$', acc: Record<string, string> = {}): Record<string, string> {
  if (value !== null && typeof value === 'object') {
    const keys = Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value as object).sort();
    if (keys.length === 0) acc[path] = Array.isArray(value) ? '[]' : '{}';
    for (const k of keys) flatten((value as any)[k], `${path}.${k}`, acc);
    return acc;
  }
  acc[path] = createHash('sha256').update(JSON.stringify(value === undefined ? null : value)).digest('hex').slice(0, 16);
  return acc;
}

const joinsIn = (sql: string) => (sql.match(/\bJOIN\b/gi) ?? []).length;

async function main() {
  const { AppModule } = await import('../src/app.module');
  const { DataSource } = await import('typeorm');
  const { JwtService } = await import('@nestjs/jwt');
  const app = await NestFactory.create(AppModule, { logger: new QuietLogger() });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as any).port}`;
  const ds = app.get(DataSource);
  const jwt = app.get(JwtService);

  let capture: Array<{ joins: number; bytes: number }> | null = null;
  const original = ds.logger;
  (ds as any).logger = new Proxy(original, {
    get(target: any, prop) {
      if (prop === 'logQuery') return (query: string, params?: unknown[], qr?: unknown) => {
        if (capture && !/^(START TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(query)) capture.push({ joins: joinsIn(query), bytes: query.length });
        return target.logQuery?.(query, params, qr);
      };
      return target[prop];
    },
  });

  const principals: Array<{ label: string; token: string; routes: string[] }> = [];
  const companyUsers = await ds.query(`SELECT u.id, u.email, u.role, u.status FROM users u WHERE u.role IN ('company_admin', 'company', 'company_staff') AND u.status = 'active' AND u."deletionCompletedAt" IS NULL ORDER BY u.id`);
  for (const [i, u] of companyUsers.entries()) {
    // Single-shift reads (the Live Operations drawer and every shift action load one shift the same way).
    const own = await ds.query(`SELECT s.id FROM shifts s JOIN companies c ON c.id = s."companyId" WHERE c."userId" = $1 ORDER BY s.id LIMIT 3`, [u.id]);
    const routes = [...COMPANY_ROUTES, ...own.map((r: any) => `/shifts/${r.id}`)];
    principals.push({ label: `company#${i + 1}`, token: jwt.sign({ sub: u.id, email: u.email, role: u.role, status: u.status, principalType: 'user' }), routes });
  }
  const guardUsers = await ds.query(`SELECT u.id, u.email, u.role, u.status FROM users u JOIN guard_profiles g ON g."userId" = u.id WHERE u.role = 'guard' AND u.status = 'active' AND u."deletionCompletedAt" IS NULL ORDER BY u.id`);
  guardUsers.forEach((u: any, i: number) => principals.push({ label: `guard#${i + 1}`, token: jwt.sign({ sub: u.id, email: u.email, role: u.role, status: u.status, principalType: 'user' }), routes: GUARD_ROUTES }));
  const only = process.env.P3_CENSUS_ROUTES?.split(',').map((r) => r.trim()).filter(Boolean);

  const results: any[] = [];
  for (const p of principals) {
    for (const route of p.routes) {
      if (only && !only.some((o) => route.startsWith(o))) continue;
      capture = [];
      const started = Date.now();
      const res = await fetch(base + route, { headers: { authorization: `Bearer ${p.token}` } });
      const text = await res.text();
      const ms = Date.now() - started;
      const queries = capture;
      capture = null;
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { body = text.length ? '<non-json>' : null; }
      results.push({
        principal: p.label, route, status: res.status, ms,
        queries: queries.length, maxJoins: Math.max(0, ...queries.map((q) => q.joins)),
        totalJoins: queries.reduce((s, q) => s + q.joins, 0), sqlBytes: queries.reduce((s, q) => s + q.bytes, 0),
        items: Array.isArray(body) ? body.length : null,
        shape: flatten(body),
      });
    }
  }
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
  console.log(`census: ${results.length} requests, ${principals.length} principals -> ${out}`);
  await app.close();
}

if (require.main === module) main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
