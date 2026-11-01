import { completionDeadline, evaluateRequirements, RequirementResult, syncDeadline } from './patrol-state';

/**
 * One evaluation of finished runs against their rules (S4 1.3.0 B1), shared by the sweep (which judges and records) and
 * every read that explains a run (which never writes), so the dashboard's explanation and the sweep's verdict can never
 * disagree. Owner decision 6:
 *   photo-only       ≥ 1 server-verified, eligible run photo; no checkpoint;
 *   QR-only          the run's route version's required checkpoints scanned; no photo;
 *   QR + photos      both; no per-checkpoint photo on an AUTOMATIC route (a chosen custom route keeps its checkpoints'
 *                    own photo settings, exactly as in 1.2.1);
 *   QR, no route     qr_rule_missing: never verified (rule A1).
 * Pending, uploaded-not-yet-inspected, rejected, quarantined, purged and tombstoned photos never count (patrol-state.ts).
 */

type Runner = { query: (sql: string, params?: unknown[]) => Promise<any> };

export type RunEvaluationContext = {
  visits: any[];
  evidence: any[];
  /** The checkpoints of the runs' route versions: routeId, checkpointId, required, photoRequired, label, route kind. */
  routeCheckpoints: any[];
  /** Active, unrevoked checkpoints of the company that ask for their own photo. */
  photoRequiredAtSite: number[];
  /** Every checkpoint label of the runs' companies, by id (for explanations). */
  labels: Map<number, string>;
  /** The kind of each run's route version ('custom' / 'auto'). */
  routeKinds: Map<number, string>;
  /** The runs' sites whose patrol setup is active (shift-based patrols in force). */
  setupSites?: Set<number>;
};

export async function loadRunEvaluationContext(runner: Runner, companyId: number, runs: any[]): Promise<RunEvaluationContext> {
  const runIds = runs.map((r) => Number(r.id));
  if (!runIds.length) return { visits: [], evidence: [], routeCheckpoints: [], photoRequiredAtSite: [], labels: new Map(), routeKinds: new Map() };
  const visits = await runner.query(
    `SELECT "id", "runId", "checkpointId", "result" FROM "patrol_checkpoint_visits" WHERE "runId" = ANY($1::int[])`,
    [runIds],
  );
  const evidence = await runner.query(
    `SELECT "id", "runId", "visitId", "kind", "uploadStatus", "retentionStatus", "sha256Stored", "syncFlags" FROM "patrol_evidence" WHERE "runId" = ANY($1::int[])`,
    [runIds],
  );
  const routeIds = [...new Set(runs.filter((r) => r.routeId != null).map((r) => Number(r.routeId)))];
  const routeCheckpoints = routeIds.length
    ? await runner.query(
      `SELECT rc."routeId", rc."checkpointId", rc."required", c."photoRequired", c."label", r."kind" FROM "patrol_route_checkpoints" rc
         JOIN "patrol_checkpoints" c ON c."id" = rc."checkpointId" JOIN "patrol_routes" r ON r."id" = rc."routeId"
        WHERE rc."routeId" = ANY($1::int[]) AND c."active" AND c."revokedAt" IS NULL`,
      [routeIds],
    )
    : [];
  const photoRequiredAtSite = (await runner.query(
    `SELECT "id" FROM "patrol_checkpoints" WHERE "companyId" = $1 AND "photoRequired" AND "active" AND "revokedAt" IS NULL`,
    [companyId],
  )).map((c: any) => Number(c.id));
  const labelRows = await runner.query(`SELECT "id", "label" FROM "patrol_checkpoints" WHERE "companyId" = $1`, [companyId]);
  const kindRows = routeIds.length ? await runner.query(`SELECT "id", "kind" FROM "patrol_routes" WHERE "id" = ANY($1::int[])`, [routeIds]) : [];
  const setupRows = await runner.query(
    `SELECT "siteId" FROM "patrol_policies" WHERE "companyId" = $1 AND "siteId" = ANY($2::int[])
        AND "setupConfirmedAt" IS NOT NULL AND "setupMode" IN ('every_shift', 'per_shift')`,
    [companyId, [...new Set(runs.map((r) => Number(r.siteId)))]],
  );
  return {
    visits, evidence, routeCheckpoints, photoRequiredAtSite,
    labels: new Map(labelRows.map((c: any) => [Number(c.id), String(c.label)])),
    routeKinds: new Map(kindRows.map((r: any) => [Number(r.id), String(r.kind ?? 'custom')])),
    setupSites: new Set(setupRows.map((r: any) => Number(r.siteId))),
  };
}

