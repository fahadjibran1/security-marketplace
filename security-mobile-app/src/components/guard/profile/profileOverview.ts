import type {
  GuardBankDetailsSummary,
  GuardCompanyMembership,
  GuardComplianceSummary,
  GuardDrivingTransport,
  GuardEmergencyContact,
  GuardEmploymentRecord,
  GuardPersonnelIdentity,
  ScreeningStatus,
} from '../../../types/models';
import { REQUIREMENT_LABELS, type ProfileRequirement } from './profileCopy';
import { LICENCE_STATUS_LABELS, TRAVEL_METHOD_LABELS, profileEnumLabel } from './profileLabels';

/**
 * S4 Guard Profile — the overview model (Profile Phase 2B).
 *
 * Turns what the Guard app ALREADY loads into the compact Profile overview: a header, up to three "needs attention"
 * items and the seven section rows with one-line summaries. Nothing here is fetched, decided or invented:
 *
 *   - Deployment status comes only from the backend's `assignable` flag (GuardComplianceSummary). S4 screening never
 *     feeds it (ComplianceService.assertGuardAssignable does not consult screening).
 *   - S4 screening is always presented as optional, whatever its status.
 *   - Data that has not loaded is 'loading', data that failed is 'error'; neither is ever shown as "not provided".
 *
 * Pure: no React, no API, no clock (the caller passes `today`). Executed by
 * scripts/guard-profile-foundations.spec.cjs. GuardProfileOverview.tsx renders it (Phase 2C).
 */

/** A value that may still be loading or may have failed to load. */
export type Loadable<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T };

export function loading<T>(): Loadable<T> {
  return { status: 'loading' };
}
export function failed<T>(): Loadable<T> {
  return { status: 'error' };
}
export function ready<T>(value: T): Loadable<T> {
  return { status: 'ready', value };
}

export type ProfileSectionKey =
  | 'personal'
  | 'companies'
  | 'compliance'
  | 'availability'
  | 'employmentPay'
  | 'screening'
  | 'privacyAccount';

/** The seven sections, in overview order, with their requirement level and what each contains. */
export const PROFILE_SECTIONS: ReadonlyArray<{
  key: ProfileSectionKey;
  title: string;
  requirement: ProfileRequirement;
  contains: string;
}> = [
  { key: 'personal', title: 'Personal details', requirement: 'required', contains: 'Name, phone, emergency contact and live location sharing' },
  { key: 'companies', title: 'Companies & invitations', requirement: 'invitation', contains: 'The companies you work for and joining with an invitation code' },
  { key: 'compliance', title: 'SIA & compliance', requirement: 'company', contains: 'SIA licence, right to work and your deployment status' },
  { key: 'availability', title: 'Availability & travel', requirement: 'optional', contains: 'Leave, weekly availability, one-off changes, driving and travel' },
  { key: 'employmentPay', title: 'Employment & pay', requirement: 'company', contains: 'Employment and pay records from your company, bank details, NINO and UTR' },
  { key: 'screening', title: 'Optional S4 screening', requirement: 'optional', contains: 'Your optional S4 screening file' },
  { key: 'privacyAccount', title: 'Privacy & account', requirement: 'required', contains: 'Who can see your information, sign-in details, deleting your account and logging out' },
];

/**
 * Every Profile field's requirement level. "Required" is what the S4 account itself needs (save safety already
 * refuses a blank name and a blanked phone); "company" is what an employer may ask for (the backend has no per-company
 * requirement setting, so the app never claims a specific company requires it); S4 screening is always optional.
 */
export const PROFILE_FIELD_REQUIREMENTS = {
  fullName: 'required',
  phone: 'required',
  signInEmail: 'required',
  emergencyContact: 'company',
  emergencyContactAlternatePhone: 'optional',
  liveLocationSharing: 'optional',
  siaLicence: 'company',
  rightToWork: 'company',
  nino: 'company',
  utr: 'company',
  bankDetails: 'company',
  drivingLicence: 'optional',
  travelPreferences: 'optional',
  availability: 'optional',
  leave: 'optional',
  s4Screening: 'optional',
  employment: 'setByCompany',
  payAdministration: 'setByCompany',
} as const satisfies Record<string, ProfileRequirement>;

export type Tone = 'success' | 'warning' | 'danger' | 'neutral';

