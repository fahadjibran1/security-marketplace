/**
 * The application's real route table, read from Nest's own decorator metadata (no app boot, no database): every
 * controller under src/, every handler, its HTTP method and path, the roles that may reach it and its company capability.
 * Used by company-capability-policy.spec.ts and scripts/company-capability-matrix.ts.
 */
import 'reflect-metadata';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { COMPANY_CAPABILITY_KEY, CompanyCapability } from '../../src/company/company-capability';

export interface RouteEntry {
  method: string;
  path: string;
  handler: string;
  file: string;
  roles: string[] | null; // null: no @Roles (JwtAuthGuard alone, or public)
  capability: CompanyCapability | null;
}

const COMPANY_ROLES = ['company', 'company_admin', 'company_staff'];

export function loadRoutes(srcDir = join(__dirname, '..', '..', 'src')): RouteEntry[] {
  const files: string[] = [];
  (function walk(d: string) {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else if (n.endsWith('.controller.ts')) files.push(f);
    }
  })(srcDir);

  const routes: RouteEntry[] = [];
  for (const file of files.sort()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file);
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const ctrlPath = Reflect.getMetadata(PATH_METADATA, exported);
      if (ctrlPath === undefined) continue;
      const classRoles: string[] | undefined = Reflect.getMetadata(ROLES_KEY, exported);
      const classCap: CompanyCapability | undefined = Reflect.getMetadata(COMPANY_CAPABILITY_KEY, exported);
      const proto = (exported as any).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const fn = proto[name];
        if (typeof fn !== 'function') continue;
        const methodPath = Reflect.getMetadata(PATH_METADATA, fn);
        const method = Reflect.getMetadata(METHOD_METADATA, fn);
        if (methodPath === undefined || method === undefined) continue;
        const join2 = (a: string | string[], b: string | string[]) =>
          ('/' + [a, b].map((x) => (Array.isArray(x) ? x[0] : x)).filter((x) => x && x !== '/').join('/')).replace(/\/+/g, '/');
        routes.push({
          method: RequestMethod[method],
          path: join2(ctrlPath, methodPath),
          handler: `${(exported as any).name}.${name}`,
          file: relative(srcDir, file).replace(/\\/g, '/'),
          roles: Reflect.getMetadata(ROLES_KEY, fn) ?? classRoles ?? null,
          capability: Reflect.getMetadata(COMPANY_CAPABILITY_KEY, fn) ?? classCap ?? null,
        });
      }
    }
  }
  return routes.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}

export const isMutating = (r: RouteEntry) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method);
/** A company user can reach it: its roles name a company role, or it has no @Roles at all (any signed-in user). */
export const companyReachable = (r: RouteEntry) => r.roles === null || r.roles.some((x) => COMPANY_ROLES.includes(x));
