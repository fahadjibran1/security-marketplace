// Patrol Management presentation (Patrols P1-D): pure, so every label, count and rule the page shows is executed in
// tests. Nothing here invents a figure — a value the API does not provide is reported as not available.

import type {
  PatrolEvidence,
  PatrolException,
  PatrolHold,
  PatrolOverview,
  PatrolRoute,
  PatrolRun,
  PatrolRunsPage,
  PatrolSignedLink,
  PatrolWindowsDay,
} from '../../types/patrols';

// ─── words ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function runStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'in_progress': return 'In progress';
    case 'completed': return 'Completed';
    case 'incomplete': return 'Incomplete';
    case 'closed_by_system': return 'Closed by S4 (not completed)';
    default: return status ? String(status) : 'Unknown';
  }
}

export function verificationLabel(status: string | null | undefined): string {
  switch (status) {
    case 'pending': return 'Awaiting verification';
    case 'verified': return 'Verified';
    case 'unverified': return 'Unverified';
    case 'flagged': return 'Flagged';
    default: return status ? String(status) : 'Unknown';
  }
}

export type PatrolTone = 'success' | 'warning' | 'danger' | 'info' | 'pending' | 'neutral';

export function runTone(run: Pick<PatrolRun, 'status' | 'verificationStatus' | 'needsReview'>): PatrolTone {
  if (run.verificationStatus === 'flagged' || run.status === 'closed_by_system') return 'danger';
  if (run.needsReview || run.status === 'incomplete' || run.verificationStatus === 'unverified') return 'warning';
  if (run.status === 'in_progress') return 'info';
  if (run.verificationStatus === 'pending') return 'pending';
  return 'success';
}

export function exceptionTypeLabel(type: string | null | undefined): string {
  switch (type) {
    case 'patrol_missed': return 'Patrol missed';
    case 'patrol_abandoned': return 'Patrol abandoned';
    case 'patrol_incomplete': return 'Patrol incomplete';
    case 'checkpoint_missed': return 'Checkpoint missed';
    case 'evidence_unverified': return 'Evidence not verified';
    case 'patrol_late': return 'Patrol late';
    default: return type ? String(type) : 'Patrol exception';
  }
}

const SYNC_FLAG_LABELS: Record<string, string> = {
  post_shift_creation: 'Reached S4 after the shift ended',
  outside_on_duty_interval: 'Outside the on-duty interval',
  no_matching_window: 'No matching scheduled window',
  clock_drift_suspect: 'Device clock drift',
  synced_after_book_off: 'Synced after Book Off',
  completed_after_book_off: 'Completed after Book Off',
  window_already_covered: 'Window already covered',
  evidence_after_alert: 'Evidence arrived after the alert',
  recovered_via_grant: 'Recovered late under a recovery grant',
};

const SCAN_FLAG_LABELS: Record<string, string> = {
  unsigned_scan: 'Unsigned scan (not verified)',
  signing_key_unavailable: 'Label could not be verified',
  malformed_payload: 'Not an S4 checkpoint label',
  unknown_signing_key: 'Unknown label key',
  tampered_signature: 'Label signature did not match',
  unknown_checkpoint: 'Unknown checkpoint',
  wrong_site: 'Checkpoint of another site',
  checkpoint_revoked: 'Checkpoint revoked',
  revoked_label: 'Old label (reprinted since)',
  invalid_label_version: 'Invalid label version',
  not_on_route: 'Not on this route',
  duplicate_in_run: 'Already scanned in this patrol',
};

export function syncFlagLabel(flag: string): string {
  return SYNC_FLAG_LABELS[flag] ?? flag.replace(/_/g, ' ');
}

export function scanFlagLabel(flag: string): string {
  return SCAN_FLAG_LABELS[flag] ?? flag.replace(/_/g, ' ');
}

