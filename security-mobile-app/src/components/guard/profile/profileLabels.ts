import type {
  DrivingLicenceStatus,
  EmergencyContactRelationship,
  GuardEngagementType,
  GuardJobRole,
  GuardLeaveType,
  GuardPayBasis,
  GuardPayFrequency,
  GuardPayrollStatus,
  GuardWorkingArrangement,
  PrimaryTravelMethod,
} from '../../../types/models';

/**
 * S4 Guard Profile — human labels for the backend enums a Guard sees (Profile Phase 2B).
 *
 * The enum values are the API contract and are never changed here; this only decides how they read. Before these
 * maps the Profile showed values by replacing underscores ("FULL TIME", "SELF EMPLOYED CONTRACTOR", "HOURLY").
 * Each map is a complete Record over its union, so the type checker refuses a new enum value without a label, and
 * profileEnumLabel() falls back to a readable form for a value an older app has never heard of.
 */

export const JOB_ROLE_LABELS: Record<GuardJobRole, string> = {
  SECURITY_OFFICER: 'Security officer',
  DOOR_SUPERVISOR: 'Door supervisor',
  CCTV_OPERATOR: 'CCTV operator',
  SITE_SUPERVISOR: 'Site supervisor',
  CONTROL_ROOM_OPERATOR: 'Control room operator',
  MOBILE_PATROL_OFFICER: 'Mobile patrol officer',
  OTHER: 'Other',
};

export const ENGAGEMENT_TYPE_LABELS: Record<GuardEngagementType, string> = {
  EMPLOYEE: 'Employee',
  SELF_EMPLOYED_CONTRACTOR: 'Self-employed contractor',
  AGENCY_WORKER: 'Agency worker',
  SUBCONTRACTOR: 'Subcontractor',
  CASUAL_WORKER: 'Casual worker',
  OTHER: 'Other',
};

export const WORKING_ARRANGEMENT_LABELS: Record<GuardWorkingArrangement, string> = {
  FULL_TIME: 'Full time',
  PART_TIME: 'Part time',
  ZERO_HOURS: 'Zero hours',
  CASUAL: 'Casual',
  TEMPORARY: 'Temporary',
  FIXED_TERM: 'Fixed term',
  OTHER: 'Other',
};

export const PAY_BASIS_LABELS: Record<GuardPayBasis, string> = {
  HOURLY: 'Hourly',
  DAILY: 'Daily',
  SALARY: 'Salary',
  OTHER: 'Other',
};

export const PAY_FREQUENCY_LABELS: Record<GuardPayFrequency, string> = {
  WEEKLY: 'Weekly',
  FORTNIGHTLY: 'Fortnightly',
  FOUR_WEEKLY: 'Every four weeks',
  MONTHLY: 'Monthly',
  IRREGULAR: 'Irregular',
};

export const PAYROLL_STATUS_LABELS: Record<GuardPayrollStatus, string> = {
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  EXCLUDED: 'Not on payroll',
};

export const LICENCE_STATUS_LABELS: Record<DrivingLicenceStatus, string> = {
  NONE: 'No licence',
  PROVISIONAL: 'Provisional',
  FULL: 'Full',
  OTHER_OR_FOREIGN: 'Other or foreign',
};

export const TRAVEL_METHOD_LABELS: Record<PrimaryTravelMethod, string> = {
  CAR: 'Car',
  MOTORCYCLE: 'Motorcycle',
  PUBLIC_TRANSPORT: 'Public transport',
  BICYCLE: 'Bicycle',
  WALK: 'Walk',
  OTHER: 'Other',
};

export const RELATIONSHIP_LABELS: Record<EmergencyContactRelationship, string> = {
  SPOUSE_PARTNER: 'Spouse or partner',
  PARENT: 'Parent',
  SIBLING: 'Sibling',
  CHILD: 'Child',
  RELATIVE: 'Relative',
  FRIEND: 'Friend',
  OTHER: 'Other',
};

export const LEAVE_TYPE_LABELS: Record<GuardLeaveType, string> = {
  annual_leave: 'Annual leave',
  sick: 'Sickness',
  unavailable: 'Unavailable',
  training: 'Training',
  suspension: 'Suspension',
  other: 'Other',
};

/** Readable form of an enum value that no map knows: "SOME_NEW_VALUE" → "Some new value". */
export function humaniseEnumValue(value: string | null | undefined): string {
  if (!value) return '—';
  const words = String(value).trim().replace(/[_\s]+/g, ' ').toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '—';
}

/** The label for `value` from `labels`, or a readable fallback for an unknown value; '—' when there is none. */
export function profileEnumLabel<T extends string>(labels: Record<T, string>, value: T | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value as T] : humaniseEnumValue(value);
}

/** The employment role as the Guard should read it: a custom role for OTHER when the company gave one. */
export function jobRoleLabel(role: GuardJobRole | string, customRole?: string | null): string {
  if (role === 'OTHER' && customRole && customRole.trim()) return customRole.trim();
  return profileEnumLabel(JOB_ROLE_LABELS, role);
}
