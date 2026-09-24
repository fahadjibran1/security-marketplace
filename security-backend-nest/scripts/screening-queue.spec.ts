/**
 * Reviewer queue certification.
 *
 * The Platform Admin landing page has to stay usable at hundreds of Guards, so this runs the real
 * ScreeningService.queue() against a real PostgreSQL schema and asserts the property that matters:
 * the number of SQL statements does not grow with the number of screenings. It also pins the
 * bucket mapping, the default workload, sorting, search and the compact row shape.
 *
 * Needs SCREENING_QUEUE_DATABASE_URL pointing at a DISPOSABLE database — it drops the schema.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource, Logger, QueryRunner } from 'typeorm';
import { appEntities } from '../src/database/entities';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import {
  EvidenceCategory,
  GuardScreening,
  HistoryType,
  ReferenceStatus,
  ScreeningAddress,
  ScreeningConsent,
  ScreeningEvidence,
  ScreeningException,
  ScreeningHistory,
  ScreeningReference,
  ScreeningStatus,
  VerificationState,
} from '../src/screening/entities/screening.entities';
import { ScreeningService } from '../src/screening/screening.service';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

/** Counts every statement the queue issues so an N+1 cannot reappear unnoticed. */
class CountingLogger implements Logger {
  count = 0;
  on = false;
  logQuery(query: string) {
    if (this.on && !/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)/i.test(query)) this.count += 1;
  }
  logQueryError() {}
  logQuerySlow() {}
  logSchemaBuild() {}
  logMigration() {}
  log() {}
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const yearsAgo = (n: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - n); return d; };