export interface ProfileOverviewInput {
  /** YYYY-MM-DD in the UK, from the caller (the model never reads a clock). */
  today: string;
  guard: Loadable<{ fullName?: string | null; phone?: string | null; siaLicenseNumber?: string | null; siaLicenceNumber?: string | null; siaExpiryDate?: string | null }>;
  compliance: Loadable<Pick<GuardComplianceSummary, 'assignable' | 'blockingReasons'> & { siaExpiryDate?: string | null }>;
  companies: Loadable<GuardCompanyMembership[]>;
  emergencyContact: Loadable<GuardEmergencyContact | null>;
  identity: Loadable<Pick<GuardPersonnelIdentity, 'ninoSet' | 'utrSet'>>;
  bank: Loadable<Pick<GuardBankDetailsSummary, 'bankSet'>>;
  employments: Loadable<Pick<GuardEmploymentRecord, 'companyName'>[]>;
  driving: Loadable<Pick<GuardDrivingTransport, 'licenceStatus' | 'primaryTravelMethod'>>;
  screening: Loadable<{ status?: ScreeningStatus | null; progress?: number | null } | null>;
  email?: string | null;
}

export interface ProfileAttentionItem {
  key: 'sia-expired' | 'sia-expiring' | 'deployment-blocked' | 'no-emergency-contact' | 'no-company';
  section: ProfileSectionKey;
  tone: Tone;
  text: string;
}

export interface ProfileSectionSummary {
  key: ProfileSectionKey;
  title: string;
  requirement: ProfileRequirement;
  requirementLabel: string;
  summary: string;
  tone: Tone;
}

export interface ProfileOverview {
  header: {
    name: string;
    initials: string;
    phone: string | null;
    sia: { label: string; tone: Tone };
    deployment: { label: string; tone: Tone };
  };
  attention: ProfileAttentionItem[];
  sections: ProfileSectionSummary[];
}

/** Days within which an SIA expiry is flagged. */
export const SIA_EXPIRY_WARNING_DAYS = 30;
const MAX_ATTENTION = 3;
const LOADING_TEXT = 'Loading…';
const ERROR_TEXT = 'Could not load';

/** Whole days from `today` to `date` (both YYYY-MM-DD or ISO), or null when either is not a date. */
export function daysUntil(today: string, date: string | null | undefined): number | null {
  if (!date) return null;
  const a = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** DD/MM/YYYY for a YYYY-MM-DD or ISO date, as the rest of the Guard app shows dates. */
export function ukDate(date: string): string {
  const [y, m, d] = String(date).slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : String(date);
}

export function initialsOf(name: string | null | undefined): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
  return `${first}${last}`.toUpperCase();
}

function siaStatus(input: ProfileOverviewInput): { label: string; tone: Tone; days: number | null } {
  const g = input.guard.status === 'ready' ? input.guard.value : null;
  const c = input.compliance.status === 'ready' ? input.compliance.value : null;
  if (!g && input.guard.status === 'loading') return { label: LOADING_TEXT, tone: 'neutral', days: null };
  const number = g?.siaLicenseNumber || g?.siaLicenceNumber || null;
  const expiry = c?.siaExpiryDate ?? g?.siaExpiryDate ?? null;
  if (!number) return { label: 'SIA licence not added', tone: 'warning', days: null };
  const days = daysUntil(input.today, expiry);
  if (days === null) return { label: 'SIA licence added', tone: 'neutral', days: null };
  if (days < 0) return { label: `SIA expired ${ukDate(String(expiry))}`, tone: 'danger', days };
  if (days <= SIA_EXPIRY_WARNING_DAYS) return { label: `SIA expires ${ukDate(String(expiry))}`, tone: 'warning', days };
  return { label: `SIA valid to ${ukDate(String(expiry))}`, tone: 'success', days };
}

function deploymentStatus(input: ProfileOverviewInput): { label: string; tone: Tone } {
  if (input.compliance.status === 'loading') return { label: LOADING_TEXT, tone: 'neutral' };
  if (input.compliance.status === 'error') return { label: 'Deployment status could not load', tone: 'neutral' };
  return input.compliance.value.assignable
    ? { label: 'Eligible for deployment', tone: 'success' }
    : { label: 'Not eligible for deployment', tone: 'warning' };
}

