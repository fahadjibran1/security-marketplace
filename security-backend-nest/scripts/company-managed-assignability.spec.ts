/**
 * Phase A certification: company-managed guard assignability.
 *
 * The approved rule is that S4 screening is an optional trust product, not a condition of a security
 * company deploying its own guard. A company that recruited, vetted and employs someone must be able
 * to roster them on S4 without buying the screening service — while every genuine operational and
 * legal requirement still bites, and while one company's decisions stay invisible to every other.
 *
 * This runs the real ComplianceService, GuardComplianceService and CompanyGuardService against a real
 * PostgreSQL schema, because the checks that matter here are company-scoped SQL filters, and a
 * hand-rolled repository fake cannot prove a filter is applied.
 *
 * Needs COMPANY_MANAGED_DATABASE_URL pointing at a DISPOSABLE database — it drops the schema.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { ForbiddenException } from '@nestjs/common';
import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardApprovalStatus, GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Company } from '../src/company/entities/company.entity';
import {
  CompanyGuard,
  CompanyGuardRelationshipType,
  CompanyGuardStatus,
} from '../src/company-guard/entities/company-guard.entity';
import { GuardDocument, GuardDocumentType } from '../src/compliance/entities/guard-document.entity';
import { GuardScreening, ScreeningStatus } from '../src/screening/entities/screening.entities';
import { ComplianceService } from '../src/compliance/compliance.service';
import { GuardComplianceService } from '../src/compliance/guard-compliance.service';
import { JobApplicationService } from '../src/job-application/job-application.service';
import { JobApplication } from '../src/job-application/entities/job-application.entity';
import { Job } from '../src/job/entities/job.entity';
import { CompanyMembershipService } from '../src/company-membership/company-membership.service';
import { CompanyMembership } from '../src/company-membership/entities/company-membership.entity';
import {
  CompanyMembershipRole,
  CompanyMembershipStatus,
} from '../src/company-membership/company-membership-types';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

async function expectForbidden(id: string, fn: () => Promise<unknown>, expected?: RegExp) {
  await test(id, async () => {
    await assert.rejects(fn, (error: unknown) => {
      assert.ok(error instanceof ForbiddenException, `expected ForbiddenException, got ${error}`);
      if (expected) assert.match((error as ForbiddenException).message, expected);
      return true;
    });
  });
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
};

async function main() {
  const url = process.env.COMPANY_MANAGED_DATABASE_URL;
  if (!url) throw new Error('COMPANY_MANAGED_DATABASE_URL is required (use a disposable database)');

  const ds = new DataSource({
    type: 'postgres',
    url,
    entities: appEntities,
    synchronize: true,
    dropSchema: true,
    logging: false,
  });
  await ds.initialize();

  try {
    const users = ds.getRepository(User);
    const guards = ds.getRepository(GuardProfile);
    const companies = ds.getRepository(Company);
    const links = ds.getRepository(CompanyGuard);
    const documents = ds.getRepository(GuardDocument);
    const screenings = ds.getRepository(GuardScreening);

    // ── fixture ───────────────────────────────────────────────────────────────
    const makeCompany = async (label: string, number: string) => {
      const owner = await users.save(users.create({
        email: `${label}.owner@example.invalid`, passwordHash: 'x',
        role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE, isEmailVerified: true,
      }));
      return companies.save(companies.create({
        user: owner, name: `${label} Security Ltd`, companyNumber: number,
        address: `1 ${label} Way`, contactDetails: `ops@${label}.example.invalid`,
      }));
    };

    let sia = 1000000000000000;
    const makeGuard = async (label: string, overrides: Partial<GuardProfile> = {}) => {
      const user = await users.save(users.create({
        email: `${label}@example.invalid`, passwordHash: 'x',
        role: UserRole.GUARD, status: UserStatus.ACTIVE, isEmailVerified: true,
      }));
      sia += 1;
      return guards.save(guards.create({
        user,
        fullName: `${label} Candidate`,
        siaLicenseNumber: String(sia),
        siaExpiryDate: daysFromNow(400),
        rightToWorkStatus: 'british',
        phone: '07000000000',
        // Deliberately left at the registration defaults: an unapproved profile must still deploy.
        status: 'pending',
        approvalStatus: GuardApprovalStatus.PENDING,
        isApproved: false,
        ...overrides,
      }));
    };

    const link = (company: Company, guard: GuardProfile, status = CompanyGuardStatus.ACTIVE) =>
      links.save(links.create({
        company, guard, status,
        relationshipType: CompanyGuardRelationshipType.EMPLOYEE,
      }));

    /** The company's own evidence file: uploaded by the company and verified by the company. */
    const fileEvidence = async (
      company: Company,
      guard: GuardProfile,
      type: GuardDocumentType,
      opts: { verified?: boolean; complete?: boolean; expiryDate?: string | null } = {},
    ) =>
      documents.save(documents.create({
        guard, company, type,
        storageProvider: 's3', storageKey: `compliance/company/${company.id}/${guard.id}/${type}`,
        originalFileName: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: '1024',
        uploadCompletedAt: opts.complete === false ? null : new Date(),
        expiryDate: opts.expiryDate ?? null,
        verified: opts.verified ?? true,
        uploadedByUserId: company.user.id,
        verifiedByUserId: opts.verified === false ? null : company.user.id,
        verifiedAt: opts.verified === false ? null : new Date(),
      }));

    const completeFileFor = async (company: Company, guard: GuardProfile) => {
      await fileEvidence(company, guard, GuardDocumentType.SIA_LICENCE);
      await fileEvidence(company, guard, GuardDocumentType.RIGHT_TO_WORK);
    };

    // ── services under test (real implementations) ────────────────────────────
    const membershipStub = { resolveCompanyContext: async () => { throw new Error('not used'); } } as never;
    const guardProfileService = {
      findOne: async (id: number) => {
        const found = await guards.findOne({ where: { id } });
        if (!found) throw new Error(`guard ${id} not found`);
        return found;
      },
    } as never;

    const guardCompliance = new GuardComplianceService(
      documents, ds.getRepository('ComplianceRecord') as never, links,
      membershipStub, guardProfileService,
      { createForUserUnlessRecentDuplicate: async () => undefined } as never,
      { log: async () => undefined } as never,
      {} as never, {} as never,
    );
    const compliance = new ComplianceService(
      ds.getRepository('ComplianceRecord') as never, membershipStub, guardProfileService,
      { createForUser: async () => undefined } as never, guardCompliance,
    );

    const abc = await makeCompany('abc', '11111111');
    const xyz = await makeCompany('xyz', '22222222');

    // ── 1-3: the company-managed guard deploys ────────────────────────────────
    const managed = await makeGuard('managed');
    await link(abc, managed);
    await completeFileFor(abc, managed);

    await test('COMPANY-MANAGED-ASSIGN: no S4 screening record at all, yet assignable', async () => {
      assert.equal(await screenings.count({ where: { guard: { id: managed.id } } }), 0);
      await compliance.assertGuardAssignable(abc.id, managed.id);
    });

    await test('SCREENING-IN-PROGRESS-ASSIGN: screening under review does not change the answer', async () => {
      const inProgress = await screenings.save(screenings.create({
        guard: managed, status: ScreeningStatus.UNDER_REVIEW, screeningPeriodYears: 5,
      }));
      await compliance.assertGuardAssignable(abc.id, managed.id);
      await screenings.remove(inProgress);
    });

    await test('UNAPPROVED-PROFILE-ASSIGN: legacy approvalStatus/isApproved are not consulted', async () => {
      const row = await guards.findOneOrFail({ where: { id: managed.id } });
      assert.equal(row.approvalStatus, GuardApprovalStatus.PENDING, 'fixture must stay unapproved');
      assert.equal(row.isApproved, false, 'fixture must stay unapproved');
      await compliance.assertGuardAssignable(abc.id, managed.id);
    });

    // ── 4-7: the gates that must still bite ───────────────────────────────────
    const expiredSia = await makeGuard('expiredsia', { siaExpiryDate: daysFromNow(-1) });
    await link(abc, expiredSia);
    await completeFileFor(abc, expiredSia);
    await expectForbidden(
      'EXPIRED-SIA-BLOCKS: an expired licence blocks deployment',
      () => compliance.assertGuardAssignable(abc.id, expiredSia.id),
      /SIA licence expired/,
    );

    const expiringSia = await makeGuard('expiringsia', { siaExpiryDate: daysFromNow(20) });
    await link(abc, expiringSia);
    await completeFileFor(abc, expiringSia);
    await test('EXPIRING-SIA-DOES-NOT-BLOCK: within 30 days warns but still deploys', async () => {
      await compliance.assertGuardAssignable(abc.id, expiringSia.id);
      const summary = await guardCompliance.getGuardSummary(expiringSia.id, abc.id);
      assert.equal(summary.complianceStatus, 'expiring');
      assert.equal(summary.assignable, true);
      assert.ok(
        summary.expiringReasons.some((reason) => /SIA licence expires within 30 days/.test(reason)),
        'the warning must still be produced',
      );
    });

    const noRtw = await makeGuard('nortw', { rightToWorkStatus: null });
    await link(abc, noRtw);
    await completeFileFor(abc, noRtw);
    await expectForbidden(
      'MISSING-RTW-BLOCKS: absent right-to-work status blocks deployment',
      () => compliance.assertGuardAssignable(abc.id, noRtw.id),
      /right-to-work status/i,
    );

    const revokedRtw = await makeGuard('revokedrtw', { rightToWorkStatus: 'revoked' });
    await link(abc, revokedRtw);
    await completeFileFor(abc, revokedRtw);
    await expectForbidden(
      'INVALID-RTW-BLOCKS: a revoked right to work blocks deployment',
      () => compliance.assertGuardAssignable(abc.id, revokedRtw.id),
      /Right-to-work status is revoked/,
    );

    const unverifiedDoc = await makeGuard('unverifieddoc');
    await link(abc, unverifiedDoc);
    await fileEvidence(abc, unverifiedDoc, GuardDocumentType.SIA_LICENCE, { verified: false });
    await fileEvidence(abc, unverifiedDoc, GuardDocumentType.RIGHT_TO_WORK);
    await expectForbidden(
      'UNVERIFIED-DOCUMENT-BLOCKS: uploaded but unverified evidence is not a compliance file',
      () => compliance.assertGuardAssignable(abc.id, unverifiedDoc.id),
      /SIA licence document is not verified/,
    );

    const missingDoc = await makeGuard('missingdoc');
    await link(abc, missingDoc);
    await fileEvidence(abc, missingDoc, GuardDocumentType.SIA_LICENCE);
    await expectForbidden(
      'MISSING-DOCUMENT-BLOCKS: the company must hold both required documents',
      () => compliance.assertGuardAssignable(abc.id, missingDoc.id),
      /Missing Right-to-work document/,
    );

    // ── 8: account state ──────────────────────────────────────────────────────
    const suspended = await makeGuard('suspended');
    await link(abc, suspended);
    await completeFileFor(abc, suspended);
    await users.update(suspended.user.id, { status: UserStatus.SUSPENDED });
    await expectForbidden(
      'INACTIVE-ACCOUNT-BLOCKS: a suspended guard account cannot be deployed',
      () => compliance.assertGuardAssignable(abc.id, suspended.id),
      /Guard account is not active/,
    );

    // ── 9-10 and 12-13: relationship and cross-company isolation ──────────────
    // XYZ has done nothing for this guard. ABC's complete file must not carry across.
    await test('COMPANY-A-EVIDENCE-DOES-NOT-SATISFY-COMPANY-B', async () => {
      await link(xyz, managed);
      const abcReasons = await guardCompliance.getBlockingReasons(abc.id, managed.id);
      const xyzReasons = await guardCompliance.getBlockingReasons(xyz.id, managed.id);
      assert.deepEqual(abcReasons, [], 'ABC holds a complete verified file');
      assert.ok(xyzReasons.length > 0, 'XYZ holds no file of its own and must be blocked');
      assert.ok(
        xyzReasons.some((reason) => /Missing SIA licence document/.test(reason)),
        `expected XYZ to be missing its own evidence, got ${JSON.stringify(xyzReasons)}`,
      );
    });

    await expectForbidden(
      'COMPANY-B-CANNOT-DEPLOY-ON-COMPANY-A-EVIDENCE',
      () => compliance.assertGuardAssignable(xyz.id, managed.id),
      /Guard compliance invalid/,
    );

    await test('CROSS-COMPANY-APPROVAL-ISOLATION: nothing ABC did altered the shared profile', async () => {
      const row = await guards.findOneOrFail({ where: { id: managed.id } });
      assert.equal(row.approvalStatus, GuardApprovalStatus.PENDING);
      assert.equal(row.isApproved, false);
      assert.equal(row.status, 'pending');
    });

    // The relationship gate is asserted by callers, so prove the assertion itself is company-scoped
    // and status-aware. CompanyGuardService is exercised directly against the same schema.
    const { CompanyGuardService } = await import('../src/company-guard/company-guard.service');
    const companyGuardService = new CompanyGuardService(
      links,
      { findOne: async (id: number) => companies.findOneOrFail({ where: { id } }) } as never,
      membershipStub,
      guardProfileService,
      { log: async () => undefined } as never,
    );

    const unrelated = await makeGuard('unrelated');
    await completeFileFor(abc, unrelated);
    await expectForbidden(
      'NO-RELATIONSHIP-BLOCKS: a guard with no link to this company is not deployable',
      () => companyGuardService.ensureActiveRelationship(abc.id, unrelated.id),
      /not active\/approved for this company/,
    );

    const blocked = await makeGuard('blocked');
    await link(abc, blocked, CompanyGuardStatus.BLOCKED);
    await completeFileFor(abc, blocked);
    await expectForbidden(
      'BLOCKED-RELATIONSHIP-BLOCKS',
      () => companyGuardService.ensureActiveRelationship(abc.id, blocked.id),
      /not active\/approved for this company/,
    );

    const inactive = await makeGuard('inactive');
    await link(abc, inactive, CompanyGuardStatus.INACTIVE);
    await completeFileFor(abc, inactive);
    await expectForbidden(
      'INACTIVE-RELATIONSHIP-BLOCKS',
      () => companyGuardService.ensureActiveRelationship(abc.id, inactive.id),
      /not active\/approved for this company/,
    );

    await test('RELATIONSHIP-GATE-IS-COMPANY-SCOPED: ABC\'s link does not admit XYZ', async () => {
      const onlyAbc = await makeGuard('onlyabc');
      await link(abc, onlyAbc);
      await companyGuardService.ensureActiveRelationship(abc.id, onlyAbc.id);
      await assert.rejects(
        () => companyGuardService.ensureActiveRelationship(xyz.id, onlyAbc.id),
        ForbiddenException,
      );
    });

    // ── 18: no deployment path bypasses the gate (static enumeration) ─────────
    // Every route that can attach a guard to a shift is enumerated here rather than trusted. If a
    // new one appears without both gates, this fails.
    await test('NO-DEPLOY-PATH-BYPASSES-GATE: every guard-to-shift write carries both gates', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const read = (rel: string) => readFileSync(join(__dirname, '..', 'src', rel), 'utf8');

      const shift = read('shift/shift.service.ts');
      const rota = read('rota-slot/rota-slot.service.ts');

      // The only two places a guard is written onto a shift entity, plus the one raw SQL write.
      const entityWrites = (shift.match(/shift\.guard = /g) || []).length;
      assert.equal(entityWrites, 2, `shift.service.ts guard writes changed (${entityWrites}); re-audit the gates`);
      const sqlWrites = (rota.match(/SET "guardId"/g) || []).length;
      assert.equal(sqlWrites, 1, `rota-slot.service.ts guard writes changed (${sqlWrites}); re-audit the gates`);

      // shift create: the funnel for admin create, company create, hire-with-shift and starter shifts.
      const create = shift.split('async create(')[1].split('async createForUser(')[0];
      assert.match(create, /ensureActiveRelationship/, 'shift create must assert the ACTIVE relationship');
      assert.match(create, /assertGuardAssignable/, 'shift create must run the compliance gate');

      // shift guard change.
      const update = shift.split('async updateForUser(')[1].split('async removeForUser(')[0];
      assert.match(update, /ensureActiveRelationship/, 'shift guard change must assert the relationship');
      assert.match(update, /assertGuardAssignable/, 'shift guard change must run the compliance gate');

      // guard responding to an offer.
      const respond = shift.split('async respondForGuard(')[1].split('assertGuardCanOperateShift(')[0];
      assert.match(respond, /ensureActiveRelationship/, 'shift offer response must assert the relationship');

      // rota slot assignment (assignMultiple delegates to assignPosition).
      const assignPosition = rota.split('async assignPosition(')[1].split('async assignMultiple(')[0];
      assert.match(assignPosition, /ensureActiveRelationship/, 'rota assign must assert the relationship');
      assert.match(assignPosition, /assertGuardCanTakeShift/, 'rota assign must run the operational gate');
      assert.match(
        rota.split('async assignMultiple(')[1].split('async cancelPosition(')[0],
        /this\.assignPosition\(/,
        'bulk assignment must delegate to the gated single-assign path',
      );

      // availability preview funnels into the same compliance gate.
      assert.match(read('availability/availability.service.ts'), /assertGuardAssignable/);
    });

    // ── stage separation: hire is not deployment ──────────────────────────────
    await test('HIRE-UNGATED: hiring paths carry no deployment compliance gate', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const read = (rel: string) => readFileSync(join(__dirname, '..', 'src', rel), 'utf8');
      // The call form, not the bare name: these files legitimately mention the gate in comments
      // that explain why they do not run it.
      assert.doesNotMatch(read('job-application/job-application.service.ts'), /this\.complianceService\.assertGuardAssignable/);
      assert.doesNotMatch(read('assignment/assignment.service.ts'), /this\.complianceService\.assertGuardAssignable/);
      assert.doesNotMatch(read('company-guard/company-guard.service.ts'), /this\.complianceService\.assertGuardAssignable/);
    });

    await test('APPLY-UNGATED: applying carries no compliance or screening gate', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const source = readFileSync(join(__dirname, '..', 'src', 'job-application/job-application.service.ts'), 'utf8');
      const createForGuard = source.split('private async createForGuard(')[1].split('async findAllForUser(')[0];
      assert.doesNotMatch(createForGuard, /assertGuardAssignable|isGuardVetted|getBlockingReasons/);
      assert.doesNotMatch(createForGuard, /screening/i);
    });

    await test('SCREENING-IS-NOT-AN-ASSIGNABILITY-INPUT: no path from screening to the gate', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const source = readFileSync(join(__dirname, '..', 'src', 'compliance/compliance.service.ts'), 'utf8');
      assert.doesNotMatch(source, /this\.screeningService\.isGuardVetted/);
      assert.doesNotMatch(source, /private readonly screeningService/);
      const body = source.split('async assertGuardAssignable')[1].split('async getBlockingRecords')[0];
      assert.doesNotMatch(body, /approvalStatus/);
      assert.doesNotMatch(body, /isApproved/);
    });

    await test('COMPANY-DTO-HIDES-LEGACY-APPROVAL', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const mappers = readFileSync(join(__dirname, '..', 'src', 'guard-profile/dto/guard-profile-response.mappers.ts'), 'utf8');
      const companyDto = mappers.split('export function toCompanyDto(')[1].split('export function toAdminDto(')[0];
      assert.doesNotMatch(companyDto, /approvalStatus/, 'a company must not be shown legacy platform approval');
      const adminDto = mappers.split('export function toAdminDto(')[1];
      assert.match(adminDto, /approvalStatus/, 'Platform Admin keeps the historical fields');
    });

    await test('GUARD-APPROVAL-IS-PLATFORM-ADMIN-ONLY', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const controller = readFileSync(join(__dirname, '..', 'src', 'guard-profile/guard-profile.controller.ts'), 'utf8');
      const approve = controller.split("@Patch(':id/approve')")[1].split('@Patch(\'me\')')[0];
      assert.doesNotMatch(approve, /COMPANY_ADMIN_ROLES|COMPANY_VIEW_ROLES/, 'approval must not admit company roles');
      assert.match(approve, /@Roles\(UserRole\.ADMIN\)/);
      const service = readFileSync(join(__dirname, '..', 'src', 'guard-profile/guard-profile.service.ts'), 'utf8');
      const body = service.split('async approveForUser(')[1];
      assert.match(body, /user\.role !== UserRole\.ADMIN/, 'the service must reject non-admin callers itself');
      assert.doesNotMatch(body, /CompanyGuardStatus\.ACTIVE/, 'approval must not activate a company relationship');
    });

    await test('BANK-REQUIRES-EMPLOYMENT-RECORD: the engagement is the reason to see it', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const source = readFileSync(join(__dirname, '..', 'src', 'guard-personnel/bank-details.service.ts'), 'utf8');
      const body = source.split('async getBankDetailsForCompany(')[1].split('async getBankDetailsForAdmin(')[0];
      assert.match(body, /requireOwnedActiveRelationship/, 'ACTIVE relationship still required');
      assert.match(body, /requireEngagement/, 'an employment record is now required too');
      assert.match(source, /PERSONNEL_BANK_VIEW/, 'the permission is still enforced');
      assert.doesNotMatch(body, /accountHolderName/, 'holder name is never returned to a company');
      assert.doesNotMatch(source, /companyProfile/, 'company context must come from the membership matrix');
    });

    // ── recruitment listing runs on the membership matrix, like review and hire ──
    // Behavioural, against the real JobApplicationService and a real membership matrix, because the
    // point of the fix is which company id the query filters on and who is allowed to ask.
    const memberships = ds.getRepository(CompanyMembership);
    const jobs = ds.getRepository(Job);
    const applications = ds.getRepository(JobApplication);

    const membership = new CompanyMembershipService(
      memberships,
      { findByUserId: async (id: number) => companies.findOne({ where: { user: { id } }, relations: ['user'] }) } as never,
    );
    const jobApplications = new JobApplicationService(
      applications,
      { findOne: async (id: number) => jobs.findOneOrFail({ where: { id } }) } as never,
      guardProfileService,
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      ds, membership,
    );

    const staffFor = async (company: Company, label: string, role: CompanyMembershipRole) => {
      const user = await users.save(users.create({
        email: `${label}@example.invalid`, passwordHash: 'x',
        role: UserRole.COMPANY_STAFF, status: UserStatus.ACTIVE, isEmailVerified: true,
      }));
      await memberships.save(memberships.create({
        userId: user.id, companyId: company.id, membershipRole: role,
        status: CompanyMembershipStatus.ACTIVE, invitedByUserId: company.user.id,
      }));
      return { sub: user.id, email: user.email, role: UserRole.COMPANY_STAFF, status: UserStatus.ACTIVE };
    };

    const abcJob = await jobs.save(jobs.create({
      company: abc, title: 'Night Officer', description: 'Static guarding', status: 'open', guardsRequired: 1, hourlyRate: 14.5,
    }));
    const xyzJob = await jobs.save(jobs.create({
      company: xyz, title: 'Event Steward', description: 'Crowd safety', status: 'open', guardsRequired: 1, hourlyRate: 13.25,
    }));
    const applicant = await makeGuard('applicant');
    await applications.save(applications.create({ job: abcJob, guard: applicant, status: 'applied' }));
    await applications.save(applications.create({ job: xyzJob, guard: applicant, status: 'applied' }));

    await test('APPLICATION-LIST-OWNER: the legacy company owner can still list', async () => {
      const owner = { sub: abc.user.id, email: abc.user.email, role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE };
      const rows = await jobApplications.findAllForUser(owner as never);
      assert.equal(rows.length, 1, 'owner sees exactly their own company application');
      assert.equal(rows[0].job.company.id, abc.id);
    });

    await test('APPLICATION-LIST-PERMITTED-STAFF: operations staff can list', async () => {
      const staff = await staffFor(abc, 'abc.ops', CompanyMembershipRole.OPERATIONS);
      const rows = await jobApplications.findAllForUser(staff as never);
      assert.equal(rows.length, 1, 'permitted staff see their company pipeline');
      assert.equal(rows[0].job.company.id, abc.id);
    });

    // Negative control. guards.manage is genuinely absent from three roles, so these are real
    // refusals from the permission matrix rather than contrived ones.
    for (const role of [CompanyMembershipRole.VIEWER, CompanyMembershipRole.FINANCE, CompanyMembershipRole.CONTROL_ROOM]) {
      await expectForbidden(
        `APPLICATION-LIST-DENIED-STAFF: ${role} lacks guards.manage and is refused`,
        async () => {
          const staff = await staffFor(abc, `abc.${role}`, role);
          return jobApplications.findAllForUser(staff as never);
        },
        /Insufficient permissions/,
      );
    }

    await expectForbidden(
      'APPLICATION-LIST-SUSPENDED-STAFF: a suspended membership never falls through to the owner path',
      async () => {
        const staff = await staffFor(abc, 'abc.suspended', CompanyMembershipRole.OPERATIONS);
        await memberships.update({ userId: staff.sub }, { status: CompanyMembershipStatus.SUSPENDED });
        return jobApplications.findAllForUser(staff as never);
      },
      /suspended/i,
    );

    await test('APPLICATION-LIST-STAFF-WITHOUT-MEMBERSHIP-IS-REFUSED', async () => {
      const orphan = await users.save(users.create({
        email: 'orphan.staff@example.invalid', passwordHash: 'x',
        role: UserRole.COMPANY_STAFF, status: UserStatus.ACTIVE, isEmailVerified: true,
      }));
      await assert.rejects(
        () => jobApplications.findAllForUser({ sub: orphan.id, email: orphan.email, role: UserRole.COMPANY_STAFF, status: UserStatus.ACTIVE } as never),
        // company_staff has no legacy owner fallback, so there is no company to resolve.
        (error: unknown) => { assert.match(String((error as Error).message), /Company not found/); return true; },
      );
    });

    await test('APPLICATION-LIST-CROSS-COMPANY-ISOLATION: XYZ never sees ABC', async () => {
      const xyzStaff = await staffFor(xyz, 'xyz.ops', CompanyMembershipRole.OPERATIONS);
      const rows = await jobApplications.findAllForUser(xyzStaff as never);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].job.company.id, xyz.id, 'XYZ must see only its own pipeline');
      assert.ok(!rows.some((row) => row.job.company.id === abc.id), 'no ABC application leaked');
    });

    await test('APPLICATION-LIST-COMPANY-NEVER-FROM-INPUT', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const service = readFileSync(join(__dirname, '..', 'src', 'job-application/job-application.service.ts'), 'utf8');
      const body = service.split('async findAllForUser(')[1].split('async findOne(')[0];
      assert.match(body, /resolveCompanyContext/, 'company context must come from the membership matrix');
      assert.match(body, /CompanyPermission\.GUARDS_MANAGE/, 'the recruitment permission must be enforced');
      assert.doesNotMatch(body, /dto\.|query\.|companyId:/, 'company id must never come from request input');
      // Call form, not the bare name: the doc comments explain what was replaced.
      assert.doesNotMatch(service, /this.companyService./, 'the legacy owner lookup must be gone from this service');

      const controller = readFileSync(join(__dirname, '..', 'src', 'job-application/job-application.controller.ts'), 'utf8');
      assert.doesNotMatch(controller, /@Query|@Body\(\)\s*dto[^)]*companyId/, 'no company id accepted on the list route');
    });

    console.log(JSON.stringify({ event: 'company_managed_assignability_passed', tests: passed }));
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