async function main() {
  const url = process.env.SCREENING_QUEUE_DATABASE_URL;
  if (!url) throw new Error('SCREENING_QUEUE_DATABASE_URL is required (use a disposable database)');

  const logger = new CountingLogger();
  const dataSource = new DataSource({ type: 'postgres', url, entities: appEntities, synchronize: true, dropSchema: true, logging: ['query'], logger });
  await dataSource.initialize();

  try {
    const users = dataSource.getRepository(User);
    const guards = dataSource.getRepository(GuardProfile);
    const screenings = dataSource.getRepository(GuardScreening);
    const history = dataSource.getRepository(ScreeningHistory);
    const addresses = dataSource.getRepository(ScreeningAddress);
    const references = dataSource.getRepository(ScreeningReference);
    const evidence = dataSource.getRepository(ScreeningEvidence);
    const consents = dataSource.getRepository(ScreeningConsent);
    const exceptions = dataSource.getRepository(ScreeningException);

    const stub = {} as never;
    const service = new ScreeningService(screenings, history, addresses, references, evidence, consents, exceptions, dataSource.getRepository('CompanyGuard') as never, stub, stub, stub, stub);

    let seq = 0;
    /**
     * Builds one realistic screening: a five-year activity record, a current address, a reference,
     * a consent and the four required evidence documents, at the requested lifecycle stage.
     */
    const seed = async (stage: 'not_submitted' | 'awaiting' | 'under_review' | 'guard_action' | 'ready' | 'vetted' | 'info_requested', name?: string) => {
      seq += 1;
      const user = await users.save(users.create({ email: `queue.${seq}@example.invalid`, passwordHash: 'x', role: UserRole.GUARD, status: UserStatus.ACTIVE, isEmailVerified: true }));
      const guard = await guards.save(guards.create({
        user, fullName: name ?? `Queue Guard ${seq}`, siaLicenseNumber: String(7100000000000000 + seq), phone: '07700000000',
        siaExpiryDate: stage === 'guard_action' ? null : '2030-01-01', rightToWorkStatus: stage === 'guard_action' ? null : 'British citizen',
      }));
      const verified = stage === 'ready' || stage === 'vetted';
      const status = { not_submitted: ScreeningStatus.IN_PROGRESS, awaiting: ScreeningStatus.READY_FOR_REVIEW, under_review: ScreeningStatus.UNDER_REVIEW, guard_action: ScreeningStatus.UNDER_REVIEW, ready: ScreeningStatus.UNDER_REVIEW, vetted: ScreeningStatus.VETTED, info_requested: ScreeningStatus.REQUIRES_ATTENTION }[stage];
      const screening = await screenings.save(screenings.create({
        guard, status, screeningPeriodYears: 5, legalFullName: guard.fullName, dateOfBirth: '1990-04-12', nationality: 'British',
        submittedAt: stage === 'not_submitted' ? null : new Date(Date.now() - seq * 60000),
        identityVerification: verified ? VerificationState.VERIFIED : VerificationState.UNVERIFIED,
        siaRegisterVerification: verified ? VerificationState.VERIFIED : VerificationState.UNVERIFIED,
        rightToWorkVerification: verified ? VerificationState.VERIFIED : VerificationState.UNVERIFIED,
      }));
      const start = iso(yearsAgo(6));
      const entry = await history.save(history.create({ screening, type: HistoryType.EMPLOYMENT, startDate: start, endDate: null, isCurrent: true, organisation: 'Acme Security Ltd', description: 'Security officer' }));
      await addresses.save(addresses.create({ screening, address: '10 Queue Street, Leeds, LS1 4AP', startDate: start, endDate: null, isCurrent: true, verificationState: verified ? VerificationState.VERIFIED : VerificationState.UNVERIFIED }));
      await references.save(references.create({ screening, history: entry, organisation: 'Acme Security Ltd', contactPerson: 'Jane Referee', relationship: 'Line manager', businessEmail: `referee.${seq}@example.invalid`, status: verified ? ReferenceStatus.VERIFIED : ReferenceStatus.NOT_REQUESTED, sourceVerified: verified }));
      await consents.save(consents.create({ screening, consentVersion: 'S4-PILOT-1', candidateUserId: user.id, acceptedAt: new Date() }));
      // "guard_action" is a Guard who has not uploaded anything: nothing for the reviewer to do.
      if (stage !== 'guard_action') {
        for (const category of [EvidenceCategory.IDENTITY, EvidenceCategory.ADDRESS, EvidenceCategory.SIA, EvidenceCategory.RIGHT_TO_WORK]) {
          await evidence.save(evidence.create({
            screening, category, storageProvider: 's3-compatible', storageKey: `screening/guard/${guard.id}/${String(seq).padStart(8, '0')}-0000-4000-8000-${category.slice(0, 4).padEnd(12, '0')}`,
            originalFileName: `${category}.pdf`, mimeType: 'application/pdf', sizeBytes: '100', uploadCompletedAt: new Date(),
            verificationState: verified ? VerificationState.VERIFIED : VerificationState.UNVERIFIED, uploadedByUserId: user.id,
          }));
        }
      }
      return screening;
    };

    const measure = async (fn: () => Promise<unknown>) => { logger.count = 0; logger.on = true; const out = await fn(); logger.on = false; return { queries: logger.count, out: out as Awaited<ReturnType<ScreeningService['queue']>> }; };
    const bulk = async (n: number, stage: Parameters<typeof seed>[0]) => { for (let i = 0; i < n; i += 1) await seed(stage); };

    // ── One of each lifecycle stage, so the mapping is pinned before scale ────────────────────
    await seed('not_submitted');
    await seed('awaiting', 'Fahad Test');
    await seed('under_review');
    await seed('guard_action');
    await seed('ready');
    await seed('vetted');

    const base = await measure(() => service.queue({ filter: 'all' }));
    const byBucket = (rows: Array<{ bucket: string }>) => rows.reduce<Record<string, number>>((acc, r) => { acc[r.bucket] = (acc[r.bucket] || 0) + 1; return acc; }, {});

    await test('QUEUE-FILTER', async () => {
      assert.deepEqual(byBucket(base.out.rows), { READY_TO_COMPLETE: 1, AWAITING_REVIEW: 1, UNDER_REVIEW: 1, NEEDS_GUARD_ACTION: 1, VETTED: 1, NOT_SUBMITTED: 1 });
      for (const [filter, bucket] of [['awaiting_review', 'AWAITING_REVIEW'], ['under_review', 'UNDER_REVIEW'], ['needs_guard_action', 'NEEDS_GUARD_ACTION'], ['ready_to_complete', 'READY_TO_COMPLETE'], ['vetted', 'VETTED'], ['not_submitted', 'NOT_SUBMITTED']] as const) {
        const r = await service.queue({ filter });
        assert.equal(r.rows.length, 1, `${filter} should return exactly one row`);
        assert.equal(r.rows[0].bucket, bucket);
      }
    });

    await test('QUEUE-NEEDS-REVIEW-COMPOSITE', async () => {
      const r = await service.queue({});
      assert.equal(r.filter, 'needs_review', 'needs_review is the default reviewer workload');
      assert.deepEqual(byBucket(r.rows), { READY_TO_COMPLETE: 1, AWAITING_REVIEW: 1, UNDER_REVIEW: 1 });
      const buckets = r.rows.map((x) => String(x.bucket));
      for (const excluded of ['NEEDS_GUARD_ACTION', 'NOT_SUBMITTED', 'VETTED', 'CLOSED']) assert.ok(!buckets.includes(excluded), `${excluded} must not be in the default workload`);
    });

    await test('QUEUE-NOT-SUBMITTED', async () => {
      const notSubmitted = await service.queue({ filter: 'not_submitted' });
      assert.equal(notSubmitted.rows[0].status, ScreeningStatus.IN_PROGRESS);
      const all = await service.queue({ filter: 'all' });
      assert.ok(all.rows.some((x) => x.bucket === 'NOT_SUBMITTED'), 'not-submitted Guards stay visible under All');
    });

    await test('QUEUE-SORT', async () => {
      const r = await service.queue({ filter: 'all' });
      const rank = ['READY_TO_COMPLETE', 'AWAITING_REVIEW', 'UNDER_REVIEW', 'NEEDS_GUARD_ACTION', 'VETTED', 'CLOSED', 'NOT_SUBMITTED'];
      const seen = r.rows.map((x) => rank.indexOf(x.bucket));
      assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'work the reviewer can finish must sort first');
      const awaiting = await service.queue({ filter: 'all', limit: 200 });
      const waits = awaiting.rows.filter((x) => x.bucket === 'AWAITING_REVIEW').map((x) => x.submittedAt ?? x.updatedAt);
      assert.deepEqual(waits, [...waits].sort(), 'oldest waiting first inside a band');
    });

    await test('QUEUE-SEARCH', async () => {
      const byName = await service.queue({ filter: 'all', q: 'fahad' });
      assert.equal(byName.rows.length, 1);
      assert.equal(byName.rows[0].guardName, 'Fahad Test');
      const byEmail = await service.queue({ filter: 'all', q: byName.rows[0].guardEmail!.split('@')[0] });
      assert.equal(byEmail.rows.length, 1, 'search covers guard email');
      assert.equal((await service.queue({ filter: 'all', q: 'no-such-guard' })).rows.length, 0);
    });

    await test('QUEUE-NO-FULL-APPLICATION', async () => {
      const row = base.out.rows[0] as Record<string, unknown>;
      assert.deepEqual(Object.keys(row).sort(), ['bucket', 'guardEmail', 'guardId', 'guardName', 'id', 'progress', 'ready', 'reviewerActions', 'guardActions', 'status', 'submittedAt', 'updatedAt', 'verificationCompleted', 'verificationTotal'].sort());
      for (const forbidden of ['evidence', 'addresses', 'history', 'references', 'consents', 'exceptions', 'requirements', 'reviewReadiness', 'guard']) {
        assert.ok(!(forbidden in row), `queue row must not carry ${forbidden}`);
      }
    });

    await test('QUEUE-NO-EXCESS-PII', async () => {
      const text = JSON.stringify(base.out.rows);
      for (const leak of ['dateOfBirth', '1990-04-12', 'nationality', 'storageKey', 'passwordHash', 'siaLicenseNumber', 'Queue Street', 'legalFullName']) {
        assert.ok(!text.includes(leak), `queue must not expose ${leak}`);
      }
      assert.ok(text.includes('guardEmail'), 'name and email are the identifying fields a reviewer needs');
    });

    // ── The owner's production case ──────────────────────────────────────────────────────────
    // A reviewer requested information on a file the Guard had already completed. Nothing is
    // outstanding from the Guard, so the row must not claim the Guard is holding it up.
    await test('QUEUE-REQUIRES-ATTENTION-NO-GUARD-WORK', async () => {
      const screening = await seed('info_requested', 'Owner Uat Case');
      const r = await service.queue({ filter: 'all', q: 'Owner Uat Case' });
      const row = r.rows[0];
      assert.equal(row.progress, 100, 'candidate side is complete');
      assert.equal(`${row.verificationCompleted}/${row.verificationTotal}`, '1/6');
      assert.equal(row.reviewerActions, 5, 'identity, address, SIA, RTW and reference are the reviewer\'s');
      assert.equal(row.guardActions, 0, 'the Guard has nothing outstanding');
      assert.equal(row.bucket, 'UNDER_REVIEW', 'bucket must follow actionable state, not a historical status flag');
      assert.ok((await service.queue({})).rows.some((x) => x.id === screening.id), 'and it belongs in the default reviewer workload');
      await screenings.delete(screening.id);
    });

    await test('QUEUE-COUNTS-INDEPENDENT', async () => {
      const filtered = await service.queue({ filter: 'vetted' });
      assert.equal(filtered.rows.length, 1);
      assert.deepEqual(filtered.counts, base.out.counts, 'workload counts must not change with the active filter');
      assert.equal(filtered.counts.needsReview, filtered.counts.awaitingReview + filtered.counts.underReview + filtered.counts.readyToComplete);
      assert.equal(filtered.counts.all, 6);
    });

    // ── Scale: the query count must not track the number of screenings ───────────────────────
    await bulk(44, 'awaiting');
    const at50 = await measure(() => service.queue({ filter: 'all', limit: 200 }));
    await test('QUEUE-50', async () => {
      assert.equal(at50.out.total, 50);
      assert.ok(at50.queries <= 10, `50 screenings took ${at50.queries} queries`);
    });

    await bulk(50, 'awaiting');
    const at100 = await measure(() => service.queue({ filter: 'all', limit: 200 }));
    await test('QUEUE-100', async () => {
      assert.equal(at100.out.total, 100);
      assert.equal(at100.queries, at50.queries, `query count changed between 50 and 100 (${at50.queries} → ${at100.queries})`);
    });

    await bulk(400, 'awaiting');
    const at500 = await measure(() => service.queue({ filter: 'all', limit: 200 }));
    await test('QUEUE-500', async () => {
      assert.equal(at500.out.total, 500);
      assert.equal(at500.queries, at50.queries, `query count changed between 50 and 500 (${at50.queries} → ${at500.queries})`);
    });

    await test('QUEUE-NO-NPLUS1', async () => {
      // The defect this replaces issued one multi-join query per screening. Ten times the data must
      // not cost ten times the statements.
      assert.equal(at500.queries, at50.queries);
      assert.ok(at500.queries <= 10, `expected a constant handful of statements, got ${at500.queries}`);
      const legacy = await measure(() => service.listAdmin());
      assert.ok(legacy.queries > at500.queries * 10, 'the old list endpoint is the N+1 baseline this queue avoids');
    });

    await test('QUEUE-DEFAULT-LIMIT', async () => {
      const defaulted = await service.queue({ filter: 'all' });
      assert.equal(defaulted.limit, 50);
      assert.equal(defaulted.rows.length, 50, 'the queue must cap its own page');
      assert.equal(defaulted.total, 500, 'total still reports the whole filtered set');
      const paged = await service.queue({ filter: 'all', limit: 10, offset: 10 });
      assert.equal(paged.rows.length, 10);
      assert.notEqual(paged.rows[0].id, defaulted.rows[0].id);
    });

    // Payload is reported per served page, since the endpoint caps a page at `limit`; the whole-set
    // figure is what an uncapped queue of that size would cost on the wire.
    const payload = (rows: unknown[]) => Buffer.byteLength(JSON.stringify(rows));
    const bytesPerRow = Math.round(payload(at500.out.rows) / at500.out.rows.length);
    console.log(JSON.stringify({
      event: 'screening_queue_tests_passed',
      tests: passed,
      queriesAt50: at50.queries, queriesAt100: at100.queries, queriesAt500: at500.queries,
      bytesPerRow,
      defaultPageBytes: payload((await service.queue({ filter: 'all' })).rows),
      wholeSetBytes: { at50: bytesPerRow * 50, at100: bytesPerRow * 100, at500: bytesPerRow * 500 },
    }));
  } finally {
    await dataSource.destroy();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
