// Pure presentation model for the Company Compliance workspace (no React / React Native imports so it can be
// unit-tested). It NEVER decides eligibility: the compliance status, blocking reasons and expiring reasons come
// verbatim from the backend Guard compliance summary. This module only groups, counts, filters and labels them.
//
// "Compliance" here is document/licence compliance only. It deliberately says nothing about the Company
// relationship, availability, shift clashes or account approval — so it never uses "Eligible" / "Ready to work".

import type { CompanyGuard, ComplianceRecord, GuardComplianceSummary, GuardDocument } from '../../types/models';

export type ComplianceStatusKey = 'valid' | 'expiring' | 'expired' | 'invalid' | 'unknown';
export type ComplianceFilter = 'all' | 'valid' | 'expiring' | 'attention' | 'unknown';
export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'pending' | 'neutral';

export const EXPIRY_WARNING_DAYS = 30; // mirrors the backend "expires within 30 days" rule; display only

// ─── Permissions ─────────────────────────────────────────────────────────────

export type CompliancePermissions = {
  /** compliance.view — status, list and drawer metadata. */
  canView: boolean;
  /** compliance.manage — view evidence file, upload, verify/unverify, save compliance records. */
  canManage: boolean;
  /** screening.view — Company screening STATUS only. */
  canViewScreening: boolean;
};

/**
 * Effective Company permissions come from the backend session (`user.companyPermissions`). Only when the
 * session has no permission list at all (older sessions) do we fall back to the legacy owner roles — the same
 * fallback the dashboard already uses for guards.manage / payroll.manage. No other role is hard-coded.
 */
export function resolveCompliancePermissions(
  permissions: readonly string[] | null | undefined,
  role?: string | null,
): CompliancePermissions {
  if (permissions) {
    return {
      canView: permissions.includes('compliance.view'),
      canManage: permissions.includes('compliance.manage'),
      canViewScreening: permissions.includes('screening.view'),
    };
  }
  const legacyOwner = role === 'company' || role === 'company_admin';
  return { canView: legacyOwner, canManage: legacyOwner, canViewScreening: legacyOwner };
}

// ─── Rows, metrics, filter, search, sort ─────────────────────────────────────

export type ComplianceRow = {
  guardId: number;
  fullName: string;
  status: ComplianceStatusKey;
  /** null => no compliance summary for this Guard: shown as Unknown, never as Valid. */
  summary: GuardComplianceSummary | null;
};

const KNOWN_STATUSES: ComplianceStatusKey[] = ['valid', 'expiring', 'expired', 'invalid'];

export function normalizeStatus(value?: string | null): ComplianceStatusKey {
  const status = String(value ?? '').trim().toLowerCase();
  return (KNOWN_STATUSES as string[]).includes(status) ? (status as ComplianceStatusKey) : 'unknown';
}

/**
 * One row per Guard the backend returned a summary for, plus one Unknown row for every Guard that has an
 * ACTIVE/BLOCKED Company relationship but no summary (so a missing summary is visible, never silently Valid).
 * INACTIVE relationships are outside the backend compliance population and are not listed.
 */
export function buildComplianceRows(
  summaries: GuardComplianceSummary[],
  companyGuards: CompanyGuard[] = [],
): ComplianceRow[] {
  const rows: ComplianceRow[] = summaries.map((summary) => ({
    guardId: summary.guardId,
    fullName: summary.fullName,
    status: normalizeStatus(summary.complianceStatus),
    summary,
  }));
  const seen = new Set(rows.map((row) => row.guardId));
  for (const link of companyGuards) {
    const relationship = String(link.status || '').toUpperCase();
    if (!link.guard || seen.has(link.guard.id)) continue;
    if (relationship !== 'ACTIVE' && relationship !== 'BLOCKED') continue;
    seen.add(link.guard.id);
    rows.push({ guardId: link.guard.id, fullName: link.guard.fullName, status: 'unknown', summary: null });
  }
  return rows;
}

export type ComplianceMetrics = {
  total: number;
  valid: number;
  expiring: number;
  /** Needs Attention = Expired + Invalid. */
  needsAttention: number;
  unknown: number;
};

export function computeMetrics(rows: ComplianceRow[]): ComplianceMetrics {
  const count = (status: ComplianceStatusKey) => rows.filter((row) => row.status === status).length;
  return {
    total: rows.length,
    valid: count('valid'),
    expiring: count('expiring'),
    needsAttention: count('expired') + count('invalid'),
    unknown: count('unknown'),
  };
}