function summaryOf<T>(value: Loadable<T>, describe: (v: T) => { summary: string; tone: Tone }): { summary: string; tone: Tone } {
  if (value.status === 'loading') return { summary: LOADING_TEXT, tone: 'neutral' };
  if (value.status === 'error') return { summary: ERROR_TEXT, tone: 'neutral' };
  return describe(value.value);
}

const SCREENING_STATUS_TEXT: Record<ScreeningStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  READY_FOR_REVIEW: 'Ready for review',
  UNDER_REVIEW: 'Under review',
  VETTED: 'Complete',
  REQUIRES_ATTENTION: 'Needs your attention',
  REJECTED: 'Not approved',
  EXPIRED: 'Expired',
};

export function buildProfileOverview(input: ProfileOverviewInput): ProfileOverview {
  const g = input.guard.status === 'ready' ? input.guard.value : null;
  const name = (g?.fullName ?? '').trim() || (input.guard.status === 'loading' ? LOADING_TEXT : 'Your profile');
  const sia = siaStatus(input);
  const deployment = deploymentStatus(input);

  // ── Needs attention: facts only, most serious first, at most three. ──
  const attention: ProfileAttentionItem[] = [];
  if (sia.tone === 'danger') attention.push({ key: 'sia-expired', section: 'compliance', tone: 'danger', text: sia.label });
  else if (sia.tone === 'warning' && sia.days !== null) attention.push({ key: 'sia-expiring', section: 'compliance', tone: 'warning', text: sia.label });
  if (input.compliance.status === 'ready' && !input.compliance.value.assignable) {
    const reasons = input.compliance.value.blockingReasons?.length ?? 0;
    attention.push({
      key: 'deployment-blocked',
      section: 'compliance',
      tone: 'warning',
      text: reasons ? `${reasons} compliance item${reasons === 1 ? '' : 's'} to review` : 'Not eligible for deployment',
    });
  }
  if (input.companies.status === 'ready' && input.companies.value.length === 0) {
    attention.push({ key: 'no-company', section: 'companies', tone: 'neutral', text: 'Join a company with an invitation code' });
  }
  if (input.emergencyContact.status === 'ready' && !input.emergencyContact.value) {
    attention.push({ key: 'no-emergency-contact', section: 'personal', tone: 'neutral', text: 'No emergency contact added' });
  }
  const order: Record<Tone, number> = { danger: 0, warning: 1, neutral: 2, success: 3 };
  attention.sort((a, b) => order[a.tone] - order[b.tone]);

  // ── Section summaries ──
  const summaries: Record<ProfileSectionKey, { summary: string; tone: Tone }> = {
    personal: summaryOf(input.emergencyContact, (contact) =>
      contact ? { summary: 'Emergency contact added', tone: 'success' } : { summary: 'No emergency contact', tone: 'neutral' }),
    companies: summaryOf(input.companies, (list) =>
      list.length === 0
        ? { summary: 'Join with an invitation code', tone: 'neutral' }
        : { summary: list.length === 1 ? list[0].companyName : `${list.length} companies`, tone: 'success' }),
    compliance: input.compliance.status === 'ready' || input.guard.status === 'ready'
      ? { summary: [deployment.label, sia.label].filter((s) => s !== LOADING_TEXT).join(' · ') || LOADING_TEXT, tone: sia.tone === 'danger' ? 'danger' : deployment.tone }
      : summaryOf(input.compliance, () => ({ summary: deployment.label, tone: deployment.tone })),
    availability: summaryOf(input.driving, (d) => {
      const travel = d.primaryTravelMethod ? profileEnumLabel(TRAVEL_METHOD_LABELS, d.primaryTravelMethod) : null;
      const licence = d.licenceStatus && d.licenceStatus !== 'NONE' ? `${profileEnumLabel(LICENCE_STATUS_LABELS, d.licenceStatus)} licence` : null;
      const parts = [travel, licence].filter(Boolean);
      return parts.length ? { summary: parts.join(' · '), tone: 'neutral' } : { summary: 'Leave, availability and travel', tone: 'neutral' };
    }),
    employmentPay: (() => {
      if (input.bank.status !== 'ready' || input.identity.status !== 'ready') {
        const pending = [input.bank, input.identity].find((v) => v.status !== 'ready')!;
        return pending.status === 'loading' ? { summary: LOADING_TEXT, tone: 'neutral' as Tone } : { summary: ERROR_TEXT, tone: 'neutral' as Tone };
      }
      const parts = [
        input.bank.value.bankSet ? 'Bank details added' : 'No bank details',
        input.identity.value.ninoSet ? 'NINO added' : 'No NINO',
      ];
      return { summary: parts.join(' · '), tone: 'neutral' as Tone };
    })(),
    screening: summaryOf(input.screening, (s) => {
      const status = (s?.status ?? 'NOT_STARTED') as ScreeningStatus;
      const text = SCREENING_STATUS_TEXT[status] ?? 'Not started';
      const progress = status === 'IN_PROGRESS' && typeof s?.progress === 'number' ? ` ${Math.max(0, Math.min(100, Math.round(s.progress)))}%` : '';
      return { summary: `Optional · ${text}${progress}`, tone: status === 'VETTED' ? 'success' : 'neutral' };
    }),
    privacyAccount: { summary: input.email ? `Signed in as ${input.email}` : 'Who can see your information', tone: 'neutral' },
  };

  return {
    header: {
      name,
      initials: initialsOf(g?.fullName),
      phone: (g?.phone ?? '').trim() || null,
      sia: { label: sia.label, tone: sia.tone },
      deployment,
    },
    attention: attention.slice(0, MAX_ATTENTION),
    sections: PROFILE_SECTIONS.map((section) => ({
      key: section.key,
      title: section.title,
      requirement: section.requirement,
      requirementLabel: REQUIREMENT_LABELS[section.requirement].label,
      summary: summaries[section.key].summary,
      tone: summaries[section.key].tone,
    })),
  };
}

