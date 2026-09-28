/**
 * UAT-DEPLOY-01 / UAT-DEPLOY-02 certification: what availability means for deployment, and the real
 * company-managed deployment journey end to end.
 *
 * Two things were uncovered by production UAT and had ZERO direct test coverage:
 *
 *  1. `availabilityStatus = 'no_rule'` is INFORMATIONAL. It is deliberately absent from `hardBlocked` in
 *     evaluateGuardForShift and from every throw in assertGuardCanTakeShift, so a guard with no
 *     availability rule IS deployable. Production holds zero availability rules, so had this been
 *     blocking, nobody could ever have been rostered. The frontend now renders it as "Availability: Not
 *     set" instead of as an Ineligible reason, and that presentation is only correct while this holds —
 *     so it is pinned here, on the authoritative side.
 *
 *  2. The journey itself. The existing Phase A certification calls completeFileFor() before every
 *     positive assertion, so nothing ever asked what happens to a freshly invited, consented, ACTIVE
 *     EMPLOYEE guard whose company has filed no evidence yet. That is exactly the state real UAT was in.
 *     Here the guard starts with an empty file, is refused, the company files and verifies its own
 *     evidence, and the same guard becomes deployable — with S4 screening still incomplete throughout.
 *
 * Runs the real AvailabilityService, ComplianceService and GuardComplianceService against a real
 * PostgreSQL schema: these are company-scoped SQL filters and a repository fake cannot prove a filter.
 *
 * Needs AVAILABILITY_DATABASE_URL pointing at a DISPOSABLE database — it drops the schema.
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
import { GuardAvailabilityRule } from '../src/availability/entities/guard-availability-rule.entity';
import {
  GuardAvailabilityOverride,
  GuardAvailabilityOverrideStatus,
} from '../src/availability/entities/guard-availability-override.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { Site } from '../src/site/entities/site.entity';
import { AvailabilityService } from '../src/availability/availability.service';
import { ComplianceService } from '../src/compliance/compliance.service';
import { GuardComplianceService } from '../src/compliance/guard-compliance.service';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
};
/** HH:MM in the SAME clock getAvailabilityStatus compares against (it reads local hours/minutes). */
const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

