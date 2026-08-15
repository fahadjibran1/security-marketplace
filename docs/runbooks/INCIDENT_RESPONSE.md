# S4 Incident Response Runbook

## Severity and command

- **P0:** authentication bypass, cross-tenant disclosure, financial corruption, material data loss, or total outage of critical guard safety operations. Page the incident commander immediately, restrict writes or access where safe, and notify release/security leadership.
- **P1:** major tenant workflow, database, API, attendance, panic-alert, payroll or invoice degradation without confirmed P0 impact. Assign an incident commander and technical owner immediately.
- **P2:** contained degradation, elevated latency, validation inconsistency, or non-critical operational defect. Track with an owner and deadline.

The incident commander owns severity, timeline, containment decisions, communications and closure. Do not lower severity until evidence rules out the higher-impact condition.

## First response

1. Open an incident record with UTC start time, reporter, affected environment and release SHA.
2. Preserve logs, request IDs, deployment events, database metrics and relevant audit rows. Never paste JWTs, passwords, evidence documents or database credentials into the ticket.
3. Stop deployments and unrelated changes. Disable automatic deployment of the suspected release.
4. Determine affected tenants, users, records and time window using read-only queries first.
5. Choose containment: revoke credentials, disable an account, restrict writes, isolate the service, application rollback, or database recovery.
6. Record every command, actor, timestamp and outcome.

## Scenario guidance

### Authentication incident

Revoke or rotate affected credentials and JWT secret where compromise is credible, preserve authentication/request logs, confirm database account status is authoritative, and test all identity classes before reopening access.

### Tenant-data incident

Treat confirmed cross-tenant access as P0. Preserve audit and HTTP evidence, identify every exposed or mutated entity, contain the route or affected accounts, and involve the data-protection/security owner before customer communication.

### Financial-integrity incident

Stop payroll/invoice finalisation and payment actions. Preserve timesheets, attendance, batch memberships, snapshots and audit rows. Do not silently edit paid or issued records; use an approved correction or reversal process.

### Database outage

Check `/health/ready`, provider status, connection saturation and TLS/connectivity. Do not recreate or overwrite the primary database. Restore service first; use `BACKUP_RESTORE.md` only when integrity or availability requires recovery.

### API outage

Check `/health/live`, `/health/ready`, deployment logs and required environment validation. Roll back only to the certified boundary described in `ROLLBACK.md`.

## Escalation and closure

Escalate P0/P1 events to release management, security/data protection, database operations and customer support as impact requires. Close only after containment, recovery, tenant/financial integrity checks, monitoring stability, communications, and a documented corrective-action owner. Preserve the incident evidence according to the approved retention policy.