// ═══════════════════ Phase 2C: from the Guard dashboard's existing state ═══════════════════

/** One record the dashboard already loads, as it holds it: the value, its loading flag and its error. */
export interface DashboardRecord<T> {
  value: T;
  loading: boolean;
  error: string | null;
}

/**
 * The dashboard's own state, unchanged, as the overview needs it. The personnel records (tax, driving, emergency
 * contact, employment, bank) are requested only after the Guard's record has loaded, so until then they are still
 * loading — or, when that first read failed, unavailable — never "not provided".
 */
export interface DashboardProfileState {
  /** The last record loaded from the server (not unsaved edits); null until one has loaded. */
  profile: { fullName: string; phone: string } | null;
  profileLoading: boolean;
  siaLicenceNumber: string;
  companies: { value: GuardCompanyMembership[]; status: 'loading' | 'ready' | 'error' };
  emergencyContact: DashboardRecord<GuardEmergencyContact | null>;
  identity: DashboardRecord<GuardPersonnelIdentity | null>;
  bank: DashboardRecord<GuardBankDetailsSummary | null>;
  employments: DashboardRecord<GuardEmploymentRecord[]>;
  driving: DashboardRecord<GuardDrivingTransport | null>;
  email?: string | null;
}

export type ProfileOverviewSource = Omit<ProfileOverviewInput, 'today' | 'compliance' | 'screening'>;

export function overviewSourceFromDashboard(state: DashboardProfileState): ProfileOverviewSource {
  function personnel<T, R>(record: DashboardRecord<T>, map: (value: T) => R): Loadable<R> {
    if (!state.profile) return state.profileLoading ? loading() : failed();
    if (record.loading) return loading();
    if (record.error) return failed();
    return ready(map(record.value));
  }
  return {
    guard: state.profile
      ? ready({ fullName: state.profile.fullName, phone: state.profile.phone, siaLicenseNumber: state.siaLicenceNumber || null })
      : state.profileLoading ? loading() : failed(),
    companies: state.companies.status === 'ready' ? ready(state.companies.value) : state.companies.status === 'loading' ? loading() : failed(),
    emergencyContact: personnel(state.emergencyContact, (v) => v ?? null),
    identity: personnel(state.identity, (v) => ({ ninoSet: Boolean(v?.ninoSet), utrSet: Boolean(v?.utrSet) })),
    bank: personnel(state.bank, (v) => ({ bankSet: Boolean(v?.bankSet) })),
    employments: personnel(state.employments, (v) => v ?? []),
    driving: personnel(state.driving, (v) => ({ licenceStatus: v?.licenceStatus ?? null, primaryTravelMethod: v?.primaryTravelMethod ?? null }) as Pick<GuardDrivingTransport, 'licenceStatus' | 'primaryTravelMethod'>),
    email: state.email ?? null,
  };
}

/** The device's calendar date as YYYY-MM-DD (the Guard app is used in the UK; the model itself never reads a clock). */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
