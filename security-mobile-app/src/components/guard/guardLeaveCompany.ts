/**
 * Which company a guard's leave request goes to (SEC-001B 2B). Pure: no React Native, so the node specs run it.
 *
 * The backend decides the routing and enforces it; this module only decides what the leave form shows and sends.
 *
 *   single    one ACTIVE employer: no selector, no companyId; the backend selects that employer (unchanged behaviour)
 *   multiple  several ACTIVE employers: a selector; the guard must choose; companyId is sent
 *   none      no ACTIVE employer: explain, and do not submit
 *   legacy    the backend predates GET /leave/mine/companies (404): behave exactly as before, no companyId
 *   error     the list could not be loaded: offer a retry; a submission sends no companyId, so the backend still
 *             selects a sole employer and refuses (LEAVE_COMPANY_REQUIRED) rather than guessing between several
 *
 * The list from GET /leave/mine/companies holds ACTIVE employers only; INACTIVE and BLOCKED companies never appear,
 * and a company id that is not in the current list is never sent.
 */
import type { GuardLeavePayload } from '../../types/models';

export interface LeaveCompany {
  companyId: number;
  name: string;
}

export type LeaveCompanyState =
  | { kind: 'loading' }
  | { kind: 'single'; company: LeaveCompany }
  | { kind: 'multiple'; companies: LeaveCompany[] }
  | { kind: 'none' }
  | { kind: 'legacy' }
  | { kind: 'error' };

export const LEAVE_COMPANY_REQUIRED = 'LEAVE_COMPANY_REQUIRED';
export const LEAVE_NO_ACTIVE_EMPLOYER = 'LEAVE_NO_ACTIVE_EMPLOYER';

export const LEAVE_COPY = {
  selectorLabel: 'Company',
  selectorHint: 'You work for more than one company. Choose who this request is for.',
  chooseCompany: 'Choose the company this leave request is for.',
  noActiveEmployer:
    'Leave cannot be requested because you do not currently have an active company relationship.',
  loadError: 'Your companies could not be loaded.',
  retry: 'Retry',
  loading: 'Loading your companies',
} as const;

/** The form state for a successful GET /leave/mine/companies response. Malformed entries are dropped. */
export function leaveCompanyStateFromList(list: unknown): LeaveCompanyState {
  const seen = new Set<number>();
  const companies: LeaveCompany[] = [];
  for (const row of Array.isArray(list) ? list : []) {
    const companyId = Number((row as any)?.companyId);
    if (!Number.isInteger(companyId) || companyId < 1 || seen.has(companyId)) continue;
    seen.add(companyId);
    const name = typeof (row as any)?.name === 'string' && (row as any).name.trim() ? (row as any).name.trim() : `Company ${companyId}`;
    companies.push({ companyId, name });
  }
  if (companies.length === 0) return { kind: 'none' };
  if (companies.length === 1) return { kind: 'single', company: companies[0] };
  return { kind: 'multiple', companies };
}

/** The form state when the request failed: a 404 means a backend without the endpoint. */
export function leaveCompanyStateFromError(status: number | undefined): LeaveCompanyState {
  return status === 404 ? { kind: 'legacy' } : { kind: 'error' };
}

/** A selection that is still valid for this state, or null (a stale or foreign id is never kept). */
export function validSelection(state: LeaveCompanyState, selectedCompanyId: number | null): number | null {
  if (state.kind !== 'multiple' || selectedCompanyId === null) return null;
  return state.companies.some((c) => c.companyId === selectedCompanyId) ? selectedCompanyId : null;
}

/** Whether the selector is shown at all. */
export function showsCompanySelector(state: LeaveCompanyState): boolean {
  return state.kind === 'multiple';
}

/** Whether the "Request leave" button is usable. */
export function canSubmitLeave(state: LeaveCompanyState, selectedCompanyId: number | null): boolean {
  switch (state.kind) {
    case 'single':
    case 'legacy':
    case 'error':
      return true;
    case 'multiple':
      return validSelection(state, selectedCompanyId) !== null;
    default:
      return false;
  }
}

export type LeaveFormValues = { leaveType: string; startAt: string; endAt: string; reason: string };

/**
 * The payload for a NEW leave request, or the reason it cannot be sent. Never carries an id: the guard app creates
 * requests only, so an existing request (and its company) is never changed from here.
 */
export function buildNewLeavePayload(
  form: LeaveFormValues,
  state: LeaveCompanyState,
  selectedCompanyId: number | null,
): { ok: true; payload: GuardLeavePayload } | { ok: false; message: string } {
  const base: GuardLeavePayload = {
    leaveType: form.leaveType,
    startAt: form.startAt,
    endAt: form.endAt,
    reason: form.reason || null,
  };
  switch (state.kind) {
    case 'single':
    case 'legacy':
    case 'error':
      return { ok: true, payload: base };
    case 'multiple': {
      const companyId = validSelection(state, selectedCompanyId);
      if (companyId === null) return { ok: false, message: LEAVE_COPY.chooseCompany };
      return { ok: true, payload: { ...base, companyId } };
    }
    case 'none':
      return { ok: false, message: LEAVE_COPY.noActiveEmployer };
    default:
      return { ok: false, message: LEAVE_COPY.loading };
  }
}

/** The stable backend code on a refused leave request, if any. */
export function leaveErrorCode(body: unknown): string | null {
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
}

/** After a refusal with one of the routing codes, the company list is out of date and is reloaded. */
export function refusalNeedsCompanyReload(code: string | null): boolean {
  return code === LEAVE_COMPANY_REQUIRED || code === LEAVE_NO_ACTIVE_EMPLOYER;
}
