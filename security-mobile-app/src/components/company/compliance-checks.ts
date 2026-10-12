// Company-recorded SIA and Right to Work checks: vocabulary, form state and client-side validation.
//
// Pure (no React, no network) so it can be tested directly. The server (GuardComplianceCheckService) is
// authoritative and applies the same rules; this module exists so a manager sees a problem while the
// form is still open, in the same words.
//
// Vocabulary follows the Home Office "Employer's guide to right to work checks" (1 October 2026) and
// GOV.UK SIA guidance. S4 records what the company checked; it does not decide whether a document or an
// online result gives a statutory excuse.

import type {
  CompanyCheckSummary,
  ComplianceCheckKind,
  ComplianceRequirement,
  RecordComplianceCheckPayload,
} from '../../types/models';
import type { Tone } from './compliance-model';
import { formatUkDate, isoToUkDate, ukDateToIso } from './ukDate';

export type Option<T extends string = string> = { value: T; label: string; help?: string };

export const SIA_METHODS: Option[] = [
  { value: 'sia_public_register', label: 'SIA public register', help: 'Searched the SIA register of licence holders.' },
  { value: 'sia_licence_status_checker', label: 'SIA Licence Status Checker', help: 'The SIA business service for employers.' },
  { value: 'sia_licence_card', label: 'Licence card checked', help: 'The physical licence card, checked as SIA guidance describes.' },
];

export const RIGHT_TO_WORK_METHODS: Option[] = [
  { value: 'manual_document', label: 'Manual document check', help: 'Original documents from List A or List B, checked and copied.' },
  { value: 'home_office_online', label: 'Home Office online check', help: 'Share code and date of birth on GOV.UK.' },
  { value: 'rtw_dvsp', label: 'Digital verification (DVSP)', help: 'A certified Right to Work digital verification service provider.' },
  { value: 'employer_checking_service', label: 'Employer Checking Service', help: 'A Positive Verification Notice from the Home Office.' },
];

export const RIGHT_TO_WORK_EXCUSES: Option[] = [
  { value: 'continuous', label: 'Continuous', help: 'No time limit, for example British or Irish, settled, or List A. No follow-up check.' },
  { value: 'time_limited', label: 'Time-limited', help: 'Permission ends on a date. A follow-up check is due on or before it.' },
  { value: 'time_limited_pvn', label: 'Positive Verification Notice', help: 'Lasts six months from the date of the notice.' },
];

const EXCUSES_BY_METHOD: Record<string, string[]> = {
  manual_document: ['continuous', 'time_limited'],
  home_office_online: ['continuous', 'time_limited'],
  rtw_dvsp: ['continuous', 'time_limited'],
  employer_checking_service: ['time_limited_pvn'],
};

export const PVN_MONTHS = 6;

export function methodsFor(kind: ComplianceCheckKind): Option[] {
  return kind === 'sia' ? SIA_METHODS : RIGHT_TO_WORK_METHODS;
}

export function excusesForMethod(method: string): Option[] {
  const allowed = EXCUSES_BY_METHOD[method] ?? [];
  return RIGHT_TO_WORK_EXCUSES.filter((option) => allowed.includes(option.value));
}

export function methodLabel(method: string | null | undefined): string {
  return [...SIA_METHODS, ...RIGHT_TO_WORK_METHODS].find((option) => option.value === method)?.label ?? 'Unknown method';
}

export function excuseLabel(excuse: string | null | undefined): string {
  return RIGHT_TO_WORK_EXCUSES.find((option) => option.value === excuse)?.label ?? '—';
}

export function outcomeLabel(kind: ComplianceCheckKind, outcome: string): string {
  if (kind === 'sia') return outcome === 'confirmed' ? 'Active licence confirmed' : 'Not confirmed';
  return outcome === 'confirmed' ? 'Right to work confirmed' : 'Not confirmed';
}

// ─── Dates ───────────────────────────────────────────────────────────────────

