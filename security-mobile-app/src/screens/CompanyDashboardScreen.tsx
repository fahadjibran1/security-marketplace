import * as React from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';

import { CompanyAuditWorkspace } from '../components/company/CompanyAuditWorkspace';
import { CompanyClientsWorkspace, type ClientFormState, CLIENT_FORM_EMPTY } from '../components/company/CompanyClientsWorkspace';
import { CompanyRotaPlannerWorkspace, type PlannerWeekDay, type FlatSlotCell, type LegacyShiftRow } from '../components/company/CompanyRotaPlannerWorkspace';
import { CompanySitesWorkspace, type SiteFormState, SITE_FORM_EMPTY } from '../components/company/CompanySitesWorkspace';
import { CompanyLiveOperationsWorkspace } from '../components/company/CompanyLiveOperationsWorkspace';
import type { LiveBoardRow, CloseOutSummary, SelectedShiftContext } from '../components/company/CompanyLiveOperationsWorkspace';
import { CompanyAnalyticsWorkspace } from '../components/company/CompanyAnalyticsWorkspace';
import { CompanyAvailabilityWorkspace } from '../components/company/CompanyAvailabilityWorkspace';
import { CompanyComplianceWorkspace } from '../components/company/CompanyComplianceWorkspace';
import { CompanyContractPricingWorkspace } from '../components/company/CompanyContractPricingWorkspace';
import { CompanyCoverageWorkspace, CoverageNavigationContext } from '../components/company/CompanyCoverageWorkspace';
import { CompanyFinanceWorkspace } from '../components/company/CompanyFinanceWorkspace';
import { CompanyFinanceControlWorkspace } from '../components/company/CompanyFinanceControlWorkspace';
import { CompanyInvoiceWorkspace } from '../components/company/CompanyInvoiceWorkspace';
import { CompanyMarginWorkspace } from '../components/company/CompanyMarginWorkspace';
import { CompanyPayRulesSettings } from '../components/company/CompanyPayRulesSettings';
import { CompanyPayrollBatchesWorkspace } from '../components/company/CompanyPayrollBatchesWorkspace';
import { CompanyPayrollWorkspace } from '../components/company/CompanyPayrollWorkspace';
import { CompanyTimesheetsWorkspace } from '../components/company/CompanyTimesheetsWorkspace';
import {
  ApiError,
  acknowledgeSafetyAlert,
  approveGuard,
  closeSafetyAlert,
  createClient,
  createJob,
  createShift,
  createSite,
  deleteShift,
  formatApiErrorMessage,
  listCompanyAttendance,
  listClients,
  listCompanyDailyLogs,
  listCompanyGuards,
  getCompanyGuardPayrollAdmin,
  createCompanyGuardPayrollAdmin,
  updateCompanyGuardPayrollAdmin,
  getCompanyGuardEmployment,
  listCompanyIncidents,
  listCompanyNotifications,
  listCompanySafetyAlerts,
  listCompanyTimesheets,
  listComplianceRecords,
  listCoverageShifts,
  listGuards,
  listJobApplications,
  listJobs,
  listShifts,
  listSites,
  getRotaWeek,
  getRotaSlot,
  createRotaSlot,
  updateRotaSlotMetadata,
  changeRotaSlotRequirement,
  changeRotaSlotTime,
  changeRotaSlotCheckCall,
  assignRotaSlotPosition,
  assignMultipleRotaSlotPositions,
  cancelRotaSlotPosition,
  cancelRotaSlot,
  listEligibleGuardsForShift,
  reviewJobApplication,
  updateIncidentStatus,
  updateClient,
  updateShift,
  updateSite,
} from '../services/api';
import {
  AttendanceEvent,
  AuthUser,
  Client,
  ComplianceRecord,
  CompanyGuard,
  CoverageShiftRow,
  CreateClientPayload,
  CreateJobPayload,
  CreateShiftPayload,
  CreateSitePayload,
  DailyLog,
  GuardProfile,
  Incident,
  Job,
  JobApplication,
  Notification,
  SafetyAlert,
  Shift,
  Site,
  Timesheet,
  UpdateClientPayload,
  UpdateShiftPayload,
  UpdateSitePayload,
  CompanyGuardPayrollRecord,
  UpsertPayrollAdminPayload,
  GuardEngagementType,
  CompanyGuardEmploymentSummary,
  EligibleGuardRow,
  RotaWeekResponse,
  RotaSlotDetail,
  RotaCreatePayload,
  RotaSlotChanges,
  RotaAssignMultipleResult,
} from '../types/models';
import { CompanySidebar } from '../components/company/CompanySidebar';
import { CompanyTopBar } from '../components/company/CompanyTopBar';
import { CompanyWeeklyApprovalsScreen } from './CompanyWeeklyApprovalsScreen';
import { Card } from '../components/ui/Card';
import { KpiCard, KpiTone } from '../components/ui/KpiCard';
import { PageHeader } from '../components/ui/PageHeader';
import { brand, colors, radii, spacing } from '../theme';

const IS_WEB = typeof document !== 'undefined';

const WEB_POINTER_STYLE = IS_WEB ? ({ cursor: 'pointer' } as const) : null;

// Legacy planner row type (raw-Shift era — kept for handleSaveRota compatibility only)
type PlannerRow = {
  localId: string;
  date: string;
  startTime: string;
  endTime: string;
  guardsRequired: string;
  assignedGuardId: string;
  status: string;
  instructions: string;
  sourceShiftIds: number[];
};

const ROTA_DAY_NAMES = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
] as const;

type CompanySection =
  | 'dashboard'
  | 'clients'
  | 'sites'
  | 'rota-planner'
  | 'shift-offers'
  | 'live-operations'
  | 'analytics'
  | 'coverage'
  | 'guards'
  | 'availability'
  | 'recruitment'
  | 'timesheets'
  | 'payroll'
  | 'payroll-batches'
  | 'invoices'
  | 'finance'
  | 'finance-control'
  | 'margins'
  | 'compliance'
  | 'contract-pricing'
  | 'pay-rules'
  | 'audit'
  | 'incidents'
  | 'alerts'
  | 'weekly-approvals';

type JobFormState = {
  title: string;
  description: string;
  guardsRequired: string;
  hourlyRate: string;
  billingRate: string;
  siteId: string;
};

type LiveFilters = {
  clientId: string;
  siteId: string;
  guardId: string;
  date: string;
  status: string;
};

type NavItem = {
  id: CompanySection;
  label: string;
  caption: string;
};

type SettledLoader = {
  label: string;
  run: () => Promise<any>;
  apply: (value: any) => void;
};

type OperationalActivityItem = {
  id: string;
  shiftId?: number | null;
  siteName: string;
  guardName: string;
  eventType: string;
  message: string;
  occurredAt: string;
};

type UrgentOperationalItem = {
  id: string;
  shiftId?: number | null;
  incidentId?: number | null;
  alertId?: number | null;
  status?: string | null;
  siteName: string;
  guardName: string;
  category:
    | 'panic'
    | 'incident'
    | 'late_start'
    | 'missed_check_call'
    | 'rejected_offer'
    | 'safety'
    | 'upcoming_risk'
    | 'missed_shift'
    | 'uncovered_shift';
  issueType: string;
  message: string;
  occurredAt: string;
};

type ManagementActionItem = {
  id: string;
  shiftId?: number | null;
  siteName: string;
  guardName: string;
  itemType: string;
  actionTaken: string;
  occurredAt: string;
};

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', caption: 'Your live operational position and items requiring attention.' },
  { id: 'clients', label: 'Clients', caption: 'Manage client relationships, contacts and operational sites.' },
  { id: 'sites', label: 'Sites', caption: 'Site setup, instructions, and coverage.' },
  { id: 'rota-planner', label: 'Rota Planner', caption: 'Plan weekly cover and assignments.' },
  { id: 'shift-offers', label: 'Shift Offers', caption: 'Track pending responses and re-cover needs.' },
  { id: 'live-operations', label: 'Live Operations', caption: 'Monitor book-ons, logs, and incidents.' },
  { id: 'analytics', label: 'Analytics', caption: 'Incident, welfare, and site-risk reporting.' },
  { id: 'coverage', label: 'Coverage', caption: 'Coverage gaps and eligible guards.' },
  { id: 'guards', label: 'Guards', caption: 'Available platform guards and linked team.' },
  { id: 'availability', label: 'Availability', caption: 'Guard availability, overrides, and leave.' },
  { id: 'recruitment', label: 'Recruitment', caption: 'Open jobs and incoming applications.' },
  { id: 'timesheets', label: 'Timesheets', caption: 'Review worked hours and approvals.' },
  { id: 'weekly-approvals', label: 'Client Timesheets', caption: 'Submit and track weekly approval requests for clients.' },
  { id: 'payroll', label: 'Payroll', caption: 'Approved hours and payment totals.' },
  { id: 'payroll-batches', label: 'Payroll Batches', caption: 'Draft, finalised, and paid payroll runs.' },
  { id: 'invoices', label: 'Invoices', caption: 'Client billing and invoice batches.' },
  { id: 'finance', label: 'Finance', caption: 'Revenue, cost, receivables, and payment tracking.' },
  { id: 'finance-control', label: 'Finance Control', caption: 'Commercial exposure and settlement visibility.' },
  { id: 'margins', label: 'Margins', caption: 'Revenue, cost, and profit reporting.' },
  { id: 'compliance', label: 'Compliance', caption: 'Licence expiry and right-to-work controls.' },
  { id: 'contract-pricing', label: 'Contract Pricing', caption: 'Client and site commercial rules.' },
  { id: 'pay-rules', label: 'Pay Rules', caption: 'Guard payable-hours calculation settings.' },
  { id: 'audit', label: 'Audit Trail', caption: 'Trace financial actions and before/after data.' },
  { id: 'incidents', label: 'Incidents', caption: 'Track reported site issues.' },
  { id: 'alerts', label: 'Safety Alerts', caption: 'Watch welfare and check-call alerts.' },
];

const COMPANY_NAV_GROUPS: Array<{ id: string; title: string; itemIds: CompanySection[] }> = [
  {
    id: 'primary',
    title: 'Primary',
    itemIds: ['dashboard', 'live-operations'],
  },
  {
    id: 'operations',
    title: 'Operations',
    itemIds: ['sites', 'clients', 'rota-planner', 'shift-offers', 'guards'],
  },
  {
    id: 'workforce',
    title: 'Workforce',
    itemIds: ['compliance', 'availability', 'timesheets', 'weekly-approvals'],
  },
  {
    id: 'commercial',
    title: 'Commercial',
    itemIds: ['payroll', 'payroll-batches', 'invoices', 'finance', 'finance-control', 'margins', 'contract-pricing', 'pay-rules'],
  },
  {
    id: 'management',
    title: 'Management',
    itemIds: ['coverage', 'analytics', 'incidents', 'alerts', 'audit', 'recruitment'],
  },
];

const JOB_FORM_EMPTY: JobFormState = {
  title: '',
  description: '',
  guardsRequired: '1',
  hourlyRate: '12',
  billingRate: '',
  siteId: '',
};