/** The run's flags as short badges, in a stable order. "Checkpoint label scanned" is the claim — never presence. */
export function runFlagBadges(run: Pick<PatrolRun, 'lateStart' | 'provisional' | 'needsReview' | 'syncedLate' | 'syncFlags'>): Array<{ label: string; tone: PatrolTone }> {
  const badges: Array<{ label: string; tone: PatrolTone }> = [];
  if (run.lateStart) badges.push({ label: 'Late start', tone: 'warning' });
  if (run.provisional) badges.push({ label: 'Provisional', tone: 'pending' });
  if (run.needsReview) badges.push({ label: 'Needs review', tone: 'warning' });
  if (run.syncedLate) badges.push({ label: 'Late sync', tone: 'info' });
  return badges;
}

/**
 * Pending sync, from the server's own fields: a run whose verification is still pending has items the server is
 * waiting for (scans or photos the Guard's device has not delivered yet). The dashboard can only ever see what has
 * reached the server, so it says "waiting for the device", never "missing".
 */
export function pendingSyncLabel(run: Pick<PatrolRun, 'status' | 'verificationStatus' | 'provisional'>): string | null {
  if (run.verificationStatus !== 'pending') return null;
  return run.status === 'in_progress' ? 'Patrol in progress — data still arriving from the device' : 'Waiting for the device to finish syncing';
}

// ─── times ────────────────────────────────────────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** dd/mm/yyyy hh:mm in a time zone (the site's). '—' when absent. */
export function formatPatrolDateTime(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date).replace(',', '');
  } catch {
    return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
  }
}

