/**
 * Vocabulary for company-recorded SIA and Right to Work checks (Migration 62).
 *
 * Stored as varchar and validated here, not as PostgreSQL enums, so a correction to the vocabulary is
 * an application change rather than a schema change.
 *
 * Right to Work terms follow the Home Office "Employer's guide to right to work checks" (1 October 2026):
 *  - the three prescribed checks: a manual document-based check, a Home Office online check (share code
 *    and date of birth), and a check using a registered RtW digital verification service provider;
 *  - the Employer Checking Service (ECS), whose Positive Verification Notice gives a time-limited
 *    statutory excuse of six months;
 *  - a continuous statutory excuse (List A, or an online check showing continuous permission), which
 *    needs no follow-up check, versus a time-limited excuse (List B Group 1, or an online check showing
 *    time-limited permission), which lasts until the permission expires and needs a follow-up check on
 *    or before that date.
 *
 * SIA methods follow GOV.UK "Check security staff have a licence to work" and "How to check SIA
 * licence cards". SIA licence numbers are 16 digits.
 *
 * S4 records what the company says it checked. It does not decide whether a document or online result
 * gives a statutory excuse: that judgement stays with the company carrying out the check.
 */

export const COMPLIANCE_CHECK_KINDS = ['sia', 'right_to_work'] as const;
export type ComplianceCheckKind = (typeof COMPLIANCE_CHECK_KINDS)[number];

/** Whether the check confirmed an active SIA licence / permission to do the work. */
export const COMPLIANCE_CHECK_OUTCOMES = ['confirmed', 'not_confirmed'] as const;
export type ComplianceCheckOutcome = (typeof COMPLIANCE_CHECK_OUTCOMES)[number];

export const SIA_CHECK_METHODS = [
  /** The SIA public register of licence holders. */
  'sia_public_register',
  /** The SIA Licence Status Checker business service. */
  'sia_licence_status_checker',
  /** The physical licence card, checked as described in "How to check SIA licence cards". */
  'sia_licence_card',
] as const;

export const RIGHT_TO_WORK_CHECK_METHODS = [
  'manual_document',
  'home_office_online',
  'rtw_dvsp',
  'employer_checking_service',
] as const;

export type ComplianceCheckMethod =
  | (typeof SIA_CHECK_METHODS)[number]
  | (typeof RIGHT_TO_WORK_CHECK_METHODS)[number];

export const RIGHT_TO_WORK_EXCUSES = [
  /** List A, or an online / DVSP check showing continuous permission. No expiry, no follow-up. */
  'continuous',
  /** List B Group 1, or an online check showing time-limited permission. Ends when permission expires. */
  'time_limited',
  /** A Positive Verification Notice from the ECS. Ends six months from the date of the notice. */
  'time_limited_pvn',
] as const;
export type RightToWorkExcuse = (typeof RIGHT_TO_WORK_EXCUSES)[number];

/** Which excuses each Right to Work method can produce. */
export const EXCUSES_BY_RIGHT_TO_WORK_METHOD: Record<(typeof RIGHT_TO_WORK_CHECK_METHODS)[number], readonly RightToWorkExcuse[]> = {
  manual_document: ['continuous', 'time_limited'],
  home_office_online: ['continuous', 'time_limited'],
  rtw_dvsp: ['continuous', 'time_limited'],
  employer_checking_service: ['time_limited_pvn'],
};

/** A PVN gives a statutory excuse for six months from the date of the notice. */
export const PVN_EXCUSE_MONTHS = 6;

export const CHECK_CHANGE_TYPES = [
  /** A new check was carried out, for example a follow-up check or a licence renewal. */
  'new_check',
  /** The current record was entered wrongly and is being corrected. A reason is required. */
  'correction',
] as const;
export type ComplianceCheckChangeType = (typeof CHECK_CHANGE_TYPES)[number];

export const SIA_LICENCE_NUMBER_PATTERN = /^\d{16}$/;