const SHIFT_STATUS_OPTIONS = [
  { label: 'Unfilled', value: 'unfilled' },
  { label: 'Offered', value: 'offered' },
  { label: 'Ready', value: 'ready' },
  { label: 'Missed', value: 'missed' },
  { label: 'Cancelled', value: 'cancelled' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
];

const UK_LOCALE = 'en-GB';
const MISSED_CHECK_IN_GRACE_MINUTES = 15;

function toNumber(value?: string | number | null) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDateTimeLabel(value?: string | null) {
  if (!value) {
    return 'Not recorded';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(UK_LOCALE, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
}

function getLiteralDateTimeParts(value?: string | null) {
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) {
    return null;
  }

  return {
    year: match[1],
    month: match[2],
    day: match[3],
    hour: match[4] || null,
    minute: match[5] || null,
  };
}

function formatDateLabel(value?: string | null) {
  if (!value) {
    return 'Not set';
  }

  const literalParts = getLiteralDateTimeParts(value);
  if (literalParts) {
    return `${literalParts.day}/${literalParts.month}/${literalParts.year}`;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(UK_LOCALE, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
}

function formatTimeLabel(value?: string | null) {
  if (!value) {
    return 'Not set';
  }

  if (/^\d{2}:\d{2}$/.test(value)) {
    return value;
  }

  const literalParts = getLiteralDateTimeParts(value);
  if (literalParts?.hour && literalParts?.minute) {
    return `${literalParts.hour}:${literalParts.minute}`;
  }

  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  return value;
}

function formatStatusLabel(value?: string | null) {
  if (!value) {
    return 'Unknown';
  }

  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeShiftLifecycleStatus(value?: string | null) {
  const normalized = (value || '').trim().toLowerCase();

  switch (normalized) {
    case 'planned':
    case 'unassigned':
    case 'scheduled':
      return 'unfilled';
    case 'assigned':
      return 'offered';
    case 'accepted':
      return 'ready';
    default:
      return normalized || 'unfilled';
  }
}

function getShiftStatusBadge(status: string) {
  switch (normalizeShiftLifecycleStatus(status)) {
    case 'missed':
      return { label: 'Missed', color: colors.warning, icon: '⚠️' };
    case 'offered':
      return { label: 'Offered', color: colors.info, icon: '🔵' };
    case 'ready':
      return { label: 'Ready', color: colors.warning, icon: '🟡' };
    case 'in_progress':
      return { label: 'Live', color: colors.success, icon: '🟢' };
    case 'completed':
      return { label: 'Completed', color: colors.primaryNavySoft, icon: '⚫' };
    case 'rejected':
      return { label: 'Rejected', color: colors.danger, icon: '🔴' };
    case 'cancelled':
      return { label: 'Cancelled', color: colors.neutralSlate, icon: '⚫' };
    case 'unfilled':
    default:
      return { label: 'Unfilled', color: colors.textSecondary, icon: '⚪' };
  }
}

function getLiveShiftRowTone(status: string) {
  switch (normalizeShiftLifecycleStatus(status)) {
    case 'in_progress':
      return colors.successSurface;
    case 'ready':
      return colors.warningSurface;
    case 'missed':
      return colors.warningSurface;
    case 'rejected':
      return colors.dangerSurface;
    default:
      return colors.card;
  }
}

function getShiftExceptionSummary(status?: string | null) {
  switch (normalizeShiftLifecycleStatus(status || 'unfilled')) {
    case 'missed':
      return {
        title: 'Missed check-in exception',
        message: `No attendance check-in was recorded within ${MISSED_CHECK_IN_GRACE_MINUTES} minutes of shift start.`,
        outcome: 'Needs re-cover now and may need attendance follow-up.',
      };
    case 'rejected':
      return {
        title: 'Offer rejected',
        message: 'The assigned guard rejected this shift before it became live.',
        outcome: 'Needs fresh cover, but not attendance escalation.',
      };
    case 'cancelled':
      return {
        title: 'Shift cancelled',
        message: 'This shift was cancelled by the company.',
        outcome: 'No re-cover action is needed unless the work is replanned.',
      };
    default:
      return null;
  }
}

function getUrgentPrimaryActionLabel(item: UrgentOperationalItem) {
  switch (item.category) {
    case 'rejected_offer':
    case 'missed_shift':
      return 'Open Re-cover';
    case 'incident':
      return 'View Incident';
    case 'panic':
      return item.status === 'acknowledged' ? 'Resolve Alert' : 'View Alert';
    case 'missed_check_call':
      return item.status === 'acknowledged' ? 'Close Follow-up' : 'View Safety Detail';
    case 'safety':
      return item.status === 'acknowledged' ? 'Close Alert' : 'View Safety Detail';
    case 'late_start':
    case 'upcoming_risk':
    default:
      return 'Open Shift';
  }
}

function getUrgentNextActionText(item: UrgentOperationalItem) {
  switch (item.category) {
    case 'uncovered_shift':
      return 'Next action: manage coverage and find a confirmed guard.';
    case 'missed_shift':
      return 'Next action: arrange replacement cover.';
    case 'rejected_offer':
      return 'Next action: re-offer the shift.';
    case 'incident':
      return (item.status || '').toLowerCase() === 'open'
        ? 'Next action: acknowledge or review the incident.'
        : 'Next action: resolve or review the incident.';
    case 'panic':
      return item.status === 'acknowledged'
        ? 'Next action: close once the escalation is resolved.'
        : 'Next action: open the alert or escalate immediately.';
    case 'missed_check_call':
      return item.status === 'acknowledged'
        ? 'Next action: close once follow-up is complete.'
        : 'Next action: review and mark followed up.';
    case 'safety':
      return item.status === 'acknowledged'
        ? 'Next action: close once the issue is resolved.'
        : 'Next action: review and acknowledge.';
    case 'late_start':
      return 'Next action: open the shift and confirm attendance.';
    case 'upcoming_risk':
      return 'Next action: open the shift and contact the guard if needed.';
    default:
      return 'Next action: review this item.';
  }
}

function shouldShowOperationalActivityMessage(eventType: string) {
  return ![
    'Shift offered',
    'Shift accepted',
    'Shift missed',
    'Shift rejected',
    'Guard checked in',
    'Guard checked out',
    'Timesheet submitted',
  ].includes(eventType);
}

function getShiftRisk(
  shift: Shift,
  attendance?: { checkInAt: string | null; checkOutAt: string | null } | null,
  incidents: Incident[] = [],
  alerts: SafetyAlert[] = [],
) {
  let score = 0;
  const lifecycleStatus = normalizeShiftLifecycleStatus(shift.status);
  const now = new Date();
  const shiftStart = new Date(shift.start);
  const hasStarted = !Number.isNaN(shiftStart.getTime()) && now.getTime() > shiftStart.getTime();

  if (
    alerts.some(
      (alert) =>
        (alert.type || '').toLowerCase() === 'panic' &&
        !['closed', 'resolved'].includes((alert.status || '').toLowerCase()),
    )
  ) {
    score += 100;
  }

  if (incidents.some((incident) => ['open', 'in_review'].includes((incident.status || '').toLowerCase()))) {
    score += 50;
  }

  if (lifecycleStatus === 'ready' && hasStarted && !attendance?.checkInAt) {
    score += 40;
  }

  if (isLikelyToMissCheckIn(shift, attendance)) {
    score += 35;
  }

  if (
    alerts.some(
      (alert) =>
        (alert.type || '').toLowerCase() === 'missed_checkcall' &&
        !['closed', 'resolved'].includes((alert.status || '').toLowerCase()),
    )
  ) {
    score += 30;
  }

  if (lifecycleStatus === 'rejected') {
    score += 25;
  }

  if (lifecycleStatus === 'missed') {
    score += 45;
  }

  if (score >= 80) {
    return { level: 'high' as const, color: colors.danger, label: 'HIGH 🔴' };
  }

  if (score >= 40) {
    return { level: 'medium' as const, color: colors.warning, label: 'MEDIUM 🟡' };
  }

  return { level: 'low' as const, color: colors.success, label: 'LOW 🟢' };
}

function getAttentionSeverity(category: UrgentOperationalItem['category']): 'red' | 'amber' | 'blue' {
  switch (category) {
    case 'panic':
    case 'incident':
    case 'missed_shift':
      return 'red';
    case 'late_start':
    case 'missed_check_call':
    case 'uncovered_shift':
    case 'rejected_offer':
    case 'safety':
      return 'amber';
    default:
      return 'blue';
  }
}

function getAttentionBadgeLabel(category: UrgentOperationalItem['category']): string {
  switch (category) {
    case 'panic':             return 'Critical';
    case 'incident':          return 'Incident';
    case 'missed_shift':      return 'Missed shift';
    case 'late_start':        return 'Late start';
    case 'uncovered_shift':   return 'Coverage gap';
    case 'missed_check_call': return 'Missed check';
    case 'rejected_offer':    return 'Offer rejected';
    case 'safety':            return 'Safety';
    case 'upcoming_risk':     return 'Upcoming risk';
    default:                  return String(category).replace(/_/g, ' ');
  }
}

function getShiftDelay(
  shift: Shift,
  attendance?: { checkInAt: string | null; checkOutAt: string | null } | null,
) {
  if (normalizeShiftLifecycleStatus(shift.status) !== 'ready') {
    return null;
  }

  const shiftStart = new Date(shift.start);
  const now = new Date();

  if (Number.isNaN(shiftStart.getTime()) || now.getTime() <= shiftStart.getTime() || attendance?.checkInAt) {
    return null;
  }

  return Math.max(1, Math.floor((now.getTime() - shiftStart.getTime()) / 60000));
}

function isShiftPastMissedGracePeriod(
  shift: Shift,
  attendance?: { checkInAt: string | null; checkOutAt: string | null } | null,
) {
  if (normalizeShiftLifecycleStatus(shift.status) !== 'ready' || attendance?.checkInAt) {
    return false;
  }

  const shiftStart = new Date(shift.start);
  const now = new Date();

  if (Number.isNaN(shiftStart.getTime())) {
    return false;
  }

  return now.getTime() - shiftStart.getTime() >= MISSED_CHECK_IN_GRACE_MINUTES * 60000;
}

function isLikelyToMissCheckIn(
  shift: Shift,
  attendance?: { checkInAt: string | null; checkOutAt: string | null } | null,
) {
  if (normalizeShiftLifecycleStatus(shift.status) !== 'ready') {
    return false;
  }

  const now = new Date();
  const shiftStart = new Date(shift.start);

  if (Number.isNaN(shiftStart.getTime()) || attendance?.checkInAt) {
    return false;
  }

  const minutesToStart = (shiftStart.getTime() - now.getTime()) / 60000;
  return minutesToStart <= 15 && minutesToStart > 0;
}

function getSiteRiskLevel(
  siteId: number | undefined,
  shifts: Shift[],
  attendanceByShiftId: Map<number, { checkInAt: string | null; checkOutAt: string | null }>,
  incidentsByShiftId: Map<number, Incident[]>,
  alertsByShiftId: Map<number, SafetyAlert[]>,
) {
  if (!siteId) {
    return 'LOW';
  }

  let rejectedCount = 0;
  let highRiskCount = 0;
  let lateCount = 0;

  shifts.forEach((shift) => {
    const currentSiteId = shift.site?.id ?? shift.siteId;
    if (currentSiteId !== siteId) {
      return;
    }

    const attendance = attendanceByShiftId.get(shift.id);
    const risk = getShiftRisk(
      shift,
      attendance,
      incidentsByShiftId.get(shift.id) || [],
      alertsByShiftId.get(shift.id) || [],
    );

    if (normalizeShiftLifecycleStatus(shift.status) === 'rejected') {
      rejectedCount += 1;
    }

    if (risk.level === 'high') {
      highRiskCount += 1;
    }

    if (getShiftDelay(shift, attendance) !== null) {
      lateCount += 1;
    }
  });

  const score = rejectedCount + highRiskCount + lateCount;
  if (highRiskCount >= 2 || score >= 3) {
    return 'HIGH';
  }

  if (score >= 1) {
    return 'MEDIUM';
  }

  return 'LOW';
}

function getLiveShiftBoardRowTone(
  status: string,
  riskLevel?: 'high' | 'medium' | 'low',
) {
  if (riskLevel === 'high') {
    return colors.dangerSurface;
  }

  return getLiveShiftRowTone(status);
}

function ShiftStatusBadge({ status }: { status?: string | null }) {
  const badge = getShiftStatusBadge(status || 'unfilled');

  return (
    <View style={[styles.statusBadge, { borderColor: badge.color, backgroundColor: `${badge.color}14` }]}>
      <Text style={[styles.statusBadgeText, { color: badge.color }]}>{`${badge.icon} ${badge.label}`}</Text>
    </View>
  );
}

function buildIsoDateTime(date: string, time: string) {
  return `${date}T${time}:00`;
}

function parseDateInput(value: string) {
  if (!isValidDateInput(value)) {
    return null;
  }

  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildShiftDateTimes(date: string, startTime: string, endTime: string) {
  const startAt = buildIsoDateTime(date, startTime);
  const endDate =
    endTime <= startTime
      ? formatDateInput(addDays(parseDateInput(date) || new Date(`${date}T00:00:00`), 1))
      : date;

  return {
    startAt,
    endAt: buildIsoDateTime(endDate, endTime),
  };
}

function isValidDateInput(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTimeInput(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateSameDayShiftTiming(date: string, startTime: string, endTime: string) {
  if (!date || !startTime || !endTime) {
    return 'Date, start time, and end time are required.';
  }

  if (!isValidDateInput(date)) {
    return 'Use a valid date in DD/MM/YYYY format.';
  }

  if (!isValidTimeInput(startTime) || !isValidTimeInput(endTime)) {
    return 'Use valid 24-hour times for both start and end.';
  }

  return null;
}

function isoToDateInput(value?: string | null) {
  if (!value) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isoToTimeInput(value?: string | null) {
  if (!value) {
    return '';
  }

  if (/^\d{2}:\d{2}$/.test(value)) {
    return value;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function weekCommencingFor(raw?: string) {
  const base = raw ? parseDateInput(raw) || new Date(`${raw}T00:00:00`) : new Date();
  const day = base.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = addDays(base, mondayOffset);
  return formatDateInput(monday);
}

function buildWeekDays(weekCommencing: string) {
  const start = parseDateInput(weekCommencing) || new Date(`${weekCommencing}T00:00:00`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    return {
      date: formatDateInput(date),
      label: date.toLocaleDateString([], { weekday: 'long' }),
      shortLabel: date.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }),
    };
  });
}

function normalizePlannerStatus(status: string, assignedGuardId: string) {
  const normalizedStatus = normalizeShiftLifecycleStatus(status);

  if (normalizedStatus) {
    return normalizedStatus;
  }

  return assignedGuardId ? 'offered' : 'unfilled';
}

function buildPlannerRow(date: string): PlannerRow {
  return {
    localId: `${date}-${Math.random().toString(36).slice(2, 8)}`,
    date,
    startTime: '08:00',
    endTime: '18:00',
    guardsRequired: '1',
    assignedGuardId: '',
    status: 'unfilled',
    instructions: '',
    sourceShiftIds: [],
  };
}

function WebSelect({
  value,
  onChange,
  options,
  placeholder,
  style,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  placeholder?: string;
  /** Merged on top of shared select chrome (e.g. Live Operations filter bar). */
  style?: any;
}) {
  const [isBrowserSelectReady, setIsBrowserSelectReady] = React.useState(false);

  React.useEffect(() => {
    setIsBrowserSelectReady(typeof document !== 'undefined');
  }, []);

  const mergedDomSelectStyle = React.useMemo(() => {
    const flat = (StyleSheet as unknown as { flatten: (s: any) => Record<string, unknown> }).flatten(
      [webSelectStyle as any, style].filter(Boolean),
    );
    return flat && typeof flat === 'object' ? flat : webSelectStyle;
  }, [style]);

  if (isBrowserSelectReady) {
    const SelectTag: any = 'select';
    const OptionTag: any = 'option';

    return (
      <SelectTag
        value={value}
        onChange={(event: any) => onChange(event.target.value)}
        style={mergedDomSelectStyle}
        aria-label={placeholder || 'Select an option'}
      >
        <OptionTag value="">{placeholder || 'Select an option'}</OptionTag>
        {options.map((option) => (
          <OptionTag key={option.value} value={option.value}>
            {option.label}
          </OptionTag>
        ))}
      </SelectTag>
    );
  }

  return (
    <TextInput
      value={value}
      onChangeText={(nextValue: string) => onChange(nextValue)}
      placeholder={placeholder || (options[0] ? `${options[0].label}` : 'Enter value')}
      style={[webSelectStyle, style] as any}
      placeholderTextColor="#6b7280"
    />
  );
}

function NativeBrowserSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  placeholder?: string;
}) {
  const [isBrowserMounted, setIsBrowserMounted] = React.useState(false);

  React.useEffect(() => {
    setIsBrowserMounted(typeof document !== 'undefined');
  }, []);

  if (isBrowserMounted) {
    const SelectTag: any = 'select';
    const OptionTag: any = 'option';

    return (
      <SelectTag
        value={value}
        onChange={(event: any) => onChange(event.target.value)}
        style={webSelectStyle}
        aria-label={placeholder || 'Select an option'}
      >
        <OptionTag value="">{placeholder || 'Select an option'}</OptionTag>
        {options.map((option) => (
          <OptionTag key={option.value} value={option.value}>
            {option.label}
          </OptionTag>
        ))}
      </SelectTag>
    );
  }

  return (
    <TextInput
      value={options.find((option) => option.value === value)?.label || ''}
      editable={false}
      placeholder={placeholder || 'Select an option'}
      style={webSelectStyle}
      placeholderTextColor="#6b7280"
    />
  );
}

function ControlledDateInput({
  value,
  onChange,
  placeholder = 'DD/MM/YYYY',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  if (typeof document === 'undefined') {
    return (
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        style={webSelectStyle}
        placeholderTextColor="#6b7280"
      />
    );
  }

  const InputTag: any = 'input';

  return (
    <InputTag
      type="date"
      value={value}
      onChange={(event: any) => onChange(event.target.value)}
      style={webSelectStyle}
    />
  );
}

function ControlledTimeInput({
  value,
  onChange,
  placeholder = 'HH:MM',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  if (typeof document === 'undefined') {
    return (
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        style={webSelectStyle}
        placeholderTextColor="#6b7280"
      />
    );
  }

  const InputTag: any = 'input';

  return (
    <InputTag
      type="time"
      value={value}
      onChange={(event: any) => onChange(event.target.value)}
      style={webSelectStyle}
    />
  );
}

type CompanyDashboardScreenProps = {
  user?: AuthUser;
  onLogout?: () => void;
};

/** Native phones below this width show a pilot message instead of the desktop company workspace. */
const COMPANY_NATIVE_MIN_WIDTH = 768;

export function CompanyDashboardScreen({ user, onLogout }: CompanyDashboardScreenProps = {}) {
  const { width: layoutWidth } = useWindowDimensions();
  const companyMobileLayoutDisabled = !IS_WEB && layoutWidth < COMPANY_NATIVE_MIN_WIDTH;

  // ── Responsive breakpoints ────────────────────────────────────────────────
  const isTablet   = layoutWidth >= 768  && layoutWidth < 1024;
  const isMobileW  = layoutWidth < 768;
  const isOverlayNav = isTablet || isMobileW;

  // ── Shell state ───────────────────────────────────────────────────────────
  // Laptop (1024–1279) defaults to collapsed; desktop (≥1280) defaults expanded.
  const [isSidebarCollapsed, setIsSidebarCollapsed] = React.useState(
    layoutWidth >= 1024 && layoutWidth < 1280,
  );
  const [isMobileNavOpen, setIsMobileNavOpen] = React.useState(false);

  // Close overlay nav when viewport grows past tablet breakpoint.
  React.useEffect(() => {
    if (!isOverlayNav) setIsMobileNavOpen(false);
  }, [isOverlayNav]);
  const contentScrollRef = React.useRef<{ scrollTo: (options: { y: number; animated: boolean }) => void } | null>(null);

  const [activeSection, setActiveSection] = React.useState<CompanySection>('dashboard');
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [clients, setClients] = React.useState<Client[]>([]);
  const [sites, setSites] = React.useState<Site[]>([]);
  const [shifts, setShifts] = React.useState<Shift[]>([]);
  const [guards, setGuards] = React.useState<GuardProfile[]>([]);
  const [companyGuards, setCompanyGuards] = React.useState<CompanyGuard[]>([]);
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [applications, setApplications] = React.useState<JobApplication[]>([]);
  const [attendanceEvents, setAttendanceEvents] = React.useState<AttendanceEvent[]>([]);
  const [timesheets, setTimesheets] = React.useState<Timesheet[]>([]);
  const [incidents, setIncidents] = React.useState<Incident[]>([]);
  const [alerts, setAlerts] = React.useState<SafetyAlert[]>([]);
  const [dailyLogs, setDailyLogs] = React.useState<DailyLog[]>([]);
  const [notifications, setNotifications] = React.useState<Notification[]>([]);
  const [uncoveredShifts, setUncoveredShifts] = React.useState<CoverageShiftRow[]>([]);
  const [complianceRecords, setComplianceRecords] = React.useState<ComplianceRecord[]>([]);
  const [coverageNavigationContext, setCoverageNavigationContext] = React.useState<CoverageNavigationContext | undefined>(undefined);
  const [selectedSiteId, setSelectedSiteId] = React.useState<number | null>(null);
  const [selectedShiftId, setSelectedShiftId] = React.useState<number | null>(null);
  const [clientForm, setClientForm] = React.useState<ClientFormState>(CLIENT_FORM_EMPTY);
  const [siteForm, setSiteForm] = React.useState<SiteFormState>(SITE_FORM_EMPTY);
  const [jobForm, setJobForm] = React.useState<JobFormState>(JOB_FORM_EMPTY);
  const [plannerClientId, setPlannerClientId] = React.useState('');
  const [plannerSiteId, setPlannerSiteId] = React.useState('');
  const [plannerWeekCommencing, setPlannerWeekCommencing] = React.useState(weekCommencingFor());
  const [plannerRows, setPlannerRows] = React.useState<PlannerRow[]>([]);
  const [plannerRemovedShiftIds, setPlannerRemovedShiftIds] = React.useState<number[]>([]);
  // R4C1 — RotaSlot read state
  const [rotaWeekData, setRotaWeekData] = React.useState<RotaWeekResponse | null>(null);
  const [loadingRota, setLoadingRota] = React.useState(false);
  const [rotaError, setRotaError] = React.useState<string | null>(null);
  const [rotaLoadKey, setRotaLoadKey] = React.useState(0);
  const [liveFilters, setLiveFilters] = React.useState<LiveFilters>({
    clientId: '',
    siteId: '',
    guardId: '',
    date: '',
    status: '',
  });
  const [savingClient, setSavingClient] = React.useState(false);
  const [savingSite, setSavingSite] = React.useState(false);
  const [savingRota, setSavingRota] = React.useState(false);
  const [creatingJob, setCreatingJob] = React.useState(false);
  const [approvingGuardId, setApprovingGuardId] = React.useState<number | null>(null);
  const [reviewingApplicationId, setReviewingApplicationId] = React.useState<number | null>(null);
  const [offerActionShiftId, setOfferActionShiftId] = React.useState<number | null>(null);
  const [reassignGuardByShiftId, setReassignGuardByShiftId] = React.useState<Record<number, string>>({});
  const [shiftOffersFeedback, setShiftOffersFeedback] = React.useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);
  const [liveOperationsFeedback, setLiveOperationsFeedback] = React.useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);
  const [urgentActionItemId, setUrgentActionItemId] = React.useState<string | null>(null);
  const [managementActions, setManagementActions] = React.useState<ManagementActionItem[]>([]);
  const [closeOutNotesDraft, setCloseOutNotesDraft] = React.useState('');
  const [savingCloseOutNotes, setSavingCloseOutNotes] = React.useState(false);
  const [liveBoardAnchorY, setLiveBoardAnchorY] = React.useState(0);
  const [shiftDetailAnchorY, setShiftDetailAnchorY] = React.useState(0);
  const [pendingShiftDetailFocusId, setPendingShiftDetailFocusId] = React.useState<number | null>(null);
  const [highlightedLiveShiftId, setHighlightedLiveShiftId] = React.useState<number | null>(null);
  const [liveBoardHighlightTimeoutId, setLiveBoardHighlightTimeoutId] = React.useState<ReturnType<typeof setTimeout> | null>(null);
  const [autoMarkingMissedShiftIds, setAutoMarkingMissedShiftIds] = React.useState<number[]>([]);

  // P1G-B — Guard Payroll / Payment Administration
  const [selectedPayrollGuardId, setSelectedPayrollGuardId] = React.useState<number | null>(null);
  const [selectedPayrollGuardName, setSelectedPayrollGuardName] = React.useState<string>('');
  const [guardPayrollRecord, setGuardPayrollRecord] = React.useState<CompanyGuardPayrollRecord | null>(null);
  const [guardPayrollEngagementType, setGuardPayrollEngagementType] = React.useState<GuardEngagementType | 'NONE' | null>(null);
  const [guardPayrollLoading, setGuardPayrollLoading] = React.useState(false);
  const [guardPayrollError, setGuardPayrollError] = React.useState<string | null>(null);
  const [editingPayrollAdmin, setEditingPayrollAdmin] = React.useState(false);
  const [payrollRefInput, setPayrollRefInput] = React.useState('');
  const [payrollFreqInput, setPayrollFreqInput] = React.useState('');
  const [payrollStatusInput, setPayrollStatusInput] = React.useState('ACTIVE');
  const [payrollStartDateInput, setPayrollStartDateInput] = React.useState('');
  const [payrollEndDateInput, setPayrollEndDateInput] = React.useState('');
  const [payrollNoteInput, setPayrollNoteInput] = React.useState('');
  const [savingPayrollAdmin, setSavingPayrollAdmin] = React.useState(false);
  const [payrollAdminFeedback, setPayrollAdminFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const runSettledLoaders = React.useMemo(
    () => async (loaders: SettledLoader[]) => {
      const results = await Promise.allSettled(loaders.map((loader) => loader.run()));
      const failures: unknown[] = [];

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
        loaders[index].apply(result.value);
      } else {
        failures.push(result.reason);
      }
      });

      return failures;
    },
    [],
  );

  const loadData = React.useMemo(
    () =>
    async (isRefresh = false) => {
      if (companyMobileLayoutDisabled) {
        setLoading(false);
        setRefreshing(false);
        return;
      }
      try {
        setError(null);
        if (isRefresh) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }

        let latestSites: Site[] = [];
        let latestShifts: Shift[] = [];

        const coreFailures = await runSettledLoaders([
          {
            label: 'clients',
            run: listClients,
            apply: (value: Client[]) => setClients(value),
          },
          {
            label: 'sites',
            run: listSites,
            apply: (value: Site[]) => {
              latestSites = value;
              setSites(latestSites);
            },
          },
          {
            label: 'shifts',
            run: listShifts,
            apply: (value: Shift[]) => {
              latestShifts = value.map((shift) => ({
                ...shift,
                status: normalizeShiftLifecycleStatus(shift.status),
              }));
              setShifts(latestShifts);
            },
          },
          {
            label: 'uncovered coverage',
            run: () => listCoverageShifts({ uncoveredOnly: true }),
            apply: (value: CoverageShiftRow[]) => setUncoveredShifts(value),
          },
          {
            label: 'guards',
            run: listGuards,
            apply: (value: GuardProfile[]) => setGuards(value),
          },
          {
            label: 'company guards',
            run: listCompanyGuards,
            apply: (value: CompanyGuard[]) => setCompanyGuards(value),
          },
        ]);

        if (!selectedSiteId && latestSites[0]) {
          setSelectedSiteId(latestSites[0].id);
        }

        if (!selectedShiftId && latestShifts[0]) {
          setSelectedShiftId(latestShifts[0].id);
        }

        const sectionLoaders: Partial<Record<CompanySection, SettledLoader[]>> = {
          dashboard: [
            { label: 'attendance', run: listCompanyAttendance, apply: (value: AttendanceEvent[]) => setAttendanceEvents(value) },
            { label: 'timesheets', run: listCompanyTimesheets, apply: (value: Timesheet[]) => setTimesheets(value) },
            { label: 'incidents', run: listCompanyIncidents, apply: (value: Incident[]) => setIncidents(value) },
            { label: 'alerts', run: listCompanySafetyAlerts, apply: (value: SafetyAlert[]) => setAlerts(value) },
            { label: 'daily logs', run: listCompanyDailyLogs, apply: (value: DailyLog[]) => setDailyLogs(value) },
            { label: 'notifications', run: listCompanyNotifications, apply: (value: Notification[]) => setNotifications(value) },
            { label: 'compliance', run: listComplianceRecords, apply: (value: ComplianceRecord[]) => setComplianceRecords(value) },
          ],
          'live-operations': [
              { label: 'attendance', run: listCompanyAttendance, apply: (value: AttendanceEvent[]) => setAttendanceEvents(value) },
              { label: 'timesheets', run: listCompanyTimesheets, apply: (value: Timesheet[]) => setTimesheets(value) },
              { label: 'incidents', run: listCompanyIncidents, apply: (value: Incident[]) => setIncidents(value) },
              { label: 'alerts', run: listCompanySafetyAlerts, apply: (value: SafetyAlert[]) => setAlerts(value) },
              { label: 'daily logs', run: listCompanyDailyLogs, apply: (value: DailyLog[]) => setDailyLogs(value) },
              { label: 'notifications', run: listCompanyNotifications, apply: (value: Notification[]) => setNotifications(value) },
            ],
          recruitment: [
            { label: 'jobs', run: listJobs, apply: (value: Job[]) => setJobs(value) },
            { label: 'applications', run: listJobApplications, apply: (value: JobApplication[]) => setApplications(value) },
          ],
          timesheets: [
            { label: 'timesheets', run: listCompanyTimesheets, apply: (value: Timesheet[]) => setTimesheets(value) },
          ],
          incidents: [
            { label: 'incidents', run: listCompanyIncidents, apply: (value: Incident[]) => setIncidents(value) },
          ],
          alerts: [
            { label: 'alerts', run: listCompanySafetyAlerts, apply: (value: SafetyAlert[]) => setAlerts(value) },
          ],
        };

        const sectionFailures = await runSettledLoaders(sectionLoaders[activeSection] || []);
        const failures = [...coreFailures, ...sectionFailures];

        if (failures.length > 0) {
          setError(formatApiErrorMessage(failures[0], 'Some company workspace data could not be loaded.'));
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeSection, runSettledLoaders, selectedShiftId, selectedSiteId, companyMobileLayoutDisabled],
  );

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  React.useEffect(() => {
    if (companyMobileLayoutDisabled) {
      return;
    }
    if (activeSection !== 'live-operations') {
      return;
    }

    const intervalId = setInterval(() => {
      loadData(true);
    }, 15000);

    return () => clearInterval(intervalId);
  }, [activeSection, loadData, companyMobileLayoutDisabled]);

  React.useEffect(() => {
    return () => {
      if (liveBoardHighlightTimeoutId) {
        clearTimeout(liveBoardHighlightTimeoutId);
      }
    };
  }, [liveBoardHighlightTimeoutId]);

  const activeCompanyGuards = React.useMemo(
    () =>
      companyGuards.filter((entry) => {
        const relationActive = (entry.status || '').toUpperCase() === 'ACTIVE';
        const guardStatus = (entry.guard?.status || '').toLowerCase();
        const guardApproval = (entry.guard?.approvalStatus || '').toLowerCase();
        const operationalStatus = !guardStatus || guardStatus === 'active' || guardStatus === 'approved';
        const approvedStatus = !guardApproval || guardApproval === 'approved';
        return relationActive && operationalStatus && approvedStatus;
      }),
    [companyGuards],
  );

  const linkedGuardIds = React.useMemo(
    () => new Set(activeCompanyGuards.map((entry) => entry.guard?.id).filter((value): value is number => typeof value === 'number')),
    [activeCompanyGuards],
  );

  const linkedGuards = React.useMemo(() => {
    const unique = new Map<number, GuardProfile>();
    activeCompanyGuards.forEach((entry) => {
      if (entry.guard?.id) {
        unique.set(entry.guard.id, entry.guard);
      }
    });
    return Array.from(unique.values()).sort((left, right) => left.fullName.localeCompare(right.fullName));
  }, [activeCompanyGuards]);

  const availablePlatformGuards = React.useMemo(
    () =>
      guards.filter((guard) => {
        const guardStatus = (guard.status || '').toLowerCase();
        const guardApproval = (guard.approvalStatus || '').toLowerCase();
        const operationalStatus = !guardStatus || guardStatus === 'active' || guardStatus === 'approved';
        const approvedStatus = !guardApproval || guardApproval === 'approved';
        return operationalStatus && approvedStatus && !linkedGuardIds.has(guard.id);
      }),
    [guards, linkedGuardIds],
  );

  const clientMap = React.useMemo(() => new Map(clients.map((client) => [client.id, client])), [clients]);
  const siteMap = React.useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const guardMap = React.useMemo(() => new Map(guards.map((guard) => [guard.id, guard])), [guards]);
  const timesheetByShiftId = React.useMemo(
    () => new Map(timesheets.map((timesheet) => [timesheet.shiftId, timesheet])),
    [timesheets],
  );
  const attendanceByShiftId = React.useMemo(() => {
    const map = new Map<number, { checkInAt: string | null; checkOutAt: string | null }>();

    attendanceEvents.forEach((event) => {
      const shiftId = event.shift?.id;
      if (!shiftId) {
        return;
      }

      const current = map.get(shiftId) || { checkInAt: null, checkOutAt: null };
      if (event.type === 'check-in') {
        if (!current.checkInAt || current.checkInAt.localeCompare(event.occurredAt) < 0) {
          current.checkInAt = event.occurredAt;
        }
      }
      if (event.type === 'check-out') {
        if (!current.checkOutAt || current.checkOutAt.localeCompare(event.occurredAt) < 0) {
          current.checkOutAt = event.occurredAt;
        }
      }

      map.set(shiftId, current);
    });

    return map;
  }, [attendanceEvents]);
  const incidentsByShiftId = React.useMemo(() => {
    const map = new Map<number, Incident[]>();
    incidents.forEach((incident) => {
      const shiftId = incident.shift?.id;
      if (!shiftId) {
        return;
      }

      const group = map.get(shiftId) || [];
      group.push(incident);
      map.set(shiftId, group);
    });
    return map;
  }, [incidents]);
  const alertsByShiftId = React.useMemo(() => {
    const map = new Map<number, SafetyAlert[]>();
    alerts.forEach((alert) => {
      const shiftId = alert.shift?.id;
      if (!shiftId) {
        return;
      }

      const group = map.get(shiftId) || [];
      group.push(alert);
      map.set(shiftId, group);
    });
    return map;
  }, [alerts]);
  const logsByShiftId = React.useMemo(() => {
    const map = new Map<number, DailyLog[]>();
    dailyLogs.forEach((log) => {
      const shiftId = log.shift?.id;
      if (!shiftId) {
        return;
      }

      const group = map.get(shiftId) || [];
      group.push(log);
      map.set(shiftId, group);
    });
    return map;
  }, [dailyLogs]);
  const lastCheckCallByShiftId = React.useMemo(() => {
    const map = new Map<number, DailyLog>();
    dailyLogs.forEach((log) => {
      const shiftId = log.shift?.id;
      if (!shiftId || !['check_call', 'welfare_check'].includes(log.logType)) {
        return;
      }

      const current = map.get(shiftId);
      if (!current || current.createdAt.localeCompare(log.createdAt) < 0) {
        map.set(shiftId, log);
      }
    });
    return map;
  }, [dailyLogs]);

  React.useEffect(() => {
    if (companyMobileLayoutDisabled) {
      return;
    }
    if (activeSection !== 'live-operations') {
      return;
    }

    const overdueReadyShifts = shifts.filter((shift) =>
      isShiftPastMissedGracePeriod(shift, attendanceByShiftId.get(shift.id)),
    );

    if (overdueReadyShifts.length === 0) {
      return;
    }

    let cancelled = false;

    const runAutomation = async () => {
      let automatedAny = false;

      for (const shift of overdueReadyShifts) {
        if (cancelled || autoMarkingMissedShiftIds.includes(shift.id)) {
          continue;
        }

        setAutoMarkingMissedShiftIds((current) => [...current, shift.id]);

        try {
          await updateShift(shift.id, { status: 'missed' });
          automatedAny = true;
          recordManagementAction({
            shiftId: shift.id,
            siteName: shift.site?.name || shift.siteName || 'Unknown site',
            guardName: shift.guard?.fullName || 'Unassigned',
            itemType: 'Shift automation',
            actionTaken: `Shift auto-marked missed after ${MISSED_CHECK_IN_GRACE_MINUTES} minutes without check-in`,
          });
          setLiveOperationsFeedback({
            tone: 'success',
            message: `Shift #${shift.id} was automatically marked as missed after ${MISSED_CHECK_IN_GRACE_MINUTES} minutes without check-in.`,
          });
        } catch (automationError) {
          setAutoMarkingMissedShiftIds((current) => current.filter((id) => id !== shift.id));
          if (!cancelled) {
            setError(formatApiErrorMessage(automationError, 'Unable to mark this missed shift automatically.'));
            setLiveOperationsFeedback({
              tone: 'error',
              message: formatApiErrorMessage(automationError, 'Unable to mark this missed shift automatically.'),
            });
          }
        }
      }

      if (automatedAny && !cancelled) {
        await loadData(true);
      }
    };

    runAutomation();

    return () => {
      cancelled = true;
    };
  }, [activeSection, attendanceByShiftId, autoMarkingMissedShiftIds, companyMobileLayoutDisabled, loadData, shifts]);

  const activeClients = React.useMemo(
    () => clients.filter((client) => (client.status || 'active').toLowerCase() !== 'archived'),
    [clients],
  );

  const activeSites = React.useMemo(
    () => sites.filter((site) => (site.status || 'active').toLowerCase() !== 'archived'),
    [sites],
  );

  const todayIso = formatDateInput(new Date());
  const shiftsToday = React.useMemo(
    () => shifts.filter((shift) => shift.start.slice(0, 10) === todayIso),
    [shifts, todayIso],
  );
  const liveShifts = React.useMemo(
    () => shifts.filter((shift) => ['ready', 'in_progress'].includes(normalizeShiftLifecycleStatus(shift.status))),
    [shifts],
  );
  const pendingTimesheets = React.useMemo(
    () => timesheets.filter((timesheet) => (timesheet.approvalStatus || '').toLowerCase() !== 'approved'),
    [timesheets],
  );
  const overdueReviewTimesheets = React.useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return timesheets.filter((timesheet) => {
      if ((timesheet.approvalStatus || '').toLowerCase() !== 'submitted') return false;
      const submittedAt = timesheet.submittedAt ? new Date(timesheet.submittedAt).getTime() : null;
      return submittedAt !== null && !Number.isNaN(submittedAt) && submittedAt <= cutoff;
    });
  }, [timesheets]);
  const pendingPayrollTimesheets = React.useMemo(
    () =>
      timesheets.filter(
        (timesheet) =>
          (timesheet.approvalStatus || '').toLowerCase() === 'approved' &&
          (timesheet.payrollStatus || 'unpaid').toLowerCase() === 'unpaid' &&
          !timesheet.payrollBatch,
      ),
    [timesheets],
  );
  const pendingInvoiceTimesheets = React.useMemo(
    () =>
      timesheets.filter(
        (timesheet) =>
          (timesheet.approvalStatus || '').toLowerCase() === 'approved' &&
          (timesheet.billingStatus || 'uninvoiced').toLowerCase() === 'uninvoiced' &&
          !timesheet.invoiceBatch,
      ),
    [timesheets],
  );
  const openIncidents = React.useMemo(
    () => incidents.filter((incident) => ['open', 'in_review'].includes((incident.status || '').toLowerCase())),
    [incidents],
  );
  const outstandingAlerts = React.useMemo(
    () => alerts.filter((alert) => (alert.status || '').toLowerCase() !== 'closed'),
    [alerts],
  );
  const missedCheckCalls = React.useMemo(
    () => outstandingAlerts.filter((alert) => ['check_call', 'missed_checkcall'].includes((alert.type || '').toLowerCase())),
    [outstandingAlerts],
  );
  const activePanicAlerts = React.useMemo(
    () => outstandingAlerts.filter((alert) => (alert.type || '').toLowerCase() === 'panic'),
    [outstandingAlerts],
  );
  const recentActivity = React.useMemo(
    () =>
      [...dailyLogs]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 6),
    [dailyLogs],
  );
  const shiftOfferRows = React.useMemo(
    () =>
      shifts
        .filter((shift) => ['offered', 'ready', 'rejected', 'missed'].includes(normalizeShiftLifecycleStatus(shift.status)))
        .sort((left, right) => left.start.localeCompare(right.start)),
    [shifts],
  );
  const pendingShiftOffers = React.useMemo(
    () => shiftOfferRows.filter((shift) => normalizeShiftLifecycleStatus(shift.status) === 'offered'),
    [shiftOfferRows],
  );
  const readyShiftOffers = React.useMemo(
    () => shiftOfferRows.filter((shift) => normalizeShiftLifecycleStatus(shift.status) === 'ready'),
    [shiftOfferRows],
  );
  const missedShiftOffers = React.useMemo(
    () => shiftOfferRows.filter((shift) => normalizeShiftLifecycleStatus(shift.status) === 'missed'),
    [shiftOfferRows],
  );
  const rejectedShiftOffers = React.useMemo(
    () =>
      shiftOfferRows.filter((shift) =>
        normalizeShiftLifecycleStatus(shift.status) === 'rejected',
      ),
    [shiftOfferRows],
  );
  const urgentOperationalItems = React.useMemo(() => {
    const now = new Date();
    const items: UrgentOperationalItem[] = [];
    const readyShiftsNotBookedOn = shifts.filter((shift) => {
      const attendance = attendanceByShiftId.get(shift.id);
      return (
        normalizeShiftLifecycleStatus(shift.status) === 'ready' &&
        !attendance?.checkInAt &&
        new Date(shift.start).getTime() <= now.getTime()
      );
    });
    const upcomingRiskShifts = shifts.filter((shift) =>
      isLikelyToMissCheckIn(shift, attendanceByShiftId.get(shift.id)),
    );

    uncoveredShifts.forEach((shift) => {
      items.push({
        id: `uncovered-${shift.shiftId}`,
        shiftId: shift.shiftId,
        status: shift.coverageState || shift.coverageStatus,
        siteName: shift.siteName || 'Unknown site',
        guardName: shift.guardName || 'No confirmed guard',
        category: 'uncovered_shift',
        issueType: 'Uncovered shift',
        message: `${formatDateLabel(shift.start)} · ${formatTimeLabel(shift.start)}-${formatTimeLabel(shift.end)} · ${formatStatusLabel(shift.coverageState || shift.coverageStatus)}`,
        occurredAt: shift.start,
      });
    });

    activePanicAlerts.forEach((alert) => {
      items.push({
        id: `panic-${alert.id}`,
        alertId: alert.id,
        shiftId: alert.shift?.id ?? null,
        status: alert.status,
        siteName: alert.shift?.site?.name || alert.shift?.siteName || 'Unknown site',
        guardName: alert.guard?.fullName || 'Unknown guard',
        category: 'panic',
        issueType: 'Active panic alert',
        message: alert.message || 'Emergency assistance requested from a live shift.',
        occurredAt: alert.createdAt,
      });
    });

    openIncidents.forEach((incident) => {
      items.push({
        id: `incident-${incident.id}`,
        incidentId: incident.id,
        shiftId: incident.shift?.id ?? null,
        status: incident.status,
        siteName: incident.site?.name || incident.shift?.site?.name || 'Unknown site',
        guardName: incident.guard?.fullName || 'Unknown guard',
        category: 'incident',
        issueType: 'Incident unresolved',
        message: incident.title,
        occurredAt: incident.createdAt,
      });
    });

    readyShiftsNotBookedOn.forEach((shift) => {
      items.push({
        id: `ready-overdue-${shift.id}`,
        shiftId: shift.id,
        status: shift.status,
        siteName: shift.site?.name || shift.siteName || 'Unknown site',
        guardName: shift.guard?.fullName || 'Unassigned',
        category: 'late_start',
        issueType: 'Guard not booked on',
        message: 'Shift start time has passed but the guard has not booked on yet.',
        occurredAt: shift.start,
      });
    });

    upcomingRiskShifts.forEach((shift) => {
      items.push({
        id: `upcoming-risk-${shift.id}`,
        shiftId: shift.id,
        status: shift.status,
        siteName: shift.site?.name || shift.siteName || 'Unknown site',
        guardName: shift.guard?.fullName || 'Unassigned',
        category: 'upcoming_risk',
        issueType: 'Upcoming Risk',
        message: 'Starting soon – no check-in ⚠️',
        occurredAt: shift.start,
      });
    });

    shifts
      .filter((shift) => normalizeShiftLifecycleStatus(shift.status) === 'missed')
      .forEach((shift) => {
        items.push({
          id: `missed-${shift.id}`,
          shiftId: shift.id,
          status: shift.status,
        siteName: shift.site?.name || shift.siteName || 'Unknown site',
        guardName: shift.guard?.fullName || 'Unassigned',
        category: 'missed_shift',
        issueType: 'Re-cover required',
        message: `No check-in was recorded within ${MISSED_CHECK_IN_GRACE_MINUTES} minutes of shift start.`,
        occurredAt: shift.start,
      });
      });

    missedCheckCalls.forEach((alert) => {
      items.push({
        id: `checkcall-${alert.id}`,
        alertId: alert.id,
        shiftId: alert.shift?.id ?? null,
        status: alert.status,
        siteName: alert.shift?.site?.name || alert.shift?.siteName || 'Unknown site',
        guardName: alert.guard?.fullName || 'Unknown guard',
        category: 'missed_check_call',
        issueType: 'Missed or overdue check call',
        message: alert.message || 'A scheduled check call needs attention.',
        occurredAt: alert.createdAt,
      });
    });

    rejectedShiftOffers.forEach((shift) => {
      items.push({
        id: `rejected-${shift.id}`,
        shiftId: shift.id,
        status: shift.status,
        siteName: shift.site?.name || shift.siteName || 'Unknown site',
        guardName: shift.guard?.fullName || 'No guard',
        category: 'rejected_offer',
        issueType: 'Re-offer required',
        message: 'The offered guard rejected this shift and replacement cover is still needed.',
        occurredAt: shift.start,
      });
    });

    outstandingAlerts
      .filter((alert) => ['welfare', 'late_checkin', 'other'].includes((alert.type || '').toLowerCase()))
      .forEach((alert) => {
      items.push({
        id: `attention-${alert.id}`,
        alertId: alert.id,
        shiftId: alert.shift?.id ?? null,
        status: alert.status,
        siteName: alert.shift?.site?.name || alert.shift?.siteName || 'Unknown site',
        guardName: alert.guard?.fullName || 'Unknown guard',
        category: 'safety',
        issueType: 'Safety / welfare needs attention',
        message: alert.message || 'A safety or welfare item needs review.',
        occurredAt: alert.createdAt,
        });
      });

    return items
      .filter((item, index, current) => current.findIndex((candidate) => candidate.id === item.id) === index)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 10);
  }, [
    activePanicAlerts,
    attendanceByShiftId,
    missedShiftOffers,
    missedCheckCalls,
    openIncidents,
    outstandingAlerts,
    rejectedShiftOffers,
    shifts,
    uncoveredShifts,
  ]);
  const recentOperationalActivity = React.useMemo(() => {
    const items: OperationalActivityItem[] = [];

    shiftOfferRows.forEach((shift) => {
      const lifecycleStatus = normalizeShiftLifecycleStatus(shift.status);
      items.push({
        id: `shift-${shift.id}-${lifecycleStatus}`,
        shiftId: shift.id,
        siteName: shift.site?.name || shift.siteName || 'Unknown site',
        guardName: shift.guard?.fullName || 'Unassigned',
        eventType:
          lifecycleStatus === 'offered'
            ? 'Shift offered'
            : lifecycleStatus === 'ready'
              ? 'Shift accepted'
              : lifecycleStatus === 'missed'
                ? 'Shift missed'
                : 'Shift rejected',
        message:
          lifecycleStatus === 'offered'
            ? 'Waiting for guard response.'
            : lifecycleStatus === 'ready'
              ? 'Guard accepted and shift is ready to start.'
              : lifecycleStatus === 'missed'
                ? `No check-in was recorded within ${MISSED_CHECK_IN_GRACE_MINUTES} minutes of shift start.`
                : 'Guard rejected and new cover is required.',
        occurredAt: shift.start,
      });
    });

    shifts
      .filter((shift) => isLikelyToMissCheckIn(shift, attendanceByShiftId.get(shift.id)))
      .forEach((shift) => {
        items.push({
          id: `likely-late-${shift.id}`,
          shiftId: shift.id,
          siteName: shift.site?.name || shift.siteName || 'Unknown site',
          guardName: shift.guard?.fullName || 'Unassigned',
          eventType: 'Likely late',
          message: 'Starting soon with no recorded check-in yet.',
          occurredAt: shift.start,
        });
      });

    attendanceEvents.forEach((event) => {
      const shiftId = event.shift?.id;
      if (!shiftId) {
        return;
      }

      if (event.type === 'check-in') {
        items.push({
          id: `attendance-in-${event.id}`,
          shiftId,
          siteName: event.shift?.site?.name || event.shift?.siteName || 'Unknown site',
          guardName: event.guard?.fullName || 'Unknown guard',
          eventType: 'Guard checked in',
          message: 'Guard booked on and the shift is now live.',
          occurredAt: event.occurredAt,
        });
      }

      if (event.type === 'check-out') {
        items.push({
          id: `attendance-out-${event.id}`,
          shiftId,
          siteName: event.shift?.site?.name || event.shift?.siteName || 'Unknown site',
          guardName: event.guard?.fullName || 'Unknown guard',
          eventType: 'Guard checked out',
          message: 'Guard booked off and the shift is completed.',
          occurredAt: event.occurredAt,
        });
      }
    });

    timesheets.forEach((timesheet) => {
      if (timesheet.submittedAt) {
        items.push({
          id: `timesheet-submitted-${timesheet.id}`,
          shiftId: timesheet.shift?.id ?? timesheet.shiftId,
          siteName: timesheet.shift?.site?.name || timesheet.shift?.siteName || 'Unknown site',
          guardName: timesheet.guard?.fullName || 'Unknown guard',
          eventType: 'Timesheet submitted',
          message: 'Worked hours were submitted for company review.',
          occurredAt: timesheet.submittedAt,
        });
      }
    });

    dailyLogs.forEach((log) => {
      items.push({
        id: `log-${log.id}`,
        shiftId: log.shift?.id,
        siteName: log.shift?.site?.name || log.shift?.siteName || 'Unknown site',
        guardName: log.guard?.fullName || 'Unknown guard',
        eventType:
          log.logType === 'check_call'
            ? 'Check call recorded'
            : log.logType === 'welfare_check'
              ? 'Welfare update recorded'
              : 'Log entry added',
        message: log.message,
        occurredAt: log.createdAt,
      });
    });

    incidents.forEach((incident) => {
      items.push({
        id: `incident-${incident.id}`,
        shiftId: incident.shift?.id,
        siteName: incident.site?.name || incident.shift?.site?.name || 'Unknown site',
        guardName: incident.guard?.fullName || 'Unknown guard',
        eventType: 'Incident raised',
        message: incident.title,
        occurredAt: incident.createdAt,
      });
    });

    alerts.forEach((alert) => {
      items.push({
        id: `alert-${alert.id}`,
        shiftId: alert.shift?.id,
        siteName: alert.shift?.site?.name || alert.shift?.siteName || 'Unknown site',
        guardName: alert.guard?.fullName || 'Unknown guard',
        eventType:
          (alert.type || '').toLowerCase() === 'panic'
            ? 'Panic alert sent'
            : (alert.type || '').toLowerCase() === 'welfare'
              ? 'Welfare update recorded'
              : 'Safety alert raised',
        message: alert.message,
        occurredAt: alert.createdAt,
      });
    });

    notifications.forEach((notification) => {
      items.push({
        id: `notification-${notification.id}`,
        shiftId: null,
        siteName: 'Control room',
        guardName: notification.user?.firstName || 'System',
        eventType: notification.title,
        message: notification.message,
        occurredAt: notification.sentAt || notification.createdAt,
      });
    });

    return items
      .filter((item, index, current) => current.findIndex((candidate) => candidate.id === item.id) === index)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 8);
  }, [alerts, attendanceByShiftId, attendanceEvents, dailyLogs, incidents, notifications, shiftOfferRows, shifts, timesheets]);

  const recentManagementActivity = React.useMemo(
    () =>
      [...managementActions]
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
        .slice(0, 6),
    [managementActions],
  );

  const selectedShift = React.useMemo(
    () => shifts.find((shift) => shift.id === selectedShiftId) ?? null,
    [selectedShiftId, shifts],
  );
  const selectedShiftCloseOutSummary = React.useMemo(() => {
    if (!selectedShift) {
      return null;
    }

    const timesheet = timesheetByShiftId.get(selectedShift.id);
    const attendance = attendanceByShiftId.get(selectedShift.id);
    const shiftLogs = logsByShiftId.get(selectedShift.id) || [];
    const shiftIncidents = incidentsByShiftId.get(selectedShift.id) || [];
    const shiftAlerts = alertsByShiftId.get(selectedShift.id) || [];
    const completedCheckCalls = shiftLogs.filter((log) => log.logType === 'check_call').length;
    const missedCheckCallsForShift = shiftAlerts.filter(
      (alert) => (alert.type || '').toLowerCase() === 'missed_checkcall',
    ).length;
    const safetyEventsCount = shiftAlerts.filter(
      (alert) => !['check_call', 'missed_checkcall'].includes((alert.type || '').toLowerCase()),
    ).length;
    const unresolvedIncidentsCount = shiftIncidents.filter((incident) =>
      ['open', 'in_review'].includes((incident.status || '').toLowerCase()),
    ).length;
    const unresolvedAlertsCount = shiftAlerts.filter((alert) => (alert.status || '').toLowerCase() !== 'closed').length;
    const unresolvedFollowUpCount = unresolvedIncidentsCount + unresolvedAlertsCount;

    return {
      scheduledStart: selectedShift.start,
      scheduledEnd: selectedShift.end,
      actualCheckInAt: attendance?.checkInAt || null,
      actualCheckOutAt: attendance?.checkOutAt || null,
      logsCount: shiftLogs.length,
      incidentsCount: shiftIncidents.length,
      safetyEventsCount,
      completedCheckCalls,
      missedCheckCalls: missedCheckCallsForShift,
      timesheetStatus: timesheet?.approvalStatus || 'pending',
      unresolvedFollowUpCount,
      closedCleanly: unresolvedFollowUpCount === 0,
    };
  }, [selectedShift, timesheetByShiftId, attendanceByShiftId, logsByShiftId, incidentsByShiftId, alertsByShiftId]);

  React.useEffect(() => {
    setCloseOutNotesDraft(selectedShift?.closeOutNotes || '');
  }, [selectedShift?.id, selectedShift?.closeOutNotes]);

  const siteOptions = React.useMemo(
    () =>
      sites.map((site) => ({
        label: `${site.name}${site.client ? ` · ${site.client.name}` : ''}`,
        value: String(site.id),
      })),
    [sites],
  );

  const siteClientOptions = React.useMemo(
    () => activeClients.map((client) => ({ label: client.name, value: String(client.id) })),
    [activeClients],
  );

  const linkedGuardOptions = React.useMemo(
    () =>
      linkedGuards.map((guard) => ({
        label: `${guard.fullName} · ${guard.phone}`,
        value: String(guard.id),
      })),
    [linkedGuards],
  );

  const linkedGuardNameById = React.useMemo(() => {
    const map = new Map<number, string>();
    linkedGuards.forEach((guard) => {
      map.set(guard.id, guard.fullName);
    });
    return map;
  }, [linkedGuards]);

  const guardNameById = React.useMemo(
    () => new Map(Array.from(linkedGuardNameById.entries()).map(([id, name]) => [String(id), name])),
    [linkedGuardNameById],
  );

  const plannerSiteOptions = React.useMemo(
    () =>
      sites
        .filter((site) => !plannerClientId || String(site.client?.id ?? site.clientId ?? '') === plannerClientId)
        .map((site) => ({ label: site.name, value: String(site.id) })),
    [plannerClientId, sites],
  );

  const plannerWeekDays = React.useMemo(() => buildWeekDays(plannerWeekCommencing), [plannerWeekCommencing]);

  const plannerRowsByDate = React.useMemo(() => {
    const map = new Map<string, PlannerRow[]>();
    plannerWeekDays.forEach((day) => map.set(day.date, []));
    plannerRows.forEach((row) => {
      const group = map.get(row.date) || [];
      group.push(row);
      map.set(row.date, group);
    });
    return map;
  }, [plannerRows, plannerWeekDays]);

  const plannerSite = React.useMemo(
    () => sites.find((site) => String(site.id) === plannerSiteId) ?? null,
    [plannerSiteId, sites],
  );

  React.useEffect(() => {
    if (!plannerSiteId) {
      setPlannerRows([]);
      setPlannerRemovedShiftIds([]);
      return;
    }

    const weekDates = new Set(plannerWeekDays.map((day) => day.date));
    const matchingShifts = shifts.filter((shift) => {
      const siteId = shift.site?.id ?? shift.siteId;
      return String(siteId ?? '') === plannerSiteId && weekDates.has(shift.start.slice(0, 10));
    });

    const rows = matchingShifts.map((shift) => ({
      localId: `shift-${shift.id}`,
      date: shift.start.slice(0, 10),
      startTime: isoToTimeInput(shift.start),
      endTime: isoToTimeInput(shift.end),
      guardsRequired: '1',
      assignedGuardId: shift.guard?.id ? String(shift.guard.id) : '',
      status: normalizeShiftLifecycleStatus(shift.status),
      instructions: shift.instructions || '',
      sourceShiftIds: [shift.id],
    }));

    setPlannerRows(rows);
    setPlannerRemovedShiftIds([]);
  }, [plannerSiteId, plannerWeekDays, shifts]);

  // R4C1 — Flatten week response into day-keyed FlatSlotCell map
  const slotsByDayName = React.useMemo((): Map<string, FlatSlotCell[]> => {
    const map = new Map<string, FlatSlotCell[]>();
    ROTA_DAY_NAMES.forEach((day) => map.set(day, []));
    if (!rotaWeekData) return map;
    for (const siteRow of rotaWeekData.sites) {
      for (const dayName of ROTA_DAY_NAMES) {
        const dayCells = (siteRow.days as any)[dayName];
        if (!dayCells) continue;
        const daySlots = map.get(dayName)!;
        for (const cell of dayCells.slots) {
          daySlots.push({
            ...cell,
            siteId: siteRow.siteId,
            siteName: siteRow.siteName,
            clientId: siteRow.clientId,
            clientName: siteRow.clientName,
          });
        }
      }
    }
    for (const [, slots] of map) {
      slots.sort((a, b) => a.startAt.localeCompare(b.startAt));
    }
    return map;
  }, [rotaWeekData]);

  // R4C1 — Legacy shift compat: shifts with no rotaSlotId that fall in the current planner week
  const legacyShiftsByDate = React.useMemo((): Map<string, LegacyShiftRow[]> => {
    const weekDates = new Set(plannerWeekDays.map((d) => d.date));
    const map = new Map<string, LegacyShiftRow[]>();
    plannerWeekDays.forEach((d) => map.set(d.date, []));
    shifts
      .filter((shift) => weekDates.has(shift.start.slice(0, 10)) && !shift.rotaSlotId)
      .forEach((shift) => {
        const date = shift.start.slice(0, 10);
        const rows = map.get(date) ?? [];
        rows.push({
          id: shift.id,
          date,
          startTime: isoToTimeInput(shift.start),
          endTime: isoToTimeInput(shift.end),
          siteName: shift.site?.name ?? shift.siteName ?? '—',
          guardName: shift.guard?.fullName ?? null,
          status: shift.status ?? 'unfilled',
        });
        map.set(date, rows);
      });
    return map;
  }, [shifts, plannerWeekDays]);

  // R4C1 — Week ending derived from backend or computed from commencing + 6 days
  const plannerWeekEnding = rotaWeekData?.weekEnding ?? (() => {
    const start = parseDateInput(plannerWeekCommencing) ?? new Date(`${plannerWeekCommencing}T00:00:00`);
    const end = addDays(start, 6);
    return formatDateInput(end);
  })();

  const resetClientForm = () => setClientForm(CLIENT_FORM_EMPTY);
  const resetSiteForm = () => setSiteForm(SITE_FORM_EMPTY);
  const resetJobForm = () => setJobForm(JOB_FORM_EMPTY);

  const handleSaveClient = async () => {
    let saveErrorMsg: string | null = null;
    try {
      setSavingClient(true);
      const payload: CreateClientPayload | UpdateClientPayload = {
        name: clientForm.name.trim(),
        contactName: clientForm.contactName.trim() || undefined,
        contactEmail: clientForm.contactEmail.trim() || undefined,
        contactPhone: clientForm.contactPhone.trim() || undefined,
        contactDetails: clientForm.notes.trim() || undefined,
        status: clientForm.status || 'active',
      };

      if (!payload.name) {
        throw new Error('Client name is required.');
      }

      if (clientForm.id) {
        await updateClient(clientForm.id, payload);
      } else {
        await createClient(payload as CreateClientPayload);
      }

      resetClientForm();
      await loadData(true);
    } catch (saveError) {
      saveErrorMsg = formatApiErrorMessage(saveError, 'Unable to save this client right now.');
    } finally {
      setSavingClient(false);
    }
    if (saveErrorMsg) throw new Error(saveErrorMsg);
  };

  const handleArchiveClient = async (client: Client) => {
    try {
      await updateClient(client.id, { status: 'archived' });
      await loadData(true);
    } catch (archiveError) {
      setError(formatApiErrorMessage(archiveError, 'Unable to archive this client right now.'));
    }
  };

  const handleSaveSite = async () => {
    try {
      setSavingSite(true);
      const selectedClientId = toNumber(siteForm.clientId);
      const trimmedSiteName = siteForm.name.trim();
      const trimmedAddress = siteForm.address.trim();
      const hasStarterShiftValue = Boolean(
        siteForm.initialShiftDate || siteForm.initialShiftStartTime || siteForm.initialShiftEndTime,
      );

      if (hasStarterShiftValue) {
        const starterValidationError = validateSameDayShiftTiming(
          siteForm.initialShiftDate,
          siteForm.initialShiftStartTime,
          siteForm.initialShiftEndTime,
        );
        if (starterValidationError) {
          throw new Error(`Starter planned shift: ${starterValidationError}`);
        }
      }

      const latStr    = siteForm.latitude.trim();
      const lonStr    = siteForm.longitude.trim();
      const radiusStr = siteForm.geofenceRadiusMeters.trim();

      const payload: CreateSitePayload | UpdateSitePayload = {
        clientId: selectedClientId,
        name: trimmedSiteName,
        address: trimmedAddress,
        contactDetails: siteForm.contactDetails.trim() || undefined,
        status: siteForm.status,
        requiredGuardCount: toNumber(siteForm.requiredGuardCount) || 1,
        operatingDays: siteForm.operatingDays.trim() || undefined,
        operatingStartTime: siteForm.operatingStartTime.trim() || undefined,
        operatingEndTime: siteForm.operatingEndTime.trim() || undefined,
        welfareCheckIntervalMinutes: toNumber(siteForm.checkCallIntervalMinutes) || 60,
        specialInstructions: siteForm.specialInstructions.trim() || undefined,
        latitude: latStr !== '' ? Number(latStr) : null,
        longitude: lonStr !== '' ? Number(lonStr) : null,
        geofenceRadiusMeters: radiusStr !== '' ? toNumber(radiusStr) : undefined,
        requireGpsCheckIn: siteForm.requireGpsCheckIn,
        timezone: siteForm.timezone.trim() || 'Europe/London',
        initialShiftDate: hasStarterShiftValue ? siteForm.initialShiftDate : undefined,
        initialShiftStartTime: hasStarterShiftValue ? siteForm.initialShiftStartTime : undefined,
        initialShiftEndTime: hasStarterShiftValue ? siteForm.initialShiftEndTime : undefined,
      };

      if (!payload.clientId || !payload.name || !payload.address) {
        throw new Error('Client, site name, and address are required.');
      }

      if (siteForm.id) {
        await updateSite(siteForm.id, payload);
      } else {
        await createSite(payload as CreateSitePayload);
      }

      resetSiteForm();
      await loadData(true);
    } catch (saveError) {
      throw new Error(formatApiErrorMessage(saveError, 'Unable to save this site right now.'));
    } finally {
      setSavingSite(false);
    }
  };

  const handleArchiveSite = async (site: Site) => {
    try {
      await updateSite(site.id, { status: 'archived' });
      await loadData(true);
    } catch (archiveError) {
      setError(formatApiErrorMessage(archiveError, 'Unable to archive this site right now.'));
    }
  };

  const handlePlanSite = (site: Site) => {
    setPlannerClientId(String(site.client?.id ?? site.clientId ?? ''));
    setPlannerSiteId(String(site.id));
    setActiveSection('rota-planner');
  };

  const handlePlannerPrevWeek = () => {
    setPlannerWeekCommencing(
      weekCommencingFor(
        formatDateInput(addDays(parseDateInput(plannerWeekCommencing) || new Date(`${plannerWeekCommencing}T00:00:00`), -7)),
      ),
    );
  };

  const handlePlannerNextWeek = () => {
    setPlannerWeekCommencing(
      weekCommencingFor(
        formatDateInput(addDays(parseDateInput(plannerWeekCommencing) || new Date(`${plannerWeekCommencing}T00:00:00`), 7)),
      ),
    );
  };

  const handlePlannerTodayWeek = () => {
    setPlannerWeekCommencing(weekCommencingFor());
  };

  // R4C1 — Load rota week data from backend
  React.useEffect(() => {
    if (activeSection !== 'rota-planner') return;
    let cancelled = false;
    setLoadingRota(true);
    setRotaError(null);
    const clientIdParam = plannerClientId ? Number(plannerClientId) : undefined;
    const siteIdsParam = plannerSiteId || undefined;
    getRotaWeek({
      weekCommencing: plannerWeekCommencing,
      clientId: clientIdParam,
      siteIds: siteIdsParam,
    })
      .then((data) => { if (!cancelled) { setRotaWeekData(data); setLoadingRota(false); } })
      .catch((err) => {
        if (!cancelled) {
          setRotaError(formatApiErrorMessage(err, 'Unable to load rota data.'));
          setLoadingRota(false);
        }
      });
    return () => { cancelled = true; };
  }, [activeSection, plannerWeekCommencing, plannerClientId, plannerSiteId, rotaLoadKey]);

  // R4C2 — Rota write callbacks (passed into CompanyRotaPlannerWorkspace)

  const handleRotaLoadSlot = React.useCallback((slotId: number): Promise<RotaSlotDetail> => {
    return getRotaSlot(slotId);
  }, []);

  const handleRotaCreateSlot = React.useCallback((data: RotaCreatePayload): Promise<RotaSlotDetail> => {
    return createRotaSlot(data);
  }, []);

  const handleRotaSaveEdits = React.useCallback(
    async (slotId: number, changes: RotaSlotChanges): Promise<RotaSlotDetail> => {
      const { startAt, endAt, requiredGuardCount, checkCallIntervalMinutes, title, instructions } = changes;
      let needsRefetch = false;
      let latest: RotaSlotDetail | null = null;

      if (startAt !== undefined && endAt !== undefined) {
        latest = await changeRotaSlotTime(slotId, startAt, endAt);
      }
      if (requiredGuardCount !== undefined) {
        await changeRotaSlotRequirement(slotId, requiredGuardCount);
        needsRefetch = true;
      }
      if (checkCallIntervalMinutes !== undefined) {
        latest = await changeRotaSlotCheckCall(slotId, checkCallIntervalMinutes);
      }
      if (title !== undefined || instructions !== undefined) {
        latest = await updateRotaSlotMetadata(slotId, {
          ...(title !== undefined ? { title } : {}),
          ...(instructions !== undefined ? { instructions } : {}),
        });
      }
      if (needsRefetch || !latest) {
        return getRotaSlot(slotId);
      }
      return latest;
    },
    [],
  );

  const handleRotaAssignPosition = React.useCallback(
    (slotId: number, shiftId: number, guardId: number): Promise<RotaSlotDetail> =>
      assignRotaSlotPosition(slotId, shiftId, guardId),
    [],
  );

  const handleRotaAssignMultiple = React.useCallback(
    async (
      slotId: number,
      assignments: Array<{ shiftId: number; guardId: number }>,
    ): Promise<{ result: RotaAssignMultipleResult; detail: RotaSlotDetail }> => {
      const result = await assignMultipleRotaSlotPositions(slotId, assignments);
      const detail = await getRotaSlot(slotId);
      return { result, detail };
    },
    [],
  );

  const handleRotaCancelPosition = React.useCallback(
    (slotId: number, shiftId: number): Promise<RotaSlotDetail> =>
      cancelRotaSlotPosition(slotId, shiftId),
    [],
  );

  const handleRotaCancelSlot = React.useCallback(async (slotId: number): Promise<void> => {
    await cancelRotaSlot(slotId);
  }, []);

  const handleRotaGetEligibleGuards = React.useCallback(
    (shiftId: number): Promise<EligibleGuardRow[]> => listEligibleGuardsForShift(shiftId),
    [],
  );

  const handleAddPlannerRow = (row: PlannerRow) => {
    setPlannerRows((current) => [...current, row]);
  };

  const handlePlannerRowChange = (localId: string, patch: Partial<PlannerRow>) => {
    setPlannerRows((current) =>
      current.map((row) => (row.localId === localId ? { ...row, ...patch } : row)),
    );
  };

  const handleRemovePlannerRow = (localId: string) => {
    setPlannerRows((current) => {
      const row = current.find((entry) => entry.localId === localId);
      if (row?.sourceShiftIds?.length) {
        setPlannerRemovedShiftIds((existing) => [...existing, ...row.sourceShiftIds]);
      }

      return current.filter((entry) => entry.localId !== localId);
    });
  };

  const copyPlannerToNextWeek = () => {
    const nextRows = plannerRows.map((row) => ({
      ...row,
      localId: `${row.localId}-copy-${Math.random().toString(36).slice(2, 8)}`,
      date: formatDateInput(addDays(parseDateInput(row.date) || new Date(`${row.date}T00:00:00`), 7)),
      sourceShiftIds: [],
    }));

    setPlannerWeekCommencing(
      weekCommencingFor(
        formatDateInput(
          addDays(parseDateInput(plannerWeekCommencing) || new Date(`${plannerWeekCommencing}T00:00:00`), 7),
        ),
      ),
    );
    setPlannerRows(nextRows);
    setPlannerRemovedShiftIds([]);
  };

  const deletePlannerShiftIfPresent = async (shiftId: number) => {
    try {
      await deleteShift(shiftId);
    } catch (shiftError) {
      if (shiftError instanceof ApiError && shiftError.status === 404) {
        return;
      }

      throw shiftError;
    }
  };

  const handleSaveRota = async () => {
    try {
      if (!plannerSite || !plannerSiteId) {
        throw new Error('Choose a site before saving the rota.');
      }

      setSavingRota(true);

      for (const shiftId of Array.from(new Set(plannerRemovedShiftIds))) {
        await deletePlannerShiftIfPresent(shiftId);
      }

      for (const row of plannerRows) {
        const validationError = validateSameDayShiftTiming(row.date, row.startTime, row.endTime);
        if (validationError) {
          throw new Error(`${formatDateLabel(row.date)}: ${validationError}`);
        }

        const guardsRequired = Math.max(1, toNumber(row.guardsRequired) || 1);
        const { startAt, endAt } = buildShiftDateTimes(row.date, row.startTime, row.endTime);
        const plannedStatus = normalizePlannerStatus(row.status, row.assignedGuardId);
        const existingIds = [...row.sourceShiftIds];

        for (let index = 0; index < guardsRequired; index += 1) {
          const assignedGuardId = index === 0 ? toNumber(row.assignedGuardId) ?? null : null;
          const payload: CreateShiftPayload & UpdateShiftPayload = {
            siteId: Number(plannerSiteId),
            guardId: assignedGuardId,
            start: startAt,
            end: endAt,
            status: assignedGuardId ? plannedStatus : plannedStatus === 'cancelled' ? 'cancelled' : 'unfilled',
            checkCallIntervalMinutes: plannerSite.welfareCheckIntervalMinutes || 60,
            instructions: row.instructions.trim() || undefined,
          };

          const existingId = existingIds.shift();
          if (existingId) {
            await updateShift(existingId, payload);
          } else {
            await createShift(payload);
          }
        }

        for (const extraId of existingIds) {
          await deletePlannerShiftIfPresent(extraId);
        }
      }

      setPlannerRemovedShiftIds([]);
      await loadData(true);
      setActiveSection('live-operations');
    } catch (saveError) {
      setError(formatApiErrorMessage(saveError, 'Unable to save this rota right now.'));
    } finally {
      setSavingRota(false);
    }
  };

  const handleCreateJob = async () => {
    try {
      setCreatingJob(true);
      const payload: CreateJobPayload = {
        title: jobForm.title.trim(),
        description: jobForm.description.trim() || undefined,
        guardsRequired: toNumber(jobForm.guardsRequired) || 1,
        hourlyRate: toNumber(jobForm.hourlyRate) || 12,
        billingRate: toNumber(jobForm.billingRate) ?? null,
        siteId: toNumber(jobForm.siteId),
      };

      if (!payload.title || !payload.siteId) {
        throw new Error('Job title and site are required.');
      }

      await createJob(payload);
      resetJobForm();
      await loadData(true);
    } catch (jobError) {
      setError(formatApiErrorMessage(jobError, 'Unable to create this recruitment job right now.'));
    } finally {
      setCreatingJob(false);
    }
  };

  const guardOnboardingMessage = (message: string) => {
    const compliancePrefix = 'Guard compliance invalid:';
    if (message.includes('Guard screening is not complete.')) {
      return 'Guard onboarding incomplete. Guard cannot yet be approved. The candidate must complete screening and authorised verification.';
    }
    return message.includes(compliancePrefix)
      ? `Guard onboarding incomplete. Guard cannot yet be approved. Outstanding candidate requirement: ${message.split(compliancePrefix)[1].trim()}`
      : message;
  };

  const handleApproveGuard = async (guardId: number) => {
    try {
      setApprovingGuardId(guardId);
      await approveGuard(guardId);
      await loadData(true);
    } catch (approveError) {
      const message = formatApiErrorMessage(approveError, 'Unable to link this guard right now.');
      setError(guardOnboardingMessage(message));
    } finally {
      setApprovingGuardId(null);
    }
  };

  const handleReviewApplication = async (
    applicationId: number,
    status: 'under_review' | 'accepted' | 'rejected',
  ) => {
    try {
      setReviewingApplicationId(applicationId);
      await reviewJobApplication(applicationId, { status });
      await loadData(true);
      if (status === 'accepted') {
        setActiveSection('guards');
      }
    } catch (reviewError) {
      setError(
        guardOnboardingMessage(formatApiErrorMessage(
          reviewError,
          status === 'accepted'
            ? 'Unable to accept this application right now.'
            : status === 'rejected'
              ? 'Unable to reject this application right now.'
              : 'Unable to update this application right now.',
        )),
      );
    } finally {
      setReviewingApplicationId(null);
    }
  };

  const recordManagementAction = (
    item: Omit<ManagementActionItem, 'id' | 'occurredAt'>,
  ) => {
    setManagementActions((current) => {
      const nowIso = new Date().toISOString();
      const existingRecentMatch = current.find((entry) => {
        const occurredMs = Date.parse(entry.occurredAt);
        const isRecent = Number.isFinite(occurredMs) && Date.now() - occurredMs < 60_000;
        return (
          isRecent &&
          entry.shiftId === item.shiftId &&
          entry.itemType === item.itemType &&
          entry.actionTaken === item.actionTaken
        );
      });

      if (existingRecentMatch) {
        return current;
      }

      return [
        {
          ...item,
          id: `management-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          occurredAt: nowIso,
        },
        ...current,
      ].slice(0, 12);
    });
  };

  const focusShiftInLiveBoard = (shiftId: number) => {
    setSelectedShiftId(shiftId);
    setActiveSection('live-operations');
    setHighlightedLiveShiftId(shiftId);

    if (liveBoardHighlightTimeoutId) {
      clearTimeout(liveBoardHighlightTimeoutId);
    }

    setTimeout(() => {
      if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        window.scrollTo({
          top: Math.max(liveBoardAnchorY - 24, 0),
          behavior: 'smooth',
        });
      }
    }, 0);

    const nextTimeoutId = setTimeout(() => {
      setHighlightedLiveShiftId((current) => (current === shiftId ? null : current));
    }, 2000);
    setLiveBoardHighlightTimeoutId(nextTimeoutId);
  };

  const focusShiftDetail = (shiftId: number) => {
    setSelectedShiftId(shiftId);
    setActiveSection('live-operations');
    setHighlightedLiveShiftId(shiftId);
    setPendingShiftDetailFocusId(shiftId);
  };

  React.useEffect(() => {
    if (
      activeSection !== 'live-operations' ||
      pendingShiftDetailFocusId === null ||
      selectedShiftId !== pendingShiftDetailFocusId ||
      shiftDetailAnchorY <= 0
    ) return;

    const timeoutId = setTimeout(() => {
      contentScrollRef.current?.scrollTo({ y: Math.max(shiftDetailAnchorY - 24, 0), animated: true });
      setPendingShiftDetailFocusId(null);
    }, 50);
    return () => clearTimeout(timeoutId);
  }, [activeSection, pendingShiftDetailFocusId, selectedShiftId, shiftDetailAnchorY]);

  const openCoverage = (context: CoverageNavigationContext = {}) => {
    setCoverageNavigationContext(context);
    setActiveSection('coverage');
  };

  const handleCancelShiftOffer = async (shiftId: number) => {
    try {
      setOfferActionShiftId(shiftId);
      setShiftOffersFeedback(null);
      const shift = shifts.find((entry) => entry.id === shiftId) ?? null;
      await updateShift(shiftId, { status: 'cancelled' });
      await loadData(true);
      recordManagementAction({
        shiftId,
        siteName: shift?.site?.name || shift?.siteName || 'Unknown site',
        guardName: shift?.guard?.fullName || 'Unassigned',
        itemType: 'Shift offer',
        actionTaken: 'Shift offer withdrawn',
      });
      setShiftOffersFeedback({
        tone: 'success',
        message: `Shift #${shiftId} was withdrawn successfully and is no longer pending a guard response.`,
      });
    } catch (shiftError) {
      setError(formatApiErrorMessage(shiftError, 'Unable to cancel this shift offer right now.'));
      setShiftOffersFeedback({
        tone: 'error',
        message: formatApiErrorMessage(shiftError, 'Unable to withdraw this shift offer right now.'),
      });
    } finally {
      setOfferActionShiftId(null);
    }
  };

  const handleReofferShift = async (shiftId: number) => {
    const nextGuardId = toNumber(reassignGuardByShiftId[shiftId]);

    if (!nextGuardId) {
      setError('Choose a replacement guard before re-offering this shift.');
      setShiftOffersFeedback({
        tone: 'error',
        message: 'Choose a replacement guard before re-offering this shift.',
      });
      return;
    }

    try {
      setOfferActionShiftId(shiftId);
      setShiftOffersFeedback(null);
      const shift = shifts.find((entry) => entry.id === shiftId) ?? null;
      const replacementGuardName = linkedGuardNameById.get(nextGuardId) || `Guard #${nextGuardId}`;
      await updateShift(shiftId, { guardId: nextGuardId });
      setReassignGuardByShiftId((current) => ({ ...current, [shiftId]: '' }));
      await loadData(true);
      recordManagementAction({
        shiftId,
        siteName: shift?.site?.name || shift?.siteName || 'Unknown site',
        guardName: replacementGuardName,
        itemType: 'Rejected shift',
        actionTaken: `Shift re-offered to ${replacementGuardName}`,
      });
      setShiftOffersFeedback({
        tone: 'success',
        message: `Shift #${shiftId} was re-offered to ${replacementGuardName} and is now back in offered status.`,
      });
    } catch (shiftError) {
      setError(formatApiErrorMessage(shiftError, 'Unable to re-offer this shift right now.'));
      setShiftOffersFeedback({
        tone: 'error',
        message: formatApiErrorMessage(shiftError, 'Unable to re-offer this shift right now.'),
      });
    } finally {
      setOfferActionShiftId(null);
    }
  };

  const handleOpenUrgentShift = (item: UrgentOperationalItem) => {
    if (!item.shiftId) {
      setLiveOperationsFeedback({
        tone: 'error',
        message: `No linked shift is available for "${item.issueType}".`,
      });
      return;
    }

    focusShiftInLiveBoard(item.shiftId);
    setLiveOperationsFeedback({
      tone: 'success',
      message: `Opening Shift #${item.shiftId} for ${item.issueType.toLowerCase()}.`,
    });
  };

  const handleOpenUrgentDetail = (item: UrgentOperationalItem) => {
    if (item.category === 'uncovered_shift') {
      openCoverage({ uncoveredOnly: true, shiftId: item.shiftId });
      return;
    }

    if (item.category === 'rejected_offer' || item.category === 'missed_shift') {
      if (item.shiftId) {
        setSelectedShiftId(item.shiftId);
      }
      setShiftOffersFeedback({
        tone: 'success',
        message: item.shiftId
          ? `Shift #${item.shiftId} is ready for re-cover in Shift Offers.`
          : 'Open Shift Offers to re-cover this shift.',
      });
      setActiveSection('shift-offers');
      return;
    }

    if (!item.shiftId) {
      setLiveOperationsFeedback({
        tone: 'error',
        message: `No linked shift is available for "${item.issueType}".`,
      });
      return;
    }

    focusShiftInLiveBoard(item.shiftId);

    if (item.category === 'incident') {
      setActiveSection('incidents');
      setLiveOperationsFeedback({
        tone: 'success',
        message: `Opening incident review for Shift #${item.shiftId}.`,
      });
      return;
    }

    if (item.category === 'panic' || item.category === 'missed_check_call' || item.category === 'safety') {
      setActiveSection('alerts');
      setLiveOperationsFeedback({
        tone: 'success',
        message: `Opening safety review for Shift #${item.shiftId}.`,
      });
      return;
    }

    setActiveSection('live-operations');
    setLiveOperationsFeedback({
      tone: 'success',
      message: `Opening Shift #${item.shiftId} in Live Operations.`,
    });
  };

  const handleLiveBoardPrimaryAction = (shift: Shift) => {
    const lifecycleStatus = normalizeShiftLifecycleStatus(shift.status);

    if (lifecycleStatus === 'offered') {
      setSelectedShiftId(shift.id);
      setActiveSection('shift-offers');
      setShiftOffersFeedback({
        tone: 'success',
        message: `Viewing offer details for Shift #${shift.id}.`,
      });
      return;
    }

    if (['rejected', 'missed'].includes(lifecycleStatus)) {
      setSelectedShiftId(shift.id);
      setActiveSection('shift-offers');
      setShiftOffersFeedback({
        tone: 'success',
        message:
          lifecycleStatus === 'missed'
            ? `Shift #${shift.id} missed check-in and is ready for re-cover.`
            : `Shift #${shift.id} is ready to be re-offered.`,
      });
      return;
    }

    focusShiftDetail(shift.id);
    setLiveOperationsFeedback({
      tone: 'success',
      message:
        lifecycleStatus === 'ready'
          ? `Opening Shift #${shift.id}.`
          : lifecycleStatus === 'in_progress'
            ? `Monitoring live Shift #${shift.id}.`
            : lifecycleStatus === 'missed'
              ? `Reviewing missed Shift #${shift.id}.`
            : `Reviewing Shift #${shift.id}.`,
    });
  };

  const handleUrgentIncidentFollowUp = async (
    item: UrgentOperationalItem,
    nextStatus: 'in_review' | 'resolved',
  ) => {
    if (!item.incidentId) {
      setLiveOperationsFeedback({
        tone: 'error',
        message: 'No incident is linked to this urgent item.',
      });
      return;
    }

    try {
      setUrgentActionItemId(item.id);
      if (item.shiftId) {
        setSelectedShiftId(item.shiftId);
      }
      await updateIncidentStatus(item.incidentId, nextStatus);
      await loadData(true);
      recordManagementAction({
        shiftId: item.shiftId,
        siteName: item.siteName,
        guardName: item.guardName,
        itemType: 'Incident',
        actionTaken:
          nextStatus === 'in_review' ? 'Incident acknowledged' : 'Incident resolved',
      });
      setLiveOperationsFeedback({
        tone: 'success',
        message:
          nextStatus === 'in_review'
            ? `Incident #${item.incidentId} was acknowledged and moved to in review.`
            : `Incident #${item.incidentId} was resolved successfully.`,
      });
    } catch (followUpError) {
      setError(formatApiErrorMessage(followUpError, 'Unable to update this incident right now.'));
      setLiveOperationsFeedback({
        tone: 'error',
        message: formatApiErrorMessage(followUpError, 'Unable to update this incident right now.'),
      });
    } finally {
      setUrgentActionItemId(null);
    }
  };

  const handleUrgentAlertFollowUp = async (
    item: UrgentOperationalItem,
    action: 'acknowledge' | 'close',
  ) => {
    if (!item.alertId) {
      setLiveOperationsFeedback({
        tone: 'error',
        message: 'No safety alert is linked to this urgent item.',
      });
      return;
    }

    try {
      setUrgentActionItemId(item.id);
      if (item.shiftId) {
        setSelectedShiftId(item.shiftId);
      }
      if (action === 'acknowledge') {
        await acknowledgeSafetyAlert(item.alertId);
      } else {
        await closeSafetyAlert(item.alertId);
      }
      await loadData(true);
      recordManagementAction({
        shiftId: item.shiftId,
        siteName: item.siteName,
        guardName: item.guardName,
        itemType:
          item.category === 'panic'
            ? 'Panic alert'
            : item.category === 'missed_check_call'
              ? 'Missed check call'
              : 'Safety alert',
        actionTaken:
          action === 'acknowledge'
            ? item.category === 'panic'
              ? 'Panic alert escalated'
              : item.category === 'missed_check_call'
                ? 'Missed check call followed up'
                : 'Safety alert acknowledged'
            : item.category === 'panic'
              ? 'Panic alert resolved'
              : item.category === 'missed_check_call'
                ? 'Missed check call closed'
                : 'Safety alert closed',
      });
      setLiveOperationsFeedback({
        tone: 'success',
        message:
          action === 'acknowledge'
            ? `${
                item.category === 'panic'
                  ? 'Panic alert'
                  : item.category === 'missed_check_call'
                    ? 'Missed check call'
                    : 'Safety alert'
              } was marked for follow-up.`
            : `${
                item.category === 'panic'
                  ? 'Panic alert'
                  : item.category === 'missed_check_call'
                    ? 'Missed check call'
                    : 'Safety alert'
              } was closed successfully.`,
      });
    } catch (followUpError) {
      setError(formatApiErrorMessage(followUpError, 'Unable to update this safety item right now.'));
      setLiveOperationsFeedback({
        tone: 'error',
        message: formatApiErrorMessage(followUpError, 'Unable to update this safety item right now.'),
      });
    } finally {
      setUrgentActionItemId(null);
    }
  };

  const handleSaveCloseOutNotes = async () => {
    if (!selectedShift) {
      setLiveOperationsFeedback({
        tone: 'error',
        message: 'Choose a shift before saving close-out notes.',
      });
      return;
    }

    try {
      setSavingCloseOutNotes(true);
      const nextNotes = closeOutNotesDraft.trim();
      await updateShift(selectedShift.id, {
        closeOutNotes: nextNotes || null,
      });
      await loadData(true);
      setLiveOperationsFeedback({
        tone: 'success',
        message: nextNotes
          ? `Close-out notes saved for Shift #${selectedShift.id}.`
          : `Close-out notes cleared for Shift #${selectedShift.id}.`,
      });
    } catch (notesError) {
      setError(formatApiErrorMessage(notesError, 'Unable to save close-out notes right now.'));
      setLiveOperationsFeedback({
        tone: 'error',
        message: formatApiErrorMessage(notesError, 'Unable to save close-out notes right now.'),
      });
    } finally {
      setSavingCloseOutNotes(false);
    }
  };

  const liveOperationRows = React.useMemo(() => {
    const priority = { high: 3, medium: 2, low: 1 };

    return shifts
      .filter((shift) => {
        const clientId = String(shift.site?.client?.id ?? shift.site?.clientId ?? '');
        const siteId = String(shift.site?.id ?? shift.siteId ?? '');
        const guardId = String(shift.guard?.id ?? shift.guardId ?? '');
        const date = shift.start.slice(0, 10);
        const status = (shift.status || '').toLowerCase();

        return (
          (!liveFilters.clientId || clientId === liveFilters.clientId) &&
          (!liveFilters.siteId || siteId === liveFilters.siteId) &&
          (!liveFilters.guardId || guardId === liveFilters.guardId) &&
          (!liveFilters.date || date === liveFilters.date) &&
          (!liveFilters.status || status === liveFilters.status.toLowerCase())
        );
      })
      .sort((left, right) => {
        const riskA = getShiftRisk(
          left,
          attendanceByShiftId.get(left.id),
          incidentsByShiftId.get(left.id) || [],
          alertsByShiftId.get(left.id) || [],
        );
        const riskB = getShiftRisk(
          right,
          attendanceByShiftId.get(right.id),
          incidentsByShiftId.get(right.id) || [],
          alertsByShiftId.get(right.id) || [],
        );

        const priorityDelta = priority[riskB.level] - priority[riskA.level];
        if (priorityDelta !== 0) {
          return priorityDelta;
        }

        const delayA = getShiftDelay(left, attendanceByShiftId.get(left.id)) || 0;
        const delayB = getShiftDelay(right, attendanceByShiftId.get(right.id)) || 0;
        if (delayB !== delayA) {
          return delayB - delayA;
        }

        return right.start.localeCompare(left.start);
      });
  }, [alertsByShiftId, attendanceByShiftId, incidentsByShiftId, liveFilters, shifts]);
  const guardsNotBookedOn = React.useMemo(
    () =>
      liveOperationRows.filter((shift) => {
        const attendance = attendanceByShiftId.get(shift.id);
        return ['ready'].includes(normalizeShiftLifecycleStatus(shift.status)) && !attendance?.checkInAt;
      }),
    [liveOperationRows, attendanceByShiftId],
  );

  const liveOperationEnrichedRows: LiveBoardRow[] = React.useMemo(
    () =>
      liveOperationRows.map((shift) => {
        const timesheet = timesheetByShiftId.get(shift.id);
        const attendance = attendanceByShiftId.get(shift.id);
        const shiftLogs = logsByShiftId.get(shift.id) || [];
        const shiftIncidents = incidentsByShiftId.get(shift.id) || [];
        const shiftAlerts = alertsByShiftId.get(shift.id) || [];
        const lastCheckCall = lastCheckCallByShiftId.get(shift.id);
        const panicOrWelfareCount = shiftAlerts.filter((a) =>
          ['panic', 'welfare', 'late_checkin'].includes((a.type || '').toLowerCase()),
        ).length;
        const lifecycleStatus = normalizeShiftLifecycleStatus(shift.status);
        const risk = getShiftRisk(shift, attendance, shiftIncidents, shiftAlerts);
        const delay = getShiftDelay(shift, attendance);
        const likelyLate = isLikelyToMissCheckIn(shift, attendance);
        const siteRiskLabel = getSiteRiskLevel(
          shift.site?.id ?? shift.siteId,
          shifts,
          attendanceByShiftId,
          incidentsByShiftId,
          alertsByShiftId,
        );
        const primaryActionLabel =
          lifecycleStatus === 'offered' ? 'View Offer' :
          lifecycleStatus === 'ready' ? 'Open Shift' :
          lifecycleStatus === 'in_progress' ? 'Monitor' :
          lifecycleStatus === 'missed' ? 'Re-cover' :
          lifecycleStatus === 'rejected' ? 'Re-offer' : 'Review Shift';
        const rowTone = getLiveShiftBoardRowTone(lifecycleStatus, risk.level);
        return {
          shift, timesheet, attendance, shiftLogs, shiftIncidents, shiftAlerts, lastCheckCall,
          panicOrWelfareCount, lifecycleStatus, risk, delay, likelyLate, siteRiskLabel, primaryActionLabel, rowTone,
        };
      }),
    [
      liveOperationRows, timesheetByShiftId, attendanceByShiftId, logsByShiftId,
      incidentsByShiftId, alertsByShiftId, lastCheckCallByShiftId, shifts,
    ],
  );

  const selectedShiftContext: SelectedShiftContext | null = React.useMemo(() => {
    if (!selectedShift) return null;
    const attendance = attendanceByShiftId.get(selectedShift.id);
    const timesheet = timesheetByShiftId.get(selectedShift.id);
    const logs = logsByShiftId.get(selectedShift.id) || [];
    const incidents = incidentsByShiftId.get(selectedShift.id) || [];
    const alerts = alertsByShiftId.get(selectedShift.id) || [];
    const lifecycleStatus = normalizeShiftLifecycleStatus(selectedShift.status);
    const badge = lifecycleStatus === 'missed'
      ? { icon: '⚠️', label: 'Missed', color: colors.warning }
      : getShiftStatusBadge(selectedShift.status || 'unfilled');
    const exception = getShiftExceptionSummary(selectedShift.status);
    const clientName =
      selectedShift.site?.client?.name ||
      clientMap.get(selectedShift.site?.clientId || 0)?.name ||
      'No client';
    return { shift: selectedShift, attendance, timesheet, logs, incidents, alerts, lifecycleStatus, badge, exception, clientName };
  }, [selectedShift, attendanceByShiftId, timesheetByShiftId, logsByShiftId, incidentsByShiftId, alertsByShiftId, clientMap]);

  const liveOperationsKpis = React.useMemo(
    () =>
      [
        {
          label: 'Live Shifts',
          value: String(liveShifts.length),
          icon: '🟢',
          tone: (liveShifts.length > 0 ? 'good' : 'neutral') as KpiTone,
        },
        {
          label: 'Guards Not Booked On',
          value: String(guardsNotBookedOn.length),
          icon: '🚪',
          tone: (guardsNotBookedOn.length > 0 ? 'warning' : 'good') as KpiTone,
        },
        {
          label: 'Open Incidents',
          value: String(openIncidents.length),
          icon: '🚨',
          tone: (openIncidents.length > 0 ? 'attention' : 'good') as KpiTone,
        },
        {
          label: 'Missed Check Calls',
          value: String(missedCheckCalls.length),
          icon: '📞',
          tone: (missedCheckCalls.length > 0 ? 'warning' : 'good') as KpiTone,
        },
        {
          label: 'Active Panic Alerts',
          value: String(activePanicAlerts.length),
          icon: '🆘',
          tone: (activePanicAlerts.length > 0 ? 'attention' : 'good') as KpiTone,
        },
        {
          label: 'Pending Timesheets',
          value: String(pendingTimesheets.length),
          icon: '⏱️',
          tone: (pendingTimesheets.length > 0 ? 'warning' : 'good') as KpiTone,
        },
      ] as const,
    [
      activePanicAlerts.length,
      guardsNotBookedOn.length,
      liveShifts.length,
      missedCheckCalls.length,
      openIncidents.length,
      pendingTimesheets.length,
    ],
  );

  const applicationShiftSummaryById = React.useMemo(() => {
    const map = new Map<
      number,
      {
        status: string;
        siteName: string;
        start: string;
      } | null
    >();

    applications.forEach((application) => {
      const assignmentShiftCandidates =
        application.assignments?.flatMap((assignment) => assignment.shifts || []) || [];
      const fallbackShiftCandidates = shifts.filter((shift) => {
        const sameGuard = (shift.guard?.id ?? shift.guardId) === application.guardId;
        const shiftCompanyId = shift.company?.id ?? shift.companyId ?? shift.assignment?.companyId;
        const applicationCompanyId = application.job?.company?.id ?? application.job?.companyId;
        return sameGuard && Boolean(applicationCompanyId) && shiftCompanyId === applicationCompanyId;
      });

      const latestShift =
        [...assignmentShiftCandidates, ...fallbackShiftCandidates]
          .sort((left, right) => right.start.localeCompare(left.start))[0] || null;

      map.set(
        application.id,
        latestShift
          ? {
              status: latestShift.status,
              siteName: latestShift.site?.name || latestShift.siteName || 'Site TBD',
              start: latestShift.start,
            }
          : null,
      );
    });

    return map;
  }, [applications, shifts]);

  const acceptedApplications = React.useMemo(
    () => applications.filter((application) => application.status === 'accepted'),
    [applications],
  );

  const renderTableHeader = (columns: string[]) => (
    <View style={styles.tableHeader}>
      {columns.map((column) => (
        <Text key={column} style={styles.tableHeaderText}>
          {column}
        </Text>
      ))}
    </View>
  );

  const dashboardKpis = React.useMemo(() => {
    const kpis: Array<{
      label: string;
      value: number;
      icon: string;
      tone: KpiTone;
      coverageContext?: CoverageNavigationContext;
    }> = [
      { label: 'Active Clients', value: activeClients.length, icon: '🏢', tone: activeClients.length > 0 ? 'good' : 'neutral' },
      { label: 'Active Sites', value: activeSites.length, icon: '📍', tone: activeSites.length > 0 ? 'good' : 'neutral' },
      { label: 'Linked Guards', value: linkedGuards.length, icon: '🛡️', tone: linkedGuards.length > 0 ? 'good' : 'neutral' },
      { label: 'Shifts Today', value: shiftsToday.length, icon: '🗓️', tone: 'neutral' },
      { label: 'Live Shifts', value: liveShifts.length, icon: '🟢', tone: liveShifts.length > 0 ? 'good' : 'neutral' },
      { label: 'Pending Timesheets', value: pendingTimesheets.length, icon: '⏱️', tone: pendingTimesheets.length > 0 ? 'warning' : 'good' },
      { label: 'Open Incidents', value: openIncidents.length, icon: '🚨', tone: openIncidents.length > 0 ? 'attention' : 'good' },
      { label: 'Alerts', value: outstandingAlerts.length, icon: '🔔', tone: outstandingAlerts.length > 0 ? 'attention' : 'good' },
      { label: 'Uncovered Shifts', value: uncoveredShifts.length, icon: '⚠️', tone: uncoveredShifts.length > 0 ? 'attention' : 'good', coverageContext: { uncoveredOnly: true } },
      {
        label: 'Sites With Coverage Gaps',
        value: new Set(uncoveredShifts.map((shift) => shift.siteId).filter((siteId) => siteId != null)).size,
        icon: '📍',
        tone: uncoveredShifts.length > 0 ? 'warning' : 'good',
        coverageContext: { uncoveredOnly: true },
      },
    ];
    return kpis;
  }, [
    activeClients.length,
    activeSites.length,
    linkedGuards.length,
    liveShifts.length,
    openIncidents.length,
    outstandingAlerts.length,
    pendingTimesheets.length,
    shiftsToday.length,
    uncoveredShifts,
  ]);

  const actionRequiredRows = React.useMemo(() => {
    const payrollCount = pendingPayrollTimesheets.length;
    const invoiceCount = pendingInvoiceTimesheets.length;
    const overdueCount = overdueReviewTimesheets.length;

    return [
      {
        key: 'payroll',
        title: 'Payroll batches',
        description: 'Approved unpaid rows ready for payroll suggestions.',
        count: payrollCount,
        countLabel: `${payrollCount} row(s)`,
        target: 'payroll' as CompanySection,
        tone: payrollCount > 0 ? ('attention' as const) : ('good' as const),
      },
      {
        key: 'invoices',
        title: 'Invoice batches',
        description: 'Approved uninvoiced rows ready for invoice suggestions.',
        count: invoiceCount,
        countLabel: `${invoiceCount} row(s)`,
        target: 'invoices' as CompanySection,
        tone: invoiceCount > 0 ? ('attention' as const) : ('good' as const),
      },
      {
        key: 'timesheets',
        title: 'Overdue reviews',
        description: 'Submitted timesheets older than 24 hours.',
        count: overdueCount,
        countLabel: `${overdueCount} row(s)`,
        target: 'timesheets' as CompanySection,
        tone: overdueCount > 0 ? ('warning' as const) : ('good' as const),
      },
    ];
  }, [overdueReviewTimesheets.length, pendingInvoiceTimesheets.length, pendingPayrollTimesheets.length]);

  const actionRequiredTotal = React.useMemo(
    () => actionRequiredRows.reduce((sum, row) => sum + row.count, 0),
    [actionRequiredRows],
  );

  const dashComplianceCounts = React.useMemo(() => ({
    valid:    complianceRecords.filter((r) => (r.status || '').toLowerCase() === 'valid').length,
    expiring: complianceRecords.filter((r) => (r.status || '').toLowerCase() === 'expiring').length,
    expired:  complianceRecords.filter((r) => (r.status || '').toLowerCase() === 'expired').length,
  }), [complianceRecords]);

  const upcomingShifts = React.useMemo(() => {
    const nowIso = new Date().toISOString();
    return shifts
      .filter((s) => s.start > nowIso && !['completed', 'cancelled'].includes(normalizeShiftLifecycleStatus(s.status)))
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, 6);
  }, [shifts]);

  const renderDashboardSection = () => {
    const coverageGapCount = uncoveredShifts.length;
    const coverageGapSites = new Set(uncoveredShifts.map((s) => s.siteId).filter(Boolean)).size;

    return (
      <View style={styles.sectionStack}>

        {/* ── ROW 1: OPERATIONAL KPI STRIP ── */}
        <View style={styles.dashKpiStrip}>
          <View style={styles.dashKpiStripCell}>
            <KpiCard
              label="Active Sites"
              value={String(activeSites.length)}
              icon="📍"
              tone={activeSites.length > 0 ? 'good' : 'neutral'}
              onPress={() => setActiveSection('sites')}
            />
          </View>
          <View style={styles.dashKpiStripCell}>
            <KpiCard
              label="Live Shifts"
              value={String(liveShifts.length)}
              icon="🟢"
              tone={liveShifts.length > 0 ? 'good' : 'neutral'}
              onPress={() => setActiveSection('live-operations')}
            />
          </View>
          <View style={styles.dashKpiStripCell}>
            <KpiCard
              label="Coverage Gaps"
              value={String(coverageGapCount)}
              icon="⚠️"
              tone={coverageGapCount > 0 ? 'attention' : 'good'}
              onPress={() => openCoverage({ uncoveredOnly: true })}
            />
          </View>
          <View style={styles.dashKpiStripCell}>
            <KpiCard
              label="Open Incidents"
              value={String(openIncidents.length)}
              icon="🚨"
              tone={openIncidents.length > 0 ? 'attention' : 'good'}
              onPress={() => setActiveSection('incidents')}
            />
          </View>
          <View style={styles.dashKpiStripCell}>
            <KpiCard
              label="Alerts"
              value={String(outstandingAlerts.length)}
              icon="🔔"
              tone={outstandingAlerts.length > 0 ? 'attention' : 'good'}
              onPress={() => setActiveSection('live-operations')}
            />
          </View>
        </View>

        {/* ── ROW 2: ATTENTION REQUIRED ── */}
        <View style={styles.dashAttentionPanel}>
          <View style={styles.dashAttentionHeader}>
            <Text style={styles.dashAttentionTitle}>
              {urgentOperationalItems.length > 0 ? 'Attention Required' : 'All Clear'}
            </Text>
            <Text style={styles.dashAttentionSubtitle}>
              {urgentOperationalItems.length > 0
                ? `${urgentOperationalItems.length} item${urgentOperationalItems.length !== 1 ? 's' : ''} requiring action.`
                : 'No operational conditions require immediate attention right now.'}
            </Text>
          </View>
          {urgentOperationalItems.length === 0 ? (
            <View style={styles.dashAttentionEmpty}>
              <Text style={styles.dashAttentionEmptyText}>Operational position is clear.</Text>
            </View>
          ) : (
            <>
              {urgentOperationalItems.slice(0, 5).map((item, index, arr) => {
                const severity = getAttentionSeverity(item.category);
                return (
                  <Pressable
                    key={item.id}
                    onPress={() => handleOpenUrgentDetail(item)}
                    accessibilityRole="button"
                    accessibilityLabel={item.issueType}
                    style={({ hovered, pressed }: any) => [
                      styles.dashAttentionItem,
                      index === arr.length - 1 && urgentOperationalItems.length <= 5 ? styles.dashAttentionItemLast : null,
                      hovered ? styles.dashAttentionItemHover : null,
                      pressed ? styles.dashAttentionItemPressed : null,
                      IS_WEB ? (WEB_POINTER_STYLE as any) : null,
                    ]}
                  >
                    <View
                      style={[
                        styles.dashAttentionBar,
                        severity === 'red' ? styles.dashAttentionBarRed
                          : severity === 'amber' ? styles.dashAttentionBarAmber
                          : styles.dashAttentionBarBlue,
                      ]}
                    />
                    <View style={styles.dashAttentionItemBody}>
                      <Text style={styles.dashAttentionItemLabel} numberOfLines={1}>{item.issueType}</Text>
                      <Text style={styles.dashAttentionItemMeta} numberOfLines={1}>
                        {item.siteName}{item.guardName && item.guardName !== 'Unknown guard' ? ` · ${item.guardName}` : ''}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.dashAttentionSeverityBadge,
                        severity === 'red' ? styles.dashAttentionSeverityRed
                          : severity === 'amber' ? styles.dashAttentionSeverityAmber
                          : styles.dashAttentionSeverityBlue,
                      ]}
                    >
                      <Text
                        style={[
                          styles.dashAttentionSeverityText,
                          severity === 'red' ? styles.dashAttentionSeverityTextRed
                            : severity === 'amber' ? styles.dashAttentionSeverityTextAmber
                            : styles.dashAttentionSeverityTextBlue,
                        ]}
                      >
                        {getAttentionBadgeLabel(item.category)}
                      </Text>
                    </View>
                    <Text style={styles.dashAttentionCta}>{'→'}</Text>
                  </Pressable>
                );
              })}
              {urgentOperationalItems.length > 5 ? (
                <Pressable
                  onPress={() => setActiveSection('live-operations')}
                  accessibilityRole="button"
                  style={({ hovered, pressed }: any) => [
                    styles.dashAttentionViewAll,
                    hovered ? styles.dashAttentionItemHover : null,
                    pressed ? styles.dashAttentionItemPressed : null,
                    IS_WEB ? (WEB_POINTER_STYLE as any) : null,
                  ]}
                >
                  <Text style={styles.dashAttentionViewAllText}>
                    {`View all ${urgentOperationalItems.length} attention items  →`}
                  </Text>
                </Pressable>
              ) : null}
            </>
          )}
        </View>

        {/* ── ROW 3: LIVE OPERATIONS (2/3) + TODAY'S COVERAGE (1/3) ── */}
        <View style={styles.dashRow3}>
          <View style={styles.dashRow3Main}>
            <Card
              style={styles.dashLivePanelCard}
              webSurfaceHover
              title="Live Operations"
              subtitle="Guards on duty right now. Tap a row to open the monitoring board."
            >
              {liveShifts.length === 0 ? (
                <DashboardPanelEmpty
                  title="No live shifts right now"
                  description="When guards are on duty they appear here for rapid monitoring access."
                  actionLabel="Open Live Operations"
                  onAction={() => setActiveSection('live-operations')}
                />
              ) : (
                liveShifts.slice(0, 8).map((shift, index, arr) => (
                  <Pressable
                    key={shift.id}
                    style={({ hovered, pressed }: any) => [
                      styles.dashListRow,
                      IS_WEB ? styles.dashListRowWeb : null,
                      index === arr.length - 1 ? styles.dashListRowLast : null,
                      hovered ? styles.dashListRowHovered : null,
                      hovered && IS_WEB ? styles.dashListRowWebHover : null,
                      pressed ? styles.dashListRowPressed : null,
                      IS_WEB ? (WEB_POINTER_STYLE as any) : null,
                    ]}
                    onPress={() => {
                      setSelectedShiftId(shift.id);
                      setActiveSection('live-operations');
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`${shift.site?.name || shift.siteName} — open in Live Operations`}
                  >
                    <View style={styles.dashLiveRowInner}>
                      <View style={styles.dashLiveRowLeft}>
                        <Text style={styles.dashListRowTitle} numberOfLines={1}>{shift.site?.name || shift.siteName}</Text>
                        <Text style={styles.dashListRowMeta}>
                          {formatTimeLabel(shift.start)}–{formatTimeLabel(shift.end)}
                        </Text>
                      </View>
                      <Text style={styles.dashLiveRowStatus} numberOfLines={1}>
                        {formatStatusLabel(normalizeShiftLifecycleStatus(shift.status))}
                      </Text>
                    </View>
                  </Pressable>
                ))
              )}
            </Card>
          </View>

          <View style={styles.dashRow3Side}>
            <Card
              style={styles.dashLivePanelCard}
              webSurfaceHover
              title="Today's Coverage"
              subtitle="Shift coverage position right now."
              tone={coverageGapCount > 0 ? 'warning' : 'default'}
            >
              <View style={styles.dashCoverageStats}>
                <View style={styles.dashCoverageStat}>
                  <Text style={styles.dashCoverageStatValue}>{liveShifts.length}</Text>
                  <Text style={styles.dashCoverageStatLabel}>Live now</Text>
                </View>
                <View style={styles.dashCoverageDivider} />
                <View style={styles.dashCoverageStat}>
                  <Text style={[styles.dashCoverageStatValue, coverageGapCount > 0 ? styles.dashCoverageStatValueWarn : null]}>
                    {coverageGapCount}
                  </Text>
                  <Text style={styles.dashCoverageStatLabel}>Uncovered</Text>
                </View>
                <View style={styles.dashCoverageDivider} />
                <View style={styles.dashCoverageStat}>
                  <Text style={[styles.dashCoverageStatValue, coverageGapSites > 0 ? styles.dashCoverageStatValueWarn : null]}>
                    {coverageGapSites}
                  </Text>
                  <Text style={styles.dashCoverageStatLabel}>Gap sites</Text>
                </View>
              </View>
              {coverageGapCount > 0 ? (
                <Pressable
                  onPress={() => openCoverage({ uncoveredOnly: true })}
                  accessibilityRole="button"
                  style={({ hovered, pressed }: any) => [
                    styles.dashCoverageAction,
                    hovered ? styles.dashCoverageActionHover : null,
                    pressed ? styles.dashCoverageActionPressed : null,
                    IS_WEB ? (WEB_POINTER_STYLE as any) : null,
                  ]}
                >
                  <Text style={styles.dashCoverageActionText}>Review coverage gaps →</Text>
                </Pressable>
              ) : (
                <DashboardPanelEmpty
                  title="Coverage looks good"
                  description="No uncovered shifts detected at this time."
                />
              )}
            </Card>
          </View>
        </View>

        {/* ── ROW 4: RECENT ACTIVITY + COMPLIANCE OVERVIEW + UPCOMING SHIFTS ── */}
        <View style={styles.dashRow4}>
          <View style={styles.dashRow4Cell}>
            <Card
              style={styles.dashLivePanelCard}
              webSurfaceHover
              title="Recent Activity"
              subtitle="Latest operational events and shift updates."
            >
              {recentOperationalActivity.length === 0 ? (
                <DashboardPanelEmpty
                  title="No recent activity"
                  description="Shift events and operational updates appear here as they occur."
                />
              ) : (
                recentOperationalActivity.slice(0, 6).map((activity, index, arr) => (
                  <View
                    key={activity.id}
                    style={[
                      styles.dashListRow,
                      IS_WEB ? styles.dashListRowWeb : null,
                      index === arr.length - 1 ? styles.dashListRowLast : null,
                    ]}
                  >
                    <Text style={styles.dashListRowTitle} numberOfLines={1}>{activity.eventType}</Text>
                    <Text style={styles.dashListRowMeta} numberOfLines={1}>
                      {activity.siteName} · {formatDateTimeLabel(activity.occurredAt)}
                    </Text>
                  </View>
                ))
              )}
            </Card>
          </View>

          <View style={styles.dashRow4Cell}>
            <Card
              style={styles.dashLivePanelCard}
              webSurfaceHover
              title="Compliance Overview"
              subtitle="Guard document and certification status."
              tone={dashComplianceCounts.expired > 0 ? 'danger' : dashComplianceCounts.expiring > 0 ? 'warning' : 'default'}
            >
              {complianceRecords.length === 0 ? (
                <DashboardPanelEmpty
                  title="No compliance records"
                  description="Guard certifications and documents appear here once guards are linked to your company."
                  actionLabel="View compliance"
                  onAction={() => setActiveSection('compliance')}
                />
              ) : (
                <>
                  <View style={styles.dashComplianceStats}>
                    <View style={[styles.dashComplianceStat, styles.dashComplianceStatValid]}>
                      <Text style={styles.dashComplianceStatValue}>{dashComplianceCounts.valid}</Text>
                      <Text style={styles.dashComplianceStatLabel}>Valid</Text>
                    </View>
                    <View style={[styles.dashComplianceStat, styles.dashComplianceStatExpiring]}>
                      <Text style={[styles.dashComplianceStatValue, dashComplianceCounts.expiring > 0 ? styles.dashComplianceStatValueWarning : null]}>
                        {dashComplianceCounts.expiring}
                      </Text>
                      <Text style={styles.dashComplianceStatLabel}>Expiring</Text>
                    </View>
                    <View style={styles.dashComplianceStat}>
                      <Text style={[styles.dashComplianceStatValue, dashComplianceCounts.expired > 0 ? styles.dashComplianceStatValueDanger : null]}>
                        {dashComplianceCounts.expired}
                      </Text>
                      <Text style={styles.dashComplianceStatLabel}>Expired</Text>
                    </View>
                  </View>
                  <Pressable
                    onPress={() => setActiveSection('compliance')}
                    accessibilityRole="button"
                    style={({ hovered, pressed }: any) => [
                      styles.dashCoverageAction,
                      hovered ? styles.dashCoverageActionHover : null,
                      pressed ? styles.dashCoverageActionPressed : null,
                      IS_WEB ? (WEB_POINTER_STYLE as any) : null,
                    ]}
                  >
                    <Text style={styles.dashCoverageActionText}>View all compliance →</Text>
                  </Pressable>
                </>
              )}
            </Card>
          </View>

          <View style={styles.dashRow4Cell}>
            <Card
              style={styles.dashLivePanelCard}
              webSurfaceHover
              title="Upcoming Shifts"
              subtitle="Next scheduled shifts starting soon."
            >
              {upcomingShifts.length === 0 ? (
                <DashboardPanelEmpty
                  title="No upcoming shifts"
                  description="Future scheduled shifts appear here when planning is in place."
                  actionLabel="View shift schedule"
                  onAction={() => setActiveSection('rota-planner')}
                />
              ) : (
                upcomingShifts.map((shift, index, arr) => (
                  <Pressable
                    key={shift.id}
                    style={({ hovered, pressed }: any) => [
                      styles.dashListRow,
                      IS_WEB ? styles.dashListRowWeb : null,
                      index === arr.length - 1 ? styles.dashListRowLast : null,
                      hovered ? styles.dashListRowHovered : null,
                      hovered && IS_WEB ? styles.dashListRowWebHover : null,
                      pressed ? styles.dashListRowPressed : null,
                      IS_WEB ? (WEB_POINTER_STYLE as any) : null,
                    ]}
                    onPress={() => setActiveSection('rota-planner')}
                    accessibilityRole="button"
                  >
                    <Text style={styles.dashListRowTitle} numberOfLines={1}>{shift.site?.name || shift.siteName}</Text>
                    <Text style={styles.dashListRowMeta}>
                      {formatDateLabel(shift.start)} · {formatTimeLabel(shift.start)}–{formatTimeLabel(shift.end)}
                    </Text>
                  </Pressable>
                ))
              )}
            </Card>
          </View>
        </View>

      </View>
    );
  };

  const renderClientsSection = () => (
    <CompanyClientsWorkspace
      clients={clients}
      sites={sites}
      clientForm={clientForm}
      setClientForm={setClientForm}
      savingClient={savingClient}
      onSaveClient={handleSaveClient}
      onArchiveClient={handleArchiveClient}
    />
  );

  const renderSitesSection = () => (
    <CompanySitesWorkspace
      sites={sites}
      clients={clients}
      siteForm={siteForm}
      setSiteForm={setSiteForm}
      savingSite={savingSite}
      onSaveSite={handleSaveSite}
      onArchiveSite={handleArchiveSite}
      onPlanCover={handlePlanSite}
    />
  );

  const renderRotaPlannerSection = () => (
    <CompanyRotaPlannerWorkspace
      plannerClientId={plannerClientId}
      plannerSiteId={plannerSiteId}
      setPlannerClientId={setPlannerClientId}
      setPlannerSiteId={setPlannerSiteId}
      siteClientOptions={siteClientOptions}
      plannerSiteOptions={plannerSiteOptions}
      weekCommencing={plannerWeekCommencing}
      weekEnding={plannerWeekEnding}
      plannerWeekDays={plannerWeekDays}
      onPrevWeek={handlePlannerPrevWeek}
      onNextWeek={handlePlannerNextWeek}
      onTodayWeek={handlePlannerTodayWeek}
      slotsByDayName={slotsByDayName}
      weekSnapshot={rotaWeekData?.snapshot ?? null}
      loadingRota={loadingRota}
      rotaError={rotaError}
      onRetryLoadRota={() => setRotaLoadKey((k) => k + 1)}
      onRefreshWeek={() => setRotaLoadKey((k) => k + 1)}
      onLoadSlot={handleRotaLoadSlot}
      onCreateSlot={handleRotaCreateSlot}
      onSaveSlotEdits={handleRotaSaveEdits}
      onAssignPosition={handleRotaAssignPosition}
      onAssignMultiple={handleRotaAssignMultiple}
      onCancelPosition={handleRotaCancelPosition}
      onCancelSlot={handleRotaCancelSlot}
      onGetEligibleGuards={handleRotaGetEligibleGuards}
      legacyShiftsByDate={legacyShiftsByDate}
    />
  );

  const renderLiveOperationsSection = () => (
    <View style={styles.sectionStack}>
      <CompanyLiveOperationsWorkspace
        liveShiftsCount={liveShifts.length}
        guardsNotBookedOnCount={guardsNotBookedOn.length}
        activePanicAlertsCount={activePanicAlerts.length}
        openIncidentsCount={openIncidents.length}
        missedCheckCallsCount={missedCheckCalls.length}
        urgentOperationalItems={urgentOperationalItems}
        urgentActionItemId={urgentActionItemId}
        liveOperationsFeedback={liveOperationsFeedback}
        liveOperationEnrichedRows={liveOperationEnrichedRows}
        selectedShiftId={selectedShiftId}
        setSelectedShiftId={setSelectedShiftId}
        highlightedLiveShiftId={highlightedLiveShiftId}
        liveFilters={liveFilters}
        setLiveFilters={setLiveFilters}
        siteClientOptions={siteClientOptions}
        siteOptions={siteOptions}
        linkedGuardOptions={linkedGuardOptions}
        uncoveredShiftCount={uncoveredShifts.length}
        recentOperationalActivity={recentOperationalActivity}
        selectedShiftContext={selectedShiftContext}
        selectedShiftCloseOutSummary={selectedShiftCloseOutSummary as CloseOutSummary | null}
        closeOutNotesDraft={closeOutNotesDraft}
        setCloseOutNotesDraft={setCloseOutNotesDraft}
        savingCloseOutNotes={savingCloseOutNotes}
        refreshing={refreshing}
        onLiveBoardPrimaryAction={handleLiveBoardPrimaryAction}
        onOpenUrgentDetail={handleOpenUrgentDetail}
        onOpenUrgentShift={handleOpenUrgentShift}
        onUrgentIncidentFollowUp={handleUrgentIncidentFollowUp}
        onUrgentAlertFollowUp={handleUrgentAlertFollowUp}
        onSaveCloseOutNotes={handleSaveCloseOutNotes}
        onOpenCoverage={openCoverage}
        onBoardLayout={setLiveBoardAnchorY}
        onDetailLayout={setShiftDetailAnchorY}
      />

    </View>
  );

  // P1G-B — Engagement-aware label helper (Company UX)
  // S4 is a workforce evidence platform. "Pay Administration" is the neutral heading for all engagement types.
  function getPayrollLabels(_engagementType: GuardEngagementType | 'NONE' | null) {
    return {
      heading:   'Pay Administration',
      subtitle:  'Operational pay information and external payroll reference.',
      reference: 'Pay Reference',
      frequency: 'Pay Frequency (informational)',
      status:    'Export Status',
      startDate: 'Arrangement Start Date',
      endDate:   'Arrangement End Date',
      note:      'Internal Note',
    };
  }

  async function handleSelectPayrollGuard(guardId: number, guardName: string) {
    setSelectedPayrollGuardId(guardId);
    setSelectedPayrollGuardName(guardName);
    setGuardPayrollRecord(null);
    setGuardPayrollEngagementType(null);
    setGuardPayrollError(null);
    setEditingPayrollAdmin(false);
    setPayrollAdminFeedback(null);
    setGuardPayrollLoading(true);
    try {
      const [payrollRecord, employment] = await Promise.all([
        getCompanyGuardPayrollAdmin(guardId),
        getCompanyGuardEmployment(guardId).catch(() => null),
      ]);
      setGuardPayrollRecord(payrollRecord);
      setGuardPayrollEngagementType(employment ? (employment as CompanyGuardEmploymentSummary).engagementType : 'NONE');
      if (payrollRecord) {
        setPayrollRefInput(payrollRecord.payrollReference ?? '');
        setPayrollFreqInput(payrollRecord.payFrequency ?? '');
        setPayrollStatusInput(payrollRecord.payrollStatus);
        setPayrollStartDateInput(payrollRecord.payrollStartDate ?? '');
        setPayrollEndDateInput(payrollRecord.payrollEndDate ?? '');
        setPayrollNoteInput(payrollRecord.payrollNote ?? '');
      } else {
        setPayrollRefInput('');
        setPayrollFreqInput('');
        setPayrollStatusInput('ACTIVE');
        setPayrollStartDateInput('');
        setPayrollEndDateInput('');
        setPayrollNoteInput('');
      }
    } catch {
      setGuardPayrollError('Could not load pay administration record.');
    } finally {
      setGuardPayrollLoading(false);
    }
  }

  async function handleSavePayrollAdmin() {
    if (!selectedPayrollGuardId) return;
    setSavingPayrollAdmin(true);
    setPayrollAdminFeedback(null);
    try {
      const payload: UpsertPayrollAdminPayload = {
        payrollReference: payrollRefInput.trim() || null,
        payFrequency: (payrollFreqInput as UpsertPayrollAdminPayload['payFrequency']) || null,
        payrollStatus: payrollStatusInput as UpsertPayrollAdminPayload['payrollStatus'],
        payrollStartDate: payrollStartDateInput.trim() || null,
        payrollEndDate: payrollEndDateInput.trim() || null,
        payrollNote: payrollNoteInput.trim() || null,
      };
      const updated = guardPayrollRecord
        ? await updateCompanyGuardPayrollAdmin(selectedPayrollGuardId, payload)
        : await createCompanyGuardPayrollAdmin(selectedPayrollGuardId, payload);
      setGuardPayrollRecord(updated);
      setEditingPayrollAdmin(false);
      setPayrollAdminFeedback({ tone: 'success', message: 'Record saved successfully.' });
    } catch (e: unknown) {
      setPayrollAdminFeedback({ tone: 'error', message: formatApiErrorMessage(e, 'Could not save record.') });
    } finally {
      setSavingPayrollAdmin(false);
    }
  }

  const renderPayrollAdminPanel = () => {
    const labels = getPayrollLabels(guardPayrollEngagementType);
    const PAY_FREQUENCY_OPTIONS = [
      { value: '', label: '— Select —' },
      { value: 'WEEKLY', label: 'Weekly' },
      { value: 'FORTNIGHTLY', label: 'Fortnightly' },
      { value: 'FOUR_WEEKLY', label: 'Four Weekly' },
      { value: 'MONTHLY', label: 'Monthly' },
      { value: 'IRREGULAR', label: 'Irregular' },
    ];
    const STATUS_OPTIONS = [
      { value: 'ACTIVE', label: 'Active' },
      { value: 'ON_HOLD', label: 'On Hold' },
      { value: 'EXCLUDED', label: 'Excluded' },
    ];

    return (
      <View style={[styles.tableCard, { marginTop: 16 }]}>
        <Text style={styles.panelTitle}>{labels.heading}</Text>
        <Text style={styles.tableCell}>{labels.subtitle}</Text>
        {selectedPayrollGuardId === null ? (
          <Text style={styles.tableCell}>Select a linked guard above to manage their {labels.heading.toLowerCase()}.</Text>
        ) : guardPayrollLoading ? (
          <Text style={styles.tableCell}>Loading…</Text>
        ) : guardPayrollError ? (
          <Text style={[styles.tableCell, { color: colors.danger }]}>{guardPayrollError}</Text>
        ) : (
          <View>
            <Text style={styles.tableCell}>Guard: <Text style={styles.tableCellStrong}>{selectedPayrollGuardName}</Text></Text>

            {payrollAdminFeedback ? (
              <View style={[styles.feedbackCard, payrollAdminFeedback.tone === 'error' ? styles.feedbackCardError : styles.feedbackCardSuccess]}>
                <Text style={[styles.feedbackText, payrollAdminFeedback.tone === 'error' ? styles.feedbackTextError : styles.feedbackTextSuccess]}>{payrollAdminFeedback.message}</Text>
              </View>
            ) : null}

            {!editingPayrollAdmin ? (
              <View>
                {guardPayrollRecord ? (
                  <View>
                    <View style={styles.tableRow}>
                      <Text style={styles.tableCell}>{labels.reference}</Text>
                      <Text style={styles.tableCellStrong}>{guardPayrollRecord.payrollReference ?? '—'}</Text>
                    </View>
                    <View style={styles.tableRow}>
                      <Text style={styles.tableCell}>{labels.frequency}</Text>
                      <Text style={styles.tableCellStrong}>{guardPayrollRecord.payFrequency ? guardPayrollRecord.payFrequency.replace(/_/g, ' ') : '—'}</Text>
                    </View>
                    <View style={styles.tableRow}>
                      <Text style={styles.tableCell}>{labels.status}</Text>
                      <Text style={styles.tableCellStrong}>{guardPayrollRecord.payrollStatus.replace(/_/g, ' ')}</Text>
                    </View>
                    <View style={styles.tableRow}>
                      <Text style={styles.tableCell}>{labels.startDate}</Text>
                      <Text style={styles.tableCellStrong}>{guardPayrollRecord.payrollStartDate ?? '—'}</Text>
                    </View>
                    <View style={styles.tableRow}>
                      <Text style={styles.tableCell}>{labels.endDate}</Text>
                      <Text style={styles.tableCellStrong}>{guardPayrollRecord.payrollEndDate ?? '—'}</Text>
                    </View>
                    {guardPayrollRecord.payrollNote ? (
                      <View style={styles.tableRow}>
                        <Text style={styles.tableCell}>{labels.note}</Text>
                        <Text style={styles.tableCellStrong}>{guardPayrollRecord.payrollNote}</Text>
                      </View>
                    ) : null}
                  </View>
                ) : (
                  <Text style={styles.tableCell}>No {labels.heading.toLowerCase()} record on file.</Text>
                )}
                <View style={styles.rowActions}>
                  <Pressable style={styles.primaryButton} onPress={() => setEditingPayrollAdmin(true)}>
                    <Text style={styles.primaryButtonText}>{guardPayrollRecord ? `Edit ${labels.heading}` : `Set Up ${labels.heading}`}</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View>
                <Text style={styles.tableCell}>{labels.reference}</Text>
                <TextInput style={styles.input} value={payrollRefInput} onChangeText={setPayrollRefInput} placeholder="e.g. EMP-001" maxLength={50} />

                <Text style={styles.tableCell}>{labels.frequency}</Text>
                <View style={styles.rowActions}>
                  {PAY_FREQUENCY_OPTIONS.map((opt) => (
                    <Pressable key={opt.value} style={[styles.secondaryButton, payrollFreqInput === opt.value && { backgroundColor: colors.accentTeal }]} onPress={() => setPayrollFreqInput(opt.value)}>
                      <Text style={styles.secondaryButtonText}>{opt.label}</Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.tableCell}>{labels.status}</Text>
                <View style={styles.rowActions}>
                  {STATUS_OPTIONS.map((opt) => (
                    <Pressable key={opt.value} style={[styles.secondaryButton, payrollStatusInput === opt.value && { backgroundColor: colors.accentTeal }]} onPress={() => setPayrollStatusInput(opt.value)}>
                      <Text style={styles.secondaryButtonText}>{opt.label}</Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.tableCell}>{labels.startDate} (YYYY-MM-DD)</Text>
                <TextInput style={styles.input} value={payrollStartDateInput} onChangeText={setPayrollStartDateInput} placeholder="e.g. 2024-01-01" maxLength={10} />

                <Text style={styles.tableCell}>{labels.endDate} (YYYY-MM-DD, leave blank if ongoing)</Text>
                <TextInput style={styles.input} value={payrollEndDateInput} onChangeText={setPayrollEndDateInput} placeholder="e.g. 2024-12-31" maxLength={10} />

                <Text style={styles.tableCell}>{labels.note}</Text>
                <TextInput style={[styles.input, { minHeight: 60 }]} value={payrollNoteInput} onChangeText={setPayrollNoteInput} placeholder="Internal note (not visible to guard)" multiline maxLength={2000} />

                <View style={styles.rowActions}>
                  <Pressable style={styles.secondaryButton} onPress={() => setEditingPayrollAdmin(false)} disabled={savingPayrollAdmin}>
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                  </Pressable>
                  <Pressable style={[styles.primaryButton, savingPayrollAdmin && { opacity: 0.5 }]} onPress={handleSavePayrollAdmin} disabled={savingPayrollAdmin}>
                    <Text style={styles.primaryButtonText}>{savingPayrollAdmin ? 'Saving…' : 'Save'}</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </View>
        )}
      </View>
    );
  };

  const renderGuardsSection = () => (
    <View style={styles.sectionStack}>
      <View style={styles.splitLayout}>
        <View style={styles.tableCard}>
          <Text style={styles.panelTitle}>Available Platform Guards</Text>
          {availablePlatformGuards.map((guard) => (
            <View key={guard.id} style={styles.tableRow}>
              <Text style={styles.tableCellStrong}>{guard.fullName}</Text>
              <Text style={styles.tableCell}>{guard.siaLicenseNumber || guard.siaLicenceNumber || 'No SIA yet'}</Text>
              <Text style={styles.tableCell}>{guard.phone}</Text>
              <View style={styles.rowActions}>
                <Pressable style={styles.primaryButton} onPress={() => handleApproveGuard(guard.id)} disabled={approvingGuardId === guard.id}>
                  <Text style={styles.primaryButtonText}>{approvingGuardId === guard.id ? 'Linking...' : 'Link Guard'}</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
        <View style={styles.tableCard}>
          <Text style={styles.panelTitle}>Linked Guards</Text>
          {linkedGuards.map((guard) => (
            <View key={guard.id} style={styles.tableRow}>
              <Text style={styles.tableCellStrong}>{guard.fullName}</Text>
              <Text style={styles.tableCell}>{guard.phone}</Text>
              <Text style={styles.tableCell}>{shifts.filter((shift) => (shift.guard?.id ?? shift.guardId) === guard.id).length} shifts</Text>
              <View style={styles.rowActions}>
                <Pressable style={styles.secondaryButton} onPress={() => handleSelectPayrollGuard(guard.id, guard.fullName)}>
                  <Text style={styles.secondaryButtonText}>Pay Admin</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      </View>
      {renderPayrollAdminPanel()}
    </View>
  );

  const renderShiftOffersSection = () => (
    <View style={styles.sectionStack}>
      <View style={styles.toolbar}>
        <Text style={styles.sectionTitle}>Shift Offers / Pending Responses</Text>
        <Pressable style={styles.secondaryButton} onPress={() => loadData(true)}>
          <Text style={styles.secondaryButtonText}>{refreshing ? 'Refreshing...' : 'Refresh'}</Text>
        </Pressable>
      </View>

      {shiftOffersFeedback ? (
        <View
          style={[
            styles.feedbackCard,
            shiftOffersFeedback.tone === 'error' ? styles.feedbackCardError : styles.feedbackCardSuccess,
          ]}
        >
          <Text
            style={[
              styles.feedbackTitle,
              shiftOffersFeedback.tone === 'error' ? styles.feedbackTitleError : styles.feedbackTitleSuccess,
            ]}
          >
            {shiftOffersFeedback.tone === 'error' ? 'Action failed' : 'Action completed'}
          </Text>
          <Text
            style={[
              styles.feedbackText,
              shiftOffersFeedback.tone === 'error' ? styles.feedbackTextError : styles.feedbackTextSuccess,
            ]}
          >
            {shiftOffersFeedback.message}
          </Text>
        </View>
      ) : null}

      <View style={styles.kpiGrid}>
        {[
          ['Waiting Response', String(pendingShiftOffers.length)],
          ['Ready To Start', String(readyShiftOffers.length)],
          ['Missed / Re-cover', String(missedShiftOffers.length)],
          ['Rejected / Re-cover', String(rejectedShiftOffers.length)],
        ].map(([label, value]) => (
          <View key={label} style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>{label}</Text>
            <Text style={styles.kpiValue}>{value}</Text>
          </View>
        ))}
      </View>

      <View style={styles.panelGrid}>
        <View style={[styles.tableCard, styles.operationsBoardCard]}>
          <Text style={styles.panelTitle}>Offer Response Board</Text>
          <Text style={styles.helperText}>
            Track guard responses after rota planning. Offered shifts are waiting, ready shifts are confirmed, missed shifts need exception follow-up and re-cover, and rejected shifts need fresh cover.
          </Text>
          {renderTableHeader(['Shift', 'Site', 'Guard', 'Date', 'Time', 'State', 'Response'])}
          {shiftOfferRows.map((shift) => {
            const lifecycleStatus = normalizeShiftLifecycleStatus(shift.status);
            const responseText =
              lifecycleStatus === 'offered'
                ? 'Waiting for guard response'
                : lifecycleStatus === 'ready'
                  ? 'Accepted and ready to start'
                  : lifecycleStatus === 'missed'
                    ? 'Missed check-in, exception follow-up and re-cover required'
                    : 'Rejected and needs reassignment';

            const reassignmentOptions = linkedGuardOptions.filter(
              (option) => option.value !== String(shift.guard?.id ?? shift.guardId ?? ''),
            );

            return (
              <View
                key={shift.id}
                style={[styles.tableRow, selectedShiftId === shift.id && styles.tableRowSelected, styles.offerRow]}
              >
                <Pressable
                  style={styles.offerRowSummary}
                  onPress={() => {
                    setSelectedShiftId(shift.id);
                    setActiveSection('shift-offers');
                  }}
                >
                  <Text style={styles.tableCellStrong}>#{shift.id}</Text>
                  <Text style={styles.tableCell}>{shift.site?.name || shift.siteName || 'Unknown site'}</Text>
                  <Text style={styles.tableCell}>{shift.guard?.fullName || 'Unassigned'}</Text>
                  <Text style={styles.tableCell}>{formatDateLabel(shift.start)}</Text>
                  <Text style={styles.tableCell}>
                    {formatTimeLabel(shift.start)}-{formatTimeLabel(shift.end)}
                  </Text>
                  <View style={styles.tableCell}>
                    <ShiftStatusBadge status={shift.status} />
                  </View>
                  <Text style={styles.tableCell}>{responseText}</Text>
                </Pressable>
                <View style={styles.offerRowActions}>
                  {lifecycleStatus === 'offered' ? (
                    <Pressable
                      style={styles.secondaryButton}
                      onPress={() => handleCancelShiftOffer(shift.id)}
                      disabled={offerActionShiftId === shift.id}
                    >
                      <Text style={styles.secondaryButtonText}>
                        {offerActionShiftId === shift.id ? 'Cancelling...' : 'Withdraw Offer'}
                      </Text>
                    </Pressable>
                  ) : null}
                  {lifecycleStatus === 'ready' ? (
                    <Pressable
                      style={styles.primaryButton}
                      onPress={() => {
                        setShiftOffersFeedback({
                          tone: 'success',
                          message: `Opening Shift #${shift.id} in Live Operations.`,
                        });
                        setSelectedShiftId(shift.id);
                        setActiveSection('live-operations');
                      }}
                    >
                      <Text style={styles.primaryButtonText}>Open In Live Ops</Text>
                    </Pressable>
                  ) : null}
                  {['rejected', 'missed'].includes(lifecycleStatus) ? (
                    <View style={styles.offerReassignBox}>
                      <WebSelect
                        value={reassignGuardByShiftId[shift.id] || ''}
                        onChange={(value: string) =>
                          setReassignGuardByShiftId((current) => ({ ...current, [shift.id]: value }))
                        }
                        options={reassignmentOptions}
                        placeholder="Choose replacement guard"
                      />
                      <Pressable
                        style={styles.primaryButton}
                        onPress={() => handleReofferShift(shift.id)}
                        disabled={offerActionShiftId === shift.id}
                      >
                        <Text style={styles.primaryButtonText}>
                          {offerActionShiftId === shift.id ? 'Re-offering...' : 'Re-offer Shift'}
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              </View>
            );
          })}
          {shiftOfferRows.length === 0 ? (
            <Text style={styles.helperText}>No current shift offers are waiting for response.</Text>
          ) : null}
        </View>

        <View style={styles.operationsSideColumn}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Waiting Response</Text>
            {pendingShiftOffers.slice(0, 6).map((shift) => (
              <View key={shift.id} style={styles.recordRow}>
                <Text style={styles.recordTitle}>Shift #{shift.id} · {shift.site?.name || shift.siteName}</Text>
                <Text style={styles.recordMeta}>
                  {shift.guard?.fullName || 'Unassigned'} | {formatDateTimeLabel(shift.start)}
                </Text>
              </View>
            ))}
            {pendingShiftOffers.length === 0 ? <Text style={styles.helperText}>No outstanding guard responses.</Text> : null}
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Ready To Start</Text>
            {readyShiftOffers.slice(0, 6).map((shift) => (
              <View key={shift.id} style={styles.recordRow}>
                <Text style={styles.recordTitle}>Shift #{shift.id} · {shift.site?.name || shift.siteName}</Text>
                <Text style={styles.recordMeta}>
                  {shift.guard?.fullName || 'Unassigned'} | Accepted and ready for book on
                </Text>
              </View>
            ))}
            {readyShiftOffers.length === 0 ? <Text style={styles.helperText}>No accepted offers are waiting to start.</Text> : null}
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Missed / Needs Re-cover</Text>
            {missedShiftOffers.slice(0, 6).map((shift) => (
              <View key={shift.id} style={styles.recordRow}>
                <Text style={styles.recordTitle}>Shift #{shift.id} · {shift.site?.name || shift.siteName}</Text>
                <Text style={styles.recordMeta}>
                  {shift.guard?.fullName || 'No guard'} | Missed check-in, follow up if needed and find replacement cover
                </Text>
              </View>
            ))}
            {missedShiftOffers.length === 0 ? <Text style={styles.helperText}>No missed shifts need re-cover right now.</Text> : null}
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Rejected / Needs Re-cover</Text>
            {rejectedShiftOffers.slice(0, 6).map((shift) => (
              <View key={shift.id} style={styles.recordRow}>
                <Text style={styles.recordTitle}>Shift #{shift.id} | {shift.site?.name || shift.siteName}</Text>
                <Text style={styles.recordMeta}>
                  {shift.guard?.fullName || 'No guard'} | Offer rejected, find replacement cover
                </Text>
              </View>
            ))}
            {rejectedShiftOffers.length === 0 ? <Text style={styles.helperText}>No rejected offers need re-cover right now.</Text> : null}
          </View>
        </View>
      </View>

      {selectedShift && ['offered', 'ready', 'rejected', 'missed'].includes(normalizeShiftLifecycleStatus(selectedShift.status)) ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Selected Offer Detail</Text>
          <Text style={styles.recordMeta}>
            {selectedShift.site?.client?.name || clientMap.get(selectedShift.site?.clientId || 0)?.name || 'No client'} | {selectedShift.site?.name || selectedShift.siteName}
          </Text>
          <Text style={styles.recordMeta}>
            {selectedShift.guard?.fullName || 'No guard assigned'} | {formatDateLabel(selectedShift.start)} | {formatTimeLabel(selectedShift.start)}-{formatTimeLabel(selectedShift.end)}
          </Text>
          <ShiftStatusBadge status={selectedShift.status} />
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'offered' ? (
            <Text style={styles.recordMeta}>Waiting for this guard to accept or reject the offer.</Text>
          ) : null}
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'ready' ? (
            <Text style={styles.recordMeta}>Guard accepted this shift. It is ready to move into live operations.</Text>
          ) : null}
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'rejected' ? (
            <Text style={styles.recordMeta}>Offer was rejected before the shift went live. Fresh cover is still required.</Text>
          ) : null}
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'missed' ? (
            <Text style={styles.recordMeta}>Missed check-in exception: no attendance was recorded within the grace period. Re-cover is now required, and attendance follow-up may still be needed.</Text>
          ) : null}
          <Text style={styles.recordMeta}>Instructions: {selectedShift.instructions || 'No instructions recorded.'}</Text>
          <View style={styles.rowActions}>
            {normalizeShiftLifecycleStatus(selectedShift.status) === 'offered' ? (
              <Pressable
                style={styles.secondaryButton}
                onPress={() => handleCancelShiftOffer(selectedShift.id)}
                disabled={offerActionShiftId === selectedShift.id}
              >
                <Text style={styles.secondaryButtonText}>
                  {offerActionShiftId === selectedShift.id ? 'Cancelling...' : 'Withdraw Offer'}
                </Text>
              </Pressable>
            ) : null}
            {normalizeShiftLifecycleStatus(selectedShift.status) === 'ready' ? (
              <Pressable
                style={styles.primaryButton}
                onPress={() => {
                  setShiftOffersFeedback({
                    tone: 'success',
                    message: `Opening Shift #${selectedShift.id} in Live Operations.`,
                  });
                  setActiveSection('live-operations');
                }}
              >
                <Text style={styles.primaryButtonText}>Open In Live Operations</Text>
              </Pressable>
            ) : null}
          </View>
          {['rejected', 'missed'].includes(normalizeShiftLifecycleStatus(selectedShift.status)) ? (
            <View style={styles.offerReassignBox}>
              <WebSelect
                value={reassignGuardByShiftId[selectedShift.id] || ''}
                onChange={(value: string) =>
                  setReassignGuardByShiftId((current) => ({ ...current, [selectedShift.id]: value }))
                }
                options={linkedGuardOptions.filter(
                  (option) => option.value !== String(selectedShift.guard?.id ?? selectedShift.guardId ?? ''),
                )}
                placeholder="Choose replacement guard"
              />
              <Pressable
                style={styles.primaryButton}
                onPress={() => handleReofferShift(selectedShift.id)}
                disabled={offerActionShiftId === selectedShift.id}
              >
                <Text style={styles.primaryButtonText}>
                  {offerActionShiftId === selectedShift.id ? 'Re-offering...' : 'Re-offer Shift'}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  const renderRecruitmentSection = () => (
    <View style={styles.sectionStack}>
      <View style={styles.splitLayout}>
        <View style={styles.formCard}>
          <Text style={styles.panelTitle}>Create Recruitment Job</Text>
          <TextInput style={styles.input} value={jobForm.title} onChangeText={(value: string) => setJobForm((current) => ({ ...current, title: value }))} placeholder="Job title" />
          <WebSelect value={jobForm.siteId} onChange={(value: string) => setJobForm((current) => ({ ...current, siteId: value }))} options={siteOptions} placeholder="Site" />
          <TextInput style={[styles.input, styles.textArea]} multiline value={jobForm.description} onChangeText={(value: string) => setJobForm((current) => ({ ...current, description: value }))} placeholder="Description" />
          <View style={styles.formRow}>
            <TextInput style={[styles.input, styles.formCell]} value={jobForm.guardsRequired} onChangeText={(value: string) => setJobForm((current) => ({ ...current, guardsRequired: value }))} placeholder="Guards required" />
            <TextInput style={[styles.input, styles.formCell]} value={jobForm.hourlyRate} onChangeText={(value: string) => setJobForm((current) => ({ ...current, hourlyRate: value }))} placeholder="Hourly rate" />
            <TextInput style={[styles.input, styles.formCell]} value={jobForm.billingRate} onChangeText={(value: string) => setJobForm((current) => ({ ...current, billingRate: value }))} placeholder="Billing rate (optional)" />
          </View>
          <Pressable style={styles.primaryButton} onPress={handleCreateJob} disabled={creatingJob}>
            <Text style={styles.primaryButtonText}>{creatingJob ? 'Saving...' : 'Create Job'}</Text>
          </Pressable>
        </View>
        <View style={styles.tableCard}>
          <Text style={styles.panelTitle}>Applications</Text>
          <Text style={styles.helperText}>
            Application review approves a guard for future work with this company. Shift offers are tracked separately once rota or shift assignment is made.
          </Text>
          {applications.map((application) => (
            <View key={application.id} style={styles.tableRow}>
              <Text style={styles.tableCellStrong}>{application.job?.title || `Job #${application.jobId}`}</Text>
              <Text style={styles.tableCell}>{application.guard?.fullName || `Guard #${application.guardId}`}</Text>
              <Text style={styles.tableCell}>{formatStatusLabel(application.status)}</Text>
              <Text style={styles.tableCell}>
                {applicationShiftSummaryById.get(application.id)
                  ? `${formatStatusLabel(applicationShiftSummaryById.get(application.id)?.status || '')} · ${applicationShiftSummaryById.get(application.id)?.siteName}`
                  : 'No shift offered'}
              </Text>
              <View style={styles.rowActions}>
                {application.status === 'applied' ? (
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={() => handleReviewApplication(application.id, 'under_review')}
                    disabled={reviewingApplicationId === application.id}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {reviewingApplicationId === application.id ? 'Updating...' : 'Under Review'}
                    </Text>
                  </Pressable>
                ) : null}
                {application.status !== 'accepted' && application.status !== 'rejected' ? (
                  <>
                    <Pressable
                      style={styles.primaryButton}
                      onPress={() => handleReviewApplication(application.id, 'accepted')}
                      disabled={reviewingApplicationId === application.id}
                    >
                      <Text style={styles.primaryButtonText}>
                        {reviewingApplicationId === application.id ? 'Updating...' : 'Accept Application'}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={styles.secondaryButton}
                      onPress={() => handleReviewApplication(application.id, 'rejected')}
                      disabled={reviewingApplicationId === application.id}
                    >
                      <Text style={styles.secondaryButtonText}>
                        {reviewingApplicationId === application.id ? 'Updating...' : 'Reject'}
                      </Text>
                    </Pressable>
                  </>
                ) : null}
                {application.status === 'accepted' ? (
                  <Text style={styles.helperText}>Approved for company assignment</Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
        <View style={styles.tableCard}>
          <Text style={styles.panelTitle}>Approved Guards Ready For Shift Offers</Text>
          <Text style={styles.helperText}>
            These guards are recruitment-approved. Offer them specific shifts from Rota Planner or shift assignment without changing the application decision.
          </Text>
          {acceptedApplications.length === 0 ? (
            <Text style={styles.helperText}>No approved applications yet.</Text>
          ) : (
            acceptedApplications.map((application) => {
              const latestOffer = applicationShiftSummaryById.get(application.id);

              return (
                <View key={`approved-${application.id}`} style={styles.tableRow}>
                  <Text style={styles.tableCellStrong}>{application.guard?.fullName || `Guard #${application.guardId}`}</Text>
                  <Text style={styles.tableCell}>{application.job?.title || `Job #${application.jobId}`}</Text>
                  <Text style={styles.tableCell}>Application Accepted</Text>
                  <Text style={styles.tableCell}>
                    {latestOffer
                      ? `${formatStatusLabel(latestOffer.status)} · ${latestOffer.siteName}`
                      : 'No shift offered yet'}
                  </Text>
                </View>
              );
            })
          )}
        </View>
      </View>
    </View>
  );

  const renderSimpleTableSection = (
    title: string,
    columns: string[],
    rows: any,
  ) => (
    <View style={styles.sectionStack}>
      <View style={styles.tableCard}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {renderTableHeader(columns)}
        {rows}
      </View>
    </View>
  );

  const renderContent = () => {
    switch (activeSection) {
      case 'dashboard':
        return renderDashboardSection();
      case 'clients':
        return renderClientsSection();
      case 'sites':
        return renderSitesSection();
      case 'rota-planner':
        return renderRotaPlannerSection();
      case 'shift-offers':
        return renderShiftOffersSection();
      case 'live-operations':
        return renderLiveOperationsSection();
      case 'analytics':
        return <CompanyAnalyticsWorkspace />;
      case 'coverage':
        return <CompanyCoverageWorkspace navigationContext={coverageNavigationContext} />;
      case 'guards':
        return renderGuardsSection();
      case 'availability':
        return <CompanyAvailabilityWorkspace />;
      case 'recruitment':
        return renderRecruitmentSection();
      case 'weekly-approvals':
        return <CompanyWeeklyApprovalsScreen />;
      case 'timesheets':
        return <CompanyTimesheetsWorkspace timesheets={timesheets} refreshing={refreshing} onRefresh={() => loadData(true)} onNavigateToClientTimesheets={() => setActiveSection('weekly-approvals')} />;
      case 'payroll':
        return <CompanyPayrollWorkspace timesheets={timesheets} refreshing={refreshing} onRefresh={() => loadData(true)} />;
      case 'payroll-batches':
        return <CompanyPayrollBatchesWorkspace />;
      case 'invoices':
        return <CompanyInvoiceWorkspace timesheets={timesheets} refreshing={refreshing} onRefresh={() => loadData(true)} />;
      case 'finance':
        return <CompanyFinanceWorkspace timesheets={timesheets} refreshing={refreshing} onRefresh={() => loadData(true)} />;
      case 'finance-control':
        return <CompanyFinanceControlWorkspace timesheets={timesheets} refreshing={refreshing} onRefresh={() => loadData(true)} />;
      case 'margins':
        return <CompanyMarginWorkspace />;
      case 'compliance':
        return <CompanyComplianceWorkspace />;
      case 'contract-pricing':
        return <CompanyContractPricingWorkspace />;
      case 'pay-rules':
        return <CompanyPayRulesSettings />;
      case 'audit':
        return <CompanyAuditWorkspace />;
      case 'incidents':
        return renderSimpleTableSection(
          'Incidents',
          ['Incident', 'Shift', 'Site', 'Guard', 'Severity', 'Status', 'Time'],
          incidents.map((incident) => (
            <View key={incident.id} style={styles.tableRow}>
              <Text style={styles.tableCellStrong}>#{incident.id}</Text>
              <Text style={styles.tableCell}>{incident.shift?.id ? `#${incident.shift.id}` : '—'}</Text>
              <Text style={styles.tableCell}>{incident.site?.name || incident.shift?.site?.name || '—'}</Text>
              <Text style={styles.tableCell}>{incident.guard?.fullName || '—'}</Text>
              <Text style={styles.tableCell}>{formatStatusLabel(incident.severity)}</Text>
              <Text style={styles.tableCell}>{formatStatusLabel(incident.status)}</Text>
              <Text style={styles.tableCell}>{formatDateTimeLabel(incident.createdAt)}</Text>
            </View>
          )),
        );
      case 'alerts':
        return renderSimpleTableSection(
          'Safety Alerts',
          ['Type', 'Shift', 'Site', 'Guard', 'Status', 'Time'],
          alerts.map((alert) => (
            <View key={alert.id} style={styles.tableRow}>
              <Text style={styles.tableCellStrong}>{formatStatusLabel(alert.type)}</Text>
              <Text style={styles.tableCell}>{alert.shift?.id ? `#${alert.shift.id}` : '—'}</Text>
              <Text style={styles.tableCell}>{alert.shift?.site?.name || alert.shift?.siteName || '—'}</Text>
              <Text style={styles.tableCell}>{alert.guard?.fullName || '—'}</Text>
              <Text style={styles.tableCell}>{formatStatusLabel(alert.status)}</Text>
              <Text style={styles.tableCell}>{formatDateTimeLabel(alert.createdAt)}</Text>
            </View>
          )),
        );
      default:
        return null;
    }
  };

  if (companyMobileLayoutDisabled) {
    return (
      <View style={styles.companyMobileFallback}>
        <Text style={styles.companyMobileFallbackTitle}>Company operations</Text>
        <Text style={styles.companyMobileFallbackBody}>
          The company dashboard is designed for tablet or desktop screens. For pilot testing, please open this app in a web browser on a larger display, or use a device at least {COMPANY_NATIVE_MIN_WIDTH}dp wide.
        </Text>
        {onLogout ? (
          <Pressable onPress={onLogout} accessibilityRole="button" style={{ marginTop: 20 }}>
            <Text style={styles.companyMobileFallbackLogout}>Log out</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.loadingShell}>
        <Text style={styles.loadingText}>Loading company operations workspace...</Text>
      </View>
    );
  }

  const activeNavItem = NAV_ITEMS.find((item) => item.id === activeSection);

  const handleNavigate = (section: CompanySection) => {
    if (section === 'coverage') setCoverageNavigationContext(undefined);
    setActiveSection(section);
  };

  return (
    <View style={styles.screen}>
      {/* ── Overlay nav (tablet / mobile web) ─────────────────────────────── */}
      {isOverlayNav && isMobileNavOpen ? (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setIsMobileNavOpen(false)}
          statusBarTranslucent
        >
          <View style={styles.navOverlay}>
            <Pressable
              style={styles.navBackdrop}
              onPress={() => setIsMobileNavOpen(false)}
              accessibilityLabel="Close navigation"
              accessibilityRole="button"
            />
            <View style={styles.navPanel}>
              <CompanySidebar
                activeId={activeSection}
                navItems={NAV_ITEMS}
                groups={COMPANY_NAV_GROUPS}
                onNavigate={(section) => {
                  handleNavigate(section);
                  setIsMobileNavOpen(false);
                }}
              />
            </View>
          </View>
        </Modal>
      ) : null}

      {/* ── Permanent sidebar (desktop / laptop) ──────────────────────────── */}
      {!isOverlayNav ? (
        <View style={[styles.sidebarShell, isSidebarCollapsed && styles.sidebarShellCollapsed]}>
          <CompanySidebar
            activeId={activeSection}
            navItems={NAV_ITEMS}
            groups={COMPANY_NAV_GROUPS}
            collapsed={isSidebarCollapsed}
            onToggleCollapse={() => setIsSidebarCollapsed((c) => !c)}
            onNavigate={handleNavigate}
          />
        </View>
      ) : null}

      {/* ── Content shell ─────────────────────────────────────────────────── */}
      <View style={styles.contentShell}>
        <CompanyTopBar
          pageTitle={activeNavItem?.label ?? 'Dashboard'}
          userEmail={user?.email ?? ''}
          onMenuAction={
            isOverlayNav
              ? () => setIsMobileNavOpen((o) => !o)
              : () => setIsSidebarCollapsed((c) => !c)
          }
          refreshing={refreshing}
          onRefresh={() => loadData(true)}
          onLogout={() => onLogout?.()}
        />

        <ScrollView
          ref={contentScrollRef}
          style={styles.content}
          contentContainerStyle={styles.contentContainer}
        >
          <PageHeader
            title={activeNavItem?.label ?? 'Dashboard'}
            description={activeNavItem?.caption}
          />

          {error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorTitle}>Action required</Text>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {renderContent()}
        </ScrollView>
      </View>
    </View>
  );
}

const webSelectStyle = {
  borderRadius: 14,
  borderWidth: 1,
  borderColor: colors.border,
  backgroundColor: colors.card,
  padding: '14px 16px',
  fontSize: 14,
  color: colors.primaryNavyStrong,
  minHeight: 48,
} as const;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: colors.surfaceSubtle,
    overflow: 'hidden',
    minHeight: 0,
  },
  // ── Permanent sidebar ─────────────────────────────────────────────────────
  sidebarShell: {
    width: 228,
    backgroundColor: colors.primaryNavy,
    overflow: 'hidden',
    minHeight: 0,
    flexShrink: 0,
  },
  sidebarShellCollapsed: {
    width: 64,
  },
  // ── Content column ────────────────────────────────────────────────────────
  contentShell: {
    flex: 1,
    flexDirection: 'column',
    overflow: 'hidden',
    minHeight: 0,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxxl,
    gap: spacing.xl,
  },
  // ── Overlay nav (tablet / mobile) ─────────────────────────────────────────
  navOverlay: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: 'rgba(11, 31, 51, 0.55)',
  },
  navBackdrop: {
    flex: 1,
  },
  navPanel: {
    width: 280,
    backgroundColor: colors.primaryNavy,
    overflow: 'hidden',
  },
  // ── Mobile fallback (native < 768dp) ──────────────────────────────────────
  companyMobileFallbackLogout: {
    color: colors.accentTeal,
    fontSize: 14,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  // ── Header styles preserved for internal section components ──────────────
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    paddingBottom: 18,
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148, 163, 184, 0.35)',
  },
  headerWeb: {
    paddingBottom: 22,
    marginBottom: 16,
    borderBottomColor: 'rgba(226, 232, 240, 0.95)',
  },
  headerLeft: {
    flex: 1,
    minWidth: 0,
    gap: 6,
    paddingRight: 8,
  },
  headerBrandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  headerBrandLogo: {
    width: 36,
    height: 36,
  },
  headerActions: {
    flexShrink: 0,
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 1.6,
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
  },
  headerTitle: {
    fontSize: 30,
    fontWeight: '900',
    color: colors.primaryNavy,
    letterSpacing: -0.4,
    lineHeight: 36,
  },
  headerTitleWeb: {
    fontSize: 34,
    lineHeight: 40,
    letterSpacing: -0.6,
  },
  headerContext: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '500',
    color: colors.textSecondary,
    maxWidth: 720,
  },
  headerRefreshButton: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.surfaceSubtle,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 11,
    shadowColor: colors.primaryNavy,
    shadowOpacity: 0.045,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  } as any,
  headerRefreshButtonHover: {
    borderColor: 'rgba(15, 23, 42, 0.14)',
    shadowOpacity: 0.08,
  } as any,
  headerRefreshButtonPressed: {
    opacity: 0.94,
  } as any,
  headerRefreshButtonText: {
    fontWeight: '800',
    fontSize: 13,
    letterSpacing: 0.2,
  },
  sectionStack: {
    gap: 28,
  },
  dashSectionShell: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.surfaceSubtle,
    padding: 22,
    shadowColor: colors.primaryNavy,
    shadowOpacity: 0.035,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  dashSectionShellWeb: {
    paddingVertical: 24,
    paddingHorizontal: 26,
    shadowOpacity: 0.045,
  },
  dashSectionHeader: {
    gap: 8,
    paddingBottom: 16,
    marginBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(226, 232, 240, 0.95)',
  },
  dashSectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.primaryNavy,
    letterSpacing: 0.1,
  },
  dashSectionSubtitle: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    lineHeight: 20,
    letterSpacing: 0.08,
    maxWidth: 720,
  },
  dashSectionBody: {
    gap: 20,
  },
  dashSectionBodyFlush: {
    marginTop: -2,
  },
  liveOpsToolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  liveOpsToolbarTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  liveOpsToolbarRefreshInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  liveOpsToolbarSync: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.pendingSurface,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
  },
  liveOpsToolbarSyncText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textSecondary,
    letterSpacing: 0.05,
  },
  liveOpsToolbarSyncHover: {
    borderColor: 'rgba(148, 163, 184, 0.55)',
    backgroundColor: colors.card,
  } as any,
  liveOpsToolbarSyncPressed: {
    opacity: 0.9,
  } as any,
  liveOpsUrgentRow: {
    paddingVertical: 13,
    borderBottomColor: 'rgba(254, 202, 202, 0.55)',
  },
  liveOpsUrgentRowBody: {
    gap: 8,
  },
  liveOpsUrgentIssue: {
    fontSize: 15,
    letterSpacing: 0.06,
    lineHeight: 21,
  },
  liveOpsUrgentMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600',
  },
  liveOpsUrgentMessage: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500',
  },
  liveOpsUrgentMetaFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 2,
  },
  liveOpsUrgentGuidance: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 140,
    color: colors.primaryNavySoft,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '700',
  },
  liveOpsUrgentOccurred: {
    flexShrink: 0,
    color: colors.neutralSlate,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
    letterSpacing: 0.05,
  },
  liveOpsUrgentActionBar: {
    marginTop: 4,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(254, 202, 202, 0.75)',
    alignItems: 'center',
  },
  liveOpsUrgentBtnPrimary: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  liveOpsUrgentBtnSecondary: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: colors.background,
  },
  liveOpsUrgentBtnPrimaryText: {
    fontSize: 13,
    fontWeight: '700',
  },
  liveOpsUrgentBtnSecondaryText: {
    fontSize: 13,
    fontWeight: '700',
  },
  liveOpsDetailEmpty: {
    paddingVertical: 10,
    paddingHorizontal: 2,
    gap: 6,
  },
  liveOpsDetailEmptyTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primaryNavy,
    letterSpacing: 0.02,
  },
  liveOpsDetailEmptyDesc: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '500',
    color: colors.textSecondary,
    maxWidth: 520,
  },
  liveOpsUrgentInset: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.dangerSurface,
    backgroundColor: colors.dangerSurface,
    padding: 16,
    gap: 12,
  },
  liveOpsSideRailIntro: {
    gap: 6,
    marginBottom: 4,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(226, 232, 240, 0.85)',
  },
  liveOpsSideRailEyebrow: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.14,
    textTransform: 'uppercase',
    color: colors.textSecondary,
  },
  liveOpsSideRailHint: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500',
    color: colors.textSecondary,
    maxWidth: 420,
  },
  liveOpsFilterStack: {
    gap: 14,
  },
  liveOpsFilterGroup: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.surfaceSubtle,
    backgroundColor: colors.background,
    padding: 14,
    gap: 8,
  },
  liveOpsFilterGroupWeb: {
    paddingVertical: 16,
    paddingHorizontal: 16,
  } as any,
  liveOpsFilterGroupLabel: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.1,
    color: colors.primaryNavy,
  },
  liveOpsFilterGroupHint: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '500',
    color: colors.textSecondary,
    marginTop: -2,
  },
  liveOpsFilterGroupRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    alignItems: 'flex-end',
  },
  liveOpsFilterField: {
    gap: 6,
    minWidth: 0,
  },
  liveOpsFilterFieldGrow: {
    flexGrow: 1,
    flexBasis: 168,
    minWidth: 148,
  },
  liveOpsFilterDateSlot: {
    flexGrow: 1,
    flexBasis: 200,
    minWidth: 160,
    maxWidth: 280,
  },
  liveOpsFilterFieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.08,
    textTransform: 'uppercase',
    color: colors.textSecondary,
  },
  liveOpsFilterTextInput: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.surfaceSubtle,
    backgroundColor: colors.card,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 14,
    color: colors.primaryNavyStrong,
    width: '100%' as any,
  },
  liveOpsFilterWebSelectChrome: {
    borderColor: colors.surfaceSubtle,
    width: '100%' as any,
    boxSizing: 'border-box' as any,
  } as any,
  liveOpsChromeInputBorder: {
    borderColor: colors.surfaceSubtle,
  },
  liveOpsBoardWrap: {
    alignSelf: 'stretch',
  },
  liveOpsBoardCard: {
    alignSelf: 'stretch',
  },
  liveOpsSideCard: {
    alignSelf: 'stretch',
    width: '100%',
  },
  liveOpsSideColumn: {
    gap: 16,
  },
  liveOpsListRowSide: {
    gap: 7,
    paddingVertical: 11,
    borderBottomColor: 'rgba(226, 232, 240, 0.78)',
  },
  liveOpsListRowSideWeb: {
    paddingVertical: 13,
    paddingHorizontal: 10,
  } as any,
  liveOpsRowTitleSide: {
    color: colors.primaryNavy,
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 0.06,
    lineHeight: 20,
  },
  liveOpsRowMetaSide: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500',
  },
  liveOpsSideRowMessage: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500',
  },
  liveOpsSideRowTimestamp: {
    color: colors.neutralSlate,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
    letterSpacing: 0.06,
    marginTop: 2,
  },
  liveOpsListRow: {
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(226, 232, 240, 0.88)',
  },
  liveOpsListRowWeb: {
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderBottomColor: 'rgba(226, 232, 240, 0.8)',
  } as any,
  liveOpsListRowLast: {
    borderBottomWidth: 0,
    paddingBottom: 6,
  },
  liveOpsRowTitle: {
    color: colors.primaryNavy,
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 0.05,
    lineHeight: 20,
  },
  liveOpsRowMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500',
  },
  liveOpsNextAction: {
    color: colors.primaryNavy,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
    letterSpacing: 0.02,
  },
  liveOpsSelectedInset: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(37, 99, 235, 0.22)',
    backgroundColor: 'rgba(239, 246, 255, 0.55)',
    padding: 18,
    gap: 12,
  },
  liveOpsSelectedInsetWeb: {
    padding: 22,
    gap: 14,
  } as any,
  liveOpsSelectedHeader: {
    gap: 8,
    paddingBottom: 16,
    marginBottom: 2,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(226, 232, 240, 0.95)',
  },
  liveOpsSelectedSummaryLine: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '500',
  },
  liveOpsSelectedInstructions: {
    color: colors.primaryNavySoft,
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '500',
    marginTop: 4,
  },
  liveOpsSelectedBadgeRow: {
    alignSelf: 'flex-start',
    marginTop: 4,
    marginBottom: 2,
  },
  liveOpsDetailTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: colors.primaryNavy,
    letterSpacing: 0.25,
    lineHeight: 24,
  },
  liveOpsDetailGrid: {
    gap: 18,
    marginTop: 8,
  },
  liveOpsDetailCard: {
    padding: 18,
    gap: 10,
    borderRadius: 16,
  },
  liveOpsDetailSectionTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.14,
    textTransform: 'uppercase',
    color: colors.textSecondary,
    marginBottom: 2,
  },
  liveOpsDetailTileLine: {
    color: colors.primaryNavySoft,
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '500',
  },
  liveOpsDetailListLine: {
    color: colors.primaryNavySoft,
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '500',
    paddingVertical: 8,
    paddingLeft: 12,
    marginLeft: 2,
    borderLeftWidth: 2,
    borderLeftColor: colors.pendingSurface,
  },
  dashLivePanelCard: {
    flex: 1,
    alignSelf: 'stretch',
    minHeight: 112,
  },
  sectionTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.primaryNavy,
  },
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 18,
  },
  kpiCell: {
    minWidth: 220,
    flexGrow: 1,
    flexBasis: 240,
    maxWidth: 320,
    alignSelf: 'stretch',
  },
  panelCell: {
    minWidth: 320,
    flexGrow: 1,
    flexBasis: 380,
    maxWidth: 620,
  },
  kpiCard: {
    minWidth: 180,
    flexGrow: 1,
    backgroundColor: colors.card,
    borderRadius: 22,
    padding: 20,
  },
  kpiLabel: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  kpiValue: {
    color: colors.primaryNavy,
    fontSize: 32,
    fontWeight: '800',
    marginTop: 10,
  },
  panelGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 22,
  },
  panel: {
    flexGrow: 1,
    minWidth: 320,
    backgroundColor: colors.card,
    borderRadius: 22,
    padding: 20,
    gap: 12,
  },
  priorityPanel: {
    shadowColor: colors.primaryNavy,
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  urgentPanel: {
    borderWidth: 1,
    borderColor: colors.dangerSurface,
    backgroundColor: colors.dangerSurface,
  },
  selectedShiftPanel: {
    borderWidth: 1,
    borderColor: colors.infoSurface,
  },
  secondaryPanel: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.pendingSurface,
  },
  panelTitle: {
    color: colors.primaryNavy,
    fontSize: 20,
    fontWeight: '800',
  },
  secondaryPanelTitle: {
    fontSize: 18,
    color: colors.primaryNavySoft,
  },
  panelTitleInline: {
    marginTop: 12,
  },
  splitLayout: {
    flexDirection: 'row',
    gap: 20,
    alignItems: 'flex-start',
  },
  tableCard: {
    flex: 2,
    backgroundColor: colors.card,
    borderRadius: 22,
    padding: 20,
    gap: 10,
  },
  operationsBoardCard: {
    flex: 2.2,
    minWidth: 760,
  },
  operationsSideColumn: {
    flex: 1,
    minWidth: 320,
    gap: 18,
  },
  formCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 22,
    padding: 20,
    gap: 12,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  toolbarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  filterBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  input: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.primaryNavyStrong,
    minWidth: 160,
  },
  textArea: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  textAreaSmall: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  formRow: {
    flexDirection: 'row',
    gap: 12,
  },
  formCell: {
    flex: 1,
  },
  inputGroup: {
    flex: 1,
    gap: 6,
  },
  formActions: {
    flexDirection: 'row',
    gap: 12,
  },
  primaryButton: {
    backgroundColor: colors.primaryNavy,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: colors.background,
    fontWeight: '700',
  },
  secondaryButton: {
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.pendingSurface,
  },
  secondaryButtonText: {
    color: colors.primaryNavy,
    fontWeight: '700',
  },
  ghostButton: {
    alignSelf: 'flex-end',
    paddingVertical: 8,
  },
  ghostButtonText: {
    color: colors.danger,
    fontWeight: '700',
  },
  tableHeader: {
    flexDirection: 'row',
    gap: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.pendingSurface,
  },
  tableHeaderText: {
    flex: 1,
    color: colors.textSecondary,
    fontWeight: '700',
    fontSize: 12,
    textTransform: 'uppercase',
  },
  liveBoardScroll: {
    marginHorizontal: -2,
  } as any,
  liveBoardScrollContent: {
    minWidth: 860,
    paddingBottom: 4,
    paddingRight: 2,
  },
  liveBoardScrollContentWeb: {
    minWidth: 1200,
  } as any,
  liveBoardTableHeader: {
    alignItems: 'flex-end',
    paddingBottom: 12,
    borderBottomColor: 'rgba(226, 232, 240, 0.95)',
    gap: 10,
  },
  liveBoardHdrText: {
    color: colors.textSecondary,
    fontWeight: '800',
    fontSize: 11,
    letterSpacing: 0.12,
    textTransform: 'uppercase',
    lineHeight: 14,
  },
  liveBoardColShift: {
    flex: 4,
    minWidth: 56,
    maxWidth: 80,
  },
  liveBoardColSite: {
    flex: 22,
    minWidth: 148,
    flexShrink: 1,
  },
  liveBoardColGuard: {
    flex: 14,
    minWidth: 108,
    flexShrink: 1,
  },
  liveBoardColStatus: {
    flex: 7,
    minWidth: 84,
    maxWidth: 112,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingTop: 2,
  },
  liveBoardColRisk: {
    flex: 11,
    minWidth: 96,
    flexShrink: 1,
  },
  liveBoardColDelay: {
    flex: 10,
    minWidth: 88,
    flexShrink: 0,
  },
  liveBoardColBookOn: {
    flex: 7,
    minWidth: 72,
    flexShrink: 0,
  },
  liveBoardColBookOff: {
    flex: 7,
    minWidth: 72,
    flexShrink: 0,
  },
  liveBoardColLastCheck: {
    flex: 10,
    minWidth: 100,
    flexShrink: 0,
  },
  liveBoardColLogs: {
    flex: 4,
    minWidth: 44,
    maxWidth: 56,
    flexShrink: 0,
  },
  liveBoardColIncidents: {
    flex: 4,
    minWidth: 44,
    maxWidth: 56,
    flexShrink: 0,
  },
  liveBoardColPanic: {
    flex: 7,
    minWidth: 72,
    flexShrink: 0,
  },
  liveBoardColTimesheet: {
    flex: 9,
    minWidth: 86,
    flexShrink: 0,
  },
  liveBoardColAction: {
    flex: 11,
    minWidth: 116,
    maxWidth: 200,
    alignItems: 'flex-start',
    paddingTop: 2,
  },
  liveBoardTableRow: {
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 12,
  },
  liveBoardCellCol: {
    gap: 4,
    minWidth: 0,
  },
  liveBoardCellBody: {
    color: colors.primaryNavySoft,
    fontSize: 13,
    lineHeight: 18,
  },
  liveBoardShiftId: {
    color: colors.primaryNavy,
    fontWeight: '800',
    fontSize: 13,
    lineHeight: 18,
  },
  liveBoardSiteTitle: {
    color: colors.primaryNavy,
    fontWeight: '700',
    fontSize: 13,
    lineHeight: 18,
  },
  liveBoardSiteRisk: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '500',
  },
  liveBoardTableRowSelected: {
    backgroundColor: colors.background,
    borderRadius: 12,
    paddingHorizontal: 6,
  },
  liveBoardActionButton: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  tableRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.pendingSurface,
  },
  liveBoardRow: {
    cursor: 'pointer',
  },
  liveBoardRowHighlighted: {
    borderWidth: 2,
    borderColor: colors.info,
    borderRadius: 14,
  },
  tableRowSelected: {
    backgroundColor: colors.background,
    borderRadius: 14,
    paddingHorizontal: 10,
  },
  tableCell: {
    flex: 1,
    color: colors.primaryNavySoft,
  },
  tableCellStrong: {
    flex: 1,
    color: colors.primaryNavy,
    fontWeight: '700',
  },
  rowActions: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  offerRow: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 10,
  },
  offerRowSummary: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  offerRowActions: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  offerReassignBox: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  recordRow: {
    gap: 4,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.background,
  },
  recordRowHover: {
    backgroundColor: 'rgba(15, 23, 42, 0.03)',
    borderRadius: 12,
    paddingHorizontal: 10,
  },
  recordRowWebHover: {
    backgroundColor: 'rgba(15, 23, 42, 0.045)',
    borderRadius: 12,
  } as any,
  recordRowPressed: {
    backgroundColor: 'rgba(15, 23, 42, 0.05)',
  },
  recordTitle: {
    color: colors.primaryNavy,
    fontWeight: '700',
  },
  recordMeta: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  dashListRow: {
    gap: 6,
    paddingVertical: 13,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(226, 232, 240, 0.88)',
  },
  dashListRowWeb: {
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderBottomColor: 'rgba(226, 232, 240, 0.8)',
  } as any,
  dashListRowLast: {
    borderBottomWidth: 0,
    paddingBottom: 6,
  },
  dashListRowTitle: {
    color: colors.primaryNavy,
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 0.05,
    lineHeight: 20,
  },
  dashListRowMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500',
  },
  dashListRowHovered: {
    backgroundColor: 'rgba(15, 23, 42, 0.032)',
    borderRadius: 12,
  },
  dashListRowWebHover: {
    backgroundColor: 'rgba(15, 23, 42, 0.045)',
  } as any,
  dashListRowPressed: {
    backgroundColor: 'rgba(15, 23, 42, 0.055)',
    borderRadius: 12,
  },
  actionRequiredAnchor: {
    borderRadius: 18,
    padding: IS_WEB ? 6 : 6,
  },
  actionRequiredAnchorClear: {
    backgroundColor: 'rgba(16, 185, 129, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.22)',
    shadowColor: colors.primaryNavy,
    shadowOpacity: 0.045,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  actionRequiredAnchorActive: {
    backgroundColor: 'rgba(254, 243, 199, 0.35)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    shadowColor: colors.primaryNavy,
    shadowOpacity: 0.055,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  actionRequiredCard: {
    borderRadius: 18,
  },
  actionRequiredList: {
    gap: 12,
  },
  actionRequiredListInnerClear: {
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(16, 185, 129, 0.22)',
    backgroundColor: 'rgba(255, 255, 255, 0.65)',
  },
  actionRequiredListInnerActive: {
    padding: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(248, 250, 252, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(226, 232, 240, 0.9)',
  },
  actionRequiredRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  actionRequiredRowCool: {
    backgroundColor: colors.card,
    borderColor: colors.pendingSurface,
  },
  actionRequiredRowAttention: {
    backgroundColor: 'rgba(254, 242, 242, 0.85)',
    borderColor: 'rgba(239, 68, 68, 0.28)',
  },
  actionRequiredRowWarn: {
    backgroundColor: 'rgba(255, 247, 237, 0.95)',
    borderColor: 'rgba(249, 115, 22, 0.28)',
  },
  actionRequiredRowHover: {
    shadowColor: colors.primaryNavy,
    shadowOpacity: 0.05,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    transform: [{ translateY: -1 }],
  },
  actionRequiredRowWebHover: {
    borderColor: 'rgba(15, 23, 42, 0.14)',
    shadowOpacity: 0.08,
  } as any,
  actionRequiredRowPressed: {
    transform: [{ translateY: 0 }],
  },
  actionRequiredAccent: {
    width: 4,
    alignSelf: 'stretch',
    backgroundColor: colors.pendingSurface,
  },
  actionRequiredAccentMuted: {
    backgroundColor: colors.pendingSurface,
  },
  actionRequiredAccentBarAttention: {
    backgroundColor: colors.danger,
  },
  actionRequiredAccentBarWarning: {
    backgroundColor: colors.warning,
  },
  actionRequiredRowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    minHeight: 70,
  },
  actionRequiredLeft: {
    flex: 1,
    gap: 5,
    paddingRight: 8,
    minWidth: 0,
  },
  actionRequiredRight: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 6,
    flexShrink: 0,
  },
  actionRequiredTitle: {
    color: colors.primaryNavy,
    fontWeight: '900',
    fontSize: 15,
    letterSpacing: 0.1,
    lineHeight: 20,
  },
  actionRequiredTitleHot: {
    color: colors.danger,
  },
  actionRequiredDescription: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500',
    marginTop: 1,
  },
  actionRequiredCountBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderWidth: 1,
    minWidth: 56,
  },
  actionRequiredCountBadgeCool: {
    backgroundColor: colors.background,
    borderColor: colors.pendingSurface,
  },
  actionRequiredCountBadgeHot: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderColor: 'rgba(239, 68, 68, 0.22)',
  },
  actionRequiredCount: {
    color: colors.primaryNavy,
    fontWeight: '900',
    fontSize: 13,
    letterSpacing: 0.2,
  },
  actionRequiredCountHot: {
    color: colors.danger,
  },
  actionRequiredCtaWrap: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(37, 99, 235, 0.22)',
    backgroundColor: 'rgba(37, 99, 235, 0.06)',
  },
  actionRequiredCta: {
    color: colors.info,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.2,
  },
  helperText: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  urgentItemActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  nextActionText: {
    color: colors.primaryNavy,
    fontSize: 13,
    fontWeight: '700',
  },
  statusBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  subtleLabel: {
    color: colors.textSecondary,
    fontWeight: '700',
    fontSize: 13,
  },
  weekGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  dayCard: {
    width: '48%',
    minWidth: 320,
    backgroundColor: colors.card,
    borderRadius: 22,
    padding: 18,
    gap: 12,
  },
  dayCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dayCardTitle: {
    color: colors.primaryNavy,
    fontSize: 18,
    fontWeight: '800',
  },
  dayCardMeta: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  plannerRow: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.pendingSurface,
    padding: 14,
    gap: 10,
  },
  detailGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    marginTop: 16,
  },
  detailCard: {
    minWidth: 260,
    flexGrow: 1,
    backgroundColor: colors.background,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.surfaceSubtle,
    padding: 16,
    gap: 8,
  },
  detailTitle: {
    color: colors.primaryNavy,
    fontWeight: '800',
    fontSize: 16,
  },
  closeOutCard: {
    backgroundColor: colors.background,
  },
  closeOutNotesSection: {
    gap: 8,
    marginTop: 8,
  },
  closeOutStatusGood: {
    color: colors.success,
  },
  closeOutStatusAttention: {
    color: colors.warning,
  },
  errorCard: {
    backgroundColor: colors.dangerSurface,
    borderRadius: 18,
    padding: 16,
    gap: 4,
  },
  errorTitle: {
    color: colors.danger,
    fontWeight: '800',
  },
  errorText: {
    color: colors.danger,
  },
  feedbackCard: {
    borderRadius: 18,
    padding: 16,
    gap: 4,
  },
  feedbackCardSuccess: {
    backgroundColor: colors.successSurface,
  },
  feedbackCardError: {
    backgroundColor: colors.dangerSurface,
  },
  feedbackTitle: {
    fontWeight: '800',
  },
  feedbackTitleSuccess: {
    color: colors.success,
  },
  feedbackTitleError: {
    color: colors.danger,
  },
  feedbackText: {
    fontSize: 14,
  },
  feedbackTextSuccess: {
    color: colors.success,
  },
  feedbackTextError: {
    color: colors.danger,
  },
  companyMobileFallback: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
    backgroundColor: colors.background,
    gap: 16,
  },
  companyMobileFallbackTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  companyMobileFallbackBody: {
    fontSize: 16,
    lineHeight: 24,
    color: colors.textSecondary,
  },
  loadingShell: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.surfaceSubtle,
  },
  loadingText: {
    color: colors.primaryNavy,
    fontSize: 16,
    fontWeight: '700',
  },
  dashEmptyWrap: {
    paddingVertical: 18,
    paddingHorizontal: 4,
    gap: 8,
    alignItems: 'flex-start',
  },
  dashEmptyTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.primaryNavy,
    letterSpacing: 0.1,
  },
  dashEmptyDesc: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.textSecondary,
    fontWeight: '500',
    maxWidth: 520,
  },
  dashEmptyCta: {
    marginTop: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(37, 99, 235, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(37, 99, 235, 0.22)',
  },
  dashEmptyCtaWebHover: {
    backgroundColor: 'rgba(37, 99, 235, 0.11)',
    borderColor: 'rgba(29, 78, 216, 0.35)',
  } as any,
  dashEmptyCtaWebPressed: {
    opacity: 0.92,
  } as any,
  dashEmptyCtaText: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.info,
  },
  dashKpiStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  dashKpiStripCell: {
    flexGrow: 1,
    flexBasis: 160,
    minWidth: 140,
    maxWidth: 260,
    alignSelf: 'stretch',
  },
  dashAttentionPanel: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  dashAttentionHeader: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 4,
  },
  dashAttentionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.primaryNavy,
    letterSpacing: -0.1,
  },
  dashAttentionSubtitle: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    lineHeight: 19,
  },
  dashAttentionEmpty: {
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  dashAttentionEmptyText: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  dashAttentionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(226, 232, 240, 0.88)',
    paddingRight: 16,
  },
  dashAttentionItemLast: {
    borderBottomWidth: 0,
  },
  dashAttentionItemHover: {
    backgroundColor: 'rgba(15, 23, 42, 0.028)',
  },
  dashAttentionItemPressed: {
    backgroundColor: 'rgba(15, 23, 42, 0.05)',
  },
  dashAttentionBar: {
    width: 4,
    alignSelf: 'stretch',
    minHeight: 52,
  },
  dashAttentionBarRed: {
    backgroundColor: colors.danger,
  },
  dashAttentionBarAmber: {
    backgroundColor: colors.warning,
  },
  dashAttentionBarBlue: {
    backgroundColor: colors.info,
  },
  dashAttentionItemBody: {
    flex: 1,
    gap: 3,
    paddingVertical: 13,
  },
  dashAttentionItemLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.primaryNavy,
    lineHeight: 20,
  },
  dashAttentionItemMeta: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textSecondary,
    lineHeight: 17,
  },
  dashAttentionSeverityBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    flexShrink: 0,
  },
  dashAttentionSeverityRed: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurface,
  },
  dashAttentionSeverityAmber: {
    borderColor: colors.warningBorder,
    backgroundColor: colors.warningSurface,
  },
  dashAttentionSeverityBlue: {
    borderColor: 'rgba(29, 78, 216, 0.3)',
    backgroundColor: colors.infoSurface,
  },
  dashAttentionSeverityText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  } as any,
  dashAttentionSeverityTextRed: {
    color: colors.danger,
  },
  dashAttentionSeverityTextAmber: {
    color: colors.warning,
  },
  dashAttentionSeverityTextBlue: {
    color: colors.info,
  },
  dashAttentionCta: {
    fontSize: 16,
    color: colors.textSecondary,
    flexShrink: 0,
  },
  dashAttentionViewAll: {
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderTopWidth: 1,
    borderTopColor: 'rgba(226, 232, 240, 0.88)',
  },
  dashAttentionViewAllText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.accentTeal,
    letterSpacing: 0.1,
  },
  dashRow3: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 22,
  },
  dashRow3Main: {
    flexGrow: 2,
    flexBasis: 440,
    minWidth: 280,
  },
  dashRow3Side: {
    flexGrow: 1,
    flexBasis: 200,
    minWidth: 200,
  },
  dashLiveRowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dashLiveRowLeft: {
    flex: 1,
    gap: 3,
  },
  dashLiveRowStatus: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    flexShrink: 0,
  } as any,
  dashCoverageStats: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  dashCoverageStat: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 16,
    gap: 4,
  },
  dashCoverageStatValue: {
    fontSize: 32,
    fontWeight: '800',
    color: colors.primaryNavy,
    letterSpacing: -0.5,
  },
  dashCoverageStatValueWarn: {
    color: colors.warning,
  },
  dashCoverageStatLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  } as any,
  dashCoverageDivider: {
    width: 1,
    backgroundColor: colors.border,
    marginVertical: 12,
  },
  dashCoverageAction: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: 'rgba(11, 31, 51, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(11, 31, 51, 0.1)',
    marginTop: 4,
    alignItems: 'center',
  },
  dashCoverageActionHover: {
    backgroundColor: 'rgba(11, 31, 51, 0.07)',
  },
  dashCoverageActionPressed: {
    opacity: 0.85,
  },
  dashCoverageActionText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primaryNavy,
  },
  dashRow4: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 22,
  },
  dashRow4Cell: {
    flexGrow: 1,
    flexBasis: 260,
    minWidth: 220,
  },
  dashComplianceStats: {
    flexDirection: 'row',
    marginBottom: 14,
  },
  dashComplianceStat: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    gap: 4,
  },
  dashComplianceStatValid: {
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  dashComplianceStatExpiring: {
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  dashComplianceStatValue: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.primaryNavy,
    letterSpacing: -0.3,
  },
  dashComplianceStatValueWarning: {
    color: colors.warning,
  },
  dashComplianceStatValueDanger: {
    color: colors.danger,
  },
  dashComplianceStatLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  } as any,
});

