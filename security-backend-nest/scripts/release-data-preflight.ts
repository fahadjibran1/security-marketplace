import 'reflect-metadata';
import { buildDatabaseSslOptions } from '../src/database/database-tls.config';

const { Client } = require('pg') as {
  Client: new (options: { connectionString: string; ssl: ReturnType<typeof buildDatabaseSslOptions> }) => Queryable & {
    connect(): Promise<void>;
    end(): Promise<void>;
  };
};

export type Queryable = {
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
};

export function buildPreflightClientOptions(env: NodeJS.ProcessEnv) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return {
    connectionString: env.DATABASE_URL,
    ssl: buildDatabaseSslOptions(env),
  };
}

type Check = {
  key: string;
  sql: string;
  review?: boolean;
};

export type PreflightResult = {
  status: 'PASS' | 'BLOCKED';
  blockers: Record<string, number>;
  blockerDetails: Record<string, Record<string, unknown>[]>;
  reviewRequired: Record<string, number>;
  reviewDetails: Record<string, Record<string, unknown>[]>;
};

const checks: Check[] = [
  {
    key: 'clientsWithoutCompany',
    sql: `SELECT c."id", c."companyId" FROM "clients" c LEFT JOIN "companies" co ON co."id" = c."companyId" WHERE c."companyId" IS NULL OR co."id" IS NULL ORDER BY c."id"`,
  },
  {
    key: 'payrollBatchesWithoutCompany',
    sql: `SELECT pb."id", pb."companyId" FROM "payroll_batches" pb LEFT JOIN "companies" co ON co."id" = pb."companyId" WHERE pb."companyId" IS NULL OR co."id" IS NULL ORDER BY pb."id"`,
  },
  {
    key: 'invalidTimesheetOwnership',
    sql: `SELECT t."id", t."shiftId", t."guardId", t."companyId", s."companyId" AS "shiftCompanyId", s."guardId" AS "shiftGuardId", a."guardId" AS "assignmentGuardId"
      FROM "timesheets" t
      LEFT JOIN "shifts" s ON s."id" = t."shiftId"
      LEFT JOIN "guard_profiles" g ON g."id" = t."guardId"
      LEFT JOIN "companies" co ON co."id" = t."companyId"
      LEFT JOIN "assignments" a ON a."id" = s."assignmentId"
      WHERE t."shiftId" IS NULL OR s."id" IS NULL OR t."guardId" IS NULL OR g."id" IS NULL
        OR t."companyId" IS NULL OR co."id" IS NULL OR t."companyId" IS DISTINCT FROM s."companyId"
        OR (s."guardId" IS NOT NULL AND t."guardId" IS DISTINCT FROM s."guardId")
        OR (a."guardId" IS NOT NULL AND t."guardId" IS DISTINCT FROM a."guardId") ORDER BY t."id"`,
  },
  {
    key: 'orphanAttendance',
    sql: `SELECT ae."id", ae."shiftId", ae."guardId" FROM "attendance_events" ae LEFT JOIN "shifts" s ON s."id" = ae."shiftId" WHERE s."id" IS NULL ORDER BY ae."id"`,
  },
  {
    key: 'attendanceGuardMismatch',
    sql: `SELECT ae."id", ae."shiftId", ae."guardId", s."guardId" AS "shiftGuardId", a."guardId" AS "assignmentGuardId"
      FROM "attendance_events" ae JOIN "shifts" s ON s."id" = ae."shiftId" LEFT JOIN "assignments" a ON a."id" = s."assignmentId"
      WHERE (s."guardId" IS NOT NULL AND ae."guardId" IS DISTINCT FROM s."guardId") OR (a."guardId" IS NOT NULL AND ae."guardId" IS DISTINCT FROM a."guardId") ORDER BY ae."id"`,
  },
  {
    key: 'duplicateAttendanceEvents',
    sql: `SELECT ae."shiftId", ae."guardId", ae."type", array_agg(ae."id" ORDER BY ae."id") AS "attendanceEventIds", count(*)::int AS "count"
      FROM "attendance_events" ae GROUP BY ae."shiftId", ae."guardId", ae."type" HAVING count(*) > 1 ORDER BY ae."shiftId", ae."guardId", ae."type"`,
  },
  {
    key: 'attendanceCheckoutWithoutCheckin',
    sql: `SELECT ae."shiftId", ae."guardId", array_agg(ae."id" ORDER BY ae."id") AS "attendanceEventIds"
      FROM "attendance_events" ae GROUP BY ae."shiftId", ae."guardId"
      HAVING count(*) FILTER (WHERE ae."type" = 'check-out') > 0 AND count(*) FILTER (WHERE ae."type" = 'check-in') = 0 ORDER BY ae."shiftId", ae."guardId"`,
  },
  {
    key: 'attendanceCheckoutBeforeCheckin',
    sql: `SELECT ae."shiftId", ae."guardId", min(ae."occurredAt") FILTER (WHERE ae."type" = 'check-in') AS "checkInAt", min(ae."occurredAt") FILTER (WHERE ae."type" = 'check-out') AS "checkOutAt", array_agg(ae."id" ORDER BY ae."id") AS "attendanceEventIds"
      FROM "attendance_events" ae GROUP BY ae."shiftId", ae."guardId"
      HAVING min(ae."occurredAt") FILTER (WHERE ae."type" = 'check-out') < min(ae."occurredAt") FILTER (WHERE ae."type" = 'check-in') ORDER BY ae."shiftId", ae."guardId"`,
  },
  {
    key: 'payrollStatusWithoutBatch',
    sql: `SELECT t."id", t."companyId", t."payrollStatus", t."payrollBatchId" FROM "timesheets" t WHERE t."payrollStatus" IN ('included', 'paid') AND t."payrollBatchId" IS NULL ORDER BY t."id"`,
  },
  {
    key: 'invalidPayrollBatchMembership',
    sql: `SELECT t."id", t."companyId", t."payrollBatchId", pb."companyId" AS "batchCompanyId" FROM "timesheets" t LEFT JOIN "payroll_batches" pb ON pb."id" = t."payrollBatchId" WHERE t."payrollBatchId" IS NOT NULL AND (pb."id" IS NULL OR t."companyId" IS DISTINCT FROM pb."companyId") ORDER BY t."id"`,
  },
  {
    key: 'duplicatePayrollMembership',
    sql: `SELECT t."shiftId", t."guardId", array_agg(t."id" ORDER BY t."id") AS "timesheetIds", array_agg(DISTINCT t."payrollBatchId") AS "payrollBatchIds"
      FROM "timesheets" t WHERE t."payrollBatchId" IS NOT NULL GROUP BY t."shiftId", t."guardId" HAVING count(DISTINCT t."payrollBatchId") > 1 ORDER BY t."shiftId", t."guardId"`,
  },
  {
    key: 'billingStatusWithoutInvoiceBatch',
    sql: `SELECT t."id", t."companyId", t."billingStatus", t."invoiceBatchId" FROM "timesheets" t WHERE t."billingStatus" IN ('included', 'invoiced') AND t."invoiceBatchId" IS NULL ORDER BY t."id"`,
  },
  {
    key: 'invalidInvoiceBatchMembership',
    sql: `SELECT t."id", t."companyId", t."invoiceBatchId", ib."companyId" AS "batchCompanyId" FROM "timesheets" t LEFT JOIN "invoice_batches" ib ON ib."id" = t."invoiceBatchId" WHERE t."invoiceBatchId" IS NOT NULL AND (ib."id" IS NULL OR t."companyId" IS DISTINCT FROM ib."companyId") ORDER BY t."id"`,
  },
  {
    key: 'invoiceBatchClientCompanyMismatch',
    sql: `SELECT ib."id", ib."companyId", ib."clientId", c."companyId" AS "clientCompanyId" FROM "invoice_batches" ib LEFT JOIN "clients" c ON c."id" = ib."clientId" WHERE c."id" IS NULL OR ib."companyId" IS DISTINCT FROM c."companyId" ORDER BY ib."id"`,
  },
  {
    key: 'invoiceBatchWithoutValidApprovedDuration',
    // to_jsonb keeps this pre-RC1 compatible when approvedMinutes has not yet
    // been added: absence is deliberately treated as no valid duration.
    sql: `SELECT ib."id" AS "invoiceBatchId", t."id" AS "timesheetId", NULLIF(to_jsonb(t)->>'approvedMinutes', '')::integer AS "approvedMinutes" FROM "invoice_batches" ib JOIN "timesheets" t ON t."invoiceBatchId" = ib."id" WHERE NULLIF(to_jsonb(t)->>'approvedMinutes', '')::integer IS NULL OR NULLIF(to_jsonb(t)->>'approvedMinutes', '')::integer <= 0 ORDER BY ib."id", t."id"`,
  },
  {
    key: 'invalidShifts',
    sql: `SELECT s."id", s."companyId", s."siteId", si."companyId" AS "siteCompanyId", s."assignmentId", a."companyId" AS "assignmentCompanyId", s."guardId", a."guardId" AS "assignmentGuardId", s."start", s."end"
      FROM "shifts" s LEFT JOIN "companies" co ON co."id" = s."companyId" LEFT JOIN "sites" si ON si."id" = s."siteId" LEFT JOIN "assignments" a ON a."id" = s."assignmentId"
      WHERE s."companyId" IS NULL OR co."id" IS NULL OR (s."siteId" IS NOT NULL AND (si."id" IS NULL OR si."companyId" IS DISTINCT FROM s."companyId"))
        OR (s."assignmentId" IS NOT NULL AND (a."id" IS NULL OR a."companyId" IS DISTINCT FROM s."companyId"))
        OR (a."guardId" IS NOT NULL AND s."guardId" IS DISTINCT FROM a."guardId") OR s."end" <= s."start" ORDER BY s."id"`,
  },
  {
    key: 'orphanCompanyGuards',
    sql: `SELECT cg."id", cg."companyId", cg."guardId" FROM "company_guards" cg LEFT JOIN "companies" co ON co."id" = cg."companyId" LEFT JOIN "guard_profiles" g ON g."id" = cg."guardId" WHERE cg."companyId" IS NULL OR co."id" IS NULL OR cg."guardId" IS NULL OR g."id" IS NULL ORDER BY cg."id"`,
  },
  {
    key: 'duplicateCompanyGuards',
    sql: `SELECT cg."companyId", cg."guardId", array_agg(cg."id" ORDER BY cg."id") AS "companyGuardIds", count(*)::int AS "count" FROM "company_guards" cg GROUP BY cg."companyId", cg."guardId" HAVING count(*) > 1 ORDER BY cg."companyId", cg."guardId"`,
  },
  {
    key: 'invalidComplianceRelationships',
    sql: `SELECT cr."id", cr."companyId", cr."guardId" FROM "compliance_records" cr LEFT JOIN "company_guards" cg ON cg."companyId" = cr."companyId" AND cg."guardId" = cr."guardId" AND cg."status" = 'ACTIVE' WHERE cg."id" IS NULL ORDER BY cr."id"`,
  },
  {
    key: 'guardDocumentsWithoutProvenance',
    sql: `SELECT gd."id", gd."guardId", gd."companyId", gd."uploadedByUserId" FROM "guard_documents" gd WHERE gd."companyId" IS NULL AND gd."uploadedByUserId" IS NULL ORDER BY gd."id"`,
  },
  {
    key: 'guardDocumentsUsingLegacyExternalUrl',
    sql: `SELECT gd."id", gd."guardId", gd."companyId" FROM "guard_documents" gd WHERE NULLIF(to_jsonb(gd)->>'fileUrl', '') IS NOT NULL AND NULLIF(to_jsonb(gd)->>'storageKey', '') IS NULL ORDER BY gd."id"`,
  },
  {
    key: 'guardDocumentsWithInvalidPrivateStorageMetadata',
    sql: `SELECT gd."id", gd."guardId", gd."companyId" FROM "guard_documents" gd WHERE NULLIF(to_jsonb(gd)->>'storageKey', '') IS NOT NULL AND (NULLIF(to_jsonb(gd)->>'storageProvider', '') IS NULL OR NULLIF(to_jsonb(gd)->>'originalFileName', '') IS NULL OR NULLIF(to_jsonb(gd)->>'mimeType', '') IS NULL OR NULLIF(to_jsonb(gd)->>'sizeBytes', '')::bigint IS NULL OR NULLIF(to_jsonb(gd)->>'sizeBytes', '')::bigint <= 0) ORDER BY gd."id"`,
  },
  {
    key: 'legacyApprovedTimesheetsWithoutVerifiedAttendance',
    review: true,
    // verifiedMinutes may not exist yet on the database being inspected.
    sql: `SELECT t."id", t."companyId", t."guardId", t."shiftId", t."hoursWorked", t."approvedHours", t."approvalStatus" FROM "timesheets" t WHERE t."approvalStatus" = 'approved' AND t."approvedHours" IS NOT NULL AND (to_jsonb(t)->>'verifiedMinutes') IS NULL ORDER BY t."id"`,
  },
];

export async function runPreflight(db: Queryable): Promise<PreflightResult> {
  const blockerDetails: Record<string, Record<string, unknown>[]> = {};
  const reviewDetails: Record<string, Record<string, unknown>[]> = {};

  for (const check of checks) {
    const { rows } = await db.query(check.sql);
    (check.review ? reviewDetails : blockerDetails)[check.key] = rows;
  }

  const blockers = Object.fromEntries(Object.entries(blockerDetails).map(([key, rows]) => [key, rows.length]));
  const reviewRequired = Object.fromEntries(Object.entries(reviewDetails).map(([key, rows]) => [key, rows.length]));
  const blocked = Object.values(blockers).some((count) => count > 0);
  return { status: blocked ? 'BLOCKED' : 'PASS', blockers, blockerDetails, reviewRequired, reviewDetails };
}

async function main(): Promise<void> {
  const client = new Client(buildPreflightClientOptions(process.env));
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const result = await runPreflight(client);
    await client.query('ROLLBACK');
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'BLOCKED' ? 1 : 0;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection may already be unusable */ }
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ status: 'ERROR', message: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  });
}