export function formatPatrolDate(value: string | null | undefined): string {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

/**
 * Clock drift as the server measured it: server receipt − the device's sentAtDevice. Positive: the device clock is
 * BEHIND the server; negative: ahead. Under a second reads as in step.
 */
export function formatClockDrift(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'Not measured';
  const abs = Math.abs(ms);
  if (abs < 1000) return 'In step with S4';
  const totalSeconds = Math.round(abs / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const amount = h ? `${h}h ${pad(m)}m` : m ? `${m}m ${pad(s)}s` : `${s}s`;
  return `Device clock ${ms > 0 ? 'behind' : 'ahead'} by ${amount}`;
}

/**
 * Today as YYYY-MM-DD at a site (#77): the dashboard's day basis (dateBasis: 'site_local'). At 23:30Z on 25 Oct 2025 it
 * is already the 26th in London (BST); at 23:30Z on 30 Mar 2025 already the 31st.
 */
export function siteTodayKey(timeZone: string | null | undefined, now: Date = new Date()): string {
  return zonedDateKey(now.toISOString(), timeZone) ?? now.toISOString().slice(0, 10);
}

/** How the Overview names its day: the basis the SERVER answered with (an older API answers 'utc'). */
export function overviewDayBasisLabel(overview: Pick<PatrolOverview, 'dateBasis' | 'timeZone'>, zone: string, oneSite: boolean): string {
  if (overview.dateBasis !== 'site_local') return 'UTC day';
  return oneSite ? `site-local day, ${overview.timeZone || zone}` : "each site's local day";
}

/**
 * The History date filters (#77). The picker gives SITE-LOCAL calendar dates (YYYY-MM-DD); they are sent as dates with
 * dateBasis 'site_local' and the server turns each into its site's own day instants (midnight to the next midnight,
 * 23 or 25 hours on a DST day), so the client never converts a date with a fixed offset. A half-typed or invalid entry
 * is not sent; a range that ends before it starts is said so.
 */
export function historyDateFilter(from: string, to: string): { from: string | null; to: string | null; dateBasis: 'site_local' | null; problem: string | null } {
  const f = DATE_ONLY.test(from.trim()) ? from.trim() : null;
  const t = DATE_ONLY.test(to.trim()) ? to.trim() : null;
  return {
    from: f,
    to: t,
    dateBasis: f || t ? 'site_local' : null,
    problem: f && t && f > t ? 'The "From" date is after the "To" date, so no patrol can match.' : null,
  };
}

/** YYYY-MM-DD in a site's time zone. */
export function zonedDateKey(iso: string | null | undefined, timeZone: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// ─── progress ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * "x of y checkpoints", formatted. Without a route there is no y, so it reads as a count of checkpoints visited.
 */
export function checkpointProgress(visited: number, total: number | null): { label: string; ratio: number | null } {
  const x = Math.max(0, Math.floor(visited));
  if (total == null || total <= 0) return { label: `${x} checkpoint${x === 1 ? '' : 's'} visited`, ratio: null };
  return { label: `${Math.min(x, total)} of ${total} checkpoints`, ratio: Math.min(1, x / total) };
}

/**
 * A run's checkpoint progress — the ONE value every view shows (#76): the History list, Live Patrols and the run
 * detail all read the server's own `checkpointsVisited` / `checkpointsTotal` (patrol-query.service.ts, computed with
 * the definition the checkpoint_missed rule uses: distinct checkpoints with a scan that was not flagged — a duplicate,
 * off-route or other-site scan never counts). Nothing is recounted here from scans or the route list. When the server
 * did not report it, null: the page shows no progress rather than a figure of its own.
 */
export function runCheckpointProgress(run: Pick<PatrolRun, 'checkpointsVisited' | 'checkpointsTotal'>): { label: string; ratio: number | null } | null {
  if (typeof run.checkpointsVisited !== 'number' || !Number.isFinite(run.checkpointsVisited)) return null;
  return checkpointProgress(run.checkpointsVisited, typeof run.checkpointsTotal === 'number' ? run.checkpointsTotal : null);
}

// ─── overview KPIs ────────────────────────────────────────────────────────────────────────────────────────────────

export type PatrolKpi = { id: string; label: string; value: string; available: boolean; tone: 'neutral' | 'good' | 'warning' | 'attention'; note?: string };

/** The exceptions list answers at most this many rows; a full page means the count is a lower bound. */
export const PATROL_EXCEPTIONS_PAGE_LIMIT = 200;

function countLabel(n: number, lowerBound: boolean): string {
  return lowerBound ? `${n}+` : String(n);
}

/**
 * The Overview figures, ONLY from real responses:
 *   - the overview endpoint (the site-local day, #77): runs by status, live runs, flagged scans, open exceptions,
 *     configuration counts;
 *   - the exceptions list: today's missed / abandoned / incomplete windows (created on the overview's date, on its basis);
 *   - today's runs page: runs still awaiting verification (a lower bound when the page is not the whole day).
 *   - the windows endpoint (#78): today's scheduled windows due / completed / outstanding, computed by the server's window
 *     engine from schedules and site time zones. Any figure without a response is shown as not available, never estimated.
 */
export function buildPatrolKpis(input: {
  overview: PatrolOverview | null;
  exceptions: PatrolException[] | null;
  todaysRuns: PatrolRunsPage | null;
  /** #78: today's scheduled windows, from the server (absent: not available). */
  windows?: PatrolWindowsDay | null;
  /** Each site's zone, for the site-local day of an exception. */
  siteZone?: (siteId: number | null | undefined) => string;
}): PatrolKpi[] {
  const { overview, exceptions, todaysRuns } = input;
  const na = (id: string, label: string, note = 'Not available'): PatrolKpi => ({ id, label, value: '—', available: false, tone: 'neutral', note });
  const kpis: PatrolKpi[] = [];
  // #78: the server's own count of today's scheduled windows (GET /patrols/windows/day), or "Not available".
  const w = input.windows;
  if (w && [w.windowsDue, w.windowsCompleted, w.windowsOutstanding].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    kpis.push({ id: 'windows-due', label: 'Windows due today', value: String(w.windowsDue), available: true, tone: 'neutral' });
    kpis.push({ id: 'windows-completed', label: 'Windows completed today', value: String(w.windowsCompleted), available: true, tone: w.windowsDue > 0 && w.windowsOutstanding === 0 ? 'good' : 'neutral' });
    kpis.push({ id: 'windows-outstanding', label: 'Windows outstanding today', value: String(w.windowsOutstanding), available: true, tone: w.windowsOutstanding > 0 ? 'warning' : 'good' });
  } else {
    kpis.push(na('windows-due', 'Windows due today'));
    kpis.push(na('windows-completed', 'Windows completed today'));
    kpis.push(na('windows-outstanding', 'Windows outstanding today'));
  }
  if (overview) {
    const s = overview.runsByStatus || ({} as PatrolOverview['runsByStatus']);
    kpis.push({ id: 'completed', label: 'Completed today', value: String(s.completed ?? 0), available: true, tone: 'good' });
    kpis.push({ id: 'incomplete-runs', label: 'Incomplete today', value: String(s.incomplete ?? 0), available: true, tone: (s.incomplete ?? 0) > 0 ? 'warning' : 'neutral' });
    kpis.push({ id: 'live', label: 'Live patrols', value: String(overview.inProgressNow), available: true, tone: 'neutral' });
    kpis.push({ id: 'open-exceptions', label: 'Open patrol exceptions', value: String(overview.openExceptions), available: true, tone: overview.openExceptions > 0 ? 'attention' : 'good' });
    kpis.push({ id: 'flagged-scans', label: 'Flagged scans today', value: String(overview.flaggedScans), available: true, tone: overview.flaggedScans > 0 ? 'warning' : 'neutral' });
  } else {
    for (const [id, label] of [['completed', 'Completed today'], ['incomplete-runs', 'Incomplete today'], ['live', 'Live patrols'], ['open-exceptions', 'Open patrol exceptions'], ['flagged-scans', 'Flagged scans today']]) {
      kpis.push(na(id, label));
    }
  }
  if (exceptions && overview) {
    const lowerBound = exceptions.length >= PATROL_EXCEPTIONS_PAGE_LIMIT;
    // The exception's day on the overview's own basis: its site's local day (#77), or the UTC day.
    const dayOf = (e: PatrolException) => (overview.dateBasis === 'site_local'
      ? zonedDateKey(e.createdAt, input.siteZone ? input.siteZone(e.siteId) : 'Europe/London')
      : (e.createdAt || '').slice(0, 10));
    const today = exceptions.filter((e) => dayOf(e) === overview.date);
    const count = (type: string) => today.filter((e) => e.type === type).length;
    const missed = count('patrol_missed');
    const abandoned = count('patrol_abandoned');
    kpis.push({ id: 'missed', label: 'Missed today', value: countLabel(missed, lowerBound), available: true, tone: missed > 0 ? 'attention' : 'good' });
    kpis.push({ id: 'abandoned', label: 'Abandoned today', value: countLabel(abandoned, lowerBound), available: true, tone: abandoned > 0 ? 'attention' : 'good' });
  } else {
    kpis.push(na('missed', 'Missed today'));
    kpis.push(na('abandoned', 'Abandoned today'));
  }
  if (todaysRuns) {
    const pending = todaysRuns.items.filter((r) => r.verificationStatus === 'pending').length;
    const lowerBound = todaysRuns.total > todaysRuns.items.length;
    kpis.push({ id: 'awaiting-verification', label: 'Awaiting evidence / verification', value: countLabel(pending, lowerBound && pending > 0), available: true, tone: pending > 0 ? 'warning' : 'neutral' });
  } else {
    kpis.push(na('awaiting-verification', 'Awaiting evidence / verification'));
  }
  return kpis;
}

// ─── evidence ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type EvidenceStatus = 'pending' | 'uploaded' | 'verified' | 'rejected' | 'quarantined' | 'deleted';

export function evidenceStatus(e: Pick<PatrolEvidence, 'uploadStatus' | 'retentionStatus'>): EvidenceStatus {
  if (e.retentionStatus === 'quarantined' || e.retentionStatus === 'claimed') return 'quarantined';
  if (e.retentionStatus === 'purged' || e.retentionStatus === 'tombstone') return 'deleted';
  if (e.uploadStatus === 'rejected' || e.uploadStatus === 'local_corrupt') return 'rejected';
  if (e.uploadStatus === 'verified') return 'verified';
  if (e.uploadStatus === 'uploaded') return 'uploaded';
  return 'pending';
}

export function evidenceStatusLabel(status: EvidenceStatus): string {
  switch (status) {
    case 'pending': return 'Pending upload';
    case 'uploaded': return 'Uploaded — verifying';
    case 'verified': return 'Verified';
    case 'rejected': return 'Rejected';
    case 'quarantined': return 'Quarantined';
    case 'deleted': return 'Deleted';
  }
}

export function evidenceStatusTone(status: EvidenceStatus): PatrolTone {
  switch (status) {
    case 'verified': return 'success';
    case 'pending': return 'pending';
    case 'uploaded': return 'info';
    case 'rejected': return 'danger';
    case 'quarantined': return 'warning';
    case 'deleted': return 'neutral';
  }
}

/** Only a verified photo still in storage can be viewed (the server answers 409 otherwise, so the button is hidden). */
export function canOpenEvidence(e: Pick<PatrolEvidence, 'uploadStatus' | 'retentionStatus'>): boolean {
  return e.uploadStatus === 'verified' && (e.retentionStatus === 'active' || e.retentionStatus === 'claimed');
}

/**
 * Whether an ACTIVE hold covers this photo — the server's own predicate (patrol-evidence-shared heldSql): a hold on the
 * photo, its run, its shift, or its site for a date range containing its capture date in the site's time zone.
 * Null when the holds list is not available to this person (patrols.holds): unknown, never "not held".
 */
export function evidenceHeld(
  e: Pick<PatrolEvidence, 'id' | 'runId' | 'capturedAtDevice'>,
  run: Pick<PatrolRun, 'shiftId' | 'siteId'> | null,
  holds: PatrolHold[] | null,
  siteTimeZone: string | null,
): boolean | null {
  if (!holds) return null;
  const captured = zonedDateKey(e.capturedAtDevice, siteTimeZone);
  return holds.some((h) => {
    if (h.releasedAt) return false;
    if (h.scope === 'evidence') return h.evidenceId === e.id;
    if (h.scope === 'run') return h.runId === e.runId;
    if (h.scope === 'shift') return run != null && h.shiftId === run.shiftId;
    if (h.scope === 'site_date_range') {
      return run != null && h.siteId === run.siteId && captured != null && !!h.fromDate && !!h.toDate && captured >= h.fromDate && captured <= h.toDate;
    }
    return false;
  });
}

export function holdScopeLabel(hold: Pick<PatrolHold, 'scope' | 'evidenceId' | 'runId' | 'shiftId' | 'siteId' | 'fromDate' | 'toDate'>, siteName?: (id: number) => string): string {
  switch (hold.scope) {
    case 'evidence': return `Photo #${hold.evidenceId}`;
    case 'run': return `Patrol #${hold.runId}`;
    case 'shift': return `Shift #${hold.shiftId}`;
    case 'site_date_range': {
      const site = hold.siteId != null ? (siteName ? siteName(hold.siteId) : `Site #${hold.siteId}`) : 'Site';
      return `${site}, ${formatPatrolDate(hold.fromDate)} – ${formatPatrolDate(hold.toDate)}`;
    }
    default: return String(hold.scope);
  }
}

// ─── signed links ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A link is treated as expired this long before its stated expiry, so it is never used at the last second. */
export const SIGNED_LINK_SAFETY_MS = 5_000;

export function signedLinkUsable(link: Pick<PatrolSignedLink, 'expiresAt'> | null | undefined, nowMs: number): boolean {
  if (!link) return false;
  const expires = Date.parse(link.expiresAt);
  return Number.isFinite(expires) && nowMs < expires - SIGNED_LINK_SAFETY_MS;
}

/** Milliseconds until a link must be dropped (never negative, never longer than 15 minutes). */
export function signedLinkLifetimeMs(link: Pick<PatrolSignedLink, 'expiresAt'>, nowMs: number): number {
  const expires = Date.parse(link.expiresAt);
  if (!Number.isFinite(expires)) return 0;
  return Math.max(0, Math.min(15 * 60_000, expires - SIGNED_LINK_SAFETY_MS - nowMs));
}

// ─── photo previews (issue #79) ───────────────────────────────────────────────────────────────────────────────────

/** Photos per page of a run's evidence list; the server allows at most 24 per preview grant. */
export const PATROL_THUMBNAIL_PAGE_SIZE = 12;

/** One page of the run's photos (1-based), the page count, and the "Photos a–b of n" label. */
export function evidencePage<T>(evidence: readonly T[], page: number, pageSize: number = PATROL_THUMBNAIL_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(evidence.length / pageSize));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
  const from = (current - 1) * pageSize;
  const items = evidence.slice(from, from + pageSize);
  const label = evidence.length ? `Photos ${from + 1}–${from + items.length} of ${evidence.length}` : 'No photos';
  return { page: current, totalPages, items, label };
}

/**
 * The preview links of a grant the server answered, by photo id — only well-formed, still-usable https links, and only
 * for the photos the caller asked about. Anything else (an empty or malformed answer, an expired grant) gives no links.
 */
export function thumbnailLinks(
  grant: { expiresAt?: string | null; items?: Array<{ evidenceId: number; url: string | null }> } | null | undefined,
  wanted: readonly number[],
  nowMs: number,
): Map<number, string> {
  const links = new Map<number, string>();
  if (!grant || !Array.isArray(grant.items) || typeof grant.expiresAt !== 'string') return links;
  if (!signedLinkUsable({ expiresAt: grant.expiresAt }, nowMs)) return links;
  for (const item of grant.items) {
    if (item && wanted.includes(item.evidenceId) && typeof item.url === 'string' && /^https:\/\//.test(item.url)) links.set(item.evidenceId, item.url);
  }
  return links;
}

// ─── forms ────────────────────────────────────────────────────────────────────────────────────────────────────────

const HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE_ONLY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export type ScheduleDraft = {
  siteId: string;
  name: string;
  routeId: string;
  daysOfWeek: number[];
  activeFrom: string;
  activeTo: string;
  frequencyMinutes: string;
  windowMinutes: string;
  startsOn: string;
  endsOn: string;
  active: boolean;
};

/** The rules of CreatePatrolScheduleDto, before the request, so the form says what is wrong. Null when valid. */
export function scheduleDraftProblem(draft: ScheduleDraft): string | null {
  if (!Number(draft.siteId)) return 'Choose a site.';
  if (!draft.name.trim()) return 'Give the schedule a name.';
  if (draft.name.trim().length > 120) return 'Keep the name to 120 characters.';
  if (!draft.daysOfWeek.length) return 'Choose at least one day.';
  if (!HH_MM.test(draft.activeFrom) || !HH_MM.test(draft.activeTo)) return 'Enter the active hours as HH:mm (site time).';
  const freq = Number(draft.frequencyMinutes);
  if (!Number.isInteger(freq) || freq < 15 || freq > 1440) return 'Frequency must be 15 to 1440 minutes.';
  if (draft.windowMinutes.trim()) {
    const win = Number(draft.windowMinutes);
    if (!Number.isInteger(win) || win < 5 || win > 1440) return 'Window must be 5 to 1440 minutes.';
    if (win > freq) return 'The window cannot be longer than the frequency.';
  }
  if (draft.startsOn.trim() && !DATE_ONLY.test(draft.startsOn.trim())) return 'Start date must be YYYY-MM-DD.';
  if (draft.endsOn.trim() && !DATE_ONLY.test(draft.endsOn.trim())) return 'End date must be YYYY-MM-DD.';
  if (draft.startsOn.trim() && draft.endsOn.trim() && draft.endsOn.trim() < draft.startsOn.trim()) return 'The end date is before the start date.';
  return null;
}

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function daysLabel(days: number[] | null | undefined): string {
  if (!days || !days.length || days.length === 7) return 'Every day';
  return [...days].sort((a, b) => a - b).map((d) => DAY_NAMES[d - 1] ?? String(d)).join(', ');
}

export function requirementScopeLabel(scope: string | null | undefined): string {
  return scope === 'per_guard' ? 'Every on-duty Guard patrols (per Guard)' : 'One patrol per window covers the site (per site)';
}

export function holdReasonProblem(reason: string): string | null {
  const r = reason.trim();
  if (r.length < 3) return 'A reason of at least 3 characters is required.';
  if (r.length > 1000) return 'Keep the reason to 1000 characters.';
  return null;
}

export type HoldDraft = { scope: 'evidence' | 'run' | 'shift' | 'site_date_range'; targetId: string; siteId: string; fromDate: string; toDate: string; reason: string };

export function holdDraftProblem(draft: HoldDraft): string | null {
  if (draft.scope === 'site_date_range') {
    if (!Number(draft.siteId)) return 'Choose a site.';
    if (!DATE_ONLY.test(draft.fromDate.trim()) || !DATE_ONLY.test(draft.toDate.trim())) return 'Enter both dates as YYYY-MM-DD.';
    if (draft.toDate.trim() < draft.fromDate.trim()) return 'The end date is before the start date.';
  } else if (!(Number(draft.targetId) > 0) || !Number.isInteger(Number(draft.targetId))) {
    return 'Enter the record number to hold.';
  }
  return holdReasonProblem(draft.reason);
}

/** #68: a recovery grant lasts 1–72 hours from issue (24 by default); the server holds the same bounds. */
export const PATROL_RECOVERY_GRANT_DEFAULT_HOURS = 24;
export const PATROL_RECOVERY_GRANT_MAX_HOURS = 72;

export type RecoveryGrantDraft = { shiftId: string; hours: string; reason: string };

export function recoveryGrantDraftProblem(draft: RecoveryGrantDraft): string | null {
  const shift = Number(draft.shiftId);
  if (!(shift > 0) || !Number.isInteger(shift)) return 'Enter the shift number.';
  const hours = draft.hours.trim() === '' ? PATROL_RECOVERY_GRANT_DEFAULT_HOURS : Number(draft.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > PATROL_RECOVERY_GRANT_MAX_HOURS) {
    return `A recovery grant lasts 1 to ${PATROL_RECOVERY_GRANT_MAX_HOURS} hours.`;
  }
  return holdReasonProblem(draft.reason);
}

export function recoveryGrantStatusLabel(status: string): string {
  if (status === 'active') return 'Active';
  if (status === 'revoked') return 'Revoked';
  if (status === 'expired') return 'Expired';
  return status;
}

/** P1-C bounds: a date-range export covers at most 31 days. */
export const PATROL_EXPORT_MAX_RANGE_DAYS = 31;

export function exportDraftProblem(draft: { purpose: string; fromDate: string; toDate: string; runIds: string }): string | null {
  if (!draft.purpose) return 'Choose why the export is needed.';
  const ids = draft.runIds.split(/[\s,]+/).filter(Boolean);
  if (ids.length) {
    if (ids.some((id) => !/^\d+$/.test(id) || Number(id) < 1)) return 'Patrol numbers must be whole numbers.';
    if (ids.length > 200) return 'At most 200 patrols in one export.';
    return null;
  }
  if (!DATE_ONLY.test(draft.fromDate.trim()) || !DATE_ONLY.test(draft.toDate.trim())) return 'Enter a date range (YYYY-MM-DD) or patrol numbers.';
  if (draft.toDate.trim() < draft.fromDate.trim()) return 'The end date is before the start date.';
  const days = (Date.parse(`${draft.toDate.trim()}T00:00:00Z`) - Date.parse(`${draft.fromDate.trim()}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > PATROL_EXPORT_MAX_RANGE_DAYS) return `An export covers at most ${PATROL_EXPORT_MAX_RANGE_DAYS} days.`;
  return null;
}

export function exportStatusLabel(status: string): string {
  switch (status) {
    case 'queued': return 'Queued';
    case 'running': return 'Preparing';
    case 'ready': return 'Ready to download';
    case 'failed': return 'Failed';
    case 'expired': return 'Expired';
    default: return status;
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// ─── Live Operations: actionable patrol alerts only ───────────────────────────────────────────────────────────────

export const PATROL_ALERT_TYPES = ['patrol_missed', 'patrol_abandoned', 'patrol_incomplete', 'checkpoint_missed', 'patrol_unverified'] as const;

export function isPatrolAlertType(type: string | null | undefined): boolean {
  return (PATROL_ALERT_TYPES as readonly string[]).includes((type || '').trim().toLowerCase());
}

export function patrolAlertTitle(type: string | null | undefined): string {
  switch ((type || '').trim().toLowerCase()) {
    case 'patrol_missed': return 'Patrol missed';
    case 'patrol_abandoned': return 'Patrol abandoned';
    case 'patrol_incomplete': return 'Patrol incomplete';
    case 'checkpoint_missed': return 'Checkpoint missed';
    case 'patrol_unverified': return 'Patrol evidence not verified';
    default: return 'Patrol alert';
  }
}

/** Where a Live Operations patrol alert leads: its run when it has one, else its exception (the missed window). */
export type PatrolRecordTarget =
  | { kind: 'run'; runId: number; exceptionId: number | null }
  | { kind: 'exception'; exceptionId: number; windowKey: string | null };

export function patrolRecordTarget(alert: { patrolRunId?: number | null; patrolExceptionId?: number | null; patrolWindowKey?: string | null }): PatrolRecordTarget | null {
  if (alert.patrolRunId) return { kind: 'run', runId: Number(alert.patrolRunId), exceptionId: alert.patrolExceptionId ? Number(alert.patrolExceptionId) : null };
  if (alert.patrolExceptionId) return { kind: 'exception', exceptionId: Number(alert.patrolExceptionId), windowKey: alert.patrolWindowKey ?? null };
  return null;
}

/**
 * Which alerts belong in Live Operations as patrol items: the patrol alert types the server raised (P1-B raises one
 * only for an ACTIONABLE exception) that are not closed. Routine successful patrols, scans and photos never become an
 * alert, so they never reach Live Operations — they stay inside Patrol Management.
 */
export function actionablePatrolAlerts<T extends { type?: string | null; status?: string | null }>(alerts: T[]): T[] {
  return alerts.filter((alert) => isPatrolAlertType(alert.type) && (alert.status || '').toLowerCase() !== 'closed');
}

// ─── layout and polling ───────────────────────────────────────────────────────────────────────────────────────────

export type PatrolLayout = { mode: 'mobile' | 'tablet' | 'desktop'; kpiColumns: number; tabsScroll: boolean; detailFullScreen: boolean; tableRows: boolean };

/** The page's breakpoints — the dashboard's own (theme breakpoints: mobile < 768, tablet < 1024). */
export function patrolLayout(width: number): PatrolLayout {
  if (width < 768) return { mode: 'mobile', kpiColumns: 2, tabsScroll: true, detailFullScreen: true, tableRows: false };
  if (width < 1024) return { mode: 'tablet', kpiColumns: 3, tabsScroll: true, detailFullScreen: false, tableRows: true };
  return { mode: 'desktop', kpiColumns: 4, tabsScroll: false, detailFullScreen: false, tableRows: true };
}

/** Modest: live patrols and the overview refresh every 30 seconds while the page is on screen. */
export const PATROL_POLL_MS = 30_000;

export function shouldPollPatrols(state: { enabled: boolean; hidden: boolean; failure: string | null }): boolean {
  if (!state.enabled || state.hidden) return false;
  // The switch is off or the permission is gone: asking again changes nothing until the session changes.
  return state.failure !== 'not_enabled' && state.failure !== 'forbidden';
}
