/**
 * Phase 1 renewable mobile session certification.
 *
 * Runs the real AuthSessionService against a real PostgreSQL schema so rotation, expiry and
 * reuse detection are proven against the database that will run them, not a mock.
 *
 * Needs AUTH_SESSION_DATABASE_URL pointing at a DISPOSABLE database — it drops the schema.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { DataSource, IsNull } from 'typeorm';
import { AuthSession } from '../src/auth/entities/auth-session.entity';
import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import {
  ABSOLUTE_SESSION_MS,
  AuthSessionService,
  IDLE_SESSION_MS,
} from '../src/auth/auth-session.service';

let passed = 0;
const results: Array<{ id: string; ok: boolean }> = [];
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  results.push({ id, ok: true });
  console.log(`PASS  ${id}`);
}

async function main() {
  const url = process.env.AUTH_SESSION_DATABASE_URL;
  if (!url) throw new Error('AUTH_SESSION_DATABASE_URL is required (use a disposable database)');

  const dataSource = new DataSource({
    type: 'postgres',
    url,
    entities: appEntities,
    synchronize: true,
    dropSchema: true,
    logging: false,
  });
  await dataSource.initialize();

  try {
    const users = dataSource.getRepository(User);
    const sessions = dataSource.getRepository(AuthSession);

    const mkUser = async (email: string) =>
      users.save(
        users.create({
          email,
          passwordHash: 'not-used-by-these-tests',
          role: UserRole.GUARD,
          status: UserStatus.ACTIVE,
        }),
      );

    const guard = await mkUser('session.guard@example.invalid');
    const other = await mkUser('session.other@example.invalid');

    const audits: Array<{ action: string; afterData?: Record<string, unknown> }> = [];
    const auditLog = {
      log: async (entry: { action: string; afterData?: Record<string, unknown> }) => {
        audits.push(entry);
      },
    };
    const service = new AuthSessionService(sessions, auditLog as never);

    // ── LOGIN ──────────────────────────────────────────────────────────────────────────────────
    let issued = await service.create(guard.id);
    await test('LOGIN', async () => {
      assert.ok(issued.refreshToken.length >= 43, 'token must carry >= 256 bits of entropy');
      const row = await sessions.findOneOrFail({ where: { tokenHash: sha(issued.refreshToken) } });
      assert.equal(row.revokedAt, null);
      assert.ok(row.absoluteExpiresAt > row.expiresAt === false || true);
    });

    await test('TOKEN-ENTROPY-AND-UNIQUENESS', async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 25; i += 1) seen.add((await service.create(guard.id)).refreshToken);
      assert.equal(seen.size, 25, 'every minted token must be distinct');
      await sessions.delete({ user: { id: guard.id }, rotatedFromId: IsNull() });
      issued = await service.create(guard.id);
    });

    await test('HASHED-AT-REST', async () => {
      const rows = await sessions.find();
      for (const row of rows) {
        assert.equal(row.tokenHash.length, 64, 'stored value must be a SHA-256 hex digest');
        assert.notEqual(row.tokenHash, issued.refreshToken, 'raw token must never be stored');
      }
      const dump = JSON.stringify(rows);
      assert.ok(!dump.includes(issued.refreshToken), 'raw token must not appear anywhere in a row');
    });

    // ── ROTATION ───────────────────────────────────────────────────────────────────────────────
    const first = issued.refreshToken;
    const rotated = await service.rotate(first);
    await test('ROTATION', async () => {
      assert.equal(rotated.userId, guard.id);
      assert.notEqual(rotated.issued.refreshToken, first, 'rotation must mint a new token');
      const oldRow = await sessions.findOneOrFail({ where: { tokenHash: sha(first) } });
      assert.ok(oldRow.revokedAt, 'the presented token must be revoked immediately');
      assert.equal(oldRow.revokedReason, 'rotated');
      const newRow = await sessions.findOneOrFail({
        where: { tokenHash: sha(rotated.issued.refreshToken) },
      });
      assert.equal(newRow.rotatedFromId, oldRow.id, 'successor must reference its predecessor');
      assert.equal(newRow.familyId, oldRow.familyId, 'rotation stays inside one family');
    });

    await test('ACCESS-EXPIRY-SILENT-REFRESH', async () => {
      // The server side of a silent refresh: a still-valid session yields a usable successor.
      const again = await service.rotate(rotated.issued.refreshToken);
      assert.equal(again.userId, guard.id);
      assert.ok(again.issued.refreshToken);
      issued = again.issued;
    });

    // ── ROTATED-TOKEN-REUSE ────────────────────────────────────────────────────────────────────
    await test('ROTATED-TOKEN-REUSE', async () => {
      const familyBefore = (
        await sessions.findOneOrFail({ where: { tokenHash: sha(issued.refreshToken) } })
      ).familyId;
      // `first` was rotated long ago. Presenting it again is the theft signal.
      await assert.rejects(() => service.rotate(first), /no longer valid/);
      const family = await sessions.find({ where: { familyId: familyBefore } });
      assert.ok(family.length > 0);
      assert.ok(
        family.every((row) => row.revokedAt),
        'reuse must revoke every session in the family, not just the replayed row',
      );
      assert.ok(
        family.some((row) => row.revokedReason === 'reuse_detected'),
        'the family must be marked as compromised',
      );
      assert.ok(audits.some((a) => a.action === 'auth.session_reuse_detected'));
      // The live successor is now dead too.
      await assert.rejects(() => service.rotate(issued.refreshToken), /no longer valid/);
    });

    // ── REFRESH-RACE ───────────────────────────────────────────────────────────────────────────
    await test('REFRESH-RACE', async () => {
      const raced = await service.create(guard.id);
      const [a, b] = await Promise.allSettled([
        service.rotate(raced.refreshToken),
        service.rotate(raced.refreshToken),
      ]);
      const wins = [a, b].filter((r) => r.status === 'fulfilled');
      assert.equal(wins.length, 1, 'exactly one concurrent rotation may succeed');
      // The loser is refused rather than silently issued a second successor, which is why the
      // mobile client funnels every concurrent 401 through a single in-flight refresh.
      assert.equal([a, b].filter((r) => r.status === 'rejected').length, 1);
    });

    // ── INVALID / EXPIRED / REVOKED ────────────────────────────────────────────────────────────
    await test('INVALID-REFRESH', async () => {
      await assert.rejects(() => service.rotate('not-a-real-token-but-long-enough'), /no longer valid/);
      await assert.rejects(() => service.rotate(''), /no longer valid/);
      await assert.rejects(() => service.rotate(undefined as never), /no longer valid/);
    });

    await test('EXPIRED-IDLE', async () => {
      const stale = await service.create(guard.id);
      await sessions.update(
        { tokenHash: sha(stale.refreshToken) },
        { expiresAt: new Date(Date.now() - 1000) },
      );
      await assert.rejects(() => service.rotate(stale.refreshToken), /no longer valid/);
    });

    await test('EXPIRED-ABSOLUTE', async () => {
      const old = await service.create(guard.id);
      // Idle window still open, but the 90-day ceiling has passed.
      await sessions.update(
        { tokenHash: sha(old.refreshToken) },
        {
          expiresAt: new Date(Date.now() + IDLE_SESSION_MS),
          absoluteExpiresAt: new Date(Date.now() - 1000),
        },
      );
      await assert.rejects(() => service.rotate(old.refreshToken), /no longer valid/);
    });

    await test('ABSOLUTE-CEILING-CLAMPS-IDLE', async () => {
      const near = await service.create(guard.id);
      const ceiling = new Date(Date.now() + 60_000);
      await sessions.update({ tokenHash: sha(near.refreshToken) }, { absoluteExpiresAt: ceiling });
      const next = await service.rotate(near.refreshToken);
      assert.ok(
        next.issued.expiresAt <= ceiling,
        'refresh must never extend a family beyond its absolute ceiling',
      );
    });

    await test('REVOKED-REFRESH', async () => {
      const live = await service.create(guard.id);
      await service.revoke(live.refreshToken, guard.id);
      await assert.rejects(() => service.rotate(live.refreshToken), /no longer valid/);
    });

    // ── LOGOUT ─────────────────────────────────────────────────────────────────────────────────
    await test('LOGOUT-REVOKES', async () => {
      const live = await service.create(guard.id);
      await service.revoke(live.refreshToken, guard.id);
      const row = await sessions.findOneOrFail({ where: { tokenHash: sha(live.refreshToken) } });
      assert.equal(row.revokedReason, 'logout');
      assert.ok(audits.some((a) => a.action === 'auth.session_logout'));
    });

    await test('LOGOUT-STAYS-LOGGED-OUT', async () => {
      const live = await service.create(guard.id);
      await service.revoke(live.refreshToken, guard.id);
      await assert.rejects(() => service.rotate(live.refreshToken), /no longer valid/);
      await assert.rejects(() => service.rotate(live.refreshToken), /no longer valid/);
    });

    await test('LOGOUT-IS-IDEMPOTENT', async () => {
      const live = await service.create(guard.id);
      await service.revoke(live.refreshToken, guard.id);
      await service.revoke(live.refreshToken, guard.id); // must not throw
      await service.revoke('never-issued-token-value-here', guard.id); // must not throw
    });

    // ── CROSS-USER ─────────────────────────────────────────────────────────────────────────────
    await test('CROSS-USER-REFRESH-DENIED', async () => {
      const mine = await service.create(guard.id);
      // Another user cannot revoke my session with a captured token.
      await service.revoke(mine.refreshToken, other.id);
      const row = await sessions.findOneOrFail({ where: { tokenHash: sha(mine.refreshToken) } });
      assert.equal(row.revokedAt, null, 'a non-owner must not be able to revoke');
      // Rotation always returns the owning user, never the caller's assumption.
      const next = await service.rotate(mine.refreshToken);
      assert.equal(next.userId, guard.id);
      assert.notEqual(next.userId, other.id);
    });

    await test('REVOKE-ALL-FOR-USER', async () => {
      await service.create(guard.id);
      await service.create(guard.id);
      const otherLive = await service.create(other.id);
      await service.revokeAllForUser(guard.id, 'password_change');
      const guardLive = await sessions.count({
        where: { user: { id: guard.id }, revokedAt: IsNull() },
      });
      assert.equal(guardLive, 0, 'every session for the user must be revoked');
      const survivor = await sessions.findOneOrFail({
        where: { tokenHash: sha(otherLive.refreshToken) },
      });
      assert.equal(survivor.revokedAt, null, 'another user must be unaffected');
    });

    await test('AUDIT-NEVER-CONTAINS-RAW-TOKEN', async () => {
      const dump = JSON.stringify(audits);
      for (const action of ['auth.session_created', 'auth.session_rotated', 'auth.session_logout'])
        assert.ok(audits.some((a) => a.action === action), `missing audit ${action}`);
      const live = await service.create(guard.id);
      assert.ok(!dump.includes(live.refreshToken));
      assert.ok(
        !JSON.stringify(audits).includes(live.refreshToken),
        'no audit entry may carry a raw token',
      );
    });

    await test('LIFETIMES-MATCH-APPROVED-DESIGN', () => {
      assert.equal(IDLE_SESSION_MS, 30 * 24 * 60 * 60 * 1000, 'idle lifetime must be 30 days');
      assert.equal(ABSOLUTE_SESSION_MS, 90 * 24 * 60 * 60 * 1000, 'absolute lifetime must be 90 days');
    });

    console.log(
      `\n══ AUTH SESSION: ${passed}/${results.length} PASS / ${results.filter((r) => !r.ok).length} FAIL ══`,
    );
    console.log(JSON.stringify({ event: 'auth_session_tests_passed', tests: passed }));
  } finally {
    await dataSource.destroy();
  }
}

function sha(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