async function main() {
  const url = process.env.AVAILABILITY_DATABASE_URL;
  if (!url) throw new Error('AVAILABILITY_DATABASE_URL is required (use a disposable database)');

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
    const rules = ds.getRepository(GuardAvailabilityRule);
    const overrides = ds.getRepository(GuardAvailabilityOverride);
    const shifts = ds.getRepository(Shift);
    const sites = ds.getRepository(Site);

    // ── fixture ───────────────────────────────────────────────────────────────
    const owner = await users.save(users.create({
      email: 'avail.owner@example.invalid', passwordHash: 'x',
      role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE, isEmailVerified: true,
    }));
    const company = await companies.save(companies.create({
      user: owner, name: 'Availability Security Ltd', companyNumber: '33333333',
      address: '1 Availability Way', contactDetails: 'ops@avail.example.invalid',
    }));
    const site = await sites.save(sites.create({
      company, name: 'Test Site', address: '2 Availability Way',
    }));

    let sia = 2000000000000000;
    const makeGuard = async (label: string, overridesIn: Partial<GuardProfile> = {}) => {
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
        status: 'pending',
        approvalStatus: GuardApprovalStatus.PENDING,
        isApproved: false,
        ...overridesIn,
      }));
    };

    /** An ACTIVE EMPLOYEE relationship established by guard consent, as a workforce invitation makes it. */
    const link = (guard: GuardProfile, status = CompanyGuardStatus.ACTIVE) =>
      links.save(links.create({
        company, guard, status,
        relationshipType: CompanyGuardRelationshipType.EMPLOYEE,
        acceptedAt: new Date(),
      }));

    const fileEvidence = (guard: GuardProfile, type: GuardDocumentType, verified = true) =>
      documents.save(documents.create({
        guard, company, type,
        storageProvider: 's3', storageKey: `compliance/company/${company.id}/${guard.id}/${type}`,
        originalFileName: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: '1024',
        uploadCompletedAt: new Date(), expiryDate: null,
        verified,
        uploadedByUserId: owner.id,
        verifiedByUserId: verified ? owner.id : null,
        verifiedAt: verified ? new Date() : null,
      }));

    const completeFileFor = async (guard: GuardProfile) => {
      await fileEvidence(guard, GuardDocumentType.SIA_LICENCE);
      await fileEvidence(guard, GuardDocumentType.RIGHT_TO_WORK);
    };

    // ── services under test (real implementations) ─────────────────────────────
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

    let approvedLeave = false;
    const availability = new AvailabilityService(
      rules, overrides, shifts, links,
      { findOne: async (id: number) => companies.findOneOrFail({ where: { id } }) } as never,
      membershipStub,
      guardProfileService,
      { hasApprovedLeaveOverlap: async () => approvedLeave } as never,
      compliance,
      { log: async () => undefined } as never,
    );

    // A fixed future window, anchored so the test cannot drift across a day/DST boundary at runtime.
    const startAt = new Date();
    startAt.setDate(startAt.getDate() + 7);
    startAt.setHours(11, 40, 0, 0);
    const endAt = new Date(startAt);
    endAt.setHours(13, 30, 0, 0);

    const evaluate = (guard: GuardProfile) =>
      availability.evaluateGuardForShift({ companyId: company.id, guardId: guard.id, startAt, endAt });

    const NO_RULE_REASON = /No availability rule found for this time/;

    // ══════════ 1-3: no_rule is informational, on every layer ══════════════════

    const compliant = await makeGuard('availcompliant');
    await link(compliant);
    await completeFileFor(compliant);

    await test('AVAIL-01-NO-RULE-DOES-NOT-BLOCK-ELIGIBILITY', async () => {
      assert.equal(await rules.count(), 0, 'fixture has no availability rules at all');
      const result = await evaluate(compliant);
      assert.equal(result.availabilityStatus, 'no_rule');
      assert.equal(result.isEligible, true, 'an absent availability rule must NOT make a guard ineligible');
      assert.equal(result.complianceValid, true);
      assert.ok(
        result.reasons.some((reason) => NO_RULE_REASON.test(reason)),
        `the informational line is still reported, got ${JSON.stringify(result.reasons)}`,
      );
    });

    await test('AVAIL-02-NO-RULE-DOES-NOT-BLOCK-ASSIGNMENT', async () => {
      // The enforcement side: this is the call assignPosition makes, and it must resolve.
      const result = await availability.assertGuardCanTakeShift(company.id, compliant.id, startAt, endAt);
      assert.equal(result.availabilityStatus, 'no_rule');
      assert.equal(result.isEligible, true);
    });

    await test('AVAIL-03-NO-RULE-IS-THE-ONLY-REASON-AN-ELIGIBLE-GUARD-CARRIES', async () => {
      // Pins the frontend's split: for an eligible candidate every reason present is informational, so
      // removing exactly the no_rule line can never hide a real blocker.
      const result = await evaluate(compliant);
      const remaining = result.reasons.filter((reason) => !NO_RULE_REASON.test(reason));
      assert.deepEqual(remaining, [], `an eligible guard must carry no blocking reason, got ${JSON.stringify(remaining)}`);
    });

    // ══════════ 4-6: unavailable DOES block ═══════════════════════════════════

    await test('AVAIL-04-EXPLICITLY-UNAVAILABLE-RULE-BLOCKS', async () => {
      const rule = await rules.save(rules.create({
        company, guard: compliant, weekday: startAt.getDay(),
        startTime: hhmm(startAt), endTime: hhmm(endAt), isAvailable: false,
      }));
      const result = await evaluate(compliant);
      assert.equal(result.availabilityStatus, 'unavailable');
      assert.equal(result.isEligible, false, 'an explicit unavailability must block');
      assert.ok(result.reasons.some((reason) => /marked unavailable/i.test(reason)));
      await assert.rejects(
        () => availability.assertGuardCanTakeShift(company.id, compliant.id, startAt, endAt),
        (error: unknown) => {
          assert.ok(error instanceof ForbiddenException);
          assert.match((error as ForbiddenException).message, /marked unavailable/i);
          return true;
        },
      );
      await rules.remove(rule);
    });

    await test('AVAIL-05-AVAILABLE-RULE-IS-CLEAN', async () => {
      const rule = await rules.save(rules.create({
        company, guard: compliant, weekday: startAt.getDay(),
        startTime: hhmm(startAt), endTime: hhmm(endAt), isAvailable: true,
      }));
      const result = await evaluate(compliant);
      assert.equal(result.availabilityStatus, 'available');
      assert.equal(result.isEligible, true);
      assert.deepEqual(result.reasons, [], 'an available guard carries no reasons at all');
      await rules.remove(rule);
    });

    await test('AVAIL-06-UNAVAILABLE-OVERRIDE-BEATS-AN-AVAILABLE-RULE', async () => {
      const rule = await rules.save(rules.create({
        company, guard: compliant, weekday: startAt.getDay(),
        startTime: hhmm(startAt), endTime: hhmm(endAt), isAvailable: true,
      }));
      const override = await overrides.save(overrides.create({
        company, guard: compliant, date: iso(startAt),
        startTime: hhmm(startAt), endTime: hhmm(endAt),
        status: GuardAvailabilityOverrideStatus.UNAVAILABLE,
      }));
      const result = await evaluate(compliant);
      assert.equal(result.availabilityStatus, 'unavailable', 'a dated override wins over the weekly rule');
      assert.equal(result.isEligible, false);
      await overrides.remove(override);
      await rules.remove(rule);
    });

    // ══════════ 7-10: the real UAT journey, empty file -> deployable ═══════════

    const invited = await makeGuard('availinvited');
    await link(invited);
    const screening = await screenings.save(screenings.create({
      guard: invited, status: ScreeningStatus.UNDER_REVIEW, screeningPeriodYears: 5,
    }));

    await test('JOURNEY-01-INVITED-ACTIVE-EMPLOYEE-WITH-NO-COMPANY-EVIDENCE-IS-REFUSED', async () => {
      const relation = await links.findOneOrFail({ where: { company: { id: company.id }, guard: { id: invited.id } } });
      assert.equal(relation.status, CompanyGuardStatus.ACTIVE, 'the relationship is ACTIVE');
      assert.equal(relation.relationshipType, CompanyGuardRelationshipType.EMPLOYEE, 'and an EMPLOYEE');
      assert.ok(relation.acceptedAt, 'established by guard consent');
      assert.equal(await documents.count({ where: { guard: { id: invited.id } } }), 0, 'and no evidence exists');

      const result = await evaluate(invited);
      assert.equal(result.complianceValid, false);
      assert.equal(result.isEligible, false);
      assert.ok(
        result.reasons.some((reason) => /Missing SIA licence document/.test(reason)),
        `expected the missing-document refusal, got ${JSON.stringify(result.reasons)}`,
      );
    });

    await test('JOURNEY-02-BOTH-DOCUMENTS-ARE-REPORTED-NOT-JUST-THE-FIRST', async () => {
      // The eligibility projection carries only blockers[0]; the Company Compliance projection the
      // frontend reads for detail carries them ALL. That is why the drawer reads the latter.
      const blockers = await guardCompliance.getBlockingReasons(company.id, invited.id);
      assert.ok(blockers.some((reason) => /Missing SIA licence document/.test(reason)));
      assert.ok(
        blockers.some((reason) => /Missing Right-to-work document/.test(reason)),
        `both required documents must be reported, got ${JSON.stringify(blockers)}`,
      );
      const summary = await guardCompliance.getGuardSummary(invited.id, company.id);
      assert.equal(summary.assignable, false);
      assert.deepEqual(
        [...summary.missingDocuments].sort(),
        ['Right-to-work document', 'SIA licence document'],
        'and named as missing documents',
      );
    });

    await test('JOURNEY-03-UNVERIFIED-EVIDENCE-IS-STILL-A-REFUSAL', async () => {
      const unverified = await fileEvidence(invited, GuardDocumentType.SIA_LICENCE, false);
      const result = await evaluate(invited);
      assert.equal(result.isEligible, false, 'an upload nobody checked is not a compliance file');
      assert.ok(result.reasons.some((reason) => /not verified/i.test(reason)));
      await documents.remove(unverified);
    });

    await test('JOURNEY-04-COMPLETE-VERIFIED-COMPANY-EVIDENCE-MAKES-THE-SAME-GUARD-DEPLOYABLE', async () => {
      await completeFileFor(invited);
      const result = await evaluate(invited);
      assert.equal(result.complianceValid, true);
      assert.equal(result.isEligible, true, 'the company owns the compliance duty and has now discharged it');
      // The whole point of Option 3: screening never moved, and never mattered.
      const stillScreening = await screenings.findOneOrFail({ where: { id: screening.id } });
      assert.equal(stillScreening.status, ScreeningStatus.UNDER_REVIEW, 'S4 screening is still incomplete');
      // And availability is still unset, which is still not a blocker.
      assert.equal(result.availabilityStatus, 'no_rule');
      await availability.assertGuardCanTakeShift(company.id, invited.id, startAt, endAt);
    });

    // ══════════ 11-12: the other legitimate blockers still bite ═══════════════

    await test('AVAIL-07-SHIFT-CLASH-BLOCKS', async () => {
      const clash = await shifts.save(shifts.create({
        company, site, siteName: site.name, guard: invited,
        status: 'scheduled', start: startAt, end: endAt,
      } as never));
      const result = await evaluate(invited);
      assert.equal(result.hasShiftClash, true);
      assert.equal(result.isEligible, false);
      await assert.rejects(
        () => availability.assertGuardCanTakeShift(company.id, invited.id, startAt, endAt),
        (error: unknown) => {
          assert.match((error as ForbiddenException).message, /overlapping shift/i);
          return true;
        },
      );
      await shifts.remove(clash);
    });

    await test('AVAIL-08-APPROVED-LEAVE-BLOCKS', async () => {
      approvedLeave = true;
      try {
        const result = await evaluate(invited);
        assert.equal(result.hasApprovedLeave, true);
        assert.equal(result.isEligible, false);
        await assert.rejects(
          () => availability.assertGuardCanTakeShift(company.id, invited.id, startAt, endAt),
          (error: unknown) => {
            assert.match((error as ForbiddenException).message, /approved leave/i);
            return true;
          },
        );
      } finally {
        approvedLeave = false;
      }
    });

    console.log(`\n${passed} availability / deployment journey checks passed`);
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