const LIVE_SHIFT_BOARD_COLUMN_LABELS = [
  'Shift',
  'Site',
  'Guard',
  'Status',
  'Risk',
  'Delay',
  'Book On',
  'Book Off',
  'Last Check Call',
  'Logs',
  'Incidents',
  'Panic / Welfare',
  'Timesheet',
  'Action',
] as const;

const LIVE_BOARD_COL_STYLES = [
  styles.liveBoardColShift,
  styles.liveBoardColSite,
  styles.liveBoardColGuard,
  styles.liveBoardColStatus,
  styles.liveBoardColRisk,
  styles.liveBoardColDelay,
  styles.liveBoardColBookOn,
  styles.liveBoardColBookOff,
  styles.liveBoardColLastCheck,
  styles.liveBoardColLogs,
  styles.liveBoardColIncidents,
  styles.liveBoardColPanic,
  styles.liveBoardColTimesheet,
  styles.liveBoardColAction,
];

function LiveShiftBoardTableHeader() {
  return (
    <View style={[styles.tableHeader, styles.liveBoardTableHeader]}>
      {LIVE_SHIFT_BOARD_COLUMN_LABELS.map((label, index) => (
        <Text key={label} style={[styles.liveBoardHdrText, LIVE_BOARD_COL_STYLES[index]]}>
          {label}
        </Text>
      ))}
    </View>
  );
}