export function matchesFilter(row: ComplianceRow, filter: ComplianceFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'valid': return row.status === 'valid';
    case 'expiring': return row.status === 'expiring';
    case 'attention': return row.status === 'expired' || row.status === 'invalid';
    case 'unknown': return row.status === 'unknown';
  }
}

const compact = (value: string) => value.toLowerCase().replace(/[\s-]+/g, '');

/** Case-insensitive search over Guard name and SIA number, using the already-loaded rows. */
export function matchesSearch(row: ComplianceRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (row.fullName.toLowerCase().includes(needle)) return true;
  const sia = row.summary?.siaLicenceNumber;
  return Boolean(sia && compact(sia).includes(compact(needle)));
}

const SORT_RANK: Record<ComplianceStatusKey, number> = { expired: 0, invalid: 1, expiring: 2, unknown: 3, valid: 4 };

/** Attention first (expired, invalid), then expiring, unknown, valid; Guard name within a group. */
export function sortRows(rows: ComplianceRow[]): ComplianceRow[] {
  return [...rows].sort((a, b) => SORT_RANK[a.status] - SORT_RANK[b.status] || a.fullName.localeCompare(b.fullName));
}

export function selectVisibleRows(rows: ComplianceRow[], filter: ComplianceFilter, query: string): ComplianceRow[] {
  return sortRows(rows.filter((row) => matchesFilter(row, filter) && matchesSearch(row, query)));
}

/** Strict lookup by Guard id — deliberately no fallback to another Guard (2D3.1 selection invariant). */
export function findRowByGuardId(rows: ComplianceRow[], guardId: number | null): ComplianceRow | null {
  if (guardId === null) return null;
  return rows.find((row) => row.guardId === guardId) ?? null;
}

export const STATUS_LABELS: Record<ComplianceStatusKey, string> = {
  valid: 'Valid',
  expiring: 'Expiring',
  expired: 'Expired',
  invalid: 'Invalid',
  unknown: 'Unknown',
};

export const STATUS_TONES: Record<ComplianceStatusKey, Tone> = {
  valid: 'success',
  expiring: 'warning',
  expired: 'danger',
  invalid: 'danger',
  unknown: 'neutral',
};

// ─── Dates ───────────────────────────────────────────────────────────────────

function parseDateOnly(value?: string | null): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whole days from today to the date (date-only, local). Negative = in the past. null = unparseable/absent. */
export function daysUntil(value: string | null | undefined, now: Date = new Date()): number | null {
  const date = parseDateOnly(value);
  if (!date) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((date.getTime() - today.getTime()) / 86400000);
}

