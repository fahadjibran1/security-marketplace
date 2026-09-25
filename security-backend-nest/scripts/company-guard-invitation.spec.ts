/**
 * Phase B certification: consent-based company workforce invitations.
 *
 * A company must be able to bring its own guards onto S4 without S4 screening, and must NOT be able
 * to attach an existing guard silently. The guard's acceptance of a one-time code is the consent.
 *
 * Runs the real CompanyGuardInvitationService against real PostgreSQL, because what matters here is
 * company-scoped SQL filtering, a row lock that makes acceptance atomic, and what actually lands in
 * the invitation and audit tables. A repository fake cannot demonstrate any of those.
 *
 * Needs PHASEB_DATABASE_URL pointing at a DISPOSABLE database — it drops the schema.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardApprovalStatus, GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Company } from '../src/company/entities/company.entity';
import {
  CompanyGuard,
  CompanyGuardRelationshipType,
  CompanyGuardStatus,
} from '../src/company-guard/entities/company-guard.entity';
import { CompanyGuardInvitation } from '../src/company-guard/entities/company-guard-invitation.entity';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { CompanyMembership } from '../src/company-membership/entities/company-membership.entity';
import {
  CompanyMembershipRole,
  CompanyMembershipStatus,
} from '../src/company-membership/company-membership-types';
import { CompanyMembershipService } from '../src/company-membership/company-membership.service';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import {
  CompanyGuardInvitationService,
  COMPANY_MANAGED_RESPONSIBILITY_STATEMENT,
  INVITATION_TTL_MS,
} from '../src/company-guard/company-guard-invitation.service';
import { GuardScreening, ScreeningStatus } from '../src/screening/entities/screening.entities';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

async function expectRejection(
  id: string,
  fn: () => Promise<unknown>,
  ctor: new (...args: never[]) => Error,
  message?: RegExp,
) {
  await test(id, async () => {
    await assert.rejects(fn, (error: unknown) => {
      assert.ok(error instanceof ctor, `expected ${ctor.name}, got ${error}`);
      if (message) assert.match((error as Error).message, message);
      return true;
    });
  });
}

const jwt = (id: number, role: UserRole) =>
  ({ sub: id, email: `u${id}@example.invalid`, role, status: UserStatus.ACTIVE }) as never;

async function main() {
  const url = process.env.PHASEB_DATABASE_URL;
  if (!url) throw new Error('PHASEB_DATABASE_URL is required (use a disposable database)');

  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities,
    synchronize: true, dropSchema: true, logging: false,
  });
  await ds.initialize();

  try {
    const users = ds.getRepository(User);
    const guards = ds.getRepository(GuardProfile);
    const companies = ds.getRepository(Company);
    const links = ds.getRepository(CompanyGuard);
    const invitations = ds.getRepository(CompanyGuardInvitation);
    const memberships = ds.getRepository(CompanyMembership);
    const audits = ds.getRepository(AuditLog);
    const screenings = ds.getRepository(GuardScreening);

    // ── real services ─────────────────────────────────────────────────────────
    const membership = new CompanyMembershipService(
      memberships,
      { findByUserId: async (id: number) => companies.findOne({ where: { user: { id } }, relations: ['user'] }) } as never,
    );
    const auditLog = new AuditLogService(audits, membership);
    const guardProfileService = {
      findByUserId: async (userId: number) => guards.findOne({ where: { user: { id: userId } } }),
    } as never;
    const service = new CompanyGuardInvitationService(
      invitations, links, membership, guardProfileService, auditLog, ds,
    );

    // ── fixture ───────────────────────────────────────────────────────────────
    const makeCompany = async (label: string, number: string) => {
      const owner = await users.save(users.create({
        email: `${label}.owner@example.invalid`, passwordHash: 'x',
        role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE, isEmailVerified: true,
      }));
      return companies.save(companies.create({
        user: owner, name: `${label.toUpperCase()} Security Ltd`, companyNumber: number,
        address: `1 ${label} Way`, contactDetails: `ops@${label}.example.invalid`,
      }));
    };

    let sia = 7400000000000000;
    const makeGuard = async (label: string) => {
      const user = await users.save(users.create({
        email: `${label}@example.invalid`, passwordHash: 'x',
        role: UserRole.GUARD, status: UserStatus.ACTIVE, isEmailVerified: true,
      }));
      sia += 1;
      const guard = await guards.save(guards.create({
        user, fullName: `${label} Guard`, siaLicenseNumber: String(sia),
        siaExpiryDate: '2030-01-01', rightToWorkStatus: 'british', phone: '07000000000',
        // Registration defaults: unapproved and unscreened must not block workforce membership.
        status: 'pending', approvalStatus: GuardApprovalStatus.PENDING, isApproved: false,
      }));
      return { guard, user };
    };

    const staffFor = async (company: Company, label: string, role: CompanyMembershipRole) => {
      const user = await users.save(users.create({
        email: `${label}@example.invalid`, passwordHash: 'x',
        role: UserRole.COMPANY_STAFF, status: UserStatus.ACTIVE, isEmailVerified: true,
      }));
      await memberships.save(memberships.create({
        userId: user.id, companyId: company.id, membershipRole: role,
        status: CompanyMembershipStatus.ACTIVE, invitedByUserId: company.user.id,
      }));
      return jwt(user.id, UserRole.COMPANY_STAFF);
    };

    const abc = await makeCompany('abc', '11111111');
    const xyz = await makeCompany('xyz', '22222222');
    const abcOwner = jwt(abc.user.id, UserRole.COMPANY_ADMIN);
    const xyzOwner = jwt(xyz.user.id, UserRole.COMPANY_ADMIN);

    // ══ INVITATION CREATION ═══════════════════════════════════════════════════

    let firstCode = '';
    let firstInvitationId = 0;
    await test('B-CREATE-PERMITTED: an owner can issue an invitation', async () => {
      const result = await service.createForCompanyUser(abcOwner, {
        relationshipType: CompanyGuardRelationshipType.EMPLOYEE,
      });
      firstCode = result.code;
      firstInvitationId = result.invitation.id;
      assert.ok(result.code.length >= 40, 'the code must be a 256-bit token, not a short string');
      assert.equal(result.invitation.state, 'PENDING');
      assert.equal(result.invitation.relationshipType, CompanyGuardRelationshipType.EMPLOYEE);
      assert.equal(result.responsibilityStatement, COMPANY_MANAGED_RESPONSIBILITY_STATEMENT);
    });

    await test('B-CREATE-PERMITTED-STAFF: operations staff can issue', async () => {
      const staff = await staffFor(abc, 'abc.ops', CompanyMembershipRole.OPERATIONS);
      const result = await service.createForCompanyUser(staff, {});
      assert.equal(result.invitation.state, 'PENDING');
      assert.equal(
        result.invitation.relationshipType,
        CompanyGuardRelationshipType.APPROVED_CONTRACTOR,
        'the default relationship type applies when none is given',
      );
    });

    for (const role of [CompanyMembershipRole.VIEWER, CompanyMembershipRole.FINANCE, CompanyMembershipRole.CONTROL_ROOM]) {
      await expectRejection(
        `B-CREATE-DENIED: ${role} lacks guards.manage`,
        async () => {
          const staff = await staffFor(abc, `abc.create.${role}`, role);
          return service.createForCompanyUser(staff, {});
        },
        ForbiddenException,
        /Insufficient permissions/,
      );
    }

    await test('B-CREATE-COMPANY-FROM-CONTEXT-NOT-BODY', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const dto = readFileSync(join(__dirname, '..', 'src', 'company-guard/dto/create-company-guard-invitation.dto.ts'), 'utf8');
      // A declared property, not the comment that explains its absence.
      assert.doesNotMatch(dto, /^\s*companyId[?!]?\s*:/m, 'the DTO must not declare a company id');
      const svc = readFileSync(join(__dirname, '..', 'src', 'company-guard/company-guard-invitation.service.ts'), 'utf8');
      const body = svc.split('async createForCompanyUser(')[1].split('async listForCompanyUser(')[0];
      assert.match(body, /resolveCompanyContext/, 'company must come from the membership matrix');
      assert.match(body, /GUARDS_MANAGE/);
      // The global ValidationPipe rejects unknown properties, so an injected companyId is a 400.
      const row = await invitations.findOneOrFail({ where: { id: firstInvitationId } });
      assert.equal(row.companyId, abc.id);
    });

    await test('B-DIGEST-STORED-NEVER-PLAINTEXT', async () => {
      const row = await invitations.findOneOrFail({ where: { id: firstInvitationId } });
      assert.equal(row.tokenDigest.length, 64, 'digest must be 64 hex characters');
      assert.equal(
        row.tokenDigest,
        createHash('sha256').update(firstCode).digest('hex'),
        'stored digest must be SHA-256 of the issued code',
      );
      // Prove the plaintext appears nowhere in the row, under any column.
      const raw = await ds.query(
        `SELECT row_to_json(t)::text AS j FROM company_guard_invitations t WHERE id = $1`,
        [firstInvitationId],
      );
      assert.ok(!raw[0].j.includes(firstCode), 'plaintext code must not be persisted anywhere');
    });

    await test('B-EXPIRY-SET-TO-SEVEN-DAYS', async () => {
      // Measured against the application clock, which is the clock that decides expiry: stateOf()
      // compares expiresAt with a JS Date. Deliberately NOT against the database-generated createdAt —
      // that mixes a NOW() from the server with a Date from the process, so it reports the host's UTC
      // offset rather than the TTL. Production pins TZ=UTC (see deploy-manifest), and no SQL in this
      // workflow compares expiresAt to NOW().
      const issuedAt = Date.now();
      const { invitation } = await service.createForCompanyUser(abcOwner, {});
      const row = await invitations.findOneOrFail({ where: { id: invitation.id } });
      const delta = row.expiresAt.getTime() - issuedAt;
      assert.ok(
        Math.abs(delta - INVITATION_TTL_MS) < 60_000,
        `expiry should be ~7 days from issue, got ${delta}ms`,
      );
      assert.equal(CompanyGuardInvitationService.stateOf(row), 'PENDING', 'and is in the future');
    });

    await test('B-AUDIT-CREATION-HAS-STATEMENT-AND-NO-TOKEN', async () => {
      const row = await audits.findOneOrFail({
        where: { action: 'company_guard_invitation.created', entityId: firstInvitationId },
      });
      const payload = JSON.stringify(row.afterData);
      assert.match(payload, /responsibilityStatement/);
      assert.ok(payload.includes('manages its own employment, screening and deployment compliance'));
      assert.ok(!payload.includes(firstCode), 'plaintext code must never reach the audit trail');
      const digest = createHash('sha256').update(firstCode).digest('hex');
      assert.ok(!payload.includes(digest), 'the full digest must not be in the audit payload either');
      assert.equal(row.company?.id, abc.id);
      assert.equal(row.user?.id, abc.user.id);
    });

    await expectRejection(
      'B-CREATE-REJECTS-MALFORMED-TARGET-LICENCE',
      () => service.createForCompanyUser(abcOwner, { targetSiaLicenceNumber: '12345' }),
      BadRequestException,
      /16 numeric digits/,
    );

    // ══ LIST / TENANCY ════════════════════════════════════════════════════════

    await test('B-LIST-COMPANY-SCOPED', async () => {
      await service.createForCompanyUser(xyzOwner, {});
      const abcRows = await service.listForCompanyUser(abcOwner);
      const xyzRows = await service.listForCompanyUser(xyzOwner);
      assert.ok(abcRows.length >= 2, 'ABC sees its own invitations');
      assert.equal(xyzRows.length, 1, 'XYZ sees only its own');
      const abcIds = new Set(abcRows.map((r) => r.id));
      assert.ok(!xyzRows.some((r) => abcIds.has(r.id)), 'no cross-company leakage');
    });

    await test('B-LIST-NEVER-EXPOSES-TOKEN-MATERIAL', async () => {
      const rows = await service.listForCompanyUser(abcOwner);
      const serialised = JSON.stringify(rows);
      assert.ok(!serialised.includes('tokenDigest'), 'tokenDigest must not appear in the projection');
      assert.ok(!serialised.includes(firstCode), 'the plaintext code must not appear');
      rows.forEach((r) => {
        assert.ok(!('tokenDigest' in (r as Record<string, unknown>)));
        assert.ok(!('code' in (r as Record<string, unknown>)));
      });
    });

    await test('B-LIST-PERMITTED-FOR-READ-ONLY-ROLE', async () => {
      const viewer = await staffFor(abc, 'abc.list.viewer', CompanyMembershipRole.VIEWER);
      const rows = await service.listForCompanyUser(viewer);
      assert.ok(rows.length >= 2, 'guards.view is enough to read the list');
    });

    await expectRejection(
      'B-CROSS-COMPANY-REVOKE-DENIED',
      () => service.revokeForCompanyUser(xyzOwner, firstInvitationId),
      NotFoundException,
      /not found/i,
    );

    await test('B-CROSS-COMPANY-REVOKE-LEFT-ROW-UNTOUCHED', async () => {
      const row = await invitations.findOneOrFail({ where: { id: firstInvitationId } });
      assert.equal(row.revokedAt, null, 'the failed cross-company revoke must not have changed it');
      assert.equal(row.revokedByUserId, null);
    });

    // ══ PREVIEW ═══════════════════════════════════════════════════════════════

    const { guard: gAlpha, user: uAlpha } = await makeGuard('alpha');
    const alpha = jwt(uAlpha.id, UserRole.GUARD);

    await test('B-PREVIEW-VALID-SHOWS-ONLY-CONSENT-FACTS', async () => {
      const preview = await service.previewForGuardUser(alpha, { code: firstCode });
      assert.equal(preview.companyName, 'ABC Security Ltd');
      assert.equal(preview.relationshipType, CompanyGuardRelationshipType.EMPLOYEE);
      assert.ok(preview.expiresAt instanceof Date);
      assert.equal(preview.alreadyInWorkforce, false);
      const keys = Object.keys(preview).sort();
      assert.deepEqual(keys, ['alreadyInWorkforce', 'companyName', 'expiresAt', 'relationshipType'],
        'the preview must not carry internal company records');
    });

    const GENERIC = /That invitation code is not valid\./;

    await expectRejection('B-PREVIEW-UNKNOWN-CODE-FAILS-GENERICALLY',
      () => service.previewForGuardUser(alpha, { code: 'not-a-real-code-at-all' }), NotFoundException, GENERIC);

    await test('B-PREVIEW-EXPIRED-FAILS', async () => {
      const { code, invitation } = await service.createForCompanyUser(abcOwner, {});
      await invitations.update({ id: invitation.id }, { expiresAt: new Date(Date.now() - 1000) });
      await assert.rejects(() => service.previewForGuardUser(alpha, { code }), (e: unknown) => {
        assert.ok(e instanceof NotFoundException);
        assert.match((e as Error).message, GENERIC);
        return true;
      });
    });

    await test('B-PREVIEW-REVOKED-FAILS', async () => {
      const { code, invitation } = await service.createForCompanyUser(abcOwner, {});
      await service.revokeForCompanyUser(abcOwner, invitation.id);
      await assert.rejects(() => service.previewForGuardUser(alpha, { code }), (e: unknown) => {
        assert.match((e as Error).message, GENERIC);
        return true;
      });
    });

    await test('B-PREVIEW-FAILURE-IS-AUDITED-BY-DIGEST-PREFIX-ONLY', async () => {
      const before = await audits.count({ where: { action: 'company_guard_invitation.preview_failed' } });
      await assert.rejects(() => service.previewForGuardUser(alpha, { code: 'another-bad-code' }));
      const after = await audits.find({
        where: { action: 'company_guard_invitation.preview_failed' },
        order: { id: 'DESC' }, take: 1,
      });
      assert.ok(after.length === 1 && before >= 0);
      const payload = JSON.stringify(after[0].afterData);
      assert.ok(!payload.includes('another-bad-code'), 'the attempted plaintext must not be recorded');
      assert.match(payload, /tokenDigestPrefix/);
      const prefix = (after[0].afterData as Record<string, string>).tokenDigestPrefix;
      assert.equal(prefix.length, 8, 'only a short digest prefix is retained');
    });

    await test('B-GUARD-ENDPOINTS-ARE-GUARD-ONLY-AND-THROTTLED', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const controller = readFileSync(join(__dirname, '..', 'src', 'company-guard/company-guard-invitation.controller.ts'), 'utf8');
      const guardSide = controller.split('class GuardWorkforceInvitationController')[1];
      for (const route of ['preview', 'accept', 'decline']) {
        const block = guardSide.split(`@Post('${route}')`)[1].split('  }')[0];
        assert.match(block, /@Roles\(UserRole\.GUARD\)/, `${route} must be guard-only`);
        assert.match(block, /AuthThrottlerGuard/, `${route} must be throttled`);
        assert.match(block, /@Throttle\(/, `${route} must declare a rate limit`);
      }
      // The class-level guards sit above the class declaration, so assert against the whole file.
      assert.match(
        controller,
        /@Controller\('guards\/me\/invitations'\)\s*@UseGuards\(JwtAuthGuard, RolesGuard\)\s*export class GuardWorkforceInvitationController/,
        'the guard-facing controller must be authenticated at class level',
      );
      assert.match(
        controller,
        /@Controller\('company-guards\/invitations'\)\s*@UseGuards\(JwtAuthGuard, RolesGuard\)/,
        'the company-facing controller must be authenticated at class level',
      );
    });

    // ══ ACCEPTANCE ════════════════════════════════════════════════════════════

    await test('B-ACCEPT-CREATES-ACTIVE-RELATIONSHIP', async () => {
      const result = await service.acceptForGuardUser(alpha, { code: firstCode });
      assert.equal(result.status, CompanyGuardStatus.ACTIVE);
      assert.equal(result.relationshipType, CompanyGuardRelationshipType.EMPLOYEE,
        'relationshipType is copied from the invitation');
      assert.ok(result.acceptedAt instanceof Date);

      const relation = await links.findOneOrFail({
        where: { company: { id: abc.id }, guard: { id: gAlpha.id } },
      });
      assert.equal(relation.status, CompanyGuardStatus.ACTIVE);
      assert.equal(relation.relationshipType, CompanyGuardRelationshipType.EMPLOYEE);
      assert.ok(relation.acceptedAt, 'acceptedAt must be recorded on the relationship');
      assert.equal(relation.invitationId, firstInvitationId, 'the consent trail links to the invitation');

      const invitation = await invitations.findOneOrFail({ where: { id: firstInvitationId } });
      assert.ok(invitation.usedAt, 'usedAt must be recorded');
      assert.equal(CompanyGuardInvitationService.stateOf(invitation), 'ACCEPTED');
    });

    await test('B-ACCEPT-NEEDS-NO-SCREENING-NO-APPROVAL-NO-COMPLIANCE', async () => {
      // The guard who just joined has: no screening record, approvalStatus pending, isApproved false,
      // and no compliance evidence of any kind for that company.
      assert.equal(await screenings.count({ where: { guard: { id: gAlpha.id } } }), 0);
      const row = await guards.findOneOrFail({ where: { id: gAlpha.id } });
      assert.equal(row.approvalStatus, GuardApprovalStatus.PENDING);
      assert.equal(row.isApproved, false);
      assert.equal(row.status, 'pending');
      // And the workflow source consults none of those gates.
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const svc = readFileSync(join(__dirname, '..', 'src', 'company-guard/company-guard-invitation.service.ts'), 'utf8');
      // Call sites, not bare names: the service comments state plainly that these gates are absent.
      assert.doesNotMatch(svc, /\.assertGuardAssignable\(/);
      assert.doesNotMatch(svc, /\.isGuardVetted\(/);
      assert.doesNotMatch(svc, /\.getBlockingReasons\(/);
      assert.doesNotMatch(svc, /approvalStatus/);
      assert.doesNotMatch(svc, /isApproved/);
    });

    await test('B-ACCEPT-WITH-SCREENING-IN-PROGRESS-IS-UNAFFECTED', async () => {
      const { guard, user } = await makeGuard('inprogress');
      await screenings.save(screenings.create({
        guard, status: ScreeningStatus.UNDER_REVIEW, screeningPeriodYears: 5,
      }));
      const { code } = await service.createForCompanyUser(abcOwner, {});
      const result = await service.acceptForGuardUser(jwt(user.id, UserRole.GUARD), { code });
      assert.equal(result.status, CompanyGuardStatus.ACTIVE);
    });

    await test('B-ACCEPT-AUDITED', async () => {
      const row = await audits.findOneOrFail({
        where: { action: 'company_guard_invitation.accepted', entityId: firstInvitationId },
      });
      assert.equal(row.company?.id, abc.id);
      assert.equal(row.user?.id, uAlpha.id);
      const payload = JSON.stringify(row.afterData);
      assert.match(payload, /"guardId":/);
      assert.match(payload, /"companyGuardId":/);
      assert.ok(!payload.includes(firstCode), 'no plaintext token in the acceptance audit');
    });

    // ══ REPLAY / RACE ═════════════════════════════════════════════════════════

    await expectRejection('B-REPLAY-SAME-CODE-REJECTED',
      () => service.acceptForGuardUser(alpha, { code: firstCode }), NotFoundException, GENERIC);

    await test('B-REPLAY-CREATED-NO-DUPLICATE-RELATIONSHIP', async () => {
      const count = await links.count({ where: { company: { id: abc.id }, guard: { id: gAlpha.id } } });
      assert.equal(count, 1, 'the unique (company, guard) pair remains authoritative');
    });

    await test('B-CONCURRENT-ACCEPT-CONSUMES-ONCE', async () => {
      const { guard, user } = await makeGuard('race');
      const { code } = await service.createForCompanyUser(abcOwner, {});
      const actor = jwt(user.id, UserRole.GUARD);
      // Both start before either commits; the row lock must serialise them.
      const results = await Promise.allSettled([
        service.acceptForGuardUser(actor, { code }),
        service.acceptForGuardUser(actor, { code }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1, `exactly one acceptance may succeed, got ${fulfilled.length}`);
      assert.equal(rejected.length, 1, 'the loser must be rejected, not silently duplicated');
      const count = await links.count({ where: { company: { id: abc.id }, guard: { id: guard.id } } });
      assert.equal(count, 1, 'no duplicate relationship row');
    });

    await test('B-ACCEPT-IS-ATOMIC-ON-FAILURE', async () => {
      // A guard blocked by the company: acceptance must fail and leave the code unconsumed, so the
      // company can lift the block and the same code still works.
      const { guard, user } = await makeGuard('blocked');
      await links.save(links.create({
        company: abc, guard, status: CompanyGuardStatus.BLOCKED,
        relationshipType: CompanyGuardRelationshipType.APPROVED_CONTRACTOR,
      }));
      const { code, invitation } = await service.createForCompanyUser(abcOwner, {});
      await assert.rejects(
        () => service.acceptForGuardUser(jwt(user.id, UserRole.GUARD), { code }),
        ForbiddenException,
      );
      const row = await invitations.findOneOrFail({ where: { id: invitation.id } });
      assert.equal(row.usedAt, null, 'a failed acceptance must not consume the code');
      assert.equal(CompanyGuardInvitationService.stateOf(row), 'PENDING');
      const relation = await links.findOneOrFail({ where: { company: { id: abc.id }, guard: { id: guard.id } } });
      assert.equal(relation.status, CompanyGuardStatus.BLOCKED, 'the block must be untouched');
      assert.equal(relation.acceptedAt, null, 'no consent recorded on a refused acceptance');
    });

    // ══ EXISTING RELATIONSHIPS ════════════════════════════════════════════════

    await test('B-EXISTING-INACTIVE-IS-REACTIVATED', async () => {
      const { guard, user } = await makeGuard('inactive');
      const existing = await links.save(links.create({
        company: abc, guard, status: CompanyGuardStatus.INACTIVE,
        relationshipType: CompanyGuardRelationshipType.APPROVED_CONTRACTOR,
      }));
      const { code, invitation } = await service.createForCompanyUser(abcOwner, {
        relationshipType: CompanyGuardRelationshipType.EMPLOYEE,
      });
      const result = await service.acceptForGuardUser(jwt(user.id, UserRole.GUARD), { code });
      assert.equal(result.status, CompanyGuardStatus.ACTIVE);
      const after = await links.findOneOrFail({ where: { id: existing.id } });
      assert.equal(after.status, CompanyGuardStatus.ACTIVE, 'reactivated in place');
      assert.equal(after.relationshipType, CompanyGuardRelationshipType.EMPLOYEE, 'type refreshed from the invitation');
      assert.equal(after.invitationId, invitation.id);
      assert.ok(after.acceptedAt);
      const count = await links.count({ where: { company: { id: abc.id }, guard: { id: guard.id } } });
      assert.equal(count, 1, 'reused, not duplicated');
      const audit = await audits.findOneOrFail({
        where: { action: 'company_guard_invitation.accepted', entityId: invitation.id },
      });
      assert.match(JSON.stringify(audit.afterData), /"reactivated":true/);
    });

    await test('B-EXISTING-ACTIVE-IS-IDEMPOTENT-AND-SAFE', async () => {
      const { guard, user } = await makeGuard('already');
      const existing = await links.save(links.create({
        company: abc, guard, status: CompanyGuardStatus.ACTIVE,
        relationshipType: CompanyGuardRelationshipType.PREFERRED,
      }));
      const { code, invitation } = await service.createForCompanyUser(abcOwner, {
        relationshipType: CompanyGuardRelationshipType.EMPLOYEE,
      });
      const result = await service.acceptForGuardUser(jwt(user.id, UserRole.GUARD), { code });
      assert.equal(result.status, CompanyGuardStatus.ACTIVE);
      assert.equal(result.alreadyInWorkforce, true, 'the caller is told they were already in');
      const after = await links.findOneOrFail({ where: { id: existing.id } });
      assert.equal(after.relationshipType, CompanyGuardRelationshipType.EMPLOYEE);
      const count = await links.count({ where: { company: { id: abc.id }, guard: { id: guard.id } } });
      assert.equal(count, 1);
      const inv = await invitations.findOneOrFail({ where: { id: invitation.id } });
      assert.ok(inv.usedAt, 'the code is still consumed so it cannot be reused');
    });

    // ══ DECLINE ═══════════════════════════════════════════════════════════════

    await test('B-DECLINE-SPENDS-CODE-WITHOUT-RELATIONSHIP', async () => {
      const { guard, user } = await makeGuard('decliner');
      const { code, invitation } = await service.createForCompanyUser(abcOwner, {});
      const result = await service.declineForGuardUser(jwt(user.id, UserRole.GUARD), { code });
      assert.equal(result.declined, true);
      const row = await invitations.findOneOrFail({ where: { id: invitation.id } });
      assert.ok(row.declinedAt, 'declinedAt recorded');
      assert.equal(row.usedAt, null, 'a decline is not an acceptance');
      assert.equal(CompanyGuardInvitationService.stateOf(row), 'DECLINED');
      const count = await links.count({ where: { company: { id: abc.id }, guard: { id: guard.id } } });
      assert.equal(count, 0, 'declining must create no relationship');
    });

    await test('B-DECLINED-CODE-CANNOT-LATER-BE-ACCEPTED', async () => {
      const { user } = await makeGuard('decliner2');
      const actor = jwt(user.id, UserRole.GUARD);
      const { code } = await service.createForCompanyUser(abcOwner, {});
      await service.declineForGuardUser(actor, { code });
      await assert.rejects(() => service.acceptForGuardUser(actor, { code }), (e: unknown) => {
        assert.match((e as Error).message, GENERIC);
        return true;
      });
      await assert.rejects(() => service.previewForGuardUser(actor, { code }));
      await assert.rejects(() => service.declineForGuardUser(actor, { code }));
    });

    await test('B-DECLINE-AUDITED-AND-COMPANY-SEES-NOT-PENDING', async () => {
      const { user } = await makeGuard('decliner3');
      const { code, invitation } = await service.createForCompanyUser(abcOwner, {});
      await service.declineForGuardUser(jwt(user.id, UserRole.GUARD), { code });
      const audit = await audits.findOneOrFail({
        where: { action: 'company_guard_invitation.declined', entityId: invitation.id },
      });
      assert.equal(audit.company?.id, abc.id);
      assert.ok(!JSON.stringify(audit.afterData).includes(code));
      const view = (await service.listForCompanyUser(abcOwner)).find((r) => r.id === invitation.id)!;
      assert.equal(view.state, 'DECLINED', 'the company sees a refusal as a refusal, not an acceptance');
      assert.ok(view.resolvedAt, 'and sees when it was resolved');
    });

    // ══ TARGETED INVITATIONS ══════════════════════════════════════════════════

    await test('B-TARGETED-CODE-ONLY-WORKS-FOR-THAT-LICENCE', async () => {
      const { guard: intended, user: intendedUser } = await makeGuard('intended');
      const { user: otherUser } = await makeGuard('interloper');
      const { code } = await service.createForCompanyUser(abcOwner, {
        targetSiaLicenceNumber: intended.siaLicenseNumber,
      });
      // Someone else holding the leaked code gets the same generic failure.
      await assert.rejects(
        () => service.acceptForGuardUser(jwt(otherUser.id, UserRole.GUARD), { code }),
        (e: unknown) => { assert.match((e as Error).message, GENERIC); return true; },
      );
      const result = await service.acceptForGuardUser(jwt(intendedUser.id, UserRole.GUARD), { code });
      assert.equal(result.status, CompanyGuardStatus.ACTIVE);
    });

    // ══ MULTI-COMPANY ═════════════════════════════════════════════════════════

    await test('B-MULTI-COMPANY-BOTH-RELATIONSHIPS-ACTIVE', async () => {
      const { guard, user } = await makeGuard('shared');
      const actor = jwt(user.id, UserRole.GUARD);

      const fromAbc = await service.createForCompanyUser(abcOwner, {
        relationshipType: CompanyGuardRelationshipType.EMPLOYEE,
      });
      const fromXyz = await service.createForCompanyUser(xyzOwner, {
        relationshipType: CompanyGuardRelationshipType.APPROVED_CONTRACTOR,
      });

      await service.acceptForGuardUser(actor, { code: fromAbc.code });
      await service.acceptForGuardUser(actor, { code: fromXyz.code });

      const a = await links.findOneOrFail({ where: { company: { id: abc.id }, guard: { id: guard.id } } });
      const b = await links.findOneOrFail({ where: { company: { id: xyz.id }, guard: { id: guard.id } } });
      assert.equal(a.status, CompanyGuardStatus.ACTIVE);
      assert.equal(b.status, CompanyGuardStatus.ACTIVE);
      assert.equal(a.relationshipType, CompanyGuardRelationshipType.EMPLOYEE);
      assert.equal(b.relationshipType, CompanyGuardRelationshipType.APPROVED_CONTRACTOR,
        "each company's own terms are preserved independently");
      assert.notEqual(a.id, b.id, 'two distinct relationship rows');

      // No global state moved.
      const profile = await guards.findOneOrFail({ where: { id: guard.id } });
      assert.equal(profile.approvalStatus, GuardApprovalStatus.PENDING);
      assert.equal(profile.isApproved, false);
      assert.equal(profile.status, 'pending');

      // Company A blocking its own relationship must not touch Company B's.
      a.status = CompanyGuardStatus.BLOCKED;
      await links.save(a);
      const bAfter = await links.findOneOrFail({ where: { id: b.id } });
      assert.equal(bAfter.status, CompanyGuardStatus.ACTIVE, "Company A cannot affect Company B");
    });

    await test('B-MULTI-COMPANY-LISTINGS-STAY-ISOLATED', async () => {
      const abcIds = new Set((await service.listForCompanyUser(abcOwner)).map((r) => r.id));
      const xyzIds = new Set((await service.listForCompanyUser(xyzOwner)).map((r) => r.id));
      const overlap = [...abcIds].filter((id) => xyzIds.has(id));
      assert.equal(overlap.length, 0, 'invitation listings must not intersect');
    });

    // ══ SECURITY ══════════════════════════════════════════════════════════════

    await test('B-NO-PLAINTEXT-ANYWHERE-IN-THE-DATABASE', async () => {
      // Sweep every invitation row and every audit payload for any issued code.
      const allInvitations = await ds.query(`SELECT row_to_json(t)::text AS j FROM company_guard_invitations t`);
      const allAudits = await ds.query(
        `SELECT COALESCE("beforeData"::text,'') || COALESCE("afterData"::text,'') AS j FROM audit_logs`,
      );
      const haystack = [...allInvitations, ...allAudits].map((r: { j: string }) => r.j).join('\n');
      assert.ok(!haystack.includes(firstCode), 'no issued code may appear in invitations or audits');

      // Generic, and therefore stronger than checking one known code: every issued token is a
      // 43-character base64url string, so if any long opaque run in persisted data is NOT a 64-char
      // hex digest, a raw token has leaked. Digests are expected and exempt.
      const longRuns = haystack.match(/[A-Za-z0-9_-]{40,}/g) ?? [];
      const suspicious = longRuns.filter((run) => !/^[0-9a-f]{64}$/.test(run));
      assert.deepEqual(
        suspicious,
        [],
        `token-shaped strings found in persisted data: ${suspicious.slice(0, 3).join(", ")}`,
      );
      assert.ok(longRuns.length > 0, 'sanity: the sweep did look at the stored digests');
    });

    await expectRejection(
      'B-NON-GUARD-CANNOT-ACCEPT',
      async () => {
        const { code } = await service.createForCompanyUser(abcOwner, {});
        // A company user has no guard profile, so there is no identity to bind consent to.
        return service.acceptForGuardUser(abcOwner, { code });
      },
      NotFoundException,
      /Guard profile not found/,
    );

    await test('B-ONE-ACCEPTANCE-PER-CODE-ACROSS-GUARDS', async () => {
      const { user: first } = await makeGuard('firstclaim');
      const { user: second } = await makeGuard('secondclaim');
      const { code } = await service.createForCompanyUser(abcOwner, {});
      await service.acceptForGuardUser(jwt(first.id, UserRole.GUARD), { code });
      await assert.rejects(
        () => service.acceptForGuardUser(jwt(second.id, UserRole.GUARD), { code }),
        (e: unknown) => { assert.match((e as Error).message, GENERIC); return true; },
      );
    });

    await test('B-EXPIRED-AND-REVOKED-CANNOT-BE-ACCEPTED', async () => {
      const { user } = await makeGuard('latecomer');
      const actor = jwt(user.id, UserRole.GUARD);

      const expired = await service.createForCompanyUser(abcOwner, {});
      await invitations.update({ id: expired.invitation.id }, { expiresAt: new Date(Date.now() - 1000) });
      await assert.rejects(() => service.acceptForGuardUser(actor, { code: expired.code }));

      const revoked = await service.createForCompanyUser(abcOwner, {});
      await service.revokeForCompanyUser(abcOwner, revoked.invitation.id);
      await assert.rejects(() => service.acceptForGuardUser(actor, { code: revoked.code }));

      const rows = await links.count({ where: { guard: { id: (await guards.findOneOrFail({ where: { user: { id: user.id } } })).id } } });
      assert.equal(rows, 0, 'neither created a relationship');
    });

    await test('B-REVOKE-ONLY-APPLIES-TO-UNRESOLVED-INVITATIONS', async () => {
      const { user } = await makeGuard('settled');
      const { code, invitation } = await service.createForCompanyUser(abcOwner, {});
      await service.acceptForGuardUser(jwt(user.id, UserRole.GUARD), { code });
      await assert.rejects(
        () => service.revokeForCompanyUser(abcOwner, invitation.id),
        (e: unknown) => {
          assert.ok(e instanceof BadRequestException);
          assert.match((e as Error).message, /already accepted/);
          return true;
        },
      );
    });

    console.log(JSON.stringify({ event: 'company_guard_invitation_passed', tests: passed }));
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
