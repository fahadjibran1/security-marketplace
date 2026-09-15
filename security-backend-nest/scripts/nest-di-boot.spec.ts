/**
 * Nest DI Boot Regression — verifies the NestJS dependency-injection graph
 * compiles without errors for modules that inject CompanyMembershipService.
 *
 * Why a boot test and not source-string inspection:
 *   Static grep/readFileSync tests check text; they cannot exercise the Nest
 *   DI container algorithm.  compile() actually resolves every constructor
 *   injection in the declared module graph and throws
 *   "Nest can't resolve dependencies of X" if any provider is missing.
 *
 * DI-BOOT-1 imports AuditLogModule (the module that broke production) and
 *   calls compile().  Before the fix, this would throw because
 *   CompanyMembershipService could not be resolved.
 *
 * DI-BOOT-2 checks IncidentModule's runtime module metadata (decorator
 *   reflection) to prove CompanyMembershipModule is wired in its @Module
 *   imports, and that IncidentService's constructor declares the injection.
 *   A full compile() for IncidentModule would require mocking ~30 transitive
 *   TypeORM entities; the metadata check is equivalent for this specific class
 *   of defect.
 *
 * Run: ts-node -r tsconfig-paths/register scripts/nest-di-boot.spec.ts
 * No DATABASE_URL required.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogModule } from '../src/audit-log/audit-log.module';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';

import { CompanyMembershipModule } from '../src/company-membership/company-membership.module';
import { CompanyMembershipService } from '../src/company-membership/company-membership.service';
import { CompanyMembership } from '../src/company-membership/entities/company-membership.entity';
import { CompanyInvitation } from '../src/company-membership/entities/company-invitation.entity';

import { Company } from '../src/company/entities/company.entity';
import { User } from '../src/user/entities/user.entity';

import { IncidentModule } from '../src/incident/incident.module';
import { IncidentService } from '../src/incident/incident.service';

import { ReportModule } from '../src/report/report.module';
import { IncidentAnalyticsService } from '../src/report/incident-analytics.service';
import { CompanyModule } from '../src/company/company.module';
import { CompanyService } from '../src/company/company.service';

// ── lightweight custom runner (matches project convention) ──────────────────
type Spec = { name: string; run: () => void | Promise<void> };
const specs: Spec[] = [];
const test = (name: string, run: Spec['run']) => specs.push({ name, run });
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

// ── mock repository (satisfies Repository<T> interface for DI purposes) ─────
const mockRepo = {
  find: async () => [],
  findOne: async () => null,
  save: async (e: unknown) => e,
  create: (e: unknown) => e,
  count: async () => 0,
  insert: async () => ({ raw: [], generatedMaps: [] }),
  update: async () => ({ affected: 1 }),
  delete: async () => ({ affected: 1 }),
};

// ── DI-BOOT-1: AuditLogModule full compile ─────────────────────────────────
//
// Imports the real AuditLogModule.  overrideProvider replaces every TypeORM
// forFeature repository token with a plain mock so no database connection is
// needed.  compile() throws with "Nest can't resolve dependencies of
// AuditLogService" if CompanyMembershipModule is absent from AuditLogModule.
test('DI-BOOT-1: AuditLogModule compiles — CompanyMembershipService resolved', async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AuditLogModule],
  })
    .overrideProvider(getRepositoryToken(AuditLog)).useValue(mockRepo)
    .overrideProvider(getRepositoryToken(Company)).useValue(mockRepo)
    .overrideProvider(getRepositoryToken(User)).useValue(mockRepo)
    .overrideProvider(getRepositoryToken(CompanyMembership)).useValue(mockRepo)
    .overrideProvider(getRepositoryToken(CompanyInvitation)).useValue(mockRepo)
    .compile();

  const svc = moduleRef.get(AuditLogService);
  assert(svc instanceof AuditLogService, 'AuditLogService must be constructed');

  // CompanyMembershipService must be reachable; { strict: false } searches all
  // modules in the compiled graph (not only AuditLogModule's own providers).
  const membership = moduleRef.get(CompanyMembershipService, { strict: false });
  assert(membership instanceof CompanyMembershipService,
    'CompanyMembershipService must be reachable from AuditLogModule — ' +
    'check that AuditLogModule imports CompanyMembershipModule');
});

// ── DI-BOOT-2: IncidentModule module-metadata check ────────────────────────
//
// Uses reflect-metadata (emitDecoratorMetadata: true in tsconfig) to verify:
//   a) CompanyMembershipModule appears in IncidentModule's @Module imports
//   b) IncidentService's constructor receives CompanyMembershipService
//
// This catches the defect class: service injects X but hosting module does not
// import the module that provides X.
test('DI-BOOT-2: IncidentModule imports CompanyMembershipModule and wires IncidentService', () => {
  // (a) Check @Module imports metadata
  const moduleImports: unknown[] = Reflect.getMetadata('imports', IncidentModule) ?? [];
  const hasMembershipModule = moduleImports.some((m) => m === CompanyMembershipModule);
  assert(hasMembershipModule,
    'IncidentModule @Module({ imports }) must include CompanyMembershipModule — ' +
    'without it NestJS cannot inject CompanyMembershipService into IncidentService');

  // (b) Check IncidentService constructor paramtypes
  const paramTypes: unknown[] = Reflect.getMetadata('design:paramtypes', IncidentService) ?? [];
  const injectsService = paramTypes.some((p) => p === CompanyMembershipService);
  assert(injectsService,
    'IncidentService constructor must declare CompanyMembershipService as a parameter');
});

// ── DI-BOOT-3: ReportModule module-metadata check ──────────────────────────
//
// IncidentAnalyticsService injects CompanyService.  Before the fix, ReportModule
// did not import CompanyModule, which caused the second production startup failure.
test('DI-BOOT-3: ReportModule imports CompanyModule and wires IncidentAnalyticsService', () => {
  // (a) Check @Module imports metadata
  const moduleImports: unknown[] = Reflect.getMetadata('imports', ReportModule) ?? [];
  const hasCompanyModule = moduleImports.some((m) => m === CompanyModule);
  assert(hasCompanyModule,
    'ReportModule @Module({ imports }) must include CompanyModule — ' +
    'without it NestJS cannot inject CompanyService into IncidentAnalyticsService');

  // (b) Check IncidentAnalyticsService constructor paramtypes
  const paramTypes: unknown[] = Reflect.getMetadata('design:paramtypes', IncidentAnalyticsService) ?? [];
  const injectsService = paramTypes.some((p) => p === CompanyService);
  assert(injectsService,
    'IncidentAnalyticsService constructor must declare CompanyService as a parameter');
});

// ── runner ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n── Nest DI Boot Regression ──────────────────────────────────────────────');
  let pass = 0;
  let fail = 0;

  for (const spec of specs) {
    try {
      await spec.run();
      console.log(`  PASS  ${spec.name}`);
      pass++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL  ${spec.name}`);
      console.log(`        ${msg}`);
      fail++;
    }
  }

  console.log(`\nNEST DI BOOT: ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
})();
