import * as React from 'react';
import { Fragment } from 'react/jsx-runtime';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radii, spacing } from '../../theme';
import { DailyLog, Incident, SafetyAlert, Shift, Timesheet } from '../../types/models';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;
const UK_LOCALE = 'en-GB';
const MISSED_GRACE = 15;

// ─── Shift status options (must match CompanyDashboardScreen) ──────────────────
const SHIFT_STATUS_OPTS = [
  { label: 'Unfilled',    value: 'unfilled' },
  { label: 'Offered',     value: 'offered' },
  { label: 'Ready',       value: 'ready' },
  { label: 'Missed',      value: 'missed' },
  { label: 'Cancelled',   value: 'cancelled' },
  { label: 'Rejected',    value: 'rejected' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed',   value: 'completed' },
];

// ─── Locally-declared types (structurally match CompanyDashboardScreen locals) ─

type UrgentCategory =
  | 'panic'
  | 'incident'
  | 'late_start'
  | 'missed_check_call'
  | 'rejected_offer'
  | 'safety'
  | 'upcoming_risk'
  | 'missed_shift'
  | 'uncovered_shift';

export type UrgentOperationalItem = {
  id: string;
  shiftId?: number | null;
  incidentId?: number | null;
  alertId?: number | null;
  status?: string | null;
  siteName: string;
  guardName: string;
  category: UrgentCategory;
  issueType: string;
  message: string;
  occurredAt: string;
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

export type LiveFilters = {
  clientId: string;
  siteId: string;
  guardId: string;
  date: string;
  status: string;
};

// ─── Exported pre-computed data types ─────────────────────────────────────────

export type LiveBoardRow = {
  shift: Shift;
  attendance: { checkInAt: string | null; checkOutAt: string | null } | undefined;
  timesheet: Timesheet | undefined;
  shiftLogs: DailyLog[];
  shiftIncidents: Incident[];
  shiftAlerts: SafetyAlert[];
  lastCheckCall: DailyLog | undefined;
  panicOrWelfareCount: number;
  lifecycleStatus: string;
  risk: { level: 'high' | 'medium' | 'low'; label: string; color: string };
  delay: number | null;
  likelyLate: boolean;
  siteRiskLabel: string;
  primaryActionLabel: string;
  rowTone: string;
};

export type CloseOutSummary = {
  scheduledStart: string;
  scheduledEnd: string;
  actualCheckInAt: string | null;
  actualCheckOutAt: string | null;
  logsCount: number;
  incidentsCount: number;
  safetyEventsCount: number;
  completedCheckCalls: number;
  missedCheckCalls: number;
  timesheetStatus: string;
  unresolvedFollowUpCount: number;
  closedCleanly: boolean;
};

export type SelectedShiftContext = {
  shift: Shift;
  attendance: { checkInAt: string | null; checkOutAt: string | null } | undefined;
  timesheet: Timesheet | undefined;
  logs: DailyLog[];
  incidents: Incident[];
  alerts: SafetyAlert[];
  lifecycleStatus: string;
  badge: { label: string; color: string; icon: string };
  exception: { title: string; message: string; outcome: string } | null;
  clientName: string;
};

export type CompanyLiveOperationsWorkspaceProps = {
  // Status counts
  liveShiftsCount: number;
  guardsNotBookedOnCount: number;
  activePanicAlertsCount: number;
  openIncidentsCount: number;
  missedCheckCallsCount: number;
  // Urgent queue
  urgentOperationalItems: UrgentOperationalItem[];
  urgentActionItemId: string | null;
  liveOperationsFeedback: { tone: 'success' | 'error'; message: string } | null;
  // Board
  liveOperationEnrichedRows: LiveBoardRow[];
  selectedShiftId: number | null;
  setSelectedShiftId: (id: number) => void;
  highlightedLiveShiftId: number | null;
  // Filters
  liveFilters: LiveFilters;
  setLiveFilters: React.Dispatch<React.SetStateAction<LiveFilters>>;
  siteClientOptions: Array<{ value: string; label: string }>;
  siteOptions: Array<{ value: string; label: string }>;
  linkedGuardOptions: Array<{ value: string; label: string }>;
  // Lower strip
  uncoveredShiftCount: number;
  recentOperationalActivity: OperationalActivityItem[];
  // Detail panel
  selectedShiftContext: SelectedShiftContext | null;
  selectedShiftCloseOutSummary: CloseOutSummary | null;
  closeOutNotesDraft: string;
  setCloseOutNotesDraft: (text: string) => void;
  savingCloseOutNotes: boolean;
  // Action handlers
  refreshing: boolean;
  onLiveBoardPrimaryAction: (shift: Shift) => void;
  onOpenUrgentDetail: (item: UrgentOperationalItem) => void;
  onOpenUrgentShift: (item: UrgentOperationalItem) => void;
  onUrgentIncidentFollowUp: (item: UrgentOperationalItem, status: 'in_review' | 'resolved') => Promise<void>;
  onUrgentAlertFollowUp: (item: UrgentOperationalItem, action: 'acknowledge' | 'close') => Promise<void>;
  onSaveCloseOutNotes: () => void;
  onOpenCoverage: (context?: { uncoveredOnly?: boolean; shiftId?: number }) => void;
  // Layout anchors
  onBoardLayout: (y: number) => void;
  onDetailLayout: (y: number) => void;
};

// ─── Pure helpers (duplicated for component isolation) ────────────────────────

function fmtTime(value?: string | null): string {
  if (!value) return '—';
  if (/^\d{2}:\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/);
  if (match?.[4] && match?.[5]) return `${match[4]}:${match[5]}`;
  const d = new Date(value);
  if (!isNaN(d.getTime())) return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  return value;
}

function fmtDateTime(value?: string | null): string {
  if (!value) return 'Not recorded';
  const d = new Date(value);
  return isNaN(d.getTime())
    ? value
    : d.toLocaleString(UK_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtStatus(value?: string | null): string {
  if (!value) return 'Unknown';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function fmtDate(value?: string | null): string {
  if (!value) return 'Not set';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toLocaleDateString(UK_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function normalizeLifecycle(value?: string | null): string {
  const n = (value || '').trim().toLowerCase();
  if (['planned', 'unassigned', 'scheduled'].includes(n)) return 'unfilled';
  if (n === 'assigned') return 'offered';
  if (n === 'accepted') return 'ready';
  return n || 'unfilled';
}

function getStatusBadge(status: string): { label: string; color: string; icon: string } {
  switch (normalizeLifecycle(status)) {
    case 'missed':      return { label: 'Missed',     color: colors.warning,         icon: '⚠️' };
    case 'offered':     return { label: 'Offered',    color: colors.info,            icon: '🔵' };
    case 'ready':       return { label: 'Ready',      color: colors.warning,         icon: '🟡' };
    case 'in_progress': return { label: 'Live',       color: colors.success,         icon: '🟢' };
    case 'completed':   return { label: 'Completed',  color: colors.primaryNavySoft, icon: '⚫' };
    case 'rejected':    return { label: 'Rejected',   color: colors.danger,          icon: '🔴' };
    case 'cancelled':   return { label: 'Cancelled',  color: colors.neutralSlate,    icon: '⚫' };
    default:            return { label: 'Unfilled',   color: colors.textSecondary,   icon: '⚪' };
  }
}

function getExceptionSummary(status?: string | null): { title: string; message: string; outcome: string } | null {
  switch (normalizeLifecycle(status || 'unfilled')) {
    case 'missed':
      return {
        title: 'Missed check-in exception',
        message: `No attendance check-in was recorded within ${MISSED_GRACE} minutes of shift start.`,
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

function getAttentionSeverity(category: UrgentCategory): 'red' | 'amber' | 'blue' {
  if (['panic', 'incident', 'missed_shift'].includes(category)) return 'red';
  if (['late_start', 'missed_check_call', 'uncovered_shift', 'rejected_offer', 'safety'].includes(category)) return 'amber';
  return 'blue';
}

function getAttentionLabel(category: UrgentCategory): string {
  switch (category) {
    case 'panic':            return 'Critical';
    case 'incident':         return 'Incident';
    case 'late_start':       return 'Late start';
    case 'missed_check_call':return 'Miss check';
    case 'rejected_offer':   return 'Rejected';
    case 'safety':           return 'Welfare';
    case 'upcoming_risk':    return 'Risk shift';
    case 'missed_shift':     return 'Missed';
    case 'uncovered_shift':  return 'Coverage gap';
    default:                 return 'Alert';
  }
}

function getUrgentPrimaryLabel(item: UrgentOperationalItem): string {
  switch (item.category) {
    case 'rejected_offer':
    case 'missed_shift':    return 'Open Re-cover';
    case 'incident':        return 'View Incident';
    case 'panic':           return item.status === 'acknowledged' ? 'Resolve Alert' : 'View Alert';
    case 'missed_check_call': return item.status === 'acknowledged' ? 'Close Follow-up' : 'View Safety Detail';
    case 'safety':          return item.status === 'acknowledged' ? 'Close Alert' : 'View Safety Detail';
    default:                return 'Open Shift';
  }
}

// ─── WebSelect (compact, filter-bar variant) ──────────────────────────────────

function WSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ label: string; value: string }>;
  placeholder?: string;
}) {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => { setReady(typeof document !== 'undefined'); }, []);

  if (ready) {
    const Sel: any = 'select';
    const Opt: any = 'option';
    return (
      <Sel
        value={value}
        onChange={(e: any) => onChange(e.target.value)}
        style={wSelectStyle}
        aria-label={placeholder || 'Select'}
      >
        <Opt value="">{placeholder || 'All'}</Opt>
        {options.map((o) => <Opt key={o.value} value={o.value}>{o.label}</Opt>)}
      </Sel>
    );
  }
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={colors.textMuted}
      style={styles.filterInput}
    />
  );
}

const wSelectStyle = {
  borderRadius: 8,
  borderWidth: 1,
  borderColor: colors.border,
  backgroundColor: colors.card,
  padding: '5px 10px',
  fontSize: 12,
  color: colors.primaryNavyStrong,
  minHeight: 34,
  flex: 1,
} as const;

// ─── StatusTile ───────────────────────────────────────────────────────────────

const SEV_COLORS = {
  neutral: { value: colors.primaryNavy,   bg: colors.card,        border: colors.border },
  warning: { value: colors.warning,       bg: colors.warningSurface, border: colors.warningBorder },
  attention:{ value: colors.danger,       bg: colors.dangerSurface,  border: colors.dangerBorder },
  aqua:    { value: colors.accentAqua,    bg: colors.card,        border: colors.border },
};

type TileTone = 'neutral' | 'warning' | 'attention' | 'aqua';

function StatusTile({ count, label, tone }: { count: number; label: string; tone: TileTone }) {
  const t = SEV_COLORS[tone];
  return (
    <View style={[styles.statusTile, { borderColor: t.border, backgroundColor: t.bg }]}>
      <Text style={[styles.statusTileValue, { color: t.value }]}>{count}</Text>
      <Text style={styles.statusTileLabel}>{label}</Text>
    </View>
  );
}

// ─── BoardTableHeader ─────────────────────────────────────────────────────────

const BOARD_COL_HDR = ['Site', 'Guard', 'Time', 'On / Off', 'Status', 'Risk', 'Alerts', 'Action'] as const;

const COL: any[] = [
  { flex: 18, minWidth: 128 },
  { flex: 12, minWidth: 100 },
  { flex: 9,  minWidth: 80 },
  { flex: 11, minWidth: 82 },
  { flex: 8,  minWidth: 76 },
  { flex: 9,  minWidth: 72 },
  { flex: 5,  minWidth: 44 },
  { flex: 10, minWidth: 96, flexShrink: 0 },
];

function BoardTableHeader() {
  return (
    <View style={styles.boardHdrRow}>
      {BOARD_COL_HDR.map((lbl, i) => (
        <Text key={lbl} style={[styles.boardHdrCell, COL[i]]}>{lbl}</Text>
      ))}
    </View>
  );
}

// ─── BoardRow ─────────────────────────────────────────────────────────────────

function BoardRow({
  row,
  selected,
  highlighted,
  onPress,
  onAction,
}: {
  row: LiveBoardRow;
  selected: boolean;
  highlighted: boolean;
  onPress: () => void;
  onAction: (shift: Shift) => void;
}) {
  const { shift, attendance, lifecycleStatus, risk, delay, likelyLate, siteRiskLabel, primaryActionLabel, rowTone, shiftIncidents, shiftAlerts, panicOrWelfareCount } = row;
  const badge = getStatusBadge(shift.status || 'unfilled');

  return (
    <Pressable
      style={[
        styles.boardRow,
        { backgroundColor: rowTone },
        likelyLate ? styles.boardRowLikelyLate : null,
        selected ? styles.boardRowSelected : null,
        highlighted ? styles.boardRowHighlighted : null,
        IS_WEB ? (WEB_PTR as any) : null,
      ]}
      onPress={onPress}
    >
      {/* Site */}
      <View style={[COL[0], styles.boardCellCol]}>
        <Text style={styles.boardCellSite} numberOfLines={1}>{shift.site?.name || shift.siteName || 'Unknown'}</Text>
        {siteRiskLabel !== 'LOW' ? <Text style={styles.boardCellSiteRisk}>{siteRiskLabel}</Text> : null}
      </View>
      {/* Guard */}
      <Text style={[COL[1], styles.boardCell]} numberOfLines={1}>{shift.guard?.fullName || 'Unassigned'}</Text>
      {/* Time */}
      <Text style={[COL[2], styles.boardCell]}>{fmtTime(shift.start)}–{fmtTime(shift.end)}</Text>
      {/* On/Off */}
      <View style={[COL[3], styles.boardCellCol]}>
        <Text style={styles.boardCellSm}>{attendance?.checkInAt ? fmtTime(attendance.checkInAt) : '—'}</Text>
        <Text style={styles.boardCellSm}>{attendance?.checkOutAt ? fmtTime(attendance.checkOutAt) : '—'}</Text>
      </View>
      {/* Status */}
      <View style={[COL[4], styles.boardCellStatusWrap]}>
        <View style={[styles.boardStatusBadge, { borderColor: badge.color, backgroundColor: `${badge.color}18` }]}>
          <Text style={[styles.boardStatusText, { color: badge.color }]}>{badge.label}</Text>
        </View>
      </View>
      {/* Risk */}
      <View style={[COL[5], styles.boardCellCol]}>
        <Text style={[styles.boardCellRisk, { color: risk.color }]}>{risk.label}</Text>
        {delay !== null ? <Text style={styles.boardCellDelay}>{delay}m late</Text> : null}
        {likelyLate ? <Text style={styles.boardCellDelay}>Likely late</Text> : null}
      </View>
      {/* Alerts */}
      <View style={[COL[6], styles.boardCellAlerts]}>
        {shiftIncidents.length > 0 ? <Text style={styles.boardAlertInc}>{shiftIncidents.length}I</Text> : null}
        {panicOrWelfareCount > 0 ? <Text style={styles.boardAlertPanic}>{panicOrWelfareCount}P</Text> : null}
        {shiftIncidents.length === 0 && panicOrWelfareCount === 0 ? <Text style={styles.boardAlertNone}>—</Text> : null}
      </View>
      {/* Action */}
      <View style={[COL[7], styles.boardCellAction]}>
        <Pressable
          style={({ pressed }: any) => [styles.boardActionBtn, pressed ? styles.boardActionBtnPressed : null, IS_WEB ? WEB_PTR : null]}
          onPress={(e: any) => { e?.stopPropagation?.(); onAction(shift); }}
        >
          <Text style={styles.boardActionBtnText}>{primaryActionLabel}</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

// ─── AttentionItem ─────────────────────────────────────────────────────────────

function AttentionItem({
  item,
  isLast,
  urgentActionItemId,
  onOpenUrgentDetail,
  onOpenUrgentShift,
  onUrgentIncidentFollowUp,
  onUrgentAlertFollowUp,
}: {
  item: UrgentOperationalItem;
  isLast: boolean;
  urgentActionItemId: string | null;
  onOpenUrgentDetail: (item: UrgentOperationalItem) => void;
  onOpenUrgentShift: (item: UrgentOperationalItem) => void;
  onUrgentIncidentFollowUp: (item: UrgentOperationalItem, status: 'in_review' | 'resolved') => Promise<void>;
  onUrgentAlertFollowUp: (item: UrgentOperationalItem, action: 'acknowledge' | 'close') => Promise<void>;
}) {
  const sev = getAttentionSeverity(item.category);
  const sevColor = sev === 'red' ? colors.danger : sev === 'amber' ? colors.warning : colors.info;
  const badgeLabel = getAttentionLabel(item.category);
  const busy = urgentActionItemId === item.id;
  const statusLower = (item.status || '').toLowerCase();

  const handleRowPress = () => {
    if (item.category === 'uncovered_shift') {
      onOpenUrgentDetail(item);
    } else if (item.shiftId) {
      onOpenUrgentShift(item);
    }
  };

  return (
    <Pressable
      style={[styles.attentionItem, isLast ? styles.attentionItemLast : null, IS_WEB ? (WEB_PTR as any) : null]}
      onPress={handleRowPress}
    >
      {/* Header row */}
      <View style={styles.attentionItemHead}>
        <View style={[styles.attentionSevDot, { backgroundColor: sevColor }]} />
        <Text style={[styles.attentionIssueType, { color: sevColor }]}>{item.issueType}</Text>
        <View style={[styles.attentionBadge, { borderColor: sevColor, backgroundColor: `${sevColor}12` }]}>
          <Text style={[styles.attentionBadgeText, { color: sevColor }]}>{badgeLabel}</Text>
        </View>
        <Text style={styles.attentionTime}>{fmtTime(item.occurredAt)}</Text>
      </View>
      {/* Meta */}
      <Text style={styles.attentionMeta} numberOfLines={1}>{item.siteName} · {item.guardName}</Text>
      {/* Action buttons */}
      <View style={styles.attentionActions}>
        {item.category === 'uncovered_shift' ? (
          <Pressable style={[styles.aBtn, styles.aBtnPrimary, IS_WEB ? WEB_PTR : null]} onPress={() => onOpenUrgentDetail(item)}>
            <Text style={styles.aBtnPrimaryText}>Manage coverage</Text>
          </Pressable>
        ) : null}

        {item.category === 'incident' && statusLower === 'open' ? (
          <Pressable
            style={[styles.aBtn, styles.aBtnSecondary, IS_WEB ? WEB_PTR : null]}
            onPress={() => onUrgentIncidentFollowUp(item, 'in_review')}
            disabled={busy}
          >
            <Text style={styles.aBtnSecondaryText}>{busy ? '…' : 'Acknowledge'}</Text>
          </Pressable>
        ) : null}
        {item.category === 'incident' ? (
          <Pressable style={[styles.aBtn, styles.aBtnPrimary, IS_WEB ? WEB_PTR : null]} onPress={() => onOpenUrgentDetail(item)}>
            <Text style={styles.aBtnPrimaryText}>View Incident</Text>
          </Pressable>
        ) : null}
        {item.category === 'incident' && ['open', 'in_review'].includes(statusLower) ? (
          <Pressable
            style={[styles.aBtn, styles.aBtnPrimary, IS_WEB ? WEB_PTR : null]}
            onPress={() => onUrgentIncidentFollowUp(item, 'resolved')}
            disabled={busy}
          >
            <Text style={styles.aBtnPrimaryText}>{busy ? '…' : 'Resolve'}</Text>
          </Pressable>
        ) : null}

        {item.category === 'panic' && item.status !== 'acknowledged' ? (
          <Pressable
            style={[styles.aBtn, styles.aBtnSecondary, IS_WEB ? WEB_PTR : null]}
            onPress={() => onUrgentAlertFollowUp(item, 'acknowledge')}
            disabled={busy}
          >
            <Text style={styles.aBtnSecondaryText}>{busy ? '…' : 'Mark Escalated'}</Text>
          </Pressable>
        ) : null}
        {item.category === 'panic' ? (
          <Pressable
            style={[styles.aBtn, styles.aBtnPrimary, IS_WEB ? WEB_PTR : null]}
            onPress={() => item.status === 'acknowledged' ? onUrgentAlertFollowUp(item, 'close') : onOpenUrgentDetail(item)}
            disabled={busy && item.status === 'acknowledged'}
          >
            <Text style={styles.aBtnPrimaryText}>
              {item.status === 'acknowledged' ? (busy ? '…' : 'Resolve Alert') : getUrgentPrimaryLabel(item)}
            </Text>
          </Pressable>
        ) : null}

        {(item.category === 'missed_check_call' || item.category === 'safety') ? (
          <>
            {item.status !== 'acknowledged' ? (
              <Pressable
                style={[styles.aBtn, styles.aBtnSecondary, IS_WEB ? WEB_PTR : null]}
                onPress={() => onUrgentAlertFollowUp(item, 'acknowledge')}
                disabled={busy}
              >
                <Text style={styles.aBtnSecondaryText}>
                  {busy ? '…' : item.category === 'missed_check_call' ? 'Mark Followed Up' : 'Acknowledge'}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.aBtn, styles.aBtnPrimary, IS_WEB ? WEB_PTR : null]}
              onPress={() => item.status === 'acknowledged' ? onUrgentAlertFollowUp(item, 'close') : onOpenUrgentDetail(item)}
              disabled={busy && item.status === 'acknowledged'}
            >
              <Text style={styles.aBtnPrimaryText}>
                {item.status === 'acknowledged' ? (busy ? '…' : getUrgentPrimaryLabel(item)) : getUrgentPrimaryLabel(item)}
              </Text>
            </Pressable>
          </>
        ) : null}

        {['rejected_offer', 'missed_shift', 'late_start', 'upcoming_risk'].includes(item.category) ? (
          <Pressable style={[styles.aBtn, styles.aBtnPrimary, IS_WEB ? WEB_PTR : null]} onPress={() => onOpenUrgentDetail(item)}>
            <Text style={styles.aBtnPrimaryText}>{getUrgentPrimaryLabel(item)}</Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

// ─── Detail panel sub-components ──────────────────────────────────────────────

function DetailEmpty({ title, desc }: { title: string; desc: string }) {
  return (
    <View style={styles.detailEmpty}>
      <Text style={styles.detailEmptyTitle}>{title}</Text>
      <Text style={styles.detailEmptyDesc}>{desc}</Text>
    </View>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function CompanyLiveOperationsWorkspace({
  liveShiftsCount,
  guardsNotBookedOnCount,
  activePanicAlertsCount,
  openIncidentsCount,
  missedCheckCallsCount,
  urgentOperationalItems,
  urgentActionItemId,
  liveOperationsFeedback,
  liveOperationEnrichedRows,
  selectedShiftId,
  setSelectedShiftId,
  highlightedLiveShiftId,
  liveFilters,
  setLiveFilters,
  siteClientOptions,
  siteOptions,
  linkedGuardOptions,
  uncoveredShiftCount,
  recentOperationalActivity,
  selectedShiftContext,
  selectedShiftCloseOutSummary,
  closeOutNotesDraft,
  setCloseOutNotesDraft,
  savingCloseOutNotes,
  onLiveBoardPrimaryAction,
  onOpenUrgentDetail,
  onOpenUrgentShift,
  onUrgentIncidentFollowUp,
  onUrgentAlertFollowUp,
  onSaveCloseOutNotes,
  onOpenCoverage,
  onBoardLayout,
  onDetailLayout,
}: CompanyLiveOperationsWorkspaceProps) {
  const [attentionExpanded, setAttentionExpanded] = React.useState(false);
  const visibleUrgentItems = attentionExpanded
    ? urgentOperationalItems
    : urgentOperationalItems.slice(0, 5);

  return (
    <View style={styles.root}>

      {/* ── Feedback banner ─────────────────────────────────────────────── */}
      {liveOperationsFeedback ? (
        <View style={[
          styles.feedbackBanner,
          liveOperationsFeedback.tone === 'error' ? styles.feedbackBannerError : styles.feedbackBannerSuccess,
        ]}>
          <Text style={[styles.feedbackTitle, liveOperationsFeedback.tone === 'error' ? styles.feedbackTitleError : styles.feedbackTitleSuccess]}>
            {liveOperationsFeedback.tone === 'error' ? 'Action failed' : 'Action completed'}
          </Text>
          <Text style={[styles.feedbackText, liveOperationsFeedback.tone === 'error' ? styles.feedbackTextError : styles.feedbackTextSuccess]}>
            {liveOperationsFeedback.message}
          </Text>
        </View>
      ) : null}

      {/* ── Status strip ────────────────────────────────────────────────── */}
      <View style={styles.statusStrip}>
        <StatusTile count={liveShiftsCount}           label="Live shifts"   tone={liveShiftsCount > 0 ? 'aqua' : 'neutral'} />
        <StatusTile count={guardsNotBookedOnCount}    label="Not booked"    tone={guardsNotBookedOnCount > 0 ? 'warning' : 'neutral'} />
        <StatusTile count={activePanicAlertsCount}    label="Panic"         tone={activePanicAlertsCount > 0 ? 'attention' : 'neutral'} />
        <StatusTile count={openIncidentsCount}        label="Open incidents" tone={openIncidentsCount > 0 ? 'attention' : 'neutral'} />
        <StatusTile count={missedCheckCallsCount}     label="Missed checks"  tone={missedCheckCallsCount > 0 ? 'warning' : 'neutral'} />
      </View>

      {/* ── Filter bar ──────────────────────────────────────────────────── */}
      <View style={styles.filterBar}>
        <WSelect value={liveFilters.clientId} onChange={(v) => setLiveFilters((f) => ({ ...f, clientId: v }))} options={siteClientOptions} placeholder="Client" />
        <WSelect value={liveFilters.siteId}   onChange={(v) => setLiveFilters((f) => ({ ...f, siteId: v }))}   options={siteOptions}       placeholder="Site" />
        <WSelect value={liveFilters.guardId}  onChange={(v) => setLiveFilters((f) => ({ ...f, guardId: v }))}  options={linkedGuardOptions} placeholder="Guard" />
        <TextInput
          style={styles.filterInput}
          value={liveFilters.date}
          onChangeText={(v: string) => setLiveFilters((f) => ({ ...f, date: v }))}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.textMuted}
        />
        <WSelect value={liveFilters.status} onChange={(v) => setLiveFilters((f) => ({ ...f, status: v }))} options={SHIFT_STATUS_OPTS} placeholder="Status" />
      </View>

      {/* ── Main workspace row ───────────────────────────────────────────── */}
      <View style={styles.workspaceRow} onLayout={(e: any) => onBoardLayout(e.nativeEvent.layout.y)}>

        {/* ── Live shift board ──────────────────────────────────────────── */}
        <View style={styles.boardColumn}>
          <View style={styles.boardPanelHeader}>
            <Text style={styles.panelTitle}>Live Shift Board</Text>
            <Text style={styles.panelCount}>{liveOperationEnrichedRows.length} shift{liveOperationEnrichedRows.length !== 1 ? 's' : ''}</Text>
          </View>
          {liveOperationEnrichedRows.length === 0 ? (
            <View style={styles.boardEmpty}>
              <Text style={styles.boardEmptyTitle}>No shifts match these filters</Text>
              <Text style={styles.boardEmptyDesc}>Broaden filters or refresh to see live data.</Text>
            </View>
          ) : (
            <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} style={styles.boardHScroll}>
              <View style={styles.boardTable}>
                <BoardTableHeader />
                {liveOperationEnrichedRows.map((row) => (
                  <Fragment key={row.shift.id}>
                    <BoardRow
                      row={row}
                      selected={selectedShiftId === row.shift.id}
                      highlighted={highlightedLiveShiftId === row.shift.id}
                      onPress={() => setSelectedShiftId(row.shift.id)}
                      onAction={onLiveBoardPrimaryAction}
                    />
                  </Fragment>
                ))}
              </View>
            </ScrollView>
          )}
        </View>

        {/* ── Attention Now ─────────────────────────────────────────────── */}
        <View style={styles.attentionColumn}>
          <View style={styles.attentionPanelHeader}>
            <Text style={styles.panelTitle}>Attention Now</Text>
            {urgentOperationalItems.length > 0 ? (
              <View style={styles.attentionCountBadge}>
                <Text style={styles.attentionCountText}>{urgentOperationalItems.length}</Text>
              </View>
            ) : null}
          </View>
          <ScrollView style={styles.attentionScroll} showsVerticalScrollIndicator={false}>
            {urgentOperationalItems.length === 0 ? (
              <View style={styles.attentionEmpty}>
                <Text style={styles.attentionEmptyTitle}>Queue clear</Text>
                <Text style={styles.attentionEmptyDesc}>No urgent operational items right now.</Text>
              </View>
            ) : (
              <>
                {visibleUrgentItems.map((item, idx) => (
                  <Fragment key={item.id}>
                    <AttentionItem
                      item={item}
                      isLast={idx === visibleUrgentItems.length - 1 && (!attentionExpanded || idx === urgentOperationalItems.length - 1)}
                      urgentActionItemId={urgentActionItemId}
                      onOpenUrgentDetail={onOpenUrgentDetail}
                      onOpenUrgentShift={onOpenUrgentShift}
                      onUrgentIncidentFollowUp={onUrgentIncidentFollowUp}
                      onUrgentAlertFollowUp={onUrgentAlertFollowUp}
                    />
                  </Fragment>
                ))}
                {urgentOperationalItems.length > 5 ? (
                  <Pressable
                    style={[styles.attentionViewAll, IS_WEB ? (WEB_PTR as any) : null]}
                    onPress={() => setAttentionExpanded((x) => !x)}
                  >
                    <Text style={styles.attentionViewAllText}>
                      {attentionExpanded
                        ? '↑ Show fewer'
                        : `View all ${urgentOperationalItems.length} →`}
                    </Text>
                  </Pressable>
                ) : null}
              </>
            )}
          </ScrollView>
        </View>

      </View>

      {/* ── Lower snapshot strip ────────────────────────────────────────── */}
      <View style={styles.lowerStrip}>
        {/* Coverage */}
        <View style={styles.lowerPanel}>
          <Text style={styles.lowerPanelTitle}>Coverage</Text>
          {uncoveredShiftCount > 0 ? (
            <>
              <Text style={styles.lowerPanelStat}>
                <Text style={styles.lowerPanelStatValue}>{uncoveredShiftCount}</Text>
                {' '}shift{uncoveredShiftCount !== 1 ? 's' : ''} unfilled
              </Text>
              <Pressable
                style={[styles.lowerPanelCta, IS_WEB ? (WEB_PTR as any) : null]}
                onPress={() => onOpenCoverage({ uncoveredOnly: true })}
              >
                <Text style={styles.lowerPanelCtaText}>Manage →</Text>
              </Pressable>
            </>
          ) : (
            <Text style={styles.lowerPanelGood}>All shifts covered</Text>
          )}
        </View>
        {/* Recent activity */}
        <View style={[styles.lowerPanel, styles.lowerPanelRight]}>
          <Text style={styles.lowerPanelTitle}>Recent Activity</Text>
          {recentOperationalActivity.length === 0 ? (
            <Text style={styles.lowerPanelGood}>No recent events</Text>
          ) : (
            recentOperationalActivity.slice(0, 3).map((a) => (
              <Text key={a.id} style={styles.lowerActivityItem} numberOfLines={1}>
                {a.eventType} · {a.siteName}
              </Text>
            ))
          )}
        </View>
      </View>

      {/* ── Selected shift detail ────────────────────────────────────────── */}
      {selectedShiftContext ? (
        <View
          style={styles.detailPanel}
          onLayout={(e: any) => onDetailLayout(e.nativeEvent.layout.y)}
        >
          <DetailPanelContent
            ctx={selectedShiftContext}
            closeOutSummary={selectedShiftCloseOutSummary}
            closeOutNotesDraft={closeOutNotesDraft}
            setCloseOutNotesDraft={setCloseOutNotesDraft}
            savingCloseOutNotes={savingCloseOutNotes}
            onSaveCloseOutNotes={onSaveCloseOutNotes}
            onOpenCoverage={onOpenCoverage}
          />
        </View>
      ) : (
        <View style={styles.detailPanelEmpty} onLayout={(e: any) => onDetailLayout(e.nativeEvent.layout.y)}>
          <Text style={styles.detailPanelEmptyText}>Select a board row to see shift detail, attendance, and records.</Text>
        </View>
      )}

    </View>
  );
}

// ─── DetailPanelContent ────────────────────────────────────────────────────────

function DetailPanelContent({
  ctx,
  closeOutSummary,
  closeOutNotesDraft,
  setCloseOutNotesDraft,
  savingCloseOutNotes,
  onSaveCloseOutNotes,
  onOpenCoverage,
}: {
  ctx: SelectedShiftContext;
  closeOutSummary: CloseOutSummary | null;
  closeOutNotesDraft: string;
  setCloseOutNotesDraft: (v: string) => void;
  savingCloseOutNotes: boolean;
  onSaveCloseOutNotes: () => void;
  onOpenCoverage: (context?: { uncoveredOnly?: boolean; shiftId?: number }) => void;
}) {
  const { shift, attendance, timesheet, logs, incidents, alerts, lifecycleStatus, badge, exception, clientName } = ctx;

  return (
    <>
      <View style={styles.detailHeader}>
        <View style={styles.detailHeaderLeft}>
          <Text style={styles.detailTitle}>Shift #{shift.id}</Text>
          <Text style={styles.detailMeta}>{clientName} · {shift.site?.name || shift.siteName}</Text>
          <Text style={styles.detailMeta}>
            {shift.guard?.fullName || 'No guard assigned'} · {fmtDate(shift.start)} · {fmtTime(shift.start)}–{fmtTime(shift.end)}
          </Text>
          <Text style={styles.detailMeta}>Check calls every {shift.checkCallIntervalMinutes || 60} min</Text>
        </View>
        <View style={[styles.detailBadge, { borderColor: badge.color, backgroundColor: `${badge.color}14` }]}>
          <Text style={[styles.detailBadgeText, { color: badge.color }]}>{badge.icon} {badge.label}</Text>
        </View>
      </View>

      {exception ? (
        <View style={styles.detailException}>
          <Text style={styles.detailExceptionTitle}>{exception.title}</Text>
          <Text style={styles.detailExceptionMsg}>{exception.message}</Text>
          <Text style={styles.detailExceptionOutcome}>{exception.outcome}</Text>
        </View>
      ) : null}

      {lifecycleStatus === 'unfilled' ? (
        <View style={styles.detailAction}>
          <Text style={styles.detailActionMsg}>No confirmed guard linked. This shift needs cover.</Text>
          <Pressable
            style={[styles.detailPrimaryBtn, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={() => onOpenCoverage({ uncoveredOnly: true, shiftId: shift.id })}
          >
            <Text style={styles.detailPrimaryBtnText}>Manage Coverage</Text>
          </Pressable>
        </View>
      ) : null}
      {lifecycleStatus === 'offered' ? (
        <Text style={styles.detailInfoMsg}>Waiting for guard confirmation before live controls are used.</Text>
      ) : null}
      {lifecycleStatus === 'in_progress' ? (
        <Text style={styles.detailInfoMsg}>Guard is booked on and the shift is live.</Text>
      ) : null}
      {lifecycleStatus === 'ready' ? (
        <Text style={styles.detailInfoMsg}>Guard confirmed. Ready for book on.</Text>
      ) : null}
      {lifecycleStatus === 'completed' ? (
        <Text style={styles.detailInfoMsg}>Shift completed. Records remain visible.</Text>
      ) : null}
      {shift.instructions ? (
        <Text style={styles.detailInstructions}>Instructions: {shift.instructions}</Text>
      ) : null}

      <View style={styles.detailGrid}>

        {lifecycleStatus === 'completed' && closeOutSummary ? (
          <View style={[styles.detailCard, styles.detailCardCloseOut]}>
            <Text style={styles.detailCardTitle}>Close-Out</Text>
            <Text style={closeOutSummary.closedCleanly ? styles.detailCloseOutGood : styles.detailCloseOutWarn}>
              {closeOutSummary.closedCleanly ? 'Closed cleanly' : `Needs follow-up (${closeOutSummary.unresolvedFollowUpCount})`}
            </Text>
            <Text style={styles.detailLine}>Scheduled: {fmtDateTime(closeOutSummary.scheduledStart)} → {fmtDateTime(closeOutSummary.scheduledEnd)}</Text>
            <Text style={styles.detailLine}>Actual: {fmtDateTime(closeOutSummary.actualCheckInAt)} → {fmtDateTime(closeOutSummary.actualCheckOutAt)}</Text>
            <Text style={styles.detailLine}>Logs: {closeOutSummary.logsCount} · Incidents: {closeOutSummary.incidentsCount} · Safety: {closeOutSummary.safetyEventsCount}</Text>
            <Text style={styles.detailLine}>Check calls: {closeOutSummary.completedCheckCalls} complete / {closeOutSummary.missedCheckCalls} missed</Text>
            <Text style={styles.detailLine}>Timesheet: {fmtStatus(closeOutSummary.timesheetStatus)}</Text>
            <View style={styles.detailCloseOutNotes}>
              <Text style={styles.detailSubLabel}>Close-out notes</Text>
              <TextInput
                style={styles.detailNotesInput}
                multiline
                value={closeOutNotesDraft}
                onChangeText={setCloseOutNotesDraft}
                placeholder="Short operational handover note"
                placeholderTextColor={colors.textMuted}
              />
              <Pressable
                style={[styles.detailPrimaryBtn, IS_WEB ? (WEB_PTR as any) : null]}
                onPress={onSaveCloseOutNotes}
                disabled={savingCloseOutNotes}
              >
                <Text style={styles.detailPrimaryBtnText}>{savingCloseOutNotes ? 'Saving…' : 'Save Note'}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <View style={styles.detailCard}>
          <Text style={styles.detailCardTitle}>Attendance &amp; Timesheet</Text>
          <Text style={styles.detailLine}>Book on: {attendance?.checkInAt ? fmtDateTime(attendance.checkInAt) : 'Pending'}</Text>
          <Text style={styles.detailLine}>Book off: {attendance?.checkOutAt ? fmtDateTime(attendance.checkOutAt) : 'Pending'}</Text>
          <Text style={styles.detailLine}>Timesheet: {fmtStatus(timesheet?.approvalStatus || 'pending')}</Text>
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailCardTitle}>Daily Logs</Text>
          {logs.length === 0
            ? <DetailEmpty title="No daily logs" desc="Logs for this shift will appear here." />
            : logs.map((log) => <Text key={log.id} style={styles.detailListLine}>– {log.message}</Text>)}
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailCardTitle}>Incidents</Text>
          {incidents.length === 0
            ? <DetailEmpty title="No incidents" desc="Incidents linked to this shift will appear here." />
            : incidents.map((inc) => <Text key={inc.id} style={styles.detailListLine}>– {inc.title} ({fmtStatus(inc.status)})</Text>)}
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailCardTitle}>Safety / Check Calls</Text>
          {alerts.length === 0
            ? <DetailEmpty title="No safety events" desc="Welfare, panic, and check-call items will appear here." />
            : alerts.map((a) => <Text key={a.id} style={styles.detailListLine}>– {fmtStatus(a.type)} ({fmtStatus(a.status)})</Text>)}
        </View>

      </View>
    </>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: spacing.sm,
  },

  // Feedback banner
  feedbackBanner: {
    borderRadius: radii.card,
    borderWidth: 1,
    padding: spacing.md,
  },
  feedbackBannerSuccess: {
    backgroundColor: colors.successSurface,
    borderColor: colors.successBorder,
  },
  feedbackBannerError: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.dangerBorder,
  },
  feedbackTitle: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  feedbackTitleSuccess: { color: colors.success },
  feedbackTitleError: { color: colors.danger },
  feedbackText: { fontSize: 12, lineHeight: 17 },
  feedbackTextSuccess: { color: colors.success },
  feedbackTextError: { color: colors.danger },

  // Status strip
  statusStrip: {
    flexDirection: 'row',
    gap: spacing.sm,
    height: 72,
    flexShrink: 0,
  },
  statusTile: {
    flex: 1,
    borderRadius: radii.card,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 3,
  },
  statusTileValue: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 26,
    letterSpacing: -0.3,
  },
  statusTileLabel: {
    fontSize: 10,
    fontWeight: '500',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.textSecondary,
    textAlign: 'center',
  },

  // Filter bar
  filterBar: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
    height: 40,
    flexShrink: 0,
  },
  filterInput: {
    flex: 1,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.sm,
    fontSize: 12,
    color: colors.primaryNavyStrong,
  },

  // Workspace row
  workspaceRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    height: IS_WEB ? 400 : undefined,
    flex: IS_WEB ? undefined : 1,
    minHeight: IS_WEB ? undefined : 300,
  },

  // Board column
  boardColumn: {
    flex: 65,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  boardPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 36,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexShrink: 0,
  },
  panelTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.primaryNavy,
    letterSpacing: 0.1,
  },
  panelCount: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  boardHScroll: {
    flex: 1,
  },
  boardTable: {
    flexShrink: 0,
  },
  boardHdrRow: {
    flexDirection: 'row',
    height: 32,
    alignItems: 'center',
    backgroundColor: colors.surfaceSubtle,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.sm,
  },
  boardHdrCell: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    color: colors.textSecondary,
    paddingHorizontal: 4,
  },
  boardRow: {
    flexDirection: 'row',
    minHeight: 42,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.sm,
  },
  boardRowLikelyLate: {
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
  },
  boardRowSelected: {
    backgroundColor: colors.accentTealSoft,
  },
  boardRowHighlighted: {
    backgroundColor: colors.infoSurface,
  },
  boardCellCol: {
    flexDirection: 'column',
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingVertical: 4,
    gap: 2,
  },
  boardCell: {
    fontSize: 12,
    color: colors.textPrimary,
    paddingHorizontal: 4,
  },
  boardCellSite: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  boardCellSiteRisk: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.warning,
    letterSpacing: 0.3,
  },
  boardCellSm: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  boardCellStatusWrap: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  boardStatusBadge: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  boardStatusText: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  boardCellRisk: {
    fontSize: 12,
    fontWeight: '600',
  },
  boardCellDelay: {
    fontSize: 10,
    color: colors.warning,
    fontWeight: '500',
  },
  boardCellAlerts: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    gap: 3,
  },
  boardAlertInc: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.danger,
    backgroundColor: colors.dangerSurface,
    borderRadius: 4,
    paddingHorizontal: 3,
    paddingVertical: 1,
  },
  boardAlertPanic: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.warning,
    backgroundColor: colors.warningSurface,
    borderRadius: 4,
    paddingHorizontal: 3,
    paddingVertical: 1,
  },
  boardAlertNone: {
    fontSize: 11,
    color: colors.textMuted,
  },
  boardCellAction: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  boardActionBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: colors.card,
  },
  boardActionBtnPressed: {
    backgroundColor: colors.surfaceSubtle,
  },
  boardActionBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.primaryNavy,
  },
  boardEmpty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
    gap: spacing.xs,
  },
  boardEmptyTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  boardEmptyDesc: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
  },

  // Attention column
  attentionColumn: {
    flex: 35,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  attentionPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 36,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexShrink: 0,
  },
  attentionCountBadge: {
    backgroundColor: colors.danger,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  attentionCountText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textOnBrand,
  },
  attentionScroll: {
    flex: 1,
  },
  attentionItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  attentionItemLast: {
    borderBottomWidth: 0,
  },
  attentionItemHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },
  attentionSevDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    flexShrink: 0,
  },
  attentionIssueType: {
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  attentionBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  attentionBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  attentionTime: {
    fontSize: 10,
    color: colors.textMuted,
    flexShrink: 0,
  },
  attentionMeta: {
    fontSize: 11,
    color: colors.textSecondary,
    marginBottom: 5,
  },
  attentionActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  aBtn: {
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  aBtnPrimary: {
    backgroundColor: colors.primaryNavy,
  },
  aBtnPrimaryText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textOnBrand,
  },
  aBtnSecondary: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  aBtnSecondaryText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  attentionEmpty: {
    padding: spacing.lg,
    alignItems: 'center',
    gap: 4,
  },
  attentionEmptyTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.success,
  },
  attentionEmptyDesc: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  attentionViewAll: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  attentionViewAllText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accentTeal,
  },

  // Lower strip
  lowerStrip: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexShrink: 0,
  },
  lowerPanel: {
    flex: 1,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: spacing.md,
    gap: 4,
    minHeight: 88,
  },
  lowerPanelRight: {
    flex: 1,
  },
  lowerPanelTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom: 4,
  },
  lowerPanelStat: {
    fontSize: 12,
    color: colors.textPrimary,
  },
  lowerPanelStatValue: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.warning,
  },
  lowerPanelCta: {
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  lowerPanelCtaText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accentTeal,
  },
  lowerPanelGood: {
    fontSize: 12,
    color: colors.success,
    fontWeight: '500',
  },
  lowerActivityItem: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 16,
  },

  // Detail panel
  detailPanel: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  detailPanelEmpty: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 60,
  },
  detailPanelEmptyText: {
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
  },

  // Detail header
  detailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  detailHeaderLeft: {
    flex: 1,
    gap: 3,
  },
  detailTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.primaryNavy,
  },
  detailMeta: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
  },
  detailBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    flexShrink: 0,
  },
  detailBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },

  // Detail exception
  detailException: {
    backgroundColor: colors.warningSurface,
    borderRadius: radii.card,
    padding: spacing.md,
    gap: 3,
    marginBottom: spacing.xs,
  },
  detailExceptionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.warning,
  },
  detailExceptionMsg: {
    fontSize: 12,
    color: colors.textPrimary,
  },
  detailExceptionOutcome: {
    fontSize: 12,
    color: colors.textSecondary,
  },

  // Detail action / info
  detailAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.xs,
  },
  detailActionMsg: {
    flex: 1,
    fontSize: 12,
    color: colors.textSecondary,
  },
  detailInfoMsg: {
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  detailInstructions: {
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },

  // Detail grid
  detailGrid: {
    flexDirection: IS_WEB ? ('row' as any) : 'column',
    flexWrap: IS_WEB ? ('wrap' as any) : undefined,
    gap: spacing.sm,
  },
  detailCard: {
    flex: IS_WEB ? undefined : undefined,
    minWidth: IS_WEB ? 240 : undefined,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 4,
    ...(IS_WEB ? { flex: 1 } : {}),
  },
  detailCardCloseOut: {
    ...(IS_WEB ? { flexBasis: '100%' } : {}),
  },
  detailCardTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.primaryNavy,
    marginBottom: 4,
  },
  detailLine: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
  },
  detailListLine: {
    fontSize: 12,
    color: colors.textPrimary,
    lineHeight: 17,
  },
  detailSubLabel: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 4,
  },
  detailNotesInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    padding: spacing.sm,
    fontSize: 12,
    color: colors.textPrimary,
    minHeight: 60,
    marginVertical: 4,
  },
  detailPrimaryBtn: {
    backgroundColor: colors.primaryNavy,
    borderRadius: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    alignSelf: 'flex-start',
    minHeight: 32,
    justifyContent: 'center',
  },
  detailPrimaryBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textOnBrand,
  },
  detailCloseOutGood: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.success,
  },
  detailCloseOutWarn: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.warning,
  },
  detailCloseOutNotes: {
    gap: 4,
    marginTop: spacing.sm,
  },

  // Shared detail empty
  detailEmpty: {
    paddingVertical: spacing.sm,
    gap: 3,
  },
  detailEmptyTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
  },
  detailEmptyDesc: {
    fontSize: 11,
    color: colors.textMuted,
  },
});