function LiveOpsDetailEmpty({ title, description }: { title: string; description: string }) {
  return (
    <View style={styles.liveOpsDetailEmpty}>
      <Text style={styles.liveOpsDetailEmptyTitle}>{title}</Text>
      <Text style={styles.liveOpsDetailEmptyDesc}>{description}</Text>
    </View>
  );
}

type DashboardSectionProps = React.PropsWithChildren<{
  title?: string;
  subtitle?: string;
}>;

function DashboardSection({ title, subtitle, children }: DashboardSectionProps) {
  const showHeader = Boolean((title && title.trim()) || (subtitle && subtitle.trim()));

  return (
    <View style={[styles.dashSectionShell, IS_WEB ? styles.dashSectionShellWeb : null]}>
      {showHeader ? (
        <View style={styles.dashSectionHeader}>
          {title ? <Text style={styles.dashSectionTitle}>{title}</Text> : null}
          {subtitle ? <Text style={styles.dashSectionSubtitle}>{subtitle}</Text> : null}
        </View>
      ) : null}
      <View style={[styles.dashSectionBody, !showHeader ? styles.dashSectionBodyFlush : null]}>{children}</View>
    </View>
  );
}

type DashboardPanelEmptyProps = {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
};

function DashboardPanelEmpty({ title, description, actionLabel, onAction }: DashboardPanelEmptyProps) {
  return (
    <View style={styles.dashEmptyWrap}>
      <Text style={styles.dashEmptyTitle}>{title}</Text>
      <Text style={styles.dashEmptyDesc}>{description}</Text>
      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          style={({ hovered, pressed }: any) => [
            styles.dashEmptyCta,
            hovered && IS_WEB ? styles.dashEmptyCtaWebHover : null,
            pressed && IS_WEB ? styles.dashEmptyCtaWebPressed : null,
            WEB_POINTER_STYLE,
          ]}
        >
          <Text style={styles.dashEmptyCtaText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

