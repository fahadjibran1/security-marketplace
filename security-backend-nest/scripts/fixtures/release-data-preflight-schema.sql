DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

CREATE TABLE companies (id integer PRIMARY KEY);
CREATE TABLE guard_profiles (id integer PRIMARY KEY);
CREATE TABLE clients (id integer PRIMARY KEY, "companyId" integer);
CREATE TABLE payroll_batches (id integer PRIMARY KEY, "companyId" integer);
CREATE TABLE assignments (id integer PRIMARY KEY, "companyId" integer, "guardId" integer);
CREATE TABLE sites (id integer PRIMARY KEY, "companyId" integer);
CREATE TABLE shifts (
  id integer PRIMARY KEY, "companyId" integer, "guardId" integer, "assignmentId" integer,
  "siteId" integer, "start" timestamp NOT NULL, "end" timestamp NOT NULL
);
CREATE TABLE invoice_batches (id integer PRIMARY KEY, "companyId" integer, "clientId" integer);
CREATE TABLE timesheets (
  id integer PRIMARY KEY, "shiftId" integer, "guardId" integer, "companyId" integer,
  "hoursWorked" numeric, "approvalStatus" text, "approvedHours" numeric,
  "verifiedMinutes" integer, "approvedMinutes" integer, "payrollStatus" text,
  "payrollBatchId" integer, "billingStatus" text, "invoiceBatchId" integer
);
CREATE TABLE attendance_events (
  id integer PRIMARY KEY, "shiftId" integer, "guardId" integer, "type" text, "occurredAt" timestamp NOT NULL
);
CREATE TABLE company_guards (id integer PRIMARY KEY, "companyId" integer, "guardId" integer, status text);
CREATE TABLE compliance_records (id integer PRIMARY KEY, "companyId" integer, "guardId" integer);

INSERT INTO companies VALUES (1);
INSERT INTO guard_profiles VALUES (10);
INSERT INTO clients VALUES (20, 1);
INSERT INTO payroll_batches VALUES (30, 1);
INSERT INTO assignments VALUES (40, 1, 10);
INSERT INTO sites VALUES (50, 1);
INSERT INTO shifts VALUES (60, 1, 10, 40, 50, '2026-01-01 09:00:00', '2026-01-01 17:00:00');
INSERT INTO invoice_batches VALUES (70, 1, 20);
INSERT INTO timesheets VALUES (80, 60, 10, 1, 8, 'approved', 8, 480, 480, 'included', 30, 'included', 70);
INSERT INTO attendance_events VALUES
  (90, 60, 10, 'check-in', '2026-01-01 09:00:00'),
  (91, 60, 10, 'check-out', '2026-01-01 17:00:00');
INSERT INTO company_guards VALUES (100, 1, 10, 'ACTIVE');
INSERT INTO compliance_records VALUES (110, 1, 10);
