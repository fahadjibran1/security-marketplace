// The Incident Report: one incident, assembled into something a client can be shown.
//
// THIS MODULE INVENTS NOTHING. Every field is read from an authoritative record — the incident row,
// the audit log, the attachments table — and anything absent is reported as absent. An incident
// report that guesses a timestamp or implies evidence that was never captured is worse than no
// report at all, because somebody will rely on it.
//
// It is pure and has no React, no API client and no formatting of its own beyond the time helpers,
// so the drawer on screen and the printed A4 page are built from the SAME view model and cannot
// drift apart.

import { formatInstantDateTime, formatUkRange } from '../../services/siteTime';
import { resolutionLabel } from './alertResolution';
import {
  incidentCategoryLabel,
  incidentLifecycleLabel,
  incidentSeverityLabel,
} from './incidentLifecycle';
import type { Attachment, AuditLog, Incident } from '../../types/models';

/** What a missing fact reads as. Never an empty cell, never a zero, never "null". */
export const NOT_RECORDED = '—';

export type ReportField = { label: string; value: string };

export type HandlingEntry = {
  /** Stable key for tests and keys; never shown. */
  key: string;
  /** What happened, in the incident's own vocabulary. */
  label: string;
  /** When, on the site's clock. */
  at: string;
  /** Who, as the record identifies them. Empty when the record does not say. */
  actor: string;
  /** Sort position — the raw epoch, so ordering never depends on the formatted string. */
  atMs: number;
};

export type EvidenceItem = {
  id: number;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  /** A human size, e.g. "1.2 MB". Empty when the record does not say. */
  size: string;
  isImage: boolean;
  uploadedBy: string;
  at: string;
};

export type IncidentReportModel = {
  incidentId: number;
  reference: string;
  statusLabel: string;
  title: string;
  /**
   * The guarding company this incident belongs to, from the incident's own eager `company` relation.
   *
   * Empty when the record does not name one, which the footer then simply omits — S4 is the platform,
   * not necessarily the guarding company, so its name must never stand in for a client's provider.
   */
  companyName: string;
  overview: ReportField[];
  /** The guard's own words, verbatim. Empty when none was recorded. */
  originalReport: string;
  evidence: EvidenceItem[];
  handling: HandlingEntry[];
  resolution: {
    recorded: boolean;
    reason: string;
    note: string;
    by: string;
    at: string;
  };
};

/** Bytes as a client would read them. Returns '' rather than "0 B" for a missing size. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * What the report says when no identity is available at all.
 *
 * Truthful rather than blank: the action WAS taken by the control room, and saying so is better than
 * an empty line that looks like a rendering fault. It is never a stand-in for a person's name.
 */
export const CONTROL_ACTOR = 'Recorded by Control';

/**
 * How a person is named in the CLIENT-FACING report.
 *
 * Priority: the person's name, then their email, then the safe fallback. Never "User #21", which
 * means nothing to a client, and never a name that was not recorded.
 *
 * WHAT THE API ACTUALLY PROVIDES, checked rather than assumed: `audit_logs.user` is an eager
 * relation on a `User` carrying nullable `firstName`/`lastName` and a non-null `email`
 * (`passwordHash` is `select: false`, so it never ships). There is no display-name or username
 * column anywhere on `User`. In production today both name columns are NULL for every actor, so the
 * email fallback is what a report currently shows — a presentation requirement is not a reason to
 * add a column or an endpoint, so the limitation is reported instead of engineered around.
 *
 * The Audit Trail is unaffected and still shows the technical account identity.
 */
export function actorLabel(
  user: AuditLog['user'] | null | undefined,
  options?: { fallback?: string },
): string {
  const fallback = options?.fallback ?? '';
  if (!user) return fallback;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || user.email || fallback;
}

const WHEN = (value: string | null | undefined, timeZone: string): string =>
  (value ? formatInstantDateTime(value, timeZone) : '');

/**
 * A shift's scheduled window — THE one rule, used by the drawer and the printed page alike.
 *
 * Same day:  Wed, 30 Sept 2026 · 20:35–21:35
 * Overnight: Wed, 30 Sept 2026 · 20:00 – Thu, 01 Oct 2026 · 08:00
 *
 * Repeating the date on the end time is the same fact told twice, and on a client's report that
 * reads as padding. But a shift that crosses midnight must say so plainly, so there both calendar
 * dates stay — spaced around the dash, because that is where the reader needs the pause.
 *
 * Both surfaces read this through the view model's `overview`, so they cannot drift. If the
 * formatter's shape ever changes, the date comparison simply stops matching and both ends are shown
 * in full: the fallback is verbose, never wrong, and never loses the change of day.
 *
 * Stored timestamps are untouched; this is presentation only.
 */