/** The requirement result of one run under its site's policy (the sweep's rule, verbatim). */
export function runRequirements(run: any, policy: { photosPerRun: number; photosPerCheckpoint: number; methods: readonly string[] }, ctx: RunEvaluationContext): RequirementResult {
  const runId = Number(run.id);
  const routeRows = run.routeId == null ? [] : ctx.routeCheckpoints.filter((rc: any) => Number(rc.routeId) === Number(run.routeId));
  const runVisits = ctx.visits.filter((v: any) => Number(v.runId) === runId);
  const runEvidence = ctx.evidence.filter((e: any) => Number(e.runId) === runId);
  // An automatic route (every confirmed checkpoint) asks for no per-checkpoint photo (owner decision 6); nor does a
  // route-less patrol at a site whose setup is active. A custom route keeps its checkpoints' own photo settings. The Guard
  // plan reports the same effective requirement (PatrolGuardService.plan), so the 1.2.1 app asks for exactly these.
  const auto = run.routeId != null
    ? ctx.routeKinds.get(Number(run.routeId)) === 'auto'
    : ctx.setupSites?.has(Number(run.siteId)) === true;
  // The checkpoint rule is the run's route version's required checkpoints (none ⇒ no rule; evaluateRequirements flags it
  // when QR is required). Never every checkpoint of the site, and never "one scan is enough".
  return evaluateRequirements({
    requiredCheckpointIds: routeRows.filter((rc: any) => rc.required).map((rc: any) => Number(rc.checkpointId)),
    photoRequiredCheckpointIds: auto ? [] : [
      ...routeRows.filter((rc: any) => rc.photoRequired).map((rc: any) => Number(rc.checkpointId)),
      ...ctx.photoRequiredAtSite.filter((id: number) => runVisits.some((v: any) => Number(v.checkpointId) === id)),
    ],
    photosPerRun: policy.photosPerRun,
    photosPerCheckpoint: auto ? 0 : policy.photosPerCheckpoint,
    methods: policy.methods,
    visits: runVisits.map((v: any) => ({ visitId: Number(v.id), checkpointId: v.checkpointId == null ? null : Number(v.checkpointId), result: v.result })),
    evidence: runEvidence.map((e: any) => ({
      id: Number(e.id), kind: e.kind, visitId: e.visitId == null ? null : Number(e.visitId), uploadStatus: e.uploadStatus,
      retentionStatus: e.retentionStatus, sha256Stored: e.sha256Stored ?? null,
    })),
  });
}

export type VerificationExplanation = {
  /** A stable code for the reason (the text may be reworded). */
  code:
    | 'in_progress' | 'closed_by_system' | 'verified' | 'scan_flagged' | 'setup_incomplete' | 'checkpoint_not_scanned' | 'photo_rejected'
    | 'photo_not_taken' | 'photo_removed' | 'awaiting_photos' | 'photos_not_received' | 'completed_with_reason' | 'awaiting_check'
    | 'not_verified';
  /** Plain English, site-local times. */
  text: string;
  /** The deadline the text refers to (ISO), when it names one. */
  deadline: string | null;
};

