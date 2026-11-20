import type { GuardEmploymentRecord, GuardPayrollAdminSummary } from '../../../types/models';
import {
  ENGAGEMENT_TYPE_LABELS,
  PAY_BASIS_LABELS,
  PAY_FREQUENCY_LABELS,
  PAYROLL_STATUS_LABELS,
  WORKING_ARRANGEMENT_LABELS,
  jobRoleLabel,
  profileEnumLabel,
} from './profileLabels';
import { profileDate } from './profileOverview';

/**
 * S4 Guard Profile — compact company summaries for Employment & pay (UX-02 Package B).
 *
 * Before Package B each company's employment and pay arrangement was a column of label/value rows (up to eight per
 * company). The same facts are now one name line and one or two lines of facts separated by " · ", always visible (no
 * expansion). Every value is one the Guard could already see; nothing here touches bank details, NINO, UTR or a
 * licence number.
 *
 * Pure: executed by scripts/guard-home-ux01.spec.cjs.
 */

/** One summary line: an optional lead-in ("Pay:"), then the facts, shown joined by " · ". */
export interface SummaryLine {
  lead?: string;
  parts: string[];
}

const present = (parts: Array<string | null | undefined | false>): string[] => parts.filter((p): p is string => Boolean(p && p.trim()));

/** "Security officer · Employee · Part time · Hourly", then "Started 02/03/2026 · Notice 7 days". */
export function employmentSummaryLines(emp: GuardEmploymentRecord): SummaryLine[] {
  return [
    {
      parts: present([
        jobRoleLabel(emp.jobRole, emp.customRole),
        profileEnumLabel(ENGAGEMENT_TYPE_LABELS, emp.engagementType),
        profileEnumLabel(WORKING_ARRANGEMENT_LABELS, emp.workingArrangement),
        profileEnumLabel(PAY_BASIS_LABELS, emp.payBasis),
      ]),
    },
    {
      parts: present([
        `Started ${profileDate(emp.startDate)}`,
        emp.endDate ? `Ended ${profileDate(emp.endDate)}` : null,
        emp.noticePeriodDays !== null && emp.noticePeriodDays !== undefined ? `Notice ${emp.noticePeriodDays} day${emp.noticePeriodDays === 1 ? '' : 's'}` : null,
      ]),
    },
  ];
}

/** "Pay: Weekly · Active", then "Since 09/03/2026 · Until …" (when the company has recorded dates). */
export function payrollSummaryLines(rec: GuardPayrollAdminSummary): SummaryLine[] {
  return [
    { lead: 'Pay:', parts: present([profileEnumLabel(PAY_FREQUENCY_LABELS, rec.payFrequency), profileEnumLabel(PAYROLL_STATUS_LABELS, rec.payrollStatus)]) },
    {
      parts: present([
        rec.payrollStartDate ? `Since ${profileDate(rec.payrollStartDate)}` : null,
        rec.payrollEndDate ? `Until ${profileDate(rec.payrollEndDate)}` : null,
      ]),
    },
  ].filter((line) => line.parts.length > 0);
}

/** The words a screen reader hears for a summary line ("Pay: Weekly, Active"). */
export function summaryLineText(line: SummaryLine): string {
  return `${line.lead ? `${line.lead} ` : ''}${line.parts.join(', ')}`;
}