export function scheduledShiftLabel(
  shift: { start?: string | null; end?: string | null } | null | undefined,
  timeZone: string,
): string {
  if (!shift?.start || !shift?.end) return '';
  const startLabel = WHEN(shift.start, timeZone);
  const endLabel = WHEN(shift.end, timeZone);
  if (!startLabel || !endLabel) return '';

  const [startDate] = startLabel.split(' · ');
  const [endDate, endTime] = endLabel.split(' · ');
  if (startDate && endTime && startDate === endDate) return `${startLabel}–${endTime}`;
  return `${startLabel} – ${endLabel}`;
}

/**
 * The same rule in the UK operational format, for the Log Book surfaces.
 *
 * Kept beside its sibling rather than parameterised: the Incident Report's wording is deliberate and
 * a shared switch would be one edit away from silently restyling a client's incident document.
 */
export function scheduledShiftLabelUk(
  shift: { start?: string | null; end?: string | null } | null | undefined,
  timeZone: string,
): string {
  if (!shift?.start || !shift?.end) return '';
  return formatUkRange(shift.start, shift.end, timeZone, '');
}

/**
 * The evidence attached to this incident.
 *
 * Read from the `attachments` table, which already models `entityType: 'incident'`. Nothing here
 * creates, uploads or signs anything: it renders what the authorised attachments endpoint returned,
 * and an empty list is an empty list.
 */
export function buildEvidence(
  attachments: Attachment[] | null | undefined,
  incidentId: number,
  timeZone: string,
): EvidenceItem[] {
  return (attachments ?? [])
    .filter((item) => item
      && (item.entityType || '').toLowerCase() === 'incident'
      && Number(item.entityId) === Number(incidentId))
    .map((item) => ({
      id: item.id,
      fileName: item.fileName || 'Attachment',
      fileUrl: item.fileUrl || '',
      mimeType: item.mimeType || '',
      size: formatFileSize(item.sizeBytes),
      isImage: (item.mimeType || '').toLowerCase().startsWith('image/'),
      uploadedBy: actorLabel(item.uploadedBy),
      at: WHEN(item.createdAt, timeZone),
    }));
}

/**
 * The lifecycle, as a person would tell it.
 *
 * Built from the AUDIT LOG, not from the incident row, and the difference matters: resolving an
 * incident overwrites `reviewedAt` with the resolution time, so the row alone cannot say when it was
 * marked in review. The audit log keeps both, with the actor for each.
 *
 * `incident.reported` opens the history. Each `incident.status_updated` is named by the status it
 * moved TO, so a transition is described by what it achieved rather than by a raw column diff. An
 * entry whose time cannot be parsed is dropped rather than shown at an invented position.
 */
export function buildHandlingHistory(
  incident: Pick<Incident, 'id' | 'reportedAt' | 'createdAt'> & { guard?: Incident['guard'] },
  auditLogs: AuditLog[] | null | undefined,
  timeZone: string,
): HandlingEntry[] {
  const mine = (auditLogs ?? []).filter((log) => log
    && (log.entityType || '').toLowerCase() === 'incident'
    && Number(log.entityId) === Number(incident.id));

  const entries: HandlingEntry[] = [];

  for (const log of mine) {
    const atMs = Date.parse(log.createdAt);
    if (!Number.isFinite(atMs)) continue;

    const action = (log.action || '').toLowerCase();
    const after = (log.afterData as Record<string, unknown> | null | undefined) ?? {};
    const toStatus = typeof after.status === 'string' ? after.status : '';

    let label = '';
    if (action === 'incident.reported') {
      label = 'Reported';
    } else if (action === 'incident.status_updated') {
      label = statusTransitionLabel(toStatus);
    }
    if (!label) continue;

    /**
     * The guard's own name is the most human identity the records hold for the report entry, and it
     * is the same person: `createForGuard` resolves the guard FROM the acting user, then audits the
     * creation as that user. So a profile name is preferred over that user's email — it is the same
     * individual named properly, not a substitution.
     */
    const reportedByGuard = label === 'Reported' ? (incident.guard?.fullName || '') : '';
    const named = actorLabel(log.user);
    const prefersProfileName = reportedByGuard && (!named || named.includes('@'));

    entries.push({
      key: `audit-${log.id}`,
      label,
      at: WHEN(log.createdAt, timeZone),
      /**
       * "Recorded by Control" is only ever used for a CONTROL action. Saying it of a report the
       * guard filed would be a claim about who raised the incident, so an unidentifiable reporter
       * is left unnamed instead.
       */
      actor: prefersProfileName
        ? reportedByGuard
        : (named || reportedByGuard || (label === 'Reported' ? '' : CONTROL_ACTOR)),
      atMs,
    });
  }

  /**
   * The report falls back to the incident row ONLY for "Reported", and only when the audit log has
   * no report entry — an incident predating the audit of its own creation still has a reported time
   * on the row, and that is a recorded fact rather than an inference.
   */
  if (!entries.some((entry) => entry.label === 'Reported')) {
    const reportedIso = incident.reportedAt || incident.createdAt;
    const atMs = Date.parse(reportedIso ?? '');
    if (Number.isFinite(atMs)) {
      entries.push({
        key: 'incident-reported',
        label: 'Reported',
        at: WHEN(reportedIso, timeZone),
        actor: incident.guard?.fullName || '',
        atMs,
      });
    }
  }

  // Oldest first: a history is read downwards. Ties keep the order the records were written in.
  return entries.sort((a, b) => a.atMs - b.atMs);
}