function hhmm(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

function quoteList(labels: string[]): string {
  const q = labels.map((l) => `'${l}'`);
  return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

/**
 * THE explanation of a run's verification state (owner: one server function, plain English). Ordered: what is happening
 * now, then the first thing a person should act on. Pure.
 */
export function explainVerification(input: {
  run: { status: string; verificationStatus: string; exceptionReason?: string | null; startedAtDevice: Date | string; windowEnd?: Date | string | null };
  policy: { maxPatrolDurationMinutes: number; completionGraceMinutes: number; syncGraceMinutes: number; methods: readonly string[] };
  requirements: RequirementResult | null;
  evidence: Array<{ uploadStatus: string; retentionStatus?: string | null }>;
  labels: Map<number, string>;
  now: Date;
  timeZone: string;
}): VerificationExplanation {
  const { run, policy, requirements: r, now, timeZone } = input;
  const compDl = completionDeadline(new Date(run.startedAtDevice), run.windowEnd ? new Date(run.windowEnd) : null, policy);
  const syncDl = syncDeadline(compDl, policy.syncGraceMinutes);
  if (run.status === 'in_progress') {
    return { code: 'in_progress', text: `Patrol in progress (to be completed by ${hhmm(compDl, timeZone)}).`, deadline: compDl.toISOString() };
  }
  if (run.status === 'closed_by_system') {
    return { code: 'closed_by_system', text: 'Closed by S4: the patrol was still in progress when the time for sending patrol data ended.', deadline: null };
  }
  if (run.verificationStatus === 'verified') {
    const photo = policy.methods.includes('photo');
    const qr = policy.methods.includes('qr');
    const what = qr && photo ? 'every required checkpoint was scanned and the patrol photo reached S4' : qr ? 'every required checkpoint was scanned' : 'the patrol photo reached S4 and passed its checks';
    return { code: 'verified', text: `Verified: ${what}.`, deadline: null };
  }
  if (!r) return { code: 'awaiting_check', text: 'Waiting for S4 to check this patrol.', deadline: syncDl.toISOString() };
  if (r.anyFlaggedScan) return { code: 'scan_flagged', text: 'A checkpoint scan was flagged for review (for example an old, foreign or repeated label).', deadline: null };
  if (r.qrRuleMissing) {
    return { code: 'setup_incomplete', text: 'Site setup incomplete: no confirmed checkpoints, so this patrol cannot be verified from QR scans.', deadline: null };
  }
  if (r.missingCheckpointIds.length) {
    const names = r.missingCheckpointIds.map((id) => input.labels.get(id) ?? `#${id}`);
    return { code: 'checkpoint_not_scanned', text: `${names.length === 1 ? 'Checkpoint' : 'Checkpoints'} ${quoteList(names)} not scanned.`, deadline: null };
  }
  if (r.missingRunPhotos + r.missingCheckpointPhotos > 0) {
    if (input.evidence.some((e) => e.uploadStatus === 'rejected')) {
      return { code: 'photo_rejected', text: 'The patrol photo was rejected by S4\'s checks, so there is no usable photo.', deadline: null };
    }
    return { code: 'photo_not_taken', text: 'No patrol photo was taken.', deadline: null };
  }
  const notVerified = r.photosNotVerified ?? r.photosNotOnServer;
  if (notVerified > 0) {
    if (input.evidence.some((e) => e.uploadStatus === 'verified' && ['quarantined', 'purged', 'tombstone'].includes(e.retentionStatus ?? 'active'))) {
      return { code: 'photo_removed', text: 'The patrol photo was deleted, so it no longer counts as evidence.', deadline: null };
    }
    if (now.getTime() < syncDl.getTime()) {
      return { code: 'awaiting_photos', text: `Waiting for photos to upload (deadline ${hhmm(syncDl, timeZone)}).`, deadline: syncDl.toISOString() };
    }
    return { code: 'photos_not_received', text: `Photos did not reach S4 by the deadline (${hhmm(syncDl, timeZone)}).`, deadline: syncDl.toISOString() };
  }
  if (run.status === 'incomplete') {
    return { code: 'completed_with_reason', text: `Completed with a reason: "${run.exceptionReason ?? 'incomplete'}".`, deadline: null };
  }
  if (run.verificationStatus === 'pending') {
    return { code: 'awaiting_check', text: `Waiting for S4 to check this patrol (by ${hhmm(syncDl, timeZone)}).`, deadline: syncDl.toISOString() };
  }
  return { code: 'not_verified', text: 'Not verified.', deadline: null };
}

/** Explanations for a page of runs (one batch of reads). Policies come from `policyFor`; time zones by site. */
export async function explainRuns(
  runner: Runner,
  companyId: number,
  runs: any[],
  policyFor: (siteId: number) => Promise<any>,
  now: Date = new Date(),
): Promise<Map<number, VerificationExplanation>> {
  const out = new Map<number, VerificationExplanation>();
  if (!runs.length) return out;
  const ctx = await loadRunEvaluationContext(runner, companyId, runs);
  const zones = new Map<number, string>(
    (await runner.query(`SELECT "id", "timezone" FROM "sites" WHERE "id" = ANY($1::int[])`, [[...new Set(runs.map((r) => Number(r.siteId)))]]))
      .map((s: any) => [Number(s.id), s.timezone || 'Europe/London']),
  );
  for (const run of runs) {
    const policy = await policyFor(Number(run.siteId));
    const finished = run.status !== 'in_progress' && run.status !== 'closed_by_system';
    out.set(Number(run.id), explainVerification({
      run,
      policy,
      requirements: finished ? runRequirements(run, policy, ctx) : null,
      evidence: ctx.evidence.filter((e: any) => Number(e.runId) === Number(run.id)),
      labels: ctx.labels,
      now,
      timeZone: zones.get(Number(run.siteId)) ?? 'Europe/London',
    }));
  }
  return out;
}
