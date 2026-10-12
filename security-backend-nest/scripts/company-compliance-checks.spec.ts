/**
 * Compliance remediation phase 1: company-recorded SIA and Right to Work checks.
 *
 * Runs the real GuardComplianceCheckService, GuardComplianceService, ComplianceService and
 * AvailabilityService against a disposable PostgreSQL migrated to Migration 62 (the real schema, not
 * synchronize), with a membership stub that applies the real ROLE_PERMISSIONS matrix.
 *
 *   CHK-ASSESS-*   what makes a Guard assignable for a company (truth table)
 *   CHK-RTW-*      continuous, time-limited and PVN right to work; follow-up; validation
 *   CHK-SIA-*      SIA checks and their validation
 *   CHK-HIST-*     append-only history, amendment, stale edits, audit log
 *   CHK-ISO-*      company / Guard isolation and the ACTIVE relationship
 *   CHK-PERM-*     who may record and who may read evidence references
 *   CHK-EVID-*     linked evidence documents (never verified by linking)
 *   CHK-DATE-*     UK calendar dates
 *   CHK-GATE-*     every assignment path still runs the gate
 *
 * Needs COMPLIANCE_CHECKS_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { appEntities } from '../src/database/entities';
import { AvailabilityService } from '../src/availability/availability.service';
import { GuardAvailabilityOverride } from '../src/availability/entities/guard-availability-override.entity';
import { GuardAvailabilityRule } from '../src/availability/entities/guard-availability-rule.entity';
import { Company } from '../src/company/entities/company.entity';
import { CompanyGuard, CompanyGuardRelationshipType, CompanyGuardStatus } from '../src/company-guard/entities/company-guard.entity';
import { CompanyMembershipRole, CompanyPermission, hasPermission } from '../src/company-membership/company-membership-types';
import { ComplianceService } from '../src/compliance/compliance.service';
import { addCalendarMonths, complianceToday, daysUntilCalendarDate, toCalendarDate } from '../src/compliance/compliance-dates';
import { RecordComplianceCheckDto } from '../src/compliance/dto/record-compliance-check.dto';
import { GuardComplianceCheck } from '../src/compliance/entities/guard-compliance-check.entity';
import { GuardDocument, GuardDocumentType } from '../src/compliance/entities/guard-document.entity';
import { GuardComplianceCheckService } from '../src/compliance/guard-compliance-check.service';
import { GuardComplianceService } from '../src/compliance/guard-compliance.service';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { GuardScreening, ScreeningStatus } from '../src/screening/entities/screening.entities';
import { Shift } from '../src/shift/entities/shift.entity';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';

const url = process.env.COMPLIANCE_CHECKS_DATABASE_URL;
if (!url) throw new Error('COMPLIANCE_CHECKS_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('COMPLIANCE_CHECKS_DATABASE_URL must point at a local disposable database');
}

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};
const rejectsWith = (fn: () => Promise<unknown>, type: Function, message?: RegExp) =>
  assert.rejects(fn, (error: unknown) => {
    assert.ok(error instanceof type, `expected ${type.name}, got ${error}`);
    if (message) assert.match((error as Error).message, message);
    return true;
  });

/** Calendar date n days from today in the UK. */
const ukDay = (n: number) => {
  const [y, m, d] = complianceToday().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

async function main() {
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: true, logging: false,
    migrations: [join(__dirname, '..', 'src', 'database', 'migrations', '*.ts')], migrationsTableName: 'typeorm_migrations',
  });
  await ds.initialize();
  await ds.runMigrations({ transaction: 'each' });

  try {
    const users = ds.getRepository(User);
    const guards = ds.getRepository(GuardProfile);
    const companies = ds.getRepository(Company);
    const links = ds.getRepository(CompanyGuard);
    const documents = ds.getRepository(GuardDocument);
    const checks = ds.getRepository(GuardComplianceCheck);
    const screenings = ds.getRepository(GuardScreening);

    // ── fixture ───────────────────────────────────────────────────────────────────────────────────
    const makeUser = (email: string, role: UserRole) =>
      users.save(users.create({ email, passwordHash: 'x', role, status: UserStatus.ACTIVE, isEmailVerified: true }));
    const makeCompany = async (label: string, number: string) => {
      const owner = await makeUser(`${label}.owner@example.invalid`, UserRole.COMPANY_ADMIN);
      return companies.save(companies.create({
        user: owner, name: `${label} Security Ltd`, companyNumber: number, address: '1 Way', contactDetails: 'ops@example.invalid',
      }));
    };
    let sia = 3000000000000000;
    const makeGuard = async (label: string, declared = true) => {
      const user = await makeUser(`${label}@example.invalid`, UserRole.GUARD);
      sia += 1;
      return guards.save(guards.create({
        user, fullName: `${label} Guard`, phone: '07000000000', siaLicenseNumber: String(sia),
        siaExpiryDate: declared ? ukDay(400) : null, rightToWorkStatus: declared ? 'british' : null, rightToWorkExpiryDate: null,
      }));
    };
    const link = (company: Company, guard: GuardProfile, status = CompanyGuardStatus.ACTIVE) =>
      links.save(links.create({ company, guard, status, relationshipType: CompanyGuardRelationshipType.EMPLOYEE }));
    const fileEvidence = (company: Company, guard: GuardProfile, type: GuardDocumentType, opts: { verified?: boolean; complete?: boolean } = {}) =>
      documents.save(documents.create({
        guard, company, type, storageProvider: 's3', storageKey: `compliance/company/${company.id}/${guard.id}/${type}/${Math.random()}`,
        originalFileName: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: '1024',
        uploadCompletedAt: opts.complete === false ? null : new Date(), expiryDate: null,
        verified: opts.verified ?? true, uploadedByUserId: company.user.id,
        verifiedByUserId: opts.verified === false ? null : company.user.id, verifiedAt: opts.verified === false ? null : new Date(),
      }));
    const verifiedDocs = async (company: Company, guard: GuardProfile) => {
      await fileEvidence(company, guard, GuardDocumentType.SIA_LICENCE);
      await fileEvidence(company, guard, GuardDocumentType.RIGHT_TO_WORK);
    };

    const abc = await makeCompany('chkabc', '41111111');
    const xyz = await makeCompany('chkxyz', '42222222');

    // Membership: user id → company and membership role; the real permission matrix decides.
    const memberships = new Map<number, { company: Company; role: CompanyMembershipRole }>();
    const staff: Record<string, User> = {};
    for (const role of Object.values(CompanyMembershipRole)) {
      const user = await makeUser(`chk.${role}@example.invalid`, UserRole.COMPANY_STAFF);
      memberships.set(user.id, { company: abc, role });
      staff[role] = user;
    }
    const xyzOwner = await makeUser('chk.xyz.staff@example.invalid', UserRole.COMPANY_STAFF);
    memberships.set(xyzOwner.id, { company: xyz, role: CompanyMembershipRole.OWNER });
    const membership = {
      resolveCompanyContext: async (userId: number, _role: UserRole, permission?: CompanyPermission) => {
        const found = memberships.get(userId);
        if (!found) throw new NotFoundException('Company not found.');
        if (permission && !hasPermission(found.role, permission)) throw new ForbiddenException('Insufficient permissions.');
        return { company: found.company, membershipRole: found.role };
      },
    } as never;
    const hr = staff[CompanyMembershipRole.HR_COMPLIANCE];

    const guardProfileService = {
      findOne: async (id: number) => guards.findOneOrFail({ where: { id } }),
    } as never;
    const guardCompliance = new GuardComplianceService(
      documents, ds.getRepository('ComplianceRecord') as never, links, membership, guardProfileService,
      { createForUserUnlessRecentDuplicate: async () => undefined } as never, { log: async () => undefined } as never,
      {} as never, {} as never, checks,
    );
    const compliance = new ComplianceService(
      ds.getRepository('ComplianceRecord') as never, membership, guardProfileService, { createForUser: async () => undefined } as never, guardCompliance,
    );
    const checkService = new GuardComplianceCheckService(checks, links, documents, membership);
    const availability = new AvailabilityService(
      ds.getRepository(GuardAvailabilityRule), ds.getRepository(GuardAvailabilityOverride), ds.getRepository(Shift), links,
      { findOne: async (id: number) => companies.findOneOrFail({ where: { id } }) } as never,
      membership, guardProfileService, { hasApprovedLeaveOverlap: async () => false } as never, compliance,
      { log: async () => undefined } as never,
    );

    const siaCheck = (guardId: number, over: Partial<RecordComplianceCheckDto> = {}): RecordComplianceCheckDto => ({
      guardId, kind: 'sia', outcome: 'confirmed', method: 'sia_public_register', licenceNumber: '1234 5678 9012 3456',
      checkDate: ukDay(-1), expiryDate: ukDay(400), checkedByName: 'Pat Checker', evidenceReference: 'HR file 12/SIA', ...over,
    });
    const rtwCheck = (guardId: number, over: Partial<RecordComplianceCheckDto> = {}): RecordComplianceCheckDto => ({
      guardId, kind: 'right_to_work', outcome: 'confirmed', method: 'manual_document', rightToWorkExcuse: 'continuous',
      checkDate: ukDay(-1), checkedByName: 'Pat Checker', evidenceReference: 'HR file 12/RTW', ...over,
    });
    const record = (dto: RecordComplianceCheckDto, user: User = hr) => checkService.recordForCompanyUser(user.id, user.role, dto);
    const summary = (guard: GuardProfile, company: Company = abc) => guardCompliance.getGuardSummary(guard.id, company.id);
    const auditRows = (entityId: number) =>
      ds.query(`SELECT action, "companyId", "userId", "beforeData", "afterData" FROM audit_logs WHERE "entityType" = 'guard_compliance_check' AND "entityId" = $1 ORDER BY id`, [entityId]);

    // ══ assessment truth table ═════════════════════════════════════════════════════════════════════
    const g1 = await makeGuard('chk1');
    await link(abc, g1);
    await verifiedDocs(abc, g1);

    await test('CHK-ASSESS-01-DECLARATIONS-AND-DOCUMENTS-WITHOUT-COMPANY-CHECKS-ARE-NOT-ELIGIBLE', async () => {
      const s = await summary(g1);
      assert.equal(s.assignable, false);
      assert.ok(s.blockingReasons.includes('SIA licence check not recorded'));
      assert.ok(s.blockingReasons.includes('Right to work check not recorded'));
      assert.deepEqual(s.companyChecks, { sia: null, rightToWork: null });
      assert.deepEqual(s.requirements.map((r) => `${r.key}:${r.state}`), [
        'sia_check:missing', 'right_to_work_check:missing', 'sia_document:met', 'right_to_work_document:met',
      ]);
      // The declarations are still shown, for reference.
      assert.ok(s.siaLicenceNumber && s.siaExpiryDate && s.rightToWorkStatus);
      await rejectsWith(() => compliance.assertGuardAssignable(abc.id, g1.id), ForbiddenException, /SIA licence check not recorded/);
    });

    await test('CHK-ASSESS-02-SIA-ALONE-IS-NOT-ENOUGH', async () => {
      await record(siaCheck(g1.id));
      const s = await summary(g1);
      assert.equal(s.assignable, false);
      assert.deepEqual(s.blockingReasons, ['Right to work check not recorded']);
    });

    await test('CHK-ASSESS-03-BOTH-CHECKS-AND-VERIFIED-DOCUMENTS-MAKE-THE-GUARD-ELIGIBLE', async () => {
      await record(rtwCheck(g1.id));
      const s = await summary(g1);
      assert.equal(s.complianceStatus, 'valid');
      assert.equal(s.assignable, true);
      assert.deepEqual(s.blockingReasons, []);
      assert.ok(s.requirements.every((r) => r.state === 'met'), JSON.stringify(s.requirements));
      assert.equal(s.companyChecks?.sia?.licenceNumber, '1234567890123456', 'spaces are normalised away');
      await compliance.assertGuardAssignable(abc.id, g1.id);
    });

    await test('CHK-ASSESS-04-RECORDING-CHECKS-NEVER-TOUCHES-THE-GUARD-PROFILE-OR-DOCUMENTS', async () => {
      const row = await guards.findOneOrFail({ where: { id: g1.id } });
      assert.equal(row.siaLicenseNumber, g1.siaLicenseNumber, 'declared licence number unchanged');
      assert.equal(toCalendarDate(row.siaExpiryDate as never), toCalendarDate(g1.siaExpiryDate as never));
      assert.equal(row.rightToWorkStatus, 'british');
      assert.equal(row.rightToWorkExpiryDate ?? null, null);
    });

    await test('CHK-ASSESS-05-DOCUMENT-VERIFICATION-IS-STILL-SEPARATELY-REQUIRED', async () => {
      const g = await makeGuard('chknodocs');
      await link(abc, g);
      await record(siaCheck(g.id));
      await record(rtwCheck(g.id));
      const s = await summary(g);
      assert.equal(s.assignable, false);
      assert.ok(s.blockingReasons.includes('Missing SIA licence document'));
      await fileEvidence(abc, g, GuardDocumentType.SIA_LICENCE, { verified: false });
      await fileEvidence(abc, g, GuardDocumentType.RIGHT_TO_WORK);
      const after = await summary(g);
      assert.deepEqual(after.blockingReasons, ['SIA licence document is not verified']);
      assert.equal(after.requirements.find((r) => r.key === 'sia_document')?.state, 'unverified');
    });

    await test('CHK-ASSESS-06-SCREENING-IS-NOT-A-PREREQUISITE', async () => {
      const g = await makeGuard('chknoscreen', false);
      await link(abc, g);
      await verifiedDocs(abc, g);
      await record(siaCheck(g.id));
      await record(rtwCheck(g.id));
      assert.equal(await screenings.count({ where: { guard: { id: g.id } } }), 0);
      await compliance.assertGuardAssignable(abc.id, g.id);
      const inProgress = await screenings.save(screenings.create({ guard: g, status: ScreeningStatus.UNDER_REVIEW, screeningPeriodYears: 5 }));
      await compliance.assertGuardAssignable(abc.id, g.id);
      await screenings.remove(inProgress);
    });

    await test('CHK-ASSESS-07-NO-DECLARATIONS-AT-ALL-DO-NOT-BLOCK-A-COMPANY-CHECKED-GUARD', async () => {
      const g = await makeGuard('chkundeclared', false);
      await link(abc, g);
      await verifiedDocs(abc, g);
      await record(siaCheck(g.id));
      await record(rtwCheck(g.id));
      const s = await summary(g);
      assert.equal(s.siaExpiryDate, null);
      assert.equal(s.rightToWorkStatus, null);
      assert.equal(s.assignable, true);
    });

    await test('CHK-ASSESS-08-GUARD-OWN-VIEW-IS-UNCHANGED-AND-CARRIES-NO-COMPANY-CHECKS', async () => {
      const s = await guardCompliance.getGuardSummary(g1.id);
      assert.equal(s.companyChecks, null);
      assert.deepEqual(s.requirements, []);
      assert.equal(s.assignable, true, 'declarations + documents, as before Migration 62');
    });

    // ══ right to work ══════════════════════════════════════════════════════════════════════════════
    const rtwGuard = async (label: string) => {
      const g = await makeGuard(label);
      await link(abc, g);
      await verifiedDocs(abc, g);
      await record(siaCheck(g.id));
      return g;
    };

    await test('CHK-RTW-01-CONTINUOUS-HAS-NO-EXPIRY-AND-NO-FOLLOW-UP', async () => {
      const g = await rtwGuard('chkrtwcont');
      await rejectsWith(() => record(rtwCheck(g.id, { expiryDate: ukDay(100) })), BadRequestException, /continuous right to work has no expiry/);
      const saved = await record(rtwCheck(g.id));
      assert.equal(saved.expiryDate, null);
      const s = await summary(g);
      assert.equal(s.complianceStatus, 'valid');
      assert.match(s.requirements.find((r) => r.key === 'right_to_work_check')!.detail, /No follow-up check needed/);
    });

    await test('CHK-RTW-02-TIME-LIMITED-NEEDS-AN-EXPIRY-AND-SIGNALS-THE-FOLLOW-UP', async () => {
      const g = await rtwGuard('chkrtwtl');
      await rejectsWith(() => record(rtwCheck(g.id, { rightToWorkExcuse: 'time_limited' })), BadRequestException, /date the permission to work ends/);
      await record(rtwCheck(g.id, { rightToWorkExcuse: 'time_limited', method: 'home_office_online', expiryDate: ukDay(200) }));
      const s = await summary(g);
      assert.equal(s.complianceStatus, 'valid');
      assert.match(s.requirements.find((r) => r.key === 'right_to_work_check')!.detail, /Follow-up check due by/);
    });

    await test('CHK-RTW-03-TIME-LIMITED-EXPIRING-WITHIN-30-DAYS-WARNS-BUT-DEPLOYS', async () => {
      const g = await rtwGuard('chkrtwexpiring');
      await record(rtwCheck(g.id, { rightToWorkExcuse: 'time_limited', expiryDate: ukDay(20) }));
      const s = await summary(g);
      assert.equal(s.complianceStatus, 'expiring');
      assert.equal(s.assignable, true);
      assert.ok(s.expiringReasons.includes('Right to work permission expires within 30 days'));
      await compliance.assertGuardAssignable(abc.id, g.id);
    });

    await test('CHK-RTW-04-EXPIRED-PERMISSION-BLOCKS-UNTIL-A-FOLLOW-UP-CHECK-IS-RECORDED', async () => {
      const g = await rtwGuard('chkrtwexpired');
      // A check made 300 days ago showing permission that ended yesterday.
      const first = await record(rtwCheck(g.id, { rightToWorkExcuse: 'time_limited', checkDate: ukDay(-300), expiryDate: ukDay(-1) }));
      const s = await summary(g);
      assert.equal(s.complianceStatus, 'expired');
      assert.equal(s.assignable, false);
      assert.ok(s.blockingReasons.includes('Right to work permission expired'));
      await rejectsWith(() => compliance.assertGuardAssignable(abc.id, g.id), ForbiddenException, /Right to work permission expired/);
      // The follow-up check need not be the same type of check.
      await record(rtwCheck(g.id, { replacesCheckId: first.id, changeType: 'new_check', method: 'home_office_online', rightToWorkExcuse: 'time_limited', expiryDate: ukDay(365) }));
      await compliance.assertGuardAssignable(abc.id, g.id);
    });

    await test('CHK-RTW-05-ECS-PVN-LASTS-AT-MOST-SIX-MONTHS-FROM-THE-NOTICE', async () => {
      const g = await rtwGuard('chkrtwpvn');
      const pvnDate = ukDay(-10);
      await rejectsWith(
        () => record(rtwCheck(g.id, { method: 'employer_checking_service', rightToWorkExcuse: 'time_limited', expiryDate: ukDay(100) })),
        BadRequestException, /Employer Checking Service result is a Positive Verification Notice/,
      );
      await rejectsWith(
        () => record(rtwCheck(g.id, { method: 'manual_document', rightToWorkExcuse: 'time_limited_pvn', expiryDate: ukDay(100) })),
        BadRequestException, /comes only from the Employer Checking Service/,
      );
      const sixMonths = addCalendarMonths(pvnDate, 6);
      const tooLate = new Date(Date.parse(`${sixMonths}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      await rejectsWith(
        () => record(rtwCheck(g.id, { method: 'employer_checking_service', rightToWorkExcuse: 'time_limited_pvn', checkDate: pvnDate, expiryDate: tooLate })),
        BadRequestException, /six months from its date/,
      );
      await record(rtwCheck(g.id, { method: 'employer_checking_service', rightToWorkExcuse: 'time_limited_pvn', checkDate: pvnDate, expiryDate: sixMonths }));
      assert.equal((await summary(g)).assignable, true);
    });

    await test('CHK-RTW-06-NOT-CONFIRMED-BLOCKS-AND-CARRIES-NO-EXCUSE-OR-EXPIRY', async () => {
      const g = await rtwGuard('chkrtwnc');
      await rejectsWith(() => record(rtwCheck(g.id, { outcome: 'not_confirmed' })), BadRequestException, /has no excuse type/);
      await record(rtwCheck(g.id, { outcome: 'not_confirmed', rightToWorkExcuse: null }));
      const s = await summary(g);
      assert.equal(s.assignable, false);
      assert.ok(s.blockingReasons.includes('Right to work check did not confirm permission to work'));
      assert.equal(s.requirements.find((r) => r.key === 'right_to_work_check')?.state, 'not_confirmed');
    });

    await test('CHK-RTW-07-VALIDATION-REJECTS-WHAT-S4-CANNOT-STAND-BEHIND', async () => {
      const g = await rtwGuard('chkrtwval');
      await rejectsWith(() => record(rtwCheck(g.id, { checkDate: ukDay(1) })), BadRequestException, /cannot be in the future/);
      await rejectsWith(() => record(rtwCheck(g.id, { checkDate: '2026-02-30' })), BadRequestException, /date the check was made/);
      await rejectsWith(() => record(rtwCheck(g.id, { method: 'sia_public_register' })), BadRequestException, /how the right to work was checked/);
      await rejectsWith(() => record(rtwCheck(g.id, { licenceNumber: '1234567890123456' })), BadRequestException, /licence number does not apply/);
      await rejectsWith(() => record(rtwCheck(g.id, { checkedByName: '  ' })), BadRequestException, /who carried out the check/);
      await rejectsWith(() => record(rtwCheck(g.id, { evidenceReference: ' ' })), BadRequestException, /where the evidence of this check is kept/);
      await rejectsWith(
        () => record(rtwCheck(g.id, { rightToWorkExcuse: 'time_limited', checkDate: ukDay(-5), expiryDate: ukDay(-6) })),
        BadRequestException, /already ended on the check date/,
      );
      assert.equal(await checks.count({ where: { guardId: g.id, kind: 'right_to_work' } }), 0, 'nothing was written');
    });

    await test('CHK-RTW-08-WORK-RESTRICTIONS-ARE-RECORDED-AND-SHOWN', async () => {
      const g = await rtwGuard('chkrtwrestrict');
      await record(rtwCheck(g.id, { rightToWorkExcuse: 'time_limited', expiryDate: ukDay(300), workRestrictions: 'Student: 20 hours a week in term time' }));
      const s = await summary(g);
      assert.equal(s.companyChecks?.rightToWork?.workRestrictions, 'Student: 20 hours a week in term time');
    });

    // ══ SIA ════════════════════════════════════════════════════════════════════════════════════════
    const siaGuard = async (label: string) => {
      const g = await makeGuard(label);
      await link(abc, g);
      await verifiedDocs(abc, g);
      await record(rtwCheck(g.id));
      return g;
    };

    await test('CHK-SIA-01-EXPIRED-LICENCE-BLOCKS', async () => {
      const g = await siaGuard('chksiaexp');
      await record(siaCheck(g.id, { checkDate: ukDay(-30), expiryDate: ukDay(-1) }));
      const s = await summary(g);
      assert.equal(s.complianceStatus, 'expired');
      assert.ok(s.blockingReasons.includes('SIA licence expired'));
      await rejectsWith(() => compliance.assertGuardAssignable(abc.id, g.id), ForbiddenException, /SIA licence expired/);
    });

    await test('CHK-SIA-02-EXPIRING-LICENCE-WARNS-BUT-DEPLOYS', async () => {
      const g = await siaGuard('chksiaexpiring');
      await record(siaCheck(g.id, { expiryDate: ukDay(30) }));
      const s = await summary(g);
      assert.equal(s.complianceStatus, 'expiring');
      assert.ok(s.expiringReasons.includes('SIA licence expires within 30 days'));
      await compliance.assertGuardAssignable(abc.id, g.id);
    });

    await test('CHK-SIA-03-NOT-CONFIRMED-BLOCKS', async () => {
      const g = await siaGuard('chksianc');
      await record(siaCheck(g.id, { outcome: 'not_confirmed', expiryDate: null }));
      assert.ok((await summary(g)).blockingReasons.includes('SIA licence check did not confirm an active licence'));
    });

    await test('CHK-SIA-04-VALIDATION', async () => {
      const g = await siaGuard('chksiaval');
      await rejectsWith(() => record(siaCheck(g.id, { licenceNumber: '12345' })), BadRequestException, /16-digit SIA licence number/);
      await rejectsWith(() => record(siaCheck(g.id, { licenceNumber: null })), BadRequestException, /16-digit/);
      await rejectsWith(() => record(siaCheck(g.id, { expiryDate: null })), BadRequestException, /SIA licence expiry date/);
      await rejectsWith(() => record(siaCheck(g.id, { method: 'manual_document' })), BadRequestException, /how the SIA licence was checked/);
      await rejectsWith(() => record(siaCheck(g.id, { rightToWorkExcuse: 'continuous' })), BadRequestException, /does not apply to an SIA check/);
      await rejectsWith(() => record(siaCheck(g.id, { checkDate: ukDay(-3), expiryDate: ukDay(-4) })), BadRequestException, /Record the check as not confirmed/);
      for (const method of ['sia_public_register', 'sia_licence_status_checker', 'sia_licence_card']) {
        assert.equal(service().normalise(siaCheck(g.id, { method })).method, method);
      }
    });
    function service() { return checkService; }

    // ══ history, amendment, audit ═════════════════════════════════════════════════════════════════
    await test('CHK-HIST-01-FIRST-RECORD-IS-AUDITED-AS-RECORDED', async () => {
      const g = await makeGuard('chkhist');
      await link(abc, g);
      const first = await record(siaCheck(g.id));
      const rows = await auditRows(first.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, 'guard_compliance_check.recorded');
      assert.equal(rows[0].companyId, abc.id);
      assert.equal(rows[0].userId, hr.id);
      assert.equal(rows[0].beforeData, null);
      assert.equal(rows[0].afterData.licenceNumber, '1234567890123456');
      assert.equal(rows[0].afterData.guardId, g.id);

      // ── amendment without naming the current check is refused (stale-edit protection) ──
      await rejectsWith(() => record(siaCheck(g.id, { expiryDate: ukDay(500) })), ConflictException, /updated since you opened it/);
      await rejectsWith(() => record(siaCheck(g.id, { replacesCheckId: first.id + 999 })), ConflictException);
      await rejectsWith(() => record(siaCheck(g.id, { replacesCheckId: first.id, changeType: 'correction' })), BadRequestException, /reason for correcting/);

      // ── correction ──
      const corrected = await record(siaCheck(g.id, { replacesCheckId: first.id, changeType: 'correction', changeReason: 'Expiry typed wrongly', expiryDate: ukDay(500) }));
      const history = await checkService.listForCompanyUser(hr.id, hr.role, g.id);
      assert.deepEqual(history.map((h) => h.id), [corrected.id, first.id], 'newest first; nothing deleted');
      assert.equal(history[1].supersededByCheckId, corrected.id);
      assert.ok(history[1].supersededAt);
      assert.equal(history[1].expiryDate, ukDay(400), 'the original record is preserved as it was');
      assert.equal(history[0].supersededAt, null);
      assert.equal((await summary(g)).companyChecks?.sia?.expiryDate, ukDay(500), 'the assessment uses the current check');

      const amended = await auditRows(corrected.id);
      assert.equal(amended[0].action, 'guard_compliance_check.amended');
      assert.equal(amended[0].beforeData.checkId, first.id);
      assert.equal(amended[0].beforeData.expiryDate, ukDay(400));
      assert.equal(amended[0].afterData.expiryDate, ukDay(500));
      assert.equal(amended[0].afterData.changeType, 'correction');
      assert.equal(amended[0].afterData.changeReason, 'Expiry typed wrongly');

      await rejectsWith(() => record(rtwCheck(g.id, { changeType: 'correction', changeReason: 'x' })), BadRequestException, /no check to correct yet/);
    });

    await test('CHK-HIST-02-CONCURRENT-FIRST-RECORDS-CANNOT-BOTH-WIN', async () => {
      const g = await makeGuard('chkrace');
      await link(abc, g);
      const results = await Promise.allSettled([record(rtwCheck(g.id)), record(rtwCheck(g.id))]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      assert.ok(rejected.reason instanceof ConflictException, `got ${rejected.reason}`);
      assert.equal(await checks.count({ where: { guardId: g.id } }), 1);
    });

    await test('CHK-HIST-03-NO-MANUAL-COMPLIANT-OVERRIDE-EXISTS', async () => {
      const controller = readFileSync(join(__dirname, '..', 'src', 'compliance', 'compliance.controller.ts'), 'utf8');
      assert.doesNotMatch(controller, /mark-?compliant|\boverride\b|\bforce\b|markCompliant/i);
      const service = readFileSync(join(__dirname, '..', 'src', 'compliance', 'guard-compliance-check.service.ts'), 'utf8');
      assert.doesNotMatch(service, /guardProfile|guard_profiles"|\.verified\s*=/, 'never writes the profile or verifies documents');
      assert.doesNotMatch(service, /\.delete\(|\.remove\(/, 'history is never deleted');
    });

    // ══ isolation and the ACTIVE relationship ═════════════════════════════════════════════════════
    const shared = await makeGuard('chkshared');
    await link(abc, shared);
    await link(xyz, shared);
    await verifiedDocs(abc, shared);
    await verifiedDocs(xyz, shared);
    await record(siaCheck(shared.id));
    await record(rtwCheck(shared.id));

    await test('CHK-ISO-01-ONE-COMPANYS-CHECKS-NEVER-SATISFY-ANOTHER', async () => {
      assert.equal((await summary(shared, abc)).assignable, true);
      const forXyz = await summary(shared, xyz);
      assert.equal(forXyz.assignable, false);
      assert.deepEqual(forXyz.companyChecks, { sia: null, rightToWork: null });
      await rejectsWith(() => compliance.assertGuardAssignable(xyz.id, shared.id), ForbiddenException, /SIA licence check not recorded/);
    });

    await test('CHK-ISO-02-ANOTHER-COMPANYS-CHECK-DOES-NOT-AFFECT-THIS-ONE', async () => {
      await checkService.recordForCompanyUser(xyzOwner.id, xyzOwner.role, rtwCheck(shared.id, { outcome: 'not_confirmed', rightToWorkExcuse: null }));
      assert.equal((await summary(shared, abc)).assignable, true, 'XYZ’s negative check does not touch ABC');
      const xyzHistory = await checkService.listForCompanyUser(xyzOwner.id, xyzOwner.role, shared.id);
      assert.equal(xyzHistory.length, 1, 'XYZ sees only its own check');
      const abcHistory = await checkService.listForCompanyUser(hr.id, hr.role, shared.id);
      assert.ok(abcHistory.every((h) => h.outcome === 'confirmed'), 'ABC sees only its own checks');
    });

    await test('CHK-ISO-03-WRITES-NEED-AN-ACTIVE-RELATIONSHIP-AND-ALL-REFUSALS-LOOK-THE-SAME', async () => {
      const unrelated = await makeGuard('chkunrelated');
      const blocked = await makeGuard('chkblocked');
      await link(abc, blocked, CompanyGuardStatus.BLOCKED);
      const inactive = await makeGuard('chkinactive');
      await link(abc, inactive, CompanyGuardStatus.INACTIVE);
      const xyzOnly = await makeGuard('chkxyzonly');
      await link(xyz, xyzOnly);
      for (const guardId of [unrelated.id, blocked.id, inactive.id, xyzOnly.id, 987654]) {
        await rejectsWith(() => record(siaCheck(guardId)), ForbiddenException, /^This Guard is not active with your company$/);
      }
      assert.equal(await checks.count({ where: [{ guardId: unrelated.id }, { guardId: blocked.id }, { guardId: inactive.id }, { guardId: xyzOnly.id }] }), 0);
    });

    await test('CHK-ISO-04-HISTORY-IS-READABLE-ONLY-FOR-THIS-COMPANYS-GUARDS', async () => {
      const xyzOnly = await guards.findOneOrFail({ where: { fullName: 'chkxyzonly Guard' } });
      await rejectsWith(() => checkService.listForCompanyUser(hr.id, hr.role, xyzOnly.id), ForbiddenException);
      await rejectsWith(() => checkService.listForCompanyUser(hr.id, hr.role, 987654), ForbiddenException);
    });

    await test('CHK-ISO-05-THE-COMPANY-COMES-FROM-THE-MEMBERSHIP-NEVER-THE-BODY', async () => {
      const dto = new RecordComplianceCheckDto();
      assert.ok(!('companyId' in dto));
      const source = readFileSync(join(__dirname, '..', 'src', 'compliance', 'dto', 'record-compliance-check.dto.ts'), 'utf8');
      assert.doesNotMatch(source, /companyId/);
      // A body carrying a companyId is rejected before the service by the global ValidationPipe
      // (whitelist + forbidNonWhitelisted); and the service ignores anything but the membership.
      const main = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
      assert.match(main, /forbidNonWhitelisted: true/);
      const sneaky = await checkService.recordForCompanyUser(xyzOwner.id, xyzOwner.role, { ...siaCheck(shared.id), companyId: abc.id } as never);
      assert.equal((await checks.findOneByOrFail({ id: sneaky.id })).companyId, xyz.id);
    });

    // ══ permissions ═══════════════════════════════════════════════════════════════════════════════
    await test('CHK-PERM-01-ONLY-OWNER-ADMIN-AND-HR-COMPLIANCE-MAY-RECORD', async () => {
      const allowed = [CompanyMembershipRole.OWNER, CompanyMembershipRole.ADMIN, CompanyMembershipRole.HR_COMPLIANCE];
      for (const role of Object.values(CompanyMembershipRole)) {
        const g = await makeGuard(`chkperm${role}`);
        await link(abc, g);
        const user = staff[role];
        if (allowed.includes(role)) {
          await record(siaCheck(g.id), user);
        } else {
          await rejectsWith(() => record(siaCheck(g.id), user), ForbiddenException, /Insufficient permissions/);
          assert.equal(await checks.count({ where: { guardId: g.id } }), 0, `${role} wrote nothing`);
        }
      }
    });

    await test('CHK-PERM-02-VIEW-ROLES-SEE-HISTORY-BUT-NOT-EVIDENCE-REFERENCES', async () => {
      const viewer = staff[CompanyMembershipRole.VIEWER];
      const asViewer = await checkService.listForCompanyUser(viewer.id, viewer.role, g1.id);
      assert.ok(asViewer.length >= 2);
      assert.ok(asViewer.every((h) => h.evidenceReference === null && h.evidenceDocumentId === null));
      const asHr = await checkService.listForCompanyUser(hr.id, hr.role, g1.id);
      assert.ok(asHr.some((h) => h.evidenceReference === 'HR file 12/SIA'));
      const s = await summary(g1);
      assert.ok(!('evidenceReference' in (s.companyChecks!.sia as object)), 'the compliance summary never carries evidence references');
    });

    // ══ linked evidence ════════════════════════════════════════════════════════════════════════════
    await test('CHK-EVID-01-LINKED-EVIDENCE-MUST-BE-THIS-COMPANYS-COMPLETED-UPLOAD-OF-THE-RIGHT-TYPE', async () => {
      const g = await makeGuard('chkevid');
      await link(abc, g);
      await link(xyz, g);
      const mineUnverified = await fileEvidence(abc, g, GuardDocumentType.SIA_LICENCE, { verified: false });
      const mineIncomplete = await fileEvidence(abc, g, GuardDocumentType.SIA_LICENCE, { complete: false });
      const mineWrongType = await fileEvidence(abc, g, GuardDocumentType.RIGHT_TO_WORK);
      const theirs = await fileEvidence(xyz, g, GuardDocumentType.SIA_LICENCE);
      for (const doc of [mineIncomplete, mineWrongType, theirs]) {
        await rejectsWith(() => record(siaCheck(g.id, { evidenceDocumentId: doc.id, evidenceReference: null })), BadRequestException, /not a completed upload/);
      }
      const linked = await record(siaCheck(g.id, { evidenceDocumentId: mineUnverified.id, evidenceReference: null }));
      assert.equal(linked.evidenceDocumentId, mineUnverified.id);
      const doc = await documents.findOneOrFail({ where: { id: mineUnverified.id } });
      assert.equal(doc.verified, false, 'linking a document to a check never verifies it');
      assert.ok((await summary(g)).blockingReasons.includes('SIA licence document is not verified'));
    });

    // ══ UK calendar dates ══════════════════════════════════════════════════════════════════════════
    await test('CHK-DATE-01-TODAY-IS-THE-UK-DATE-NOT-THE-SERVER-DATE', () => {
      // 23:30 UTC on 30 June is 00:30 BST on 1 July: a licence expiring 30 June has expired in the UK.
      const lateEvening = new Date('2026-06-30T23:30:00Z');
      assert.equal(complianceToday(lateEvening), '2026-07-01');
      assert.equal(daysUntilCalendarDate('2026-06-30', lateEvening), -1);
      assert.equal(daysUntilCalendarDate('2026-07-01', lateEvening), 0, 'valid all day on its expiry date');
      // In winter UK time is UTC.
      assert.equal(complianceToday(new Date('2026-12-31T23:30:00Z')), '2026-12-31');
      // DST change days have no 23/25-hour drift.
      assert.equal(daysUntilCalendarDate('2026-03-30', new Date('2026-03-29T12:00:00Z')), 1);
      assert.equal(daysUntilCalendarDate('2026-10-26', new Date('2026-10-25T12:00:00Z')), 1);
    });

    await test('CHK-DATE-02-CALENDAR-HELPERS', () => {
      assert.equal(toCalendarDate('2026-02-29'), null, 'not a leap year');
      assert.equal(toCalendarDate('2028-02-29'), '2028-02-29');
      assert.equal(addCalendarMonths('2026-08-31', 6), '2027-02-28');
      assert.equal(addCalendarMonths('2026-01-15', 6), '2026-07-15');
      assert.equal(addCalendarMonths('2026-10-12', 3), '2027-01-12');
    });

    // ══ assignment paths ═══════════════════════════════════════════════════════════════════════════
    await test('CHK-GATE-01-ROTA-ASSIGNMENT-GATE-REFUSES-WITHOUT-COMPANY-CHECKS-AND-ADMITS-WITH-THEM', async () => {
      const g = await makeGuard('chkrota');
      await link(abc, g);
      await verifiedDocs(abc, g);
      const start = new Date(Date.now() + 7 * 86400000);
      const end = new Date(start.getTime() + 4 * 3600000);
      // assertGuardCanTakeShift is what rota-slot assignPosition (and so assignMultiple) runs.
      await rejectsWith(() => availability.assertGuardCanTakeShift(abc.id, g.id, start, end), ForbiddenException, /SIA licence check not recorded/);
      await record(siaCheck(g.id));
      await record(rtwCheck(g.id));
      const result = await availability.assertGuardCanTakeShift(abc.id, g.id, start, end);
      assert.equal(result.isEligible, true);
    });

    await test('CHK-GATE-02-EVERY-ASSIGNMENT-PATH-STILL-CALLS-THE-GATE-AND-NONE-WAS-WEAKENED', () => {
      const src = (rel: string) => readFileSync(join(__dirname, '..', 'src', rel), 'utf8');
      const shift = src('shift/shift.service.ts');
      assert.equal((shift.match(/this\.complianceService\.assertGuardAssignable\(/g) || []).length, 4, 'create, createForUser context, offer acceptance, guard change');
      assert.match(src('availability/availability.service.ts'), /this\.complianceService\.assertGuardAssignable\(/);
      assert.match(src('rota-slot/rota-slot.service.ts').split('async assignPosition(')[1].split('async assignMultiple(')[0], /assertGuardCanTakeShift/);
      const gate = src('compliance/compliance.service.ts').split('async assertGuardAssignable')[1].split('async getBlockingRecords')[0];
      assert.match(gate, /UserStatus\.ACTIVE/);
      assert.match(gate, /getBlockingReasons\(companyId, guardId\)/, 'always company-scoped');
      assert.match(src('compliance/guard-compliance.service.ts'), /return \['valid', 'expiring'\]|complianceStatus === 'valid' \|\| summary\.complianceStatus === 'expiring'/);
    });
  } finally {
    await ds.destroy();
  }

  console.log(JSON.stringify({ event: 'company_compliance_checks_certified', tests: passed }));
}

main().catch((error) => {
  console.error('FAIL ', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