/** What a move to this status is called in the report. */
function statusTransitionLabel(status: string): string {
  switch ((status || '').trim().toLowerCase()) {
    case 'in_review':
      return 'Marked In Review';
    case 'resolved':
      return 'Resolved';
    case 'closed':
      return 'Closed';
    case 'open':
      return 'Reopened';
    default:
      return '';
  }
}

/**
 * Who resolved it and when.
 *
 * Taken from the audit entry for the move to resolved or closed, because the incident row's
 * `reviewedByUserId` is simply whoever touched it last. When no such audit entry exists — a
 * historical incident resolved before any of this — the row's own `closedAt` is used, and if that is
 * absent too, the report says the evidence was not recorded rather than filling it in.
 */
function resolutionActor(
  incident: Incident,
  auditLogs: AuditLog[] | null | undefined,
  timeZone: string,
): { by: string; at: string } {
  const closing = (auditLogs ?? [])
    .filter((log) => log
      && (log.entityType || '').toLowerCase() === 'incident'
      && Number(log.entityId) === Number(incident.id)
      && (log.action || '').toLowerCase() === 'incident.status_updated')
    .filter((log) => {
      const after = (log.afterData as Record<string, unknown> | null | undefined) ?? {};
      const status = typeof after.status === 'string' ? after.status.toLowerCase() : '';
      return status === 'resolved' || status === 'closed';
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const last = closing[closing.length - 1];
  if (last) {
    return { by: actorLabel(last.user, { fallback: CONTROL_ACTOR }), at: WHEN(last.createdAt, timeZone) };
  }

  const fallback = incident.closedAt || null;
  return { by: '', at: WHEN(fallback, timeZone) };
}

/**
 * The whole report, from records only.
 *
 * `notes` is the guard's report and is never mixed with `resolutionNote`: they are separate fields
 * on the row precisely so that resolving an incident cannot overwrite the account of it.
 */
export function buildIncidentReport(
  incident: Incident,
  auditLogs: AuditLog[] | null | undefined,
  attachments: Attachment[] | null | undefined,
  timeZone: string,
): IncidentReportModel {
  const site = incident.site || incident.shift?.site || null;
  const client = site?.client?.name || site?.clientName || '';
  const shift = incident.shift || null;

  const overview: ReportField[] = [
    { label: 'Incident reference', value: `#${incident.id}` },
    { label: 'Client', value: client },
    { label: 'Site', value: site?.name || '' },
    { label: 'Guard', value: incident.guard?.fullName || '' },
    { label: 'Shift', value: shift?.id ? `#${shift.id}` : '' },
    { label: 'Scheduled shift', value: scheduledShiftLabel(shift, timeZone) },
    { label: 'Location', value: incident.locationText || '' },
    { label: 'Reported', value: WHEN(incident.reportedAt || incident.createdAt, timeZone) },
    { label: 'Severity', value: incidentSeverityLabel(incident.severity) },
    { label: 'Category', value: incidentCategoryLabel(incident.category) },
    { label: 'Current status', value: incidentLifecycleLabel(incident.status) },
  ].map((field) => ({ ...field, value: field.value || NOT_RECORDED }));

  const reason = incident.resolutionReason
    ? resolutionLabel('incident', incident.resolutionReason)
    : '';
  const note = incident.resolutionNote?.trim() || '';
  const { by, at } = resolutionActor(incident, auditLogs, timeZone);

  return {
    incidentId: incident.id,
    reference: `#${incident.id}`,
    statusLabel: incidentLifecycleLabel(incident.status),
    title: incident.title || '',
    companyName: incident.company?.name?.trim() || '',
    overview,
    originalReport: incident.notes?.trim() || '',
    evidence: buildEvidence(attachments, incident.id, timeZone),
    handling: buildHandlingHistory(incident, auditLogs, timeZone),
    resolution: {
      // A resolution the record cannot evidence is reported as absent, not as blank fields.
      recorded: Boolean(reason || note),
      reason,
      note,
      by,
      at,
    },
  };
}