/** Today's UK calendar date as YYYY-MM-DD; falls back to the device date where Intl time zones are unavailable. */
export function ukTodayIso(now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = (type: string) => parts.find((part) => part.type === type)?.value;
    const value = `${get('year')}-${get('month')}-${get('day')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  } catch {
    // fall through
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const isoDayNumber = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

/** Adds calendar months, clamping to the month's last day (31 Aug + 6 months = 28/29 Feb). */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// ─── Form ────────────────────────────────────────────────────────────────────

export type CheckForm = {
  outcome: 'confirmed' | 'not_confirmed';
  method: string;
  excuse: string;
  licenceNumber: string;
  /** DD/MM/YYYY as typed. */
  checkDate: string;
  /** DD/MM/YYYY as typed. */
  expiryDate: string;
  workRestrictions: string;
  checkedByName: string;
  evidenceReference: string;
  /** Optional: one of this company's uploaded documents for this Guard, of the matching type. Linking never verifies it. */
  evidenceDocumentId: number | null;
  changeType: 'new_check' | 'correction';
  changeReason: string;
};

/**
 * A new check. With a current check, it keeps that check's method, type and licence number, but it is dated
 * today and its expiry is left blank: a follow-up check or a renewal has a new expiry, and carrying the old one
 * over is the mistake this avoids. The Guard's own declarations are never copied in — a company check must be
 * the company's own.
 */
export function initialCheckForm(kind: ComplianceCheckKind, current: CompanyCheckSummary | null, today: string = ukTodayIso()): CheckForm {
  const defaultMethod = kind === 'sia' ? 'sia_public_register' : 'manual_document';
  return {
    outcome: 'confirmed',
    method: current?.method ?? defaultMethod,
    excuse: kind === 'right_to_work' ? current?.rightToWorkExcuse ?? '' : '',
    licenceNumber: kind === 'sia' ? current?.licenceNumber ?? '' : '',
    checkDate: isoToUkDate(today) ?? '',
    expiryDate: '',
    workRestrictions: current?.workRestrictions ?? '',
    checkedByName: '',
    evidenceReference: '',
    evidenceDocumentId: null,
    changeType: 'new_check',
    changeReason: '',
  };
}

/** For a correction, the form shows the current record exactly as it is, including its check date. */
export function correctionForm(kind: ComplianceCheckKind, current: CompanyCheckSummary): CheckForm {
  return {
    ...initialCheckForm(kind, current),
    outcome: current.outcome === 'not_confirmed' ? 'not_confirmed' : 'confirmed',
    checkDate: isoToUkDate(current.checkDate) ?? '',
    expiryDate: isoToUkDate(current.expiryDate) ?? '',
    checkedByName: current.checkedByName,
    changeType: 'correction',
  };
}

export type CheckValidation = { ok: true; payload: RecordComplianceCheckPayload } | { ok: false; error: string };

/** Mirrors the server's rules (GuardComplianceCheckService.normalise). The server remains authoritative. */
export function validateCheckForm(
  kind: ComplianceCheckKind,
  guardId: number,
  form: CheckForm,
  current: CompanyCheckSummary | null,
  today: string = ukTodayIso(),
): CheckValidation {
  const fail = (error: string): CheckValidation => ({ ok: false, error });
  const checkDate = ukDateToIso(form.checkDate.trim());
  if (!checkDate) return fail(kind === 'right_to_work' && form.method === 'employer_checking_service'
    ? 'Enter the date of the Positive Verification Notice as DD/MM/YYYY.'
    : 'Enter the date the check was made as DD/MM/YYYY.');
  if (isoDayNumber(checkDate) > isoDayNumber(today)) return fail('The check date cannot be in the future.');
  const typedExpiry = form.expiryDate.trim();
  const expiryDate = typedExpiry ? ukDateToIso(typedExpiry) : null;
  if (typedExpiry && !expiryDate) return fail('Enter the expiry date as DD/MM/YYYY.');
  const checkedByName = form.checkedByName.trim();
  if (!checkedByName) return fail('Enter who carried out the check.');
  const evidenceReference = form.evidenceReference.trim() || null;
  const evidenceDocumentId = form.evidenceDocumentId ?? null;
  if (!evidenceReference && !evidenceDocumentId) return fail('Enter where the evidence of this check is kept, or link an uploaded document.');
  if (current && form.changeType === 'correction' && !form.changeReason.trim()) return fail('Give a reason for correcting the check.');
  const confirmed = form.outcome === 'confirmed';

  const base = {
    guardId,
    kind,
    outcome: form.outcome,
    method: form.method,
    checkDate,
    checkedByName,
    evidenceReference,
    evidenceDocumentId,
    replacesCheckId: current?.id ?? null,
    changeType: current ? form.changeType : 'new_check',
    changeReason: current && form.changeType === 'correction' ? form.changeReason.trim() : null,
  } as const;

  if (kind === 'sia') {
    if (!SIA_METHODS.some((option) => option.value === form.method)) return fail('Choose how the SIA licence was checked.');
    const licenceNumber = form.licenceNumber.replace(/[\s-]/g, '');
    if (!/^\d{16}$/.test(licenceNumber)) return fail('Enter the 16-digit SIA licence number that was checked.');
    if (confirmed) {
      if (!expiryDate) return fail('Enter the SIA licence expiry date.');
      if (isoDayNumber(expiryDate) < isoDayNumber(checkDate)) return fail('The licence had already expired on the check date. Record the check as not confirmed.');
    }
    return { ok: true, payload: { ...base, licenceNumber, expiryDate: expiryDate ?? null, rightToWorkExcuse: null, workRestrictions: null } };
  }

  if (!RIGHT_TO_WORK_METHODS.some((option) => option.value === form.method)) return fail('Choose how the right to work was checked.');
  const workRestrictions = form.workRestrictions.trim() || null;
  if (!confirmed) {
    return { ok: true, payload: { ...base, rightToWorkExcuse: null, expiryDate: null, licenceNumber: null, workRestrictions } };
  }
  const excuse = form.excuse;
  if (!excusesForMethod(form.method).some((option) => option.value === excuse)) {
    return fail(form.method === 'employer_checking_service'
      ? 'An Employer Checking Service result is a Positive Verification Notice.'
      : 'Choose whether the right to work is continuous or time-limited.');
  }
  if (excuse === 'continuous') {
    if (expiryDate) return fail('A continuous right to work has no expiry date. Clear the expiry date.');
    return { ok: true, payload: { ...base, rightToWorkExcuse: excuse, expiryDate: null, licenceNumber: null, workRestrictions } };
  }
  if (!expiryDate) return fail(excuse === 'time_limited_pvn' ? 'Enter the date the Positive Verification Notice excuse ends.' : 'Enter the date the permission to work ends.');
  if (isoDayNumber(expiryDate) < isoDayNumber(checkDate)) return fail('The permission had already ended on the check date. Record the check as not confirmed.');
  if (excuse === 'time_limited_pvn' && isoDayNumber(expiryDate) > isoDayNumber(addMonthsIso(checkDate, PVN_MONTHS))) {
    return fail('A Positive Verification Notice gives an excuse for six months from its date, no longer.');
  }
  return { ok: true, payload: { ...base, rightToWorkExcuse: excuse, expiryDate, licenceNumber: null, workRestrictions } };
}

/** Whether the form should ask for an expiry date at all, and how to label it. */
export function expiryFieldFor(kind: ComplianceCheckKind, form: CheckForm): { show: boolean; label: string; required: boolean } {
  if (kind === 'sia') return { show: true, label: 'Licence expiry date', required: form.outcome === 'confirmed' };
  if (form.outcome !== 'confirmed' || form.excuse === 'continuous' || !form.excuse) return { show: false, label: '', required: false };
  return {
    show: true,
    label: form.excuse === 'time_limited_pvn' ? 'Excuse ends (six months from the notice at most)' : 'Permission to work ends',
    required: true,
  };
}

// ─── Presentation ────────────────────────────────────────────────────────────

/** One-line description of a current or historical check. */
export function describeCheck(kind: ComplianceCheckKind, check: Pick<CompanyCheckSummary, 'outcome' | 'method' | 'rightToWorkExcuse' | 'checkDate' | 'expiryDate'>): string {
  const parts = [outcomeLabel(kind, check.outcome), methodLabel(check.method), `checked ${formatUkDate(check.checkDate)}`];
  if (kind === 'right_to_work' && check.outcome === 'confirmed') parts.splice(1, 0, excuseLabel(check.rightToWorkExcuse));
  if (check.expiryDate) parts.push(`${kind === 'sia' ? 'expires' : 'until'} ${formatUkDate(check.expiryDate)}`);
  return parts.join(' · ');
}

export const REQUIREMENT_PRESENTATION: Record<string, { label: string; tone: Tone }> = {
  met: { label: 'Done', tone: 'success' },
  expiring: { label: 'Expiring soon', tone: 'warning' },
  missing: { label: 'Needed', tone: 'danger' },
  expired: { label: 'Expired', tone: 'danger' },
  not_confirmed: { label: 'Not confirmed', tone: 'danger' },
  unverified: { label: 'Not verified', tone: 'warning' },
};

export function requirementPresentation(requirement: Pick<ComplianceRequirement, 'state'>): { label: string; tone: Tone } {
  return REQUIREMENT_PRESENTATION[requirement.state] ?? { label: 'Unknown', tone: 'neutral' };
}

/** Requirements that still need action, in the order the server gave them. */
export function outstandingRequirements(requirements: ComplianceRequirement[] | null | undefined): ComplianceRequirement[] {
  return (requirements ?? []).filter((requirement) => requirement.state !== 'met');
}