export function formatDate(value?: string | Date | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : parseDateOnly(value) ?? new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export type Indicator = { label: string; detail?: string; tone: Tone };

function expiryIndicator(expiry: string | null | undefined, now: Date): Indicator {
  const days = daysUntil(expiry, now);
  const date = formatDate(expiry);
  if (days === null) return { label: 'Invalid date', detail: expiry ? String(expiry) : undefined, tone: 'danger' };
  if (days < 0) return { label: 'Expired', detail: date, tone: 'danger' };
  if (days === 0) return { label: 'Expires today', detail: date, tone: 'warning' };
  if (days <= EXPIRY_WARNING_DAYS) return { label: `Expires in ${days} day${days === 1 ? '' : 's'}`, detail: date, tone: 'warning' };
  return { label: date, tone: 'neutral' };
}

// ─── SIA ─────────────────────────────────────────────────────────────────────

export function siaIndicator(summary: GuardComplianceSummary | null, now: Date = new Date()): Indicator {
  if (!summary) return { label: '—', tone: 'neutral' };
  if (!summary.siaLicenceNumber || !String(summary.siaLicenceNumber).trim()) return { label: 'Missing', tone: 'danger' };
  if (!summary.siaExpiryDate) return { label: 'No expiry date', tone: 'danger' };
  return expiryIndicator(summary.siaExpiryDate, now);
}

/** Last four digits only — enough to tell Guards apart without putting the full licence number in the table. */
export function maskSiaNumber(value?: string | null): string | null {
  const digits = String(value ?? '').replace(/\s+/g, '');
  if (!digits) return null;
  return digits.length <= 4 ? digits : `•••• ${digits.slice(-4)}`;
}

// ─── Right to work ───────────────────────────────────────────────────────────

// Same status vocabulary the backend uses to decide whether an expiry date is required (display only).
const RTW_INVALID_STATUSES = ['invalid', 'expired', 'revoked', 'refused', 'suspended'];
const RTW_INDEFINITE_STATUSES = ['permanent', 'indefinite', 'settled', 'british', 'citizen', 'no_expiry'];

export function rightToWorkIndicator(summary: GuardComplianceSummary | null, now: Date = new Date()): Indicator {
  if (!summary) return { label: '—', tone: 'neutral' };
  const status = String(summary.rightToWorkStatus ?? '').trim().toLowerCase();
  if (!status) return { label: 'Missing', tone: 'danger' };
  if (RTW_INVALID_STATUSES.includes(status)) {
    return { label: status === 'expired' ? 'Expired' : 'Invalid', detail: summary.rightToWorkStatus ?? undefined, tone: 'danger' };
  }
  if (RTW_INDEFINITE_STATUSES.includes(status)) {
    // An indefinite status normally has no expiry; if one is recorded it is still checked, as the backend does.
    if (summary.rightToWorkExpiryDate) {
      const days = daysUntil(summary.rightToWorkExpiryDate, now);
      if (days !== null && days < 0) return { label: 'Expired', detail: formatDate(summary.rightToWorkExpiryDate), tone: 'danger' };
    }
    return { label: 'Indefinite', tone: 'success' };
  }
  if (!summary.rightToWorkExpiryDate) return { label: 'No expiry date', detail: 'Time-limited status', tone: 'danger' };
  const expiry = expiryIndicator(summary.rightToWorkExpiryDate, now);
  return expiry.tone === 'neutral' ? { label: 'Valid', detail: `Until ${expiry.label}`, tone: 'success' } : expiry;
}

// ─── Documents ───────────────────────────────────────────────────────────────

const REQUIRED_DOCUMENT_TYPES = ['sia_licence', 'right_to_work'] as const;

export type DocumentSummary = {
  required: number;
  verified: number;
  pending: number;
  missing: number;
  expired: boolean;
  headline: string;
  detail?: string;
  tone: Tone;
};

/** Counts the two required evidence types (SIA licence, right to work) from the summary's own documents. */
export function summarizeDocuments(summary: GuardComplianceSummary | null, now: Date = new Date()): DocumentSummary | null {
  if (!summary) return null;
  const documents = summary.documents ?? [];
  let verified = 0;
  let pending = 0;
  let missing = 0;
  let expired = false;
  for (const type of REQUIRED_DOCUMENT_TYPES) {
    const complete = documents.filter((document) => document.type === type && document.uploadCompletedAt);
    if (!complete.length) { missing += 1; continue; }
    const accepted = complete.find((document) => document.verified);
    if (!accepted) { pending += 1; continue; }
    verified += 1;
    const days = daysUntil(accepted.expiryDate, now);
    if (days !== null && days < 0) expired = true;
  }
  const required = REQUIRED_DOCUMENT_TYPES.length;
  const detailParts = [
    pending ? `${pending} pending` : '',
    missing ? `${missing} missing` : '',
    expired ? 'Expired' : '',
  ].filter(Boolean);
  const tone: Tone = missing || expired ? 'danger' : pending ? 'warning' : 'success';
  return { required, verified, pending, missing, expired, headline: `${verified}/${required} verified`, detail: detailParts.join(' · ') || undefined, tone };
}

// ─── Screening (status only) ─────────────────────────────────────────────────

export type ScreeningOutcome = { guardId: number; status: string; vetted: boolean };

const SCREENING_LABELS: Record<string, { label: string; tone: Tone }> = {
  VETTED: { label: 'Vetted', tone: 'success' },
  IN_PROGRESS: { label: 'In progress', tone: 'info' },
  READY_FOR_REVIEW: { label: 'Submitted for review', tone: 'info' },
  UNDER_REVIEW: { label: 'Under review', tone: 'info' },
  REQUIRES_ATTENTION: { label: 'Requires attention', tone: 'warning' },
  NOT_STARTED: { label: 'Not started', tone: 'neutral' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  EXPIRED: { label: 'Expired', tone: 'danger' },
};

/** Friendly screening status. Never leaks a raw enum: an unrecognised value reads as Unknown. */
export function screeningIndicator(outcome: ScreeningOutcome | null | undefined): Indicator {
  if (!outcome) return { label: '—', tone: 'neutral' };
  return SCREENING_LABELS[String(outcome.status).toUpperCase()] ?? { label: 'Unknown', tone: 'neutral' };
}

export function indexScreeningOutcomes(outcomes: ScreeningOutcome[] | null | undefined): Map<number, ScreeningOutcome> {
  return new Map((outcomes ?? []).map((outcome) => [outcome.guardId, outcome]));
}

// ─── Blockers ────────────────────────────────────────────────────────────────

export type BlockerAction =
  | { kind: 'add_document'; documentType: 'sia_licence' | 'right_to_work' }
  | { kind: 'update_record'; recordType: 'SIA' | 'RIGHT_TO_WORK' };

export type Blocker = {
  key: string;
  severity: 'blocking' | 'expiring';
  text: string;
  /** Practical next step; null when there is no accurate, existing action to point to. */
  nextStep: string | null;
  /** Only present for managers, and only for actions that exist in this workspace. */
  action: BlockerAction | null;
};

/** Backend reasons lower-case the licence label ("Missing sia licence expiry date"); restore the acronym. */
export function prettyReason(reason: string): string {
  const text = String(reason).replace(/\bsia\b/gi, 'SIA').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function documentTypeFromReason(reason: string): 'sia_licence' | 'right_to_work' | null {
  if (/\bsia\b/i.test(reason)) return 'sia_licence';
  if (/right-to-work/i.test(reason)) return 'right_to_work';
  return null;
}

const DOCUMENT_NAMES: Record<string, string> = { sia_licence: 'SIA licence', right_to_work: 'right-to-work' };

/** Maps ONE backend reason to a next step. Steps only reference actions that genuinely exist. */
export function describeReason(
  reason: string,
  severity: Blocker['severity'],
  canManage: boolean,
): Pick<Blocker, 'nextStep' | 'action'> {
  const r = reason.toLowerCase();
  const documentType = documentTypeFromReason(reason);
  const docName = documentType ? DOCUMENT_NAMES[documentType] : 'document';
  const managerOnly = (step: string, restricted: string, action: BlockerAction | null) =>
    canManage ? { nextStep: step, action } : { nextStep: restricted, action: null };

  // Guard profile fields (only the Guard can change these)
  if (/^missing sia licence number/.test(r)) return { nextStep: 'Ask the Guard to add their SIA licence number.', action: null };
  if (/sia licence expiry date/.test(r)) return { nextStep: 'Ask the Guard to add or correct their SIA expiry date.', action: null };
  if (/^sia licence expired$/.test(r)) return { nextStep: 'Ask the Guard to update their SIA details once the licence is renewed.', action: null };
  if (/^sia licence expires within/.test(r)) return { nextStep: 'Ask the Guard to renew their SIA licence before it expires.', action: null };
  if (/^missing right-to-work status/.test(r)) return { nextStep: 'Ask the Guard to provide their right-to-work status.', action: null };
  if (/^right-to-work status is/.test(r)) return { nextStep: 'Ask the Guard for current right-to-work evidence and an updated status.', action: null };
  if (/right-to-work clearance expiry date/.test(r)) return { nextStep: 'Ask the Guard to add the right-to-work expiry date, or correct the status if it does not expire.', action: null };
  if (/^right-to-work clearance expired/.test(r)) return { nextStep: 'Ask the Guard for renewed right-to-work evidence and updated details.', action: null };
  if (/^right-to-work clearance expires within/.test(r)) return { nextStep: 'Ask the Guard to renew their right-to-work clearance.', action: null };

  // Evidence documents
  if (/^missing .* document$/.test(r) && documentType) {
    return managerOnly(`Add the ${docName} document.`, `A compliance manager needs to add the ${docName} document.`, { kind: 'add_document', documentType });
  }
  if (/document is not verified$/.test(r)) {
    return managerOnly('Review the uploaded evidence, then verify it.', 'A compliance manager needs to review and verify the uploaded evidence.', null);
  }
  if (/document expired$/.test(r) && documentType) {
    return managerOnly(`Add the renewed ${docName} document.`, `A compliance manager needs to add the renewed ${docName} document.`, { kind: 'add_document', documentType });
  }
  if (/document expires within/.test(r) && documentType) {
    return managerOnly(`Add the renewed ${docName} document before it expires.`, `A compliance manager needs to add the renewed ${docName} document.`, { kind: 'add_document', documentType });
  }

  // Compliance records maintained by the Company
  const recordType: 'SIA' | 'RIGHT_TO_WORK' = /right-to-work/i.test(reason) ? 'RIGHT_TO_WORK' : 'SIA';
  if (/compliance record expired$/.test(r) || /compliance record expiring soon$/.test(r)) {
    const verb = severity === 'blocking' ? 'Update the compliance record with the new expiry date.' : 'Update the compliance record when the licence is renewed.';
    return managerOnly(verb, 'A compliance manager needs to update the compliance record.', { kind: 'update_record', recordType });
  }

  return { nextStep: null, action: null };
}

/** ALL current blockers and expiring items — one entry per backend reason, never only the first. */
export function buildBlockers(summary: GuardComplianceSummary | null, canManage: boolean): Blocker[] {
  if (!summary) return [];
  const make = (reasons: string[], severity: Blocker['severity']) =>
    (reasons ?? []).map((reason, index) => ({
      key: `${severity}-${index}-${reason}`,
      severity,
      text: prettyReason(reason),
      ...describeReason(reason, severity, canManage),
    }));
  return [...make(summary.blockingReasons, 'blocking'), ...make(summary.expiringReasons, 'expiring')];
}

// ─── Documents in the drawer ─────────────────────────────────────────────────

/** Who/when verified, from the fields the backend returns. It returns user ids only — no names. */
export function describeVerification(
  document: Pick<GuardDocument, 'verified' | 'verifiedAt' | 'verifiedByUserId'>,
  currentUserId?: number | null,
): string | null {
  if (!document.verified) return null;
  const when = document.verifiedAt ? formatDate(document.verifiedAt) : null;
  const who = document.verifiedByUserId
    ? document.verifiedByUserId === currentUserId ? 'you' : `user #${document.verifiedByUserId}`
    : null;
  if (!when && !who) return 'Verified';
  return `Verified${when ? ` ${when}` : ''}${who ? ` by ${who}` : ''}`;
}

export const UPLOAD_DOCUMENT_TYPES: Array<{ value: 'sia_licence' | 'right_to_work' | 'id_proof' | 'training'; label: string }> = [
  { value: 'sia_licence', label: 'SIA licence' },
  { value: 'right_to_work', label: 'Right to work' },
  { value: 'id_proof', label: 'ID proof' },
  { value: 'training', label: 'Training' },
];

export const RECORD_TYPES: Array<{ value: 'SIA' | 'RIGHT_TO_WORK' | 'TRAINING' | 'OTHER'; label: string }> = [
  { value: 'SIA', label: 'SIA' },
  { value: 'RIGHT_TO_WORK', label: 'Right to work' },
  { value: 'TRAINING', label: 'Training' },
  { value: 'OTHER', label: 'Other' },
];

export function recordsForGuard(records: ComplianceRecord[], guardId: number): ComplianceRecord[] {
  return records.filter((record) => record.guard?.id === guardId);
}

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

export function normalizeEvidenceMimeType(value: string | undefined, name: string): string | null {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'application/pdf') return normalized;
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'image/jpeg';
  if (normalized === 'image/png') return normalized;
  const extension = name.toLowerCase().split('.').pop();
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  return null;
}

/** Client-side pre-checks that mirror the backend limits, so the manager gets a clear message before uploading. */
export function validateUpload(input: { name?: string | null; mimeType?: string; size?: number | null; expiryDate?: string }): string | null {
  if (!input.name) return 'Choose a document to upload.';
  if (!normalizeEvidenceMimeType(input.mimeType, input.name)) return 'Choose a PDF, JPEG/JPG or PNG document.';
  if (!input.size || input.size < 1) return 'The selected document is empty or its size is unavailable.';
  if (input.size > MAX_EVIDENCE_BYTES) return 'The selected document exceeds the 10 MB size limit.';
  const expiry = (input.expiryDate ?? '').trim();
  if (expiry && !isIsoDate(expiry)) return 'Enter the expiry date as YYYY-MM-DD, or leave it blank.';
  return null;
}

export function isIsoDate(value: string): boolean {
  const date = parseDateOnly(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return formatIso(date) === value;
}

function formatIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
